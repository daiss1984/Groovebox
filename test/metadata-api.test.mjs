import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, get, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeLocalSettings } from '../server/local-settings.mjs';
import { createMetadataHandler } from '../server/metadata-api.mjs';

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
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-metadata-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function app(t, options) {
  const handle = createMetadataHandler(options);
  const { origin, close } = await serve(t, async (req, res) => {
    if (!await handle(req, res, new URL(req.url, 'http://localhost'))) res.writeHead(404).end();
  });
  const request = (route, { method = 'GET', body, headers, signal } = {}) => fetch(origin + '/api/metadata/' + route, {
    method, headers: { ...(method !== 'GET' && { Origin: origin, 'Content-Type': 'application/json' }), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined, signal,
  });
  const put = (adapter, url, headersAction = 'keep', headers) =>
    request('config', { method: 'PUT', body: { lyrics: { adapter, url, headersAction, headers } } });
  const lookup = (body, extra) => request('lyrics', { method: 'POST', body, ...extra });
  return { origin, close, request, put, lookup };
}

const song = { title: 'Song & Name', artist: '艺人', album: 'Album + Name', duration: 99.64 };
const lrc = '[00:06.00] First line\n[00:08.20] Second line';
const reply = (res, status, type, body) => res.writeHead(status, { 'Content-Type': type }).end(body);
const lrcReply = res => reply(res, 200, 'text/plain; charset=utf-8', lrc);
const jsonReply = res => reply(res, 200, 'application/json', JSON.stringify({
  instrumental: false, plainLyrics: 'Untimed', syncedLyrics: lrc, ignored: 'private upstream fields',
}));

test('configures a persisted LRCLIB endpoint and sends only matching fields and configured upstream headers', async t => {
  const requests = [];
  const upstream = await serve(t, (req, res) => {
    requests.push({ url: new URL(req.url, 'http://localhost'), headers: req.headers, method: req.method });
    jsonReply(res);
  });
  const dataDir = await settingsDirectory(t);
  const initial = await app(t, { dataDir });
  const url = upstream.origin + '/custom/exact-lrclib';
  const secret = 'fixture-only-secret';
  assert.deepEqual(await (await initial.request('status')).json(), { configured: false, lyrics: { adapter: 'none', revision: 'none' } });
  assert.equal((await initial.lookup(song)).status, 404);
  const saved = await initial.put('lrclib', url, 'replace', 'Authorization=Bearer ' + secret + '&Lrclib-Api-Key=fixture-lrclib-key&X-Signature=value=kept');
  assert.equal(saved.status, 200);
  const status = await saved.json();
  assert.deepEqual(Object.keys(status.lyrics).sort(), ['adapter', 'revision']);
  assert.match(status.lyrics.revision, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await (await initial.request('config')).json(), { lyrics: { adapter: 'lrclib', url, hasHeaders: true } });
  assert.equal(requests.length, 0);
  assert.deepEqual(await (await initial.put('lrclib', url)).json(), status);
  const expanded = upstream.origin + '/' + '歌'.repeat(400);
  assert.ok(expanded.length < 2000 && new URL(expanded).href.length > 2000);
  const rejected = await initial.put('lrclib', expanded);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, 'metadata_invalid_config');
  assert.deepEqual(await (await initial.request('status')).json(), status);

  const matched = await initial.lookup(song, { headers: { Cookie: 'local-cookie=ignored', Authorization: 'browser-token', 'X-Source-Token': 'also ignored' } });
  assert.deepEqual(await matched.json(), {
    adapter: 'lrclib', revision: status.lyrics.revision, instrumental: false, syncedLyrics: lrc, plainLyrics: 'Untimed',
  });
  const [sent] = requests;
  assert.equal(sent.url.pathname, '/custom/exact-lrclib');
  assert.equal(sent.method, 'GET');
  assert.deepEqual(Object.fromEntries(sent.url.searchParams), {
    track_name: song.title, artist_name: song.artist, album_name: song.album, duration: '100',
  });
  assert.equal(sent.headers.accept, 'application/json');
  assert.equal(sent.headers.authorization, 'Bearer ' + secret);
  assert.equal(sent.headers['lrclib-api-key'], 'fixture-lrclib-key');
  assert.equal(sent.headers['x-signature'], 'value=kept');
  assert.equal(sent.headers.cookie, undefined);
  assert.equal(sent.headers['x-source-token'], undefined);
  assert.equal(sent.headers.origin, undefined);

  const file = join(dataDir, 'metadata-settings.bin');
  const bytes = await readFile(file);
  for (const privateValue of [secret, 'fixture-lrclib-key', url, 'Authorization']) assert.equal(bytes.includes(privateValue), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await initial.close();
  const reopened = await app(t, { dataDir });
  assert.deepEqual(await (await reopened.request('status')).json(), status);
  assert.equal((await reopened.lookup(song)).status, 200);
  assert.equal(requests.at(-1).headers.authorization, 'Bearer ' + secret);
});

test('calls HisAtri on the saved path and clears kept credentials when the target origin changes', async t => {
  const sent = [];
  const upstream = () => serve(t, (req, res) => {
    sent.push({ url: new URL(req.url, 'http://localhost'), headers: req.headers });
    lrcReply(res);
  });
  const [first, second] = await Promise.all([upstream(), upstream()]);
  const player = await app(t, { dataDir: await settingsDirectory(t) });
  const one = await (await player.put('hisatri', first.origin + '/lyrics', 'replace', 'Authentication=fixture-private-1')).json();
  assert.equal((await player.lookup(song)).status, 200);
  assert.equal(sent[0].headers.authentication, 'fixture-private-1');
  assert.equal((await player.put('hisatri', first.origin + '/other-path')).status, 200);
  assert.equal((await player.lookup(song)).status, 200);
  assert.equal(sent[1].headers.authentication, 'fixture-private-1');
  assert.equal(sent[1].url.pathname, '/other-path');
  const two = await (await player.put('hisatri', second.origin + '/exact')).json();
  assert.notEqual(one.lyrics.revision, two.lyrics.revision);
  assert.equal((await (await player.request('config')).json()).lyrics.hasHeaders, false);
  assert.deepEqual(await (await player.lookup(song)).json(), {
    adapter: 'hisatri', revision: two.lyrics.revision, instrumental: false, syncedLyrics: lrc, plainLyrics: null,
  });
  assert.equal(sent[2].headers.authentication, undefined);
  assert.equal(sent[2].headers.accept, 'application/json');
  assert.equal(sent[2].url.pathname, '/exact');
  assert.deepEqual(Object.fromEntries(sent[2].url.searchParams), { title: song.title, artist: song.artist, album: song.album });
  await player.put('hisatri', second.origin + '/exact', 'replace', 'Authorization=Bearer fixture-private-2');
  await player.put('hisatri', second.origin + '/exact', 'remove');
  await player.lookup({ title: 'Solo' });
  assert.equal(sent.at(-1).headers.authorization, undefined);
  assert.deepEqual(Object.fromEntries(sent.at(-1).url.searchParams), { title: 'Solo' });
  const off = await (await player.put('none', second.origin + '/exact')).json();
  const miss = await player.lookup(song);
  assert.equal(off.lyrics.adapter, 'none');
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).code, 'metadata_not_configured');
  assert.equal(sent.length, 4);
});

