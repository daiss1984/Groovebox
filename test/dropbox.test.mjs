import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDropboxHandler } from '../server/dropbox.mjs';

const prefix = '/api/dropbox';
const scope = 'files.metadata.read files.content.read';
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
    handler = createDropboxHandler({ request, sessionFile, env: configured ? {
      DROPBOX_CLIENT_ID: 'test-client',
      DROPBOX_CLIENT_SECRET: secret,
      DROPBOX_REDIRECT_URI: callback,
    } : {} });
  }
  restart();
  const get = (action, options = {}) => fetch(base + prefix + action, { redirect: 'manual', ...options });
  const authorization = async () => {
    const response = await get('/connect');
    assert.equal(response.status, 303);
    const auth = new URL(response.headers.get('location'));
    assert.equal(auth.origin, 'https://www.dropbox.com');
    assert.equal(auth.searchParams.get('redirect_uri'), callback);
    assert.equal(auth.searchParams.get('scope'), scope);
    assert.equal(auth.searchParams.get('token_access_type'), 'offline');
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
    assert.equal(response.headers.get('location'), '/?dropbox=connected');
    return localCookie(response)[0];
  };
  return { base, get, authorization, connect, restart };
}

test('Dropbox exposes unconfigured status without using an upstream', async (t) => {
  const { get } = await fixture(t, () => assert.fail('unexpected upstream request'), false);
  assert.deepEqual(await (await get('/status')).json(), { configured: false, connected: false });
  assert.equal((await get('/connect')).status, 503);
});

test('Dropbox authorization checks the browser cookie and consumes the OAuth state once', async (t) => {
  let exchangeCount = 0;
  let received;
  const { authorization, get } = await fixture(t, async (endpoint, options) => {
    assert.equal(String(endpoint), 'https://api.dropboxapi.com/oauth2/token');
    assert.equal(options.method, 'POST');
    exchangeCount++;
    received = new URLSearchParams(options.body);
    return Response.json({ access_token: 'dropbox-access', refresh_token: 'dropbox-refresh', expires_in: 3600, scope });
  });
  const { state, cookie } = await authorization();
  const path = '/callback?code=test-code&state=';
  assert.equal((await get(path + state)).headers.get('location'), '/?dropbox=error');
  assert.equal((await get(path + 'incorrect', { headers: { cookie } })).headers.get('location'), '/?dropbox=error');
  const result = await get(path + state, { headers: { cookie } });
  assert.equal(result.headers.get('location'), '/?dropbox=connected');
  const authCookie = localCookie(result)[0];
  assert.ok(authCookie);
  assert.equal(received.get('grant_type'), 'authorization_code');
  assert.equal(received.get('client_secret'), 'test-secret');
  assert.equal(received.get('code'), 'test-code');
  assert.equal((await get(path + state, { headers: { cookie } })).headers.get('location'), '/?dropbox=error');
  assert.equal(exchangeCount, 1);
  assert.deepEqual(await (await get('/status', { headers: { cookie: authCookie } })).json(), { configured: true, connected: true });
  assert.equal((await get('/disconnect', { method: 'POST', headers: { cookie: authCookie, origin: 'https://unrelated.test' } })).status, 403);
  assert.equal((await get('/disconnect', { method: 'POST', headers: { cookie: authCookie } })).status, 200);
  assert.equal((await get('/list', { headers: { cookie: authCookie } })).status, 401);
});

