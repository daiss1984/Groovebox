import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';
import { createDropboxHandler } from '../server/dropbox.mjs';
import { dropboxAccountKey, dropboxContentHash } from '../server/dropbox-backup.mjs';
import { createSessionStore } from '../server/oauth-session-store.mjs';

const prefix = '/api/dropbox';
const readScope = 'files.metadata.read files.content.read';
const writeScope = 'account_info.read files.content.write';
const client = 'test-client';
const secret = 'test-fixture-secret';
const operation = '68d9fb4a-85a3-46b4-bc29-b979ca9d2614';
const route = '/backup?id=' + operation;
const track = { '.tag': 'file', id: 'id:track_fixture', name: '夜曲.m4a', size: 6, is_downloadable: true };
const legacy = 'x'.repeat(43);
const cookie = response => response.headers.getSetCookie().map(value => value.split(';')[0]).find(value => !value.endsWith('='));

async function fixture(t, { enabled = true, respond, expiring = false, legacySession = false } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'groovebox-dropbox-backup-route-'));
  const sessionFile = join(tmp, 'sessions.enc');
  let handler;
  const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const callback = origin + prefix + '/callback';
  const files = { owner: new Map(), other: new Map() };
  const history = [];
  const faults = [];
  if (legacySession) {
    const store = createSessionStore(sessionFile, secret, JSON.stringify([prefix, client, callback]));
    const expiresAt = Date.now() + 3600_000;
    store.write(new Map([[legacy, { expiresAt, token: { accessToken: 'owner_read', refreshToken: 'refresh-owner_read', expiresAt } }]]));
  }
  function restart() {
    handler = createDropboxHandler({ sessionFile, env: {
      DROPBOX_CLIENT_ID: client, DROPBOX_CLIENT_SECRET: secret, DROPBOX_REDIRECT_URI: callback,
      DROPBOX_PLAYLIST_BACKUP: enabled ? '1' : undefined,
    }, async request(raw, init) {
      try {
        const url = new URL(raw);
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.method, 'POST');
        if (url.pathname === '/oauth2/token') {
          assert.equal(url.host, 'api.dropboxapi.com');
          const grant = init.body;
          history.push({ phase: 'token', grant });
          if (grant.get('grant_type') === 'refresh_token') {
            const refresh = /^refresh-(owner|other)_upgrade$/.exec(grant.get('refresh_token'));
            assert.ok(refresh);
            return Response.json({ access_token: refresh[1] + '_refreshed', expires_in: 3600 });
          }
          const [account, kind] = grant.get('code').split('_');
          assert.ok(files[account]);
          return Response.json({ access_token: account + '_' + kind, account_id: 'dbid:' + account,
            refresh_token: 'refresh-' + account + '_' + kind, scope: readScope + (kind === 'upgrade' ? ' ' + writeScope : ''),
            expires_in: kind === 'upgrade' && expiring ? 1 : 3600 });
        }
        const bearer = /^Bearer (owner|other)_(read|upgrade|refreshed|partial)$/.exec(init.headers.Authorization);
        assert.ok(bearer, init.headers.Authorization);
        const [, account, type] = bearer;
        const upgraded = type === 'upgrade' || type === 'refreshed';
        const accountKey = dropboxAccountKey(client, secret, 'dbid:' + account);
        const directory = '/groovebox-playlist-backups-' + accountKey.slice(0, 20).toLowerCase();
        const name = 'groovebox-playlists-' + operation + '.json';
        const path = directory + '/' + name;
        const entries = files[account];
        assert.equal(init.headers['Dropbox-API-Select-User'], undefined);
        assert.equal(init.headers['Dropbox-API-Path-Root'], undefined);
        const run = (phase, details = {}) => {
          history.push({ phase, account, ...details });
          return respond?.({ phase, account, entries, directory, path, ...details });
        };
        const missing = () => Response.json({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, { status: 409 });
        switch (url.pathname) {
          case '/2/users/get_current_account': {
            assert.equal(url.host, 'api.dropboxapi.com');
            assert.ok(upgraded);
            assert.equal(init.body, undefined);
            const override = await run('account');
            return override || Response.json({ account_id: 'dbid:' + account, disabled: false, email: 'private@invalid.test' });
          }
          case '/2/files/list_folder':
          case '/2/files/list_folder/continue': {
            assert.equal(url.host, 'api.dropboxapi.com');
            const args = JSON.parse(init.body);
            if (args.path === '') return Response.json({ entries: [track, { ...track, id: 'id:lyrics', name: '夜曲.lrc' },
              { '.tag': 'folder', id: 'id:music_folder', name: '音乐' }], has_more: false });
            assert.ok(upgraded);
            const override = await run('list', { args });
            if (override) return override;
            if (url.pathname.endsWith('/continue')) {
              assert.equal(args.cursor, 'test-next');
              return Response.json({ entries: entries.has(path) ? [entries.get(path).metadata] : [], has_more: false });
            }
            assert.equal(args.path, directory);
            assert.equal(args.recursive, false);
            assert.equal(args.include_mounted_folders, false);
            return Response.json({ entries: [{ ...track, path_lower: '/unscoped/something' }], cursor: 'test-next', has_more: true });
          }
          case '/2/files/get_metadata': {
            const { path: target, include_has_explicit_shared_members } = JSON.parse(init.body);
            if (target === track.id) {
              const override = await run('track', { upgraded });
              return override || Response.json(track);
            }
            assert.ok(upgraded);
            assert.equal(include_has_explicit_shared_members, true);
            assert.ok([directory, path].includes(target), target);
            return entries.has(target) ? Response.json(entries.get(target).metadata) : missing();
          }
          case '/2/files/create_folder_v2': {
            assert.ok(upgraded);
            assert.deepEqual(JSON.parse(init.body), { path: directory, autorename: false });
            const override = await run('mkdir');
            if (override) return override;
            if (entries.has(directory)) return Response.json({ error: { '.tag': 'path', path: { '.tag': 'conflict',
              conflict: { '.tag': 'folder' } } } }, { status: 409 });
            const metadata = { '.tag': 'folder', id: 'id:folder_' + account, name: directory.slice(1), path_lower: directory };
            entries.set(directory, { metadata });
            return Response.json({ metadata });
          }
          case '/2/files/upload': {
            assert.ok(upgraded);
            assert.equal(url.host, 'content.dropboxapi.com');
            const payload = Buffer.from(init.body);
            const args = JSON.parse(init.headers['Dropbox-API-Arg']);
            assert.equal(init.headers['Content-Type'], 'application/octet-stream');
            assert.equal(init.headers['Content-Length'], String(payload.length));
            assert.deepEqual(args, { path, mode: 'add', autorename: false, strict_conflict: true, content_hash: dropboxContentHash(payload) });
            assert.ok(entries.has(directory));
            const override = await run('upload', { args, payload });
            if (override) return override;
            if (entries.has(path)) return Response.json({ error: { '.tag': 'path', reason: { '.tag': 'conflict',
              conflict: { '.tag': 'file' } }, upload_session_id: 'ignored' } }, { status: 409 });
            const metadata = { '.tag': 'file', id: 'id:snapshot_' + account, name, path_lower: path, size: payload.length,
              rev: 'abcdef123456', content_hash: dropboxContentHash(payload), server_modified: '2026-11-20T05:05:00Z' };
            entries.set(path, { metadata, payload });
            const result = await run('uploaded');
            const { '.tag': _tag, ...receipt } = metadata;
            return result || Response.json(receipt);
          }
          case '/2/files/download': {
            assert.equal(url.host, 'content.dropboxapi.com');
            const args = JSON.parse(init.headers['Dropbox-API-Arg']);
            if (args.path === track.id) return new Response('music!', { headers: { 'Content-Type': 'application/octet-stream' } });
            assert.ok(upgraded);
            assert.deepEqual(args, { path });
            const { metadata, payload } = entries.get(path);
            const { '.tag': _tag, ...receipt } = metadata;
            return new Response(payload, { headers: { 'Dropbox-API-Result': JSON.stringify(receipt) } });
          }
          default: assert.fail('Unexpected synthetic Dropbox operation ' + url.pathname);
        }
      } catch (error) {
        if (error instanceof assert.AssertionError) faults.push(error);
        throw error;
      }
    } });
  }
  restart();
  t.after(() => assert.deepEqual(faults, []));
  const send = (path, headers, options) => fetch(origin + prefix + path, { redirect: 'manual', headers, ...options });
  const get = (path, cookie) => send(path, cookie ? { cookie } : {});
  const begin = old => send('/backup/connect', { cookie: old, origin, accept: 'application/json' }, { method: 'POST' });
  const end = (state, pending, old, values) => get('/callback?' + new URLSearchParams({ state, ...values }), [pending, old].filter(Boolean).join('; '));
  async function connect(account, previous) {
    const start = await get('/connect', previous);
    const target = new URL(start.headers.get('location'));
    assert.equal(target.searchParams.get('scope'), readScope);
    const callback = await end(target.searchParams.get('state'), cookie(start), previous, { code: account + '_read' });
    assert.equal(callback.headers.get('location'), '/?dropbox=connected');
    return cookie(callback);
  }
  async function authorize(previous) {
    const start = await begin(previous);
    assert.equal(start.status, 200);
    const target = new URL((await start.json()).authorizeUrl);
    assert.equal(target.origin + target.pathname, 'https://www.dropbox.com/oauth2/authorize');
    assert.equal(target.searchParams.get('scope'), writeScope);
    assert.equal(target.searchParams.get('include_granted_scopes'), 'user');
    assert.equal(target.searchParams.get('token_access_type'), 'offline');
    assert.equal(target.searchParams.get('force_reapprove'), 'true');
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    const challenge = target.searchParams.get('code_challenge');
    const state = target.searchParams.get('state');
    return { challenge, finish: values => end(state, cookie(start), previous, values) };
  }
  async function upgrade(account, previous) {
    const { challenge, finish } = await authorize(previous);
    const result = await finish({ code: account + '_upgrade' });
    assert.equal(result.headers.get('location'), '/?dropbox=backup-connected');
    const grant = history.filter(item => item.phase === 'token').at(-1).grant;
    assert.equal(createHash('sha256').update(grant.get('code_verifier')).digest('base64url'), challenge);
    return cookie(result);
  }
  const put = (cookie, body, url = route, headers = {}) =>
    send(url, { cookie, origin, 'content-type': 'application/json', ...headers }, { method: 'PUT', body });
  return { get, send, origin, begin, connect, authorize, upgrade, put, files, history, restart, sessionFile };
}

