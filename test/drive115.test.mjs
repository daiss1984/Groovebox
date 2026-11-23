import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { createDrive115Handler } from '../server/drive115.mjs';

async function fixture(t, upstream, sessionFile) {
  let origin;
  let handle;
  const server = createServer((req, res) => handle(req, res, new URL(req.url, origin)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + '/api/drive115';
  const calls = [];
  function restart(secret = 'secret') {
    handle = createDrive115Handler({
      sessionFile,
      env: { DRIVE115_CLIENT_ID: 'client', DRIVE115_CLIENT_SECRET: secret, DRIVE115_REDIRECT_URI: base + '/callback' },
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
    assert.equal(authorize.origin + authorize.pathname, 'https://passportapi.115.com/open/authorize');
    assert.equal(authorize.searchParams.get('redirect_uri'), base + '/callback');
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.has('client_secret'), false);
    const state = authorize.searchParams.get('state');
    const [pendingCookie] = connect.headers.getSetCookie();
    assert.match(pendingCookie, /^groovebox_drive115_pending=[\w-]{43}; Path=\/api\/drive115; HttpOnly; SameSite=Lax/);
    const headers = { Cookie: pendingCookie.split(';')[0] };
    const route = '/callback?code=example&state=' + state;
    assert.equal((await request(route)).status, 400);
    const callback = await request(route, { headers });
    assert.equal(callback.headers.get('location'), '/?drive115=connected');
    assert.equal((await request(route, { headers })).status, 400);
    const exchange = calls[0];
    assert.equal(exchange.url.pathname, '/open/authCodeToToken');
    assert.equal(exchange.options.body.get('client_secret'), 'secret');
    assert.equal(exchange.options.body.get('code'), 'example');
    assert.equal(exchange.options.body.get('redirect_uri'), base + '/callback');
    assert.equal(exchange.options.method, 'POST');
    return callback.headers.getSetCookie()[1].split(';')[0];
  }
  return { origin, request, login, calls, restart };
}

function issueToken(accessToken = 'access', refreshToken = 'refresh') {
  return Response.json({ state: 1, code: 0, data: { access_token: accessToken, refresh_token: refreshToken, expires_in: 7200 } });
}
const plain = data => Response.json({ state: true, code: 0, data });
const mediaId = '9223372036854775807';

test('115 Drive uses browser authorization code, rotates tokens, paginates and proxies range audio and lyrics', async t => {
  const f = await fixture(t, (url, options) => {
    if (url.host === 'passportapi.115.com') {
      assert.equal(options.headers.Authorization, undefined);
      if (url.pathname === '/open/refreshToken') {
        assert.deepEqual([...options.body], [['refresh_token', 'refresh']]);
        return issueToken('renewed-access', 'rotated-refresh');
      }
      assert.equal(options.body.get('grant_type'), 'authorization_code');
      return issueToken();
    }
    if (url.host === 'proapi.115.com') {
      assert.equal(options.headers['User-Agent'], 'Groovebox/1.0');
      if (options.headers.Authorization === 'Bearer access') {
        return Response.json({ state: false, code: 40140125, data: [] });
      }
      assert.equal(options.headers.Authorization, 'Bearer renewed-access');
      if (url.pathname === '/open/ufile/files') {
        assert.equal(url.searchParams.get('cid'), '0');
        assert.equal(url.searchParams.get('limit'), '500');
        assert.equal(url.searchParams.get('show_dir'), '1');
        if (url.searchParams.get('offset') === '2') {
          return new Response('{"state":true,"code":0,"count":4,"data":[{"fid":' + mediaId +
            ',"fn":"蓝色夜空.flac","fc":"1","fs":20,"play_long":65},{"fid":"3","fn":"蓝色夜空.vtt","fc":"1"}]}');
        }
        return Response.json({ state: true, count: 4, data: [
          { fid: '1', fn: '古典', fc: '0' }, { fid: '5', fn: '删除.mp3', aid: '7', fc: '1' },
        ] });
      }
      if (url.pathname === '/open/folder/get_info') {
        const id = url.searchParams.get('file_id');
        return plain({
          file_id: id, file_name: id === '3' ? '蓝色夜空.vtt' : '蓝色夜空.flac', file_category: '1',
          pick_code: id === '3' ? 'lyricscode' : 'audiocode',
        });
      }
      assert.equal(url.pathname, '/open/ufile/downurl');
      assert.equal(options.method, 'POST');
      const code = options.body.get('pick_code');
      assert.ok(code === 'audiocode' || code === 'lyricscode');
      const id = code === 'lyricscode' ? '3' : mediaId;
      return plain({ [id]: { url: { url: 'https://foo.115cdn.net/file?id=' + id + '&sign=%20' } } });
    }
    assert.equal(url.host, 'foo.115cdn.net');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers['User-Agent'], 'Groovebox/1.0');
    assert.equal(url.searchParams.get('sign'), ' ');
    if (url.searchParams.get('id') === '3') {
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
      { path: mediaId, id: mediaId, name: '蓝色夜空.flac', folder: false, size: 20, streamUrl: '/api/drive115/stream?id=' + mediaId, duration: 65 },
      { path: '3', id: '3', name: '蓝色夜空.vtt', folder: false, size: 0, streamUrl: '/api/drive115/stream?id=3' },
    ]);
  }
  assert.equal(f.calls.filter(({ url }) => url.pathname === '/open/refreshToken').length, 1);
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

test('115 Drive rejects foreign file URLs and omits bearer tokens from download redirects', async t => {
  let signedUrl = 'https://malicious.example/track';
  const f = await fixture(t, (url, options) => {
    if (url.pathname === '/open/authCodeToToken') return issueToken();
    if (url.pathname === '/open/folder/get_info') {
      return plain({ file_name: '曲目.wav', file_category: '1', pick_code: 'audiocode' });
    }
    if (url.pathname === '/open/ufile/downurl') return plain({ 1: { url: { url: signedUrl } } });
    assert.equal(url.host, 'foo.115cdn.net');
    assert.equal(options.headers.Authorization, undefined);
    return Response.redirect('https://malicious.example/track');
  });
  const Cookie = await f.login();
  const headers = { Cookie };
  assert.equal((await f.request('/stream?id=1', { headers })).status, 502);
  signedUrl = 'https://foo.115cdn.net/track';
  assert.equal((await f.request('/stream?id=1', { headers })).status, 502);
  assert.deepEqual(f.calls.map(({ url }) => url.host), [
    'passportapi.115.com', 'proapi.115.com', 'proapi.115.com', 'proapi.115.com', 'proapi.115.com', 'foo.115cdn.net',
  ]);
});

test('115 Drive restores its encrypted session after restart and persists refresh and disconnect', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-drive115-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'auth.enc');
  let refreshed = 0;
  const f = await fixture(t, (endpoint, options) => {
    const url = new URL(endpoint);
    if (url.hostname === 'passportapi.115.com') {
      const grant = url.pathname === '/open/refreshToken' ? 'refresh_token' : options.body.get('grant_type');
      if (grant === 'refresh_token') {
        assert.equal(options.body.get('refresh_token'), 'initial-refresh-secret');
        refreshed++;
        return issueToken('fresh-access-secret', 'new-refresh-secret');
      }
      assert.equal(grant, 'authorization_code');
      return plain({ access_token: 'initial-access-secret', refresh_token: 'initial-refresh-secret', expires_in: 1 });
    }
    assert.equal(options.headers.Authorization, 'Bearer fresh-access-secret');
    assert.equal(url.pathname, '/open/ufile/files');
    return plain([]);
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
