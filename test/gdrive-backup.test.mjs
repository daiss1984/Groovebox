import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';
import { createGdriveHandler } from '../server/gdrive.mjs';

const prefix = '/api/gdrive';
const readScope = 'https://www.googleapis.com/auth/drive.readonly';
const writeScope = 'https://www.googleapis.com/auth/drive.file';
const operation = 'c4381e8a-d90a-4ef6-b04b-b03673f6f679';
const route = '/backup?id=' + operation;
const folderType = 'application/vnd.google-apps.folder';
const track = { id: '123audio_-', name: '原始录音.m4a', mimeType: 'audio/mp4', trashed: false,
  capabilities: { canDownload: true }, size: '16' };
const folderName = 'Groovebox Playlist Backups';
const snapshotName = 'groovebox-playlists-' + operation + '.json';
const cookies = response => response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.endsWith('='));

function unpackMultipart({ body, headers }) {
  const match = /^multipart\/related; boundary=(groovebox_[0-9a-f]{36})$/.exec(headers['Content-Type']);
  assert.ok(match);
  assert.equal(headers['Content-Length'], String(body.length));
  const delimiter = '--' + match[1];
  const start = Buffer.from(delimiter + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n');
  const middle = Buffer.from('\r\n' + delimiter + '\r\nContent-Type: application/json\r\n\r\n');
  const end = Buffer.from('\r\n' + delimiter + '--\r\n');
  assert.deepEqual(body.subarray(0, start.length), start);
  assert.deepEqual(body.subarray(-end.length), end);
  const split = body.indexOf(middle);
  assert.ok(split > start.length);
  return { metadata: JSON.parse(body.subarray(start.length, split).toString('utf8')),
    bytes: body.subarray(split + middle.length, -end.length) };
}

async function driveFixture(t, { respond, enabled = true } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'groovebox-gdrive-backup-routes-'));
  let handler;
  const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const objects = { owner: new Map(), other: new Map() };
  const generated = { owner: new Set(), other: new Set() };
  const stages = [];
  const errors = [];
  function restart() {
    handler = createGdriveHandler({
      sessionFile: join(temp, 'session.enc'),
      env: { GDRIVE_CLIENT_ID: 'synthetic-client', GDRIVE_CLIENT_SECRET: 'synthetic-secret',
        GDRIVE_REDIRECT_URI: origin + prefix + '/callback', GDRIVE_PLAYLIST_BACKUP: enabled ? '1' : undefined },
      async request(url, init) {
        try {
          url = new URL(url);
          const path = url.pathname;
          assert.equal(init.redirect, 'error');
          if (url.hostname === 'oauth2.googleapis.com') {
            assert.equal(path, '/token');
            const code = init.body.get('code');
            assert.match(code, /^(?:owner|other)-(?:base|elevated)$/);
            return Response.json({ access_token: code, refresh_token: code + '-refresh', expires_in: 3600,
              scope: code.endsWith('base') ? readScope : readScope + ' ' + writeScope });
          }
          assert.equal(url.origin, 'https://www.googleapis.com');
          const authorized = /^Bearer (owner|other)-(base|elevated)$/.exec(init.headers.Authorization);
          assert.ok(authorized);
          const [, account, level] = authorized;
          const owner = objects[account];
          const rootId = account + '-root';
          if (path === '/drive/v3/about') {
            assert.equal(url.searchParams.get('fields'), 'user(permissionId)');
            return Response.json({ user: { permissionId: account + '-permission', emailAddress: 'private@invalid.test' } });
          }
          if (path === '/drive/v3/files' && init.method !== 'POST' && url.searchParams.get('orderBy')) {
            return Response.json({ files: [track, { ...track, id: 'lyrics_123', name: '原始录音.lrc' },
              { id: 'shared_music_folder', name: '音乐', mimeType: folderType }] });
          }
          assert.equal(level, 'elevated');
          const record = async (stage, extra) => {
            stages.push({ stage, account, ...extra });
            return respond?.({ stage, account, owner, url, ...extra });
          };
          if (path === '/drive/v3/files/root') {
            return Response.json({ id: rootId, mimeType: folderType, trashed: false });
          }
          if (path === '/drive/v3/files/generateIds') {
            assert.equal(url.searchParams.get('space'), 'drive');
            assert.equal(url.searchParams.get('count'), '1');
            assert.equal(url.searchParams.get('type'), 'files');
            const set = generated[account];
            const id = account + '_id_' + (set.size + 1);
            set.add(id);
            await record('allocate', { id });
            return Response.json({ ids: [id], space: 'drive' });
          }
          if (path === '/drive/v3/files' && init.method !== 'POST') {
            const q = url.searchParams.get('q');
            assert.match(url.searchParams.get('fields'), /nextPageToken,incompleteSearch,files\(id,name/);
            assert.equal(url.searchParams.get('corpora'), 'user');
            const parent = /^'([\w-]+)' in parents/.exec(q)?.[1];
            assert.ok(parent);
            const folder = q.includes('playlist-backup-folder-v1');
            const listed = [...owner.values()].map(file => file.metadata)
              .filter(file => file.parents[0] === parent && (file.mimeType === folderType) === folder);
            return Response.json({ files: listed });
          }
          if (init.method === 'POST') {
            const folder = path === '/drive/v3/files';
            const { metadata, bytes } = folder ? { metadata: JSON.parse(init.body) } : unpackMultipart(init);
            assert.ok(generated[account].has(metadata.id), metadata.id);
            assert.equal(metadata.appProperties.grooveboxKind, folder ? 'playlist-backup-folder-v1' : 'playlist-backup-snapshot-v1');
            if (folder) {
              assert.equal(metadata.name, folderName);
              assert.equal(metadata.parents, undefined);
            } else {
              assert.equal(path, '/upload/drive/v3/files');
              assert.equal(url.searchParams.get('uploadType'), 'multipart');
              assert.equal(metadata.name, snapshotName);
              assert.equal(metadata.appProperties.grooveboxOperation, operation);
              assert.equal(metadata.appProperties.grooveboxSha256, createHash('sha256').update(bytes).digest('base64url'));
              assert.equal(owner.get(metadata.parents[0])?.metadata.name, folderName);
            }
            const before = await record(folder ? 'folder-create' : 'upload', { id: metadata.id, bytes });
            if (before) return before;
            if (owner.has(metadata.id)) return new Response(null, { status: 409 });
            owner.set(metadata.id, { metadata: { ...metadata, parents: metadata.parents || [rootId], trashed: false,
              ownedByMe: true, shared: false, isAppAuthorized: true, modifiedTime: '2026-11-18T23:09:00Z',
              size: bytes && String(bytes.length), capabilities: folder ? { canAddChildren: true } : { canDownload: true } },
            bytes });
            const after = await record(folder ? 'folder-committed' : 'uploaded', { id: metadata.id, bytes });
            if (after) return after;
            return Response.json(owner.get(metadata.id).metadata);
          }
          const id = path.split('/').at(-1);
          if (id === track.id) {
            const overridden = await record('verify-track', { id });
            return overridden || Response.json(track);
          }
          const object = owner.get(id);
          if (!object) return new Response(null, { status: 404 });
          if (url.searchParams.get('alt') === 'media') {
            const overridden = await record('readback', { id });
            return overridden || new Response(object.bytes);
          }
          return Response.json(object.metadata);
        } catch (error) {
          if (error instanceof assert.AssertionError) errors.push(error);
          throw error;
        }
      },
    });
  }
  restart();
  t.after(() => assert.deepEqual(errors, []));
  const send = (route, options) => fetch(origin + prefix + route, { redirect: 'manual', ...options });
  const get = (cookie, target = '/backup') => send(target, cookie ? { headers: { cookie } } : undefined);
  async function connect(account, elevated = false, from) {
    const start = elevated ? await send('/backup/connect', {
      method: 'POST', headers: { cookie: from, origin, Accept: 'application/json' },
    }) : await get(null, '/connect');
    assert.equal(start.status, elevated ? 200 : 303);
    const url = new URL(elevated ? (await start.json()).authorizeUrl : start.headers.get('location'));
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('scope'), elevated ? writeScope : readScope);
    const pending = cookies(start)[0];
    const state = url.searchParams.get('state');
    const response = await get([pending, from].filter(Boolean).join('; '),
      '/callback?' + new URLSearchParams({ code: account + '-' + (elevated ? 'elevated' : 'base'), state }));
    assert.equal(response.headers.get('location'), '/?gdrive=' + (elevated ? 'backup-connected' : 'connected'));
    return cookies(response)[0];
  }
  const put = (cookie, body, target = route, headers = {}) => send(target, {
    method: 'PUT', body, headers: { cookie, origin, 'content-type': 'application/json', ...headers },
  });
  return { get, put, send, origin, objects, stages, restart,
    readonly: account => connect(account), elevate: (account, from) => connect(account, true, from) };
}

