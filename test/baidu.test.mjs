import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createBaiduHandler } from '../server/baidu.mjs';
import { inspectRemoteTrack } from '../public/remote-metadata.js';
import { createPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';
import { dsdFixture } from './helpers/dsd-fixture.mjs';

const prefix = '/api/baidu';
const anonymous = { configured: true, connected: false };
const connected = { configured: true, connected: true };
const mediaId = '9223372036854775807';

async function fixture(t, respond, { configured = true, sessionFile, callbackAddress, backupFolder } = {}) {
  const calls = [];
  let origin;
  let handler;
  const server = createServer((req, res) => handler(req, res, new URL(req.url, origin)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  origin = 'http://127.0.0.1:' + server.address().port;
  const redirectUri = callbackAddress ?? origin + prefix + '/callback';
  const restart = (secret = 'test-secret') => {
    handler = createBaiduHandler({
      sessionFile,
      env: configured ? {
        BAIDU_CLIENT_ID: 'test-key',
        BAIDU_CLIENT_SECRET: secret,
        BAIDU_REDIRECT_URI: redirectUri,
        BAIDU_BACKUP_APP_FOLDER: backupFolder,
      } : {},
      request: async (url, options) => {
        calls.push({ url: new URL(url), options });
        return respond(url, options);
      },
    });
  };
  restart();

  const request = (route, init) => fetch(origin + prefix + route, { ...init, redirect: 'manual' });
  async function authorize() {
    const response = await request('/connect');
    assert.equal(response.status, 303);
    const redirect = new URL(response.headers.get('location'));
    const [setCookie] = response.headers.getSetCookie();
    assert.equal(redirect.origin + redirect.pathname, 'https://openapi.baidu.com/oauth/2.0/authorize');
    assert.equal(redirect.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(redirect.searchParams.get('scope'), 'basic,netdisk');
    assert.equal(redirect.searchParams.has('client_secret'), false);
    assert.match(setCookie, /^musicer_baidu_oauth=[\w-]{43}; Path=\/api\/baidu; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const state = redirect.searchParams.get('state');
    assert.match(state, /^[\w-]{43}$/);
    return { state, cookie: firstPart(setCookie) };
  }

  function callback(auth, values, cookie = auth.cookie) {
    const query = new URLSearchParams({ state: auth.state, ...values });
    return request('/callback?' + query, cookie ? { headers: { Cookie: cookie } } : undefined);
  }

  async function login(code) {
    const auth = await authorize();
    const response = await callback(auth, { code });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/?baidu=connected');
    const [cleared, session] = response.headers.getSetCookie();
    assert.match(cleared, /^musicer_baidu_oauth=;.*Max-Age=0$/);
    assert.match(session, /^musicer_baidu=[\w-]{43}; Path=\/api\/baidu; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    return firstPart(session);
  }

  return { origin, redirectUri, calls, request, authorize, callback, login, restart };
}

function firstPart(cookie) {
  return cookie.split(';')[0];
}

function issueToken(name = 'owner') {
  return Response.json({ access_token: name + '-access', refresh_token: name + '-refresh', expires_in: 3600 });
}

function standardTokenRequest(url) {
  return url.pathname.endsWith('/token') && url.searchParams.get('grant_type') === 'authorization_code';
}

test('reports missing configuration without contacting Baidu', async (t) => {
  const fixtureData = await fixture(t, () => assert.fail('Unexpected upstream request'), { configured: false });
  const status = await fixtureData.request('/status');
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await status.json(), { configured: false, connected: false });
  assert.equal((await fixtureData.request('/connect')).status, 503);
  assert.equal((await fixtureData.request('/list')).status, 503);
  assert.equal(fixtureData.calls.length, 0);
});

test('reports only usable Baidu authorization options for local and forwarded requests', async (t) => {
  const callbackAddress = 'https://music.example.test:443/api/baidu/callback';
  const f = await fixture(t, () => assert.fail('Unexpected upstream request'), { callbackAddress });
  assert.deepEqual(await (await f.request('/status')).json(), {
    ...anonymous, codeAvailable: true, deviceAvailable: true, redirectUri: callbackAddress,
  });
  const headers = { 'X-Forwarded-For': '203.0.113.10' };
  assert.deepEqual(await (await f.request('/status', { headers })).json(), {
    ...anonymous, redirectUri: callbackAddress,
  });
  const unavailable = await f.request('/code/start', { method: 'POST', headers: { ...headers, Origin: f.origin } });
  assert.equal(unavailable.status, 403);
  assert.equal((await f.request('/disconnect', {
    method: 'POST', headers: { ...headers, Origin: f.origin },
  })).status, 403);
  const disconnected = await f.request('/disconnect', { method: 'POST', headers: { Origin: f.origin } });
  assert.equal(disconnected.status, 200);
  assert.deepEqual(await disconnected.json(), anonymous);
  for (const removed of disconnected.headers.getSetCookie()) assert.doesNotMatch(removed, /; Secure/);

  const unsafe = await fixture(t, () => assert.fail('Unexpected upstream request'), {
    callbackAddress: 'https://music.example.test/api/baidu/callback?credential=do-not-report',
  });
  assert.deepEqual(await (await unsafe.request('/status')).json(), { configured: false, connected: false });
});

test('preserves the safe redirect mismatch diagnostic and consumes the attempt without copying provider text', async t => {
  const f = await fixture(t, () => Response.json({ error: 'redirect_uri_mismatch', error_description: 'provider-only-detail' }, { status: 400 }));
  const denied = await f.authorize();
  const mismatch = await f.callback(denied, { error: 'redirect_uri_mismatch', error_description: 'provider-only-detail', code: 'ignore' });
  assert.equal(mismatch.headers.get('location'), '/?baidu=redirect-mismatch');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.callback(denied, { code: 'retry' })).status, 400);

  const exchanged = await f.authorize();
  const rejected = await f.callback(exchanged, { code: 'credential-not-for-redirect' });
  assert.equal(f.calls.length, 1);
  assert.equal(rejected.headers.get('location'), '/?baidu=redirect-mismatch');
  assert.equal(rejected.headers.getSetCookie().length, 1);
});

test('requires matching OAuth state and browser cookie, handles denial, and consumes callbacks once', async (t) => {
  const f = await fixture(t, () => issueToken());
  assert.deepEqual(await (await f.request('/status')).json(), { ...anonymous, codeAvailable: true, deviceAvailable: true });
  assert.equal((await f.request('/list')).status, 401);

  const auth = await f.authorize();
  const secondAuth = await f.authorize();
  assert.equal((await f.callback(auth, { code: 'auth-code' }, '')).status, 400);
  assert.equal((await f.callback(auth, { code: 'auth-code' }, secondAuth.cookie)).status, 400);
  assert.equal((await f.callback(auth, { code: 'auth-code', state: 'bad-state' })).status, 400);
  assert.equal(f.calls.length, 0);

  const denied = await f.callback(secondAuth, { error: 'access_denied' });
  assert.equal(denied.headers.get('location'), '/?baidu=denied');
  assert.equal(f.calls.length, 0);

  const complete = await f.callback(auth, { code: 'auth-code' });
  assert.equal(complete.headers.get('location'), '/?baidu=connected');
  const session = firstPart(complete.headers.getSetCookie()[1]);
  assert.equal((await f.callback(auth, { code: 'auth-code' })).status, 400);
  assert.equal(f.calls.length, 1);
  const [{ url }] = f.calls;
  assert.equal(url.pathname, '/oauth/2.0/token');
  assert.equal(url.searchParams.get('client_id'), 'test-key');
  assert.equal(url.searchParams.get('client_secret'), 'test-secret');
  assert.equal(url.searchParams.get('code'), 'auth-code');
  assert.equal(url.searchParams.get('redirect_uri'), f.redirectUri);
  assert.deepEqual(await (await f.request('/status', { headers: { Cookie: session } })).json(), { ...connected, codeAvailable: true, deviceAvailable: true });

  const forbidden = await f.request('/disconnect', {
    method: 'POST',
    headers: { Cookie: session, Origin: 'https://untrusted.example' },
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await (await f.request('/status', { headers: { Cookie: session } })).json(), { ...connected, codeAvailable: true, deviceAvailable: true });

  const disconnected = await f.request('/disconnect', {
    method: 'POST',
    headers: { Cookie: session, Origin: f.origin },
  });
  assert.deepEqual(await disconnected.json(), anonymous);
  assert.equal((await f.request('/list', { headers: { Cookie: session } })).status, 401);
});

test('lists all pages and preserves Chinese paths and 64-bit IDs', async (t) => {
  const folder = '/云端唱片室/我的 收藏';
  const f = await fixture(t, (url) => {
    if (standardTokenRequest(url)) return issueToken();
    if (url.searchParams.get('start') === '0') {
      return Response.json({ errno: 0, list: Array.from({ length: 1000 }, (_, index) => ({
        fs_id: index + 1,
        path: folder + '/分组 ' + index,
        isdir: 1,
      })) });
    }
    // Use a raw JSON number because Baidu can return an ID larger than Number.MAX_SAFE_INTEGER.
    return new Response(`{"errno":0,"list":[{"fs_id":${mediaId},"path":"/云端唱片室/我的 收藏/晚风.flac","server_filename":"晚风.flac","size":512},{"fs_id":1001,"path":"/云端唱片室/我的 收藏/封面.png","size":32}]}`);
  });
  const session = await f.login('owner');
  const response = await f.request('/list?' + new URLSearchParams({ path: folder }), { headers: { Cookie: session } });
  assert.equal(response.status, 200);
  const { items } = await response.json();
  assert.equal(items.length, 1002);
  assert.deepEqual(items[0], {
    id: '1', name: '分组 0', path: folder + '/分组 0', folder: true, size: 0, streamUrl: null,
  });
  assert.deepEqual(items[1000], {
    id: mediaId, name: '晚风.flac', path: folder + '/晚风.flac', folder: false, size: 512,
    streamUrl: prefix + '/stream?id=' + mediaId,
  });
  assert.equal(items[1001].streamUrl, null);

  const pages = f.calls.slice(1);
  assert.deepEqual(pages.map(({ url }) => url.searchParams.get('start')), ['0', '1000']);
  for (const { url } of pages) {
    assert.equal(url.pathname, '/rest/2.0/xpan/file');
    assert.equal(url.searchParams.get('dir'), folder);
    assert.equal(url.searchParams.get('limit'), '1000');
    assert.equal(url.searchParams.get('access_token'), 'owner-access');
  }
});

test('shares a versioned Baidu folder cover across pages and binds it to the authorized browser', async t => {
  const root = await mkdtemp(join(tmpdir(), 'groovebox-baidu-cover-'));
  const sessionFile = join(root, 'sessions.enc');
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = '/云端 唱片';
  const png = { fs_id: mediaId, path: folder + '/CoVeR.PNG', server_mtime: 10, size: 32 };
  const jpg = { fs_id: 2, path: folder + '/cover.JPG', server_mtime: 11, size: 16 };
  const audio = { fs_id: 3, path: folder + '/晚风.flac' };
  const second = { fs_id: 4, path: folder + '/雨夜.flac' };
  const differentFolder = { fs_id: 5, path: folder + '/子目录/其他.flac' };
  const lyric = { fs_id: 6, path: folder + '/晚风.lrc' };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const requests = [];
  const raw = list => new Response(JSON.stringify({ errno: 0, list }).replace('"fs_id":"' + mediaId + '"', '"fs_id":' + mediaId));
  let rejected = false;
  const f = await fixture(t, (url, options) => {
    if (standardTokenRequest(url)) return issueToken(url.searchParams.get('code'));
    if (url.searchParams.get('grant_type') === 'refresh_token') return issueToken('refreshed');
    const method = url.searchParams.get('method');
    if (method === 'list') {
      if (url.searchParams.get('dir') !== folder) return raw([differentFolder]);
      return raw(url.searchParams.get('start') === '0' ? [jpg, audio, lyric,
        ...Array.from({ length: 997 }, (_, index) => ({ fs_id: 2000 + index, isdir: 1, path: folder + '/目录' + index }))]
        : [png, second, differentFolder, { fs_id: 7, path: '/Other/cover.jpeg' }, { fs_id: 8, path: folder + '/cover.svg' }]);
    }
    if (method === 'filemetas') {
      assert.equal(url.searchParams.get('fsids'), '[' + mediaId + ',2]');
      assert.equal(url.searchParams.get('dlink'), '1');
      if (rejected && url.searchParams.get('access_token') === 'owner-access') return Response.json({ errno: 110 });
      // Metadata may not be sorted in the same order as the requested IDs.
      return raw([{ ...jpg, dlink: 'https://d.pcs.baidu.com/fallback' }, { ...png, dlink: 'https://d.pcs.baidu.com/primary' }]);
    }
    requests.push(url.pathname);
    assert.equal(url.searchParams.get('access_token'), rejected ? 'refreshed-access' : 'owner-access');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Range, undefined);
    assert.equal(options.headers['User-Agent'], 'pan.baidu.com');
    return url.pathname === '/primary' ? new Response('<svg/>', { headers: { 'Content-Type': 'image/png' } })
      : new Response(jpeg, { headers: { 'Content-Type': 'application/octet-stream' } });
  }, { sessionFile });
  const owner = await f.login('owner');
  const shared = await f.login('other');
  const items = async (path = folder, cookie = owner) => (await (await f.request('/list?' + new URLSearchParams({ path }),
    { headers: { Cookie: cookie } })).json()).items;
  const page = await items();
  const first = page.find(item => item.id === '3');
  assert.equal(first.folderCover, page.find(item => item.id === '4').folderCover);
  assert.match(first.folderCover, /^\/api\/baidu\/cover\?ids=9223372036854775807%2C2&folder=[\w-]{22}&v=[\w-]{22}&proof=[\w-]{43}$/);
  assert.equal(page.find(item => item.id === '5').folderCover, undefined);
  assert.equal(page.find(item => item.id === '6').folderCover, undefined);
  assert.equal(page.find(item => item.id === mediaId).streamUrl, null);
  assert.equal((await items(folder + '/子目录'))[0].folderCover, undefined);
  const oldUrl = first.folderCover.slice(prefix.length);
  const beforeCover = f.calls.length;
  assert.equal(f.calls.filter(({ url }) => url.searchParams.get('method') === 'filemetas').length, 0);
  assert.equal((await f.request(oldUrl)).status, 401);
  assert.equal((await f.request(oldUrl, { headers: { Cookie: shared } })).status, 404);
  assert.equal((await f.request(oldUrl, { headers: { Cookie: owner, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.request(oldUrl.replace('%2C2', '%2C8'), { headers: { Cookie: owner } })).status, 404);
  assert.equal((await f.request(oldUrl + '&v=duplicate', { headers: { Cookie: owner } })).status, 404);
  assert.equal(f.calls.length, beforeCover);

  f.restart();
  rejected = true;
  const headers = { Cookie: owner, Range: 'bytes=0-1' };
  const cover = await f.request(oldUrl, { headers });
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/jpeg');
  assert.equal(cover.headers.get('cache-control'), 'private, no-store');
  assert.equal(cover.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(cover.headers.get('x-content-type-options'), 'nosniff');
  assert.match(cover.headers.get('content-security-policy'), /sandbox/);
  assert.equal(cover.headers.get('location'), null);
  assert.deepEqual(Buffer.from(await cover.arrayBuffer()), jpeg);
  const head = await f.request(oldUrl, { method: 'HEAD', headers });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(jpeg.length));
  assert.equal(await head.text(), '');
  assert.deepEqual(requests, ['/primary', '/fallback', '/primary', '/fallback']);

  png.server_mtime++;
  const revised = (await items()).find(item => item.id === '3').folderCover;
  assert.notEqual(revised, first.folderCover);
});

test('rejects replaced or unsafe Baidu cover content before returning local image bytes', async t => {
  const file = { fs_id: 1, path: '/Album/cover.jpg', filename: 'cover.jpg', size: 4 };
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const limit = 8 * 1024 * 1024;
  let metadata = file;
  let downloads = 0;
  let cancelled = false;
  let response;
  const f = await fixture(t, url => {
    if (standardTokenRequest(url)) return issueToken();
    if (url.searchParams.get('method') === 'list') {
      return Response.json({ list: [file, { fs_id: 3, path: '/Album/Song.m4a' }] });
    }
    if (url.searchParams.get('method') === 'filemetas') {
      return Response.json({ list: [{ ...metadata, dlink: 'https://d.pcs.baidu.com/cover' }] });
    }
    assert.equal(url.hostname, 'd.pcs.baidu.com');
    downloads++;
    return response();
  });
  const headers = { Cookie: await f.login('owner') };
  const listing = await f.request('/list?path=/Album', { headers });
  const localUrl = (await listing.json()).items[1].folderCover.slice(prefix.length);
  assert.equal((await f.request('/stream?id=1', { headers })).status, 415);
  for (const invalid of [
    { fs_id: 2 }, { path: '/Other/cover.jpg' }, { path: '/Album/cover.jpg/' }, { filename: 'other.jpg' },
    { isdir: 1 }, { size: limit + 1 },
  ]) {
    metadata = { ...file, ...invalid };
    assert.equal((await f.request(localUrl, { headers })).status, 404);
  }
  assert.equal(downloads, 0);

  metadata = file;
  for (const invalid of [
    () => Response.redirect('https://untrusted.example/image.jpg'),
    () => new Response(bytes, { headers: { 'Content-Type': 'image/svg+xml' } }),
    () => new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Content-Encoding': 'gzip' } }),
    () => new Response('<html>', { headers: { 'Content-Type': 'image/jpeg' } }),
    () => new Response(bytes, { headers: { 'Content-Length': String(limit + 1) } }),
    () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc(5 * 1024 * 1024));
        controller.enqueue(Buffer.alloc(4 * 1024 * 1024));
      },
      cancel() { cancelled = true; },
    })),
  ]) {
    response = invalid;
    assert.equal((await f.request(localUrl, { headers })).status, 404);
  }
  assert.equal(downloads, 6);
  assert.equal(cancelled, true);
  assert.equal(f.calls.some(({ url }) => url.hostname === 'untrusted.example'), false);
});

test('lists DSF and DFF, preserves their original bytes and exposes their embedded tags through authorized ranges', async (t) => {
  const files = ['dsf', 'dff'].map((format, index) => {
    const bytes = dsdFixture(format, { seconds: 0.3 });
    const name = '录音.' + format.toUpperCase();
    const item = { fs_id: index + 1, server_filename: name, path: '/' + name, size: bytes.length };
    return { format, name, item, bytes };
  });
  const f = await fixture(t, (url, options) => {
    if (standardTokenRequest(url)) return issueToken();
    const method = url.searchParams.get('method');
    if (method === 'list') return Response.json({ errno: 0, list: files.map(file => file.item) });
    if (method === 'filemetas') {
      const [id] = JSON.parse(url.searchParams.get('fsids'));
      return Response.json({ errno: 0, list: [{ ...files[id - 1].item, dlink: 'https://d.pcs.baidu.com/audio/' + id }] });
    }
    assert.equal(url.hostname, 'd.pcs.baidu.com');
    assert.equal(url.searchParams.get('access_token'), 'owner-access');
    const file = files[Number(url.pathname.split('/').at(-1)) - 1];
    const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range ? Math.min(Number(range[2]), file.bytes.length - 1) : file.bytes.length - 1;
    return new Response(options.method === 'HEAD' ? null : file.bytes.subarray(start, end + 1), {
      status: range ? 206 : 200,
      headers: {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
        ...(range && { 'Content-Range': 'bytes ' + start + '-' + end + '/' + file.bytes.length }),
      },
    });
  });
  const cookie = await f.login('owner');
  const listing = await f.request('/list', { headers: { Cookie: cookie } });
  assert.equal(listing.status, 200);
  const { items } = await listing.json();
  assert.equal(items.length, files.length);
  for (const [index, file] of files.entries()) {
    const { name, streamUrl } = items[index];
    assert.equal(name, file.name);
    assert.equal(streamUrl, prefix + '/stream?id=' + file.item.fs_id);
    const original = await fetch(f.origin + streamUrl, { headers: { Cookie: cookie } });
    assert.equal(original.status, 200);
    assert.equal(original.headers.get('content-type'), 'audio/x-' + file.format);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), file.bytes);

    const tagged = await inspectRemoteTrack(streamUrl, {
      name, fetchImpl: (path, options) => fetch(f.origin + path, {
        ...options, headers: { ...options.headers, Cookie: cookie },
      }),
    });
    assert.equal(tagged.title, file.format.toUpperCase() + ' Studio Test');
    assert.equal(tagged.artist, 'Synthetic Artist');
    assert.equal(tagged.album, 'Quality Test');
    assert.ok(tagged.duration >= 0.3 && tagged.duration < 0.4);
  }
  assert.ok(f.calls.some(({ options }) => options.headers?.Range?.startsWith('bytes=65536-')));
});

