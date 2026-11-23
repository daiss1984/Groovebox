import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildPlaylistArchive } from '../public/playlist-download.js';

const exec = promisify(execFile);
const file = (name, bytes = 'a') => ({ name, blob: new Blob([bytes]) });

test('standard ZIP tools verify checksums, extract UTF-8 names and preserve original bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-zip-test-'));
  try {
    const archivePath = join(directory, 'playlist.zip');
    const output = join(directory, 'extracted');
    await mkdir(output);
    const binary = Buffer.from([0, 1, 127, 128, 255, 16, 4, 0]);
    const original = new Uint8Array(180_000).map((_, i) => i % 251);
    const sources = [
      file('夜曲 🎶.flac', binary), file('夜曲 🎶.FLAC', original),
      file('夜曲 🎶 (2).FLAC', 'explicit alias'), file('../../别处.mp3', 'safe path'),
      file('CON .m4a', 'safe device name'), file('空曲目.wav', ''),
    ];
    const progress = [];
    const archive = await buildPlaylistArchive(sources, { onProgress: value => progress.push(value) });
    assert.equal(archive.type, 'application/zip');
    assert.deepEqual(progress.map(entry => entry.name), [
      '夜曲 🎶.flac', '夜曲 🎶 (2).FLAC', '夜曲 🎶 (2) (2).FLAC', '_.._别处.mp3', '_CON .m4a', '空曲目.wav',
    ]);
    assert.deepEqual(progress.map(entry => entry.processed), [1, 2, 3, 4, 5, 6]);
    assert.ok(progress.every(entry => entry.total === sources.length));
    assert.equal(progress.at(-1).bytes, sources.reduce((total, source) => total + source.blob.size, 0));

    await writeFile(archivePath, Buffer.from(await archive.arrayBuffer()));
    try {
      await exec('unzip', ['-t', archivePath]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return t.skip('System unzip is unavailable');
    }
    if (process.platform === 'darwin') {
      // Apple's bundled Info-ZIP converts filenames to a legacy code page.
      await exec('/usr/bin/ditto', ['-x', '-k', archivePath, output]);
    } else {
      await exec('unzip', ['-q', archivePath, '-d', output]);
    }
    const extracted = await readdir(output);
    assert.deepEqual(extracted.sort(), progress.map(entry => entry.name).sort());
    for (const [index, source] of sources.entries()) {
      assert.deepEqual(await readFile(join(output, progress[index].name)), Buffer.from(await source.blob.arrayBuffer()));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('writes uncompressed UTF-8 ZIP records, CRC32, accurate local offsets and directory size', async () => {
  const archive = await buildPlaylistArchive([file('甲.mp3', '123456789'), file('乙.flac', 'second')]);
  const bytes = Buffer.from(await archive.arrayBuffer());
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 10), 2);
  let central = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt32LE(end + 12), end - central);
  for (const [name, value] of [['甲.mp3', '123456789'], ['乙.flac', 'second']]) {
    const length = Buffer.byteLength(name);
    assert.equal(bytes.readUInt32LE(central), 0x02014b50);
    assert.equal(bytes.readUInt16LE(central + 8), 0x0800);
    assert.equal(bytes.readUInt16LE(central + 10), 0);
    assert.equal(bytes.readUInt16LE(central + 28), length);
    assert.equal(bytes.toString('utf8', central + 46, central + 46 + length), name);
    const local = bytes.readUInt32LE(central + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 6), 0x0800);
    assert.equal(bytes.readUInt16LE(local + 8), 0);
    assert.equal(bytes.readUInt32LE(local + 14), bytes.readUInt32LE(central + 16));
    assert.equal(bytes.readUInt32LE(local + 22), value.length);
    assert.equal(bytes.toString('utf8', local + 30 + length, local + 30 + length + value.length), value);
    if (name === '甲.mp3') assert.equal(bytes.readUInt32LE(local + 14), 0xcbf43926);
    central += 46 + length;
  }
  assert.equal(central, end);
});

test('accepts async iterables and retains extensions when shortening Unicode filenames', async () => {
  const names = [];
  const long = '音乐🎸'.repeat(110);
  async function* source() {
    yield file(long + '.flac');
    yield file(long + '.flac');
    yield file('Cafe\u0301.mp3');
    yield file('Café.mp3');
    yield file('line\ud800.wav');
  }
  await buildPlaylistArchive(source(), { onProgress: entry => {
    assert.equal(entry.total, null);
    names.push(entry.name);
  } });
  assert.match(names[0], /\.flac$/);
  assert.match(names[1], / \(2\)\.flac$/);
  assert.ok(names.every(name => Buffer.byteLength(name) <= 240 && !name.includes('\ufffd')));
  assert.deepEqual(names.slice(2), ['Café.mp3', 'Café (2).mp3', 'line_.wav']);
});

test('rejects oversized requests before reading a Blob and supports early and in-flight cancellation', async () => {
  class OversizedBlob extends Blob {
    get size() { return 0xffffffff; }
    stream() { throw new Error('must not read oversized Blob'); }
  }
  await assert.rejects(buildPlaylistArchive([{ name: 'large.flac', blob: new OversizedBlob() }]), RangeError);
  await assert.rejects(buildPlaylistArchive(Array(65_536)), RangeError);
  await assert.rejects(buildPlaylistArchive([{ name: 'bad.flac', blob: 'audio' }]), TypeError);
  const early = new AbortController();
  early.abort();
  await assert.rejects(buildPlaylistArchive([file('never-read.flac')], { signal: early.signal }), { name: 'AbortError' });

  const during = new AbortController();
  let cancelled = false;
  class WaitingBlob extends Blob {
    stream() {
      return new ReadableStream({
        pull() { queueMicrotask(() => during.abort()); },
        cancel() { cancelled = true; },
      });
    }
  }
  await assert.rejects(buildPlaylistArchive([{ name: 'reading.flac', blob: new WaitingBlob(['test']) }], {
    signal: during.signal,
  }), { name: 'AbortError' });
  assert.equal(cancelled, true);
});
