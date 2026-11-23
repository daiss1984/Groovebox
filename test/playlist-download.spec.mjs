import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const dialog = page => page.getByRole('dialog');
const track = (page, name) => page.locator('#content tr').filter({ has: page.getByRole('button', { name }) });

function wave(samples) {
  const file = Buffer.alloc(44 + samples.length * 2);
  file.write('RIFF', 0);
  file.writeUInt32LE(file.length - 8, 4);
  file.write('WAVEfmt ', 8);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(8000, 24);
  file.writeUInt32LE(16000, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write('data', 36);
  file.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => file.writeInt16LE(sample, 44 + index * 2));
  return file;
}

function archivedAudio(zip) {
  const entries = new Map();
  let cursor = 0;
  while (zip.readUInt32LE(cursor) === 0x04034b50) {
    expect(zip.readUInt16LE(cursor + 8)).toBe(0);
    const size = zip.readUInt32LE(cursor + 18);
    const nameStart = cursor + 30;
    const nameEnd = nameStart + zip.readUInt16LE(cursor + 26);
    const contentStart = nameEnd + zip.readUInt16LE(cursor + 28);
    expect(contentStart + size).toBeLessThan(zip.length);
    entries.set(zip.toString('utf8', nameStart, nameEnd), zip.subarray(contentStart, contentStart + size));
    cursor = contentStart + size;
  }
  expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
  return entries;
}

async function addToPlaylist(row, playlist) {
  await row.locator('[data-action=track-menu]').click();
  const menu = dialog(row.page());
  await menu.getByRole('button', { name: '添加到歌单' }).click();
  await menu.getByRole('button', { name: playlist }).click();
}

test('saves a real playlist ZIP containing local originals and cached Baidu audio after reload', async ({ page }) => {
  const localName = '本地原版录音.wav';
  const localBytes = wave([0, 200, -500, 4000, -20, 100]);
  const cloudName = '云端录音 - 雨夜.wav';
  const cloudBytes = wave([-1000, 300, 0, 1200, -280, 11, -1]);
  const stream = '/api/baidu/stream?id=9001';
  const playlist = '原始文件下载';
  let reachable = true;
  let streamRequests = 0;
  await page.route('**/api/baidu/status', route => route.fulfill({
    json: { configured: true, connected: reachable },
  }));
  await page.route('**/api/baidu/list?**', route => route.fulfill({
    json: { items: [{ id: '9001', folder: false, name: cloudName, path: '/录音/' + cloudName, streamUrl: stream }] },
  }));
  await page.route('**' + stream, route => {
    streamRequests++;
    if (!reachable) return route.abort('internetdisconnected');
    return route.fulfill({ contentType: 'audio/wav', body: cloudBytes });
  });

  await page.goto('/');
  await page.locator('.add-playlist').click();
  await dialog(page).getByRole('textbox').fill(playlist);
  await dialog(page).getByRole('button', { name: '创建' }).click();
  await page.locator('#import-files').setInputFiles({ name: localName, mimeType: 'audio/wav', buffer: localBytes });
  await page.locator('#sidebar [data-nav=songs]').click();
  await addToPlaylist(track(page, /本地原版录音/), playlist);

  await page.locator('#sidebar [data-nav=sources]').click();
  await page.locator('[data-action=baidu-source]').click();
  const cloud = track(page, '雨夜 云端录音');
  await addToPlaylist(cloud, playlist);
  await cloud.locator('[data-action=track-menu]').click();
  await dialog(page).getByRole('button', { name: '离线保存' }).click();
  await expect(page.getByRole('status').filter({ hasText: '音频已保存到离线歌曲' })).toBeVisible();
  expect(streamRequests).toBe(1);

  reachable = false;
  await page.locator('#playlist-nav').getByRole('button', { name: playlist }).click();
  await page.reload();
  await expect(track(page, /本地原版录音/)).toBeVisible();
  await expect(cloud).toBeVisible();
  await page.getByRole('button', { name: '下载歌单', exact: true }).click();
  const save = page.getByRole('link', { name: '保存 ZIP 到本地' });
  await expect(save).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
  expect(download.suggestedFilename()).toBe(playlist + '.zip');
  expect(archivedAudio(await readFile(await download.path()))).toEqual(new Map([
    [localName, localBytes],
    [cloudName, cloudBytes],
  ]));
  expect(streamRequests).toBe(1);
});

test('cancels a pending playlist ZIP and can retry after a provider failure', async ({ page }) => {
  const source = '/api/baidu/stream?id=9002';
  const cover = '/api/baidu/cover?ids=31&folder=' + 'f'.repeat(22) + '&v=' + 'v'.repeat(22) + '&proof=' + 'p'.repeat(43);
  const artwork = await readFile(new URL('../public/assets/cover-2.jpg', import.meta.url));
  const recording = wave([5, 8, 2]);
  const name = '重试下载';
  const began = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let responseMode = 'waiting';
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => route.fulfill({
    json: { items: [{ id: '9002', folder: false, name: '重试音频.wav', path: '/重试音频.wav', streamUrl: source, folderCover: cover }] },
  }));
  await page.route('**' + cover, route => route.fulfill({ contentType: 'image/jpeg', body: artwork }));
  await page.route('**' + source, async route => {
    if (responseMode === 'waiting') {
      began.resolve();
      await finish.promise;
      return route.abort().catch(() => {});
    }
    if (responseMode === 'unavailable') return route.fulfill({ status: 503, json: { error: 'Fixture provider unavailable' } });
    return route.fulfill({ contentType: 'audio/wav', body: recording });
  });
  try {
    await page.goto('/#sources');
    await page.locator('.add-playlist').click();
    await dialog(page).getByRole('textbox').fill(name);
    await dialog(page).getByRole('button', { name: '创建' }).click();
    await page.locator('#sidebar [data-nav=sources]').click();
    await page.locator('[data-action=baidu-source]').click();
    await addToPlaylist(track(page, /重试音频/), name);
    await page.locator('#playlist-nav').getByRole('button', { name }).click();
    const prepare = page.getByRole('button', { name: '下载歌单', exact: true });
    const save = page.getByRole('link', { name: '保存 ZIP 到本地' });

    await prepare.click();
    await began.promise;
    await page.getByRole('button', { name: '取消下载歌单' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已取消歌单下载' })).toBeVisible();
    await expect(save).toHaveCount(0);
    finish.resolve();

    responseMode = 'unavailable';
    await prepare.click();
    await expect(page.getByRole('status').filter({ hasText: '无法下载「重试音频」' })).toBeVisible();
    await expect(save).toHaveCount(0);

    responseMode = 'available';
    await prepare.click();
    await expect(save).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
    expect(archivedAudio(await readFile(await download.path()))).toEqual(new Map([['重试音频.wav', recording]]));
    await page.unroute('**' + cover);
    await page.locator('#sidebar [data-nav=offline]').press('Enter');
    await page.reload();
    const downloadedCover = track(page, /重试音频/).locator('.track-main img');
    await expect(downloadedCover).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => downloadedCover.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  } finally {
    finish.resolve();
  }
});
