import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';

const nav = (page, section) => page.locator('#sidebar [data-nav="' + section + '"]');
const action = (scope, name) => scope.locator('[data-action="' + name + '"]');
const row = (page, name) => page.locator('#content tr').filter({
  has: page.getByRole('button', { name }),
});
const toggle = (page) => page.locator('#player-toggle');
const title = (page) => page.locator('#player-title');
const audioState = (page) => page.locator('#audio').evaluate((audio) => ({
  time: audio.currentTime,
  duration: audio.duration,
  paused: audio.paused,
  muted: audio.volume === 0,
}));
async function playDemo(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '立即播放' }).click();
  await expect(title(page)).toHaveText('After Hours');
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(0.1);
}

test('plays real demo audio, seeks, skips, pauses, and changes playback modes', async ({ page }) => {
  await playDemo(page);
  await expect.poll(async () => (await audioState(page)).duration).toBeGreaterThan(160);
  const pauseIcon = toggle(page).locator('use[href="/icons.svg#pause"]');
  await expect(pauseIcon).toHaveCount(1);
  await expect.poll(() => pauseIcon.evaluate((icon) => icon.getBBox().width)).toBeGreaterThan(0);

  const seek = page.getByRole('slider', { name: '播放进度' });
  const box = await seek.boundingBox();
  await seek.click({ position: { x: Math.floor(box.width * 0.4), y: Math.round(box.height / 2) } });
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(55);

  await page.getByRole('button', { name: '下一首' }).click();
  await expect(title(page)).toHaveText('Blue Static');
  await page.getByRole('button', { name: '上一首' }).click();
  await expect(title(page)).toHaveText('After Hours');

  await toggle(page).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  await toggle(page).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);

  await page.getByRole('button', { name: '随机播放' }).click();
  await expect(page.getByRole('button', { name: '随机播放' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#repeat').click();
  await expect(page.locator('#repeat')).toHaveAttribute('aria-pressed', 'true');
  await action(page, 'mute').click();
  await expect.poll(async () => (await audioState(page)).muted).toBe(true);
  await action(page, 'mute').click();
  await expect.poll(async () => (await audioState(page)).muted).toBe(false);
});

test('searches and preserves favorites, recent playback, and playlists after refresh', async ({ page }) => {
  await page.goto('/#songs');
  const historyTrack = '历史样本 录音室';
  await page.locator('#import-files').setInputFiles({
    name: '录音室 - 历史样本.wav', mimeType: 'audio/wav', buffer: testWav(4),
  });
  await row(page, historyTrack).getByRole('button', { name: historyTrack }).press('Enter');
  await expect(title(page)).toHaveText('历史样本');
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(0.1);
  const search = page.getByRole('searchbox', { name: '搜索' });
  await search.fill('Blue Static');
  await expect(page.getByRole('heading', { name: '搜索结果' })).toBeVisible();
  await expect(row(page, 'Blue Static Nova Lane')).toBeVisible();
  await expect(page.locator('#content tbody tr')).toHaveCount(1);
  await action(row(page, 'Blue Static Nova Lane'), 'favorite').press('Enter');

  await nav(page, 'favorites').press('Enter');
  await expect(row(page, 'Blue Static Nova Lane')).toBeVisible();
  await nav(page, 'history').press('Enter');
  await expect(row(page, historyTrack)).toBeVisible();
  await nav(page, 'favorites').press('Enter');
  await page.locator('.add-playlist').press('Enter');
  const dialog = page.locator('#dialog');
  await dialog.getByRole('textbox').fill('夜读歌单');
  await dialog.locator('button[type="submit"]').press('Enter');
  await expect(page.getByRole('heading', { name: '夜读歌单' })).toBeVisible();

  await nav(page, 'favorites').press('Enter');
  await action(row(page, 'Blue Static Nova Lane'), 'track-menu').press('Enter');
  await dialog.getByRole('button', { name: '添加到歌单' }).press('Enter');
  await dialog.getByRole('button', { name: '夜读歌单' }).press('Enter');
  await page.locator('#playlist-nav').getByRole('button', { name: '夜读歌单' }).press('Enter');
  await expect(row(page, 'Blue Static Nova Lane')).toBeVisible();

  await page.reload();
  await expect(row(page, 'Blue Static Nova Lane')).toBeVisible();
  await nav(page, 'favorites').press('Enter');
  await expect(row(page, 'Blue Static Nova Lane')).toBeVisible();
  await nav(page, 'history').press('Enter');
  await expect(row(page, historyTrack)).toBeVisible();
});

test('adds a track next in queue, advances, reorders, and removes an entry', async ({ page }) => {
  await playDemo(page);
  await nav(page, 'songs').click();
  await action(row(page, 'Last Light Mira Kos'), 'track-menu').click();
  await page.locator('#dialog').getByRole('button', { name: '下一首播放' }).click();
  await expect(page.locator('#now .queue-row').nth(1)).toContainText('Last Light');
  await page.getByRole('button', { name: '下一首' }).click();
  await expect(title(page)).toHaveText('Last Light');
  const queue = page.locator('#now .queue-row');
  await action(queue.nth(1), 'queue-menu').click();
  await page.locator('#dialog').getByRole('button', { name: '上移' }).click();
  await expect(queue.first()).toContainText('Last Light');
  await expect(title(page)).toHaveText('Last Light');

  const blue = queue.filter({ hasText: 'Blue Static' });
  await action(blue, 'queue-menu').click();
  await page.locator('#dialog').getByRole('button', { name: '移出队列' }).click();
  await expect(blue).toHaveCount(0);
});

function testWav(seconds) {
  const rate = 8000;
  const sampleCount = rate * seconds;
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 262 * i / rate) * 2000), 44 + i * 2);
  }
  return buffer;
}

