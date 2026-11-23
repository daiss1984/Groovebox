import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

async function scrollUnderToolbar(page, pinned) {
  const workspace = page.locator('.workspace');
  await workspace.evaluate(element => { element.scrollTop = 700; });
  const metrics = () => workspace.evaluate(element => ({ scrollTop: element.scrollTop,
    toolbarOffset: element.querySelector('.topbar').getBoundingClientRect().top - element.getBoundingClientRect().top }));
  await expect.poll(async () => (await metrics()).scrollTop).toBeGreaterThan(600);
  if (pinned) await expect.poll(async () => Math.abs((await metrics()).toolbarOffset)).toBeLessThan(2);
  else await expect.poll(async () => (await metrics()).toolbarOffset).toBeLessThan(-600);
}

test('keeps the top toolbar visible on request and restores the preference after refresh and backup', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    const tracks = Array.from({ length: 60 }, (_, index) => ({
      id: 'baidu:topbar-' + index, title: 'Track ' + index, artist: 'Test artist', album: 'Test album',
      provider: 'baidu', src: '/api/baidu/stream?id=' + index,
    }));
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ tracks, settings: { demos: false },
      favorites: tracks.map(track => track.id) }));
  });
  const option = page.getByRole('checkbox', { name: '滚动时固定顶部工具栏' });
  await page.goto('/#songs');
  await expect(page.getByRole('heading', { name: '全部歌曲' })).toBeVisible();
  await scrollUnderToolbar(page, true);
  await expect(page.locator('#search')).toBeInViewport();

  await page.goto('/#settings');
  await expect(option).toBeChecked();
  await option.press('Space');
  await expect(option).not.toBeChecked();
  await page.goto('/#songs');
  await scrollUnderToolbar(page, false);
  await expect(page.locator('#search')).not.toBeInViewport();

  await page.goto('/#settings');
  await page.reload();
  await expect(option).not.toBeChecked();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份' }).press('Enter');
  const backup = await readFile(await (await download).path());
  expect(JSON.parse(backup).settings.keepTopbarVisible).toBe(false);
  await option.press('Space');
  await expect(option).toBeChecked();
  await page.locator('#restore-file').setInputFiles({ name: 'topbar-backup.json', mimeType: 'application/json', buffer: backup });
  await expect(option).not.toBeChecked();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#songs');
  await scrollUnderToolbar(page, false);
  await page.goto('/#settings');
  await option.press('Space');
  await expect(option).toBeChecked();
  await page.goto('/#songs');
  await scrollUnderToolbar(page, true);
  await expect(page.locator('#search')).toBeInViewport();
});