function bytes(account, name = '测试歌单') {
  const ids = [track.id];
  return createPlaylistSnapshot({ tracks: [{ id: track.id, title: '原始录音' }], playlists: [{ name, tracks: ids }], favorites: ids }, {
    scope: { provider: 'gdrive', account }, operation, verifiedFiles: new Map(ids.map(id => [id, id])),
  });
}

test('Google backup integrates scoped multipart writes, playback provenance, exact read and immutable restart', async t => {
  const f = await driveFixture(t);
  assert.equal((await f.get(null)).status, 401);
  const read = await f.readonly('owner');
  const restricted = await f.get(read);
  assert.equal(restricted.status, 403);
  assert.equal((await restricted.json()).code, 'backup_scope_required');
  assert.ok((await (await f.get(read, '/list')).json()).items.every(item => !item.backupAccount));
  const cookie = await f.elevate('owner', read);
  const foreign = await f.elevate('other', await f.readonly('other'));
  const baseline = await (await f.get(cookie)).json();
  const { account } = baseline;
  const other = await (await f.get(foreign)).json();
  assert.match(account, /^[\w-]{43}$/);
  assert.notEqual(other.account, account);
  assert.deepEqual(baseline.snapshots, []);
  assert.equal((await f.get(cookie, route)).status, 404);
  assert.deepEqual(f.stages, []);
  const list = (await (await f.get(cookie, '/list')).json()).items;
  assert.equal(list.find(item => item.id === track.id).backupAccount, account);
  assert.ok(list.filter(item => item.id !== track.id).every(item => !item.backupAccount));
  const payload = bytes(account);
  assert.equal((await f.put(cookie, payload, route, { origin: 'https://other.invalid' })).status, 403);
  assert.equal((await f.put(cookie, payload, route, { origin: '' })).status, 403);
  assert.equal((await f.put(cookie, payload, route + '&verify=1')).status, 400);
  assert.equal((await f.put(cookie, payload, route + '&path=/anywhere')).status, 400);
  assert.equal((await f.put(foreign, payload)).status, 400);
  assert.equal(f.stages.length, 0);
  assert.deepEqual(await (await f.put(cookie, payload)).json(), { status: 'saved', id: operation });
  const response = await f.get(cookie, route);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
  const listings = await (await f.get(cookie)).json();
  assert.deepEqual(listings, { account, snapshots: [{
    id: operation, name: snapshotName, size: payload.byteLength, modifiedAt: Date.parse('2026-11-18T23:09:00Z'),
  }] });
  assert.equal((await f.get(foreign, route + '&verify=1')).status, 404);
  assert.deepEqual(await (await f.get(cookie, route + '&verify=1')).json(), {
    snapshot: Buffer.from(payload).toString('utf8'), available: [track.id],
  });
  f.restart();
  assert.deepEqual(await (await f.put(cookie, payload)).json(), { status: 'already_present', id: operation });
  const conflict = await f.put(cookie, bytes(account, '另一份歌单'));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'snapshot_conflict');
  assert.equal(f.stages.filter(hit => hit.stage === 'upload').length, 1);
  assert.equal(f.stages.filter(hit => hit.stage === 'folder-create').length, 1);
});

