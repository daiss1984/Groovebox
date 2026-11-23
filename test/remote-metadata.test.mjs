import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseBuffer, updateBuffer } from 'music-metadata';
import { replayGainTags } from '../public/library.js';

const workspace = new URL('../', import.meta.url);
const audio = new URL('public/assets/demo-1.m4a', workspace);
const image = new URL('public/assets/cover-1.jpg', workspace);
// A synthetic tone encoded by libopus, with -4 dB OpusHead output gain and conflicting comment families.
const opus = new URL('./fixtures/r128-mixed.opus', import.meta.url);
const trackUrl = '/api/baidu/stream?id=1234';
const pageSize = 64 * 1024;
let temp;
let inspectRemoteTrack;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'groovebox-range-probe-'));
  await Promise.all([
    ...['remote-metadata.js', 'library.js', 'track-sort.js', 'media-storage.js', 'karaoke-formats.js', 'genres.js', 'audio-encoding.js', 'stream-bitrate.js'].map(file =>
      copyFile(new URL('public/' + file, workspace), join(temp, file))),
    writeFile(join(temp, 'package.json'), '{"type":"module"}'),
    build({
      stdin: {
        contents: `
          export { parseBlob, parseFromTokenizer } from "music-metadata";
          export { AbstractTokenizer, EndOfStreamError } from "strtok3/core";
        `,
        resolveDir: fileURLToPath(workspace),
      },
      platform: 'browser',
      format: 'esm',
      bundle: true,
      outfile: join(temp, 'metadata.bundle.js'),
    }),
  ]);
  ({ inspectRemoteTrack } = await import(pathToFileURL(join(temp, 'remote-metadata.js'))));
});
after(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

function atoms(buffer, start = 0, end = buffer.length) {
  const result = [];
  while (start + 8 <= end) {
    const size = buffer.readUInt32BE(start);
    assert.ok(size >= 8 && start + size <= end);
    result.push({ type: buffer.toString('ascii', start + 4, start + 8), start, size, end: start + size });
    start += size;
  }
  return result;
}

function moveMoovAfterMedia(buffer) {
  const info = atoms(buffer).find(atom => atom.type === 'moov');
  assert.ok(info && info.end < buffer.length);
  const moov = Buffer.from(buffer.subarray(info.start, info.end));
  const knownContainers = new Set(['trak', 'mdia', 'minf', 'stbl']);
  let tables = 0;
  function adjustOffsets(start, end) {
    for (const atom of atoms(moov, start, end)) {
      if (knownContainers.has(atom.type)) adjustOffsets(atom.start + 8, atom.end);
      if (atom.type !== 'stco') continue;
      tables++;
      const count = moov.readUInt32BE(atom.start + 12);
      for (let i = 0; i < count; i++) {
        const field = atom.start + 16 + i * 4;
        moov.writeUInt32BE(moov.readUInt32BE(field) - moov.length, field);
      }
    }
  }
  adjustOffsets(8, moov.length);
  assert.ok(tables > 0);
  return Buffer.concat([buffer.subarray(0, info.start), buffer.subarray(info.end), moov]);
}

async function rangeOrigin(t, file, mime, { failAfter = Infinity } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    assert.equal(req.url, trackUrl);
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), file.length - 1);
    requests.push({ start, end, validator: req.headers['if-range'] });
    const body = file.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + file.length,
      'Content-Length': body.length,
      ETag: requests.length > failAfter ? '"wrong-entity"' : '"probe-audio"',
    });
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return {
    requests,
    fetchImpl: (path, options) => {
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.redirect, 'error');
      return fetch(origin + path, options);
    },
  };
}

test('reads cover art, lyrics, tags, and duration from a real M4A with moov at the tail', async t => {
  const picture = await readFile(image);
  const tags = {
    title: '海边测试', artist: '测试艺人', album: '测试专辑', albumartist: '测试专辑艺人',
    genre: ['Ambient'],
    picture: [{ type: 'Cover (front)', format: 'image/jpeg', data: picture }],
    lyrics: '[00:12.50]黑夜里',
    replaygain_track_gain: '+6 dB', replaygain_track_peak: '0.5',
    replaygain_album_gain: '-5 dB', replaygain_album_peak: '0.9',
  };
  const input = moveMoovAfterMedia(Buffer.from(await updateBuffer(await readFile(audio), tags)));
  assert.equal(atoms(input).at(-1).type, 'moov');
  const reference = await parseBuffer(input, 'audio/mp4');
  const { requests, fetchImpl } = await rangeOrigin(t, input, 'audio/mp4');
  const result = await inspectRemoteTrack(trackUrl, { name: 'wrong.m4a', fetchImpl });
  assert.equal(result.title, tags.title);
  assert.equal(result.artist, tags.artist);
  assert.equal(result.album, tags.album);
  assert.equal(result.albumArtist, tags.albumartist);
  assert.deepEqual(result.genres, ['Ambient']);
  assert.equal(result.replayGain, 6);
  assert.equal(result.replayGainPeak, .5);
  assert.equal(result.replayGainAlbum, -5);
  assert.equal(result.replayGainAlbumPeak, .9);
  assert.equal(result.duration, reference.format.duration);
  assert.equal(result.encoding.codec, 'MPEG-4/AAC');
  assert.equal(result.encoding.bitrate, reference.format.bitrate);
  assert.equal(result.encoding.sampleRate, reference.format.sampleRate);
  assert.equal(result.encoding.numberOfChannels, reference.format.numberOfChannels);
  assert.ok(result.duration > 150);
  assert.equal(result.cover.type, 'image/jpeg');
  assert.deepEqual(Buffer.from(await result.cover.arrayBuffer()), picture);
  assert.deepEqual(result.lyrics, [{ time: 12.5, text: '黑夜里' }]);
  const media = atoms(input).find(atom => atom.type === 'mdat');
  assert.ok(requests.some(range => range.start > media.end - pageSize));
  assert.ok(requests.length <= 4);
  assert.equal(new Set(requests.map(range => range.start)).size, requests.length);
  assert.ok(requests.reduce((total, range) => total + range.end - range.start + 1, 0) < input.length / 4);
  assert.equal(requests[0].validator, undefined);
  assert.ok(requests.slice(1).every(range => range.validator === '"probe-audio"'));
});

