import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseBuffer, updateBuffer } from 'music-metadata';
import { dsdFixture } from './helpers/dsd-fixture.mjs';

const execute = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH;
const monkeyAudio = process.env.MONKEY_AUDIO_TEST_BIN;
const artist = 'Synthetic Artist';
const album = 'Quality Test';
const fixtures = [
  { extension: 'wav', mime: 'audio/wav', sampleRate: 96000, bits: 24 },
  { extension: 'ape', mime: 'audio/x-ape', sampleRate: 96000, bits: 24 },
  { extension: 'dsf', mime: 'audio/x-dsf', sampleRate: 2822400, bits: 1 },
  { extension: 'dff', mime: 'audio/x-dff', sampleRate: 2822400, bits: 1 },
];

let temporary;
let wavFile;

// Optional live formats test. FFmpeg generates the source PCM; Monkey's Audio encodes it as APE.
test.beforeAll(async () => {
  if (!ffmpeg) return;
  temporary = await mkdtemp(join(tmpdir(), 'groovebox-quality-formats-'));
  wavFile = join(temporary, 'original.wav');
  await execute(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=96000',
    '-c:a', 'pcm_s24le', '-metadata', 'title=WAV Studio Test', '-metadata', 'artist=' + artist,
    '-metadata', 'album=' + album, '-metadata', 'genre=Classical', wavFile,
  ], { timeout: 10000 });
});

test.afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function audioBytes(extension) {
  if (extension === 'wav') return readFile(wavFile);
  if (extension !== 'ape') return dsdFixture(extension, { seconds: 3 });
  const target = join(temporary, 'original.ape');
  await execute(monkeyAudio, [wavFile, target, '-c2000'], { timeout: 10000 });
  const cover = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
  return Buffer.from(await updateBuffer(await readFile(target), {
    title: 'APE Studio Test', artist, album, genre: ['Classical'],
    lyrics: '[00:01.00]Synthetic audio lyric',
    picture: [{ type: 'Cover (front)', format: 'image/jpeg', data: cover }],
  }));
}

async function pcmHash(file) {
  const { stdout } = await execute(ffmpeg, [
    '-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_s24le', '-f', 'hash', '-hash', 'SHA256', '-',
  ], { timeout: 10000 });
  return stdout.trim();
}

async function loadedAudioBytes(audio) {
  const encoded = await audio.evaluate(async element => {
    const blob = await (await fetch(element.src)).blob();
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  });
  return Buffer.from(encoded, 'base64');
}

for (const { extension, mime, sampleRate, bits } of fixtures) {
  test(`imports real ${extension.toUpperCase()} tags and verifies original or compatible playback`, async ({ page }) => {
    test.skip(!ffmpeg, 'Set FFMPEG_PATH to an FFmpeg with APE, DSF, DSDIFF and FLAC support');
    test.skip(extension === 'ape' && !monkeyAudio, 'Set MONKEY_AUDIO_TEST_BIN to the Monkey’s Audio console encoder');
    const title = extension.toUpperCase() + ' Studio Test';
    const bytes = await audioBytes(extension);
    const original = await parseBuffer(bytes, { mimeType: mime, path: 'original.' + extension });
    expect(original.format.sampleRate).toBe(sampleRate);
    expect(original.format.bitsPerSample).toBe(bits);
    expect(original.common.title).toBe(title);
    await page.goto('/#songs');
    await page.locator('#import-files').setInputFiles({ name: 'original.' + extension, mimeType: mime, buffer: bytes });
    const row = page.locator('#content tr').filter({ hasText: title });
    const track = row.getByRole('button', { name: title + ' ' + artist });
    await expect(track).toBeVisible();
    await expect(row.getByText(album, { exact: true })).toBeVisible();
    if (extension === 'ape') await expect.poll(() => track.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    const audio = page.locator('#audio');
    if (extension === 'wav') {
      const transcodes = [];
      page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/transcode')) transcodes.push(request.url()); });
      await track.press('Enter');
      await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
      const digest = await audio.evaluate(async element => {
        const original = await (await fetch(element.currentSrc)).arrayBuffer();
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', original)), value => value.toString(16).padStart(2, '0')).join('');
      });
      expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(transcodes).toHaveLength(0);
      return;
    }
    await row.getByRole('button', { name: '歌曲选项' }).press('Enter');
    const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname === '/api/transcode' && candidate.request().method() === 'POST');
    await page.getByRole('button', { name: '兼容播放', exact: true }).press('Enter');
    const converted = await response;
    expect(converted.status()).toBe(200);
    expect(converted.headers()['content-type']).toBe('audio/flac');
    await expect(page.locator('#toast')).toContainText('兼容音频已准备好');
    await expect(page.locator('#player-title')).toHaveText(title);
    const flac = await loadedAudioBytes(audio);
    const result = await parseBuffer(flac, { mimeType: 'audio/flac' });
    expect(result.format.bitsPerSample).toBe(24);
    expect(result.format.sampleRate).toBe(extension === 'ape' ? sampleRate : sampleRate / 8);
    if (extension === 'ape') {
      const compatible = join(temporary, 'compatible.flac');
      await writeFile(compatible, flac);
      expect(await pcmHash(compatible)).toBe(await pcmHash(wavFile));
    }
    await page.locator('#player-toggle').press('Enter');
    await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  });
}

