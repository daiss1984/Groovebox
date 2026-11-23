import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('changes lyric weights across queue preview, lyrics panel and immersive playback, and restores the setting', async ({ page }) => {
  await page.goto('/#songs');
  const sample = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const lyrics = '[00:00.00]安静开场\n[00:03.00]<00:03.00>远山 <00:03.45>微光\n[00:09.00]尾声';
  await page.locator('#import-files').setInputFiles([
    { name: '测试艺人 - 字重测试.m4a', mimeType: 'audio/mp4', buffer: sample },
    { name: '测试艺人 - 字重测试.lrc', mimeType: 'text/plain', buffer: Buffer.from(lyrics) },
  ]);
  await page.locator('#content').getByRole('button', { name: '字重测试 测试艺人', exact: true }).press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => audio.evaluate(element => element.paused)).toBe(true);
  const now = page.locator('#now');
  const tab = now.getByRole('button', { name: '歌词', exact: true });
  const current = now.locator('.lyric-line.current');
  await tab.press('Enter');
  await expect(current).toHaveCSS('font-weight', '740');
  await page.goto('/#settings');
  const setting = page.getByRole('combobox', { name: '歌词字体粗细', exact: true });
  await expect(setting).toHaveValue('default');
  await setting.selectOption('medium');
  await expect(current).toHaveCSS('font-weight', '550');
  await expect(now.getByRole('button', { name: '尾声' })).toHaveCSS('font-weight', '550');

  await audio.evaluate(element => { element.currentTime = 3.7; });
  await expect(current.locator('.current-word')).toHaveText('微光');
  await expect(current.locator('.current-word')).toHaveCSS('text-decoration-line', 'underline');
  await expect(current.locator('.current-word')).toHaveCSS('font-weight', '550');
  await now.getByRole('button', { name: '播放队列', exact: true }).press('Enter');
  await expect(now.locator('[data-lyric-preview]')).toHaveText('远山 微光');
  await expect(now.locator('[data-lyric-preview]')).toHaveCSS('font-weight', '550');

  await page.locator('#player-art').press('Enter');
  const immersive = page.getByRole('region', { name: '沉浸播放', exact: true });
  await expect(immersive.locator('.current-word')).toHaveCSS('font-weight', '550');
  await immersive.getByRole('button', { name: '关闭沉浸播放', exact: true }).press('Enter');
  const backupReady = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份', exact: true }).press('Enter');
  const backup = await (await backupReady).path();
  expect(JSON.parse(await readFile(backup, 'utf8')).settings.lyricWeight).toBe('medium');
  await page.reload();
  await expect(setting).toHaveValue('medium');
  await setting.selectOption('bold');
  await expect(page.locator('html')).toHaveAttribute('data-lyric-weight', 'bold');
  await page.locator('#restore-file').setInputFiles(backup);
  await expect(setting).toHaveValue('medium');
  await expect(page.locator('html')).toHaveAttribute('data-lyric-weight', 'medium');
});