test('imports local WAV and timed LRC, then plays both after browser reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '你的云端唱片室' })).toBeVisible();
  await page.locator('#import-files').setInputFiles([
    { name: '录音室 - 雨中.wav', mimeType: 'audio/wav', buffer: testWav(8) },
    { name: '录音室 - 雨中.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:00.00]第一行歌词\n[00:04.00]第二行歌词\n') },
  ]);
  await nav(page, 'songs').click();
  const imported = row(page, '雨中 录音室');
  await expect(imported).toBeVisible();
  await page.reload();
  await expect(imported).toBeVisible();
  await imported.getByRole('button', { name: '雨中 录音室' }).click();
  await expect(title(page)).toHaveText('雨中');
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(0.1);
  await expect.poll(async () => (await audioState(page)).duration).toBe(8);
  await page.locator('#now').getByRole('button', { name: '歌词', exact: true }).click();
  await page.locator('#now').getByRole('button', { name: '第二行歌词' }).click();
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThanOrEqual(4);
});

test('Baidu source explains missing app credentials', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '连接网盘' }).click();
  await expect(page.getByRole('heading', { name: '音乐来源' })).toBeVisible();
  await expect(page.getByText('百度网盘', { exact: true })).toBeVisible();
  await action(page, 'baidu-source').click();
  const dialog = page.locator('#dialog');
  await expect(dialog.getByText(/首次连接需要百度开放平台应用/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '在网页配置百度应用' })).toBeVisible();
});

test('mobile navigation and player work without horizontal overflow @mobile', async ({ page }) => {
  await playDemo(page);
  expect(await page.locator('body').evaluate((body) => body.scrollWidth)).toBeLessThanOrEqual(412);
  await page.getByRole('button', { name: '菜单' }).click();
  await nav(page, 'songs').click();
  await expect(page.getByRole('heading', { name: '全部歌曲' })).toBeVisible();
  await expect(page.locator('#sidebar')).toBeHidden();
  expect(await page.locator('body').evaluate((body) => body.scrollWidth)).toBeLessThanOrEqual(412);
  await action(page.locator('.player-options'), 'queue-panel').click();
  await expect(page.locator('#now')).toBeVisible();
});

