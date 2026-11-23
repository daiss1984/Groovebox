import { expect, test } from '@playwright/test';

const src = '/api/sources/518d77fa-7ea7-4b57-b891-bceba8a53188/stream?id=fixture-lyrics';
const track = { id: 'server-lyrics-fixture', provider: 'demo', src: '/assets/demo-1.m4a', lyrics: src,
  title: 'Server Lyrics Fixture', artist: 'Fixture Artist' };
const next = { id: 'next-fixture', provider: 'demo', src: '/assets/demo-2.m4a', title: 'Next Lyric Fixture', artist: 'Fixture Artist' };
const english = { id: 'a'.repeat(24), language: 'eng', title: track.title, timed: true,
  lines: [{ time: 1, text: 'Original server lyric' }] };
const japanese = { id: 'b'.repeat(24), language: 'jpn', title: track.title, timed: true,
  lines: [{ time: 4, text: '新しい 詩', words: [{ time: 4, text: '新しい ' }, { time: 8, text: '詩' }] }] };
const french = { id: 'c'.repeat(24), language: 'fra', title: track.title, timed: false, lines: [{ time: null, text: 'Une autre strophe' }] };
const lyrics = page => page.locator('#now');
const picker = (page, area = lyrics(page)) => area.getByRole('button', { name: 'Server Lyric Versions', exact: true });
const dialog = page => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Server Lyric Versions' }) });
const position = page => page.locator('#audio').evaluate(element => element.currentTime);

async function stage(page, first = track, extraState = {}) {
  await page.addInitScript(({ track, next, extraState }) => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      tracks: [track, next], settings: { demos: false, language: 'en' },
      onlineLyrics: [[track.id, [{ time: 0, text: 'Previously matched online' }]]],
      ...extraState,
    }));
  }, { track: first, next, extraState });
  await page.goto('/#songs');
  await page.locator('#content').getByRole('button', { name: 'Server Lyrics Fixture Fixture Artist', exact: true }).press('Enter');
  await lyrics(page).getByRole('button', { name: 'Lyrics', exact: true }).press('Enter');
}

function payload(primary, variants) {
  const { lines, ...defaultVersion } = primary;
  return { lines, defaultVersion, variants };
}

test('selects timed and plain server languages, retains the online toggle, and remembers the variant across reorder', async ({ page }) => {
  let reordered = false;
  let reads = 0;
  await page.route('**' + src, route => {
    reads++;
    return route.fulfill({ json: reordered ? payload(french, [japanese, english]) : payload(english, [japanese, french]) });
  });
  await stage(page);
  await expect(lyrics(page).getByRole('button', { name: /^Original server lyric/ })).toBeVisible();
  await expect(lyrics(page).locator('.lyric-translation')).toHaveCount(0);
  await picker(page).press('Enter');
  await expect(dialog(page).getByRole('button', { name: 'English · Synchronized lyrics' })).toHaveAttribute('aria-pressed', 'true');
  await dialog(page).getByRole('button', { name: 'French · Plain lyrics' }).press('Enter');
  await expect(lyrics(page).getByText('Une autre strophe', { exact: true })).toBeVisible();
  await expect(lyrics(page).locator('.lyric-line[data-time]')).toHaveCount(0);
  await lyrics(page).getByRole('button', { name: 'Use matched lyrics', exact: true }).press('Enter');
  await expect(lyrics(page).getByText('Previously matched online', { exact: true })).toBeVisible();

  await picker(page).press('Enter');
  await dialog(page).getByRole('button', { name: 'Japanese · Synchronized lyrics' }).press('Enter');
  await expect(picker(page)).toBeFocused();
  const line = lyrics(page).getByRole('button', { name: '新しい 詩', exact: true });
  await expect(line).toBeVisible();
  await line.press('Enter');
  await expect.poll(() => position(page)).toBeGreaterThanOrEqual(4);
  await expect(line.locator('.current-word')).toHaveText('新しい ');
  await expect(lyrics(page).locator('.lyric-translation')).toHaveCount(0);
  expect(reads).toBe(1);

  reordered = true;
  await page.reload();
  await lyrics(page).getByRole('button', { name: 'Lyrics', exact: true }).press('Enter');
  await expect(line).toBeVisible();
  await page.locator('#player-art').press('Enter');
  const immersive = page.getByRole('region', { name: 'Immersive Player' });
  await picker(page, immersive).press('Enter');
  await expect(dialog(page).getByRole('button', { name: 'Japanese · Synchronized lyrics' })).toHaveAttribute('aria-pressed', 'true');
  expect(reads).toBe(2);
});

