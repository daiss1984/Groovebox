import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseBuffer } from 'music-metadata';
import { createAudioTranscoder, TranscodeError } from '../server/audio-transcode.mjs';

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'audio-transcode-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fakeEncoder(t, { seekable = true, mode = 'encode' } = {}) {
  const tempRoot = await sandbox(t);
  const command = join(tempRoot, 'test-ffmpeg');
  await writeFile(command, `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const seekable = ${seekable};
const mode = ${JSON.stringify(mode)};
if (args.includes('-protocols')) {
  process.stdout.write('Supported file protocols:\\nInput:\\n' + (seekable ? '  fd\\n' : '') + '  pipe\\n  https\\nOutput:\\n  pipe\\n');
  process.exit(0);
}
const argument = name => args[args.indexOf(name) + 1];
assert.equal(argument('-protocol_whitelist'), seekable ? 'fd' : 'pipe');
assert.equal(argument('-i'), seekable ? 'fd:' : 'pipe:0');
if (seekable) assert.equal(argument('-fd'), '3');
assert.ok(!argument('-format_whitelist').match(/(?:concat|hls|dash)/));
assert.ok(args.includes('-nostdin'));
assert.equal(argument('-map'), '0:a:0');
assert.equal(argument('-c:a'), 'libmp3lame');
assert.equal(argument('-f'), 'mp3');
const input = fs.readFileSync(seekable ? 3 : 0);
assert.equal(input.subarray(0, 5).toString(), 'audio');
const output = args.at(-1);
assert.equal(path.basename(output), 'audio.mp3');
assert.equal(fs.realpathSync(path.dirname(output)), fs.realpathSync(process.cwd()));
if (mode === 'hang') {
  setInterval(() => {}, 10_000);
} else if (mode === 'invalid') {
  process.stderr.write('Unreadable test input');
  process.exitCode = 1;
} else {
  fs.writeFileSync(output, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(253)]));
}
`, { mode: 0o700 });
  return { command, tempRoot };
}

function hasStatus(status) {
  return error => error instanceof TranscodeError && error.status === status;
}

for (const seekable of [true, false]) {
  test(`converts bytes through a restricted ${seekable ? 'file descriptor' : 'stdin'} and removes the input`, {
    skip: process.platform === 'win32',
  }, async t => {
    const config = await fakeEncoder(t, { seekable });
    const transcode = createAudioTranscoder({ ...config, maxResults: 1 });
    assert.deepEqual(await transcode.check(), { seekable });

    const source = ReadableStream.from([Buffer.from('audio'), Buffer.from(' bytes')]);
    const result = await transcode(source);
    assert.equal(result.mime, 'audio/mpeg');
    assert.equal(result.size, 256);
    assert.equal((await readFile(result.path)).subarray(0, 3).toString(), 'ID3');
    assert.deepEqual(await readdir(dirname(result.path)), ['audio.mp3']);
    await assert.rejects(transcode(Buffer.from('audio')), hasStatus(429));
    await Promise.all([result.dispose(), result.dispose()]);
    await assert.rejects(readFile(result.path), { code: 'ENOENT' });

    const replacement = await transcode(Buffer.from('audio'));
    await replacement.dispose();
    assert.deepEqual(await readdir(config.tempRoot), ['test-ffmpeg']);
  });
}

test('fails without FFmpeg before consuming the input and only accepts bytes', async t => {
  const tempRoot = await sandbox(t);
  const transcode = createAudioTranscoder({ tempRoot, command: join(tempRoot, 'missing-ffmpeg') });
  let consumed = false;
  async function* input() {
    consumed = true;
    yield Buffer.from('audio');
  }
  await assert.rejects(transcode('https://example.invalid/audio'), hasStatus(400));
  await assert.rejects(transcode(input(), { signal: AbortSignal.abort() }), hasStatus(499));
  await assert.rejects(transcode(input()), hasStatus(503));
  assert.equal(consumed, false);
  assert.deepEqual(await readdir(tempRoot), []);
});

test('enforces the input and output limits and cleans failed conversions', { skip: process.platform === 'win32' }, async t => {
  const config = await fakeEncoder(t);
  const transcode = createAudioTranscoder({ ...config, inputLimit: 20, outputLimit: 200 });
  await assert.rejects(transcode([Buffer.from('audio'), Buffer.alloc(16)]), hasStatus(413));
  await assert.rejects(transcode(Buffer.from('audio')), hasStatus(413));
  await assert.rejects(transcode(Buffer.alloc(0)), hasStatus(400));
  assert.deepEqual(await readdir(config.tempRoot), ['test-ffmpeg']);
});

test('reports corrupt audio and removes intermediate files', { skip: process.platform === 'win32' }, async t => {
  const config = await fakeEncoder(t, { mode: 'invalid' });
  await assert.rejects(createAudioTranscoder(config)(Buffer.from('audio')), hasStatus(422));
  assert.deepEqual(await readdir(config.tempRoot), ['test-ffmpeg']);
});