test('demo files support HTTP byte ranges for browser seeking', async ({ request }) => {
  const path = '/assets/demo-1.m4a';
  const partial = await request.get(path, { headers: { Range: 'bytes=32-63' } });
  expect(partial.status()).toBe(206);
  expect(partial.headers()['content-range']).toMatch(/^bytes 32-63\/\d+$/);
  expect(partial.headers()['accept-ranges']).toBe('bytes');
  expect(partial.headers()['content-type']).toContain('audio/mp4');
  expect(await partial.body()).toHaveLength(32);
  const invalid = await request.head(path, { headers: { Range: 'bytes=9999999999-' } });
  expect(invalid.status()).toBe(416);
  expect(invalid.headers()['content-range']).toMatch(/^bytes \*\/\d+$/);
});

test('browses, plays, seeks to cloud lyrics, and scans a connected Baidu folder', async ({ page }) => {
  const folder = '/我的 音乐';
  const requestedPaths = [];
  await page.route('**/api/baidu/status', (route) => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    requestedPaths.push(path);
    return route.fulfill({ json: { items: path === '/' ? [
      { id: '1', folder: true, name: '我的 音乐', path: folder },
    ] : [
      { id: '2', folder: false, name: '云端录音 - 雨夜.m4a', path: folder + '/云端录音 - 雨夜.m4a', streamUrl: '/api/baidu/stream?id=2' },
      { id: '3', folder: false, name: '云端录音 - 雨夜.lrc', path: folder + '/云端录音 - 雨夜.lrc', streamUrl: '/api/baidu/stream?id=3' },
    ] } });
  });
  await page.route('**/api/baidu/stream?id=2', async (route) => {
    const wave = testWav(8);
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ contentType: 'audio/wav', body: wave });
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), wave.length - 1) : wave.length - 1;
    return route.fulfill({
      status: 206,
      contentType: 'audio/wav',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + start + '-' + end + '/' + wave.length },
      body: wave.subarray(start, end + 1),
    });
  });
  await page.route('**/api/baidu/stream?id=3', (route) =>
    route.fulfill({ contentType: 'text/plain; charset=utf-8', body: '[00:00.00]雨夜开场\n[00:04.00]云端副歌\n' }));

  await page.goto('/');
  await page.getByRole('button', { name: '连接网盘' }).click();
  await action(page, 'baidu-source').click();
  await expect(page.getByRole('heading', { name: '百度网盘' })).toBeVisible();
  await page.getByRole('button', { name: '我的 音乐' }).click();
  await expect(row(page, '雨夜 云端录音')).toBeVisible();
  expect(requestedPaths).toEqual(['/', folder]);
  await row(page, '雨夜 云端录音').getByRole('button', { name: '雨夜 云端录音' }).click();
  await expect(title(page)).toHaveText('雨夜');
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(0.1);
  await page.locator('#now').getByRole('button', { name: '歌词', exact: true }).click();
  await page.locator('#now').getByRole('button', { name: '云端副歌' }).click();
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThanOrEqual(4);
  await page.getByRole('button', { name: '扫描并加入曲库' }).click();
  await expect(page.getByRole('status').filter({ hasText: '扫描完成' })).toBeVisible();
  await nav(page, 'songs').click();
  await expect(row(page, '雨夜 云端录音')).toBeVisible();
});

