import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAliyundriveHandler } from '../server/aliyundrive.mjs';

const prefix = '/api/aliyundrive';
const scope = 'user:base,file:all:read';
const localCookie = (response) => response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.endsWith('='));

async function fixture(t, request, configured = true, sessionFile) {
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
    handler = createAliyundriveHandler({ request, sessionFile, env: configured ? {
      ALIYUNDRIVE_CLIENT_ID: 'test-client',
      ALIYUNDRIVE_CLIENT_SECRET: secret,
      ALIYUNDRIVE_REDIRECT_URI: callback,
    } : {} });
  }
  restart();
  const get = (action, options = {}) => fetch(base + prefix + action, { redirect: 'manual', ...options });
  const authorization = async () => {
    const response = await get('/connect');
    assert.equal(response.status, 303);
    const auth = new URL(response.headers.get('location'));
    assert.equal(auth.origin, 'https://openapi.alipan.com');
    assert.equal(auth.searchParams.get('redirect_uri'), callback);
    assert.equal(auth.searchParams.get('scope'), scope);
    assert.equal(auth.pathname, '/oauth/authorize');
    const state = auth.searchParams.get('state');
    return {
      cookie: localCookie(response)[0],
      state,
    };
  };
  const connect = async () => {
    const { cookie, state } = await authorization();
    const response = await get('/callback?code=test-code&state=' + state, { headers: { cookie } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/?aliyundrive=connected');
    return localCookie(response)[0];
  };
  return { base, get, authorization, connect, restart };
}

test('Aliyun Drive exposes unconfigured status without using an upstream', async (t) => {
  const { get } = await fixture(t, () => assert.fail('unexpected upstream request'), false);
  assert.deepEqual(await (await get('/status')).json(), { configured: false, connected: false });
  assert.equal((await get('/connect')).status, 503);
});

test('Aliyun Drive authorization checks the browser cookie and consumes the OAuth state once', async (t) => {
  let exchangeCount = 0;
  let received;
  const { authorization, get } = await fixture(t, async (endpoint, options) => {
    assert.equal(String(endpoint), 'https://openapi.alipan.com/oauth/access_token');
    assert.equal(options.method, 'POST');
    exchangeCount++;
    received = JSON.parse(options.body);
    return Response.json({ access_token: 'box-access', refresh_token: 'box-refresh', expires_in: 3600, scope });
  });
  const { state, cookie } = await authorization();
  const path = '/callback?code=test-code&state=';
  assert.equal((await get(path + state)).headers.get('location'), '/?aliyundrive=error');
  assert.equal((await get(path + 'incorrect', { headers: { cookie } })).headers.get('location'), '/?aliyundrive=error');
  const result = await get(path + state, { headers: { cookie } });
  assert.equal(result.headers.get('location'), '/?aliyundrive=connected');
  const authCookie = localCookie(result)[0];
  assert.ok(authCookie);
  assert.equal(received.grant_type, 'authorization_code');
  assert.equal(received.client_secret, 'test-secret');
  assert.equal(received.code, 'test-code');
  assert.equal((await get(path + state, { headers: { cookie } })).headers.get('location'), '/?aliyundrive=error');
  assert.equal(exchangeCount, 1);
  assert.deepEqual(await (await get('/status', { headers: { cookie: authCookie } })).json(), { configured: true, connected: true });
  assert.equal((await get('/disconnect', { method: 'POST', headers: { cookie: authCookie, origin: 'https://unrelated.test' } })).status, 403);
  assert.equal((await get('/disconnect', { method: 'POST', headers: { cookie: authCookie } })).status, 200);
  assert.equal((await get('/list', { headers: { cookie: authCookie } })).status, 401);
});

test('Aliyun Drive paginates a directory, refreshes once, and proxies partial audio and lyrics', async (t) => {
  const requests = [];
  let refreshCount = 0;
  const drive = '123';
  const song = { file_id: 'file_v1', name: '夜曲.m4a', type: 'file', size: 8000 };
  const lyrics = { file_id: 'lrc_abc', name: '夜曲.lrc', type: 'file', size: 16 };
  const folder = { file_id: 'folder_1', name: '我的唱片', type: 'folder' };
  const playable = new Map([[song.file_id, song], [lyrics.file_id, lyrics]]);
  const { connect, get } = await fixture(t, async (endpoint, options) => {
    const url = new URL(endpoint);
    requests.push([url, options]);
    if (url.hostname === 'openapi.alipan.com') {
      assert.equal(options.method, 'POST');
      const data = JSON.parse(options.body);
      if (url.pathname === '/oauth/access_token') {
        if (data.grant_type === 'refresh_token') {
          refreshCount++;
          assert.equal(data.refresh_token, 'test-refresh');
          return Response.json({ access_token: 'longer', refresh_token: 'rotated', expires_in: 3600 });
        }
        return Response.json({ access_token: 'short', refresh_token: 'test-refresh', expires_in: 1, scope });
      }
      assert.equal(options.headers.Authorization, 'Bearer longer');
      if (url.pathname.endsWith('/getDriveInfo')) {
        return Response.json({ resource_drive_id: drive, default_drive_id: drive, backup_drive_id: '456' });
      }
      assert.equal(data.drive_id, drive);
      if (url.pathname.endsWith('/list')) {
        assert.equal(data.limit, 100);
        if (data.parent_file_id === folder.file_id) return Response.json({ items: [song, lyrics] });
        assert.equal(data.parent_file_id, 'root');
        if (data.marker === 'page-two') return Response.json({ items: [lyrics] });
        return Response.json({
          items: [folder, song, { file_id: 'doc_id', name: '文档.odt', type: 'file' }], next_marker: 'page-two',
        });
      }
      if (url.pathname.endsWith('/get')) return Response.json(playable.get(data.file_id));
      assert.equal(url.pathname, '/adrive/v1.0/openFile/getDownloadUrl');
      assert.equal(data.expire_sec, 900);
      return Response.json({ url: 'https://dl1-v6.aliyundrive.cloud/sample/' + data.file_id + '?signed=123', method: 'GET' });
    }
    assert.equal(url.searchParams.get('signed'), '123');
    assert.equal(options.headers.Authorization, undefined);
    if (url.hostname === 'dl1-v6.aliyundrive.cloud') {
      return new Response(null, {
        status: 302, headers: { Location: 'https://cn-beijing-data.aliyundrive.net' + url.pathname + url.search },
      });
    }
    assert.equal(url.hostname, 'cn-beijing-data.aliyundrive.net');
    const id = url.pathname.split('/').at(-1);
    if (id === lyrics.file_id) return new Response('[00:01.50]歌词');
    assert.equal(options.headers.Range, 'bytes=4-7');
    return new Response(Uint8Array.of(1, 2, 3, 4), {
      status: 206, headers: { 'Content-Length': '4', 'Content-Range': 'bytes 4-7/8000' },
    });
  });
  const id = (file) => drive + ':' + file.file_id;
  const stream = (file) => '/stream?id=' + encodeURIComponent(id(file));
  const cookie = await connect();
  const [one, two, root] = await Promise.all([
    get('/list?path=123%3Aroot', { headers: { cookie } }),
    get('/list?path=' + encodeURIComponent(id(folder)), { headers: { cookie } }),
    get('/list', { headers: { cookie } }),
  ]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.deepEqual((await root.json()).items.map(item => item.name), ['资源库', '备份盘']);
  const { items } = await one.json();
  assert.deepEqual(items, [
    { id: id(folder), name: folder.name, path: id(folder), folder: true, size: 0, streamUrl: null },
    { id: id(song), name: song.name, path: id(song), folder: false, size: 8000, streamUrl: prefix + stream(song) },
    { id: id(lyrics), name: lyrics.name, path: id(lyrics), folder: false, size: 16, streamUrl: prefix + stream(lyrics) },
  ]);
  assert.equal(refreshCount, 1);
  assert.equal(requests.filter(([url, options]) => url.pathname.endsWith('/list') && JSON.parse(options.body).marker === 'page-two').length, 1);
  assert.equal(requests.filter(([url]) => url.pathname.endsWith('/getDriveInfo')).length, 1);

  const audio = await get(stream(song), { headers: { cookie, range: 'bytes=4-7' } });
  assert.equal(audio.status, 206);
  assert.equal(audio.headers.get('content-range'), 'bytes 4-7/8000');
  assert.equal(audio.headers.get('content-type'), 'audio/mp4');
  assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [1, 2, 3, 4]);
  const head = await get(stream(song), { method: 'HEAD', headers: { cookie, range: 'bytes=4-7' } });
  assert.equal(head.status, 206);
  assert.equal(await head.text(), '');
  const lrc = await get(stream(lyrics), { headers: { cookie } });
  assert.equal(lrc.headers.get('content-type'), 'text/plain');
  assert.equal(await lrc.text(), '[00:01.50]歌词');
});


test('Aliyun Drive refuses off-domain signed download destinations', async (t) => {
  const { connect, get } = await fixture(t, async (endpoint) => {
    const url = new URL(endpoint);
    assert.equal(url.hostname, 'openapi.alipan.com');
    if (url.pathname === '/oauth/access_token') return Response.json({ access_token: 'test-access', expires_in: 3600, scope });
    if (url.pathname.endsWith('/getDriveInfo')) return Response.json({ default_drive_id: '123' });
    if (url.pathname.endsWith('/get')) return Response.json({ file_id: 'abc', name: '演示.wav', type: 'file' });
    assert.ok(url.pathname.endsWith('/getDownloadUrl'));
    return Response.json({ url: 'https://aliyundrive.cloud.unrelated.test/file', method: 'GET' });
  });
  const cookie = await connect();
  const response = await get('/stream?id=123%3Aabc', { headers: { cookie } });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /非受信/);
});

test('Aliyun Drive restores its encrypted session after restart and persists refresh and disconnect', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-aliyundrive-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'auth.enc');
  let refreshed = 0;
  const f = await fixture(t, (endpoint, options) => {
    const url = new URL(endpoint);
    if (url.pathname === '/oauth/access_token') {
      const grant = JSON.parse(options.body).grant_type;
      if (grant === 'refresh_token') {
        assert.equal(JSON.parse(options.body).refresh_token, 'initial-refresh-secret');
        refreshed++;
        return Response.json({ access_token: 'fresh-access-secret', refresh_token: 'new-refresh-secret', expires_in: 3600 });
      }
      assert.equal(grant, 'authorization_code');
      return Response.json({ access_token: 'initial-access-secret', refresh_token: 'initial-refresh-secret', expires_in: 1 });
    }
    assert.equal(options.headers.Authorization, 'Bearer fresh-access-secret');
    if (url.pathname.endsWith('/getDriveInfo')) return Response.json({ resource_drive_id: '123' });
    assert.match(url.pathname, /\/openFile\/list$/);
    return Response.json({ items: [] });
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
