import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const stateKey = 'groovebox.state.v1';
const lyricsPanel = page => page.locator('#now');
const dialog = page => page.getByRole('dialog');
const nav = (page, id) => page.locator('#sidebar [data-nav="' + id + '"]').press('Enter');
const play = (page, title) => page.locator('#content tr').filter({ hasText: title }).locator('.track-main').press('Enter');
const lyrics = page => lyricsPanel(page).getByRole('button', { name: 'Lyrics', exact: true }).press('Enter');
const position = page => page.locator('#audio').evaluate(audio => audio.currentTime);
const lyricMatch = page => lyricsPanel(page).getByRole('button', { name: 'Find lyrics online', exact: true });
const storedMatches = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)).onlineLyrics ?? [], stateKey);

const first = { id: 'track-one', provider: 'demo', src: '/assets/demo-1.m4a', title: 'First Track', artist: 'Fixture Band' };
const second = { id: 'track-two', provider: 'demo', src: '/assets/demo-2.m4a', title: 'Second Track', artist: 'Fixture Band' };
const lines = text => [{ time: 0, text }];

async function fixture(page, tracks, { online = [], auto = false, deferReads = false } = {}) {
  await page.addInitScript(({ key, tracks, online, auto, deferReads }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      tracks, onlineLyrics: online, settings: { language: 'en', demos: false, autoMatchLyrics: auto },
    }));
    if (!deferReads) return;
    const fetch = window.fetch.bind(window);
    window.lyricReads = [];
    window.fetch = (input, options) => {
      const url = new URL(input, location.origin);
      if (url.hostname !== 'lrclib.net' && url.pathname !== '/api/baidu/lyrics') return fetch(input, options);
      return new Promise(resolve => window.lyricReads.push({ url: url.href, signal: options.signal, resolve }));
    };
  }, { key: stateKey, tracks, online, auto, deferReads });
  await page.goto('/#songs');
}

async function openClearDialog(page) {
  await nav(page, 'settings');
  await page.getByRole('button', { name: 'Clear Lyrics Cache', exact: true }).press('Enter');
  await expect(dialog(page)).toBeVisible();
}

async function clearCache(page) {
  await openClearDialog(page);
  await dialog(page).getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toHaveText('Lyrics cache cleared.');
  expect(await storedMatches(page)).toEqual([]);
}

function requests(page) {
  return page.evaluate(() => window.lyricReads.map(read => ({
    source: new URL(read.url).pathname, track: new URL(read.url).searchParams.get('track_name'), aborted: read.signal.aborted,
  })));
}

