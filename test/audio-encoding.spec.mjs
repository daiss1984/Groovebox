import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { parseBuffer } from 'music-metadata';

const ffmpeg = process.env.FFMPEG_PATH;
const shape = {
  flac: ['audio/flac', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'],
  wav: ['audio/wav', '-c:a', 'pcm_s24le'],
  mp3: ['audio/mpeg', '-c:a', 'libmp3lame', '-b:a', '128k'],
};
const sourceLine = page => page.locator('#now [data-source-encoding]');
const compatibilityLine = page => page.locator('#now [data-active-encoding]');
const capLine = page => page.locator('#now [data-stream-bitrate-limit]');
const currentTime = page => page.locator('#audio').evaluate(element => element.currentTime);
const audioRow = (page, title) => page.locator('#content tr').filter({ hasText: title });
const stage = (page, tracks = [], options = {}) => page.addInitScript(({ tracks, options }) => {
  if (localStorage.getItem('groovebox.state.v1')) return;
  localStorage.setItem('groovebox.state.v1', JSON.stringify({ tracks, settings: { language: 'en', demos: false, ...options } }));
}, { tracks, options });

async function makeAudio(extension, title, rate) {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-encoding-'));
  const [mimeType, ...options] = shape[extension];
  const path = join(directory, title + '.' + extension);
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=8:sample_rate=' + rate,
      ...options, '-metadata', 'title=' + title, path], { timeout: 10000 });
    return { name: title + '.' + extension, mimeType, buffer: await readFile(path) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const kbps = async ({ buffer, mimeType }) => Math.round((await parseBuffer(buffer, { mimeType })).format.bitrate / 1000);

test('displays actual FLAC and AAC facts on both playback views and after restoring the queue', async ({ page }) => {
  test.skip(!ffmpeg, 'Set FFMPEG_PATH to create the real FLAC fixture');
  await stage(page);
  const flac = await makeAudio('flac', 'Encoding FLAC', 96000);
  const m4a = { name: 'Encoding AAC.m4a', mimeType: 'audio/mp4',
    buffer: await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url)) };
  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles([flac, m4a]);
  await audioRow(page, 'Encoding FLAC').locator('.track-main').press('Enter');
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.1);
  const expected = 'Source file: FLAC · ' + await kbps(flac) + ' kbps · 96 kHz · 24-bit';
  await expect(sourceLine(page)).toHaveText(expected);
  await expect(sourceLine(page)).toBeVisible();
  await page.locator('#player-art').press('Enter');
  await expect(page.locator('.immersive [data-source-encoding]')).toHaveText(expected);
  await page.getByRole('button', { name: 'Close Immersive Player' }).press('Enter');
  await audioRow(page, 'Encoding AAC').locator('.track-main').press('Enter');
  const matchAac = new RegExp('^Source file: AAC \\(M4A\\) · ' + await kbps(m4a) + ' kbps · ');
  await expect(sourceLine(page)).toHaveText(matchAac);
  await expect(sourceLine(page)).not.toContainText('16-bit');
  await page.reload();
  await expect(sourceLine(page)).toHaveText(matchAac);
  await expect(compatibilityLine(page)).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('groovebox.library');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction('tracks', 'readwrite');
      const store = transaction.objectStore('tracks');
      const request = store.get('local:Encoding AAC.m4a');
      request.onsuccess = () => {
        const record = request.result;
        delete record.encoding;
        store.put(record);
      };
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
  await page.reload();
  await expect(sourceLine(page)).toHaveText(matchAac);
});

