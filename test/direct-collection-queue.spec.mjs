import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const source = { id: '5c042bce-ce1d-4478-bbd0-ce36e8a0895d', name: 'Direct music fixture', type: 'emby' };
const sourcePath = '/api/sources/' + source.id;
const nav = (page, route) => page.locator('#sidebar [data-nav="' + route + '"]');
const queue = page => page.locator('#now .queue-row');
const setting = page => page.locator('#queue-all-direct-tracks');
const titles = page => queue(page).locator('.track-name');
const folderTrackNames = ['First Recording', 'Second Recording'];
const playlistName = 'Remote Repeats';
const localPlaylist = { id: 'local-scope', name: '我的歌单', tracks: ['demo-1', 'demo-2', 'demo-3'] };
const folder = (id, name, browseKind) => ({ id, path: id, name, folder: true, browseKind });
const track = (id, name, entry) => ({
  id, name, title: name, artist: 'Fixture Artist', streamUrl: sourcePath + '/stream?id=' + id, playlistEntry: entry,
});
const folders = [folder('album', 'Remote Album', 'album'), folder('artist', 'Remote Artist', 'artist'), folder('plain', 'Plain Folder')];
const folderTracks = [track('one', folderTrackNames[0]), track('two', folderTrackNames[1])];
const mixTracks = [track('repeat', 'Repeat Song', 'first-repeat'), track('bridge', 'Bridge Song', 'bridge'),
  track('repeat', 'Repeat Song', 'second-repeat')];

async function provider(page) {
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [source] } }));
  await page.route('**' + sourcePath + '/list?**', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    const items = path === '/' ? folders : path === 'playlists' ? [folder('mix', playlistName)]
      : path === 'mix' ? mixTracks : folderTracks;
    return route.fulfill({ json: { items, ...(path === 'mix' && { serverOrder: true }) } });
  });
  await page.route('**' + sourcePath + '/stream?**', async route => {
    const url = new URL('/assets/demo-1.m4a', route.request().url());
    await route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
}
async function openSource(page) {
  await nav(page, 'sources').click();
  await page.locator('[data-action="open-cloud"][data-id="' + source.id + '"]').click();
}
async function openServerPlaylist(page) {
  await openSource(page);
  await page.getByRole('button', { name: '服务器歌单', exact: true }).click();
  await page.getByRole('button', { name: playlistName, exact: true }).click();
}

test('defaults to a full direct playlist and narrows filtered duplicate selection when disabled', async ({ page }) => {
  await provider(page);
  await page.goto('/#settings');
  await expect(setting(page)).toBeChecked();
  await page.locator('#remember-playlist-position').check();
  await openServerPlaylist(page);

  const content = page.locator('#content');
  const repeatRows = content.locator('tbody tr').filter({ hasText: 'Repeat Song' });
  const selected = repeatRows.nth(1);
  const filter = content.getByRole('searchbox', { name: '搜索此歌单', exact: true });
  await selected.locator('.track-main').click();
  await expect(titles(page)).toHaveText(['Repeat Song', 'Bridge Song', 'Repeat Song']);
  await expect(queue(page).nth(2)).toHaveClass(/\bcurrent\b/);

  await nav(page, 'settings').click();
  await setting(page).uncheck();
  await page.reload();
  await expect(setting(page)).not.toBeChecked();
  await openServerPlaylist(page);
  await filter.fill('repeat');
  await expect(repeatRows).toHaveCount(2);
  await selected.locator('.track-main').click();
  await expect(titles(page)).toHaveText(['Repeat Song']);
  await expect(selected).toHaveAttribute('aria-current', 'true');
  await expect(repeatRows.first()).not.toHaveAttribute('aria-current', 'true');
  await expect.poll(async () => page.evaluate(() => {
    const { playlistQueue } = JSON.parse(localStorage.getItem('groovebox.state.v1'));
    return playlistQueue?.occurrences[0] && JSON.parse(playlistQueue.occurrences[0]).at(-1);
  })).toBe('second-repeat');

  await content.getByRole('button', { name: '播放歌单', exact: true }).click();
  await expect(titles(page)).toHaveText(['Repeat Song', 'Bridge Song', 'Repeat Song']);
  await expect(queue(page).nth(2)).toHaveClass(/\bcurrent\b/);
});

test('applies the option to live albums and artists while folders and local lists keep their full queue', async ({ page }) => {
  await page.addInitScript(playlist => {
    if (!localStorage.getItem('groovebox.state.v1')) localStorage.setItem('groovebox.state.v1', JSON.stringify({ playlists: [playlist] }));
  }, localPlaylist);
  await provider(page);
  await page.goto('/#settings');
  await setting(page).uncheck();
  const content = page.locator('#content');

  for (const entry of folders) {
    await openSource(page);
    await content.getByRole('button', { name: entry.name, exact: true }).click();
    await content.locator('.track-main').filter({ hasText: folderTrackNames[1] }).click();
    await expect(titles(page)).toHaveText(entry.browseKind ? [folderTrackNames[1]] : folderTrackNames);
    await expect(page.locator('#player-title')).toHaveText(folderTrackNames[1]);
    await content.getByRole('button', { name: '播放此目录', exact: true }).click();
    await expect(titles(page)).toHaveText(folderTrackNames);
  }

  await nav(page, 'playlist/' + localPlaylist.id).click();
  await content.locator('.track-main').nth(1).click();
  await expect(titles(page)).toHaveText(['After Hours', 'Blue Static', 'Soft Signal']);
  await expect(queue(page).nth(1)).toHaveClass(/\bcurrent\b/);

  for (const [route, group] of [['albums', 'Midnight Tape'], ['artists', 'Velvet Atlas']]) {
    await nav(page, route).click();
    await content.locator('[data-action="group"]').filter({ hasText: group }).click();
    await content.locator('.track-main').filter({ hasText: 'Slow Motion' }).click();
    await expect(titles(page)).toHaveText(['After Hours', 'Slow Motion']);
    await expect(queue(page).nth(1)).toHaveClass(/\bcurrent\b/);
  }
});
