import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

const key = 'groovebox.state.v1';
const nav = (page, value) => page.locator('#sidebar [data-nav="' + value + '"]');
const action = (page, value) => page.locator('[data-action="' + value + '"]');
const dialog = page => page.getByRole('dialog');
const saved = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
const title = (page, name) => page.locator('#content .track-name').filter({ hasText: name });
const remote = 'baidu:729';
const listId = 'known-modification';
const legacyId = 'unknown-modification';
const previous = Date.UTC(2025, 1, 9);
const next = Date.UTC(2025, 1, 10);

test('keeps unknown legacy dates and original clock through reorder, no-op rename, and real tag parsing', async ({ page }) => {
  const state = {
    settings: { onlineCover: false, playlistOverviewOrder: 'modified-at-desc' },
    playlists: [
      { id: legacyId, name: 'Legacy undated', tracks: [] },
      { id: listId, name: 'Known repeated tracks', tracks: [remote, 'demo-1', remote] },
    ],
    playlistModificationDates: [[listId, previous]],
    tracks: [{
      id: remote, title: 'Before tags', artist: 'Fixture', provider: 'baidu',
      src: '/api/baidu/stream?id=729', fileName: 'tags.m4a',
    }],
  };
  await page.clock.setFixedTime(next);
  await page.addInitScript(({ key, state }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state)); }, { key, state });
  const tagged = Buffer.from(await updateBuffer(await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url)), {
    title: 'After tags', artist: 'Fixture',
  }));
  let mediaRead = 0;
  await page.route('**/api/baidu/stream?id=729', route => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ contentType: 'audio/mp4', body: tagged });
    mediaRead++;
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), tagged.length - 1);
    return route.fulfill({ status: 206, contentType: 'audio/mp4', body: tagged.subarray(start, end + 1),
      headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + tagged.length } });
  });
  const assertDate = async () => expect((await saved(page)).playlistModificationDates).toEqual([[listId, previous]]);
  await page.goto('/#playlist%2F' + listId);
  const entries = page.locator('#playlist-nav button');
  await expect(entries).toHaveText(['Known repeated tracks', 'Legacy undated']);
  await action(page, 'playlist-order').press('Enter');
  await action(page, 'playlist-track-down').first().press('Enter');
  expect((await saved(page)).playlists[1].tracks).toEqual(['demo-1', remote, remote]);
  await assertDate();
  await action(page, 'playlist-order').press('Enter');

  await action(page, 'rename-playlist').press('Enter');
  await dialog(page).getByRole('button', { name: '保存', exact: true }).press('Enter');
  await assertDate();
  await nav(page, 'playlist/' + legacyId).press('Enter');
  await action(page, 'rename-playlist').press('Enter');
  await dialog(page).getByRole('button', { name: '保存', exact: true }).press('Enter');
  await assertDate();
  await nav(page, 'playlist/' + listId).press('Enter');

  await page.locator('#content tr[data-track="' + remote + '"] [data-action=track-menu]').first().press('Enter');
  await dialog(page).getByRole('button', { name: '读取音频标签', exact: true }).press('Enter');
  await expect(title(page, 'After tags')).toHaveCount(2);
  expect(mediaRead).toBeGreaterThan(0);
  await assertDate();

  await action(page, 'reorder-playlists').press('Enter');
  const sort = dialog(page).getByRole('combobox');
  await sort.selectOption('name');
  await sort.selectOption('modified-at-desc');
  await dialog(page).getByRole('button', { name: '关闭', exact: true }).press('Enter');
  await assertDate();
  await page.reload();
  await expect(entries).toHaveText(['Known repeated tracks', 'Legacy undated']);
  await expect(title(page, 'After tags')).toHaveCount(2);
  await assertDate();
});
