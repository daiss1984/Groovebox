import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGdriveHandler } from '../server/gdrive.mjs';

const prefix = '/api/gdrive';
const scope = 'https://www.googleapis.com/auth/drive.readonly';
const backupScope = 'https://www.googleapis.com/auth/drive.file';
const localCookie = (response) => response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.endsWith('='));

async function fixture(t, request, configured = true, sessionFile, backupEnabled = false) {
  let handler;
  const server = createServer(async (req, res) => {
    const full = new URL(req.url, 'http://' + req.headers.host);
    if (!await handler(req, res, full)) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const callback = base + prefix + '/callback';
  function restart(secret = 'test-secret') {
    handler = createGdriveHandler({ request, sessionFile, env: configured ? {
      GDRIVE_CLIENT_ID: 'test-client',
      GDRIVE_CLIENT_SECRET: secret,
      GDRIVE_REDIRECT_URI: callback,
      GDRIVE_PLAYLIST_BACKUP: backupEnabled ? '1' : undefined,
    } : {} });
  }
  restart();
  const get = (action, options = {}) => fetch(base + prefix + action, { redirect: 'manual', ...options });
  const authorization = async () => {
    const response = await get('/connect');
    assert.equal(response.status, 303);
    const auth = new URL(response.headers.get('location'));
    assert.equal(auth.origin, 'https://accounts.google.com');
    assert.equal(auth.searchParams.get('redirect_uri'), callback);
    assert.equal(auth.searchParams.get('scope'), scope);
    assert.equal(auth.searchParams.get('access_type'), 'offline');
    const state = auth.searchParams.get('state');
    return {
      challenge: auth.searchParams.get('code_challenge'),
      cookie: localCookie(response)[0],
      state,
    };
  };
  const connect = async () => {
    const { cookie, state } = await authorization();
    const response = await get('/callback?code=test-code&state=' + state, { headers: { cookie } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/?gdrive=connected');
    return localCookie(response)[0];
  };
  return { base, get, authorization, connect, restart };
}

test('Google Drive exposes unconfigured status without using an upstream', async (t) => {
  const { get } = await fixture(t, () => assert.fail('unexpected upstream request'), false);
  assert.deepEqual(await (await get('/status')).json(), { configured: false, connected: false });
  assert.equal((await get('/connect')).status, 503);
});

test('Google Drive authorization verifies browser cookie, state and PKCE', async (t) => {
  let exchangeCount = 0;
  let received;
  const { authorization, get } = await fixture(t, async (endpoint, options) => {
    assert.equal(String(endpoint), 'https://oauth2.googleapis.com/token');
    assert.equal(options.method, 'POST');
    exchangeCount++;
    received = new URLSearchParams(options.body);
    return Response.json({ access_token: 'gdrive-access', refresh_token: 'gdrive-refresh', expires_in: 3600, scope });
  });
  const { challenge, state, cookie } = await authorization();
  const path = '/callback?code=test-code&state=';
  assert.equal((await get(path + state)).headers.get('location'), '/?gdrive=error');
  assert.equal((await get(path + 'incorrect', { headers: { cookie } })).headers.get('location'), '/?gdrive=error');
  const result = await get(path + state, { headers: { cookie } });
  assert.equal(result.headers.get('location'), '/?gdrive=connected');
  const authCookie = localCookie(result)[0];
  assert.ok(authCookie);
  assert.equal(received.get('grant_type'), 'authorization_code');
  assert.equal(received.get('client_secret'), 'test-secret');
  assert.equal(received.get('code'), 'test-code');
  assert.equal(createHash('sha256').update(received.get('code_verifier')).digest('base64url'), challenge);
  assert.equal((await get(path + state, { headers: { cookie } })).headers.get('location'), '/?gdrive=error');
  assert.equal(exchangeCount, 1);
  assert.deepEqual(await (await get('/status', { headers: { cookie: authCookie } })).json(), { configured: true, connected: true });
  assert.equal((await get('/disconnect', { method: 'POST', headers: { cookie: authCookie, origin: 'https://unrelated.test' } })).status, 403);
  assert.equal((await get('/disconnect', { method: 'POST', headers: { cookie: authCookie } })).status, 200);
  assert.equal((await get('/list', { headers: { cookie: authCookie } })).status, 401);
});

test('Google Drive paginates a directory, refreshes once, and proxies partial audio and lyrics', async (t) => {
  const requests = [];
  let refreshCount = 0;
  const song = { id: 'file_v1', name: '夜曲.m4a', mimeType: 'audio/mp4', size: '8000' };
  const lyrics = { id: 'lrc_abc', name: '夜曲.lrc', mimeType: 'text/plain', size: '16' };
  const folder = { id: 'folder_1', name: '我的唱片', mimeType: 'application/vnd.google-apps.folder' };
  const playable = new Map([[song.id, song], [lyrics.id, lyrics]]);
  const { connect, get } = await fixture(t, async (endpoint, options) => {
    const url = new URL(endpoint);
    requests.push([url, options]);
    if (url.hostname === 'oauth2.googleapis.com') {
      if (options.body.get('grant_type') === 'refresh_token') {
        refreshCount++;
        assert.equal(options.body.get('refresh_token'), 'test-refresh');
        return Response.json({ access_token: 'longer', expires_in: 3600 });
      }
      return Response.json({ access_token: 'short', refresh_token: 'test-refresh', expires_in: 1, scope });
    }
    assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer longer');
    assert.equal(url.searchParams.has('access_token'), false);
    if (url.pathname.endsWith('/files')) {
      if (url.searchParams.get('q').includes("'folder_1'")) return Response.json({ files: [song, lyrics] });
      if (url.searchParams.get('pageToken') === 'page-two') return Response.json({ files: [lyrics] });
      return Response.json({ files: [folder, song, { id: 'doc_id', name: '文档', mimeType: 'application/vnd.google-apps.document' }], nextPageToken: 'page-two' });
    }
    const id = url.pathname.split('/').at(-1);
    if (!url.searchParams.has('alt')) return Response.json(playable.get(id));
    if (id === lyrics.id) return new Response('[00:01.50]歌词');
    assert.equal(options.headers.Range, 'bytes=4-7');
    return new Response(Uint8Array.of(1, 2, 3, 4), {
      status: 206, headers: { 'Content-Length': '4', 'Content-Range': 'bytes 4-7/8000' },
    });
  });
  const cookie = await connect();
  const [one, two] = await Promise.all([
    get('/list', { headers: { cookie } }),
    get('/list?path=folder_1', { headers: { cookie } }),
  ]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  const { items } = await one.json();
  assert.deepEqual(items, [
    { id: folder.id, name: folder.name, path: folder.id, folder: true, size: 0, streamUrl: null },
    { id: song.id, name: song.name, path: song.id, folder: false, size: 8000, streamUrl: prefix + '/stream?id=' + song.id },
    { id: lyrics.id, name: lyrics.name, path: lyrics.id, folder: false, size: 16, streamUrl: prefix + '/stream?id=' + lyrics.id },
  ]);
  assert.equal(refreshCount, 1);
  assert.equal(requests.filter(([url]) => url.searchParams.get('pageToken') === 'page-two').length, 1);

  const audio = await get('/stream?id=' + song.id, { headers: { cookie, range: 'bytes=4-7' } });
  assert.equal(audio.status, 206);
  assert.equal(audio.headers.get('content-range'), 'bytes 4-7/8000');
  assert.equal(audio.headers.get('content-type'), 'audio/mp4');
  assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [1, 2, 3, 4]);
  const head = await get('/stream?id=' + song.id, { method: 'HEAD', headers: { cookie, range: 'bytes=4-7' } });
  assert.equal(head.status, 206);
  assert.equal(await head.text(), '');
  const lrc = await get('/stream?id=' + lyrics.id, { headers: { cookie } });
  assert.equal(lrc.headers.get('content-type'), 'text/plain');
  assert.equal(await lrc.text(), '[00:01.50]歌词');
});

test('Google Drive restores its encrypted session after restart and persists refresh and disconnect', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-gdrive-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'auth.enc');
  let refreshed = 0;
  const f = await fixture(t, (endpoint, options) => {
    const url = new URL(endpoint);
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname.endsWith('/token')) {
      if (options.body.get('grant_type') === 'refresh_token') {
        assert.equal(options.body.get('refresh_token'), 'initial-refresh-secret');
        refreshed++;
        return Response.json({ access_token: 'fresh-access-secret', refresh_token: 'new-refresh-secret', expires_in: 3600 });
      }
      assert.equal(options.body.get('grant_type'), 'authorization_code');
      return Response.json({ access_token: 'initial-access-secret', refresh_token: 'initial-refresh-secret', expires_in: 1 });
    }
    assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer fresh-access-secret');
    return Response.json({ files: [] });
  }, true, sessionFile);
  const cookie = await f.connect();
  const request = f.get;
  const headers = { Cookie: cookie };
  const encrypted = await readFile(sessionFile);
  assert.equal(encrypted.includes(Buffer.from('initial-refresh-secret')), false);
  assert.equal(encrypted.includes(Buffer.from(cookie.split('=')[1])), false);
  if (process.platform !== 'win32') assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);

  f.restart('different-oauth-app-secret');
  assert.deepEqual(await (await request('/status', { headers })).json(), { configured: true, connected: false });
  f.restart();
  assert.deepEqual(await (await request('/status', { headers })).json(), { configured: true, connected: true });
  assert.deepEqual(await (await request('/list', { headers })).json(), { items: [] });
  assert.equal(refreshed, 1);
  const rotated = await readFile(sessionFile);
  assert.notDeepEqual(rotated, encrypted);
  assert.equal(rotated.includes(Buffer.from('new-refresh-secret')), false);

  f.restart();
  assert.deepEqual(await (await request('/list', { headers })).json(), { items: [] });
  assert.equal(refreshed, 1);
  const disconnected = await request('/disconnect', { method: 'POST', headers: { ...headers, Origin: f.base } });
  assert.equal(disconnected.status, 200);
  f.restart();
  assert.deepEqual(await (await request('/status', { headers })).json(), { configured: true, connected: false });
  assert.equal((await request('/list', { headers })).status, 401);
});