test('streams range requests and HEAD through Baidu CDN without exposing its download URL', async (t) => {
  const f = await fixture(t, (url, options) => {
    if (standardTokenRequest(url)) return issueToken();
    if (url.searchParams.get('method') === 'filemetas') {
      return Response.json({ errno: 0, list: [{
        filename: '晚风.flac',
        dlink: 'https://d.pcs.baidu.com/file?sign=opaque%20a%2B&download=1',
      }] });
    }
    if (url.hostname === 'd.pcs.baidu.com') {
      return Response.redirect('https://download.baidupcs.com/music', 302);
    }
    return new Response(options.method === 'HEAD' ? null : new Uint8Array([2, 3, 4, 5]), {
      status: 206,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': 'bytes 2-5/32',
        'Content-Length': '4',
        'Accept-Ranges': 'bytes',
      },
    });
  });
  const session = await f.login('owner');
  const path = '/stream?id=' + mediaId;
  const headers = { Cookie: session, Range: 'bytes=2-5' };
  const response = await f.request(path, { headers });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'audio/flac');
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/32');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [2, 3, 4, 5]);
  const head = await f.request(path, { method: 'HEAD', headers });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '4');
  assert.equal(await head.text(), '');

  const requests = f.calls.slice(1);
  assert.equal(requests.length, 6);
  for (const [offset, method] of [[0, 'GET'], [3, 'HEAD']]) {
    const [metadata, download, cdn] = requests.slice(offset, offset + 3);
    assert.equal(metadata.url.searchParams.get('fsids'), '[' + mediaId + ']');
    assert.equal(download.url.search, '?sign=opaque%20a%2B&download=1&access_token=owner-access');
    assert.equal(cdn.url.hostname, 'download.baidupcs.com');
    for (const request of [download, cdn]) {
      assert.equal(request.options.headers.Range, 'bytes=2-5');
      assert.equal(request.options.headers['User-Agent'], 'pan.baidu.com');
      assert.equal(request.options.method, method);
    }
  }
  const invalid = await f.request(path, { headers: { ...headers, Range: 'bytes=2-5,10-12' } });
  assert.equal(invalid.status, 416);
  assert.equal(f.calls.length, 7);
});