test('rejects off-origin configuration and lookup inputs outside the fixed protocol', async t => {
  const player = await app(t, { dataDir: await settingsDirectory(t) });
  const valid = { lyrics: { adapter: 'hisatri', url: 'http://127.0.0.1:1/exact', headersAction: 'remove' } };
  assert.equal((await player.request('config', { headers: { 'X-Forwarded-For': '192.0.2.2' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    get(player.origin + '/api/metadata/config', { headers: { Host: 'media.invalid' } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await player.request('config', { method: 'PUT', body: valid, headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await player.request('config', { method: 'PUT', body: valid, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await player.request('config', { method: 'PUT', body: valid, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await player.request('config', { method: 'PUT', body: { text: 'a'.repeat(13_000) } })).status, 413);
  for (const target of ['ftp://example.com/a', 'http://user:pass@example.com/a', 'http://example.com/a?key=value',
    'http://example.com/a#x', 'http://example.com/a?', 'http:///example.com/a']) {
    const res = await player.put('hisatri', target);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'metadata_invalid_config');
  }
  for (const headers of ['Cookie=a', 'X-Forwarded-For=example', 'X-Original-URL=/other', 'Authorization=a&authorization=b',
    'Authentication=abc\r\nInjected: true', '\r\nAuthentication=invalid', 'Authorization', 'Authorization=']) {
    assert.equal((await player.put('hisatri', valid.lyrics.url, 'replace', headers)).status, 400);
  }
  assert.equal((await player.put('hisatri', valid.lyrics.url)).status, 200);
  assert.equal((await player.lookup(song, { headers: { Origin: 'https://other.invalid' } })).status, 403);
  for (const body of [{}, { ...song, url: 'http://private.invalid' }, { ...song, duration: '100' }, { ...song, album: 'a'.repeat(201) }]) {
    const res = await player.lookup(body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'metadata_invalid_lookup');
  }
});

test('accepts same-host HTTPS browser origins on a plain HTTP proxy hop only for lookups', async t => {
  let upstreamCalls = 0;
  const upstream = await serve(t, (req, res) => { upstreamCalls += 1; lrcReply(res); });
  const player = await app(t, { dataDir: await settingsDirectory(t) });
  assert.equal((await player.put('hisatri', upstream.origin + '/lyrics')).status, 200);
  const proxyHop = (route, host, origin, site = 'same-origin') => new Promise((resolve, reject) => {
    const req = request(player.origin + '/api/metadata/' + route, {
      method: route === 'lyrics' ? 'POST' : 'PUT',
      headers: { Host: host, Origin: origin, 'Sec-Fetch-Site': site, 'Content-Type': 'application/json' },
    }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(JSON.stringify(song));
  });
  const publicHost = 'music.example.test:7443';
  const matched = await proxyHop('lyrics', publicHost, 'https://' + publicHost);
  assert.equal(matched.status, 200);
  assert.equal(matched.body.syncedLyrics, lrc);
  for (const [origin, site] of [
    ['https://other.example.test:7443', 'same-origin'],
    ['https://music.example.test:8443', 'same-origin'],
    ['https://' + publicHost, 'cross-site'],
    ['https://' + publicHost + '/not-an-origin', 'same-origin'],
  ]) {
    const denied = await proxyHop('lyrics', publicHost, origin, site);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'metadata_origin_required');
  }
  const publicConfig = await proxyHop('config', publicHost, 'https://' + publicHost);
  assert.equal(publicConfig.status, 403);
  assert.equal(publicConfig.body.code, 'metadata_local_config_only');
  const localHost = new URL(player.origin).host;
  const localConfig = await proxyHop('config', localHost, 'https://' + localHost);
  assert.equal(localConfig.status, 403);
  assert.equal(localConfig.body.code, 'metadata_origin_required');
  assert.equal(upstreamCalls, 1);
});

test('rejects a stale caller revision before sending song details to the replacement endpoint', async t => {
  const paths = [];
  const upstream = await serve(t, (req, res) => {
    paths.push(new URL(req.url, 'http://localhost').pathname);
    assert.equal(req.headers['x-metadata-revision'], undefined);
    lrcReply(res);
  });
  const player = await app(t, { dataDir: await settingsDirectory(t) });
  const original = await (await player.put('hisatri', upstream.origin + '/old')).json();
  const replacement = await (await player.put('hisatri', upstream.origin + '/new')).json();
  assert.notEqual(original.lyrics.revision, replacement.lyrics.revision);
  const headers = revision => ({ 'X-Metadata-Revision': revision });
  const stale = await player.lookup(song, { headers: headers(original.lyrics.revision) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'metadata_config_changed');
  assert.deepEqual(paths, []);
  const current = await player.lookup(song, { headers: headers(replacement.lyrics.revision) });
  assert.equal(current.status, 200);
  assert.equal((await current.json()).revision, replacement.lyrics.revision);
  assert.equal((await player.lookup(song)).status, 200);
  await player.put('none', '');
  assert.equal((await player.lookup(song, { headers: headers(replacement.lyrics.revision) })).status, 409);
  assert.deepEqual(paths, ['/new', '/new']);
});

test('does not report corrupt or invalid saved settings as disabled and supports explicit repair', async t => {
  let upstreamCalls = 0;
  const upstream = await serve(t, (req, res) => { upstreamCalls += 1; lrcReply(res); });
  const dataDir = await settingsDirectory(t);
  const settingsFile = join(dataDir, 'metadata-settings.bin');
  const original = await app(t, { dataDir });
  const saved = await (await original.put('hisatri', upstream.origin + '/lyrics')).json();
  await original.close();
  const encrypted = await readFile(settingsFile);
  encrypted[encrypted.length - 1] ^= 1;
  await writeFile(settingsFile, encrypted);

  const checkUnavailable = async player => {
    for (const response of [await player.request('status'), await player.lookup(song)]) {
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'metadata_config_unavailable');
    }
    assert.deepEqual(await (await player.request('config')).json(), {
      configurationError: true, lyrics: { adapter: 'none', url: '', hasHeaders: false },
    });
    assert.equal(upstreamCalls, 0);
  };
  const corrupted = await app(t, { dataDir });
  await checkUnavailable(corrupted);
  const repaired = await (await corrupted.put('none', '')).json();
  assert.equal(repaired.configured, false);
  assert.notEqual(repaired.lyrics.revision, 'none');
  assert.notEqual(repaired.lyrics.revision, saved.lyrics.revision);
  await corrupted.close();

  const disabled = await app(t, { dataDir });
  assert.deepEqual(await (await disabled.request('status')).json(), repaired);
  assert.equal((await disabled.lookup(song)).status, 404);
  await disabled.close();

  writeLocalSettings(settingsFile, { adapter: 'hisatri', revision: saved.lyrics.revision, headers: [] });
  const invalid = await app(t, { dataDir });
  await checkUnavailable(invalid);
  assert.equal((await invalid.put('hisatri', upstream.origin + '/lyrics')).status, 200);
  assert.equal((await invalid.lookup(song)).status, 200);
  assert.equal(upstreamCalls, 1);
});

test('sanitizes misses, provider failures and rate limits, bounds streamed bytes and never follows redirects', async t => {
  let redirectCalls = 0;
  const redirect = await serve(t, (req, res) => { redirectCalls += 1; lrcReply(res); });
  const upstream = await serve(t, (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/miss') return reply(res, 404, 'text/plain', 'private error text');
    if (pathname === '/rate-limit') return res.writeHead(429, { 'Retry-After': '999999' }).end('private error text');
    if (pathname === '/redirect') return res.writeHead(302, { Location: redirect.origin }).end();
    if (pathname === '/html') return reply(res, 200, 'text/html', '<html>[00:02.00] wrong format</html>');
    if (pathname === '/large') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('[00:02.00] start\n');
      return res.end('x'.repeat(300_000));
    }
    return reply(res, 200, 'text/plain', 'not a lyrics result');
  });
  const player = await app(t, { dataDir: await settingsDirectory(t) });
  for (const [path, status, code] of [
    ['/miss', 404, 'metadata_not_found'], ['/rate-limit', 429, 'metadata_rate_limited'], ['/redirect', 502, 'metadata_unavailable'],
    ['/html', 502, 'metadata_unavailable'], ['/large', 502, 'metadata_unavailable'], ['/invalid', 502, 'metadata_unavailable'],
  ]) {
    assert.equal((await player.put('hisatri', upstream.origin + path, 'replace', 'Authorization=Bearer fixture-secret')).status, 200);
    const response = await player.lookup(song);
    assert.equal(response.status, status, path);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal(JSON.stringify(body).includes('private error text'), false);
    assert.equal(JSON.stringify(body).includes(upstream.origin), false);
    if (status === 429) {
      assert.equal(response.headers.get('retry-after'), '3600');
      assert.equal(body.retryAfter, 3600);
    }
  }
  assert.equal(redirectCalls, 0);
});

test('aborts real upstream requests on client disconnect, settings revision change and deadline', { timeout: 6000 }, async t => {
  const arrived = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
  const closed = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
  let index = 0;
  const upstream = await serve(t, (req, res) => {
    const attempt = index++;
    res.once('close', () => closed[attempt].resolve());
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('[00:04.00] Partial line\n');
    arrived[attempt].resolve();
  });
  const player = await app(t, { dataDir: await settingsDirectory(t), timeoutMs: 1200 });
  assert.equal((await player.put('hisatri', upstream.origin + '/lyrics')).status, 200);
  const controller = new AbortController();
  const pendingClient = player.lookup(song, { signal: controller.signal });
  await arrived[0].promise;
  controller.abort();
  await assert.rejects(pendingClient, { name: 'AbortError' });
  await closed[0].promise;

  const pendingRevision = player.lookup(song);
  await arrived[1].promise;
  const updated = await player.put('hisatri', upstream.origin + '/new-path');
  assert.equal(updated.status, 200);
  const stale = await pendingRevision;
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'metadata_config_changed');
  await closed[1].promise;

  const pendingDeadline = player.lookup(song);
  await arrived[2].promise;
  const late = await pendingDeadline;
  assert.equal(late.status, 504);
  assert.equal((await late.json()).code, 'metadata_timeout');
  await closed[2].promise;
});
