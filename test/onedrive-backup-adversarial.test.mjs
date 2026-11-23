import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOnedriveHandler } from '../server/onedrive.mjs';
import { createOAuthSessionRegistry } from '../server/oauth-session-store.mjs';

const prefix = '/api/onedrive';
const drivePath = '/v1.0/me/drive';
const graphOrigin = 'https://graph.microsoft.com';
const readScope = graphOrigin + '/Files.Read offline_access';
const narrowWrite = graphOrigin + '/Files.ReadWrite.AppFolder';
const fullScope = graphOrigin + '/Files.Read ' + narrowWrite + ' offline_access';
const operation = 'c4381e8a-d90a-4ef6-b04b-b03673f6f679';
const archiveName = 'groovebox-playlists-' + operation + '.json';
const archiveRoute = '/backup?id=' + operation;
const folderId = 'alpha!40';
const archiveId = 'alpha!41';
const audioId = 'alpha!42';
const date = 1626175567890;
const cdn = 'https://album.files.1drv.com/content?auth=fixture-capability';
const audioCdn = 'https://album.files.1drv.com/audio?auth=fixture-playback';
const upload = 'https://sn3302.up.1drv.com/up/fixture-capability';
const audioBytes = Buffer.from('synthetic original audio');
const cookies = response => response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.endsWith('='));
const graphError = status => Response.json({ error: { code: 'provider-error' } }, { status });

function snapshot(account, title = 'First Recording') {
  return Buffer.from(JSON.stringify({
    format: 'groovebox-playlists', version: 2, operation, scope: { provider: 'onedrive', account },
    tracks: [{ file: audioId, title }],
    playlists: [{ id: '4a29388d-73ae-4d8f-9b45-d0e5e555f318', createdAt: date, name: '旧日歌单', tracks: [0, 0] }],
    favorites: [0],
  }));
}

