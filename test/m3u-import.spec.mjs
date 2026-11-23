import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('imports a local M3U8 in entry order, skips unresolved entries and keeps its title after reload', async ({ page }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const first = '回归艺人 - 流水.m4a';
  const second = '回归艺人 - 云朵.m4a';
  const name = '夜间 & 播放';
  const file = Buffer.from([
    '#EXTM3U',
    '#PLAYLIST:' + name,
    '#EXTINF:-1,回归艺人 - 云朵',
    'C:\\Backup\\Artists\\' + second,
    '#EXTINF:-1,回归艺人 - 流水',
    'file:///old/path/' + encodeURIComponent(first),
    'https://playlist-fixture.invalid/' + encodeURIComponent(first),
    'missing.mp3',
    second,
  ].join('\n'));
  let externalRequests = 0;
  await page.route('**://playlist-fixture.invalid/**', route => {
    externalRequests++;
    return route.abort();
  });

  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles([first, second].map(name => ({ name, mimeType: 'audio/mp4', buffer: audio })));
  const content = page.locator('#content');
  await expect(content.getByRole('button', { name: '流水 回归艺人' })).toBeVisible();
  await expect(content.getByRole('button', { name: '云朵 回归艺人' })).toBeVisible();

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '导入 M3U 歌单' }).press('Enter'),
  ]);
  await chooser.setFiles({ name: '旧文件名.m3u8', mimeType: 'audio/x-mpegurl', buffer: file });
  await expect(content.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '已导入 2 首歌曲，跳过 3 项。' })).toBeVisible();
  await expect(content.locator('tbody .track-name')).toHaveText(['云朵', '流水']);

  await page.reload();
  await expect(content.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(content.locator('tbody .track-name')).toHaveText(['云朵', '流水']);
  expect(externalRequests).toBe(0);
});
