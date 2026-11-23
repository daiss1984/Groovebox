import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { createPcloudHandler } from '../server/pcloud.mjs';

async function fixture(t, upstream, sessionFile) {
  let origin;
  let handle;
  const server = createServer((req, res) => handle(req, res, new URL(req.url, origin)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + '/api/pcloud';
  const calls = [];
  function restart(secret = 'pcloud-secret') {
    handle = createPcloudHandler({
      sessionFile,
      env: { PCLOUD_CLIENT_ID: 'pcloud-key', PCLOUD_CLIENT_SECRET: secret, PCLOUD_REDIRECT_URI: base + '/callback' },
      request: (url, options) => {
        calls.push({ url, options });
        return upstream(url, options);
      },
    });
  }
  restart();
  const request = (route, options) => fetch(base + route, { redirect: 'manual', ...options });
  async function authorize() {
    const connect = await request('/connect');
    const authorize = new URL(connect.headers.get('location'));
    assert.equal(authorize.origin + authorize.pathname, 'https://my.pcloud.com/oauth2/authorize');
    assert.equal(authorize.searchParams.get('redirect_uri'), base + '/callback');
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.has('permissions'), false);
    assert.equal(authorize.searchParams.has('client_secret'), false);
    const [pending] = connect.headers.getSetCookie();
    assert.match(pending, /^groovebox_pcloud_pending=[\w-]{43}; Path=\/api\/pcloud; HttpOnly; SameSite=Lax/);
    const state = authorize.searchParams.get('state');
    assert.match(state, /^[\w-]{43}$/);
    return { state, Cookie: pending.split(';')[0] };
  }
  async function callback(authorization, params, withCookie = true) {
    return request('/callback?' + new URLSearchParams({ state: authorization.state, ...params }),
      withCookie ? { headers: { Cookie: authorization.Cookie } } : {});
  }
  async function login(locationid, hostname) {
    const authorization = await authorize();
    const params = { code: 'example', locationid, hostname };
    assert.equal((await callback(authorization, params, false)).status, 400);
    const response = await callback(authorization, params);
    assert.equal(response.headers.get('location'), '/?pcloud=connected');
    assert.equal((await callback(authorization, params)).status, 400);
    return response.headers.getSetCookie()[1].split(';')[0];
  }
  return { origin, request, authorize, callback, login, calls, restart };
}

const fileid = '18446744073709551615';
const values = [
  { folderid: 2, id: 'd2', isfolder: true, name: '收藏' },
  { fileid: 3, id: 'f3', isfolder: false, name: '晚风.LRC', size: 25 },
  { fileid: 4, id: 'f4', isfolder: false, name: '封面.jpg' },
];

test('pCloud isolates US/EU OAuth sessions and proxies signed range audio and lyric files', async t => {
  const f = await fixture(t, (url, options) => {
    if (url.pathname === '/oauth2_token') {
      assert.equal(options.method, 'POST');
      assert.equal(url.search, '');
      assert.equal(options.body.get('client_id'), 'pcloud-key');
      assert.equal(options.body.get('client_secret'), 'pcloud-secret');
      assert.equal(options.body.get('code'), 'example');
      return Response.json({ result: 0, access_token: url.host + '-token' });
    }
    if (['eapi.pcloud.com', 'api.pcloud.com'].includes(url.host)) {
      assert.equal(options.headers.Authorization, 'Bearer ' + url.host + '-token');
      assert.equal(options.headers.Connection, 'close');
      assert.equal(url.searchParams.has('access_token'), false);
      if (url.pathname === '/listfolder') {
        if (url.searchParams.get('folderid') === '2') {
          assert.equal(url.host, 'api.pcloud.com');
          return Response.json({ result: 0, metadata: { contents: [values[1]] } });
        }
        assert.equal(url.searchParams.get('folderid'), '0');
        return new Response('{"result":0,"metadata":{"contents":[{"fileid":' + fileid +
          ',"name":"晚风.mp3","size":20},' + values.map(value => JSON.stringify(value)).join(',') + ']}}');
      }
      const id = url.searchParams.get('fileid');
      if (url.pathname === '/stat') {
        return Response.json({ result: 0, metadata: { name: id === '3' ? '晚风.LRC' : '晚风.mp3' } });
      }
      assert.equal(url.pathname, '/getfilelink');
      assert.equal(url.searchParams.get('forcedownload'), '1');
      assert.ok(id === '3' || id === fileid);
      return Response.json({ result: 0, hosts: ['c10.pcloud.com'], path: '/signed/track?file=' + id + '&sign=%20' });
    }
    assert.equal(url.host, 'c10.pcloud.com');
    assert.equal(url.searchParams.get('sign'), ' ');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    if (url.searchParams.get('file') === '3') {
      assert.equal(options.headers.Range, undefined);
      return new Response('[00:01.00]晚风\r\n');
    }
    assert.equal(options.headers.Range, 'bytes=0-2');
    return new Response(options.method === 'HEAD' ? null : Buffer.from([1, 2, 3]), {
      status: 206, headers: { 'Content-Range': 'bytes 0-2/20', 'Content-Length': '3' },
    });
  });
  assert.equal((await f.request('/list')).status, 401);
  const usSession = await f.login('1', 'api.pcloud.com');
  const euSession = await f.login('2', 'eapi.pcloud.com');
  assert.notEqual(usSession, euSession);
  const eu = { Cookie: euSession };
  const us = { Cookie: usSession };
  const root = await f.request('/list?path=/', { headers: eu });
  assert.deepEqual((await root.json()).items, [
    { id: 'f' + fileid, path: fileid, name: '晚风.mp3', folder: false, size: 20, streamUrl: '/api/pcloud/stream?id=' + fileid },
    { id: 'd2', path: '2', name: '收藏', folder: true, size: 0, streamUrl: null },
    { id: 'f3', path: '3', name: '晚风.LRC', folder: false, size: 25, streamUrl: '/api/pcloud/stream?id=3' },
    { id: 'f4', path: '4', name: '封面.jpg', folder: false, size: 0, streamUrl: null },
  ]);
  const album = await f.request('/list?path=2', { headers: us });
  assert.equal((await album.json()).items[0].name, '晚风.LRC');
  for (const method of ['GET', 'HEAD']) {
    const response = await f.request('/stream?id=' + fileid, { method, headers: { ...eu, Range: 'bytes=0-2' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('content-range'), 'bytes 0-2/20');
    assert.equal(response.headers.get('location'), null);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], method === 'HEAD' ? [] : [1, 2, 3]);
  }
  const lyric = await f.request('/stream?id=3', { headers: eu });
  assert.equal(lyric.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await lyric.text(), '[00:01.00]晚风\n');
  const disconnect = (Origin) => f.request('/disconnect', { method: 'POST', headers: { ...eu, Origin } });
  assert.equal((await disconnect('https://example.com')).status, 403);
  assert.equal((await disconnect(f.origin)).status, 200);
  assert.equal((await f.request('/list', { headers: eu })).status, 401);
  assert.equal((await f.request('/list', { headers: us })).status, 200);
});

test('pCloud refuses foreign regional endpoints and out-of-domain CDN redirects', async t => {
  const f = await fixture(t, (url) => {
    if (url.pathname === '/oauth2_token') return Response.json({ result: 0, access_token: 'pcloud-token' });
    if (url.pathname === '/stat') return Response.json({ result: 0, metadata: { name: 'test.wav' } });
    if (url.pathname === '/getfilelink') return Response.json({ result: 0, hosts: ['c11.pcloud.com'], path: '/signed' });
    return Response.redirect('https://example.com/track');
  });
  for (const params of [
    { locationid: '1', hostname: 'eapi.pcloud.com' },
    { locationid: '2', hostname: 'example.com' },
  ]) {
    const pending = await f.authorize();
    const response = await f.callback(pending, { code: 'example', ...params });
    assert.equal(response.headers.get('location'), '/?pcloud=error');
    assert.equal(f.calls.length, 0);
  }
  const Cookie = await f.login('2', 'eapi.pcloud.com');
  assert.equal((await f.request('/stream?id=4', { headers: { Cookie } })).status, 502);
  assert.deepEqual(f.calls.map(({ url }) => url.hostname), [
    'eapi.pcloud.com', 'eapi.pcloud.com', 'eapi.pcloud.com', 'c11.pcloud.com',
  ]);
});

test('pCloud restores both API regions and remembers upstream revocation and disconnect after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-pcloud-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'auth.enc');
  let revokeEurope = false;
  const f = await fixture(t, (url, options) => {
    assert.ok(['api.pcloud.com', 'eapi.pcloud.com'].includes(url.hostname));
    const token = 'secret-token-for-' + url.hostname;
    if (url.pathname === '/oauth2_token') return Response.json({ result: 0, access_token: token });
    assert.equal(url.pathname, '/listfolder');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    if (revokeEurope && url.hostname === 'eapi.pcloud.com') return Response.json({ result: 2000 });
    return Response.json({ result: 0, metadata: { contents: [] } });
  }, sessionFile);
  const america = { Cookie: await f.login('1', 'api.pcloud.com') };
  const europe = { Cookie: await f.login('2', 'eapi.pcloud.com') };
  const encrypted = await readFile(sessionFile);
  assert.equal(encrypted.includes(Buffer.from('secret-token-for-')), false);
  assert.equal(encrypted.includes(Buffer.from('eapi.pcloud.com')), false);

  f.restart('different-oauth-app-secret');
  assert.deepEqual(await (await f.request('/status', { headers: europe })).json(), { configured: true, connected: false });
  f.restart();
  for (const headers of [america, europe]) {
    assert.deepEqual(await (await f.request('/status', { headers })).json(), { configured: true, connected: true });
    assert.deepEqual(await (await f.request('/list', { headers })).json(), { items: [] });
  }

  revokeEurope = true;
  assert.equal((await f.request('/list', { headers: europe })).status, 401);
  f.restart();
  assert.deepEqual(await (await f.request('/status', { headers: europe })).json(), { configured: true, connected: false });
  assert.deepEqual(await (await f.request('/list', { headers: america })).json(), { items: [] });
  assert.equal((await f.request('/disconnect', { method: 'POST', headers: { ...america, Origin: f.origin } })).status, 200);
  f.restart();
  assert.equal((await f.request('/list', { headers: america })).status, 401);
});
