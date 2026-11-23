import { expect, test } from '@playwright/test';

const current = area => area.locator('[data-time].current');
const scrollPosition = area => area.evaluate(element => element.scrollTop);
const touch = (area, type) => area.evaluate((element, type) => element.dispatchEvent(new Event(type, { bubbles: true })), type);

async function manualScroll(area, top) {
  await area.evaluate(async (element, value) => {
    const moved = new Promise(resolve => element.addEventListener('scroll', resolve, { once: true }));
    element.scrollTop = value;
    await moved;
  }, top);
}

test('immersive lyrics keep the manual scroll position while lines update and follow again after touch release', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const lyrics = Array.from({ length: 100 }, (_, index) => ({ time: index * 2, text: `Timed fixture line ${index}` }));
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      settings: { demos: false },
      tracks: [{ id: 'lyrics-scroll', title: 'Lyric Scroll Fixture', artist: 'Fixture Artist', provider: 'demo',
        src: '/assets/demo-1.m4a', lyrics }],
    }));
  });
  await page.goto('/#songs');
  await page.locator('#content').getByRole('button', { name: 'Lyric Scroll Fixture Fixture Artist', exact: true }).press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await page.locator('#player-art').press('Enter');
  const area = page.locator('.immersive .lyrics');
  const seek = async (time, line) => {
    await audio.evaluate((element, seconds) => { element.currentTime = seconds; }, time);
    await expect(current(area)).toHaveText(`Timed fixture line ${line}`);
  };
  await seek(30, 15);
  await expect.poll(() => scrollPosition(area)).toBeGreaterThan(200);

  await touch(area, 'touchstart');
  await manualScroll(area, 1550);
  const browsed = await scrollPosition(area);
  expect(browsed).toBeGreaterThan(1400);
  await seek(48, 24);
  await page.clock.runFor(3200);
  expect(await scrollPosition(area)).toBe(browsed);
  await touch(area, 'touchend');
  await page.clock.runFor(2000);
  expect(await scrollPosition(area)).toBe(browsed);
  await page.clock.runFor(1100);
  await expect.poll(() => scrollPosition(area)).toBeLessThan(browsed - 100);
  await expect(current(area)).toBeInViewport();

  await manualScroll(area, 1500);
  const browsedAgain = await scrollPosition(area);
  await seek(60, 30);
  expect(await scrollPosition(area)).toBe(browsedAgain);
  await area.getByRole('button', { name: 'Timed fixture line 15', exact: true }).press('Enter');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeLessThan(35);
  await expect(current(area)).toHaveText('Timed fixture line 15');
  await expect.poll(() => scrollPosition(area)).toBeLessThan(browsedAgain - 100);
});
