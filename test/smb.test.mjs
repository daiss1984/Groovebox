import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSmbSource, SmbError } from '../server/smb.mjs';
import { createSourcesHandler } from '../server/sources.mjs';
import { dsdFixture } from './helpers/dsd-fixture.mjs';
import { launchSmb2 } from './helpers/smb-fixture.mjs';

const fixturePython = process.env.SMB_TEST_PYTHON;

test('SMB validates private source addresses and handles a missing connector dependency', async () => {
  for (const url of [
    'https://nas/music', 'smb://nas/', 'smb://usr:secret@nas/share', 'smb://nas/share/../else',
    'smb://nas/share/%2e%2e/else', 'smb://nas/share/%2Felse', 'smb://nas/share/%5Celse',
    'smb://nas/share?password=x', 'smb://nas/share#playlist', 'smb://nas/share//folder',
  ]) {
    assert.throws(() => createSmbSource({ url, username: 'name', password: 'secret' }),
      error => error instanceof SmbError && error.status === 400, url);
  }
  const fixture = createSmbSource({
    url: 'smb://NAS:445/MUSIC/%E9%9F%B3%E4%B9%90', username: 'name', password: 'secret',
  }, { env: { SMB_PYTHON: '/groovebox-missing-smb-fixture' } });
  assert.equal(fixture.base.href, 'smb://nas/MUSIC/%E9%9F%B3%E4%B9%90/');
  await assert.rejects(fixture.list(null), error => error instanceof SmbError && error.status === 503);
});

