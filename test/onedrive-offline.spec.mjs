import { expect, test } from '@playwright/test';

test('saves and plays OneDrive audio offline when the native file ID contains an exclamation mark', async ({ page }) => {
  const id = 'ABCD!2';
  const media = '/api/onedrive/stream?id=' + id;
  let reachable = true;
  let requests = 0;
  await page.route('**/api/onedrive/status', route => route.fulfill({
    json: { configured: true, connected: reachable },
  }));
  await page.route('**/api/onedrive/list?**', route => route.fulfill({
    json: { items: [{ id, name: 'OneDrive Artist - OneDrive Song.m4a', folder: false, path: id, streamUrl: media }] },
  }));
  await page.route(url => url.pathname === '/api/onedrive/stream' && url.searchParams.get('id') === id, async route => {
    requests++;
    if (!reachable) return route.fulfill({ status: 503 });
    const response = await route.fetch({ url: new URL('/assets/demo-1.m4a', route.request().url()).href });
    await route.fulfill({ response });
  });
  await page.goto('/#sources');
  await page.locator('[data-action="oauth-source"][data-id="onedrive"]').click();
  const track = page.locator('#content tr').filter({ hasText: 'OneDrive Song' });
  await expect(track).toBeVisible();
  await track.getByRole('button', { name: '歌曲选项', exact: true }).click();
  const menu = page.getByRole('dialog');
  await expect(menu.getByRole('button', { name: '读取音频标签', exact: true })).toBeVisible();
  await menu.getByRole('button', { name: '离线保存', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('音频已保存到离线歌曲。');
  expect(requests).toBe(1);

  reachable = false;
  await page.goto('/#offline');
  await page.reload();
  await expect(track).toBeVisible();
  await track.locator('.track-main').click();
  await expect.poll(() => page.locator('#audio').evaluate(audio =>
    audio.currentSrc.startsWith('blob:') && !audio.paused && audio.currentTime > 0.1)).toBe(true);
  expect(requests).toBe(1);
});
