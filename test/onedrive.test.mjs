import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { createOnedriveHandler } from '../server/onedrive.mjs';

async function fixture(t, upstream, sessionFile, { backupEnabled } = {}) {
  let origin;
  let handle;
  const server = createServer((req, res) => handle(req, res, new URL(req.url, origin)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + '/api/onedrive';
  const calls = [];
  function restart(secret = 'ms-secret') {
    handle = createOnedriveHandler({
      sessionFile,
      env: { ONEDRIVE_CLIENT_ID: 'ms-key', ONEDRIVE_CLIENT_SECRET: secret, ONEDRIVE_REDIRECT_URI: base + '/callback',
        ...(backupEnabled && { ONEDRIVE_PLAYLIST_BACKUP: '1' }) },
      request: (url, options) => {
        calls.push({ url, options });
        return upstream(url, options);
      },
    });
  }
  restart();
  const request = (route, options) => fetch(base + route, { redirect: 'manual', ...options });
  async function login() {
    const connect = await request('/connect');
    const authorize = new URL(connect.headers.get('location'));
    const state = authorize.searchParams.get('state');
    assert.equal(authorize.origin, 'https://login.microsoftonline.com');
    assert.equal(authorize.searchParams.get('redirect_uri'), base + '/callback');
    assert.equal(authorize.searchParams.get('scope'), 'https://graph.microsoft.com/Files.Read offline_access');
    assert.equal(authorize.searchParams.get('response_mode'), 'query');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.has('client_secret'), false);
    const [stateCookie] = connect.headers.getSetCookie();
    assert.match(stateCookie, /^groovebox_onedrive_pending=[\w-]{43}; Path=\/api\/onedrive; HttpOnly; SameSite=Lax/);
    const headers = { Cookie: stateCookie.split(';')[0] };
    const callbackPath = '/callback?code=example&state=' + state;
    assert.equal((await request(callbackPath)).status, 400);
    const callback = await request(callbackPath, { headers });
    assert.equal(callback.headers.get('location'), '/?onedrive=connected');
    assert.equal((await request(callbackPath, { headers })).status, 400);
    const token = calls[0].options.body;
    assert.equal(token.get('client_secret'), 'ms-secret');
    assert.equal(token.get('code'), 'example');
    assert.equal(createHash('sha256').update(token.get('code_verifier')).digest('base64url'), authorize.searchParams.get('code_challenge'));
    return callback.headers.getSetCookie()[1].split(';')[0];
  }
  return { origin, request, login, calls, restart };
}

function issueToken() {
  return Response.json({ access_token: 'ms-access', refresh_token: 'ms-refresh', expires_in: 3600 });
}

test('OneDrive App Folder backups are opt-in, personal-only, and give provenance solely to verified drive audio', async t => {
  let driveType = 'business';
  let identities = 0;
  const driveId = 'current-drive!1';
  const parentReference = { driveId };
  const tracks = [
    { id: 'current!1', name: 'Current.m4a', file: {}, parentReference },
    { id: 'foreign!1', name: 'Foreign.m4a', file: {}, parentReference: { driveId: 'another-drive' } },
    { id: 'current!2', name: 'Alias.m4a', file: {}, parentReference, remoteItem: {} },
    { id: 'current!3', name: 'Current.lrc', file: {}, parentReference },
  ];
  const upstream = (url, options) => {
    if (url.hostname === 'login.microsoftonline.com') return issueToken();
    assert.equal(options.headers.Authorization, 'Bearer ms-access');
    if (url.pathname === '/v1.0/me/drive') {
      identities++;
      return Response.json({ id: driveId, driveType, owner: { user: { id: 'current-owner' } } });
    }
    assert.equal(url.pathname, '/v1.0/me/drive/root/children');
    return Response.json({ value: tracks });
  };
  const disabled = await fixture(t, upstream);
  const disabledCookie = await disabled.login();
  const disabledHeaders = { Cookie: disabledCookie, Origin: disabled.origin };
  assert.deepEqual(await (await disabled.request('/status', { headers: disabledHeaders })).json(), { configured: true, connected: true });
  const unavailable = await disabled.request('/backup/connect', { method: 'POST', headers: disabledHeaders });
  assert.equal(unavailable.status, 403);
  assert.equal((await unavailable.json()).code, 'backup_disabled');
  assert.equal(identities, 0);

  const enabled = await fixture(t, upstream, undefined, { backupEnabled: true });
  const cookie = await enabled.login();
  const headers = { Cookie: cookie, Origin: enabled.origin };
  assert.deepEqual(await (await enabled.request('/status', { headers })).json(), { configured: true, connected: true });
  const business = await enabled.request('/backup/connect', { method: 'POST', headers });
  assert.equal(business.status, 403);
  assert.equal((await business.json()).code, 'backup_unavailable');
  const ordinary = await (await enabled.request('/list', { headers })).json();
  assert.equal(ordinary.items.length, tracks.length);
  assert.equal(ordinary.items.some(item => item.backupAccount), false);

  driveType = 'personal';
  assert.deepEqual(await (await enabled.request('/status', { headers })).json(), { configured: true, connected: true, backupAuthorizationAvailable: true });
  const { items } = await (await enabled.request('/list', { headers })).json();
  assert.match(items[0].backupAccount, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(items.filter(item => item.backupAccount).map(item => item.id), ['current!1']);
  assert.equal(items[0].streamUrl, '/api/onedrive/stream?id=current!1');
});

test('OneDrive OAuth with PKCE, paginated folder listing, CDN Range and disconnect', async t => {
  const f = await fixture(t, (url, options) => {
    if (url.hostname === 'login.microsoftonline.com') {
      assert.equal(options.method, 'POST');
      return issueToken();
    }
    if (url.hostname === 'graph.microsoft.com') {
      assert.equal(options.headers.Authorization, 'Bearer ms-access');
      assert.equal(options.headers.Range, undefined);
      if (url.pathname.endsWith('/children')) {
        return url.searchParams.has('$skiptoken')
          ? Response.json({ value: [{ id: 'ABCD!2', file: {}, name: '晚风.flac', size: 12 }] })
          : Response.json({
              value: [{ id: 'ABCD!1', folder: {}, name: '中文目录' }],
              '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=next',
            });
      }
      if (url.pathname.endsWith('/content')) {
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'manual');
        return Response.redirect('https://music.files.1drv.com/track?auth=sign', 302);
      }
      return Response.json({ id: 'ABCD!2', file: { mimeType: 'audio/flac' }, name: '晚风.flac' });
    }
    assert.equal(url.href, 'https://music.files.1drv.com/track?auth=sign');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Range, 'bytes=2-4');
    return new Response(options.method === 'HEAD' ? null : Buffer.from([2, 3, 4]), {
      status: 206, headers: { 'Content-Range': 'bytes 2-4/12', 'Content-Length': '3' },
    });
  });
  assert.deepEqual(await (await f.request('/status')).json(), { configured: true, connected: false });
  assert.equal((await f.request('/stream?id=ABCD!2')).status, 401);
  const Cookie = await f.login();
  const headers = { Cookie };
  const directory = await f.request('/list?path=/', { headers });
  assert.deepEqual((await directory.json()).items, [
    { id: 'ABCD!1', name: '中文目录', path: 'ABCD!1', folder: true, size: 0, streamUrl: null },
    { id: 'ABCD!2', name: '晚风.flac', path: 'ABCD!2', folder: false, size: 12, streamUrl: '/api/onedrive/stream?id=ABCD!2' },
  ]);
  for (const method of ['GET', 'HEAD']) {
    const res = await f.request('/stream?id=ABCD!2', { method, headers: { Cookie, Range: 'bytes=2-4' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 2-4/12');
    assert.equal(res.headers.get('content-type'), 'audio/flac');
    assert.equal(res.headers.get('location'), null);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], method === 'HEAD' ? [] : [2, 3, 4]);
  }
  assert.equal((await f.request('/disconnect', { method: 'POST', headers: { Cookie, Origin: 'https://example.com' } })).status, 403);
  assert.equal((await f.request('/disconnect', { method: 'POST', headers: { Cookie, Origin: f.origin } })).status, 200);
  assert.equal((await f.request('/list', { headers })).status, 401);
});

test('OneDrive lists Personal audio tags and keeps the original file identity and fallback fields', async t => {
  const audio = {
    title: '  夜空  ', artist: '歌手', album: '专辑', albumArtist: '群星', duration: 204125,
    bitrate: 320, track: 2,
  };
  const f = await fixture(t, url => {
    if (url.hostname === 'login.microsoftonline.com') return issueToken();
    assert.equal(url.pathname, '/v1.0/me/drive/items/ABCD!1/children');
    assert.equal(url.searchParams.get('$select'), 'id,name,size,file,folder,audio');
    return Response.json({ value: [
      { id: 'ABCD!2', name: '保留原文件.flac', size: 120, file: {}, audio },
      { id: 'ABCD!3', name: '无标签.mp3', file: {} },
      { id: 'ABCD!4', name: '坏标签.mp3', file: {}, audio: {
        title: '  ', artist: ['bad'], album: 'x'.repeat(1025), albumArtist: 'a\u0000b', duration: '9007199254740992',
      } },
      { id: 'ABCD!5', name: '歌词.lrc', file: {}, audio },
      { id: 'ABCD!6', name: '音乐目录', folder: {}, audio },
      { id: 'ABCD!7', name: '字符串毫秒.m4a', file: {}, audio: { duration: '1250' } },
      { id: 'ABCD!8', name: '图片.png', file: { mimeType: 'image/png' }, audio },
      { id: 'ABCD!9', name: '未知时长.flac', file: {}, audio: { duration: -1000 } },
    ] });
  });
  const Cookie = await f.login();
  const response = await f.request('/list?path=ABCD!1', { headers: { Cookie } });
  assert.equal(response.status, 200);
  const { items } = await response.json();
  assert.deepEqual(items[0], {
    id: 'ABCD!2', name: '保留原文件.flac', path: 'ABCD!2', folder: false, size: 120,
    streamUrl: '/api/onedrive/stream?id=ABCD!2', title: '夜空', artist: '歌手', album: '专辑', albumArtist: '群星', duration: 204.125,
  });
  assert.deepEqual(items.slice(1).map(({ id, name, path, folder, size, streamUrl, ...metadata }) => metadata),
    [{}, {}, {}, {}, { duration: 1.25 }, {}, {}]);
  assert.equal(items[3].streamUrl, '/api/onedrive/stream?id=ABCD!5');
  assert.equal(items[4].folder, true);
  assert.equal(items[6].streamUrl, null);
  assert.equal(f.calls.length, 2);
});

test('OneDrive rejects third-party next links and CDN destinations without requesting them', async t => {
  const f = await fixture(t, (url) => {
    if (url.hostname === 'login.microsoftonline.com') return issueToken();
    if (url.pathname.endsWith('/children')) {
      return Response.json({ value: [], '@odata.nextLink': 'https://other.example/v1.0/leak' });
    }
    if (url.pathname.endsWith('/content')) return Response.redirect('https://other.example/track');
    return Response.json({ id: 'ABCD!2', file: {}, name: 'audio.flac' });
  });
  const Cookie = await f.login();
  assert.equal((await f.request('/list', { headers: { Cookie } })).status, 502);
  assert.equal((await f.request('/stream?id=ABCD!2', { headers: { Cookie } })).status, 502);
  assert.deepEqual(f.calls.map(({ url }) => url.hostname), [
    'login.microsoftonline.com', 'graph.microsoft.com', 'graph.microsoft.com', 'graph.microsoft.com',
  ]);
});

test('OneDrive restores its encrypted session after restart and persists refresh and disconnect', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-onedrive-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'auth.enc');
  let refreshed = 0;
  const f = await fixture(t, (endpoint, options) => {
    const url = new URL(endpoint);
    if (url.hostname === 'login.microsoftonline.com' && url.pathname.endsWith('/token')) {
      if (options.body.get('grant_type') === 'refresh_token') {
        assert.equal(options.body.get('refresh_token'), 'initial-refresh-secret');
        refreshed++;
        return Response.json({ access_token: 'fresh-access-secret', refresh_token: 'new-refresh-secret', expires_in: 3600 });
      }
      assert.equal(options.body.get('grant_type'), 'authorization_code');
      return Response.json({ access_token: 'initial-access-secret', refresh_token: 'initial-refresh-secret', expires_in: 1 });
    }
    assert.equal(url.hostname, 'graph.microsoft.com');
    assert.equal(options.headers.Authorization, 'Bearer fresh-access-secret');
    return Response.json({ value: [] });
  }, sessionFile);
  const cookie = await f.login();
  const request = f.request;
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
  const disconnected = await request('/disconnect', { method: 'POST', headers: { ...headers, Origin: f.origin } });
  assert.equal(disconnected.status, 200);
  f.restart();
  assert.deepEqual(await (await request('/status', { headers })).json(), { configured: true, connected: false });
  assert.equal((await request('/list', { headers })).status, 401);
});