test('lists authenticated lyrics sidecars and normalizes their encodings as safe UTF-8 text', async (t) => {
  const files = [
    { fs_id: 1, path: '/专辑/晚风.LRC', filename: '晚风.LRC' },
    { fs_id: 2, path: '/专辑/锦夜.vtt', filename: '锦夜.vtt' },
    { fs_id: 3, path: '/专辑/晨光.lrc', filename: '晨光.lrc' },
  ];
  const utf16vtt = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('WEBVTT\r\n\r\n00:00.000 --> 00:02.000\r\n晚风', 'utf16le')]);
  const gbLrc = Buffer.concat([Buffer.from('[00:01.00]'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]);
  const f = await fixture(t, (url, options) => {
    if (standardTokenRequest(url)) return issueToken();
    if (url.searchParams.get('method') === 'list') return Response.json({ errno: 0, list: files });
    if (url.searchParams.get('method') === 'filemetas') {
      const [id] = JSON.parse(url.searchParams.get('fsids'));
      return Response.json({ errno: 0, list: [{ ...files[id - 1], dlink: 'https://d.pcs.baidu.com/lyrics/' + id }] });
    }
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Range, undefined);
    const id = Number(url.pathname.split('/').at(-1));
    return new Response(['[00:01.00]<b>晚风</b>\r\n', utf16vtt, gbLrc][id - 1], {
      headers: { 'Content-Type': id === 2 ? 'text/vtt' : 'application/octet-stream' },
    });
  });
  assert.equal((await f.request('/stream?id=1')).status, 401);
  assert.equal(f.calls.length, 0);
  const session = await f.login('owner');
  const headers = { Cookie: session };
  const { items } = await (await f.request('/list?path=/专辑', { headers })).json();
  const expected = ['[00:01.00]<b>晚风</b>\n', 'WEBVTT\n\n00:00.000 --> 00:02.000\n晚风', '[00:01.00]中文'];
  for (const [index, item] of items.entries()) {
    assert.equal(item.streamUrl, prefix + '/stream?id=' + (index + 1));
    const response = await f.request(item.streamUrl.slice(prefix.length), {
      headers: { ...headers, Range: 'bytes=0-2' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-range'), null);
    assert.equal(await response.text(), expected[index]);
  }
  const head = await f.request('/stream?id=1', { method: 'HEAD', headers });
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(expected[0])));
  assert.equal(await head.text(), '');
});