async function fixture(t, { respond, enabled = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-onedrive-adversarial-'));
  const sessionFile = join(directory, 'legacy-session.enc');
  const clientId = 'fixture-onedrive-client';
  const clientSecret = 'fixture-onedrive-secret';
  const stages = [];
  const unexpected = [];
  const state = { visible: true, archive: null, mediaDrive: 'drive-alpha', download: cdn,
    archiveParent: folderId, archiveETag: 'fixture-etag' };
  let handler;
  const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(unexpected, []);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const callback = origin + prefix + '/callback';
  const legacyId = 'L'.repeat(43);
  const old = createOAuthSessionRegistry(sessionFile, clientSecret, JSON.stringify([prefix, clientId, callback]));
  old.commit(entries => entries.set(legacyId, {
    expiresAt: Date.now() + 10800000,
    token: { accessToken: 'base-token', refreshToken: 'base-refresh', expiresAt: Date.now() + 7200000 },
  }));

  function restart() {
    handler = createOnedriveHandler({
      sessionFile,
      env: { ONEDRIVE_CLIENT_ID: clientId, ONEDRIVE_CLIENT_SECRET: clientSecret,
        ONEDRIVE_REDIRECT_URI: callback, ONEDRIVE_PLAYLIST_BACKUP: enabled ? '1' : undefined },
      async request(raw, init) {
        const url = new URL(raw);
        const headers = new Headers(init.headers);
        const stage = async (name, data = {}) => {
          const record = { name, url, headers, init, ...data };
          stages.push(record);
          return respond?.(record, state);
        };
        try {
          if (url.hostname === 'login.microsoftonline.com') {
            assert.match(url.pathname, /^\/(common|consumers)\/oauth2\/v2\.0\/token$/);
            const code = init.body.get('code');
            const override = await stage('token', { code });
            if (override) return override;
            assert.ok(['good', 'different-account', 'same-drive-other-owner', 'wide-scope', 'base'].includes(code));
            return Response.json({ access_token: code === 'base' ? 'base-token' : code + '-token',
              refresh_token: code + '-refresh', expires_in: 3600, scope: code === 'base' ? readScope :
                code === 'wide-scope' ? fullScope + ' Files.ReadWrite.All' : fullScope });
          }
          if (url.href === upload) {
            assert.equal(init.method, 'PUT');
            assert.equal(init.redirect, 'error');
            assert.equal(headers.get('authorization'), null);
            assert.equal(headers.get('cookie'), null);
            const bytes = Buffer.from(init.body);
            assert.equal(headers.get('content-range'), `bytes 0-${bytes.length - 1}/${bytes.length}`);
            assert.equal(headers.get('content-length'), String(bytes.length));
            const override = await stage('write-bytes', { bytes });
            if (override === 'lost') throw Object.assign(new Error('Lost synthetic transfer response'), { expected: true });
            if (override) return override;
            if (state.archive) return graphError(409);
            state.archive = bytes;
            return Response.json({ id: archiveId, name: archiveName, file: {}, size: bytes.length }, { status: 201 });
          }
          if (url.href === cdn) {
            assert.equal(headers.get('authorization'), null);
            assert.equal(headers.get('cookie'), null);
            const override = await stage('download');
            if (override) return override;
            return new Response(state.archive, { headers: { 'Content-Type': 'application/json' } });
          }
          if (url.href === audioCdn) {
            assert.equal(headers.get('authorization'), null);
            assert.equal(headers.get('cookie'), null);
            return new Response(audioBytes, { headers: { 'Content-Length': String(audioBytes.length), 'Content-Type': 'audio/mp4' } });
          }
          assert.equal(url.origin, graphOrigin);
          const token = headers.get('authorization');
          assert.match(token, /^Bearer (?:base|good|different-account|same-drive-other-owner|wide-scope|downgraded)-token$/);
          const foreign = token.includes('different-account');
          const path = url.pathname;
          if (path === drivePath) {
            const override = await stage('identity', { token });
            return override || Response.json({ id: foreign ? 'drive-beta' : 'drive-alpha', driveType: 'personal',
              owner: { user: { id: foreign || token.includes('other-owner') ? 'owner-beta' : 'owner-alpha' } } });
          }
          if (path === drivePath + '/root/children') {
            const override = await stage('playback-list', { token });
            return override || Response.json({ value: [media()] });
          }
          if (path === drivePath + '/items/' + audioId) {
            const override = await stage('audio-check', { token });
            return override || Response.json(media());
          }
          if (path === drivePath + '/items/' + audioId + '/content') {
            await stage('original-audio', { token });
            return Response.redirect(audioCdn, 302);
          }
          assert.equal(token, 'Bearer good-token', `Unpinned backup operation ${path}`);
          if (path === drivePath + '/special/approot' || path === drivePath + '/items/' + folderId) {
            const override = await stage(path.endsWith('/approot') ? 'approot' : 'folder');
            return override || Response.json({ id: folderId, folder: {}, specialFolder: { name: 'approot' },
              parentReference: { driveId: 'drive-alpha', id: 'root!90' } });
          }
          if (path === drivePath + '/items/' + folderId + '/children') {
            const override = await stage('archives');
            return override || Response.json({ value: state.archive && state.visible ? [metadata()] : [] });
          }
          if (path === drivePath + '/items/' + folderId + ':/' + archiveName + ':') {
            const override = await stage('archive-metadata');
            return override || (state.archive && state.visible ? Response.json(metadata()) : graphError(404));
          }
          if (path === drivePath + '/items/' + archiveId + '/content') {
            assert.equal(init.redirect, 'manual');
            await stage('archive-content');
            return Response.redirect(state.download, 302);
          }
          if (path === drivePath + '/items/' + folderId + ':/' + archiveName + ':/createUploadSession') {
            assert.equal(init.method, 'POST');
            const body = JSON.parse(init.body);
            assert.equal(body.item.name, archiveName);
            assert.equal(body.item['@microsoft.graph.conflictBehavior'], 'fail');
            const override = await stage('create-upload');
            return override || Response.json({ uploadUrl: upload, expirationDateTime: '2030-01-01T00:00:00Z' });
          }
          assert.fail('Unexpected upstream request: ' + init.method + ' ' + url.href);
        } catch (error) {
          if (!error.expected) unexpected.push(error);
          throw error;
        }
      },
    });
  }
  function media() {
    return { id: audioId, name: 'Fixture Recording.m4a', size: audioBytes.length, file: { mimeType: 'audio/mp4' },
      parentReference: { driveId: state.mediaDrive }, '@microsoft.graph.downloadUrl': cdn };
  }
  function metadata() {
    return { id: archiveId, name: archiveName, size: state.archive.length, file: { mimeType: 'application/json' },
      lastModifiedDateTime: '2025-10-12T17:03:43Z', eTag: state.archiveETag, parentReference: { id: state.archiveParent, driveId: 'drive-alpha' } };
  }
  restart();
  let session = 'groovebox_onedrive=' + legacyId;
  function call(route, options = {}) {
    return fetch(origin + prefix + route, { ...options, redirect: 'manual', headers: { Cookie: session, ...options.headers } });
  }
  async function elevate(query = { code: 'good' }) {
    const start = await call('/backup/connect', { method: 'POST', headers: { Origin: origin, Accept: 'application/json' } });
    assert.equal(start.status, 200, await start.clone().text());
    const authorize = new URL((await start.json()).authorizeUrl);
    assert.equal(authorize.origin, 'https://login.microsoftonline.com');
    assert.equal(authorize.pathname, '/consumers/oauth2/v2.0/authorize');
    assert.equal(authorize.searchParams.get('scope'), fullScope);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    const response = await call('/callback?' + new URLSearchParams({ ...query, state: authorize.searchParams.get('state') }), {
      headers: { Cookie: [session, ...cookies(start)].join('; ') },
    });
    const next = cookies(response).find(value => value.startsWith('groovebox_onedrive='));
    if (next) session = next;
    return response;
  }
  return { call, elevate, origin, state, restart, sessionFile, stages };
}

async function playback(f) {
  const list = await f.call('/list');
  assert.equal(list.status, 200);
  const { items } = await list.json();
  assert.equal(items[0].streamUrl, prefix + '/stream?id=' + audioId);
  const stream = await f.call('/stream?id=' + audioId);
  assert.equal(stream.status, 200);
  assert.deepEqual(Buffer.from(await stream.arrayBuffer()), audioBytes);
  assert.equal(f.stages.findLast(event => event.name === 'original-audio').token, 'Bearer base-token');
  return items[0];
}

async function backupList(f) {
  const list = await f.call('/backup');
  assert.equal(list.status, 200, await list.clone().text());
  const result = await list.json();
  assert.match(result.account, /^[\w-]{43}$/);
  return result;
}

function put(f, bytes) {
  return f.call(archiveRoute, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: f.origin }, body: bytes });
}

