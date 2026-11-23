import { expect, test } from '@playwright/test';

const owner = { id: '412555e6-45e3-4a51-b68e-cbbe79485be4', name: 'Editing Server', type: 'jellyfin', playlistWritable: true };
const reader = { id: '61a3f264-ef19-44dd-b15f-d8b9762029bb', name: 'Listening Server', type: 'jellyfin' };
const rootSong = { id: 'song-3', title: 'New Song' };
const mix = { id: 'mix', path: 'mix', name: 'Owned Mix', folder: true, playlistWritable: true };
const shared = { id: 'shared', path: 'shared', name: 'Shared Mix', folder: true, playlistWritable: false };
const created = { id: 'created', path: 'created', name: 'Created Mix', folder: true, playlistWritable: true };
const action = (parent, name) => parent.locator('[data-action="' + name + '"]');
const panel = page => page.locator('#content');
const dialog = page => page.getByRole('dialog');
const administratorNotice = 'Adding tracks requires the selected user’s playlist edit permission. Removing tracks uses the administrator API key.';
const titles = page => panel(page).locator('tbody .track-name');
const rows = page => panel(page).locator('tbody tr');

function song(id, title, playlistEntry) { return { id, title, playlistEntry }; }
function track(source, item) {
  return { ...item, name: item.title, artist: 'Fixture Artist', streamUrl: '/api/sources/' + source.id + '/stream?id=' + item.id };
}

async function fixture(page, { apiKey = false } = {}) {
  let playlists = [mix, shared];
  const items = new Map([
    ['mix', [song('repeat', 'Repeat Song', 'first-repeat'), song('bridge', 'Bridge Song', 'bridge-entry'),
      song('repeat', 'Repeat Song', 'second-repeat')]],
    ['shared', [song('bridge', 'Bridge Song', 'untrusted-readonly-entry')]],
  ]);
  const requests = [];
  const behavior = {};
  const editingSource = { ...owner, ...(apiKey && { playlistAuthority: 'api-key' }) };
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [editingSource, reader] } }));
  await page.route(/\/api\/sources\/[^/]+\/list\?/, route => {
    const url = new URL(route.request().url());
    const source = url.pathname.includes(owner.id) ? owner : reader;
    const path = url.searchParams.get('path');
    if (path === '/') return route.fulfill({ json: { items: [track(source, rootSong)] } });
    if (path === 'playlists') return route.fulfill({ json: { items: source === owner ? playlists : [shared] } });
    return route.fulfill({ json: { items: (items.get(path) || []).map(item => track(source, item)), serverOrder: true,
      playlistWritable: source === owner && playlists.find(item => item.path === path)?.playlistWritable === true } });
  });
  await page.route(/\/api\/sources\/[^/]+\/stream\?/, async route => {
    const audio = new URL('/assets/demo-1.m4a', route.request().url());
    await route.fulfill({ response: await route.fetch({ url: audio.href }) });
  });
  await page.route(/\/api\/sources\/[^/]+\/playlist\?/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.searchParams.get('path');
    const body = request.postDataJSON();
    expect(request.method()).toBe('POST');
    expect(url.pathname).toBe('/api/sources/' + owner.id + '/playlist');
    requests.push({ path, body });
    await behavior.delay;
    if (behavior.reject) return route.fulfill({ status: 409, json: { error: 'Playlist changed on server' } });
    const finish = (json, status = 200) => {
      if (behavior.loss === 'network') return route.abort();
      if (behavior.loss === 'commit') return route.fulfill({ status: 503, json: { code: 'playlist_commit_unknown' } });
      return route.fulfill({ status, json: behavior.loss === 'invalid' ? {} : json });
    };
    if (body.action === 'create') {
      expect(path).toBe('playlists');
      expect(body.name).toBe(created.name);
      playlists = [...playlists, created];
      items.set(created.path, []);
      return finish({ playlist: created }, 201);
    }
    if (body.action === 'add') {
      expect(body.trackId).toBe(rootSong.id);
      items.get(path).push({ ...rootSong, playlistEntry: 'added-entry' });
    } else {
      items.set(path, items.get(path).filter(item => item.playlistEntry !== body.entryId && item.playlistRemoveEntry !== body.entryId));
    }
    return finish({ updated: true });
  });
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { demos: false, language: 'en' } }));
  });
  await page.goto('/#sources');
  await openSource(page, owner);
  return { behavior, items, requests };
}

async function openSource(page, source) {
  await action(page, 'open-cloud').and(page.locator('[data-id="' + source.id + '"]')).press('Enter');
  await expect(panel(page).getByRole('heading', { name: source.name, exact: true })).toBeVisible();
}

async function openPlaylists(page) {
  await action(panel(page), 'server-playlists').press('Enter');
  await expect(panel(page).getByRole('heading', { name: 'Server Playlists', exact: true })).toBeVisible();
}

async function openPlaylist(page, name) {
  await panel(page).getByRole('button', { name, exact: true }).press('Enter');
  await expect(panel(page).getByRole('heading', { name, exact: true })).toBeVisible();
}