test('rejects oversized lyrics from metadata, headers, and bounded streaming reads', async (t) => {
  let cancelled = false;
  let chunks = 0;
  const f = await fixture(t, (url) => {
    if (standardTokenRequest(url)) return issueToken();
    if (url.searchParams.get('method') === 'filemetas') {
      const [id] = JSON.parse(url.searchParams.get('fsids'));
      return Response.json({ errno: 0, list: [{
        filename: '晚风.lrc', size: id === 1 ? 1_000_001 : undefined,
        dlink: 'https://d.pcs.baidu.com/lyrics/' + id,
      }] });
    }
    if (url.pathname.endsWith('/2')) {
      return new Response('oversized', { headers: { 'Content-Length': '1000001' } });
    }
    return new Response(new ReadableStream({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        cancelled = true;
      },
    }));
  });
  const session = await f.login('owner');
  for (const id of [1, 2, 3]) {
    const response = await f.request('/stream?id=' + id, { headers: { Cookie: session } });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /1 MB/);
  }
  assert.equal(f.calls.filter(({ url }) => url.hostname === 'd.pcs.baidu.com').length, 2);
  assert.equal(cancelled, true);
  assert.ok(chunks <= 3);
});

test('two isolated sessions do not share tokens, and concurrent expiry triggers one refresh', async (t) => {
  let signalOldRequests;
  let oldRequests = 0;
  const oldRequestsReady = new Promise((resolve) => { signalOldRequests = resolve; });
  const f = await fixture(t, async (url) => {
    const query = url.searchParams;
    if (standardTokenRequest(url)) return issueToken(query.get('code'));
    if (query.get('grant_type') === 'refresh_token') {
      return Response.json({ access_token: 'refreshed-access', expires_in: 3600 });
    }
    if (query.get('access_token') === 'first-access') {
      oldRequests += 1;
      if (oldRequests === 2) signalOldRequests();
      const ready = await Promise.race([oldRequestsReady.then(() => true), setTimeout(2000, false, { ref: false })]);
      assert.equal(ready, true, 'Both concurrent requests must reach the upstream with the expired token');
      return Response.json({ errno: 111 });
    }
    return Response.json({ errno: 0, list: [{ fs_id: 1, path: '/' + query.get('access_token'), isdir: 1 }] });
  });
  const first = await f.login('first');
  const second = await f.login('second');
  assert.notEqual(first, second);

  async function list(cookie) {
    const response = await f.request('/list', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return (await response.json()).items[0].name;
  }
  assert.deepEqual(await Promise.all([list(first), list(first), list(second)]), [
    'refreshed-access', 'refreshed-access', 'second-access',
  ]);
  const refresh = f.calls.filter(({ url }) => url.searchParams.get('grant_type') === 'refresh_token');
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0].url.searchParams.get('refresh_token'), 'first-refresh');
});

test('rejects non-Baidu download redirects and does not contact their destination', async (t) => {
  const f = await fixture(t, (url) => {
    if (standardTokenRequest(url)) return issueToken();
    if (url.searchParams.get('method') === 'filemetas') {
      return Response.json({ errno: 0, list: [{ filename: '晚风.flac', dlink: 'https://d.pcs.baidu.com/file' }] });
    }
    return Response.redirect('http://127.0.0.1:12345/private', 302);
  });
  const session = await f.login('owner');
  const response = await f.request('/stream?id=' + mediaId, { headers: { Cookie: session } });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /下载地址/);
  assert.deepEqual(f.calls.map(({ url }) => url.hostname), ['openapi.baidu.com', 'pan.baidu.com', 'd.pcs.baidu.com']);
});

