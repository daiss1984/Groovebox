import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const title = '一段很长的音乐标题'.repeat(8);
const artist = '艺人名称'.repeat(12);
const trackId = 'baidu:65874';
const placement = page => page.locator('#content .track-main').filter({ hasText: title });
const lines = locator => locator.evaluate(element => {
  const range = document.createRange();
  range.selectNodeContents(element);
  return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size;
});

async function openFixture(page) {
  await page.addInitScript(({ title, artist, trackId }) => {
    const key = 'groovebox.state.v1';
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({
      settings: { demos: false },
      tracks: [{ id: trackId, title, artist, provider: 'baidu', src: '/api/baidu/stream?id=65874' }],
    }));
  }, { title, artist, trackId });
  await page.route('**/api/baidu/stream?id=65874', async route => {
    const response = await route.fetch({ url: new URL('/assets/demo-1.m4a', route.request().url()).href });
    await route.fulfill({ response });
  });
  await page.goto('/#songs');
}

test('wraps long titles in narrow lists and the queue, preserves playback and restores the display setting', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await openFixture(page);
  const row = placement(page);
  const name = row.locator('.track-name');
  await expect(name).toHaveText(title);
  expect(await lines(name)).toBe(1);
  await page.goto('/#settings');
  const setting = page.getByRole('checkbox', { name: '多行显示歌曲标题', exact: true });
  await expect(setting).not.toBeChecked();
  await setting.check();
  await page.goto('/#songs');
  await expect.poll(() => lines(name)).toBeGreaterThan(1);
  expect(await lines(row.locator('.track-artist'))).toBe(1);
  const overflow = () => page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(await overflow()).toBe(false);

  await row.press('Enter');
  await expect.poll(() => page.locator('#audio').evaluate(el => el.currentTime)).toBeGreaterThan(0.1);
  await page.locator('.player [data-action="queue-panel"]').press('Enter');
  const queue = page.locator('.queue-row.current');
  await expect(queue.locator('.track-name')).toHaveText(title);
  await expect.poll(() => lines(queue.locator('.track-name'))).toBeGreaterThan(1);
  expect(await overflow()).toBe(false);
  await page.getByRole('button', { name: '关闭正在播放', exact: true }).press('Enter');
  await page.reload();
  await expect.poll(() => lines(name)).toBeGreaterThan(1);

  await page.goto('/#settings');
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份', exact: true }).press('Enter');
  const file = await (await downloadReady).path();
  expect(JSON.parse(await readFile(file, 'utf8')).settings.multilineTrackTitles).toBe(true);
  await setting.uncheck();
  await page.goto('/#songs');
  expect(await lines(name)).toBe(1);
  await page.goto('/#settings');
  await page.locator('#restore-file').setInputFiles(file);
  await expect(setting).toBeChecked();
  await page.goto('/#songs');
  await expect.poll(() => lines(name)).toBeGreaterThan(1);
});

test('keeps touch playback available with wrapped titles @mobile', async ({ page }) => {
  await openFixture(page);
  await page.goto('/#settings');
  await page.getByRole('checkbox', { name: '多行显示歌曲标题', exact: true }).check();
  await page.goto('/#songs');
  const row = placement(page);
  await expect.poll(() => lines(row.locator('.track-name'))).toBeGreaterThan(1);
  await row.tap();
  await expect.poll(() => page.locator('#audio').evaluate(el => el.currentTime)).toBeGreaterThan(0.1);
});