const snapshot = (account, name = 'Dropbox 歌单') => createPlaylistSnapshot({
  tracks: [{ id: track.id, title: '夜曲' }], playlists: [{ name, tracks: [track.id] }], favorites: [track.id],
}, { scope: { provider: 'dropbox', account }, operation, verifiedFiles: new Map([[track.id, track.id]]) });

test('Dropbox uses legacy readonly reconnect and explicit same-account PKCE, keeping playback on denial or mismatch', async t => {
  const f = await fixture(t, { legacySession: true });
  const legacyCookie = 'groovebox_dropbox=' + legacy;
  const status = async user => (await f.get('/status', user)).json();
  assert.deepEqual(await status(legacyCookie), { configured: true, connected: true, backupReconnectRequired: true });
  const rejected = await f.begin(legacyCookie);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'backup_reconnect_required');
  assert.equal((await f.get('/list', legacyCookie)).status, 200);
  const owner = await f.connect('owner', legacyCookie);
  f.restart(); // The readonly account anchor survives an encrypted restart.
  assert.deepEqual(await status(owner), { configured: true, connected: true, backupAuthorizationAvailable: true });
  const deny = await (await f.authorize(owner)).finish({ error: 'access_denied' });
  assert.equal(deny.headers.get('location'), '/?dropbox=backup-denied');
  assert.equal(cookie(deny), undefined);
  for (const code of ['owner_partial', 'other_upgrade']) {
    const wrong = await (await f.authorize(owner)).finish({ code });
    assert.equal(wrong.headers.get('location'), '/?dropbox=backup-error');
    assert.equal(cookie(wrong), undefined);
    assert.equal((await status(owner)).connected, true);
  }
  const unprivileged = await f.get('/backup', owner);
  assert.equal(unprivileged.status, 403);
  assert.equal((await unprivileged.json()).code, 'backup_scope_required');
  assert.equal((await f.get('/stream?id=' + track.id, owner)).status, 200);
  const upgraded = await f.upgrade('owner', owner);
  assert.equal((await status(owner)).connected, false);
  assert.equal((await status(upgraded)).canBackup, true);
  const encrypted = await readFile(f.sessionFile);
  for (const value of ['dbid:owner', 'owner_upgrade', 'refresh-owner_upgrade']) assert.equal(encrypted.includes(value), false);
});