test('SMB2 fixture uses real authentication, directory covers, lyrics and byte streaming', {
  skip: !fixturePython && 'Set SMB_TEST_PYTHON to a venv with smbprotocol and impacket to run the SMB2 fixture',
  timeout: 30_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'groovebox-smb-test-'));
  t.after(() => rm(root, { recursive: true }));
  const folder = join(root, '音乐');
  const song = '雨夜.wav';
  const lyrics = '雨夜.lrc';
  const sound = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const dsdSamples = ['dsf', 'dff'].map(format => ({
    name: '合成录音.' + format.toUpperCase(), type: 'audio/x-' + format, bytes: dsdFixture(format, { seconds: 0.3 }),
  }));
  const expectedNames = [lyrics, song, ...dsdSamples.map(sample => sample.name)].sort();
  const lyricText = '[00:01.00]第一行';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=', 'base64');
  const jpg = await readFile(new URL('../public/assets/cover-2.jpg', import.meta.url));
  const coverPng = join(folder, 'cover.PNG');
  const coverJpg = join(folder, 'COVER.JpG');
  await mkdir(folder);
  await Promise.all([
    writeFile(join(folder, song), sound),
    writeFile(join(folder, lyrics), Buffer.concat([Buffer.from([255, 254]), Buffer.from(lyricText, 'utf16le')])),
    writeFile(join(folder, '非音频.txt'), 'ignore this document'),
    writeFile(coverPng, '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    writeFile(coverJpg, jpg),
    ...dsdSamples.map(sample => writeFile(join(folder, sample.name), sample.bytes)),
  ]);
  const remote = launchSmb2(fixturePython, root);
  t.after(() => remote.stop());
  const input = await remote.input;
  const env = { SMB_PYTHON: fixturePython };
  const source = createSmbSource(input, { env });
  const dirs = await source.list(null);
  assert.deepEqual(dirs.map(({ name, folder }) => ({ name, folder })), [{ name: '音乐', folder: true }]);
  assert.deepEqual(await source.listArtistPortraits(), []);
  const list = await source.list(dirs[0].location);
  assert.deepEqual(list.map(entry => entry.name).sort(), expectedNames);
  const scoped = createSmbSource({ ...input, url: input.url + '/%E9%9F%B3%E4%B9%90' }, { env });
  assert.deepEqual((await scoped.list(null)).map(entry => entry.name).sort(), expectedNames);
  const wrong = createSmbSource({ ...input, password: 'wrong' }, { env });
  await assert.rejects(wrong.list(null), error => error instanceof SmbError && error.status === 403);

  const previousPython = process.env.SMB_PYTHON;
  process.env.SMB_PYTHON = fixturePython;
  t.after(() => {
    if (previousPython === undefined) delete process.env.SMB_PYTHON;
    else process.env.SMB_PYTHON = previousPython;
  });
  const handler = createSourcesHandler();
  const server = createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://127.0.0.1'))) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const link = 'http://127.0.0.1:' + server.address().port;
  const connected = await fetch(link + '/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'smb', ...input }),
  });
  assert.equal(connected.status, 201);
  const Cookie = connected.headers.get('set-cookie').split(';')[0];
  const { source: publicSource } = await connected.json();
  assert.deepEqual(Object.keys(publicSource).sort(), ['id', 'name', 'type']);
  const endpoint = link + '/api/sources/' + publicSource.id;
  const { items: folders } = await (await fetch(endpoint + '/list', { headers: { Cookie } })).json();
  assert.equal(folders[0].name, '音乐');
  const query = '?path=' + encodeURIComponent(folders[0].path);
  const listFiles = async () => (await (await fetch(endpoint + '/list' + query, { headers: { Cookie } })).json()).items;
  const files = await listFiles();
  assert.deepEqual(files.map(entry => entry.name).sort(), expectedNames);
  const track = files.find(file => file.name === song);
  const resource = link + track.streamUrl;
  const cover = link + track.folderCover;
  assert.match(track.folderCover, new RegExp('^/api/sources/' + publicSource.id + '/cover\\?id=[\\w-]+$'));
  assert.ok(files.filter(file => file.name !== lyrics).every(file => file.folderCover === track.folderCover));
  assert.equal(files.find(file => file.name === lyrics).folderCover, undefined);
  assert.equal(folders[0].folderCover, undefined);
  for (const headers of [{}, { Cookie: Cookie + '-other' }]) {
    assert.equal((await fetch(cover, { headers })).status, 404);
  }
  assert.equal((await fetch(cover.replace('/cover?', '/stream?'), { headers: { Cookie } })).status, 404);
  const fallback = await fetch(cover, { headers: { Cookie, Range: 'bytes=0-5' } });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get('content-type'), 'image/jpeg');
  assert.equal(fallback.headers.get('cache-control'), 'private, no-store');
  assert.equal(fallback.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(fallback.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), jpg);
  await writeFile(coverPng, png);
  const replacement = link + (await listFiles()).find(file => file.name === song).folderCover;
  assert.notEqual(replacement, cover);
  const updated = await fetch(replacement, { headers: { Cookie } });
  assert.equal(updated.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await updated.arrayBuffer()), png);
  const coverHead = await fetch(replacement, { method: 'HEAD', headers: { Cookie } });
  assert.equal(coverHead.status, 200);
  assert.equal(coverHead.headers.get('content-length'), String(png.length));
  assert.equal(await coverHead.text(), '');
  await truncate(coverPng, 8 * 1024 * 1024 + 1);
  await rm(coverJpg);
  assert.equal((await fetch(replacement, { headers: { Cookie } })).status, 404);
  assert.equal((await listFiles()).find(file => file.name === song).folderCover, undefined);
  assert.equal((await fetch(resource)).status, 404);
  const response = await fetch(resource, { headers: { Cookie, Range: 'bytes=10-13' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('content-range'), 'bytes 10-13/36');
  assert.equal(await response.text(), 'abcd');
  const suffix = await fetch(resource, { headers: { Cookie, Range: 'bytes=-2' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), 'yz');
  const head = await fetch(resource, { method: 'HEAD', headers: { Cookie, Range: 'bytes=33-' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '3');
  assert.equal(await head.text(), '');
  const missing = await fetch(resource, { headers: { Cookie, Range: 'bytes=999-' } });
  assert.equal(missing.status, 416);
  assert.equal(missing.headers.get('content-range'), 'bytes */36');
  const text = await fetch(link + files.find(file => file.name === lyrics).streamUrl, { headers: { Cookie } });
  assert.equal(text.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await text.text(), lyricText);
  for (const sample of dsdSamples) {
    const track = files.find(file => file.name === sample.name);
    const response = await fetch(link + track.streamUrl, { headers: { Cookie, Range: 'bytes=0-127' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), sample.type);
    assert.equal(response.headers.get('content-range'), 'bytes 0-127/' + sample.bytes.length);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), sample.bytes.subarray(0, 128));
  }
  assert.equal((await fetch(endpoint, { method: 'DELETE', headers: { Cookie } })).status, 200);
  assert.equal((await fetch(resource, { headers: { Cookie } })).status, 404);
});
