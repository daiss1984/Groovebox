import { expect, test } from '@playwright/test';

test('searches only the open playlist, starts its full queue at the result and can locate or remove a track', async ({ page }) => {
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      playlists: [
        { id: 'travel', name: 'Travel Playlist', tracks: ['demo-1', 'demo-3', 'demo-2'] },
        { id: 'other', name: 'Other Playlist', tracks: ['demo-4'] },
      ],
    }));
  });
  await page.goto('/#playlist%2Ftravel');
  const content = page.locator('#content');
  const filter = content.getByRole('searchbox', { name: '搜索此歌单' });
  const titles = content.locator('tbody .track-name');
  const queueTitles = page.locator('#now .queue-list .track-name');
  await expect(titles).toHaveText(['After Hours', 'Soft Signal', 'Blue Static']);

  await filter.pressSequentially('mira');
  await expect(filter).toBeFocused();
  await expect(titles).toHaveText(['Soft Signal']);
  await expect(content.getByRole('button', { name: '手动排序' })).toHaveCount(0);
  await content.getByRole('button', { name: 'Soft Signal Mira Kos' }).press('Enter');
  await expect(queueTitles).toHaveText(['After Hours', 'Soft Signal', 'Blue Static']);
  await expect(page.locator('#player-title')).toHaveText('Soft Signal');

  await filter.fill('Midnight Tape');
  await expect(titles).toHaveText(['After Hours']);
  await content.getByRole('button', { name: '定位当前歌曲' }).press('Enter');
  await expect(filter).toHaveValue('');
  await expect(content.getByRole('button', { name: 'Soft Signal Mira Kos' })).toBeFocused();
  await expect(page).toHaveURL(/travel$/);

  await filter.fill('paper planes');
  await expect(content.getByText('此歌单没有匹配的歌曲')).toBeVisible();
  await filter.fill('nova');
  await content.getByRole('button', { name: '歌曲选项' }).press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '从歌单移除' }).press('Enter');
  await expect(content.getByText('此歌单没有匹配的歌曲')).toBeVisible();

  await page.locator('#playlist-nav').getByRole('button', { name: 'Other Playlist' }).press('Enter');
  await expect(filter).toHaveValue('');
  await expect(titles).toHaveText(['Paper Planes']);
  await page.locator('#playlist-nav').getByRole('button', { name: 'Travel Playlist' }).press('Enter');
  await expect(titles).toHaveText(['After Hours', 'Soft Signal']);
});

test('keeps the exact Emby playlist occurrence when filtering and removing a duplicate', async ({ page }) => {
  const source = { id: '412555e6-45e3-4a51-b68e-cbbe79485be4', name: 'Emby test', type: 'emby' };
  const [part, unrelated, same] = [
    { id: 's1', name: 'Repeat Song', title: 'Repeat Song', artist: 'Test Artist' },
    { id: 's2', name: 'Bridge Song', title: 'Bridge Song', artist: 'Test Artist' },
    { id: 's1', name: 'Repeat Song', title: 'Repeat Song', artist: 'Test Artist' },
  ].map((item, index) => ({ ...item, playlistEntry: 'entry-' + index, streamUrl: '/api/sources/' + source.id + '/stream?id=' + item.id }));
  let entries = [part, unrelated, same];
  const mutation = [];
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [source] } }));
  await page.route('**/api/sources/' + source.id + '/list?**', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    return route.fulfill({ json: path === 'mix' ? { items: entries, serverOrder: true } : { items: path === 'playlists'
      ? [{ id: 'mix', path: 'mix', name: 'Duplicate Mix', folder: true }] : [] } });
  });
  await page.route('**/api/sources/' + source.id + '/stream?**', async route => {
    const asset = new URL('/assets/demo-1.m4a', route.request().url());
    await route.fulfill({ response: await route.fetch({ url: asset.href }) });
  });
  await page.route('**/api/sources/' + source.id + '/playlist?**', route => {
    const action = route.request().postDataJSON();
    mutation.push(action);
    entries = entries.filter(entry => entry.playlistEntry !== action.entryId);
    return route.fulfill({ json: { updated: true } });
  });

  await page.goto('/#sources');
  await page.locator('[data-action="open-cloud"]').press('Enter');
  await page.getByRole('button', { name: '服务器歌单' }).press('Enter');
  await page.getByRole('button', { name: 'Duplicate Mix' }).press('Enter');
  const content = page.locator('#content');
  const rows = content.locator('tbody tr');
  const filter = content.getByRole('searchbox', { name: '搜索此歌单' });
  await expect(rows).toHaveCount(3);
  await filter.fill('repeat');
  await expect(rows).toHaveCount(2);
  await rows.nth(1).getByRole('button', { name: 'Repeat Song Test Artist' }).press('Enter');
  await expect(page.locator('#now .queue-row.current')).toHaveJSProperty('className', 'queue-row current');
  await expect(page.locator('#now .queue-row').nth(2)).toHaveClass(/current/);

  await rows.nth(1).getByRole('button', { name: '从 Emby 歌单移除' }).press('Enter');
  await expect(rows).toHaveCount(1);
  expect(mutation).toEqual([{ action: 'remove', entryId: 'entry-2' }]);
  await filter.fill('');
  await expect(rows.locator('.track-name')).toHaveText(['Repeat Song', 'Bridge Song']);
});

test('scrolls an open playlist back to the top when its title is double-clicked', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('groovebox.state.v1', JSON.stringify({
    playlists: [{ id: 'long', name: 'Long Playlist', tracks: Array.from({ length: 128 }, (_, index) => 'demo-' + (index % 8 + 1)) }],
  })));
  await page.goto('/#playlist%2Flong');
  const workspace = page.locator('.workspace');
  const title = workspace.getByRole('heading', { name: 'Long Playlist' });
  await expect(title).toBeVisible();
  await workspace.evaluate(element => { element.scrollTop = 600; });
  await expect.poll(() => workspace.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await title.dispatchEvent('dblclick');
  await expect.poll(() => workspace.evaluate(element => element.scrollTop)).toBe(0);
});
