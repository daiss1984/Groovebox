import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { createDrive123Handler } from '../server/drive123.mjs';

async function fixture(t, upstream, sessionFile) {
  let origin;
  let handle;
  const server = createServer((req, res) => handle(req, res, new URL(req.url, origin)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + '/api/drive123';
  const calls = [];
  function restart(secret = 'secret') {
    handle = createDrive123Handler({
      sessionFile,
      env: { DRIVE123_CLIENT_ID: 'client', DRIVE123_CLIENT_SECRET: secret, DRIVE123_REDIRECT_URI: base + '/callback' },
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
    assert.equal(authorize.origin + authorize.pathname, 'https://yun.123pan.com/auth');
    assert.equal(authorize.searchParams.get('redirect_uri'), base + '/callback');
    assert.equal(authorize.searchParams.get('scope'), 'user:base,file:all:read,file:all:write');
    assert.equal(authorize.searchParams.has('client_secret'), false);
    const state = authorize.searchParams.get('state');
    const [pendingCookie] = connect.headers.getSetCookie();
    assert.match(pendingCookie, /^groovebox_drive123_pending=[\w-]{43}; Path=\/api\/drive123; HttpOnly; SameSite=Lax/);
    const headers = { Cookie: pendingCookie.split(';')[0] };
    const route = '/callback?code=example&state=' + state;
    assert.equal((await request(route)).status, 400);
    const callback = await request(route, { headers });
    assert.equal(callback.headers.get('location'), '/?drive123=connected');
    assert.equal((await request(route, { headers })).status, 400);
    const exchange = calls[0];
    assert.equal(exchange.url.pathname, '/api/v1/oauth2/access_token');
    assert.equal(exchange.url.searchParams.get('client_secret'), 'secret');
    assert.equal(exchange.url.searchParams.get('code'), 'example');
    assert.equal(exchange.url.searchParams.get('redirect_uri'), base + '/callback');
    assert.equal(exchange.options.method, 'POST');
    assert.equal(exchange.options.headers.Platform, 'open_platform');
    return callback.headers.getSetCookie()[1].split(';')[0];
  }
  return { origin, request, login, calls, restart };
}

function issueToken(accessToken = 'access', refreshToken = 'refresh') {
  return Response.json({ access_token: accessToken, refresh_token: refreshToken, expires_in: 7200 });
}
const content = data => Response.json({ code: 0, data });
const mediaId = '9223372036854775807';

test('123 Drive authorizes, refreshes, paginates, filters deleted content and streams signed URLs', async t => {
  const f = await fixture(t, (url, options) => {
    if (url.pathname === '/api/v1/oauth2/access_token') {
      assert.equal(options.headers.Authorization, undefined);
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        assert.equal(url.searchParams.get('refresh_token'), 'refresh');
        return issueToken('renewed-access', 'rotated-refresh');
      }
      return issueToken();
    }
    if (url.host === 'open-api.123pan.com') {
      assert.equal(options.headers.Platform, 'open_platform');
      if (options.headers.Authorization === 'Bearer access') {
        return Response.json({ code: 401, data: null });
      }
      assert.equal(options.headers.Authorization, 'Bearer renewed-access');
      if (url.pathname === '/api/v2/file/list') {
        assert.equal(url.searchParams.get('limit'), '100');
        assert.equal(url.searchParams.get('parentFileId'), '0');
        if (url.searchParams.get('lastFileId') === '17') {
          return new Response('{"code":0,"data":{"lastFileId":-1,"fileList":[{"fileId":' + mediaId +
            ',"filename":"蓝色夜空.flac","type":0,"size":20},{"fileId":3,"filename":"蓝色夜空.vtt","type":0}]}}');
        }
        return content({
          lastFileId: 17, fileList: [{ fileId: 1, filename: '古典', type: 1 },
            { fileId: 5, filename: '删除.mp3', trashed: 1, type: 0 },
            { fileId: 6, filename: '审核驳回.mp3', status: 101, type: 0 }],
        });
      }
      if (url.pathname.endsWith('/detail')) {
        const id = url.searchParams.get('fileID');
        return content({ fileID: id, filename: id === '3' ? '蓝色夜空.vtt' : '蓝色夜空.flac', type: 0 });
      }
      const id = url.searchParams.get('fileId');
      assert.ok(id === mediaId || id === '3');
      return content({ downloadUrl: 'https://download.123pan.cn/content?file=' + id + '&sign=%20' });
    }
    assert.equal(url.host, 'download.123pan.cn');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(url.searchParams.get('sign'), ' ');
    if (url.searchParams.get('file') === '3') {
      return new Response('WEBVTT\r\n\r\n00:00.000 --> 00:03.000\r\n蓝色夜空');
    }
    assert.equal(options.headers.Range, 'bytes=2-4');
    return new Response(options.method === 'HEAD' ? null : Buffer.from([2, 3, 4]), {
      status: 206, headers: { 'Content-Range': 'bytes 2-4/20', 'Content-Length': '3' },
    });
  });
  assert.equal((await f.request('/list')).status, 401);
  const Cookie = await f.login();
  const headers = { Cookie };
  const responses = await Promise.all([f.request('/list', { headers }), f.request('/list', { headers })]);
  for (const response of responses) {
    assert.deepEqual((await response.json()).items, [
      { path: '1', id: '1', name: '古典', folder: true, size: 0, streamUrl: null },
      { path: mediaId, id: mediaId, name: '蓝色夜空.flac', folder: false, size: 20, streamUrl: '/api/drive123/stream?id=' + mediaId },
      { path: '3', id: '3', name: '蓝色夜空.vtt', folder: false, size: 0, streamUrl: '/api/drive123/stream?id=3' },
    ]);
  }
  assert.equal(f.calls.filter(({ url }) => url.searchParams.get('grant_type') === 'refresh_token').length, 1);
  for (const method of ['GET', 'HEAD']) {
    const res = await f.request('/stream?id=' + mediaId, { method, headers: { Cookie, Range: 'bytes=2-4' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 2-4/20');
    assert.equal(res.headers.get('content-type'), 'audio/flac');
    assert.equal(res.headers.get('location'), null);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], method === 'HEAD' ? [] : [2, 3, 4]);
  }
  const lyric = await f.request('/stream?id=3', { headers });
  assert.equal(lyric.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await lyric.text(), 'WEBVTT\n\n00:00.000 --> 00:03.000\n蓝色夜空');
  assert.equal((await f.request('/disconnect', { method: 'POST', headers: { Cookie, Origin: f.origin } })).status, 200);
  assert.equal((await f.request('/list', { headers })).status, 401);
});

test('123 Drive blocks foreign downloads and reports exhausted download quota', async t => {
  const f = await fixture(t, url => {
    if (url.pathname === '/api/v1/oauth2/access_token') return issueToken();
    if (url.pathname.endsWith('/detail')) return content({ filename: '曲目.wav', type: 0 });
    if (url.searchParams.get('fileId') === '1') return Response.json({ code: 5113, data: null });
    return content({ downloadUrl: 'https://malicious.example/track' });
  });
  const Cookie = await f.login();
  const headers = { Cookie };
  assert.equal((await f.request('/stream?id=1', { headers })).status, 429);
  assert.equal((await f.request('/stream?id=2', { headers })).status, 502);
  assert.ok(f.calls.every(({ url }) => url.host === 'open-api.123pan.com'));
});

test('123 Drive restores its encrypted session after restart and persists refresh and disconnect', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-drive123-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'auth.enc');
  let refreshed = 0;
  const f = await fixture(t, (endpoint, options) => {
    const url = new URL(endpoint);
    if (url.pathname === '/api/v1/oauth2/access_token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'refresh_token') {
        assert.equal(url.searchParams.get('refresh_token'), 'initial-refresh-secret');
        refreshed++;
        return Response.json({ access_token: 'fresh-access-secret', refresh_token: 'new-refresh-secret', expires_in: 3600 });
      }
      assert.equal(grant, 'authorization_code');
      return Response.json({ access_token: 'initial-access-secret', refresh_token: 'initial-refresh-secret', expires_in: 1 });
    }
    assert.equal(options.headers.Authorization, 'Bearer fresh-access-secret');
    assert.equal(url.pathname, '/api/v2/file/list');
    return content({ lastFileId: -1, fileList: [] });
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
