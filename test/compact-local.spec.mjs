import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('hides local sources but preserves imported songs and restores settings across profiles', async ({ page, browser }) => {
  await page.goto('/#sources');
  const localFile = page.locator('.source-card[data-action="import-files"]');
  const localFolder = page.locator('.source-card[data-action="import-folder"]');
  await expect(localFile).toBeVisible();
  await expect(localFolder).toBeVisible();
  await page.locator('#import-files').setInputFiles({
    name: 'Local Visibility Sample.m4a',
    mimeType: 'audio/mp4',
    buffer: await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url)),
  });
  const sample = page.locator('#content').getByRole('button', { name: /Local Visibility Sample/ });
  await expect(sample).toBeVisible();
  await page.goto('/#sources');
  await expect(localFile).toContainText('1 首已导入');

  await page.goto('/#settings');
  const visibility = page.getByRole('checkbox', { name: '显示本地音乐来源' });
  const compact = page.getByRole('checkbox', { name: '使用迷你播放器' });
  await expect(visibility).toBeChecked();
  await expect(compact).not.toBeChecked();
  await visibility.press('Space');
  await compact.press('Space');
  await page.reload();
  await expect(visibility).not.toBeChecked();
  await expect(compact).toBeChecked();

  const [backup] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出备份' }).press('Enter'),
  ]);
  const restoredContext = await browser.newContext();
  try {
    const restored = await restoredContext.newPage();
    await restored.goto(page.url());
    await restored.locator('#restore-file').setInputFiles(await backup.path());
    await expect(restored.getByRole('checkbox', { name: '显示本地音乐来源' })).not.toBeChecked();
    await expect(restored.getByRole('checkbox', { name: '使用迷你播放器' })).toBeChecked();
    await expect(restored.locator('html')).toHaveAttribute('data-compact-player', '');
  } finally {
    await restoredContext.close();
  }

  await page.goto('/#sources');
  await expect(localFile).toHaveCount(0);
  await expect(localFolder).toHaveCount(0);
  await expect(page.locator('.source-card[data-action="baidu-source"]')).toBeVisible();
  await page.goto('/#songs');
  await expect(sample).toBeVisible();
  await page.goto('/#settings');
  await visibility.press('Space');
  await page.goto('/#sources');
  await expect(localFile).toContainText('1 首已导入');
  await expect(localFolder).toBeVisible();
});

test('switches to the compact player while audio is playing', async ({ page }) => {
  await page.goto('/');
  const player = page.locator('footer.player');
  const originalHeight = await player.evaluate(element => element.offsetHeight);
  await page.getByRole('button', { name: '立即播放' }).press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await page.goto('/#settings');
  const compact = page.getByRole('checkbox', { name: '使用迷你播放器' });
  await compact.press('Space');
  expect(await player.evaluate(element => element.offsetHeight)).toBeLessThan(originalHeight);
  await expect(page.locator('#player-title')).toHaveText('After Hours');
  expect(await audio.evaluate(element => element.paused)).toBe(false);
  await expect(player.getByRole('slider', { name: '播放进度' })).toBeVisible();
  await player.getByRole('button', { name: '下一首' }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText('Blue Static');
  await compact.press('Space');
  expect(await player.evaluate(element => element.offsetHeight)).toBe(originalHeight);
  await expect(page.locator('#player-title')).toHaveText('Blue Static');
});

test('compact player fits narrow mobile screens and retains transport and queue @mobile', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/#settings');
  const player = page.locator('footer.player');
  const originalHeight = await player.evaluate(element => element.offsetHeight);
  await page.getByRole('checkbox', { name: '使用迷你播放器' }).check();
  expect(await player.evaluate(element => element.offsetHeight)).toBeLessThan(originalHeight);
  expect(await player.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(player.getByRole('slider', { name: '播放进度' })).toBeVisible();
  await player.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('#player-title')).toHaveText('After Hours');
  await player.getByRole('button', { name: '下一首' }).click();
  await expect(page.locator('#player-title')).toHaveText('Blue Static');
  await player.getByRole('button', { name: '播放队列' }).click();
  await expect(page.locator('#now .queue-row').first()).toBeVisible();
  await player.getByRole('button', { name: '定位当前歌曲', exact: true }).tap();
  await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Blue Static Nova Lane', exact: true }) })).toHaveAttribute('aria-current', 'true');
});