test('exports and restores favorites and theme across browser profiles', async ({ page, browser }) => {
  await page.goto('/');
  await nav(page, 'songs').click();
  await action(row(page, 'Blue Static Nova Lane'), 'favorite').click();
  await nav(page, 'settings').click();
  await page.getByRole('button', { name: '雾紫' }).click();
  await expect(page.getByRole('button', { name: '雾紫' })).toHaveClass(/active/);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出备份' }).click(),
  ]);
  const context = await browser.newContext();
  try {
    const restored = await context.newPage();
    await restored.goto(page.url());
    await expect(restored.getByRole('heading', { name: '设置' })).toBeVisible();
    await restored.locator('#restore-file').setInputFiles(await download.path());
    await expect(restored.getByRole('button', { name: '雾紫' })).toHaveClass(/active/);
    await nav(restored, 'favorites').click();
    await expect(row(restored, 'Blue Static Nova Lane')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('automatically advances at track end and honors single-track repeat', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '你的云端唱片室' })).toBeVisible();
  await page.locator('#import-files').setInputFiles([
    { name: 'Auto - 第一首.wav', mimeType: 'audio/wav', buffer: testWav(2) },
    { name: 'Auto - 第二首.wav', mimeType: 'audio/wav', buffer: testWav(2) },
  ]);
  await nav(page, 'songs').click();
  await page.locator('#sort').selectOption('default');
  await row(page, '第一首 Auto').getByRole('button', { name: '第一首 Auto' }).click();
  await expect(title(page)).toHaveText('第一首');
  await expect(title(page)).toHaveText('第二首', { timeout: 7000 });
  await page.locator('#repeat').click();
  await page.locator('#repeat').click();
  await expect(page.locator('#repeat')).toHaveAttribute('title', '单曲循环');
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(1);
  await expect.poll(async () => (await audioState(page)).time).toBeLessThan(0.9);
  await expect(title(page)).toHaveText('第二首');
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
});

test('restores the active queue entry and progress in a paused state after reload', async ({ page }) => {
  await playDemo(page);
  await page.getByRole('button', { name: '下一首' }).click();
  await expect(title(page)).toHaveText('Blue Static');
  await expect.poll(async () => (await audioState(page)).duration).toBeGreaterThan(140);
  const seek = page.getByRole('slider', { name: '播放进度' });
  const box = await seek.boundingBox();
  await seek.click({ position: { x: Math.floor(box.width * .35), y: Math.round(box.height / 2) } });
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(40);
  const progress = (await audioState(page)).time;

  await page.reload();
  await expect(title(page)).toHaveText('Blue Static');
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  await expect.poll(async () => Math.abs((await audioState(page)).time - progress)).toBeLessThan(1);
});

test('keeps the queue when disabling automatic position restoration and saves the preference in backups', async ({ page }) => {
  await playDemo(page);
  await page.getByRole('button', { name: '下一首', exact: true }).press('Enter');
  await expect(title(page)).toHaveText('Blue Static');
  await expect.poll(async () => (await audioState(page)).duration).toBeGreaterThan(140);
  const queue = page.locator('#now .queue-row .track-name');
  const order = await queue.allTextContents();
  expect(order).toContain('Blue Static');

  const seek = page.getByRole('slider', { name: '播放进度' });
  await seek.fill('350');
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(40);
  await nav(page, 'settings').press('Enter');
  const restore = page.getByRole('checkbox', { name: '打开播放器时恢复上次播放进度', exact: true });
  await expect(restore).toBeChecked();
  await restore.uncheck();
  expect((await audioState(page)).time).toBeGreaterThan(40);
  const [backup] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出备份' }).press('Enter'),
  ]);

  await page.reload();
  await expect(restore).not.toBeChecked();
  await expect(title(page)).toHaveText('Blue Static');
  await expect(queue).toHaveText(order);
  await expect.poll(async () => (await audioState(page)).duration).toBeGreaterThan(140);
  expect(await audioState(page)).toMatchObject({ time: 0, paused: true });

  await restore.check();
  await seek.fill('300');
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(40);
  const position = (await audioState(page)).time;
  await page.reload();
  await expect(restore).toBeChecked();
  await expect(title(page)).toHaveText('Blue Static');
  await expect(queue).toHaveText(order);
  await expect.poll(async () => Math.abs((await audioState(page)).time - position)).toBeLessThan(1);

  await page.locator('#restore-file').setInputFiles(await backup.path());
  await expect(restore).not.toBeChecked();
});