async function pickDestination(page) {
  await panel(page).getByRole('button', { name: 'Track Options' }).press('Enter');
  await dialog(page).getByRole('button', { name: 'Add to Jellyfin Playlist', exact: true }).press('Enter');
}

test('creates an owned Jellyfin playlist and adds a track while keeping shared read-only lists playable', async ({ page }) => {
  const { requests } = await fixture(page);
  await openPlaylists(page);
  await expect(panel(page).getByText(administratorNotice, { exact: true })).toHaveCount(0);
  await openPlaylist(page, shared.name);
  await expect(titles(page)).toHaveText(['Bridge Song']);
  await expect(action(page, 'remove-jellyfin-playlist-entry')).toHaveCount(0);
  await expect(action(page, 'remove-jellyfin-playlist-entries')).toHaveCount(0);
  await rows(page).getByRole('button', { name: 'Bridge Song Fixture Artist', exact: true }).press('Enter');
  await expect.poll(() => page.locator('#audio').evaluate(audio => !audio.paused && audio.currentTime > 0.1)).toBe(true);
  await page.locator('.breadcrumbs').getByRole('button', { name: 'Server Playlists', exact: true }).press('Enter');
  await panel(page).getByRole('button', { name: 'New Jellyfin Playlist', exact: true }).press('Enter');
  await dialog(page).getByLabel('Playlist name').fill(created.name);
  expect(requests).toHaveLength(0);
  await dialog(page).getByRole('button', { name: 'Create Playlist', exact: true }).press('Enter');
  await expect(panel(page).getByRole('heading', { name: created.name, exact: true })).toBeVisible();
  await expect(panel(page).getByText('This playlist has no tracks', { exact: true })).toBeVisible();

  await page.locator('.breadcrumbs').getByRole('button', { name: 'Root', exact: true }).press('Enter');
  await pickDestination(page);
  await expect(dialog(page).getByRole('button', { name: mix.name, exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: shared.name, exact: true })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: created.name, exact: true }).press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await openPlaylists(page);
  await openPlaylist(page, created.name);
  await expect(titles(page)).toHaveText([rootSong.title]);
  expect(requests).toEqual([
    { path: 'playlists', body: { action: 'create', name: created.name } },
    { path: created.path, body: { action: 'add', trackId: rootSong.id } },
  ]);

  await page.goto('/#sources');
  await openSource(page, reader);
  await panel(page).getByRole('button', { name: 'Track Options' }).press('Enter');
  await expect(dialog(page).getByRole('button', { name: 'Add to Jellyfin Playlist', exact: true })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Close' }).press('Enter');
  await openPlaylists(page);
  await expect(panel(page).getByRole('button', { name: 'New Jellyfin Playlist' })).toHaveCount(0);
});

test('removes only the selected Jellyfin occurrence while filtering and waits for the server result', async ({ page }) => {
  const { requests, behavior, items } = await fixture(page);
  await openPlaylists(page);
  await openPlaylist(page, mix.name);
  const filter = panel(page).getByRole('searchbox', { name: 'Search this playlist' });
  await filter.fill('repeat');
  await expect(titles(page)).toHaveText(['Repeat Song', 'Repeat Song']);
  const removals = panel(page).getByRole('button', { name: 'Remove from Jellyfin Playlist', exact: true });
  const response = Promise.withResolvers();
  behavior.delay = response.promise;
  try {
    await removals.nth(1).press('Enter');
    await expect(removals.nth(1)).toBeDisabled();
    await removals.nth(0).press('Enter');
    await expect(titles(page)).toHaveCount(2);
    await expect.poll(() => requests.length).toBe(1);
    expect(requests).toEqual([{ path: mix.path, body: { action: 'remove', entryId: 'second-repeat' } }]);
  } finally { response.resolve(); }
  await expect(titles(page)).toHaveText(['Repeat Song']);
  await filter.fill('');
  await expect(titles(page)).toHaveText(['Repeat Song', 'Bridge Song']);
  expect(items.get(mix.path)[0].playlistEntry).toBe('first-repeat');
});

