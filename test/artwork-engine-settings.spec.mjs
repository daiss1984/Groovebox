import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const stateKey = 'groovebox.state.v1';
const album = 'Artwork Engine Album';
const artist = 'Artwork Engine Artist';
const albumCover = '/api/artwork/cover?id=96e2cff0-58f6-445f-9f65-4a9a9f281782';
const portrait = {
  cover: '/api/artwork/artist-cover?id=6c7d81cc-a077-4125-a6bc-3a756d0474b5',
  attribution: {
    name: 'Artwork fixture.jpg', url: 'https://commons.wikimedia.org/wiki/File:Artwork_fixture.jpg',
    license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
};

const songCovers = page => page.locator('#online-cover');
const artistPhotos = page => page.locator('#artist-image-engine');
const albumFallback = page => page.locator('#artist-album-cover-fallback');
const go = (page, name) => page.locator('#sidebar [data-nav="' + name + '"]').press('Enter');
const savedState = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), stateKey);

async function restoreSettings(page, settings) {
  const data = { version: 1, playlists: [], settings };
  await page.locator('#restore-file').setInputFiles({
    name: 'groovebox-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)),
  });
}

test('defaults all three artwork settings on and restores independent choices with localized controls', async ({ page }) => {
  await page.goto('/#settings');
  await expect(page.getByRole('checkbox', { name: '自动查找艺人照片' })).toBeChecked();
  await expect(songCovers(page)).toBeChecked();
  await expect(albumFallback(page)).toBeChecked();

  const language = page.locator('#interface-language');
  await language.selectOption('en');
  await expect(page.getByRole('checkbox', { name: 'Find artist photos automatically' })).toBeChecked();
  await expect(page.getByText('Use an available album cover when automatic artist photo lookup is off.')).toBeVisible();
  await language.selectOption('ja');
  await expect(page.getByRole('checkbox', { name: 'アーティスト写真を自動で検索する' })).toBeChecked();
  await language.selectOption('ko');
  await expect(page.getByRole('checkbox', { name: '아티스트 사진 자동 검색' })).toBeChecked();
  await language.selectOption('en');

  await songCovers(page).press('Space');
  await albumFallback(page).press('Space');
  await expect(songCovers(page)).not.toBeChecked();
  await expect(artistPhotos(page)).toBeChecked();
  await expect(albumFallback(page)).not.toBeChecked();
  await page.reload();
  await expect(songCovers(page)).not.toBeChecked();
  await expect(artistPhotos(page)).toBeChecked();
  await expect(albumFallback(page)).not.toBeChecked();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).press('Enter');
  const file = await (await download).path();
  expect(JSON.parse(await readFile(file, 'utf8')).settings).toMatchObject({
    onlineCover: false, artistImageEngine: true, artistAlbumCoverFallback: false,
  });
  await songCovers(page).press('Space');
  await artistPhotos(page).press('Space');
  await albumFallback(page).press('Space');
  await page.locator('#restore-file').setInputFiles(file);
  await expect(songCovers(page)).not.toBeChecked();
  await expect(artistPhotos(page)).toBeChecked();
  await expect(albumFallback(page)).not.toBeChecked();
});

test('migrates explicit legacy artwork booleans from storage and old backups', async ({ page }) => {
  await page.addInitScript(key => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: {
      onlineCover: false, artistAlbumCoverFallback: false,
    } }));
  }, stateKey);
  await page.goto('/#settings');
  await expect(songCovers(page)).not.toBeChecked();
  await expect(artistPhotos(page)).not.toBeChecked();
  await expect(albumFallback(page)).not.toBeChecked();
  await restoreSettings(page, { onlineCover: true, artistAlbumCoverFallback: false });
  await expect(songCovers(page)).toBeChecked();
  await expect(artistPhotos(page)).toBeChecked();
  await expect(albumFallback(page)).not.toBeChecked();
  await restoreSettings(page, { onlineCover: false, artistImageEngine: true });
  await expect(songCovers(page)).not.toBeChecked();
  await expect(artistPhotos(page)).toBeChecked();
  await expect(albumFallback(page)).toBeChecked();
  await page.reload();
  await expect(songCovers(page)).not.toBeChecked();
  await expect(artistPhotos(page)).toBeChecked();
});