test('only pauses on a hidden page after opting in and keeps the current playback position', async ({ page }) => {
  const visibility = hidden => page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await playDemo(page);
  await nav(page, 'settings').press('Enter');
  const setting = page.getByRole('checkbox', { name: '切到后台时暂停播放', exact: true });
  await expect(setting).not.toBeChecked();
  const beforeHidden = (await audioState(page)).time;
  await visibility(true);
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(beforeHidden + 0.1);
  await visibility(false);

  await setting.check();
  const queue = await page.locator('#now .queue-row .track-name').allTextContents();
  const originalSource = await page.locator('#audio').evaluate(audio => audio.currentSrc);
  const beforePause = (await audioState(page)).time;
  await visibility(true);
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  expect((await audioState(page)).time).toBeGreaterThanOrEqual(beforePause);
  await expect(title(page)).toHaveText('After Hours');
  expect(await page.locator('#audio').evaluate(audio => audio.currentSrc)).toBe(originalSource);
  await expect(page.locator('#now .queue-row .track-name')).toHaveText(queue);

  await visibility(false);
  expect((await audioState(page)).paused).toBe(true);
  await toggle(page).press('Enter');
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  await page.reload();
  await expect(setting).toBeChecked();
});

test('uploads a WebDAV backup and merges a shared playlist without losing local entries', async ({ page }) => {
  const source = { id: 'webdav-test', name: '家庭云盘', type: 'webdav' };
  let uploaded;
  await page.route('**/api/sources', (route) => route.fulfill({ json: { sources: [source] } }));
  await page.route('**/api/sources/webdav-test/list?*', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/sources/webdav-test/backup', (route) => {
    if (route.request().method() === 'PUT') {
      uploaded = route.request().postDataJSON();
      return route.fulfill({ json: { saved: true } });
    }
    return route.fulfill({
      json: {
        version: 1,
        playlists: [
          { ...uploaded.playlists[0], tracks: ['demo-1', 'demo-2'] },
          { id: 'remote-list', name: '云端歌单二号', tracks: ['demo-3'] },
        ],
        favorites: ['demo-2'],
        tracks: [],
      },
    });
  });

  await page.goto('/');
  await page.locator('.add-playlist').click();
  const dialog = page.locator('#dialog');
  await dialog.getByRole('textbox').fill('跨设备歌单');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('heading', { name: '跨设备歌单' })).toBeVisible();

  await nav(page, 'songs').click();
  const first = row(page, 'After Hours Velvet Atlas');
  await action(first, 'favorite').click();
  await action(first, 'track-menu').click();
  await dialog.getByRole('button', { name: '添加到歌单' }).click();
  await dialog.getByRole('button', { name: '跨设备歌单' }).click();

  await nav(page, 'sources').click();
  await page.getByRole('button', { name: /^家庭云盘/ }).click();
  await page.getByRole('button', { name: '云端歌单' }).click();
  await dialog.getByRole('button', { name: '上传歌单' }).click();
  await dialog.getByRole('button', { name: '确认' }).click();
  await expect(dialog.getByRole('status')).toHaveText('歌单已上传。');
  expect(uploaded).toMatchObject({
    version: 1,
    playlists: [{ name: '跨设备歌单', tracks: ['demo-1'] }],
    favorites: ['demo-1'],
  });

  await dialog.getByRole('button', { name: '下载并合并' }).click();
  await expect(dialog.getByRole('status')).toHaveText('云端歌单已合并。');
  await dialog.getByRole('button', { name: '关闭' }).click();
  await page.locator('#playlist-nav').getByRole('button', { name: '跨设备歌单' }).click();
  await expect(row(page, 'After Hours Velvet Atlas')).toHaveCount(1);
  await expect(row(page, 'Blue Static Nova Lane')).toBeVisible();

  await page.locator('#playlist-nav').getByRole('button', { name: '云端歌单二号' }).click();
  await expect(row(page, 'Soft Signal Mira Kos')).toBeVisible();
  await nav(page, 'favorites').click();
  await expect(row(page, 'After Hours Velvet Atlas')).toBeVisible();
  await expect(row(page, 'Blue Static Nova Lane')).toBeVisible();
});