test('Dropbox backup writes fixed add-only paths, refreshes scope-less grants, lists, restores and keeps exact bytes on retry', async t => {
  const f = await fixture(t, { expiring: true });
  const owner = await f.upgrade('owner', await f.connect('owner'));
  const other = await f.upgrade('other', await f.connect('other'));
  const { account, snapshots } = await (await f.get('/backup', owner)).json();
  assert.match(account, /^[\w-]{43}$/);
  assert.deepEqual(snapshots, []);
  const outside = await f.get('/backup', other);
  assert.equal(outside.status, 200);
  assert.notEqual((await outside.json()).account, account);
  assert.ok(f.history.some(entry => entry.phase === 'token' && entry.grant.get('grant_type') === 'refresh_token'));
  assert.equal((await (await f.get('/status', owner)).json()).canBackup, true);
  const ordinary = (await (await f.get('/list', owner)).json()).items;
  assert.equal(ordinary.find(item => item.id === track.id).backupAccount, account);
  assert.ok(ordinary.filter(item => item.id !== track.id).every(item => !item.backupAccount));
  const payload = snapshot(account);
  assert.equal((await f.put(other, payload)).status, 400);
  assert.equal((await f.put(owner, payload, route, { origin: 'https://other.invalid' })).status, 403);
  assert.equal((await f.put(owner, payload, route + '&path=/foreign')).status, 400);
  assert.equal((await f.get(route, owner)).status, 404);
  assert.equal(f.history.filter(hit => hit.phase === 'mkdir' || hit.phase === 'upload').length, 0);
  assert.deepEqual(await (await f.put(owner, payload)).json(), { status: 'saved', id: operation });
  const raw = await f.get(route, owner);
  assert.equal(raw.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), payload);
  assert.deepEqual(await (await f.get(route + '&verify=1', owner)).json(), {
    snapshot: Buffer.from(payload).toString('utf8'), available: [track.id],
  });
  assert.deepEqual((await (await f.get('/backup', owner)).json()).snapshots, [{
    id: operation, name: 'groovebox-playlists-' + operation + '.json', size: payload.byteLength,
    modifiedAt: Date.parse('2026-11-20T05:05:00Z'),
  }]);
  assert.equal((await f.get(route, other)).status, 404);
  f.restart();
  assert.deepEqual(await (await f.put(owner, payload)).json(), { status: 'already_present', id: operation });
  assert.equal((await f.put(owner, snapshot(account, '第二份歌单'))).status, 409);
  assert.equal(f.history.filter(hit => hit.phase === 'upload').length, 1);
});

