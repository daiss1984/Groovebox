import { expect, test } from '@playwright/test';

async function seedPlayingTrack(page, currentIndex = 30) {
  await page.addInitScript(index => {
    const tracks = Array.from({ length: 40 }, (_, index) => ({
      id: 'fixture-' + index, title: '曲目 ' + (index + 1), artist: '测试艺人',
      provider: 'demo', src: '/assets/demo-1.m4a', duration: 164,
    }));
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      tracks, queue: tracks.map(track => track.id), index, position: 0, settings: { demos: false },
    }));
  }, currentIndex);
}

test('locates the playing row in the current list or opens the library when it is absent', async ({ page }) => {
  await seedPlayingTrack(page);
  await page.goto('/#songs');
  const locate = page.getByRole('button', { name: '定位当前歌曲', exact: true });
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: '曲目 31 测试艺人', exact: true }) });
  const play = page.locator('#player-toggle');
  await expect(locate).toBeEnabled();
  await expect(row).not.toBeInViewport();
  await play.press('Enter');
  await expect(play).toHaveAccessibleName('暂停');
  await page.locator('#seek').fill('110');
  await locate.press('Enter');
  await expect(row).toBeInViewport();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(row.getByRole('button', { name: '曲目 31 测试艺人', exact: true })).toBeFocused();
  await expect(play).toHaveAccessibleName('暂停');
  expect(await page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(10);

  await page.locator('#sidebar [data-nav="favorites"]').press('Enter');
  await expect(page).toHaveURL(/#favorites$/);
  await expect(page.getByRole('heading', { name: '我喜欢的', exact: true })).toBeVisible();
  await locate.press('Enter');
  await expect(page).toHaveURL(/#songs$/);
  await expect(row).toBeInViewport();
  await expect(row.getByRole('button', { name: '曲目 31 测试艺人', exact: true })).toBeFocused();
});

test('holding the player title locates the exact current song before release, while moving or canceling leaves the page alone @mobile', async ({ page }) => {
  await seedPlayingTrack(page, 14);
  await page.goto('/#songs');
  await page.getByRole('combobox', { name: '排序', exact: true }).selectOption('title-desc');
  await page.goto('/#favorites');
  const locate = page.getByRole('button', { name: '定位当前歌曲', exact: true });
  await expect(locate).toBeEnabled();
  await page.clock.install();
  const pointer = { pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, clientX: 45, clientY: 100 };
  await locate.dispatchEvent('pointerdown', pointer);
  await locate.dispatchEvent('pointermove', { ...pointer, clientY: 140 });
  await page.clock.runFor(600);
  await expect(page).toHaveURL(/#favorites$/);
  await locate.dispatchEvent('pointerup', pointer);
  await locate.dispatchEvent('pointerdown', pointer);
  await locate.dispatchEvent('pointercancel', pointer);
  await page.clock.runFor(600);
  await expect(page).toHaveURL(/#favorites$/);

  await locate.dispatchEvent('pointerdown', pointer);
  await page.clock.runFor(600);
  await expect(page).toHaveURL(/#songs$/);
  await expect(page.getByRole('combobox', { name: '排序', exact: true })).toHaveValue('title-desc');
  const track = page.locator('#content').getByRole('button', { name: '曲目 15 测试艺人', exact: true });
  await expect(track).toBeInViewport();
  await expect(track).toBeFocused();
  await expect(track.locator('xpath=ancestor::tr')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#player-title')).toHaveText('曲目 15');

  await locate.dispatchEvent('pointerup', pointer);
  await locate.focus();
  await locate.dispatchEvent('click', { detail: 1 });
  await expect(locate).toBeFocused();
  await locate.tap();
  await expect(track).toBeFocused();
});

test('a browser-dispatched touch hold locates the playing song without waiting for the tap @mobile', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium exposes timed native touch input via CDP');
  await seedPlayingTrack(page);
  await page.goto('/#favorites');
  const locate = page.getByRole('button', { name: '定位当前歌曲', exact: true });
  await expect(locate).toBeEnabled();
  const { x, y, width, height } = await locate.boundingBox();
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: x + width / 2, y: y + height / 2, id: 1 }],
  });
  const track = page.locator('#content').getByRole('button', { name: '曲目 31 测试艺人', exact: true });
  try {
    await expect(page).toHaveURL(/#songs$/);
    await expect(track).toBeFocused();
  } finally {
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  }
  await expect(track).toBeFocused();
});

test('only opens playback details on track selection when enabled, and retains the setting', async ({ page }) => {
  await page.goto('/#settings');
  const setting = page.getByRole('checkbox', { name: '点击歌曲时打开播放详情' });
  const songs = page.locator('#sidebar [data-nav="songs"]');
  const settings = page.locator('#sidebar [data-nav="settings"]');
  const track = title => page.getByRole('table').getByRole('button', { name: new RegExp(title) });
  const detail = page.getByRole('region', { name: '沉浸播放', exact: true });
  await expect(setting).not.toBeChecked();
  await songs.press('Enter');
  await track('After Hours').press('Enter');
  await expect(detail).toHaveCount(0);

  await settings.press('Enter');
  await setting.press('Space');
  await expect(setting).toBeChecked();
  await songs.press('Enter');
  await track('Blue Static').press('Enter');
  await expect(detail.getByRole('heading', { name: 'Blue Static' })).toBeVisible();
  await expect(page.locator('#player-toggle')).toHaveAccessibleName('暂停');
  await detail.getByRole('button', { name: '关闭沉浸播放' }).press('Enter');
  await page.getByRole('button', { name: '下一首', exact: true }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText('Soft Signal');
  await expect(detail).toHaveCount(0);

  await page.reload();
  await track('After Hours').press('Enter');
  await expect(detail.getByRole('heading', { name: 'After Hours' })).toBeVisible();
});

test('opens playback details when reselecting the playing occurrence without restarting or replacing the queue', async ({ page }) => {
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({
      playlists: [{ id: 'duplicates', name: 'Repeated tracks', tracks: ['demo-1', 'demo-2', 'demo-1'] }],
    }));
  });
  const setting = page.getByRole('checkbox', { name: '再次点击正在播放的歌曲时打开播放详情', exact: true });
  const settings = page.locator('#sidebar [data-nav="settings"]');
  const playlist = page.locator('#sidebar [data-nav="playlist/duplicates"]');
  const rows = page.locator('#content [data-action="play-row"]');
  const queueRows = page.locator('#now .queue-row');
  const detail = page.getByRole('region', { name: '沉浸播放', exact: true });
  const audio = page.locator('#audio');
  const transport = page.locator('#player-toggle');
  const progress = () => audio.evaluate(element => element.currentTime);
  const expectPlaying = async () => {
    await expect(transport).toHaveAccessibleName('暂停');
    await expect.poll(progress).toBeGreaterThan(0.1);
  };

  await page.goto('/#songs');
  await expect(page.locator('#player-title')).toHaveText('After Hours');
  await settings.press('Enter');
  await expect(setting).not.toBeChecked();
  await setting.press('Space');
  await expect(setting).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '点击歌曲时打开播放详情', exact: true })).not.toBeChecked();

  await playlist.press('Enter');
  await rows.nth(0).press('Enter');
  await expectPlaying();
  await expect(detail).toHaveCount(0);
  await audio.evaluate(element => { element.currentTime = 12; });
  await rows.nth(0).press('Enter');
  await expect(detail.getByRole('heading', { name: 'After Hours', exact: true })).toBeVisible();
  expect(await progress()).toBeGreaterThanOrEqual(12);
  await detail.getByRole('button', { name: '关闭沉浸播放', exact: true }).press('Enter');
  await expect(rows.nth(0)).toBeFocused();
  await expect(queueRows.locator('.track-name')).toHaveText(['After Hours', 'Blue Static', 'After Hours']);
  await expect(queueRows.nth(0)).toHaveClass(/\bcurrent\b/);

  await rows.nth(2).press('Enter');
  await expect(queueRows.nth(2)).toHaveClass(/\bcurrent\b/);
  await expect(detail).toHaveCount(0);
  await expectPlaying();
  await audio.evaluate(element => { element.currentTime = 20; });
  await queueRows.nth(2).locator('[data-action="queue-play"]').press('Enter');
  await expect(detail.getByRole('heading', { name: 'After Hours', exact: true })).toBeVisible();
  expect(await progress()).toBeGreaterThanOrEqual(20);
  await detail.getByRole('button', { name: '关闭沉浸播放', exact: true }).press('Enter');

  await transport.press('Enter');
  await expect(transport).toHaveAccessibleName('播放');
  await rows.nth(2).press('Enter');
  await expectPlaying();
  await expect(detail).toHaveCount(0);
  await page.reload();
  await settings.press('Enter');
  await expect(setting).toBeChecked();
});