test('plays a saved cloud track after reload while the source stream is unavailable', async ({ page }) => {
  let sourceReachable = true;
  let streamRequests = 0;
  const streamUrl = '/api/baidu/stream?id=4';
  await page.route('**/api/baidu/status', (route) => route.fulfill({
    json: { configured: true, connected: sourceReachable },
  }));
  await page.route('**/api/baidu/list?*', (route) => route.fulfill({
    json: { items: [{ id: '4', folder: false, name: '云端录音 - 离线伴奏.wav', path: '/离线伴奏.wav', streamUrl }] },
  }));
  await page.route('**' + streamUrl, (route) => {
    streamRequests += 1;
    if (!sourceReachable) return route.abort('internetdisconnected');
    return route.fulfill({ contentType: 'audio/wav', body: testWav(8) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '连接网盘' }).click();
  await action(page, 'baidu-source').click();
  const track = row(page, '离线伴奏 云端录音');
  await action(track, 'track-menu').click();
  const dialog = page.locator('#dialog');
  await dialog.getByRole('button', { name: '离线保存' }).click();
  await expect(page.getByRole('status').filter({ hasText: '音频已保存到离线歌曲' })).toBeVisible();
  expect(streamRequests).toBe(1);

  await nav(page, 'offline').click();
  await expect(page.getByRole('heading', { name: '已下载音乐' })).toBeVisible();
  await expect(track).toBeVisible();
  sourceReachable = false;

  await page.reload();
  await expect(track).toBeVisible();
  await track.getByRole('button', { name: '离线伴奏 云端录音' }).click();
  await expect(title(page)).toHaveText('离线伴奏');
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(0.1);
  expect(await page.locator('#audio').evaluate((audio) => audio.currentSrc)).toMatch(/^blob:/);
  expect(streamRequests).toBe(1);

  await action(track, 'track-menu').click();
  await dialog.getByRole('button', { name: '删除离线副本' }).click();
  await expect(track).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '已下载音乐' })).toBeVisible();
  await expect(page.getByText('缓存或下载完成的歌曲会显示在这里。')).toBeVisible();
});