test('OneDrive keeps backup disabled by default and excludes business drives without touching approot', async t => {
  for (const config of [{ enabled: false }, {
    respond({ name }) {
      if (name === 'identity') return Response.json({ id: 'business-drive', driveType: 'business', owner: { user: { id: 'business-owner' } } });
    },
  }]) {
    const f = await fixture(t, config);
    assert.deepEqual(await (await f.call('/status')).json(), { configured: true, connected: true });
    assert.equal((await playback(f)).backupAccount, undefined);
    const start = await f.call('/backup/connect', { method: 'POST', headers: { Origin: f.origin } });
    assert.equal(start.status, 403);
    assert.equal((await start.json()).code, config.enabled === false ? 'backup_disabled' : 'backup_unavailable');
    assert.equal(f.stages.some(event => ['token', 'approot', 'archives', 'create-upload', 'write-bytes'].includes(event.name)), false);
  }
});

test('legacy encrypted OneDrive playback survives declined, mismatched, broad and downgraded backup consent', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  let elevatedUnauthorized = false;
  const f = await fixture(t, {
    respond({ name, init, token }) {
      if (name === 'identity' && token === 'Bearer good-token' && elevatedUnauthorized) return graphError(401);
      if (name === 'token' && init.body.get('grant_type') === 'refresh_token') {
        assert.equal(init.body.get('refresh_token'), 'good-refresh');
        return Response.json({ access_token: 'downgraded-token', refresh_token: 'next-backup-refresh', expires_in: 3600, scope: readScope });
      }
    },
  });
  assert.equal((await (await f.call('/status')).json()).connected, true);
  const provenance = (await playback(f)).backupAccount;
  assert.match(provenance, /^[\w-]{43}$/);
  for (const [query, marker] of [
    [{ error: 'access_denied' }, 'backup-denied'],
    [{ code: 'different-account' }, 'backup-error'],
    [{ code: 'same-drive-other-owner' }, 'backup-error'],
    [{ code: 'wide-scope' }, 'backup-error'],
  ]) {
    const denied = await f.elevate(query);
    assert.equal(denied.headers.get('location'), '/?onedrive=' + marker);
    assert.equal((await (await f.call('/status')).json()).canBackup, undefined);
    assert.equal((await playback(f)).backupAccount, provenance);
    assert.equal(f.stages.some(event => event.name === 'approot'), false);
  }
  const accepted = await f.elevate();
  assert.equal(accepted.headers.get('location'), '/?onedrive=backup-connected');
  const { account } = await backupList(f);
  assert.equal(account, provenance);
  f.restart();
  assert.equal((await backupList(f)).account, account);
  assert.equal((await playback(f)).backupAccount, account);
  assert.doesNotMatch(await readFile(f.sessionFile, 'utf8'), /(?:good-refresh|base-refresh|owner-alpha)/);
  const assertDowngrade = async () => {
    const denied = await f.call('/backup');
    assert.equal(denied.status, 403, await denied.clone().text());
    assert.equal((await denied.json()).code, 'backup_scope_required');
    const status = await (await f.call('/status')).json();
    assert.equal(status.connected, true);
    assert.equal(status.canBackup, undefined);
    assert.equal((await playback(f)).backupAccount, provenance);
  };
  elevatedUnauthorized = true;
  await assertDowngrade();
  elevatedUnauthorized = false;
  assert.equal((await f.elevate()).headers.get('location'), '/?onedrive=backup-connected');
  t.mock.timers.tick(3600000);
  await assertDowngrade();
  f.restart();
  assert.equal((await (await f.call('/status')).json()).canBackup, undefined);
  assert.equal((await playback(f)).backupAccount, provenance);
});

