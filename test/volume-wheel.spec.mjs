import { expect, test } from '@playwright/test';

const readLevel = page => page.locator('#audio').evaluate(audio => audio.volume);
const wheel = (target, options) => target.evaluate((element, init) =>
  element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })), options);

test('desktop volume wheel raises the audio level when scrolling up and lowers it when scrolling down', async ({ page }) => {
  await page.goto('/');
  const slider = page.getByRole('slider', { name: '音量', exact: true });
  await expect.poll(() => readLevel(page)).toBe(0.8);
  const bounds = await slider.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -80);
  await expect.poll(() => readLevel(page)).toBe(0.85);
  await expect(slider).toHaveValue('85');
  await page.mouse.wheel(0, 80);
  await expect.poll(() => readLevel(page)).toBe(0.8);
});

test('volume wheel clamps the slider, leaves other wheel gestures alone and persists the adjusted level', async ({ page }) => {
  await page.goto('/');
  const slider = page.getByRole('slider', { name: '音量', exact: true });
  await expect.poll(() => readLevel(page)).toBe(0.8);
  expect(await wheel(page.locator('#seek'), { deltaY: -50 })).toBe(true);
  expect(await wheel(slider, { deltaX: 40, deltaY: 1 })).toBe(true);
  expect(await wheel(slider, { deltaY: -50, ctrlKey: true })).toBe(true);
  expect(await wheel(slider, { deltaY: -50, metaKey: true })).toBe(true);
  await expect(slider).toHaveValue('80');

  await slider.press('End');
  expect(await wheel(slider, { deltaY: -50 })).toBe(false);
  await expect(slider).toHaveValue('100');
  await slider.press('Home');
  expect(await wheel(slider, { deltaY: 50 })).toBe(false);
  await expect(slider).toHaveValue('0');
  expect(await wheel(slider, { deltaY: -1, deltaMode: 1 })).toBe(false);
  await expect.poll(() => readLevel(page)).toBe(0.05);
  await page.reload();
  await expect.poll(() => readLevel(page)).toBe(0.05);
  await expect(slider).toHaveValue('5');
});