const readToken = 'gdrive-playback-fixture';
const readRefresh = 'gdrive-playback-refresh-fixture';
const elevatedToken = 'gdrive-backup-fixture';
const elevatedRefresh = 'gdrive-backup-refresh-fixture';
const combinedScope = backupScope + ' ' + scope;
const track = { id: 'fixture_track', name: '夜曲.m4a', mimeType: 'audio/mp4', size: '4' };
const accountPermission = 'opaque_account_permission_fixture';

async function backupOAuth(t, { sessionFile, enabled = true, evolveToken, refresh, identity } = {}) {
  const calls = [];
  const f = await fixture(t, async (endpoint, options) => {
    const url = new URL(endpoint);
    calls.push({ url, options });
    if (url.hostname === 'oauth2.googleapis.com') {
      if (options.body.get('grant_type') === 'refresh_token') {
        assert.ok(refresh, 'unexpected refresh');
        return refresh(options.body.get('refresh_token'));
      }
      if (options.body.get('code') === 'test-code') {
        return Response.json({ access_token: readToken, refresh_token: readRefresh, expires_in: 3600, scope });
      }
      const reply = await evolveToken?.(options.body.get('code'));
      return reply ?? Response.json({ access_token: elevatedToken, refresh_token: elevatedRefresh, expires_in: 3600, scope: combinedScope });
    }
    assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(options.redirect, 'error');
    if (url.pathname.endsWith('/about')) {
      assert.equal(url.searchParams.get('fields'), 'user(permissionId)');
      return Response.json({ user: { permissionId: identity?.(options.headers.Authorization) ?? accountPermission } });
    }
    if (url.pathname.endsWith('/files')) return Response.json({ files: [track] });
    assert.equal(url.pathname, '/drive/v3/files/' + track.id);
    if (!url.searchParams.has('alt')) return Response.json(track);
    return new Response(Uint8Array.of(1, 2, 3, 4), { headers: { 'Content-Type': 'audio/mp4', 'Content-Length': '4' } });
  }, true, sessionFile, enabled);
  const startRequest = (cookie, extra = {}) => f.get('/backup/connect', {
    method: 'POST', headers: { cookie, origin: f.base, 'sec-fetch-site': 'same-origin', ...extra },
  });
  async function start(cookie) {
    const response = await startRequest(cookie);
    assert.equal(response.status, 303);
    const auth = new URL(response.headers.get('location'));
    assert.equal(auth.origin, 'https://accounts.google.com');
    assert.equal(auth.searchParams.get('redirect_uri'), f.base + prefix + '/callback');
    assert.equal(auth.searchParams.get('scope'), backupScope);
    assert.equal(auth.searchParams.get('include_granted_scopes'), 'true');
    assert.equal(auth.searchParams.get('access_type'), 'offline');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.match(auth.searchParams.get('code_challenge'), /^[\w-]{43}$/);
    return { cookie: localCookie(response)[0], state: auth.searchParams.get('state'), challenge: auth.searchParams.get('code_challenge') };
  }
  const finish = (base, pending, values = { code: 'backup-code' }) => f.get('/callback?' + new URLSearchParams({ state: pending.state, ...values }),
    { headers: { cookie: [base, pending.cookie].filter(Boolean).join('; ') } });
  const status = cookie => f.get('/status', { headers: { cookie } }).then(response => response.json());
  return { ...f, start, startRequest, finish, status, calls };
}