test('OneDrive preserves exact dated bytes after an uncertain commit and rejects a different retry', async t => {
  const f = await fixture(t, {
    respond({ name, bytes }, state) {
      if (name === 'write-bytes') {
        state.archive = bytes;
        state.visible = false;
        return 'lost';
      }
    },
  });
  assert.equal((await f.elevate()).headers.get('location'), '/?onedrive=backup-connected');
  const { account } = await backupList(f);
  const bytes = snapshot(account);
  const unknown = await put(f, bytes);
  assert.equal(unknown.status, 503, await unknown.clone().text());
  assert.equal((await unknown.json()).code, 'commit_unknown');
  f.restart();
  f.state.visible = true;
  const recovered = await put(f, bytes);
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.match((await recovered.json()).status, /^(?:already_present|reconciled)$/);
  const conflict = await put(f, snapshot(account, 'Other Recording'));
  assert.equal(conflict.status, 409, await conflict.clone().text());
  assert.equal((await conflict.json()).code, 'snapshot_conflict');
  assert.equal(f.stages.filter(event => event.name === 'create-upload').length, 1);
  assert.equal(f.stages.filter(event => event.name === 'write-bytes').length, 1);
  assert.deepEqual(f.state.archive, bytes);
  const raw = await f.call(archiveRoute);
  assert.equal(raw.status, 200, await raw.clone().text());
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes);
  const checked = await f.call(archiveRoute + '&verify=1');
  assert.equal(checked.status, 200, await checked.clone().text());
  const preview = await checked.json();
  assert.deepEqual(preview, { snapshot: bytes.toString('utf8'), available: [audioId] });
  assert.equal(JSON.parse(preview.snapshot).playlists[0].createdAt, date);
  f.state.mediaDrive = 'drive-beta';
  const moved = await f.call(archiveRoute + '&verify=1');
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.deepEqual((await moved.json()).available, []);
});

test('OneDrive never follows a foreign archive pagination or download address', async t => {
  let hostilePage;
  const f = await fixture(t, {
    respond({ name }) {
      if (name === 'archives' && hostilePage) return Response.json({ value: [], '@odata.nextLink': hostilePage });
    },
  });
  assert.equal((await f.elevate()).headers.get('location'), '/?onedrive=backup-connected');
  const { account } = await backupList(f);
  f.state.archive = snapshot(account);
  for (const target of [
    'https://trap.invalid/v1.0/me/drive/items/' + folderId + '/children?$skiptoken=foreign',
    graphOrigin + '/v1.0/me/drive/root/children?$skiptoken=other-folder',
  ]) {
    hostilePage = target;
    const result = await f.call('/backup');
    assert.equal(result.status, 502, await result.clone().text());
    assert.equal(f.stages.some(event => event.url.href === target), false);
  }
  for (const target of [
    'https://album.files.1drv.com.trap.invalid/archive?auth=fixture',
    'https://graph.microsoft.com/v1.0/me/drive/items/' + audioId + '/content',
  ]) {
    f.state.download = target;
    const loaded = await f.call(archiveRoute + '&verify=1');
    assert.equal(loaded.ok, false);
    assert.equal(f.stages.some(event => event.url.href === target), false);
  }
  assert.ok(f.stages.some(event => event.name === 'archive-content'));
  assert.equal((await playback(f)).streamUrl, prefix + '/stream?id=' + audioId);
});