test('requires confirmation for shared native occurrence IDs and refreshes before retry when their count changes', async ({ page }) => {
  const { requests, behavior, items } = await fixture(page);
  const dupe = { id: 'same-native', title: 'Grouped Song', playlistRemoveEntry: 'group-of-two', playlistRemoveCount: 2 };
  items.set(mix.path, [dupe, song('bridge', 'Bridge Song', 'bridge-entry'), dupe]);
  await openPlaylists(page);
  await openPlaylist(page, mix.name);
  const groupButtons = panel(page).getByRole('button', { name: 'Remove All Occurrences (currently 2)', exact: true });
  await expect(groupButtons).toHaveCount(2);
  await expect(rows(page).nth(0).getByRole('button', { name: 'Remove from Jellyfin Playlist', exact: true })).toHaveCount(0);
  await groupButtons.nth(1).press('Enter');
  await expect(dialog(page)).toContainText('Remove all occurrences of “Grouped Song” from this Jellyfin playlist? There are currently 2.');
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  expect(requests).toHaveLength(0);

  await groupButtons.first().press('Enter');
  behavior.reject = true;
  const larger = { ...dupe, playlistRemoveEntry: 'group-of-three', playlistRemoveCount: 3 };
  items.set(mix.path, [larger, larger, song('bridge', 'Bridge Song', 'bridge-entry'), larger]);
  await dialog(page).getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('Playlist changed on server');
  await expect(dialog(page)).toHaveCount(0);
  const allThree = panel(page).getByRole('button', { name: 'Remove All Occurrences (currently 3)', exact: true });
  await expect(allThree).toHaveCount(3);
  behavior.reject = false;
  await allThree.first().press('Enter');
  await expect(dialog(page)).toContainText('Remove all occurrences of “Grouped Song” from this Jellyfin playlist? There are currently 3.');
  await dialog(page).getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
  await expect(titles(page)).toHaveText(['Bridge Song']);
  await expect(page.locator('#toast')).toHaveText('Removed all occurrences of this track from the Jellyfin playlist.');
  expect(requests).toEqual([
    { path: mix.path, body: { action: 'remove', entryId: 'group-of-two' } },
    { path: mix.path, body: { action: 'remove', entryId: 'group-of-three' } },
  ]);
});

test('dismisses an obsolete Jellyfin picker after source changes and preserves an unrelated dialog during an in-flight create', async ({ page }) => {
  const { requests, behavior } = await fixture(page);
  await pickDestination(page);
  const oldChoice = dialog(page).getByRole('button', { name: mix.name, exact: true });
  await expect(oldChoice).toBeVisible();
  await page.evaluate(id => { location.hash = encodeURIComponent('source/' + id); }, reader.id);
  await expect(panel(page).getByRole('heading', { name: reader.name, exact: true })).toBeVisible();
  await oldChoice.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  expect(requests).toHaveLength(0);

  await page.goto('/#sources');
  await openSource(page, owner);
  await openPlaylists(page);
  await action(page, 'new-jellyfin-playlist').press('Enter');
  await dialog(page).getByLabel('Playlist name').fill(created.name);
  const response = Promise.withResolvers();
  behavior.delay = response.promise;
  try {
    const submit = dialog(page).getByRole('button', { name: 'Create Playlist', exact: true });
    await submit.press('Enter');
    await expect(submit).toBeDisabled();
    await expect.poll(() => requests.length).toBe(1);
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).press('Enter');
    await page.goto('/#songs');
    await page.locator('#sidebar').getByRole('button', { name: 'New Playlist', exact: true }).first().press('Enter');
    await expect(dialog(page).getByRole('heading', { name: 'New Playlist', exact: true })).toBeVisible();
    response.resolve();
    await expect(page.locator('#toast')).toContainText('Created Jellyfin playlist');
    await expect(dialog(page).getByRole('heading', { name: 'New Playlist', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#songs$/);
  } finally { response.resolve(); }
});

test('rereads the Jellyfin playlist after lost create, add, and remove replies without sending another write', async ({ page }) => {
  const { requests, behavior } = await fixture(page, { apiKey: true });
  const toast = page.locator('#toast');
  const unknown = 'Jellyfin did not confirm the result. Check the server playlist before trying again.';
  await openPlaylists(page);
  await expect(panel(page).getByText(administratorNotice, { exact: true })).toBeVisible();
  behavior.loss = 'commit';
  await action(page, 'new-jellyfin-playlist').press('Enter');
  await dialog(page).getByLabel('Playlist name').fill(created.name);
  await dialog(page).getByRole('button', { name: 'Create Playlist', exact: true }).press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(toast).toHaveText(unknown);
  await expect(panel(page).getByRole('heading', { name: 'Server Playlists', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: created.name, exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);

  behavior.loss = 'network';
  await page.locator('.breadcrumbs').getByRole('button', { name: 'Root', exact: true }).press('Enter');
  await pickDestination(page);
  await expect(dialog(page).getByText(administratorNotice, { exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: created.name, exact: true }).press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(panel(page).getByRole('heading', { name: created.name, exact: true })).toBeVisible();
  await expect(titles(page)).toHaveText([rootSong.title]);
  await expect(toast).toHaveText(unknown);
  expect(requests).toHaveLength(2);

  behavior.loss = 'invalid';
  await panel(page).getByRole('button', { name: 'Remove from Jellyfin Playlist', exact: true }).press('Enter');
  await expect(panel(page).getByText('This playlist has no tracks', { exact: true })).toBeVisible();
  await expect(toast).toHaveText(unknown);
  expect(requests).toEqual([
    { path: 'playlists', body: { action: 'create', name: created.name } },
    { path: created.path, body: { action: 'add', trackId: rootSong.id } },
    { path: created.path, body: { action: 'remove', entryId: 'added-entry' } },
  ]);
});