test('restores encrypted Baidu sessions across restart and persists logout', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-baidu-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'auth.enc');
  const f = await fixture(t, () => issueToken('private-session'), { sessionFile });
  const cookie = await f.login('login-for-restart');
  const headers = { Cookie: cookie };
  const encrypted = await readFile(sessionFile);
  assert.equal(encrypted.includes(Buffer.from('private-session-access')), false);
  assert.equal(encrypted.includes(Buffer.from(cookie.slice(cookie.indexOf('=') + 1))), false);
  if (process.platform !== 'win32') assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
  f.restart('different-app-secret');
  assert.deepEqual(await (await f.request('/status', { headers })).json(), { ...anonymous, codeAvailable: true, deviceAvailable: true });
  f.restart();
  assert.deepEqual(await (await f.request('/status', { headers })).json(), { ...connected, codeAvailable: true, deviceAvailable: true });
  const disconnected = await f.request('/disconnect', { method: 'POST', headers: { ...headers, Origin: f.origin } });
  assert.deepEqual(await disconnected.json(), anonymous);
  f.restart();
  assert.deepEqual(await (await f.request('/status', { headers })).json(), { ...anonymous, codeAvailable: true, deviceAvailable: true });
});

test('completes Baidu manual-code OAuth on the same loopback origin and restores its encrypted session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-baidu-manual-code-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const exchangeCode = 'manual-example-code';
  const f = await fixture(t, url => {
    assert.ok(standardTokenRequest(url));
    assert.equal(url.searchParams.get('redirect_uri'), 'oob');
    assert.equal(url.searchParams.get('code'), exchangeCode);
    return issueToken('manual-login');
  }, { sessionFile: join(dir, 'auth.enc') });

  const crossOrigin = await f.request('/code/start', { method: 'POST', headers: { Origin: 'https://untrusted.invalid' } });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await f.request('/code/start', { method: 'POST' })).status, 403);
  const start = await f.request('/code/start', { method: 'POST', headers: { Origin: f.origin } });
  assert.equal(start.status, 200);
  const { authorizeUrl, state } = await start.json();
  assert.match(state, /^[\w-]{43}$/);
  const authorize = new URL(authorizeUrl);
  assert.equal(authorize.origin + authorize.pathname, 'https://openapi.baidu.com/oauth/2.0/authorize');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'oob');
  assert.equal(authorize.searchParams.get('scope'), 'basic,netdisk');
  assert.equal(authorize.searchParams.get('state'), state);
  assert.equal(authorize.searchParams.has('client_secret'), false);
  const [pending] = start.headers.getSetCookie();
  assert.match(pending, /^musicer_baidu_oauth=[\w-]{43}; Path=\/api\/baidu; HttpOnly; SameSite=Lax; Max-Age=600$/);
  const Cookie = firstPart(pending);

  const complete = (body, headers = {}) => f.request('/code/complete', {
    method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json', Cookie, ...headers },
    body: JSON.stringify(body),
  });
  const input = { state, code: '  ' + exchangeCode + '\n' };
  assert.equal((await complete(input, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await complete(input, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await complete(input, { Cookie: '' })).status, 400);
  assert.equal((await complete({ ...input, state: 'wrong' })).status, 400);
  assert.equal((await complete({ ...input, code: 'a'.repeat(9000) })).status, 413);
  assert.equal((await complete({ ...input, code: 'embedded spaces' })).status, 400);
  assert.equal((await f.callback({ state, cookie: Cookie }, { code: exchangeCode })).status, 400);
  const normal = await f.authorize();
  assert.equal((await complete({ ...input, state: normal.state }, { Cookie: normal.cookie })).status, 400);
  assert.equal(f.calls.length, 0);

  const completed = await complete(input);
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), connected);
  const [cleared, session] = completed.headers.getSetCookie();
  assert.match(cleared, /^musicer_baidu_oauth=;.*Max-Age=0$/);
  assert.match(session, /^musicer_baidu=[\w-]{43}; Path=\/api\/baidu; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  assert.equal((await complete(input)).status, 400);
  assert.equal(f.calls.length, 1);
  f.restart();
  assert.deepEqual(await (await f.request('/status', { headers: { Cookie: firstPart(session) } })).json(), { ...connected, codeAvailable: true, deviceAvailable: true });
});

test('manual code exchange does not replay a failed Baidu grant or echo the pasted code', async t => {
  const pasted = 'example-invalid-sensitive-paste';
  const f = await fixture(t, () => Response.json({
    error: 'invalid_grant', error_description: 'Invalid authorization code: ' + pasted,
  }, { status: 400 }));
  const response = await f.request('/code/start', { method: 'POST', headers: { Origin: f.origin } });
  const { state } = await response.json();
  const submit = () => f.request('/code/complete', {
    method: 'POST',
    headers: { Origin: f.origin, 'Content-Type': 'application/json', Cookie: firstPart(response.headers.getSetCookie()[0]) },
    body: JSON.stringify({ state, code: pasted }),
  });
  const failed = await submit();
  assert.equal(failed.status, 401);
  const error = await failed.json();
  assert.equal(error.upstreamCode, 'invalid_grant');
  assert.match(error.error, /授权码/);
  assert.equal(JSON.stringify(error).includes(pasted), false);
  assert.match(failed.headers.getSetCookie()[0], /^musicer_baidu_oauth=;.*Max-Age=0$/);
  assert.equal((await submit()).status, 400);
  assert.equal(f.calls.length, 1);
});

test('binds a Baidu device grant to the same browser and creates an encrypted session once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-device-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'] });
  let tokenCalls = 0;
  const privateCode = 'server-only-test-device-code';
  const f = await fixture(t, url => {
    if (url.pathname.endsWith('/device/code')) {
      assert.equal(url.searchParams.get('scope'), 'basic,netdisk');
      assert.equal(url.searchParams.has('client_secret'), false);
      return Response.json({ device_code: privateCode, user_code: 'ABCD-3210',
        verification_url: 'https://openapi.baidu.com/device', expires_in: 300, interval: 5 });
    }
    assert.equal(url.searchParams.get('grant_type'), 'device_token');
    assert.equal(url.searchParams.get('code'), privateCode);
    tokenCalls++;
    return tokenCalls === 1 ? Response.json({ error: 'authorization_pending' }, { status: 400 }) : issueToken('device');
  }, { sessionFile: join(dir, 'sessions.enc') });

  assert.equal((await f.request('/device/start', { method: 'POST' })).status, 403);
  const start = await f.request('/device/start', { method: 'POST', headers: { Origin: f.origin } });
  const data = await start.json();
  assert.equal(start.status, 200);
  assert.match(data.state, /^[\w-]{43}$/);
  assert.deepEqual({ ...data, state: undefined }, { state: undefined, userCode: 'ABCD-3210',
    verificationUrl: 'https://openapi.baidu.com/device', expiresIn: 300, interval: 5 });
  const Cookie = firstPart(start.headers.getSetCookie()[0]);
  const poll = (state = data.state, extra = {}) => f.request('/device/poll', {
    method: 'POST', headers: { Origin: f.origin, Cookie, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ state }),
  });
  assert.equal((await poll('wrong')).status, 400);
  assert.equal((await poll(data.state, { Cookie: '' })).status, 400);
  assert.equal((await poll(data.state, { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await f.callback({ state: data.state, cookie: Cookie }, { code: 'wrong-mode' })).status, 400);
  assert.equal((await (await poll()).json()).status, 'pending');
  assert.equal(tokenCalls, 0);
  t.mock.timers.tick(5000);
  assert.equal((await (await poll()).json()).status, 'pending');
  t.mock.timers.tick(5000);
  const finished = await poll();
  const session = firstPart(finished.headers.getSetCookie()[1]);
  assert.deepEqual(await finished.json(), { status: 'authorized', ...connected });
  assert.equal((await poll()).status, 400);
  assert.equal(tokenCalls, 2);
  f.restart();
  assert.equal((await (await f.request('/status', { headers: { Cookie: session } })).json()).connected, true);
});