test('bounds simultaneous work and cleans up on timeout or caller abort', { skip: process.platform === 'win32' }, async t => {
  const config = await fakeEncoder(t, { mode: 'hang' });
  const transcode = createAudioTranscoder({ ...config, timeoutMs: 650, maxConcurrent: 1 });
  await transcode.check();
  const conversion = transcode(Buffer.from('audio'));
  await assert.rejects(transcode(Buffer.from('audio')), hasStatus(429));
  await assert.rejects(conversion, hasStatus(504));

  const controller = new AbortController();
  const aborted = transcode(Buffer.from('audio'), { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, hasStatus(499));
  assert.deepEqual(await readdir(config.tempRoot), ['test-ffmpeg']);
});

test('automatically removes expired files and frees the result lease', { skip: process.platform === 'win32' }, async t => {
  const config = await fakeEncoder(t);
  const transcode = createAudioTranscoder({ ...config, retentionMs: 15, maxResults: 1 });
  const result = await transcode(Buffer.from('audio'));
  await new Promise(resolve => setTimeout(resolve, 75));
  await assert.rejects(readFile(result.path), { code: 'ENOENT' });
  await result.dispose();
  const second = await transcode(Buffer.from('audio'));
  await second.dispose();
});

test('expires a stalled upload and frees storage and concurrency', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async t => {
  const config = await fakeEncoder(t);
  const transcode = createAudioTranscoder({ ...config, timeoutMs: 700, maxConcurrent: 1 });
  await transcode.check();
  let unlock;
  const paused = new Promise(resolve => { unlock = resolve; });
  t.after(unlock);
  async function* partialUpload() {
    yield Buffer.from('audio');
    await paused;
  }
  await assert.rejects(transcode(partialUpload()), hasStatus(504));
  assert.deepEqual(await readdir(config.tempRoot), ['test-ffmpeg']);
  const result = await transcode(Buffer.from('audio'));
  await result.dispose();
});

for (const { name, inputRate, layout, outputChannels } of [
  { name: 'preserves 48 kHz mono when encoding WavPack to MP3', inputRate: 48000, layout: 'mono', outputChannels: 1 },
  { name: 'converts 96 kHz surround WavPack to a supported 48 kHz stereo MP3', inputRate: 96000, layout: '5.1', outputChannels: 2 },
]) {
  test(name, { skip: !process.env.FFMPEG_TEST_BIN && 'FFMPEG_TEST_BIN was not supplied' }, async t => {
    const tempRoot = await sandbox(t);
    const command = process.env.FFMPEG_TEST_BIN;
    const source = join(tempRoot, 'synthetic.wv');
    const ffmpeg = promisify(execFile);
    await ffmpeg(command, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4:sample_rate=' + inputRate,
      '-af', 'aformat=channel_layouts=' + layout, '-c:a', 'wavpack', source,
    ]);
    const transcode = createAudioTranscoder({ command, tempRoot });
    const result = await transcode(await readFile(source));
    try {
      const encoded = await readFile(result.path);
      assert.equal(result.size, encoded.length);
      assert.equal(encoded.subarray(0, 3).toString(), 'ID3');
      assert.ok(encoded.includes(Buffer.from('Xing')));
      const { format } = await parseBuffer(encoded, { mimeType: 'audio/mpeg' });
      assert.equal(format.sampleRate, 48000);
      assert.equal(format.numberOfChannels, outputChannels);
      await ffmpeg(command, ['-v', 'error', '-xerror', '-i', result.path, '-f', 'null', '-']);
    } finally {
      await result.dispose();
    }
    assert.deepEqual(await readdir(tempRoot), ['synthetic.wv']);
  });
}

test('preserves 24-bit stereo PCM samples and the 96 kHz rate in FLAC output', {
  skip: !process.env.FFMPEG_TEST_BIN && 'FFMPEG_TEST_BIN was not supplied',
}, async t => {
  const tempRoot = await sandbox(t);
  const command = process.env.FFMPEG_TEST_BIN;
  const pcm = Buffer.alloc(6 * 4096);
  for (let frame = 0; frame < 4096; frame++) {
    pcm.writeIntLE(Math.round(Math.sin(frame / 50) * 4567891), frame * 6, 3);
    pcm.writeIntLE(Math.round(Math.cos(frame / 55) * 3456789), frame * 6 + 3, 3);
  }
  const rawPath = join(tempRoot, 'stereo.pcm');
  const wavPath = join(tempRoot, 'original.wav');
  await writeFile(rawPath, pcm);
  const ffmpeg = promisify(execFile);
  await ffmpeg(command, ['-v', 'error', '-f', 's24le', '-ar', '96000', '-ac', '2', '-i', rawPath, '-c:a', 'pcm_s24le', wavPath]);

  const result = await createAudioTranscoder({ command, tempRoot })(await readFile(wavPath), { format: 'flac' });
  try {
    assert.equal(result.mime, 'audio/flac');
    const encoded = await readFile(result.path);
    assert.equal(encoded.subarray(0, 4).toString(), 'fLaC');
    const info = encoded.readUInt32BE(18);
    assert.equal(info >>> 12, 96000);
    assert.equal(((info >>> 9) & 7) + 1, 2);
    assert.equal(((info >>> 4) & 31) + 1, 24);
    const { stdout } = await ffmpeg(command, ['-v', 'error', '-i', result.path, '-f', 's24le', '-'], { encoding: 'buffer' });
    assert.deepEqual(stdout, pcm);
  } finally { await result.dispose(); }
});