test('Dropbox restore allows confirmed missing tracks, withholds payload on global failure, and disables revoked write scope', async t => {
  let mode = 'valid';
  const f = await fixture(t, { respond({ phase }) {
    if (phase === 'account' && mode === 'scope') return Response.json({ error: { '.tag': 'missing_scope' } }, { status: 401 });
    if (phase === 'track' && mode === 'missing') return Response.json({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, { status: 409 });
    if (phase === 'track' && mode === 'limited') return new Response(null, { status: 429 });
  } });
  const cookie = await f.upgrade('owner', await f.connect('owner'));
  const { account } = await (await f.get('/backup', cookie)).json();
  const payload = snapshot(account);
  assert.equal((await f.put(cookie, payload)).status, 200);
  mode = 'missing';
  assert.deepEqual(await (await f.get(route + '&verify=1', cookie)).json(), {
    snapshot: Buffer.from(payload).toString('utf8'), available: [],
  });
  mode = 'limited';
  const unavailable = await f.get(route + '&verify=1', cookie);
  assert.equal(unavailable.status, 429);
  const broken = await unavailable.json();
  assert.equal(broken.snapshot, undefined);
  assert.equal(broken.available, undefined);
  mode = 'scope';
  const denied = await f.get('/backup', cookie);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'backup_scope_required');
  assert.deepEqual(await (await f.get('/status', cookie)).json(), {
    configured: true, connected: true, backupAuthorizationAvailable: true,
  });
  assert.equal((await f.get('/list', cookie)).status, 200);
});