test('Google backup filters missing restore tracks but rejects systemic verification failures and unsafe folders', async t => {
  let mode = 'valid';
  const f = await driveFixture(t, {
    respond({ stage }) {
      if (stage === 'verify-track' && mode !== 'valid') return new Response(null, { status: mode === 'missing' ? 404 : 429 });
    },
  });
  const cookie = await f.elevate('owner', await f.readonly('owner'));
  const { account } = await (await f.get(cookie)).json();
  const payload = bytes(account);
  mode = 'missing';
  assert.equal((await f.put(cookie, payload)).status, 409);
  assert.equal(f.stages.filter(r => r.stage === 'folder-create').length, 0);
  mode = 'valid';
  assert.equal((await f.put(cookie, payload)).status, 200);
  mode = 'missing';
  assert.deepEqual(await (await f.get(cookie, route + '&verify=1')).json(), {
    snapshot: Buffer.from(payload).toString('utf8'), available: [],
  });
  mode = 'quota';
  const failure = await f.get(cookie, route + '&verify=1');
  assert.equal(failure.status, 429);
  const body = await failure.json();
  assert.equal(body.snapshot, undefined);
  assert.equal(body.available, undefined);
  assert.equal(body.code, 'rate_limited');
  assert.equal((await f.get(cookie, route)).status, 200);
  const folder = [...f.objects.owner.values()].find(item => item.metadata.mimeType === folderType);
  folder.metadata.shared = true;
  assert.equal((await f.get(cookie)).status, 409);
  assert.equal((await f.put(cookie, payload)).status, 409);
  assert.equal(f.stages.filter(hit => hit.stage === 'upload').length, 1);
});

