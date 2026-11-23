import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { createCastHandler } from '../server/cast-bridge.mjs';

const clip = Buffer.from('0123456789abcdefghijkl');
const maxUpload = 60 * 1024 * 1024;
const first = {
  id: 'opaque-receiver-a', name: '客厅音响', address: '127.0.0.1', localAddress: '127.0.0.1',
  controlUrl: 'http://127.0.0.1:6020/control', serviceType: 'urn:schemas-upnp-org:service:AVTransport:1',
};
const second = { ...first, id: 'opaque-receiver-b', name: '书房音响' };

function sessionCookie(response) {
  const setCookie = response.headers.get('Set-Cookie');
  assert.match(setCookie, /^groovebox_cast=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/api\/cast$/);
  return setCookie.split(';')[0];
}

async function fixture(t, { discover = async () => [first], onControl = () => {} } = {}) {
  const calls = [];
  const cookies = new Set();
  let origin;
  const handle = createCastHandler({
    discover,
    async control(renderer, action, params, options) {
      assert(options.signal instanceof AbortSignal);
      calls.push({ id: renderer.id, action, params });
      return onControl(renderer, action, params);
    },
  });
  const server = createServer(async (req, res) => {
    if (!await handle(req, res, new URL(req.url, origin))) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  function request(path, init) {
    return fetch(origin + '/api/cast/' + path, { ...init, redirect: 'manual' });
  }
  async function search() {
    const response = await request('devices');
    assert.equal(response.status, 200);
    const cookie = sessionCookie(response);
    cookies.add(cookie);
    return { cookie, body: await response.json() };
  }
  function action(command, cookie, extra = {}) {
    return request(command, { ...extra, method: 'POST', headers: { Cookie: cookie, Origin: origin, ...extra.headers } });
  }
  function cast(cookie, device = first.id, extra = {}) {
    const params = new URLSearchParams({ device, artist: '艺人', title: '窗口 & 花', album: '专辑', seconds: '5.5' });
    return action('start?' + params, cookie, { body: clip, ...extra, headers: { 'Content-Type': 'audio/mpeg', ...extra.headers } });
  }
  t.after(async () => {
    for (const cookie of cookies) {
      await action('stop', cookie, { signal: AbortSignal.timeout(2000) }).then(res => res.arrayBuffer()).catch(() => {});
    }
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  return { request, search, action, cast, origin, calls };
}

test('loopback-only browser discovery exposes opaque names and rejects rebinding or cross-site callers', async t => {
  let discoveries = 0;
  const app = await fixture(t, { discover: async () => { discoveries++; return [first]; } });
  for (const headers of [
    { Host: 'lookalike.invalid:6020' },
    { Origin: 'http://elsewhere.invalid' },
    { Origin: app.origin, 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const forbidden = await rawRequest(app.origin, 'devices', { method: 'GET', headers });
    assert.equal(forbidden.status, 403, JSON.stringify(headers));
    assert.equal(forbidden.headers['set-cookie'], undefined);
    assert.deepEqual(Object.keys(forbidden.body), ['error']);
  }
  assert.equal(discoveries, 0);
  const { cookie, body } = await app.search();
  assert.equal(discoveries, 1);
  assert.deepEqual(body, { devices: [{ id: first.id, name: first.name }] });
  assert(!JSON.stringify(body).includes(first.address));
  const secondDiscovery = await app.request('devices', { headers: { Cookie: cookie, Origin: app.origin } });
  assert.equal(secondDiscovery.status, 200);
  assert.equal(secondDiscovery.headers.get('Set-Cookie'), null);
  assert.deepEqual(await secondDiscovery.json(), body);

  const wrongMethod = await app.action('devices', cookie);
  assert.equal(wrongMethod.status, 405);
  await wrongMethod.json();
});

test('renderer receives a private ephemeral Range stream and supports playback position, controls, and stop cleanup', async t => {
  let remoteAudio;
  const app = await fixture(t, { async onControl(renderer, command, params) {
    assert.equal(renderer.id, first.id);
    if (command === 'setUri') {
      remoteAudio = new URL(params.uri);
      assert.equal(remoteAudio.hostname, first.localAddress);
      assert(remoteAudio.port);
      assert.match(remoteAudio.pathname, /^\/audio\/[A-Za-z0-9_-]{32}$/);
      const head = await fetch(remoteAudio, { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
      assert.equal(head.status, 206);
      assert.equal(head.headers.get('content-type'), 'audio/mpeg');
      assert.equal(head.headers.get('content-range'), 'bytes 2-5/' + clip.length);
      assert.equal(head.headers.get('content-length'), '4');
      assert.equal(head.headers.get('accept-ranges'), 'bytes');
      assert.equal((await head.arrayBuffer()).byteLength, 0);

      const suffix = await fetch(remoteAudio, { headers: { Range: 'bytes=-4' } });
      assert.equal(suffix.status, 206);
      assert.equal(await suffix.text(), clip.subarray(-4).toString());
    }
    if (command === 'getPosition') return { position: 12.5, duration: 120 };
    if (command === 'getTransport') return { state: 'PLAYING' };
  } });
  const { cookie } = await app.search();
  const started = await app.cast(cookie);
  assert.equal(started.status, 200);
  assert.deepEqual(await started.json(), { active: true });
  assert.deepEqual(app.calls, [
    { id: first.id, action: 'setUri', params: {
      uri: remoteAudio.href, title: '窗口 & 花', artist: '艺人', album: '专辑', mime: 'audio/mpeg',
    } },
    { id: first.id, action: 'play', params: {} },
    { id: first.id, action: 'seek', params: { seconds: 5.5 } },
  ]);

  const normal = await fetch(remoteAudio);
  assert.equal(normal.status, 200);
  assert.equal(normal.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await normal.arrayBuffer()), clip);
  const ahead = await fetch(remoteAudio, { headers: { Range: 'bytes=999-' } });
  assert.equal(ahead.status, 416);
  assert.equal(ahead.headers.get('content-range'), 'bytes */' + clip.length);
  assert.equal((await fetch(remoteAudio.href + '?unexpected=1')).status, 404);
  assert.equal((await fetch(remoteAudio, { method: 'POST' })).status, 405);

  const position = await app.request('position', { headers: { Cookie: cookie } });
  assert.equal(position.status, 200);
  assert.deepEqual(await position.json(), { position: 12.5, duration: 120, state: 'PLAYING' });
  for (const command of ['pause', 'seek?seconds=68', 'play']) {
    const handled = await app.action(command, cookie);
    assert.deepEqual(await handled.json(), { active: true });
  }
  assert.deepEqual(app.calls.slice(-3).map(call => [call.action, call.params]), [
    ['pause', {}], ['seek', { seconds: 68 }], ['play', {}],
  ]);
  const stopped = await app.action('stop', cookie);
  assert.deepEqual(await stopped.json(), { active: false });
  assert.equal(app.calls.at(-1).action, 'stop');
  await assert.rejects(fetch(remoteAudio, { signal: AbortSignal.timeout(1500) }));
  const noPosition = await app.request('position', { headers: { Cookie: cookie } });
  assert.equal(noPosition.status, 404);
  await noPosition.json();
});

test('sessions cannot select a different session’s renderer or control its active cast', async t => {
  let searchCount = 0;
  const app = await fixture(t, { discover: async () => [searchCount++ ? second : first] });
  const a = await app.search();
  const b = await app.search();
  assert.notEqual(a.cookie, b.cookie);
  assert.deepEqual(b.body.devices, [{ id: second.id, name: second.name }]);
  const cast = await app.cast(a.cookie);
  assert.equal(cast.status, 200);
  await cast.json();
  for (const [route, response] of [
    ['unknown selection', await app.cast(b.cookie, first.id)],
    ['anonymous control', await app.request('pause', { method: 'POST' })],
    ['other-session pause', await app.action('pause', b.cookie)],
    ['other-session seek', await app.action('seek?seconds=1', b.cookie)],
    ['other-session position', await app.request('position', { headers: { Cookie: b.cookie } })],
    ['other-session stop', await app.action('stop', b.cookie)],
  ]) {
    assert.equal(response.status, 404, route);
    await response.json();
  }
  assert.deepEqual(app.calls.map(({ action }) => action), ['setUri', 'play', 'seek']);
  const stopped = await app.action('stop', a.cookie);
  assert.equal(stopped.status, 200);
  await stopped.json();
});

function rawRequest(origin, path, { method, headers }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(origin + '/api/cast/' + path, { method, headers, signal: AbortSignal.timeout(1500) }, async res => {
      try {
        let body = '';
        for await (const chunk of res) body += chunk;
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
      } catch (error) { reject(error); }
    });
    req.once('error', reject);
    req.end();
  });
}

test('upload validates audio MIME, empty payload, explicit size, and chunked size before contacting a receiver', async t => {
  const app = await fixture(t);
  const { cookie } = await app.search();
  const wrongMime = await app.cast(cookie, first.id, { headers: { 'Content-Type': 'text/html' } });
  assert.equal(wrongMime.status, 415);
  assert.equal(typeof (await wrongMime.json()).error, 'string');
  const empty = await app.cast(cookie, first.id, { body: Buffer.alloc(0) });
  assert.equal(empty.status, 400);
  assert.equal(typeof (await empty.json()).error, 'string');

  const oversized = await rawRequest(app.origin, 'start?device=' + first.id, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'audio/mpeg', 'Content-Length': maxUpload + 1 },
  });
  assert.equal(oversized.status, 413);
  assert.match(oversized.body.error, /60 MB/);

  const unit = Buffer.alloc(1024 * 1024);
  const streamed = await app.cast(cookie, first.id, {
    body: (async function* () {
      for (let i = 0; i <= 60; i++) yield unit;
    })(),
    duplex: 'half',
    signal: AbortSignal.timeout(6000),
  });
  assert.equal(streamed.status, 413);
  assert.match((await streamed.json()).error, /60 MB/);
  assert.deepEqual(app.calls, []);
});

test('the LAN bridge ignores forwarded headers, and serving closes even when receiver Stop fails', async t => {
  let bridge;
  const otherPeer = { ...first, address: '127.0.0.2' };
  const app = await fixture(t, {
    discover: async () => [otherPeer],
    onControl(_renderer, command, params) {
      if (command === 'setUri') bridge = params.uri;
      if (command === 'stop') throw new Error('simulated receiver failure');
    },
  });
  const { cookie } = await app.search();
  const started = await app.cast(cookie);
  assert.deepEqual(await started.json(), { active: true });
  const outsider = await fetch(bridge, { headers: { 'X-Forwarded-For': '127.0.0.2', 'Forwarded': 'for=127.0.0.2' } });
  assert.equal(outsider.status, 404);

  const stopped = await app.action('stop', cookie);
  assert.equal(stopped.status, 502);
  assert.match((await stopped.json()).error, /局域网投屏/);
  await assert.rejects(fetch(bridge, { signal: AbortSignal.timeout(1500) }));
  const position = await app.request('position', { headers: { Cookie: cookie } });
  assert.equal(position.status, 404);
  await position.json();
});

test('application/ogg is served as audio/ogg and switching devices discards the old bridge', async t => {
  const urls = new Map();
  const app = await fixture(t, {
    discover: async () => [first, second],
    async onControl(renderer, command, params) {
      if (command !== 'setUri') return;
      const audio = await fetch(params.uri, { method: 'HEAD' });
      assert.equal(audio.headers.get('content-type'), params.mime);
      urls.set(renderer.id, params.uri);
    },
  });
  const { cookie } = await app.search();
  const ogg = await app.cast(cookie, first.id, { headers: { 'Content-Type': 'application/ogg' } });
  assert.equal(ogg.status, 200);
  assert.deepEqual(await ogg.json(), { active: true });
  assert.equal(app.calls.find(call => call.action === 'setUri').params.mime, 'audio/ogg');

  const switched = await app.cast(cookie, second.id);
  assert.deepEqual(await switched.json(), { active: true });
  assert.deepEqual(app.calls.at(-1), { id: first.id, action: 'stop', params: {} });
  await assert.rejects(fetch(urls.get(first.id), { signal: AbortSignal.timeout(1500) }));
  const active = await fetch(urls.get(second.id), { method: 'HEAD' });
  assert.equal(active.status, 200);
});
