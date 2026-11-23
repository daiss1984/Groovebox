import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { MetadataCoverError, queryMetadataCover } from '../server/metadata-cover.mjs';

const jpeg = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=', 'base64');
const headers = [['Authorization', 'Bearer cover-fixture-secret'], ['X-Reference-Fixture', 'local only']];
const artistLookup = { scope: 'artist', artist: '海岛 & 乐团' };
const albumLookup = { scope: 'album', album: '黄昏 + 现场', artist: '海岛 & 乐团' };
const maxImageBytes = 2 * 1024 * 1024;

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return 'http://127.0.0.1:' + server.address().port;
}

function config(origin, path = '/configured/cover') {
  return { url: origin + path, headers, revision: 'cover-fixture' };
}

function errorIs(status, code, retryAfter) {
  return error => {
    assert.ok(error instanceof MetadataCoverError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.retryAfter, retryAfter);
    assert.doesNotMatch(error.message, /cover-fixture-secret|127\.0\.0\.1|private-provider-error/);
    return true;
  };
}

test('uses the exact configured HTTP endpoint and protocol for artist and album artwork', async t => {
  const requests = [];
  const origin = await listen(t, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({
      method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams),
      accept: req.headers.accept, auth: req.headers.authorization, fixture: req.headers['x-reference-fixture'],
      cookie: req.headers.cookie,
    });
    const album = url.searchParams.has('album');
    res.writeHead(200, { 'Content-Type': album ? 'image/png' : 'image/jpeg; fixture=raw' }).end(album ? png : jpeg);
  });
  const selected = config(origin);
  assert.deepEqual(await queryMetadataCover(selected, { ...artistLookup, album: 'ignored on artist requests' }), {
    bytes: jpeg, contentType: 'image/jpeg',
  });
  assert.deepEqual(await queryMetadataCover(selected, albumLookup), { bytes: png, contentType: 'image/png' });
  assert.deepEqual(await queryMetadataCover(selected, { ...albumLookup, artist: '' }), { bytes: png, contentType: 'image/png' });
  const expected = {
    method: 'GET', path: '/configured/cover', accept: '*/*', auth: headers[0][1], fixture: headers[1][1], cookie: undefined,
  };
  assert.deepEqual(requests, [
    { ...expected, params: { artist: artistLookup.artist, sourceType: 'api' } },
    { ...expected, params: { album: albumLookup.album, artist: albumLookup.artist, sourceType: 'api' } },
    { ...expected, params: { album: albumLookup.album, sourceType: 'api' } },
  ]);
  assert.equal(selected.url, origin + '/configured/cover');
});

test('rejects invalid scope or metadata before opening a connection', async t => {
  let requests = 0;
  const origin = await listen(t, (_, res) => {
    requests++;
    res.writeHead(500).end();
  });
  for (const invalid of [
    null, { scope: 'track', artist: 'Valid' }, { scope: 'artist', artist: '  ' },
    { scope: 'album', artist: 'Only Artist' }, { scope: 'album', album: 123 },
    { scope: 'album', album: 'Bad\nTitle' }, { scope: 'artist', artist: '歌'.repeat(201) },
  ]) {
    await assert.rejects(queryMetadataCover(config(origin), invalid), errorIs(400, 'metadata_invalid_lookup'));
  }
  await assert.rejects(queryMetadataCover(config(origin, '/configured/cover?token=cover-fixture-secret'), artistLookup),
    errorIs(502, 'metadata_unavailable'));
  assert.equal(requests, 0);
});

test('preserves 404 and bounded rate limits without exposing upstream content', async t => {
  const origin = await listen(t, (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/missing') {
      res.writeHead(404).end('private-provider-error');
      return;
    }
    const delays = { '/normal': '8', '/excessive': '999999999999999999999', '/past': 'Thu, 01 Jan 1970 00:00:00 GMT' };
    res.writeHead(429, delays[path] ? { 'Retry-After': delays[path] } : {}).end('private-provider-error');
  });
  await assert.rejects(queryMetadataCover(config(origin, '/missing'), artistLookup), errorIs(404, 'metadata_not_found'));
  for (const [path, seconds] of [['/normal', 8], ['/excessive', 3600], ['/past', 1], ['/unspecified', 60]]) {
    await assert.rejects(queryMetadataCover(config(origin, path), artistLookup), errorIs(429, 'metadata_rate_limited', seconds));
  }
});

test('rejects an HTTP redirect without contacting its destination or forwarding headers', async t => {
  let targetRequests = 0;
  let initialRequests = 0;
  const redirected = await listen(t, (_, res) => {
    targetRequests++;
    res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(jpeg);
  });
  const origin = await listen(t, (req, res) => {
    initialRequests++;
    assert.equal(req.headers.authorization, headers[0][1]);
    res.writeHead(302, { Location: redirected + '/foreign-cover' }).end();
  });
  await assert.rejects(queryMetadataCover(config(origin), artistLookup), errorIs(502, 'metadata_unavailable'));
  assert.equal(initialRequests, 1);
  assert.equal(targetRequests, 0);
});

test('rejects oversized declared and chunked bodies, HTML, SVG, URL text and mismatched raster bytes', async t => {
  const origin = await listen(t, (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/declared') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': maxImageBytes + 1 }).end(jpeg);
      return;
    }
    if (path === '/chunked') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' });
      res.write(png);
      res.end(Buffer.alloc(maxImageBytes));
      return;
    }
    const bodies = {
      '/svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      '/url': ['text/plain', 'https://example.invalid/cover.jpg'],
      '/html': ['text/html', '<html>private-provider-error</html>'],
      '/mismatch': ['image/png', jpeg],
      '/invalid': ['image/jpeg', 'private-provider-error'],
      '/untyped': ['application/octet-stream', png],
    };
    const [contentType, body] = bodies[path];
    res.writeHead(200, { 'Content-Type': contentType }).end(body);
  });
  for (const path of ['/declared', '/chunked', '/svg', '/url', '/html', '/mismatch', '/invalid', '/untyped']) {
    await assert.rejects(queryMetadataCover(config(origin, path), artistLookup), errorIs(502, 'metadata_unavailable'));
  }
});

test('handles cancellation during a raster body and times out a stalled upstream connection', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const origin = await listen(t, (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path !== '/abort') return;
    res.once('close', disconnected.resolve);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.write(png.subarray(0, 12));
    entered.resolve();
  });
  const caller = new AbortController();
  const lookup = queryMetadataCover(config(origin, '/abort'), artistLookup, { signal: caller.signal });
  const canceled = assert.rejects(lookup, { name: 'AbortError', message: 'The cover request was canceled.' });
  await entered.promise;
  caller.abort(new Error('private-provider-error with cover-fixture-secret'));
  await canceled;
  await disconnected.promise;
  await assert.rejects(queryMetadataCover(config(origin, '/timeout'), artistLookup, { timeoutMs: 100 }),
    errorIs(504, 'metadata_timeout'));
});
