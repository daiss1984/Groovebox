import { expect, test } from '@playwright/test';

const track = {
  id: 'lyrics-version-fixture', provider: 'demo', src: '/assets/demo-1.m4a',
  title: 'Version Fixture', artist: 'Fixture Band', album: 'Studio Album', duration: 164,
};
const oldLyrics = 'Original online lyrics';
const otherLyrics = 'Different live version';
const studio = {
  id: 1, trackName: track.title, artistName: track.artist, albumName: track.album,
  duration: 164, syncedLyrics: '[00:00]' + oldLyrics,
};
const live = {
  ...studio, id: 2, albumName: 'Live Album', duration: 180, syncedLyrics: '[00:00]' + otherLyrics,
};
const stateKey = 'groovebox.state.v1';
const savedLyrics = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)).onlineLyrics ?? [], stateKey);
const now = page => page.locator('#now');
const dialog = page => page.getByRole('dialog');
const browse = page => now(page).getByRole('button', { name: 'Browse Other Versions', exact: true });
const search = page => dialog(page).getByRole('button', { name: 'Search lyrics', exact: true });
const showing = page => now(page).locator('.lyric-line');
const elapsed = page => page.locator('#audio').evaluate(audio => audio.currentTime);

async function fixture(page, { seedMatch = false, defer = false } = {}) {
  await page.addInitScript(({ track, oldLyrics, stateKey, seedMatch, defer }) => {
    if (!localStorage.getItem(stateKey)) localStorage.setItem(stateKey, JSON.stringify({
      tracks: [track], settings: { demos: false, language: 'en' },
      ...(seedMatch && { onlineLyrics: [[track.id, [{ time: 0, text: oldLyrics }], true]] }),
    }));
    if (!defer) return;
    const original = window.fetch.bind(window);
    window.lyricVersionRequests = [];
    window.fetch = (input, options) => {
      const url = new URL(input, location.origin);
      if (url.origin !== 'https://lrclib.net') return original(input, options);
      return new Promise(resolve => window.lyricVersionRequests.push({ path: url.pathname, signal: options.signal, resolve }));
    };
  }, { track, oldLyrics, stateKey, seedMatch, defer });
  await page.goto('/#songs');
  await page.locator('#content').getByRole('button', { name: 'Version Fixture Fixture Band', exact: true }).press('Enter');
  await now(page).getByRole('button', { name: 'Lyrics', exact: true }).press('Enter');
}

test('browses other online versions directly even when an identical exact match exists', async ({ page }) => {
  const requests = [];
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Lrclib-Client' };
  await page.route(/^https:\/\/lrclib\.net\/api\/(?:get|search)\?/, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(route.request().url());
    requests.push([url.pathname, Object.fromEntries(url.searchParams)]);
    return route.fulfill({ headers: cors, json: url.pathname === '/api/get' ? studio :
      url.searchParams.has('album_name') ? [live] : [studio, live, { ...studio, albumName: 'No lyrics', instrumental: true }] });
  });
  await fixture(page);
  await now(page).getByRole('button', { name: 'Find lyrics online', exact: true }).press('Enter');
  await search(page).press('Enter');
  await expect(showing(page)).toHaveText(oldLyrics);
  const old = await savedLyrics(page);
  expect(requests.map(([path]) => path)).toEqual(['/api/get']);

  await browse(page).press('Enter');
  await expect(dialog(page).getByRole('heading', { name: 'Browse Other Versions' })).toBeVisible();
  await expect(dialog(page).getByRole('textbox', { name: 'Song title' })).toHaveValue(track.title);
  await expect(dialog(page).getByRole('textbox', { name: 'Artist (optional)' })).toHaveValue(track.artist);
  await expect(dialog(page).getByRole('textbox', { name: 'Album (optional)' })).toHaveValue('');
  const afterOpening = requests.length;
  await search(page).press('Enter');
  await expect(dialog(page).getByRole('button', { name: /Studio Album.*2:44/ })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /Live Album.*3:00/ })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /No lyrics/ })).toHaveCount(0);
  await expect(showing(page)).toHaveText(oldLyrics);
  expect(await savedLyrics(page)).toEqual(old);
  expect(requests.slice(afterOpening)).toEqual([
    ['/api/search', { track_name: track.title, artist_name: track.artist }],
  ]);
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).press('Enter');
  await expect(showing(page)).toHaveText(oldLyrics);
  expect(await savedLyrics(page)).toEqual(old);

  await browse(page).press('Enter');
  await dialog(page).getByRole('textbox', { name: 'Album (optional)' }).fill(live.albumName);
  await search(page).press('Enter');
  const candidate = dialog(page).getByRole('button', { name: /Live Album.*3:00/ });
  await expect(candidate).toBeVisible();
  expect(requests.at(-1)).toEqual(['/api/search', { track_name: track.title, artist_name: track.artist, album_name: live.albumName }]);
  await expect.poll(() => elapsed(page)).toBeGreaterThan(0.2);
  const before = await elapsed(page);
  await candidate.press('Enter');
  await expect(showing(page)).toHaveText(otherLyrics);
  await expect.poll(() => elapsed(page)).toBeGreaterThanOrEqual(before);
  expect(await savedLyrics(page)).toEqual([[track.id, [{ time: 0, text: otherLyrics }], true]]);

  await page.reload();
  await expect(page.locator('#player-title')).toHaveText(track.title);
  await now(page).getByRole('button', { name: 'Lyrics', exact: true }).press('Enter');
  await expect(showing(page)).toHaveText(otherLyrics);
  expect(requests.map(([path]) => path)).toEqual(['/api/get', '/api/search', '/api/search']);
});

function pending(page) {
  return page.evaluate(() => window.lyricVersionRequests.map(({ path, signal }) => ({ path, aborted: signal.aborted })));
}

async function respond(page, index, data, status = 200) {
  await page.evaluate(async ({ index, data, status }) => {
    window.lyricVersionRequests[index].resolve(new Response(JSON.stringify(data), {
      status, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
    }));
    await new Promise(resolve => requestAnimationFrame(resolve));
  }, { index, data, status });
}

test('cancels dismissed searches and honors backoff from a current response', async ({ page }) => {
  await fixture(page, { seedMatch: true, defer: true });
  const close = () => dialog(page).getByRole('button', { name: 'Close', exact: true }).press('Enter');
  const openSearch = async () => {
    await browse(page).press('Enter');
    await search(page).press('Enter');
  };
  await openSearch();
  await expect.poll(() => pending(page)).toEqual([{ path: '/api/search', aborted: false }]);
  await close();
  await openSearch();
  await expect.poll(() => pending(page)).toEqual([
    { path: '/api/search', aborted: true }, { path: '/api/search', aborted: false },
  ]);
  await respond(page, 0, [], 429);
  await expect(search(page)).toBeDisabled();
  await respond(page, 1, [live]);
  await expect(dialog(page).getByRole('button', { name: /Live Album/ })).toBeVisible();
  await close();
  await expect(showing(page)).toHaveText(oldLyrics);

  await openSearch();
  await expect.poll(async () => (await pending(page)).length).toBe(3);
  await respond(page, 2, [], 429);
  await expect(dialog(page).getByRole('status')).toHaveText('The lyrics service is busy. Try again shortly.');
  await close();
  await openSearch();
  await expect(dialog(page).getByRole('status')).toHaveText('Too many lyrics requests. Try again shortly.');
  expect(await pending(page)).toHaveLength(3);
  await expect(showing(page)).toHaveText(oldLyrics);
  expect(await savedLyrics(page)).toEqual([[track.id, [{ time: 0, text: oldLyrics }], true]]);
});
