import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMetadataHandler } from '../server/metadata-api.mjs';
import { createMetadataArtworkHandler } from '../server/metadata-artwork-api.mjs';

const base = '/api/metadata/artwork/';
const jpeg = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
const photo = { scope: 'artist', artist: '艺人 & Artist' };
const cover = { scope: 'album', album: 'Album + title', artist: photo.artist };

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const close = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  t.after(close);
  return { origin: 'http://127.0.0.1:' + server.address().port, close };
}

async function settingsDirectory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'groovebox-metadata-artwork-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function player(t, options) {
  const handlers = [createMetadataHandler(options), createMetadataArtworkHandler(options)];
  const { origin, close } = await serve(t, async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    for (const handler of handlers) if (await handler(req, res, url)) return;
    res.writeHead(404).end();
  });
  const send = (path, { method = 'GET', body, headers, signal } = {}) => fetch(origin + path, {
    method,
    headers: { ...(method !== 'GET' && { Origin: origin, 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const put = artwork => send(base + 'config', { method: 'PUT', body: { artwork: { adapter: 'hisatri', album: true, artist: true,
    headersAction: 'keep', ...artwork } } });
  const lookup = (body, extra) => send(base + 'cover', { method: 'POST', body, ...extra });
  return { origin, close, send, put, lookup };
}

function raster(res, bytes = jpeg) {
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.byteLength }).end(bytes);
}

test('stores independent encrypted artwork settings and returns opaque cached photos and covers, preserving lyric configuration', async t => {
  const received = [];
  const source = await serve(t, (req, res) => {
    received.push({ url: new URL(req.url, 'http://localhost'), headers: req.headers });
    raster(res);
  });
  const dataDir = await settingsDirectory(t);
  const app = await player(t, { dataDir });
  assert.deepEqual(await (await app.send(base + 'status')).json(),
    { configured: false, artwork: { adapter: 'none', revision: 'none', album: false, artist: false } });
  const lyric = await app.send('/api/metadata/config', { method: 'PUT', body: { lyrics: {
    adapter: 'hisatri', url: source.origin + '/lyrics', headersAction: 'replace', headers: 'Authentication=lyric-secret',
  } } });
  assert.equal(lyric.status, 200);
  const lyricStatus = await lyric.json();
  const url = source.origin + '/exact-hisatri-cover';
  const saved = await app.put({ url, headersAction: 'replace', headers: 'Authentication=art-secret&X-Cover-Key=second-art-secret' });
  const status = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(status.configured, true);
  assert.deepEqual(Object.keys(status.artwork).sort(), ['adapter', 'album', 'artist', 'revision']);
  assert.deepEqual(await (await app.send(base + 'config')).json(), {
    artwork: { adapter: 'hisatri', url, album: true, artist: true, hasHeaders: true },
  });
  assert.equal(received.length, 0);

  const picture = await app.lookup({ ...photo, artist: ' ' + photo.artist + ' ', album: 'ignored-for-artist' }, {
    headers: { Cookie: 'source-token=ignored', Authorization: 'Bearer browser-secret', 'X-Metadata-Revision': status.artwork.revision },
  });
  assert.equal(picture.status, 200);
  const portrait = await picture.json();
  assert.deepEqual(Object.keys(portrait).sort(), ['adapter', 'cover', 'revision', 'scope']);
  assert.equal(portrait.scope, 'artist');
  assert.equal(portrait.revision, status.artwork.revision);
  assert.match(portrait.cover, /^\/api\/metadata\/artwork\/image\?id=[a-f0-9-]{36}$/);
  assert.deepEqual(await (await app.lookup(photo)).json(), portrait);
  const album = await (await app.lookup(cover)).json();
  assert.notEqual(album.cover, portrait.cover);
  assert.equal(album.scope, 'album');
  assert.deepEqual(received.map(entry => entry.url.pathname), ['/exact-hisatri-cover', '/exact-hisatri-cover']);
  assert.deepEqual(received.map(entry => Object.fromEntries(entry.url.searchParams)), [
    { artist: photo.artist, sourceType: 'api' },
    { album: cover.album, artist: photo.artist, sourceType: 'api' },
  ]);
  for (const { headers } of received) {
    assert.equal(headers.accept, '*/*');
    assert.equal(headers.authentication, 'art-secret');
    assert.equal(headers['x-cover-key'], 'second-art-secret');
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-metadata-revision'], undefined);
  }
  const image = await app.send(portrait.cover);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(image.headers.get('cache-control'), 'private, no-store');
  assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  assert.equal((await app.send(portrait.cover, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(received.length, 2);
  assert.deepEqual(await (await app.send('/api/metadata/status')).json(), lyricStatus);

  const file = join(dataDir, 'metadata-artwork-settings.bin');
  const bytes = await readFile(file);
  for (const text of [url, 'art-secret', 'second-art-secret', 'Authentication']) assert.equal(bytes.includes(text), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await app.close();
  const reopened = await player(t, { dataDir });
  assert.deepEqual(await (await reopened.send(base + 'status')).json(), status);
  assert.equal((await reopened.send(portrait.cover)).status, 404);
  assert.equal(received.length, 2);
  assert.equal((await reopened.lookup(photo)).status, 200);
  assert.equal(received.at(-1).headers.authentication, 'art-secret');
});

test('rejects stale revisions before fetching and invalidates image IDs and credentials when the endpoint changes', async t => {
  const authenticated = [];
  const makeSource = () => serve(t, (req, res) => { authenticated.push(req.headers.authentication); raster(res); });
  const [first, second] = await Promise.all([makeSource(), makeSource()]);
  const app = await player(t, { dataDir: await settingsDirectory(t) });
  const original = await (await app.put({ url: first.origin + '/cover', artist: false, headersAction: 'replace',
    headers: 'Authentication=first-origin-only' })).json();
  const denied = await app.lookup(photo);
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).code, 'metadata_scope_disabled');
  const known = await (await app.lookup(cover)).json();
  assert.deepEqual(authenticated, ['first-origin-only']);
  const replacement = await (await app.put({ url: second.origin + '/cover', album: false })).json();
  assert.notEqual(replacement.artwork.revision, original.artwork.revision);
  assert.equal((await (await app.send(base + 'config')).json()).artwork.hasHeaders, false);
  const staleImage = await app.send(known.cover);
  assert.equal(staleImage.status, 404);
  assert.equal((await staleImage.json()).code, 'metadata_image_not_found');
  const staleRequest = await app.lookup(photo, { headers: { 'X-Metadata-Revision': original.artwork.revision } });
  assert.equal(staleRequest.status, 409);
  assert.equal((await staleRequest.json()).code, 'metadata_config_changed');
  assert.deepEqual(authenticated, ['first-origin-only']);
  const fresh = await app.lookup(photo, { headers: { 'X-Metadata-Revision': replacement.artwork.revision } });
  assert.equal(fresh.status, 200);
  assert.deepEqual(authenticated, ['first-origin-only', undefined]);
  assert.deepEqual(await (await app.put({ url: second.origin + '/cover', album: false })).json(), replacement);
  const disabled = await (await app.put({ adapter: 'none', url: '', album: true, artist: true })).json();
  assert.deepEqual({ ...disabled.artwork, revision: undefined }, { adapter: 'none', revision: undefined, album: false, artist: false });
  const disabledLookup = await app.lookup(photo);
  assert.equal(disabledLookup.status, 404);
  assert.equal((await disabledLookup.json()).code, 'metadata_not_configured');
  assert.equal((await app.send((await fresh.json()).cover)).status, 404);
  assert.equal(authenticated.length, 2);
});

test('authorizes the configured endpoint only, accepts proxied same-host lookups and keeps config local', async t => {
  const requested = [];
  const source = await serve(t, (req, res) => { requested.push(req.url); raster(res); });
  const app = await player(t, { dataDir: await settingsDirectory(t) });
  for (const url of ['file:///tmp/cover', 'http://username:password@localhost/cover', source.origin + '/?credential=value',
    source.origin + '/#fragment', source.origin + '/' + '图'.repeat(400)]) {
    assert.equal((await app.put({ url })).status, 400);
  }
  assert.equal((await app.put({ url: source.origin + '/cover', headersAction: 'replace', headers: 'Cookie=injected' })).status, 400);
  assert.equal((await app.put({ url: source.origin + '/cover', headersAction: 'replace', headers: 'X-Forwarded-For=invalid' })).status, 400);
  assert.equal((await app.send(base + 'config', { headers: { 'X-Forwarded-For': '192.0.2.3' } })).status, 403);
  const configured = await app.put({ url: source.origin + '/cover' });
  assert.equal(configured.status, 200);
  assert.equal((await app.lookup({ ...photo, url: source.origin + '/other' })).status, 400);
  assert.equal((await app.lookup(photo, { headers: { Origin: 'https://other.example.test' } })).status, 403);
  assert.equal((await app.lookup(photo, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await app.lookup({ ...photo, artist: 'x'.repeat(12_100) })).status, 413);
  assert.deepEqual(requested, []);

  const proxyHop = (path, origin) => new Promise((resolve, reject) => {
    const req = request(app.origin + base + path, { method: path === 'cover' ? 'POST' : 'PUT',
      headers: { Host: 'music.example.test', Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' } },
    res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify(photo));
  });
  assert.equal(await proxyHop('cover', 'https://music.example.test'), 200);
  assert.equal(await proxyHop('cover', 'https://different.example.test'), 403);
  assert.equal(await proxyHop('config', 'https://music.example.test'), 403);
  assert.equal(requested.length, 1);
});

test('fails closed on damaged settings and allows an explicit repair without changing the lyric revision', async t => {
  const dataDir = await settingsDirectory(t);
  let calls = 0;
  const source = await serve(t, (req, res) => { calls += 1; raster(res); });
  const original = await player(t, { dataDir });
  const status = await (await original.put({ url: source.origin + '/cover' })).json();
  await original.close();
  const file = join(dataDir, 'metadata-artwork-settings.bin');
  const bytes = await readFile(file);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(file, bytes);
  const damaged = await player(t, { dataDir });
  for (const response of [await damaged.send(base + 'status'), await damaged.lookup(cover)]) {
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'metadata_config_unavailable');
  }
  assert.equal(calls, 0);
  assert.deepEqual(await (await damaged.send(base + 'config')).json(), { configurationError: true,
    artwork: { adapter: 'none', url: '', album: false, artist: false, hasHeaders: false } });
  const repair = await damaged.put({ url: source.origin + '/cover' });
  assert.equal(repair.status, 200);
  assert.notEqual((await repair.json()).artwork.revision, status.artwork.revision);
  assert.equal((await damaged.lookup(cover)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await damaged.send('/api/metadata/status')).status, 200);
});

test('evicts old IDs when the byte or entry cap is reached and never refetches an evicted image URL', async t => {
  const large = Buffer.concat([jpeg, Buffer.alloc(2 * 1024 * 1024 - jpeg.length)]);
  let calls = 0;
  const source = await serve(t, (req, res) => {
    calls += 1;
    const artist = new URL(req.url, 'http://localhost').searchParams.get('artist');
    raster(res, artist.startsWith('big') ? large : jpeg);
  });
  const app = await player(t, { dataDir: await settingsDirectory(t) });
  await app.put({ url: source.origin + '/cover' });
  const fill = async (prefix, count) => {
    const ids = [];
    for (let index = 0; index < count; index++) {
      const result = await app.lookup({ scope: 'artist', artist: prefix + index });
      assert.equal(result.status, 200);
      ids.push((await result.json()).cover);
    }
    return ids;
  };
  const big = await fill('big', 17);
  assert.equal((await app.send(big[0])).status, 404);
  assert.equal((await app.send(big.at(-1))).status, 200);
  const small = await fill('small', 129);
  assert.equal((await app.send(small[0])).status, 404);
  assert.equal((await app.send(small.at(-1))).status, 200);
  assert.equal(calls, big.length + small.length);
});

test('closes pending origin requests when the client disconnects or changes configuration', { timeout: 6000 }, async t => {
  const arrivals = [Promise.withResolvers(), Promise.withResolvers()];
  const closes = [Promise.withResolvers(), Promise.withResolvers()];
  let attempts = 0;
  const source = await serve(t, (req, res) => {
    const index = attempts++;
    res.once('close', () => closes[index].resolve());
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.write(jpeg.subarray(0, 4));
    arrivals[index].resolve();
  });
  const app = await player(t, { dataDir: await settingsDirectory(t) });
  await app.put({ url: source.origin + '/cover' });
  const controller = new AbortController();
  const abandoned = app.lookup(cover, { signal: controller.signal });
  await arrivals[0].promise;
  controller.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
  await closes[0].promise;

  const pending = app.lookup(cover);
  await arrivals[1].promise;
  await app.put({ url: source.origin + '/cover', album: false });
  const superseded = await pending;
  assert.equal(superseded.status, 409);
  assert.equal((await superseded.json()).code, 'metadata_config_changed');
  await closes[1].promise;
  assert.equal(attempts, 2);
});