const backupRoot = '/apps/测试 Groovebox';
const backupDir = backupRoot + '/groovebox-backups';
const operationId = 'c4381e8a-d90a-4ef6-b04b-b03673f6f679';
const backupName = 'groovebox-playlists-' + operationId + '.json';
const backupPath = backupDir + '/' + backupName;
const backupRoute = '/backup?id=' + operationId;
const songRow = { fs_id: mediaId, isdir: 0, size: 934, server_filename: '夜曲.m4a', path: '/音乐/夜曲.m4a' };

async function backupFixture(t, { backupFolder = backupRoot, exists = true, respond } = {}) {
  const folders = new Map([['owner', exists], ['other', true]]);
  const files = new Map([['owner', new Map()], ['other', new Map()]]);
  const stages = [];
  let counter = 0;
  const upstream = async (url, options) => {
    if (standardTokenRequest(url)) return issueToken(url.searchParams.get('code'));
    const token = url.searchParams.get('access_token');
    const owner = token === 'owner-access' || token === 'owner-reconnected-access';
    assert.ok(owner || token === 'other-access', token);
    const account = owner ? 'owner' : 'other';
    const snapshots = files.get(account);
    const method = url.searchParams.get('method');
    const reply = value => Response.json(value);
    if (url.hostname === 'd.pcs.baidu.com' && !method) {
      const file = [...snapshots.values()].find(item => url.pathname === '/download/' + item.row.fs_id);
      assert.ok(file);
      return new Response(file.bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    if (url.pathname.endsWith('/nas') && method === 'uinfo') {
      const overridden = await respond?.({ phase: 'uinfo', account });
      if (overridden) return overridden;
      // Adjacent, high signed IDs must remain distinct even though both round to the same JS Number.
      return new Response(owner ? '{"errno":0,"uk":9223372036854775806,"baidu_name":"Private Owner"}'
        : '{"errno":0,"uk":9223372036854775807,"baidu_name":"Private Other"}');
    }
    if (method === 'list') {
      const dir = url.searchParams.get('dir');
      const overridden = await respond?.({ phase: 'list', dir, account, snapshots });
      if (overridden) return overridden;
      if (dir === '/') return reply({ errno: 0, list: [songRow, { fs_id: '7', isdir: 1, path: '/音乐' }] });
      if (dir === backupRoot) return reply({ errno: 0, list: [] });
      assert.equal(dir, backupDir);
      if (!folders.get(account)) return reply({ errno: -9 });
      return reply({ errno: 0, list: [...snapshots.values()].map(item => item.row).slice(0, Number(url.searchParams.get('limit'))) });
    }
    if (method === 'filemetas') {
      const ids = url.searchParams.get('fsids').slice(1, -1).split(',');
      assert.equal(ids.every(id => /^[0-9]+$/.test(id)), true);
      const download = url.searchParams.get('dlink') === '1';
      const overridden = await respond?.({ phase: 'filemetas', ids, account, snapshots, download });
      if (overridden) return overridden;
      if (!download) return reply({ errno: 0, list: owner && ids.includes(mediaId) ? [songRow] : [] });
      const list = [...snapshots.values()].map(item => item.row).filter(item => ids.includes(item.fs_id));
      return reply({ errno: 0, list: list.map(row => ({ ...row, dlink: 'https://d.pcs.baidu.com/download/' + row.fs_id })) });
    }

    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const body = await new Request(url, options).formData();
    if (method === 'upload') {
      assert.equal(url.hostname + url.pathname, 'd.pcs.baidu.com/rest/2.0/pcs/superfile2');
      assert.equal(url.searchParams.get('path'), backupPath);
      assert.equal(url.searchParams.get('type'), 'tmpfile');
      assert.equal(url.searchParams.get('partseq'), '0');
      assert.equal(url.searchParams.get('uploadid'), 'fake+/part==');
      assert.deepEqual([...body.keys()], ['file']);
      const part = body.get('file');
      assert.equal(part.name, 'file');
      assert.equal(part.type, 'application/octet-stream');
      stages.push('upload');
      const bytes = Buffer.from(await part.arrayBuffer());
      const response = await respond?.({ phase: 'upload', account, snapshots, bytes });
      if (response) return response;
      pending.set(account, bytes);
      return reply({ md5: createHash('md5').update(bytes).digest('hex') });
    }

    assert.equal(url.hostname + url.pathname, 'pan.baidu.com/rest/2.0/xpan/file');
    assert.equal(body.get('rtype'), '0');
    if (method === 'create' && body.get('isdir') === '1') {
      stages.push('mkdir');
      assert.deepEqual(Object.fromEntries(body), { path: backupDir, size: '0', isdir: '1', rtype: '0' });
      const response = await respond?.({ phase: 'mkdir', account, snapshots, folders });
      if (response) return response;
      if (folders.get(account)) return reply({ errno: -8 });
      folders.set(account, true);
      return reply({ errno: 0, path: backupDir, isdir: 1 });
    }
    assert.equal(body.get('path'), backupPath);
    assert.equal(body.get('isdir'), '0');
    assert.ok(folders.get(account));
    stages.push(method);
    const override = await respond?.({ phase: method, account, snapshots });
    if (override) return override;
    if (snapshots.has(backupPath)) return reply({ errno: -8 });
    if (method === 'precreate') {
      assert.equal(body.get('autoinit'), '1');
      return reply({ errno: 0, return_type: 1, uploadid: 'fake+/part==', block_list: [0] });
    }
    assert.equal(method, 'create');
    assert.equal(body.get('uploadid'), 'fake+/part==');
    const bytes = pending.get(account);
    const md5 = createHash('md5').update(bytes).digest('hex');
    assert.equal(body.get('size'), String(bytes.byteLength));
    assert.deepEqual(JSON.parse(body.get('block_list')), [md5]);
    const row = { path: backupPath, fs_id: String(++counter + 512), isdir: 0, size: bytes.length,
      server_filename: backupName, server_mtime: 1_760_000_000 };
    snapshots.set(backupPath, { row, bytes });
    const afterCommit = await respond?.({ phase: 'committed', account, snapshots });
    if (afterCommit) return afterCommit;
    return reply({ errno: 0, ...row, md5 });
  };
  const pending = new Map();
  const f = await fixture(t, upstream, { backupFolder });
  const status = Cookie => f.request('/status', { headers: { Cookie } });
  const get = (Cookie, route = '/backup', headers = {}) => f.request(route, { headers: { Cookie, ...headers } });
  const put = (Cookie, bytes, headers = {}, route = backupRoute) => f.request(route, {
    method: 'PUT', body: bytes, headers: { Cookie, Origin: f.origin, 'Content-Type': 'application/json', ...headers },
  });
  return { ...f, get, put, status, stages, files };
}

function snapshotBytes(account, { withFile = false, name = '待备份歌单' } = {}) {
  const tracks = [{ id: 'one', title: '夜曲' }];
  return createPlaylistSnapshot({ tracks, playlists: [{ name, tracks: ['one'] }], favorites: ['one'] }, {
    operation: operationId, scope: { provider: 'baidu', account },
    verifiedFiles: withFile ? new Map([['one', mediaId]]) : new Map(),
  });
}

test('scopes backup, lossless provenance and verified write to the current Baidu account', async t => {
  const f = await backupFixture(t);
  assert.equal((await f.request('/backup')).status, 401);
  const owner = await f.login('owner');
  const other = await f.login('other');
  const same = await f.login('owner-reconnected');
  assert.equal((await (await f.status(owner)).json()).canBackup, true);
  const { account, snapshots } = await (await f.get(owner)).json();
  const foreign = (await (await f.get(other)).json()).account;
  assert.match(account, /^[\w-]{43}$/);
  assert.notEqual(foreign, account);
  assert.equal((await (await f.get(same)).json()).account, account);
  assert.deepEqual(snapshots, []);
  const { items } = await (await f.get(owner, '/list')).json();
  assert.equal(items.find(item => item.id === mediaId).backupAccount, account);
  assert.equal(items.find(item => item.folder).backupAccount, undefined);
  assert.equal((await (await f.get(other, '/list')).json()).items[0].backupAccount, foreign);

  const bytes = snapshotBytes(account, { withFile: true });
  assert.equal((await f.put(other, bytes)).status, 400);
  assert.equal((await f.put(owner, bytes, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await f.get(owner, '/backup', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.put(owner, bytes, { Origin: '' })).status, 403);
  assert.equal((await f.put(owner, bytes, {}, backupRoute + '&dir=/elsewhere')).status, 400);
  assert.equal((await f.get(owner, '/backup?id=../bad')).status, 400);
  assert.equal((await f.put(owner, bytes, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.put(owner, Buffer.alloc(1_000_001))).status, 413);
  assert.deepEqual(f.stages, []);
  assert.deepEqual(await (await f.put(owner, bytes)).json(), { status: 'saved', id: operationId });
  assert.deepEqual(f.stages, ['precreate', 'upload', 'create']);
  const listing = await (await f.get(same)).json();
  assert.deepEqual(listing, { account, snapshots: [{ id: operationId, name: backupName, size: bytes.byteLength,
    modifiedAt: 1_760_000_000_000 }] });
  const response = await f.get(same, backupRoute);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal((await f.get(other, backupRoute)).status, 404);
  assert.deepEqual(await (await f.put(owner, bytes)).json(), { status: 'already_present', id: operationId });
  const conflict = await f.put(owner, snapshotBytes(account, { name: '另一个歌单' }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'snapshot_conflict');
  assert.deepEqual(f.stages, ['precreate', 'upload', 'create']);
});

test('creates only the fixed missing child directory after an explicit valid PUT', async t => {
  const f = await backupFixture(t, { exists: false,
    respond({ phase, folders, account }) {
      if (phase === 'mkdir') {
        folders.set(account, true); // Another writer had just created the exact directory.
        return Response.json({ errno: -8 });
      }
    },
  });
  const cookie = await f.login('owner');
  const { account, snapshots } = await (await f.get(cookie)).json();
  assert.deepEqual(snapshots, []);
  assert.equal((await f.get(cookie, backupRoute)).status, 404);
  assert.deepEqual(f.stages, []);
  assert.deepEqual(await (await f.put(cookie, snapshotBytes(account))).json(), { status: 'saved', id: operationId });
  assert.deepEqual(f.stages, ['mkdir', 'precreate', 'upload', 'create']);
});

test('keeps disabled, inaccessible or unapproved scopes from reaching any upload phase', async t => {
  const disabled = await backupFixture(t, { backupFolder: '/apps/a/../b' });
  const cookie = await disabled.login('owner');
  assert.notEqual((await (await disabled.status(cookie)).json()).canBackup, true);
  assert.equal((await disabled.get(cookie)).status, 403);
  assert.equal(disabled.calls.length, 1); // OAuth only.

  const missing = await backupFixture(t, { exists: false,
    respond: ({ phase, dir }) => phase === 'list' && dir === backupRoot ? Response.json({ errno: -9 }) : undefined,
  });
  const owner = await missing.login('owner');
  const { account } = await (await missing.get(owner)).json();
  const unavailable = await missing.put(owner, snapshotBytes(account));
  assert.equal(unavailable.status, 404);
  assert.equal((await unavailable.json()).code, 'approved_app_directory_missing');
  assert.deepEqual(missing.stages, []);

  const denied = await backupFixture(t, {
    respond: ({ phase, dir }) => phase === 'list' && dir === backupDir ? Response.json({ errno: -9 }, { status: 403 }) : undefined,
  });
  const deniedCookie = await denied.login('owner');
  assert.equal((await denied.get(deniedCookie)).status, 502);
  assert.equal((await denied.put(deniedCookie, snapshotBytes(account))).status, 502);
  assert.deepEqual(denied.stages, []);
});

test('rejects invalid references and does not issue duplicate commits after upstream ambiguity', async t => {
  let lost = true;
  let uploadFailed = false;
  const f = await backupFixture(t, {
    respond({ phase, download }) {
      if (phase === 'filemetas' && !download) return Response.json({ errno: 0, list: [{ ...songRow, isdir: 1 }] });
      if (phase === 'upload' && !uploadFailed) {
        uploadFailed = true;
        return Response.json({}, { status: 503 });
      }
      if (phase === 'create' && lost) {
        lost = false;
        throw new TypeError('upstream timeout could include authentication URL');
      }
    },
  });
  const cookie = await f.login('owner');
  const { account } = await (await f.get(cookie)).json();
  const invalid = await f.put(cookie, snapshotBytes(account, { withFile: true }));
  assert.equal(invalid.status, 409);
  assert.equal((await invalid.json()).code, 'invalid_track_reference');
  assert.deepEqual(f.stages, []);
  const bytes = snapshotBytes(account);
  const uncertain = await f.put(cookie, bytes);
  assert.equal(uncertain.status, 503);
  assert.equal((await uncertain.json()).code, 'commit_unknown');
  assert.deepEqual(f.stages, ['precreate', 'upload', 'upload', 'create']);
  assert.deepEqual(await (await f.put(cookie, bytes)).json(), { status: 'saved', id: operationId });
  assert.deepEqual(f.stages, ['precreate', 'upload', 'upload', 'create', 'precreate', 'upload', 'create']);
});

test('reconciles readback after a lost commit and shares identical concurrent writes', async t => {
  let completeCreate;
  let notifyCreate;
  const sawCreate = new Promise(resolve => { notifyCreate = resolve; });
  const delayCreate = new Promise(resolve => { completeCreate = resolve; });
  const f = await backupFixture(t, {
    async respond({ phase }) {
      if (phase === 'committed') {
        notifyCreate();
        await delayCreate;
        throw new TypeError('fixture lost the final response');
      }
    },
  });
  const cookie = await f.login('owner');
  const { account } = await (await f.get(cookie)).json();
  const bytes = snapshotBytes(account);
  const first = f.put(cookie, bytes);
  await sawCreate;
  let duplicate;
  try {
    duplicate = f.put(cookie, bytes);
    const conflict = await f.put(cookie, snapshotBytes(account, { name: '不同版本' }));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'snapshot_conflict');
  } finally {
    completeCreate();
  }
  const [initial, repeated] = await Promise.all([first, duplicate]);
  assert.deepEqual(await initial.json(), { status: 'reconciled', id: operationId });
  const second = await repeated.json();
  assert.equal(second.id, operationId);
  assert.ok(['reconciled', 'already_present'].includes(second.status));
  assert.deepEqual(f.stages, ['precreate', 'upload', 'create']);
  assert.deepEqual(new Uint8Array(f.files.get('owner').get(backupPath).bytes), bytes);
});

test('keeps ordinary audio browsing available when Baidu account identity cannot be verified', async t => {
  const f = await backupFixture(t, {
    respond: ({ phase }) => phase === 'uinfo' ? Response.json({ errno: 0, uk: null, baidu_name: 'hidden' }) : undefined,
  });
  const cookie = await f.login('owner');
  const { items } = await (await f.get(cookie, '/list')).json();
  assert.deepEqual(items.map(item => item.id), [mediaId, '7']);
  assert.ok(items.every(item => item.backupAccount === undefined));
  const invalid = await f.get(cookie);
  assert.equal(invalid.status, 502);
  assert.doesNotMatch(await invalid.text(), /hidden/);
  assert.deepEqual(f.stages, []);
});

test('returns exact snapshot text with only currently available audio across provider batches', async t => {
  const ids = [...Array.from({ length: 100 }, (_, index) => String(index + 1)), mediaId];
  let mode = 'upload';
  const batches = [];
  const f = await backupFixture(t, {
    respond({ phase, download, ids }) {
      if (phase !== 'filemetas' || download) return;
      batches.push(ids);
      if (mode === 'error' && ids.includes(mediaId)) {
        return Response.json({ errno: -9, list: [] });
      }
      if (mode === 'unexpected' && ids.includes(mediaId)) {
        return Response.json({ errno: 0, list: [{ ...songRow, fs_id: '3456' }] });
      }
      const list = ids.filter(id => mode !== 'partial' || id !== mediaId).map(id => {
        if (mode === 'partial' && id === '1') return { fs_id: id, errno: -9 };
        if (mode === 'partial' && id === '2') return { fs_id: id, isdir: 1 };
        if (mode === 'partial' && id === '3') return { fs_id: id, isdir: 0, filename: 'readme.txt' };
        return { ...songRow, fs_id: id };
      }).reverse();
      return Response.json({ errno: 0, list });
    },
  });
  const cookie = await f.login('owner');
  const { account } = await (await f.get(cookie)).json();
  const tracks = ids.map(id => ({ id, title: '曲目 ' + id }));
  const bytes = createPlaylistSnapshot({ tracks, playlists: [{ name: '验证现有曲目', tracks: ids }], favorites: [] }, {
    operation: operationId, scope: { provider: 'baidu', account }, verifiedFiles: new Map(ids.map(id => [id, id])),
  });
  assert.equal((await f.put(cookie, bytes)).status, 200);
  assert.deepEqual(batches.splice(0), [ids.slice(0, 100), [mediaId]]);
  mode = 'partial';
  const route = backupRoute + '&verify=1';
  const verified = await f.get(cookie, route);
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), {
    snapshot: Buffer.from(bytes).toString('utf8'),
    available: ids.slice(3, 100),
  });
  assert.deepEqual(batches.splice(0), [ids.slice(0, 100), [mediaId]]);
  assert.deepEqual(new Uint8Array(await (await f.get(cookie, backupRoute)).arrayBuffer()), bytes);
  assert.deepEqual(batches, []);

  for (const failureMode of ['error', 'unexpected']) {
    mode = failureMode;
    const response = await f.get(cookie, route);
    assert.equal(response.status, 502);
    const rejected = await response.json();
    assert.equal(rejected.code, 'verification_unavailable');
    assert.equal(rejected.available, undefined);
    assert.equal(rejected.snapshot, undefined);
    assert.deepEqual(batches.splice(0), [ids.slice(0, 100), [mediaId]]);
  }
  assert.equal((await f.get(cookie, '/backup?verify=1')).status, 400);
  assert.equal((await f.get(cookie, backupRoute + '&verify=0')).status, 400);
  assert.equal((await f.get(cookie, route + '&verify=1')).status, 400);
  assert.equal((await f.put(cookie, bytes, {}, route)).status, 400);
  assert.equal((await f.get(await f.login('other'), route)).status, 404);
  assert.deepEqual(batches, []);
});

test('withholds a deferred verified snapshot after its browser session disconnects', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let defer = false;
  const f = await backupFixture(t, {
    async respond({ phase, download }) {
      if (defer && phase === 'filemetas' && !download) {
        started.resolve();
        await finish.promise;
        return Response.json({ errno: 0, list: [songRow] });
      }
    },
  });
  const owner = await f.login('owner');
  const { account } = await (await f.get(owner)).json();
  const bytes = snapshotBytes(account, { withFile: true });
  assert.equal((await f.put(owner, bytes)).status, 200);
  defer = true;
  const pending = f.get(owner, backupRoute + '&verify=1');
  try {
    await started.promise;
    const disconnected = await f.request('/disconnect', {
      method: 'POST', headers: { Cookie: owner, Origin: f.origin },
    });
    assert.equal(disconnected.status, 200);
    const other = await f.login('other');
    assert.equal((await f.get(other, backupRoute + '&verify=1')).status, 404);
  } finally {
    finish.resolve();
  }
  const interrupted = await pending;
  assert.equal(interrupted.status, 401);
  const body = await interrupted.json();
  assert.equal(body.snapshot, undefined);
  assert.equal(body.available, undefined);
  assert.equal(body.account, undefined);
});

test('stops upload before the next write phase after a concurrent Baidu disconnect', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const f = await backupFixture(t, {
    async respond({ phase }) {
      if (phase === 'precreate') {
        started.resolve();
        await finish.promise;
      }
    },
  });
  const cookie = await f.login('owner');
  const { account } = await (await f.get(cookie)).json();
  const pending = f.put(cookie, snapshotBytes(account));
  try {
    await started.promise;
    const disconnected = await f.request('/disconnect', {
      method: 'POST', headers: { Cookie: cookie, Origin: f.origin },
    });
    assert.equal(disconnected.status, 200);
  } finally {
    finish.resolve();
  }

  const interrupted = await pending;
  assert.equal(interrupted.status, 401);
  assert.deepEqual(f.stages, ['precreate']);
  assert.equal(f.files.get('owner').size, 0);
});

test('never confirms an ambiguous Baidu commit using an invalidated session', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const f = await backupFixture(t, {
    async respond({ phase }) {
      if (phase === 'committed') {
        started.resolve();
        await finish.promise;
        throw new TypeError('provider dropped its reply');
      }
    },
  });
  const cookie = await f.login('owner');
  const { account } = await (await f.get(cookie)).json();
  const bytes = snapshotBytes(account);
  const pending = f.put(cookie, bytes);
  try {
    await started.promise;
    const disconnected = await f.request('/disconnect', {
      method: 'POST', headers: { Cookie: cookie, Origin: f.origin },
    });
    assert.equal(disconnected.status, 200);
  } finally {
    finish.resolve();
  }
  const result = await pending;
  assert.equal(result.status, 503);
  assert.equal((await result.json()).code, 'commit_unknown');
  assert.deepEqual(f.stages, ['precreate', 'upload', 'create']);
  const same = await f.login('owner-reconnected');
  assert.deepEqual(await (await f.put(same, bytes)).json(), { status: 'already_present', id: operationId });
  assert.deepEqual(f.stages, ['precreate', 'upload', 'create']);
});