test('adds an authenticated Kodi server, browses its library and plays a real WAV through the Kodi proxy', async ({ page }) => {
  const wav = testWav(12);
  const auth = 'Basic ' + Buffer.from('fixture:secret').toString('base64');
  const vfsPath = '/vfs/' + encodeURIComponent('/music/蓝色夜晚.wav');
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== auth) return res.writeHead(401).end();
    if (req.url === vfsPath) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(wav.length - 1, Number(match[2])) : wav.length - 1;
      const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
      if (match) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + wav.length;
      return res.writeHead(match ? 206 : 200, headers).end(req.method === 'HEAD' ? undefined : wav.subarray(start, end + 1));
    }
    if (req.url !== '/jsonrpc' || req.method !== 'POST') return res.writeHead(404).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    const { id, method } = JSON.parse(body);
    const result = method === 'AudioLibrary.GetAlbums' ? { albums: [{ albumid: 1, label: 'Kodi 专辑' }] } :
      { songs: [{ songid: 1, title: '蓝色夜晚', artist: ['Kodi 艺人'], album: 'Kodi 专辑', duration: 12, file: '/music/蓝色夜晚.wav' }] };
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id, result: { ...result, limits: { start: 0, end: 1, total: 1 } } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await page.goto('/');
    await nav(page, 'sources').click();
    await action(page, 'add-source').click();
    const dialog = page.locator('#dialog');
    await dialog.getByLabel('协议').selectOption('kodi');
    await dialog.getByLabel('名称').fill('我的 Kodi');
    await dialog.getByLabel('服务地址').fill('http://127.0.0.1:' + server.address().port);
    await dialog.getByLabel('用户名').fill('fixture');
    await dialog.getByLabel('密码').fill('secret');
    await dialog.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('button', { name: 'Kodi 专辑', exact: true }).click();
    await page.getByRole('button', { name: '蓝色夜晚 Kodi 艺人', exact: true }).click();
    await expect(title(page)).toHaveText('蓝色夜晚');
    await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(0.1);
    await expect.poll(async () => (await audioState(page)).duration).toBe(12);
    await page.locator('#seek').fill('650');
    await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(7);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('keeps the visible screen awake only during playback, and remembers the setting', async ({ page }) => {
  await page.addInitScript(() => {
    window.screenWakeEvents = [];
    Object.defineProperty(navigator, 'wakeLock', { value: {
      async request(type) {
        window.screenWakeEvents.push(type);
        const sentinel = new EventTarget();
        sentinel.released = false;
        sentinel.release = async () => {
          if (sentinel.released) return;
          sentinel.released = true;
          window.screenWakeEvents.push('release');
          sentinel.dispatchEvent(new Event('release'));
        };
        return sentinel;
      },
    } });
  });
  await page.goto('/');
  await nav(page, 'settings').click();
  const keepAwake = page.getByRole('checkbox', { name: '播放时保持屏幕常亮' });
  await keepAwake.check();
  expect(await page.evaluate(() => window.screenWakeEvents)).toEqual([]);
  await toggle(page).click();
  await expect(page.locator('#wake-lock-status')).toHaveText('屏幕常亮已启用。');
  await toggle(page).click();
  await expect.poll(() => page.evaluate(() => window.screenWakeEvents)).toEqual(['screen', 'release']);
  await page.reload();
  await expect(keepAwake).toBeChecked();
  expect(await page.evaluate(() => window.screenWakeEvents)).toEqual([]);
});

