import { expect, test } from '@playwright/test';

test('shuffles only the selected artist’s songs and restores that queue after reload', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      tracks: [{ id: 'artist-second-album', title: 'City Nights', artist: 'Velvet Atlas', album: 'Live Sessions',
        provider: 'demo', src: '/assets/demo-1.m4a' }],
    }));
  });
  await page.goto('/#artists');
  const content = page.locator('#content');
  const shuffleArtist = content.getByRole('button', { name: '随机播放该艺人', exact: true });
  await expect(shuffleArtist).toHaveCount(0);
  await content.getByRole('button', { name: /Velvet Atlas/ }).press('Enter');
  await expect(content.getByRole('heading', { name: 'Velvet Atlas', exact: true })).toBeVisible();
  const shuffle = page.locator('#shuffle');
  const title = page.locator('#player-title');
  const queue = page.locator('#now .queue-row .track-name');
  await expect(shuffle).toHaveAttribute('aria-pressed', 'false');

  await page.evaluate(() => {
    const values = [0.75];
    Math.random = () => values.shift() ?? 0;
  });
  await shuffleArtist.press('Enter');
  await expect(title).toHaveText('Slow Motion');
  const expectedQueue = ['City Nights', 'After Hours', 'Slow Motion'];
  await expect(queue).toHaveText(expectedQueue);
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '下一首', exact: true }).press('Enter');
  await expect(title).toHaveText(/^(City Nights|After Hours)$/);
  const next = await title.textContent();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(title).toHaveText(next);
  await expect(queue).toHaveText(expectedQueue);
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
});