test('Google Drive backup consent is gated and binds explicit incremental PKCE to the active session', async t => {
  const disabled = await backupOAuth(t, { enabled: false });
  const disabledCookie = await disabled.connect();
  assert.equal((await disabled.startRequest(disabledCookie)).status, 403);
  assert.equal((await disabled.status(disabledCookie)).backupAuthorizationAvailable, undefined);
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-google-drive-backup-oauth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = join(directory, 'sessions.enc');
  const f = await backupOAuth(t, { sessionFile });
  const original = await f.connect();
  const other = await f.connect();
  assert.deepEqual(await f.status(original), { configured: true, connected: true, backupAuthorizationAvailable: true });
  assert.equal((await f.get('/backup/connect', { headers: { cookie: original } })).status, 405);
  assert.equal((await f.startRequest(original, { origin: '' })).status, 403);
  assert.equal((await f.startRequest(original, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.startRequest('')).status, 401);

  const wrongSession = await f.start(original);
  const count = f.calls.length;
  assert.equal((await f.finish(other, wrongSession)).headers.get('location'), '/?gdrive=backup-error');
  assert.equal(f.calls.length, count); // No provider token exchange for the wrong browser session.

  const approved = await f.start(original);
  const received = await f.finish(original, approved);
  assert.equal(received.headers.get('location'), '/?gdrive=backup-connected');
  const upgraded = localCookie(received)[0];
  assert.ok(upgraded && upgraded !== original);
  const grant = f.calls.find(call => call.options.body?.get('code') === 'backup-code').options.body;
  assert.equal(createHash('sha256').update(grant.get('code_verifier')).digest('base64url'), approved.challenge);
  assert.equal((await f.status(original)).connected, false);
  assert.equal((await f.status(other)).canBackup, undefined);
  assert.deepEqual(await f.status(upgraded), { configured: true, connected: true, backupAuthorizationAvailable: true, canBackup: true });
  assert.notEqual((await f.finish(upgraded, approved)).headers.get('location'), '/?gdrive=backup-connected');
  assert.equal((await f.get('/list', { headers: { cookie: upgraded } })).status, 200);
  const encrypted = await readFile(sessionFile);
  for (const privateValue of [accountPermission, elevatedToken, elevatedRefresh, readRefresh]) {
    assert.equal(encrypted.includes(privateValue), false);
  }
  f.restart();
  assert.equal((await f.status(upgraded)).canBackup, true);
  assert.equal((await f.get('/list', { headers: { cookie: upgraded } })).status, 200);
});

test('Google Drive declined, incomplete, overly broad and different-account consent preserves the playback cookie', async t => {
  const f = await backupOAuth(t, {
    evolveToken(code) {
      const grantedScope = new Map([
        ['read-only', scope], ['backup-only', backupScope], ['missing-scope', undefined],
        ['broad-scope', combinedScope + ' https://www.googleapis.com/auth/drive'],
      ]);
      return Response.json({ access_token: elevatedToken, refresh_token: elevatedRefresh, expires_in: 3600,
        scope: grantedScope.has(code) ? grantedScope.get(code) : combinedScope });
    },
    identity: bearer => bearer === 'Bearer ' + elevatedToken ? 'different_account' : accountPermission,
  });
  const original = await f.connect();
  const pending = await f.start(original);
  const rejected = await f.finish(original, pending, { error: 'access_denied' });
  assert.equal(rejected.headers.get('location'), '/?gdrive=backup-denied');
  assert.deepEqual(localCookie(rejected), []);
  assert.equal(f.calls.length, 1);
  for (const code of ['read-only', 'backup-only', 'missing-scope', 'broad-scope', 'wrong-account']) {
    const rejected = await f.finish(original, await f.start(original), { code });
    assert.equal(rejected.headers.get('location'), '/?gdrive=backup-error');
    assert.deepEqual(localCookie(rejected), []);
    assert.deepEqual(await f.status(original), { configured: true, connected: true, backupAuthorizationAvailable: true });
  }
  const audio = await f.get('/stream?id=' + track.id, { headers: { cookie: original } });
  assert.equal(audio.status, 200);
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), Uint8Array.of(1, 2, 3, 4));
  assert.ok(f.calls.filter(({ url }) => url.pathname.includes('/files')).every(({ options }) => options.headers.Authorization === 'Bearer ' + readToken));
});

