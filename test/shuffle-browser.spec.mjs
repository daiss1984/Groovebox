import { expect, test } from '@playwright/test';

test('uses actual playback history across repeat-all shuffle cycles and a reload', async ({ page }) => {
  await page.addInitScript(() => {
    Math.random = () => 0;
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      queue: ['demo-1', 'demo-2', 'demo-3'],
      index: 0,
      position: 0,
      settings: { shuffle: false, repeat: 'off' },
    }));
  });
  await page.goto('/#songs');
  const title = page.locator('#player-title');
  const queue = page.locator('#now .queue-row .track-name');
  const initial = ['After Hours', 'Blue Static', 'Soft Signal'];
  await expect(queue).toHaveText(initial);
  const shuffle = page.locator('#shuffle');
  const repeat = page.locator('#repeat');
  await shuffle.press('Enter');
  await repeat.press('Enter');
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  await expect(repeat).toHaveAttribute('title', '列表循环');

  await page.locator('#player-toggle').press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  await expect(title).toHaveText(initial[0]);
  const next = page.getByRole('button', { name: '下一首', exact: true });
  const previous = page.getByRole('button', { name: '上一首', exact: true });
  const playNext = async expected => {
    await next.press('Enter');
    await expect(title).toHaveText(expected);
  };
  const playPrevious = async expected => {
    await page.locator('#seek').press('Home');
    await previous.press('Enter');
    await expect(title).toHaveText(expected);
  };

  await playNext(initial[1]);
  await playNext(initial[2]);
  await playNext(initial[0]);
  await playPrevious(initial[2]);
  await playPrevious(initial[1]);
  await page.reload();
  await expect(title).toHaveText(initial[1]);
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  await playPrevious(initial[0]);
  await playNext(initial[1]);
  await playNext(initial[2]);
  await playNext(initial[0]);
  await playNext(initial[1]);
  await playNext(initial[2]);
  await expect(queue).toHaveText(initial);
});