test('reads exact native Opus R128 and classic ReplayGain independently over HTTP 206', async t => {
  const input = await readFile(opus);
  const native = await parseBuffer(input, { path: 'r128-mixed.opus', mimeType: 'audio/ogg' });
  const { requests, fetchImpl } = await rangeOrigin(t, input, 'audio/ogg');
  const remote = await inspectRemoteTrack(trackUrl, { name: 'r128-mixed.opus', fetchImpl });
  assert.deepEqual(replayGainTags(native.common, native), { replayGain: 4, replayGainPeak: .85, replayGainAlbum: -8,
    r128TrackGain: -6, r128AlbumGain: -12 });
  const { encoding, ...remoteTags } = remote;
  assert.equal(encoding.codec, 'Opus');
  assert.equal(encoding.bitrate, native.format.bitrate);
  assert.equal(encoding.sampleRate, 48000);
  assert.deepEqual(remoteTags, { title: 'R128 fixture', duration: 3, ...replayGainTags(native.common, native) });
  assert.deepEqual(requests, [{ start: 0, end: input.length - 1, validator: undefined }]);
});

test('accepts only a single valid signed Q7.8 Opus comment per mode', () => {
  const gains = (comments, format = { container: 'Ogg', codec: 'Opus' }) =>
    replayGainTags({}, { format, native: { vorbis: comments.map(([id, value]) => ({ id, value })) } });
  const track = 'R128_TRACK_GAIN';
  const album = 'R128_ALBUM_GAIN';
  assert.deepEqual(gains([[track.toLowerCase(), '-32768'], [album, '+32767']]), {
    r128TrackGain: -128, r128AlbumGain: 32767 / 256,
  });
  assert.deepEqual(gains([[track, '000000'], [album, '+00111']]), { r128TrackGain: 0, r128AlbumGain: 111 / 256 });
  assert.deepEqual(gains([[track, '1'], [track.toLowerCase(), '2'], [album, '-573']]), { r128AlbumGain: -573 / 256 });
  for (const value of ['', ' 123', '123\n', '123 ', '1.2', '1e3', '１２', '+000001', '-32769', '32768', 100]) {
    assert.deepEqual(gains([[track, value]]), {}, String(value));
  }
  assert.deepEqual(gains([[track, '-1536']], { container: 'FLAC', codec: 'FLAC' }), {});
});

test('declines unsafe URLs before fetching or parsing', async () => {
  for (const url of [
    'https://example.com/api/baidu/stream?id=1', '//example.com/api/baidu/stream?id=1',
    '/api/baidu/list?id=1', '/api/sources/1/stream?id=1&next=x', '/api/sources/1/stream?id=1#hash',
    '/api/sources/1/stream?id=%00', '/api/sources/1/stream?id=1&id=2', 'blob:https://example.com/audio',
  ]) {
    await assert.rejects(
      inspectRemoteTrack(url, { fetchImpl: () => assert.fail('unsafe URL was fetched') }),
      { code: 'invalid-source' },
    );
  }
});

test('cancels an audio server response that ignored Range before reading its body', async () => {
  let read = false;
  let cancelled = false;
  const stream = new ReadableStream({
    pull: () => { read = true; },
    cancel: () => { cancelled = true; },
  }, { highWaterMark: 0 });
  const fetchImpl = async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'audio/mp4' } });
  await assert.rejects(inspectRemoteTrack(trackUrl, { fetchImpl }), { code: 'range-unavailable' });
  assert.equal(read, false);
  assert.equal(cancelled, true);
});

test('rejects a changed HTTP entity between sparse reads', async t => {
  const input = await readFile(audio);
  const { requests, fetchImpl } = await rangeOrigin(t, input, 'audio/mp4', { failAfter: 1 });
  await assert.rejects(inspectRemoteTrack(trackUrl, { fetchImpl }), { code: 'range-unavailable' });
  assert.equal(requests.length, 2);
});

test('bounds network work when metadata requires more than 24 range pages', async t => {
  const input = Buffer.alloc(12 + 30 * pageSize);
  input.write('RIFF');
  input.writeUInt32LE(input.length - 8, 4);
  input.write('WAVE', 8);
  for (let start = 12; start < input.length; start += pageSize) {
    input.write('JUNK', start);
    input.writeUInt32LE(pageSize - 8, start + 4);
  }
  const { requests, fetchImpl } = await rangeOrigin(t, input, 'audio/wav');
  await assert.rejects(inspectRemoteTrack(trackUrl, { fetchImpl }), { code: 'budget' });
  assert.equal(requests.length, 24);
  assert.ok(requests.reduce((total, range) => total + range.end - range.start + 1, 0) <= 24 * pageSize);
});

test('propagates caller cancellation through an in-flight range request', async () => {
  const controller = new AbortController();
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    assert.equal(url, trackUrl);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    begin();
  });
  const pending = inspectRemoteTrack(trackUrl, { signal: controller.signal, fetchImpl });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
