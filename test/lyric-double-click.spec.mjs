import { expect, test } from '@playwright/test';

const playerTime = page => page.locator('#audio').evaluate(audio => audio.currentTime);
const paused = page => page.locator('#audio').evaluate(audio => audio.paused);

async function clickLyric(line, browserName, double = false) {
  if (browserName === 'webkit') {
    // Headless WebKit on this host sometimes routes pointer hits to <html>.
    await line.dispatchEvent('click', { detail: 1 });
    if (double) {
      await line.dispatchEvent('click', { detail: 2 });
      await line.dispatchEvent('dblclick', { detail: 2 });
    }
  } else if (double) await line.dblclick({ delay: 40 });
  else await line.click();
}

test('double-clicking timed or plain lyrics toggles playback in the main and immersive views', async ({ page, browserName }) => {
  await page.addInitScript(() => {
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      settings: { demos: false },
      tracks: [{ id: 'lyric-gestures', title: 'Lyric Gesture Track', artist: 'Fixture Artist', provider: 'demo',
        src: '/assets/demo-1.m4a', lyrics: [
          { time: 1, text: 'First timed line' },
          { time: 12, text: 'Second timed line' },
          { time: null, text: 'Plain lyric line' },
        ] }],
    }));
  });
  await page.goto('/#songs');
  await page.getByRole('button', { name: 'Lyric Gesture Track Fixture Artist', exact: true }).press('Enter');
  await expect.poll(() => playerTime(page)).toBeGreaterThan(0.1);
  const now = page.locator('#now');
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await page.locator('#audio').evaluate(audio => { audio.currentTime = 5; });
  const activeLine = now.getByRole('button', { name: 'First timed line' });
  await expect(activeLine).toHaveClass(/\bcurrent\b/);
  await clickLyric(activeLine, browserName, true);
  await expect.poll(() => paused(page)).toBe(true);
  expect(await playerTime(page)).toBeGreaterThanOrEqual(5);
  expect(await playerTime(page)).toBeLessThan(9);

  const futureLine = now.getByRole('button', { name: 'Second timed line' });
  await clickLyric(futureLine, browserName, true);
  await expect.poll(() => paused(page)).toBe(false);
  expect(await playerTime(page)).toBeLessThan(11);
  await clickLyric(futureLine, browserName);
  await expect.poll(() => playerTime(page)).toBeGreaterThanOrEqual(12);
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => paused(page)).toBe(true);
  await activeLine.press('Enter');
  await expect.poll(() => playerTime(page)).toBe(1);

  await page.locator('#player-art').press('Enter');
  const immersive = page.locator('.immersive');
  const untimed = immersive.locator('.lyric-line').filter({ hasText: 'Plain lyric line' });
  await clickLyric(untimed, browserName, true);
  await expect.poll(() => paused(page)).toBe(false);
  await expect.poll(() => playerTime(page)).toBeGreaterThan(1.25);
  await clickLyric(immersive.getByRole('button', { name: 'First timed line' }), browserName, true);
  await expect.poll(() => paused(page)).toBe(true);
  expect(await playerTime(page)).toBeGreaterThan(1.25);
  expect(await playerTime(page)).toBeLessThan(6);
});
