import { expect, test } from '@playwright/test';

test('plays a randomly selected whole album in shuffle mode', async ({ page }) => {
  await page.goto('/#albums');
  const action = page.getByRole('button', { name: '随机播放一张专辑', exact: true });
  const title = page.locator('#player-title');
  const shuffle = page.locator('#shuffle');
  const queue = page.locator('#now .queue-row .track-name');
  await expect(shuffle).toHaveAttribute('aria-pressed', 'false');
  await expect(action).toBeVisible();

  await page.evaluate(() => {
    const values = [.4, .75];
    Math.random = () => values.shift() ?? 0;
  });
  await action.press('Enter');

  await expect(title).toHaveText('Last Light');
  await expect(queue).toHaveText(['Soft Signal', 'Last Light']);
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '下一首', exact: true }).press('Enter');
  await expect(title).toHaveText('Soft Signal');

  await page.reload();
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  await expect(title).toHaveText('Soft Signal');
  await expect(queue).toHaveText(['Soft Signal', 'Last Light']);
});

test('only offers random album playback on a populated album catalog', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { demos: false } }));
  });
  await page.goto('/#albums');
  await expect(page.getByRole('heading', { name: '专辑', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '随机播放一张专辑', exact: true })).toHaveCount(0);
});