async function release(page, index, data) {
  await page.evaluate(async ({ index, data }) => {
    window.lyricReads[index].resolve(new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
    await new Promise(resolve => requestAnimationFrame(resolve));
  }, { index, data });
}

test('clearing in another tab prevents stale matches from returning on the next settings save', async ({ page, context }) => {
  await fixture(page, [first], { online: [[first.id, lines('Cross-tab saved lyric'), true]] });
  const other = await context.newPage();
  await other.goto('/#songs');
  await play(other, first.title);
  await lyrics(other);
  await expect(lyricsPanel(other).getByText('Cross-tab saved lyric', { exact: true })).toBeVisible();
  await clearCache(page);
  await expect.poll(() => other.evaluate(() => localStorage.getItem('groovebox.lyrics-cache-epoch.v1'))).not.toBeNull();
  await other.locator('#volume').evaluate(input => { input.value = '49'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change')); });
  expect(await storedMatches(other)).toEqual([]);
  await expect(lyricsPanel(other).getByText('Cross-tab saved lyric', { exact: true })).toBeVisible();
  await other.reload();
  expect(await storedMatches(other)).toEqual([]);
  await expect(lyricsPanel(other).getByText('Cross-tab saved lyric', { exact: true })).toHaveCount(0);
});

test('a held lookup in another tab cannot publish lyrics after a cache clear', async ({ page, context }) => {
  await fixture(page, [first]);
  const other = await context.newPage();
  await fixture(other, [first], { deferReads: true });
  await play(other, first.title);
  await lyrics(other);
  await lyricMatch(other).press('Enter');
  await dialog(other).getByRole('button', { name: 'Search lyrics', exact: true }).press('Enter');
  await expect.poll(async () => (await requests(other)).length).toBe(1);
  await clearCache(page);
  await expect.poll(async () => (await requests(other))[0].aborted).toBe(true);
  await expect(dialog(other)).not.toBeVisible();
  await release(other, 0, { syncedLyrics: '[00:00]Late cross-tab lyric' });
  await other.locator('#volume').evaluate(input => input.dispatchEvent(new Event('change')));
  expect(await storedMatches(other)).toEqual([]);
  await expect(lyricsPanel(other).getByText('Late cross-tab lyric', { exact: true })).toHaveCount(0);
  await lyricMatch(other).press('Enter');
  await dialog(other).getByRole('button', { name: 'Search lyrics', exact: true }).press('Enter');
  await expect.poll(async () => (await requests(other)).length).toBe(2);
  await release(other, 1, { syncedLyrics: '[00:00]Fresh cross-tab lyric' });
  await expect(lyricsPanel(other).getByText('Fresh cross-tab lyric', { exact: true })).toBeVisible();
  expect(await storedMatches(other)).toEqual([[first.id, lines('Fresh cross-tab lyric'), true]]);
});

test('clears saved matches while current lyrics, embedded source selection and offline audio remain usable', async ({ page }) => {
  const bytes = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const remote = { ...first, id: 'baidu:19', provider: 'baidu', src: '/api/baidu/stream?id=19',
    lyrics: lines('Embedded original line') };
  const match = 'Saved online line';
  let online = true;
  await page.route('**' + remote.src, route => online
    ? route.fulfill({ body: bytes, contentType: 'audio/mp4' }) : route.abort('internetdisconnected'));
  await fixture(page, [remote], { online: [[remote.id, lines(match), true]] });
  await page.locator('#content tr').filter({ hasText: first.title }).getByRole('button', { name: 'Track Options' }).press('Enter');
  await dialog(page).getByRole('button', { name: 'Save for Offline Playback', exact: true }).press('Enter');
  await nav(page, 'offline');
  await expect(page.locator('#content').getByRole('button', { name: /^First Track/ })).toBeVisible();
  await nav(page, 'songs');
  await page.locator('#import-files').setInputFiles([
    { name: 'Fixture Band - Local Track.m4a', mimeType: 'audio/mp4', buffer: bytes },
    { name: 'Fixture Band - Local Track.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:00]Imported original line') },
  ]);
  online = false;
  await play(page, first.title);
  await lyrics(page);
  await expect(lyricsPanel(page).getByText(match, { exact: true })).toBeVisible();
  await expect.poll(() => position(page)).toBeGreaterThan(0.1);

  await openClearDialog(page);
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  expect(await storedMatches(page)).toEqual([[remote.id, lines(match), true]]);
  const before = await position(page);
  await clearCache(page);
  await expect.poll(() => position(page)).toBeGreaterThan(before);
  await expect(lyricsPanel(page).getByText(match, { exact: true })).toBeVisible();
  await lyricsPanel(page).getByRole('button', { name: 'Use original lyrics', exact: true }).press('Enter');
  await expect(lyricsPanel(page).getByText('Embedded original line', { exact: true })).toBeVisible();
  await lyricsPanel(page).getByRole('button', { name: 'Use matched lyrics', exact: true }).press('Enter');
  await expect(lyricsPanel(page).getByText(match, { exact: true })).toBeVisible();
  expect(await storedMatches(page)).toEqual([]);

  await nav(page, 'songs');
  await play(page, 'Local Track');
  await expect(lyricsPanel(page).getByText('Imported original line', { exact: true })).toBeVisible();
  await play(page, first.title);
  await expect(lyricsPanel(page).getByText('Embedded original line', { exact: true })).toBeVisible();
  await expect(lyricsPanel(page).getByText(match, { exact: true })).toHaveCount(0);
  await page.reload();
  await nav(page, 'offline');
  await play(page, first.title);
  await lyrics(page);
  await expect(lyricsPanel(page).getByText('Embedded original line', { exact: true })).toBeVisible();
  await expect.poll(() => position(page)).toBeGreaterThan(0.1);
  expect(await storedMatches(page)).toEqual([]);
});

test('ignores a delayed automatic match and resumes matching on another play', async ({ page }) => {
  await fixture(page, [first, second], { auto: true, deferReads: true });
  await play(page, first.title);
  await lyrics(page);
  await expect.poll(() => requests(page)).toEqual([{ source: '/api/get', track: first.title, aborted: false }]);
  await clearCache(page);
  await expect.poll(() => requests(page)).toEqual([{ source: '/api/get', track: first.title, aborted: true }]);
  await nav(page, 'songs');
  await play(page, second.title);
  await expect.poll(() => requests(page)).toEqual([
    { source: '/api/get', track: first.title, aborted: true },
    { source: '/api/get', track: second.title, aborted: false },
  ]);
  await release(page, 0, { plainLyrics: 'Late old lyrics' });
  expect(await storedMatches(page)).toEqual([]);
  await expect(lyricsPanel(page).getByText('Late old lyrics', { exact: true })).toHaveCount(0);
  await release(page, 1, { plainLyrics: 'Fresh automatic lyrics' });
  await expect(lyricsPanel(page).getByText('Fresh automatic lyrics', { exact: true })).toBeVisible();
  expect((await storedMatches(page)).map(([id]) => id)).toEqual([second.id]);
  expect((await requests(page)).map(({ track }) => track)).toEqual([first.title, second.title]);
});

test('ignores an old provider read while a fresh replacement for the same lyric URL is active', async ({ page }) => {
  const src = '/api/baidu/lyrics?id=44';
  await fixture(page, [{ ...first, lyrics: src }], { deferReads: true });
  await play(page, first.title);
  await expect.poll(() => position(page)).toBeGreaterThan(.05);
  await lyrics(page);
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  await clearCache(page);
  await expect.poll(() => requests(page)).toEqual([
    { source: '/api/baidu/lyrics', track: null, aborted: true },
    { source: '/api/baidu/lyrics', track: null, aborted: false },
  ]);
  await release(page, 0, { lines: lines('Stale provider line') });
  await expect(lyricsPanel(page).getByText('Stale provider line', { exact: true })).toHaveCount(0);
  await release(page, 1, { lines: lines('Fresh provider line') });
  await expect(lyricsPanel(page).getByText('Fresh provider line', { exact: true })).toBeVisible();
  expect(await storedMatches(page)).toEqual([]);
  expect((await requests(page)).length).toBe(2);
});

test('ignores a canceled manual lookup and still saves a new explicit match', async ({ page }) => {
  await fixture(page, [first], { deferReads: true });
  await play(page, first.title);
  await lyrics(page);
  const search = dialog(page).getByRole('button', { name: 'Search lyrics', exact: true });
  await lyricMatch(page).press('Enter');
  await search.press('Enter');
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).press('Enter');
  await clearCache(page);

  await lyricMatch(page).press('Enter');
  await search.press('Enter');
  await expect.poll(async () => (await requests(page)).length).toBe(2);
  expect((await requests(page))[0].aborted).toBe(true);
  await release(page, 0, { syncedLyrics: '[00:00]Late manual match' });
  await expect(search).toBeDisabled();
  await expect(lyricsPanel(page).getByText('Late manual match', { exact: true })).toHaveCount(0);
  expect(await storedMatches(page)).toEqual([]);
  await release(page, 1, { syncedLyrics: '[00:00]New manual match' });
  await expect(lyricsPanel(page).getByText('New manual match', { exact: true })).toBeVisible();
  expect(await storedMatches(page)).toEqual([[first.id, lines('New manual match'), true]]);
});

test('a selected online candidate cannot return after Clear while its word-timing parser loads', async ({ page }) => {
  await fixture(page, [first], { deferReads: true });
  let releaseBundle;
  const bundleGate = new Promise(resolve => { releaseBundle = resolve; });
  await page.route('**/lyricsfile-yaml.bundle.js', async route => {
    await bundleGate;
    await route.continue();
  });
  try {
    await play(page, first.title);
    await lyrics(page);
    await lyricMatch(page).press('Enter');
    await dialog(page).getByRole('textbox', { name: 'Artist (optional)' }).fill('');
    const search = dialog(page).getByRole('button', { name: 'Search lyrics', exact: true });
    await search.press('Enter');
    await expect.poll(() => requests(page)).toEqual([{ source: '/api/search', track: first.title, aborted: false }]);
    await release(page, 0, [{
      trackName: first.title, artistName: first.artist, hasWordSync: true,
      lyricsfile: 'version: "1.0"\nlines:\n  - text: Stale chosen lyric\n    start_ms: 0',
    }]);
    const moduleRequested = page.waitForRequest('**/lyricsfile-yaml.bundle.js');
    await dialog(page).getByRole('button', { name: 'First Track · Fixture Band', exact: true }).press('Enter');
    await moduleRequested;
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).press('Enter');
    await clearCache(page);
    releaseBundle();
    await page.evaluate(async () => { await import('/lyricsfile-yaml.bundle.js'); });
    await expect(lyricsPanel(page).getByText('Stale chosen lyric', { exact: true })).toHaveCount(0);
    expect(await storedMatches(page)).toEqual([]);

    await lyricMatch(page).press('Enter');
    await search.press('Enter');
    await expect.poll(async () => (await requests(page)).length).toBe(2);
    await release(page, 1, { plainLyrics: 'Fresh lyric after canceled candidate' });
    await expect(lyricsPanel(page).getByText('Fresh lyric after canceled candidate', { exact: true })).toBeVisible();
  } finally {
    releaseBundle();
  }
});

test('keeps existing matches if saving the clear fails', async ({ page }) => {
  const initial = [[first.id, lines('Persisted lyric')]];
  await fixture(page, [first], { online: initial });
  await play(page, first.title);
  await lyrics(page);
  await openClearDialog(page);
  await page.evaluate(key => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === key) throw new DOMException('Fixture storage full', 'QuotaExceededError');
      return write.call(this, name, value);
    };
  }, stateKey);
  await dialog(page).getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toHaveText('Could not save the lyrics cache changes.');
  expect(await storedMatches(page)).toEqual(initial);
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  await expect(lyricsPanel(page).getByText('Persisted lyric', { exact: true })).toBeVisible();
});
