import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ hasTouch: true });

async function swipeCover(cover, session, horizontal, vertical) {
  const bounds = await cover.boundingBox();
  const x = Math.round(bounds.x + bounds.width / 2);
  const y = Math.round(bounds.y + bounds.height / 3);
  if (session) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 4; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + horizontal * step / 4, y: y + vertical * step / 4 }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    const pointer = { pointerId: 5, isPrimary: true, pointerType: 'touch', bubbles: true };
    await cover.dispatchEvent('pointerdown', { ...pointer, clientX: x, clientY: y });
    await cover.dispatchEvent('pointerup', { ...pointer, clientX: x + horizontal, clientY: y + vertical });
  }
}

test('opens full lyrics from the synchronized preview or a right swipe without disturbing playback', async ({ page, browserName }) => {
  await page.goto('/#songs');
  const audioFile = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.locator('#import-files').setInputFiles([
    { name: '歌词测试 - 播放样本.m4a', mimeType: 'audio/mp4', buffer: audioFile },
    { name: '歌词测试 - 播放样本.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:00.00]起始歌词\n[00:03.00]当前副歌\n[00:09.00]完整歌词') },
  ]);
  await page.locator('#content').getByRole('button', { name: '播放样本 歌词测试', exact: true }).press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  const now = page.locator('#now');
  const preview = now.getByRole('button', { name: '打开歌词', exact: true });
  const lyricsTab = now.getByRole('button', { name: '歌词', exact: true });
  const queueTab = now.getByRole('button', { name: '播放队列', exact: true });
  const cover = now.getByRole('button', { name: '放大封面', exact: true });
  const queue = await now.locator('.queue-row .track-name').allTextContents();
  await expect(preview).toHaveText('起始歌词');

  await audio.evaluate(element => { element.currentTime = 3.25; });
  await expect(preview).toHaveText('当前副歌');
  if (browserName === 'chromium') await preview.tap();
  else await preview.press('Enter');
  await expect(lyricsTab).toBeFocused();
  await expect(now.locator('.lyric-line.current')).toHaveText('当前副歌');
  await now.getByRole('button', { name: '完整歌词', exact: true }).press('Enter');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThanOrEqual(9);

  await queueTab.press('Enter');
  await expect(preview).toHaveText('完整歌词');
  await expect(now.locator('.queue-row .track-name')).toHaveText(queue);
  const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
  try {
    await swipeCover(cover, session, -90, 4);
    await expect(preview).toBeVisible();
    await swipeCover(cover, session, 6, 95);
    await expect(preview).toBeVisible();
    await swipeCover(cover, session, 95, 4);
    await expect(now.locator('.lyric-line.current')).toHaveText('完整歌词');
    await expect(page.getByRole('region', { name: '沉浸播放', exact: true })).toHaveCount(0);
    await expect.poll(() => audio.evaluate(element => element.paused)).toBe(false);
    await queueTab.press('Enter');
    await expect(now.locator('.queue-row .track-name')).toHaveText(queue);
    await cover.press('Enter');
    await expect(page.getByRole('region', { name: '沉浸播放', exact: true })).toBeVisible();
  } finally {
    await session?.detach();
  }
});