test('Google backup reconciles a lost commit and same-install concurrent retries without replacing bytes', async t => {
  let drop = true;
  const f = await driveFixture(t, {
    async respond({ stage }) {
      if (stage === 'upload' || stage === 'folder-create') await new Promise(resolve => setTimeout(resolve, 10));
      if (stage === 'uploaded' && drop) {
        drop = false;
        throw new TypeError('synthetic connection lost after write');
      }
    },
  });
  const cookie = await f.elevate('owner', await f.readonly('owner'));
  const { account } = await (await f.get(cookie)).json();
  const payload = bytes(account);
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.put(cookie, payload)));
  assert.ok(responses.every(response => response.status === 200), responses.map(response => response.status));
  const saved = await Promise.all(responses.map(response => response.json()));
  assert.ok(saved.some(value => value.status === 'reconciled'));
  assert.equal(new Set(f.stages.filter(hit => hit.stage === 'upload').map(hit => hit.id)).size, 1);
  assert.equal(new Set(f.stages.filter(hit => hit.stage === 'folder-create').map(hit => hit.id)).size, 1);
  assert.equal(f.objects.owner.size, 2);
});

test('Google backup withholds a deferred verified payload after its pinned browser session disconnects', { timeout: 5000 }, async t => {
  let barrier;
  const f = await driveFixture(t, {
    async respond({ stage }) {
      if (stage === 'verify-track' && barrier) {
        barrier.started.resolve();
        await barrier.release.promise;
      }
    },
  });
  const cookie = await f.elevate('owner', await f.readonly('owner'));
  const { account } = await (await f.get(cookie)).json();
  const payload = bytes(account);
  assert.equal((await f.put(cookie, payload)).status, 200);
  barrier = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  const pending = f.get(cookie, route + '&verify=1');
  try {
    await barrier.started.promise;
    assert.equal((await f.send('/disconnect', { method: 'POST', headers: { cookie, origin: f.origin } })).status, 200);
  } finally {
    barrier.release.resolve();
  }
  const result = await pending;
  assert.equal(result.status, 401);
  const rejected = await result.json();
  assert.equal(rejected.code, 'session_changed');
  assert.equal(rejected.snapshot, undefined);
  assert.equal(rejected.available, undefined);
});

test('Google backup does not start folder or media writes after disconnect during verification', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await driveFixture(t, {
    async respond({ stage }) {
      if (stage === 'verify-track') {
        started.resolve();
        await release.promise;
      }
    },
  });
  const cookie = await f.elevate('owner', await f.readonly('owner'));
  const { account } = await (await f.get(cookie)).json();
  const pending = f.put(cookie, bytes(account));
  try {
    await started.promise;
    assert.equal((await f.send('/disconnect', { method: 'POST', headers: { cookie, origin: f.origin } })).status, 200);
  } finally {
    release.resolve();
  }
  const result = await pending;
  assert.equal(result.status, 401);
  assert.equal((await result.json()).code, 'session_changed');
  assert.equal(f.stages.filter(hit => hit.stage.endsWith('create') || hit.stage === 'upload').length, 0);
});

test('Google backup is read-only by default and will not resolve API aliases as playable files', async t => {
  const disabled = await driveFixture(t, { enabled: false });
  const read = await disabled.readonly('owner');
  assert.equal((await disabled.get(read)).status, 403);
  assert.equal((await disabled.get(read, '/backup/connect')).status, 405);
  assert.deepEqual(disabled.stages, []);

  const f = await driveFixture(t);
  const elevated = await f.elevate('owner', await f.readonly('owner'));
  const { account } = await (await f.get(elevated)).json();
  const fake = 'generateIds';
  const payload = createPlaylistSnapshot({ tracks: [{ id: fake, title: '不支持' }], playlists: [], favorites: [fake] }, {
    scope: { provider: 'gdrive', account }, operation, verifiedFiles: new Map([[fake, fake]]),
  });
  const response = await f.put(elevated, payload);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'invalid_track_reference');
  assert.deepEqual(f.stages.map(hit => hit.stage), ['allocate']);
});