test('Dropbox paginates a directory, refreshes once, and proxies partial audio and lyrics', async (t) => {
  const requests = [];
  let refreshCount = 0;
  const song = { id: 'id:file_v1', name: '夜曲.m4a', '.tag': 'file', size: 8000 };
  const lyrics = { id: 'id:lrc_abc', name: '夜曲.lrc', '.tag': 'file', size: 16 };
  const folder = { id: 'id:folder_1', name: '我的唱片', '.tag': 'folder' };
  const playable = new Map([[song.id, song], [lyrics.id, lyrics]]);
  const { connect, get } = await fixture(t, async (endpoint, options) => {
    const url = new URL(endpoint);
    requests.push([url, options]);
    if (url.pathname === '/oauth2/token') {
      if (options.body.get('grant_type') === 'refresh_token') {
        refreshCount++;
        assert.equal(options.body.get('refresh_token'), 'test-refresh');
        return Response.json({ access_token: 'longer', expires_in: 3600 });
      }
      return Response.json({ access_token: 'short', refresh_token: 'test-refresh', expires_in: 1, scope });
    }
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer longer');
    assert.equal(url.searchParams.has('access_token'), false);
    if (url.hostname === 'api.dropboxapi.com') {
      const args = JSON.parse(options.body);
      if (url.pathname.endsWith('/list_folder/continue')) {
        assert.deepEqual(args, { cursor: 'page-two' });
        return Response.json({ entries: [lyrics], has_more: false });
      }
      if (url.pathname.endsWith('/list_folder')) {
        if (args.path === folder.id) return Response.json({ entries: [song, lyrics], has_more: false });
        assert.equal(args.path, '');
        return Response.json({
          entries: [folder, song, { id: 'id:doc_id', name: '文档.odt', '.tag': 'file' }],
          has_more: true,
          cursor: 'page-two',
        });
      }
      assert.equal(url.pathname, '/2/files/get_metadata');
      return Response.json(playable.get(args.path));
    }
    assert.equal(url.hostname, 'content.dropboxapi.com');
    assert.equal(url.pathname, '/2/files/download');
    const id = JSON.parse(options.headers['Dropbox-API-Arg']).path;
    if (id === lyrics.id) return new Response('[00:01.50]歌词');
    assert.equal(options.headers.Range, 'bytes=4-7');
    return new Response(Uint8Array.of(1, 2, 3, 4), {
      status: 206, headers: { 'Content-Length': '4', 'Content-Range': 'bytes 4-7/8000' },
    });
  });
  const cookie = await connect();
  const [one, two] = await Promise.all([
    get('/list', { headers: { cookie } }),
    get('/list?path=' + encodeURIComponent(folder.id), { headers: { cookie } }),
  ]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  const { items } = await one.json();
  assert.deepEqual(items, [
    { id: folder.id, name: folder.name, path: folder.id, folder: true, size: 0, streamUrl: null },
    { id: song.id, name: song.name, path: song.id, folder: false, size: 8000, streamUrl: prefix + '/stream?id=' + encodeURIComponent(song.id) },
    { id: lyrics.id, name: lyrics.name, path: lyrics.id, folder: false, size: 16, streamUrl: prefix + '/stream?id=' + encodeURIComponent(lyrics.id) },
  ]);
  assert.equal(refreshCount, 1);
  assert.equal(requests.filter(([url]) => url.pathname.endsWith('/list_folder/continue')).length, 1);

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

test('Dropbox restores its encrypted session after restart and persists refresh and disconnect', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-dropbox-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'auth.enc');
  let refreshed = 0;
  const f = await fixture(t, (endpoint, options) => {
    const url = new URL(endpoint);
    if (url.hostname === 'api.dropboxapi.com' && url.pathname.endsWith('/token')) {
      if (options.body.get('grant_type') === 'refresh_token') {
        assert.equal(options.body.get('refresh_token'), 'initial-refresh-secret');
        refreshed++;
        return Response.json({ access_token: 'fresh-access-secret', refresh_token: 'new-refresh-secret', expires_in: 3600 });
      }
      assert.equal(options.body.get('grant_type'), 'authorization_code');
      return Response.json({ access_token: 'initial-access-secret', refresh_token: 'initial-refresh-secret', expires_in: 1 });
    }
    assert.equal(url.hostname, 'api.dropboxapi.com');
    assert.equal(options.headers.Authorization, 'Bearer fresh-access-secret');
    return Response.json({ entries: [], has_more: false });
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