test('OneDrive rejects an out-of-drive app folder and a hostile upload capability before writing', async t => {
  let wrongFolder = false;
  let hostileUpload = false;
  let originalBytes;
  const trap = 'https://sn3302.up.1drv.com.trap.invalid/up/fixture-capability';
  const f = await fixture(t, {
    respond({ name }, state) {
      if ((name === 'folder' || name === 'approot') && wrongFolder) {
        return Response.json({ id: folderId, folder: {}, specialFolder: { name: 'approot' },
          parentReference: { id: 'root!90', driveId: 'drive-beta' } });
      }
      if (name === 'create-upload' && hostileUpload) return Response.json({ uploadUrl: trap });
      if (name === 'write-bytes') {
        // A competing client commits after preflight and before this session's final chunk.
        state.archive = originalBytes;
        return graphError(409);
      }
    },
  });
  assert.equal((await f.elevate()).headers.get('location'), '/?onedrive=backup-connected');
  const { account } = await backupList(f);
  const candidate = snapshot(account);
  originalBytes = snapshot(account, 'Other Recording');
  wrongFolder = true;
  assert.equal((await put(f, candidate)).ok, false);
  assert.equal(f.stages.some(event => event.name === 'create-upload'), false);
  wrongFolder = false;
  hostileUpload = true;
  assert.equal((await put(f, candidate)).ok, false);
  assert.equal(f.stages.some(event => event.name === 'write-bytes' || event.url.href === trap), false);
  assert.equal(f.state.archive, null);
  hostileUpload = false;
  const conflict = await put(f, candidate);
  assert.equal(conflict.status, 409, await conflict.clone().text());
  assert.equal((await conflict.json()).code, 'snapshot_conflict');
  assert.deepEqual(f.stages.filter(event => event.name === 'write-bytes').map(event => event.bytes), [candidate]);
  const raw = await f.call(archiveRoute);
  assert.equal(raw.status, 200, await raw.clone().text());
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), originalBytes);
});

test('OneDrive discards a verified restore response if the owning session disconnects during download', async t => {
  let signalRead;
  let unblockRead;
  const readStarted = new Promise(resolve => { signalRead = resolve; });
  const slowCdn = new Promise(resolve => { unblockRead = resolve; });
  const f = await fixture(t, {
    async respond({ name }) {
      if (name === 'download') {
        signalRead();
        await slowCdn;
      }
    },
  });
  assert.equal((await f.elevate()).headers.get('location'), '/?onedrive=backup-connected');
  const { account } = await backupList(f);
  f.state.archive = snapshot(account);
  const restoring = f.call(archiveRoute + '&verify=1');
  try {
    await Promise.race([readStarted, restoring.then(async response => assert.fail('Restore ended early: ' + await response.clone().text()))]);
    assert.equal((await f.call('/disconnect', { method: 'POST', headers: { Origin: f.origin } })).status, 200);
  } finally { unblockRead(); }
  const revoked = await restoring;
  assert.equal(revoked.status, 401, await revoked.clone().text());
  assert.equal((await revoked.json()).code, 'session_changed');
  assert.equal((await (await f.call('/status')).json()).connected, false);
});

test('OneDrive discards archive bytes when the file changes or moves during signed download', async t => {
  let update;
  const f = await fixture(t, {
    respond({ name }, state) {
      if (name === 'download') update(state);
    },
  });
  assert.equal((await f.elevate()).headers.get('location'), '/?onedrive=backup-connected');
  const { account } = await backupList(f);
  f.state.archive = snapshot(account);
  for (const change of [state => { state.archiveETag = 'changed-etag'; }, state => { state.archiveParent = 'other!40'; }]) {
    f.state.archiveParent = folderId;
    f.state.archiveETag = 'fixture-etag';
    update = change;
    const response = await f.call(archiveRoute + '&verify=1');
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json()).code, 'destination_conflict');
  }
  assert.equal(f.stages.filter(event => event.name === 'download').length, 2);
  assert.equal(f.stages.some(event => event.name === 'audio-check'), false);
  f.state.archiveParent = folderId;
  f.state.archiveETag = undefined;
  const missingRevision = await f.call(archiveRoute + '&verify=1');
  assert.equal(missingRevision.status, 422, await missingRevision.clone().text());
  assert.equal((await missingRevision.json()).code, 'snapshot_unreadable');
  assert.equal(f.stages.filter(event => event.name === 'download').length, 2);
});