test('automatically syncs WebDAV edits between browser profiles and retries an ETag conflict', async ({ page, browser, baseURL }) => {
  test.setTimeout(45_000);
  let stored;
  let version = 0;
  let concurrentChange = false;
  const writes = [];
  const upstreamErrors = [];
  const etag = () => '"rev-' + version + '"';
  async function serveDav(request, response) {
    if (request.method === 'PROPFIND' && request.url === '/music/') {
      request.resume();
      return response.writeHead(207, { 'Content-Type': 'application/xml' }).end(
        '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/music/</d:href><d:propstat>' +
        '<d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>' +
        '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
      );
    }
    if (request.url !== '/music/groovebox-playlists.json') return response.writeHead(404).end();
    if (request.method === 'GET') {
      if (!stored) return response.writeHead(404).end();
      return response.writeHead(200, { 'Content-Type': 'application/json', ETag: etag() }).end(JSON.stringify(stored));
    }
    if (request.method !== 'PUT') return response.writeHead(405).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const next = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const match = request.headers['if-match'];
    const absent = request.headers['if-none-match'];
    writes.push({ match, absent });
    if (concurrentChange) {
      concurrentChange = false;
      stored.favorites.push('demo-3');
      version++;
    }
    if (stored ? match !== etag() : absent !== '*') return response.writeHead(412).end();
    stored = next;
    version++;
    return response.writeHead(version === 1 ? 201 : 204).end();
  }
  const dav = createServer((request, response) => {
    void serveDav(request, response).catch(error => {
      upstreamErrors.push(error);
      response.writeHead(500).end();
    });
  });
  dav.listen(0, '127.0.0.1');
  await once(dav, 'listening');
  const sourceURL = 'http://127.0.0.1:' + dav.address().port + '/music';
  const secondContext = await browser.newContext({ baseURL });
  const dialog = (tab) => tab.locator('#dialog');
  const sidebarList = (tab, text) => tab.locator('#playlist-nav').getByRole('button', { name: text });
  const original = '自动同步歌单';
  const renamed = '云端修改后的歌单';

  async function addTrack(tab, song, playlist) {
    await nav(tab, 'songs').click();
    await action(row(tab, song), 'track-menu').click();
    await dialog(tab).getByRole('button', { name: '添加到歌单' }).click();
    await dialog(tab).getByRole('button', { name: playlist }).click();
  }

  async function connectAndEnable(tab) {
    await nav(tab, 'sources').click();
    await action(tab, 'add-source').click();
    await dialog(tab).getByLabel('名称').fill('同步测试 WebDAV');
    await dialog(tab).getByLabel('服务地址').fill(sourceURL);
    await dialog(tab).getByRole('button', { name: '连接', exact: true }).click();
    await expect(tab.getByRole('heading', { name: '同步测试 WebDAV' })).toBeVisible();
    await tab.getByRole('button', { name: '云端歌单' }).click();
    await action(dialog(tab), 'auto-sync-enable').click();
    await expect(dialog(tab).getByRole('status')).toHaveText('已同步歌单和收藏。');
    await dialog(tab).getByRole('button', { name: '关闭', exact: true }).click();
  }

  try {
    await page.goto('/');
    await page.locator('.add-playlist').click();
    await dialog(page).getByRole('textbox').fill(original);
    await dialog(page).getByRole('button', { name: '创建' }).click();
    await expect(sidebarList(page, original)).toBeVisible();
    await addTrack(page, 'After Hours Velvet Atlas', original);
    await connectAndEnable(page);
    expect(writes).toEqual([{ match: undefined, absent: '*' }]);

    const second = await secondContext.newPage();
    await second.goto('/');
    await expect(sidebarList(second, original)).toHaveCount(0);
    await connectAndEnable(second);
    await sidebarList(second, original).click();
    await expect(row(second, 'After Hours Velvet Atlas')).toBeVisible();

    concurrentChange = true;
    await addTrack(page, 'Blue Static Nova Lane', original);
    await expect.poll(() => stored.playlists[0].tracks).toEqual(['demo-1', 'demo-2']);
    expect(writes.slice(-2)).toEqual([
      { match: '"rev-1"', absent: undefined },
      { match: '"rev-2"', absent: undefined },
    ]);
    await nav(page, 'favorites').click();
    await expect(row(page, 'Soft Signal Mira Kos')).toBeVisible();

    await second.evaluate(() => dispatchEvent(new Event('online')));
    await expect(row(second, 'Blue Static Nova Lane')).toBeVisible();
    await second.getByRole('button', { name: '重命名' }).click();
    await dialog(second).getByRole('textbox').fill(renamed);
    await dialog(second).getByRole('button', { name: '保存' }).click();
    await expect(sidebarList(second, renamed)).toBeVisible();
    await action(row(second, 'After Hours Velvet Atlas'), 'track-menu').click();
    await dialog(second).getByRole('button', { name: '从歌单移除' }).click();
    await expect.poll(() => stored.playlists[0]).toMatchObject({ name: renamed, tracks: ['demo-2'] });

    await page.reload();
    await sidebarList(page, renamed).click();
    await expect(row(page, 'Blue Static Nova Lane')).toBeVisible();
    await expect(row(page, 'After Hours Velvet Atlas')).toHaveCount(0);
    await expect(sidebarList(page, original)).toHaveCount(0);
    await nav(page, 'sources').click();
    await page.getByRole('button', { name: /^同步测试 WebDAV/ }).click();
    await page.getByRole('button', { name: '云端歌单' }).click();
    await expect(action(dialog(page), 'auto-sync-disable')).toBeVisible();
    expect(upstreamErrors).toEqual([]);
  } finally {
    await secondContext.close();
    dav.closeAllConnections();
    await new Promise(resolve => dav.close(resolve));
  }
});
