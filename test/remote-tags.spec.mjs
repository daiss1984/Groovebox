import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { updateBuffer } from 'music-metadata';

const streamUrl = '/api/baidu/stream?id=51';
const rawLabel = '原始文件 旧艺人';
const taggedLabel = '云端标签曲名 云端标签艺人';
const taggedTitle = '云端标签曲名';
const taggedAlbum = '云端标签专辑';
const lyricText = '云中歌词';

let taggedAudio;
test.beforeAll(async () => {
  const rate = 48000;
  const pcmBytes = 1600000;
  const wave = Buffer.alloc(44 + pcmBytes);
  wave.write('RIFF');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(rate, 24);
  wave.writeUInt32LE(rate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(pcmBytes, 40);

  const cover = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
  taggedAudio = Buffer.from(await updateBuffer(wave, {
    title: taggedTitle,
    artist: '云端标签艺人',
    album: taggedAlbum,
    lyrics: '[00:01.50]' + lyricText,
    picture: [{ type: 'Cover (front)', format: 'image/jpeg', data: cover }],
    replaygain_album_gain: '-5 dB',
    replaygain_album_peak: '0.9',
  }));
});

const nav = (page, section) => page.locator('#sidebar [data-nav="' + section + '"]');
const track = (page, label) => page.locator('#content tr').filter({ has: page.getByRole('button', { name: label, exact: true }) });
const playerTime = page => page.locator('#audio').evaluate(audio => audio.currentTime);

test('fills in missing album gain tags on previously read cloud songs when album mode is enabled', async ({ page }) => {
  const probes = await mockBaiduTrack(page);
  await page.addInitScript(() => {
    const storage = 'groovebox.state.v1';
    if (localStorage.getItem(storage)) return;
    localStorage.setItem(storage, JSON.stringify({
      settings: { demos: false, autoReadTags: true, replayGain: true, replayGainMode: 'album' },
      tracks: [{
        id: 'baidu:51', provider: 'baidu', title: '原始文件', artist: '旧艺人', album: '百度网盘',
        path: '/旧艺人 - 原始文件.wav', src: '/api/baidu/stream?id=51', embeddedTags: { title: '原始文件', replayGain: -2 },
        replayGain: -2,
      }],
    }));
  });
  await page.goto('/#songs');
  await expect(track(page, rawLabel)).toBeVisible();
  expect(probes).toHaveLength(0);
  await track(page, rawLabel).getByRole('button', { name: rawLabel }).press('Enter');
  await expect(track(page, taggedLabel)).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('groovebox.state.v1')).tracks.find(track => track.id === 'baidu:51');
    return saved?.embeddedTags?.replayGainAlbum;
  })).toBe(-5);
  checkBoundedProbes(probes);
});

async function mockBaiduTrack(page) {
  const probes = [];
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?*', route => route.fulfill({ json: { items: [{
    id: '51', folder: false, name: '旧艺人 - 原始文件.wav', path: '/旧艺人 - 原始文件.wav', streamUrl,
  }] } }));
  await page.route('**' + streamUrl, route => {
    const request = route.request();
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '');
    const mediaHeaders = { 'Accept-Ranges': 'bytes', ETag: '"remote-tags-wave"' };
    if (!range) {
      if (request.resourceType() === 'fetch') probes.push({ first: 0, last: taggedAudio.length - 1, unbounded: true });
      return route.fulfill({ contentType: 'audio/wav', headers: mediaHeaders, body: taggedAudio });
    }
    const first = Number(range[1]);
    const last = range[2] ? Math.min(Number(range[2]), taggedAudio.length - 1) : taggedAudio.length - 1;
    if (first > last) return route.fulfill({ status: 416, headers: { 'Content-Range': 'bytes */' + taggedAudio.length } });
    if (request.resourceType() === 'fetch') probes.push({ first, last, unbounded: !range[2] });
    return route.fulfill({
      status: 206,
      contentType: 'audio/wav',
      headers: { ...mediaHeaders, 'Content-Range': 'bytes ' + first + '-' + last + '/' + taggedAudio.length },
      body: taggedAudio.subarray(first, last + 1),
    });
  });
  return probes;
}

async function openMockLibrary(page) {
  await nav(page, 'sources').click();
  await page.locator('[data-action="baidu-source"]').click();
  await expect(page.getByRole('heading', { name: '百度网盘', exact: true })).toBeVisible();
}

function checkBoundedProbes(probes) {
  expect(probes.length).toBeGreaterThan(1);
  expect(probes.every(probe => !probe.unbounded)).toBe(true);
  expect(probes.some(probe => probe.first > taggedAudio.length / 2)).toBe(true);
  expect(probes.reduce((sum, probe) => sum + probe.last - probe.first + 1, 0)).toBeLessThan(taggedAudio.length / 4);
}

test('reads remote ID3 tags via the song menu and retains them after reload', async ({ page }) => {
  const probes = await mockBaiduTrack(page);
  await page.goto('/');
  await openMockLibrary(page);
  await expect(track(page, rawLabel)).toBeVisible();
  expect(probes).toHaveLength(0);
  await track(page, rawLabel).getByRole('button', { name: '歌曲选项' }).click();
  await page.locator('#dialog').getByRole('button', { name: '读取音频标签' }).click();

  const tagged = track(page, taggedLabel);
  await expect(page.getByRole('status').filter({ hasText: '已更新歌曲标签。' })).toBeVisible();
  await expect(tagged.getByRole('cell', { name: taggedAlbum })).toBeVisible();
  await expect(tagged.getByRole('cell', { name: '0:16' })).toBeVisible();
  await expect(tagged.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect.poll(() => tagged.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  checkBoundedProbes(probes);
  const count = probes.length;

  await page.reload();
  await expect(tagged).toBeVisible();
  await expect(tagged.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await nav(page, 'songs').click();
  await tagged.getByRole('button', { name: taggedLabel }).click();
  await expect(page.locator('#player-title')).toHaveText(taggedTitle);
  await expect.poll(() => playerTime(page)).toBeGreaterThan(0.1);

  const now = page.locator('#now');
  await now.getByRole('button', { name: '歌词', exact: true }).click();
  await now.getByRole('button', { name: lyricText }).click();
  await expect.poll(() => playerTime(page)).toBeGreaterThanOrEqual(1.5);
  expect(probes).toHaveLength(count);
});

test('automatically reads remote tags on playback and reuses the saved tags', async ({ page }) => {
  const probes = await mockBaiduTrack(page);
  await page.goto('/');
  await nav(page, 'settings').click();
  const autoRead = page.getByRole('checkbox', { name: '播放时读取云端音频标签' });
  await expect(autoRead).not.toBeChecked();
  await autoRead.check();

  await openMockLibrary(page);
  await expect(track(page, rawLabel)).toBeVisible();
  expect(probes).toHaveLength(0);
  await track(page, rawLabel).getByRole('button', { name: rawLabel }).click();
  await expect(page.locator('#player-title')).toHaveText(taggedTitle);
  await expect(track(page, taggedLabel)).toBeVisible();
  await expect.poll(() => playerTime(page)).toBeGreaterThan(0.1);
  checkBoundedProbes(probes);
  const count = probes.length;

  await nav(page, 'settings').click();
  await page.reload();
  await expect(autoRead).toBeChecked();
  await nav(page, 'songs').click();
  await track(page, taggedLabel).getByRole('button', { name: taggedLabel }).click();
  await expect(page.locator('#player-title')).toHaveText(taggedTitle);
  await expect.poll(() => playerTime(page)).toBeGreaterThan(0.1);
  expect(probes).toHaveLength(count);
});