test('retains a translation from a server with a single version', async ({ page }) => {
  const lines = [{ ...english.lines[0], translation: '第一行\n第二行' }];
  await page.route('**' + src, route => route.fulfill({ json: { lines } }));
  await stage(page);
  await expect(lyrics(page).locator('.lyric-translation')).toHaveText(/第一行\s*第二行/);
  await expect(picker(page)).toHaveCount(0);
});

test('labels distinct unspecified versions and ignores a stale picker after automatic track advance', async ({ page }) => {
  const first = { ...english, language: 'xxx' };
  const alternate = { ...japanese, language: 'und' };
  await page.route('**' + src, route => route.fulfill({ json: payload(first, [alternate]) }));
  await stage(page);
  await expect.poll(() => position(page)).toBeGreaterThan(0.1);
  await picker(page).press('Enter');
  const option = dialog(page).getByRole('button', { name: 'Language unspecified · Synchronized lyrics · Version 2' });
  await expect(option).toBeVisible();
  await page.locator('#audio').evaluate(element => { element.currentTime = element.duration - 0.1; });
  await expect(page.locator('#player-title')).toHaveText(next.title);
  await option.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(lyrics(page).getByText('新しい 詩', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')).serverLyricChoices)).toEqual([]);
});

test('dismisses a stale picker when playlist syncing replaces the current song’s lyric source', async ({ page }) => {
  const id = '518d77fa-7ea7-4b57-b891-bceba8a53188';
  const first = { ...track, src: '/api/sources/' + id + '/stream?id=fixture-audio' };
  const replacement = { ...first, lyrics: src + '-replaced' };
  const replacementVersion = { ...english, id: 'd'.repeat(24), lines: [{ time: 1, text: 'New server source' }] };
  const snapshot = song => ({ version: 1, playlists: [], favorites: [song.id], tracks: [song] });
  let remote = snapshot(first);
  let reads = 0;
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [{ id, name: 'Fixture WebDAV', type: 'webdav' }] } }));
  await page.route('**/api/sources/' + id + '/backup', route => {
    reads++;
    return route.fulfill({ json: remote, headers: { ETag: '"snapshot-' + reads + '"' } });
  });
  await page.route('**' + first.src, async route => {
    const response = await route.fetch({ url: new URL(track.src, route.request().url()).href });
    await route.fulfill({ response });
  });
  await page.route('**' + src, route => route.fulfill({ json: payload(english, [japanese]) }));
  await page.route('**' + replacement.lyrics, route => route.fulfill({ json: payload(replacementVersion, [japanese]) }));
  await stage(page, first, { favorites: [first.id], playlistSync: { id, base: remote } });
  await expect.poll(() => reads).toBeGreaterThan(0);
  await picker(page).press('Enter');
  const option = dialog(page).getByRole('button', { name: 'Japanese · Synchronized lyrics' });
  await expect(option).toBeVisible();

  remote = snapshot(replacement);
  const fetched = page.waitForResponse(response => new URL(response.url()).pathname + new URL(response.url()).search === replacement.lyrics);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await fetched;
  await expect(lyrics(page).locator('.lyric-line')).toHaveText('New server source');
  await option.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(lyrics(page).locator('.lyric-line')).toHaveText('New server source');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')).serverLyricChoices)).toEqual([]);
});
