import { expect, test } from '@playwright/test';

const record = (page, playlist) => page.evaluate(id => {
  const state = JSON.parse(localStorage.getItem('groovebox.state.v1'));
  return state.playlistResumeBookmarks?.find(([key]) => key === 'playlist/' + id)?.[1];
}, playlist);
const nav = (page, name) => page.locator('#sidebar [data-nav="' + name + '"]');
const queue = (page, index) => page.locator('#now [data-action="queue-play"][data-index="' + index + '"]');
const activeIndex = page => page.locator('#now .queue-row.current [data-action="queue-play"]');
const playbackStarted = page => expect.poll(() => page.locator('#audio').evaluate(audio =>
  !audio.paused && audio.currentTime > 0.05)).toBe(true);

test('remembers the exact occurrence in an opted-in playlist across ordering, filtering, and queue reload', async ({ page }) => {
  const playlist = { id: 'resume-demo', name: '续播测试', tracks: ['demo-2', 'missing', 'demo-1', 'demo-2', 'demo-8'] };
  const other = { id: 'another-list', name: '另一张歌单', tracks: ['demo-1', 'demo-2', 'demo-3'] };
  await page.addInitScript(playlists => {
    if (!localStorage.getItem('groovebox.state.v1')) {
      localStorage.setItem('groovebox.state.v1', JSON.stringify({ playlists }));
    }
  }, [playlist, other]);

  const content = page.locator('#content');
  const playAll = content.getByRole('button', { name: '全部播放', exact: true });
  const toggle = page.locator('#remember-playlist-position');
  const blueRows = content.locator('tbody tr').filter({ hasText: 'Blue Static' });
  await page.goto('/#settings');
  await expect(toggle).not.toBeChecked();
  await nav(page, 'playlist/' + playlist.id).press('Enter');
  await blueRows.last().locator('.track-main').press('Enter');
  await expect(activeIndex(page)).toHaveAttribute('data-index', '2');
  await playbackStarted(page);
  expect(await record(page, playlist.id)).toBeUndefined();
  await playAll.click();
  await expect(activeIndex(page)).toHaveAttribute('data-index', '0');

  await nav(page, 'settings').press('Enter');
  await toggle.check();
  await nav(page, 'playlist/' + playlist.id).press('Enter');
  await blueRows.last().locator('.track-main').press('Enter');
  await playbackStarted(page);
  await expect.poll(() => record(page, playlist.id)).toBeTruthy();
  const secondOccurrence = await record(page, playlist.id);

  await content.getByRole('button', { name: '手动排序', exact: true }).press('Enter');
  await blueRows.last().getByRole('button', { name: '上移 Blue Static', exact: true }).press('Enter');
  await blueRows.last().getByRole('button', { name: '上移 Blue Static', exact: true }).press('Enter');
  await content.getByRole('button', { name: '完成排序', exact: true }).press('Enter');
  await content.getByRole('combobox', { name: '排序', exact: true }).selectOption('title');
  await page.reload();
  const search = content.getByRole('searchbox', { name: '搜索此歌单', exact: true });
  await search.fill('Last Light');
  await expect(content.locator('.track-name')).toHaveText(['Last Light']);
  await playAll.click();
  await expect(activeIndex(page)).toHaveAttribute('data-index', '1');
  await playbackStarted(page);
  expect(await record(page, playlist.id)).toBe(secondOccurrence);
  expect(await page.locator('#audio').evaluate(audio => audio.currentTime)).toBeLessThan(2);

  await search.clear();
  await expect(blueRows.first()).toHaveAttribute('aria-current', 'true');
  await expect(blueRows.last()).not.toHaveAttribute('aria-current', 'true');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')));
  expect(saved.localPlaylistSlots).toHaveLength(1);
  expect(saved.localPlaylistSlots[0][1].map(([, id]) => id)).toEqual(['demo-2', 'demo-2']);
  expect(saved.playlistQueue.occurrences.filter(occurrence => occurrence === true)).toHaveLength(2);
  await blueRows.first().getByRole('button', { name: '歌曲选项', exact: true }).press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '添加到播放队列', exact: true }).press('Enter');
  await page.reload();
  // Wait for the restored queue before inspecting the panel's visibility.
  await expect(activeIndex(page)).toHaveAttribute('data-index', '1');
  if (await page.locator('body.panel-closed').count()) await page.locator('[data-action="queue-panel"]').click();
  await queue(page, 4).click();
  await expect(activeIndex(page)).toHaveAttribute('data-index', '4');
  await playbackStarted(page);
  expect(await record(page, playlist.id)).toBe(secondOccurrence);

  await queue(page, 2).click();
  await expect(activeIndex(page)).toHaveAttribute('data-index', '2');
  await playbackStarted(page);
  await expect.poll(() => record(page, playlist.id)).not.toBe(secondOccurrence);
  const firstOccurrence = await record(page, playlist.id);
  expect(firstOccurrence).toBeTruthy();

  await nav(page, 'playlist/' + other.id).press('Enter');
  await playAll.click();
  await expect(activeIndex(page)).toHaveAttribute('data-index', '0');
  await playbackStarted(page);
  expect(await record(page, playlist.id)).toBe(firstOccurrence);

  const dialog = page.getByRole('dialog');
  await content.locator('tbody tr').filter({ hasText: 'Soft Signal' })
    .getByRole('button', { name: '歌曲选项', exact: true }).click();
  await dialog.getByRole('button', { name: '添加到歌单', exact: true }).click();
  await dialog.getByRole('button', { name: playlist.name, exact: true }).click();
  await page.reload();
  await nav(page, 'playlist/' + playlist.id).press('Enter');
  await expect(content.getByRole('heading', { name: playlist.name, exact: true })).toBeVisible();
  await playAll.click();
  await expect(activeIndex(page)).toHaveAttribute('data-index', '2');
  await blueRows.first().locator('.track-main').press('Enter');
  await expect(activeIndex(page)).toHaveAttribute('data-index', '1');
});
