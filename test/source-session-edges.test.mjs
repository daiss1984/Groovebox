import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSourcesHandler } from '../server/sources.mjs';
import { createSmbSource } from '../server/smb.mjs';

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}
async function app(t, directory, key, onRequest = () => {}) {
  const handle = createSourcesHandler({ sessionDirectory: directory, sessionKey: key });
  return listen(t, async (req, res) => {
    onRequest(req);
    if (!await handle(req, res, new URL(req.url, 'http://app'))) res.writeHead(404).end();
  });
}
async function connect(url, input) {
  const response = await fetch(url + '/api/sources', { method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  return { response, cookie: response.headers.get('set-cookie')?.split(';', 1)[0], body: await response.json() };
}
const row = path => '<d:response><d:href>' + path + '</d:href><d:propstat><d:prop>' +
  '<d:displayname>Recording.mp3</d:displayname><d:resourcetype/><d:getcontenttype>audio/mpeg</d:getcontenttype>' +
  '<d:getcontentlength>6</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';

test('restores a legal deep Unicode WebDAV base without truncating its escaped URL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-source-deep-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const path = '/' + Array.from({ length: 28 }, () => '汉'.repeat(20)).join('/') + '/';
  let calls = 0;
  const upstream = await listen(t, (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('fixture:private').toString('base64'));
    if (req.method === 'PROPFIND') {
      req.resume();
      return res.writeHead(207, { 'Content-Type': 'application/xml' }).end(
        '<d:multistatus xmlns:d="DAV:">' + row(new URL(path + 'recording.mp3', upstream.url).pathname) + '</d:multistatus>');
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(Buffer.from([1, 2, 3, 4, 5, 6]));
  });
  const original = await app(t, directory, key);
  const input = { type: 'webdav', name: 'Deep Unicode', url: upstream.url + path, username: 'fixture', password: 'private' };
  assert.ok(input.url.length < 4096);
  assert.ok(new URL(input.url).href.length > 4096);
  const connected = await connect(original.url, input);
  assert.equal(connected.response.status, 201);
  const id = connected.body.source.id;
  const listing = await (await fetch(original.url + '/api/sources/' + id + '/list', { headers: { Cookie: connected.cookie } })).json();
  const stream = listing.items[0].streamUrl;
  const restored = await app(t, directory, key);
  const registry = await fetch(restored.url + '/api/sources', { headers: { Cookie: connected.cookie } });
  assert.equal(registry.status, 200);
  assert.deepEqual((await registry.json()).sources.map(source => source.id), [id]);
  const bytes = await fetch(restored.url + stream, { headers: { Cookie: connected.cookie } });
  assert.equal(bytes.status, 200);
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), Buffer.from([1, 2, 3, 4, 5, 6]));
  const before = calls;
  const rejected = await connect(restored.url, { ...input, url: upstream.url + path.repeat(3) });
  assert.equal(rejected.response.status, 400);
  assert.equal(calls, before);
});

test('reconstructs the same deep SMB base from its escaped durable URL without a network operation', () => {
  const url = 'smb://localhost/share/' + Array.from({ length: 28 }, () => '汉'.repeat(20)).join('/');
  const config = { username: 'fixture', password: 'private' };
  const source = createSmbSource({ ...config, url });
  assert.ok(source.base.href.length > 4096);
  const restored = createSmbSource({ ...config, url: source.base.href });
  assert.equal(restored.base.href, source.base.href);
});

test('a playlist form completed after disconnect does not create an Emby playlist', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-source-cancel-form-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let creations = 0;
  const upstream = await listen(t, (req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('AuthenticateByName')) return res.end(JSON.stringify({ AccessToken: 'fixture-token', User: { Id: 'fixture-user' } }));
    if (req.method === 'POST' && new URL(req.url, 'http://emby').pathname.endsWith('/Playlists')) {
      creations++;
      return res.end(JSON.stringify({ Id: 'unexpected-created' }));
    }
    res.end(JSON.stringify({ Items: [] }));
  });
  let started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  const current = await app(t, directory, randomBytes(32), req => {
    if (req.method === 'POST' && req.url.includes('/playlist?')) req.once('data', () => setTimeout(started, 20));
  });
  const connected = await connect(current.url, { type: 'emby', name: 'Fixture Emby', url: upstream.url,
    username: 'fixture', password: 'private' });
  assert.equal(connected.response.status, 201);
  const id = connected.body.source.id;
  const pending = request(current.url + '/api/sources/' + id + '/playlist?path=playlists', { method: 'POST',
    headers: { Origin: current.url, Cookie: connected.cookie, 'Content-Type': 'application/json' } });
  const response = new Promise((resolve, reject) => { pending.once('response', resolve); pending.once('error', reject); });
  pending.write('{"action":"create",');
  await bodyStarted;
  const disconnected = await fetch(current.url + '/api/sources/' + id, { method: 'DELETE', headers: { Cookie: connected.cookie, Origin: current.url } });
  assert.equal(disconnected.status, 200);
  await disconnected.arrayBuffer();
  pending.end('"name":"Cancelled form"}');
  const result = await response;
  result.resume();
  assert.equal(creations, 0);
  assert.equal(result.statusCode, 404);
});