test('cancels the disabled engine’s lookup and discards even a late successful reply', async ({ page }) => {
  await page.addInitScript(({ key, artist, album, portrait, albumCover }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { demos: false, language: 'en' }, tracks: [{
      id: 'baidu:artwork-engine', title: 'Artwork Engine Track', artist, album, provider: 'baidu',
      albumIsFallback: false, src: '/api/baidu/stream?id=481',
    }] }));
    const actualFetch = window.fetch.bind(window);
    const jobs = { artist: [], album: [] };
    window.artworkFixtures = jobs;
    window.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input, location.origin);
      if (!['/api/artwork/artist', '/api/artwork/album'].includes(url.pathname)) return actualFetch(input, options);
      const kind = url.pathname.split('/').at(-1);
      return new Promise(resolve => {
        const entry = { signal: options.signal, settle: () => resolve(Response.json(kind === 'artist' ? portrait : { cover: albumCover })) };
        jobs[kind].push(entry);
      });
    };
  }, { key: stateKey, artist, album, portrait, albumCover });
  const image = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
  await page.route('**/api/artwork/*-cover?*', route => route.fulfill({ body: image, contentType: 'image/jpeg' }));
  await page.route('**' + albumCover, route => route.fulfill({ body: image, contentType: 'image/jpeg' }));
  const pending = () => page.evaluate(() => Object.fromEntries(Object.entries(window.artworkFixtures)
    .map(([kind, jobs]) => [kind, jobs.map(job => job.signal.aborted)])));
  const openAlbum = () => page.locator('#content [data-action="group"]').filter({ hasText: album }).press('Enter');
  const openArtist = () => page.locator('#content [data-action="group"]').filter({ hasText: artist }).press('Enter');

  await page.goto('/#albums');
  await openAlbum();
  await expect.poll(pending).toEqual({ album: [false], artist: [] });
  await go(page, 'artists');
  await openArtist();
  await expect.poll(pending).toEqual({ album: [false], artist: [false] });
  await go(page, 'settings');
  await artistPhotos(page).press('Space');
  await expect.poll(pending).toEqual({ album: [false], artist: [true] });
  await expect(songCovers(page)).toBeChecked();
  await songCovers(page).press('Space');
  await expect.poll(pending).toEqual({ album: [true], artist: [true] });
  await page.evaluate(() => {
    for (const jobs of Object.values(window.artworkFixtures)) jobs[0].settle();
  });
  await go(page, 'albums');
  await openAlbum();
  await expect(page.locator('.album-detail-cover img')).toHaveCount(0);
  await go(page, 'artists');
  await openArtist();
  await expect(page.locator('.artist-portrait img')).toHaveCount(0);
  expect(await pending()).toEqual({ album: [true], artist: [true] });
  expect(await savedState(page)).toMatchObject({ artistPortraits: [], onlineCovers: [] });

  await go(page, 'settings');
  await artistPhotos(page).press('Space');
  await go(page, 'artists');
  await openArtist();
  await expect.poll(pending).toEqual({ album: [true], artist: [true, false] });
  await page.evaluate(() => window.artworkFixtures.artist[1].settle());
  await expect(page.locator('.artist-portrait img')).toHaveAttribute('src', portrait.cover);
  await go(page, 'albums');
  await openAlbum();
  await expect(page.locator('.album-detail-cover img')).toHaveCount(0);
  expect(await pending()).toEqual({ album: [true], artist: [true, false] });
  await go(page, 'settings');
  await songCovers(page).press('Space');
  await go(page, 'albums');
  await openAlbum();
  await expect.poll(pending).toEqual({ album: [true, false], artist: [true, false] });
  await page.evaluate(() => window.artworkFixtures.album[1].settle());
  await expect(page.locator('.album-detail-cover img')).toHaveAttribute('src', albumCover);
});