test('Dropbox concurrent commits and lost write responses reconcile at the same path', async t => {
  let transportLost = true;
  const f = await fixture(t, { async respond({ phase }) {
    if (phase === 'mkdir' || phase === 'upload') await new Promise(resolve => setTimeout(resolve, 10));
    if (phase === 'uploaded' && transportLost) {
      transportLost = false;
      throw new TypeError('synthetic response lost');
    }
  } });
  const user = await f.upgrade('owner', await f.connect('owner'));
  const { account } = await (await f.get('/backup', user)).json();
  const requests = await Promise.all(Array.from({ length: 4 }, () => f.put(user, snapshot(account))));
  assert.ok(requests.every(response => response.status === 200), requests.map(response => response.status));
  assert.ok((await Promise.all(requests.map(response => response.json()))).some(body => body.status === 'reconciled'));
  assert.equal(new Set(f.history.filter(hit => hit.phase === 'upload').map(hit => hit.args.path)).size, 1);
  assert.equal(f.files.owner.size, 2);
});

test('Dropbox drops the verified restore response after the browser session disconnects', { timeout: 5000 }, async t => {
  let barrier;
  const f = await fixture(t, { async respond({ phase }) {
    if (phase === 'track' && barrier) {
      barrier.started.resolve();
      await barrier.release.promise;
    }
  } });
  const user = await f.upgrade('owner', await f.connect('owner'));
  const { account } = await (await f.get('/backup', user)).json();
  assert.equal((await f.put(user, snapshot(account))).status, 200);
  barrier = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  const pending = f.get(route + '&verify=1', user);
  try {
    await barrier.started.promise;
    assert.equal((await f.send('/disconnect', { cookie: user, origin: f.origin }, { method: 'POST' })).status, 200);
  } finally {
    barrier.release.resolve();
  }
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'session_changed');
});

test('Dropbox backup is disabled by default while ordinary authorization remains read-only', async t => {
  const f = await fixture(t, { enabled: false });
  const user = await f.connect('owner');
  assert.deepEqual(await (await f.get('/status', user)).json(), { configured: true, connected: true });
  const start = await f.begin(user);
  assert.equal(start.status, 403);
  assert.equal((await start.json()).code, 'backup_unavailable');
  const saved = await f.get('/backup', user);
  assert.equal(saved.status, 403);
  assert.equal((await saved.json()).code, 'backup_unavailable');
  assert.equal((await f.get('/list', user)).status, 200);
  assert.deepEqual(f.history.map(hit => hit.phase), ['token']);
});
