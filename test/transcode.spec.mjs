import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dsdFixture } from './helpers/dsd-fixture.mjs';

const isConversion = response => new URL(response.url()).pathname === '/api/transcode' && response.request().method() === 'POST';
const playbackMime = page => page.locator('#audio').evaluate(audio =>
  audio.canPlayType('audio/flac') || audio.canPlayType('audio/x-flac') ? 'audio/flac' : 'audio/mpeg');

test('converts uploaded audio and uses the browser-decodable result for playback', async ({ page }) => {
  test.skip(!process.env.FFMPEG_PATH, 'Set FFMPEG_PATH to an installed FFmpeg with MP3 encoding');
  const rate = 8000;
  const samples = rate * 3;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let n = 0; n < samples; n++) wav.writeInt16LE(Math.round(Math.sin(n * 2 * Math.PI * 220 / rate) * 7000), 44 + n * 2);
  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles({ name: '兼容测试.wav', mimeType: 'audio/wav', buffer: wav });
  const row = page.locator('#content tr').filter({ hasText: '兼容测试' });
  await row.getByRole('button', { name: '歌曲选项' }).press('Enter');
  const response = page.waitForResponse(isConversion);
  await page.getByRole('button', { name: '兼容播放', exact: true }).press('Enter');
  const output = await response;
  expect(output.status()).toBe(200);
  expect(output.headers()['content-type']).toBe(await playbackMime(page));
  await expect(page.locator('#toast')).toContainText('兼容音频已准备好');
  await expect(page.locator('#player-title')).toHaveText('兼容测试');
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
});

test('automatically plays a real WavPack track after native decoding fails', async ({ page }) => {
  test.skip(!process.env.FFMPEG_PATH, 'Set FFMPEG_PATH to an installed FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-wavpack-browser-'));
  const input = join(directory, 'WavPack fixture.wv');
  try {
    execFileSync(process.env.FFMPEG_PATH, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=360:d=3', '-c:a', 'wavpack', input]);
    await page.goto('/#songs');
    await page.locator('#import-files').setInputFiles(input);
    const track = page.getByRole('table').getByRole('button', { name: 'WavPack fixture 未知艺人', exact: true });
    await expect(track).toBeVisible();
    const response = page.waitForResponse(isConversion);
    await track.press('Enter');
    const converted = await response;
    expect(converted.status()).toBe(200);
    expect(converted.headers()['content-type']).toBe(await playbackMime(page));
    await expect(page.getByRole('status').filter({ hasText: '正在播放兼容音频' })).toBeVisible();
    await expect(page.locator('#player-title')).toHaveText('WavPack fixture');
    await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('requests an authentic DSF file from the Baidu route and automatically plays the compatible audio', async ({ page }) => {
  test.skip(!process.env.FFMPEG_PATH, 'Set FFMPEG_PATH to an installed FFmpeg');
  const audio = dsdFixture('dsf', { seconds: 3 });
  const name = '测试艺人 - 百度DSF.dsf';
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?*', route => route.fulfill({ json: { items: [{
    id: '91', name, path: '/Music/' + name, folder: false, streamUrl: '/api/baidu/stream?id=91',
  }] } }));
  let completeReads = 0;
  await page.route('**/api/baidu/stream?id=91', route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (!range) {
      completeReads++;
      return route.fulfill({ contentType: 'audio/x-dsf', body: audio });
    }
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
    return route.fulfill({ status: 206, contentType: 'audio/x-dsf',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${audio.length}` },
      body: audio.subarray(start, end + 1),
    });
  });
  await page.goto('/#sources');
  await page.locator('#content [data-action="baidu-source"]').press('Enter');
  const track = page.getByRole('table').getByRole('button', { name: '百度DSF 测试艺人', exact: true });
  await expect(track).toBeVisible();
  const response = page.waitForResponse(isConversion);
  await track.press('Enter');
  const compatible = await response;
  expect(compatible.status()).toBe(200);
  expect(compatible.headers()['content-type']).toBe(await playbackMime(page));
  expect(completeReads).toBeGreaterThan(0);
  await expect.poll(() => page.locator('#audio').evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
});
