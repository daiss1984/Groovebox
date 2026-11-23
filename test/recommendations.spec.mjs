import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('recommends albums and individual tracks from the listening library instead of demo music', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    const track = (id, title, album, extra = {}) => ({ id: 'baidu:' + id, title, album, artist: '测试艺人',
      provider: 'baidu', src: '/api/baidu/stream?id=' + id, albumIsFallback: false, ...extra });
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ tracks: [
      track('1', '收藏曲', '收藏专辑'), track('2', '常听曲一', '常听专辑'),
      track('3', '常听曲二', '常听专辑', { cover: '/assets/cover-1.jpg' }),
      track('4', '独立单曲', '百度网盘', { albumIsFallback: true }),
    ], history: [{ id: 'baidu:3', at: 5000 }, { id: 'baidu:2', at: 3000 }], favorites: ['baidu:1'] }));
  });
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.route('**/api/baidu/stream?**', route => route.fulfill({ contentType: 'audio/mp4', body: audio }));
  await page.goto('/');
  const featured = page.getByRole('region', { name: '推荐音乐' });
  const cards = featured.locator('.card');
  await expect(cards.locator('strong')).toHaveText(['常听专辑', '收藏专辑', '独立单曲']);
  await expect(cards.first().locator('img')).toHaveAttribute('src', '/assets/cover-1.jpg');
  await cards.first().press('Enter');
  await expect(page.getByRole('heading', { name: '常听专辑' })).toBeVisible();
  await expect(page.locator('.track-table tbody tr')).toHaveCount(2);
  await page.locator('#sidebar [data-nav=home]').press('Enter');
  await featured.getByRole('button', { name: /独立单曲/ }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText('独立单曲');
  await expect.poll(() => page.locator('#audio').evaluate(player => player.currentTime)).toBeGreaterThan(0.1);
});

test('restores the actual occurrence of a repeated track in the queue', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      queue: ['demo-1', 'demo-2', 'demo-1', 'demo-3'], index: 2, position: 7,
    }));
  });
  await page.goto('/');
  await expect(page.locator('#player-title')).toHaveText('After Hours');
  await expect.poll(() => page.locator('#audio').evaluate(player => player.currentTime)).toBeCloseTo(7, 0);
  await page.getByRole('button', { name: '下一首', exact: true }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText('Soft Signal');
});
