import { expect, test } from '@playwright/test';

test('shows each album track’s latest progress and preserves it across reloads', async ({ page }) => {
  const albumHeading = page.getByRole('heading', { name: 'Midnight Tape', exact: true });
  const progress = page.getByRole('progressbar', { name: '「After Hours」的播放进度' });
  const preference = page.getByRole('checkbox', { name: '在专辑详情显示歌曲播放进度' });
  const audio = page.locator('#audio');
  const tracks = page.getByRole('table');

  await page.goto('/#albums');
  const albumCard = page.getByRole('button', { name: /^Midnight Tape/ });
  await expect(albumCard).toBeVisible();
  await albumCard.press('Enter');
  await expect(albumHeading).toBeVisible();
  const albumUrl = page.url();
  await expect(page.locator('.album-track-progress')).toHaveCount(0);

  await page.locator('#sidebar [data-nav=settings]').press('Enter');
  await expect(preference).not.toBeChecked();
  await preference.check();
  await page.goto(albumUrl);
  await expect(albumHeading).toBeVisible();
  await expect(page.locator('.album-track-progress[hidden]')).toHaveCount(2);
  await tracks.getByRole('button', { name: 'After Hours Velvet Atlas', exact: true }).press('Enter');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.05);
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => audio.evaluate(element => element.paused)).toBe(true);
  await page.locator('#seek').fill('530');
  await expect(progress).toHaveAttribute('value', '53');

  await tracks.getByRole('button', { name: 'Slow Motion Velvet Atlas', exact: true }).press('Enter');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.05);
  await expect(progress).toHaveAttribute('value', '53');
  await expect(page.getByRole('progressbar', { name: '「Slow Motion」的播放进度' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')).trackProgress))
    .toContainEqual(['demo-1', 53]);

  await page.reload();
  await expect(progress).toHaveAttribute('value', '53');
  await tracks.getByRole('button', { name: 'After Hours Velvet Atlas', exact: true }).press('Enter');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.05);
  await audio.evaluate(element => { element.currentTime = element.duration - 0.2; });
  await expect(page.locator('#player-title')).toHaveText('Slow Motion');
  await expect(progress).toHaveAttribute('value', '100');
  await page.locator('#sidebar [data-nav=songs]').press('Enter');
  await expect(page.locator('.album-track-progress')).toHaveCount(0);
  await page.locator('#sidebar [data-nav=settings]').press('Enter');
  await expect(preference).toBeChecked();
  await preference.uncheck();
  await page.goto(albumUrl);
  await expect(albumHeading).toBeVisible();
  await expect(page.locator('.album-track-progress')).toHaveCount(0);
});