test('plays the compatible 48 kHz mono MP3 if the browser reports no FLAC support', async ({ page }) => {
  test.skip(!ffmpeg, 'Set FFMPEG_PATH to an FFmpeg with MP3 support');
  const input = join(temporary, 'mono.wav');
  await execute(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000',
    '-c:a', 'pcm_s24le', '-metadata', 'title=Mono Studio Test', input,
  ], { timeout: 10000 });
  await page.addInitScript(() => {
    const nativeCanPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return /^audio\/(?:x-)?flac$/i.test(type) ? '' : nativeCanPlay.call(this, type);
    };
  });
  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles(input);
  const row = page.locator('#content tr').filter({ hasText: 'Mono Studio Test' });
  await row.getByRole('button', { name: '歌曲选项' }).press('Enter');
  const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname === '/api/transcode' &&
    candidate.request().method() === 'POST');
  await page.getByRole('button', { name: '兼容播放', exact: true }).press('Enter');
  const converted = await response;
  expect(converted.status()).toBe(200);
  expect(converted.headers()['content-type']).toBe('audio/mpeg');
  await expect(page.locator('#toast')).toContainText('兼容音频已准备好');
  await expect(page.locator('#player-title')).toHaveText('Mono Studio Test');
  const audio = page.locator('#audio');
  const { format } = await parseBuffer(await loadedAudioBytes(audio), { mimeType: 'audio/mpeg' });
  expect(format.sampleRate).toBe(48000);
  expect(format.numberOfChannels).toBe(1);
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
});

test('returns to WAV bytes without changing the active repeated queue entry or the playback position', async ({ page }) => {
  test.skip(!ffmpeg, 'Set FFMPEG_PATH to an FFmpeg with FLAC support');
  const input = join(temporary, 'original-switch.wav');
  await execute(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10:sample_rate=96000',
    '-c:a', 'pcm_s24le', '-metadata', 'title=Switch Source Test', input,
  ], { timeout: 10000 });
  await page.goto('/#songs');
  await page.locator('#now').getByRole('button', { name: '清空队列', exact: true }).press('Enter');
  await page.locator('#import-files').setInputFiles(input);
  const row = page.locator('#content tr').filter({ hasText: 'Switch Source Test' });
  const trackMenu = row.getByRole('button', { name: '歌曲选项' });
  const dialog = page.getByRole('dialog');
  await trackMenu.press('Enter');
  await dialog.getByRole('button', { name: '兼容播放', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('兼容音频已准备好');
  await trackMenu.press('Enter');
  await dialog.getByRole('button', { name: '添加到播放队列', exact: true }).press('Enter');
  const queue = page.locator('#now .queue-row');
  await expect(queue).toHaveCount(2);
  await queue.nth(1).locator('.track-main').press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await audio.evaluate(element => { element.currentTime = 2; });
  await expect.poll(() => audio.evaluate(element => element.seeking ? 0 : element.currentTime)).toBeGreaterThanOrEqual(2);
  const before = await audio.evaluate(element => ({ src: element.currentSrc, time: element.currentTime }));
  expect((await loadedAudioBytes(audio)).subarray(0, 4).toString()).toBe('fLaC');
  const activeEntryMenu = queue.nth(1).getByRole('button', { name: '队列选项' });
  await activeEntryMenu.press('Enter');
  await dialog.getByRole('button', { name: '切回原始音源', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toHaveText('已切回原始音源。');
  await expect(queue).toHaveCount(2);
  await expect(queue.nth(1)).toHaveClass(/current/);
  const after = await audio.evaluate(element => ({ src: element.currentSrc, time: element.currentTime, playing: !element.paused }));
  expect(after.src).not.toBe(before.src);
  expect(after.time).toBeGreaterThanOrEqual(before.time - 0.15);
  expect(after.playing).toBe(true);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  expect(sha256(await loadedAudioBytes(audio))).toBe(sha256(await readFile(input)));
});

test('keeps the paused compatible audio when the original APE fails to decode', async ({ page }) => {
  test.skip(!ffmpeg || !monkeyAudio, 'Requires FFmpeg and the Monkey’s Audio console encoder');
  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles({ name: 'fallback.ape', mimeType: 'audio/x-ape', buffer: await audioBytes('ape') });
  const row = page.locator('#content tr').filter({ hasText: 'APE Studio Test' });
  const trackMenu = row.getByRole('button', { name: '歌曲选项' });
  const dialog = page.getByRole('dialog');
  await trackMenu.press('Enter');
  await dialog.getByRole('button', { name: '兼容播放', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('兼容音频已准备好');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.duration)).toBeGreaterThan(2);
  await audio.evaluate(element => { element.currentTime = 1; });
  const compatible = await audio.evaluate(element => element.src);
  await trackMenu.press('Enter');
  await dialog.getByRole('button', { name: '切回原始音源', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toHaveText('无法播放原始音源，已保留兼容音频。');
  expect(await audio.evaluate(element => ({ src: element.src, time: element.currentTime, paused: element.paused })))
    .toEqual({ src: compatible, time: 1, paused: true });
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(1.1);
});