for (const useMp3 of [false, true]) {
  test('separates actual ' + (useMp3 ? 'MP3' : 'FLAC') + ' compatibility audio and returns to the original WAV', async ({ page }) => {
    test.skip(!ffmpeg, 'Set FFMPEG_PATH for actual compatibility audio');
    await stage(page);
    if (useMp3) await page.addInitScript(() => {
      const native = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (type) {
        return /^audio\/(?:x-)?flac$/i.test(type) ? '' : native.call(this, type);
      };
    });
    const wav = await makeAudio('wav', 'Encoding WAV', 96000);
    await page.goto('/#songs');
    await page.locator('#import-files').setInputFiles(wav);
    const menu = audioRow(page, 'Encoding WAV').getByRole('button', { name: 'Track Options' });
    await menu.press('Enter');
    const conversion = page.waitForResponse(response => new URL(response.url()).pathname === '/api/transcode' &&
      response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Play Compatible Version', exact: true }).press('Enter');
    const response = await conversion;
    expect(response.ok()).toBe(true);
    const mimeType = response.headers()['content-type'];
    await expect(sourceLine(page)).toHaveText('Source file: PCM (WAV) · 2304 kbps · 96 kHz · 24-bit');
    await expect(compatibilityLine(page)).toBeVisible();
    const buffer = Buffer.from(await page.locator('#audio').evaluate(async element => {
      const bytes = await (await fetch(element.currentSrc)).arrayBuffer();
      return Array.from(new Uint8Array(bytes));
    }));
    const rate = await kbps({ buffer, mimeType });
    expect(Number.isFinite(rate)).toBe(true);
    await expect(compatibilityLine(page)).toHaveText(useMp3
      ? 'Browser compatibility audio: MP3 · ' + rate + ' kbps · 48 kHz'
      : 'Browser compatibility audio: FLAC · ' + rate + ' kbps · 96 kHz · 24-bit');
    await expect(capLine(page)).toHaveCount(0);
    await menu.press('Enter');
    await page.getByRole('button', { name: 'Return to Original Audio', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toHaveText('Switched to original audio.');
    await expect(compatibilityLine(page)).toHaveCount(0);
    await expect(sourceLine(page)).toContainText('PCM (WAV) · 2304 kbps');
  });
}

test('shows an active media-server request cap separately from measured original file bitrate', async ({ page }) => {
  test.skip(!ffmpeg, 'Set FFMPEG_PATH to create the original and transcoded media fixtures');
  const original = await makeAudio('flac', 'Remote file tag', 48000);
  const limited = await makeAudio('mp3', 'Server Stream', 48000);
  const id = '1dbcd5ea-13eb-4624-860f-a52ecf4a48c4';
  const stream = '/api/sources/' + id + '/stream?id=source-track';
  await stage(page, [{ id: id + ':source-track', provider: 'navidrome', title: 'Original Rate', artist: 'Fixture',
    album: 'Fixture Album', albumIsFallback: false, src: stream }],
  { streamBitrates: { network: 'wifi', wifi: 96 }, autoReadTags: false });
  const sourceRanges = [];
  await page.route('**' + stream + '*', route => {
    const usingLimit = new URL(route.request().url()).searchParams.has('maxBitRate');
    const { buffer, mimeType } = usingLimit ? limited : original;
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), buffer.length - 1) : buffer.length - 1;
    if (!usingLimit && range) sourceRanges.push(range[0]);
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: mimeType,
      headers: { 'Accept-Ranges': 'bytes', ...(range && { 'Content-Range': 'bytes ' + start + '-' + end + '/' + buffer.length }) },
      body: buffer.subarray(start, end + 1),
    });
  });
  await page.goto('/#songs');
  const row = audioRow(page, 'Original Rate');
  await row.locator('.track-main').press('Enter');
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.1);
  await expect(capLine(page)).toHaveText('Requested stream limit: 96 kbps');
  await expect(sourceLine(page)).toHaveCount(0);
  await expect(compatibilityLine(page)).toHaveCount(0);
  expect(await kbps(limited)).toBe(128);
  expect(sourceRanges).toEqual([]);

  await page.locator('#player-art').press('Enter');
  const facts = 'Source file: FLAC · ' + await kbps(original) + ' kbps · 48 kHz · 24-bit';
  await expect(page.locator('.immersive [data-source-encoding]')).toHaveText(facts);
  await expect(page.locator('#player-title')).toHaveText('Original Rate');
  expect(sourceRanges).toContain('bytes=0-65535');
  await page.getByRole('button', { name: 'Close Immersive Player' }).press('Enter');
  await row.getByRole('button', { name: 'Track Options' }).press('Enter');
  await page.getByRole('button', { name: 'Read Audio Tags', exact: true }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText('Remote file tag');
  await expect(sourceLine(page)).toHaveText(facts);
  await expect(capLine(page)).toHaveText('Requested stream limit: 96 kbps');

  await page.locator('#sidebar [data-nav=settings]').press('Enter');
  await page.locator('[data-stream-bitrate=wifi]').selectOption('128');
  await expect(capLine(page)).toHaveText('Requested stream limit: 96 kbps');
  await page.locator('#sidebar [data-nav=songs]').press('Enter');
  await audioRow(page, 'Remote file tag').locator('.track-main').press('Enter');
  await expect(capLine(page)).toHaveText('Requested stream limit: 128 kbps');
});

test('reads actual FLAC encoding for a directly played Baidu track only when the playback panel is opened', async ({ page }) => {
  test.skip(!ffmpeg, 'Set FFMPEG_PATH to create the real Baidu audio fixture');
  const { buffer, mimeType } = await makeAudio('flac', 'Metadata Only', 48000);
  const media = '/api/baidu/stream?id=2712';
  const ranges = [];
  await stage(page, [], { directCloudSources: ['baidu'], autoReadTags: false });
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => route.fulfill({ json: { items: [{
    id: '2712', name: 'Direct Baidu.flac', path: '/Direct Baidu.flac', streamUrl: media,
  }] } }));
  await page.route('**' + media, route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ body: buffer, contentType: mimeType });
    ranges.push(range[0]);
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : buffer.length - 1, buffer.length - 1);
    return route.fulfill({ status: 206, contentType: mimeType, body: buffer.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${buffer.length}` } });
  });
  await page.goto('/#sources');
  await page.locator('#content [data-action=baidu-source]').click();
  await page.locator('#content').getByRole('button', { name: /^Direct Baidu/ }).press('Enter');
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.1);
  await expect(sourceLine(page)).toHaveCount(0);
  const before = ranges.filter(range => range === 'bytes=0-65535').length;
  const panel = page.locator('.player-options [data-action=queue-panel]');
  await panel.press('Enter');
  await panel.press('Enter');
  await expect(sourceLine(page)).toHaveText('Source file: FLAC · ' + await kbps({ buffer, mimeType }) + ' kbps · 48 kHz · 24-bit');
  expect(ranges.filter(range => range === 'bytes=0-65535')).toHaveLength(before + 1);
  await expect(page.locator('#player-title')).toHaveText('Direct Baidu');
});
