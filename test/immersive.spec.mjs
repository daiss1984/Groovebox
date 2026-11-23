import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ hasTouch: true });

const readPosition = page => page.locator('#audio').evaluate(audio => audio.currentTime);

async function swipeCover(art, session, dx, dy) {
  const box = await art.boundingBox();
  const x = Math.round(box.x + box.width / 3);
  const y = Math.round(box.y + box.height / 3);
  if (session) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 4; step++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: x + dx * step / 4, y: y + dy * step / 4 }],
      });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  const pointer = { pointerId: 1, isPrimary: true, pointerType: 'touch', bubbles: true };
  await art.dispatchEvent('pointerdown', { ...pointer, clientX: x, clientY: y });
  await art.dispatchEvent('pointerup', { ...pointer, clientX: x + dx, clientY: y + dy });
}

test('keeps horizontal and small cover drags open and restores scroll after a downward swipe', async ({ page, browserName }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const nextAudio = await readFile(new URL('../public/assets/demo-2.m4a', import.meta.url));
  const lyrics = Array.from({ length: 50 }, (_, index) =>
    '[00:' + String(index).padStart(2, '0') + '.00]沉浸歌词第 ' + (index + 1) + ' 行').join('\n');
  await page.goto('/');
  await page.locator('#import-files').setInputFiles([
    { name: '测试艺人 - 沉浸回归.m4a', mimeType: 'audio/mp4', buffer: audio },
    { name: '测试艺人 - 沉浸回归.lrc', mimeType: 'text/plain', buffer: Buffer.from(lyrics) },
    { name: '队列艺人 - 队列续播.m4a', mimeType: 'audio/mp4', buffer: nextAudio },
  ]);
  await page.locator('#sidebar [data-nav=songs]').press('Enter');
  const tracks = page.getByRole('table');
  await expect(tracks.getByRole('button', { name: '队列续播 队列艺人', exact: true })).toBeVisible();
  await tracks.getByRole('button', { name: '沉浸回归 测试艺人', exact: true }).press('Enter');
  await expect.poll(() => readPosition(page)).toBeGreaterThan(0.05);
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
  const duration = await page.locator('#audio').evaluate(audio => audio.duration);
  await page.getByRole('slider', { name: '播放进度' }).fill(String(Math.round(9000 / duration)));
  await expect.poll(() => readPosition(page)).toBeGreaterThan(8.8);
  const position = await readPosition(page);

  const queue = page.locator('#now .queue-row .track-name');
  await expect(queue.first()).toBeVisible();
  const previousQueue = await queue.allTextContents();
  expect(previousQueue.length).toBeGreaterThan(1);

  const trigger = page.locator('#player-art');
  await trigger.press('Enter');
  const layer = page.getByRole('region', { name: '沉浸播放' });
  const art = layer.locator('.immersive-art');
  const scroll = layer.locator('.lyrics');
  const close = layer.getByRole('button', { name: '关闭沉浸播放' });
  await expect(close).toBeFocused();
  await expect(scroll.getByRole('button', { name: '沉浸歌词第 50 行' })).toBeAttached();
  const scrolled = await scroll.evaluate(area => {
    area.scrollTop = 530;
    return area.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(300);

  const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
  try {
    await swipeCover(art, session, 120, 24);
    await expect(layer).toBeVisible();
    await swipeCover(art, session, 1, 35);
    await expect(layer).toBeVisible();
    await swipeCover(art, session, 4, 120);
    await expect(layer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(queue).toHaveText(previousQueue);
    expect(await readPosition(page)).toBeCloseTo(position, 1);

    await trigger.press('Enter');
    await expect(layer).toBeVisible();
    await expect.poll(() => scroll.evaluate(area => area.scrollTop)).toBe(scrolled);
    await close.press('Enter');
    await expect(layer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(queue).toHaveText(previousQueue);
    expect(await readPosition(page)).toBeCloseTo(position, 1);
  } finally {
    await session?.detach();
  }
});
