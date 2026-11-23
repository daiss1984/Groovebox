import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('blurs only inactive timed lyrics and still lets them be clicked to seek', async ({ page }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles([
    { name: 'Lyric Blur Sample.m4a', mimeType: 'audio/mp4', buffer: audio },
    {
      name: 'Lyric Blur Sample.lrc', mimeType: 'text/plain',
      buffer: Buffer.from('[00:00.00]第一句歌词\n[00:12.00]下一句歌词'),
    },
  ]);
  await page.getByRole('button', { name: /Lyric Blur Sample/ }).click();
  const player = page.locator('#player-toggle');
  await expect(player).toHaveAccessibleName('暂停');
  await player.click();

  const now = page.locator('#now');
  await now.getByRole('button', { name: '歌词', exact: true }).click();
  const first = now.getByRole('button', { name: '第一句歌词' });
  const next = now.getByRole('button', { name: '下一句歌词' });
  await expect(first).toHaveClass(/\bcurrent\b/);
  await expect(next).toHaveCSS('filter', 'none');

  await page.goto('/#settings');
  const blur = page.getByRole('checkbox', { name: '模糊未播放歌词' });
  await expect(blur).not.toBeChecked();
  await blur.check();
  await expect(first).toHaveCSS('filter', 'none');
  await expect(next).toHaveCSS('filter', 'blur(1.25px)');
  await next.focus();
  await expect(next).toHaveCSS('filter', 'none');
  await next.click();
  await expect(next).toHaveClass(/\bcurrent\b/);
  await expect(first).toHaveCSS('filter', 'blur(1.25px)');
  expect(await page.locator('#audio').evaluate(audio => audio.currentTime)).toBe(12);
  await blur.uncheck();
  await expect(first).toHaveCSS('filter', 'none');
});

test('changes the playback button and restores appearance choices across profiles', async ({ page, browser }) => {
  await page.goto('/#settings');
  const style = page.getByLabel('播放按钮样式');
  const player = page.locator('#player-toggle');
  await expect(style).toHaveValue('circle');
  await expect(player).toHaveCSS('border-radius', '50%');
  await style.selectOption('rounded');
  await expect(player).toHaveCSS('border-radius', '10px');
  await style.selectOption('outline');
  await expect(player).toHaveCSS('border-top-style', 'solid');
  await expect(player).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await player.click();
  await expect(player).toHaveAccessibleName('暂停');

  await page.getByRole('checkbox', { name: '模糊未播放歌词' }).check();
  await page.reload();
  await expect(style).toHaveValue('outline');
  await expect(page.getByRole('checkbox', { name: '模糊未播放歌词' })).toBeChecked();
  const [backup] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出备份', exact: true }).click(),
  ]);
  const context = await browser.newContext();
  try {
    const restored = await context.newPage();
    await restored.goto(page.url());
    const restoreFile = restored.locator('#restore-file');
    const restoredStyle = restored.getByLabel('播放按钮样式');
    const blur = restored.getByRole('checkbox', { name: '模糊未播放歌词' });
    await restoreFile.setInputFiles(await backup.path());
    await expect(restoredStyle).toHaveValue('outline');
    await expect(blur).toBeChecked();

    await restoreFile.setInputFiles({
      name: 'old-backup.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ version: 1, playlists: [], settings: { theme: 'copper' } })),
    });
    await expect(restoredStyle).toHaveValue('circle');
    await expect(blur).not.toBeChecked();
  } finally {
    await context.close();
  }
});