test('Google Drive reuses an old refresh token only when it proves the combined grant and account', async t => {
  let mode = 'read-only';
  let refreshes = 0;
  const f = await backupOAuth(t, {
    evolveToken: () => Response.json({ access_token: elevatedToken, expires_in: 3600, scope: combinedScope }),
    refresh(received) {
      assert.equal(received, readRefresh);
      refreshes++;
      return Response.json({ access_token: 'fresh-' + mode, expires_in: mode === 'eligible' ? 1 : 3600,
        scope: mode === 'read-only' ? scope : combinedScope });
    },
    identity: bearer => bearer.endsWith('wrong-account') ? 'different_account' : accountPermission,
  });
  const original = await f.connect();
  for (mode of ['read-only', 'wrong-account']) {
    const denied = await f.finish(original, await f.start(original));
    assert.equal(denied.headers.get('location'), '/?gdrive=backup-error');
    assert.equal((await f.status(original)).canBackup, undefined);
    assert.equal((await f.status(original)).connected, true);
  }
  mode = 'eligible';
  const approved = await f.finish(original, await f.start(original));
  assert.equal(approved.headers.get('location'), '/?gdrive=backup-connected');
  const upgraded = localCookie(approved)[0];
  assert.equal((await f.status(upgraded)).canBackup, true);
  mode = 'read-only';
  const playable = await f.get('/list', { headers: { cookie: upgraded } });
  assert.equal(playable.status, 200);
  assert.deepEqual(await f.status(upgraded), { configured: true, connected: true, backupAuthorizationAvailable: true });
  assert.equal(refreshes, 4);
});

test('Google Drive cannot restore a disconnected browser session during an in-flight backup grant', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await backupOAuth(t, {
    async evolveToken() {
      entered.resolve();
      await release.promise;
    },
  });
  const original = await f.connect();
  const response = f.finish(original, await f.start(original));
  try {
    await entered.promise;
    const disconnected = await f.get('/disconnect', { method: 'POST', headers: { origin: f.base, cookie: original } });
    assert.equal(disconnected.status, 200);
  } finally {
    release.resolve();
  }
  const expired = await response;
  assert.equal(expired.headers.get('location'), '/?gdrive=backup-error');
  assert.deepEqual(localCookie(expired), []);
  assert.equal((await f.status(original)).connected, false);
});
