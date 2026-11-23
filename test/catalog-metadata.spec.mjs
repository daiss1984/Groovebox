import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const artist = 'Fixture Ensemble';
const album = 'Night Sessions';
const genre = 'Jazz Fusion';
const title = 'Moonlight Session';
const cover = '/api/artwork/cover?id=905a104c-d081-48ee-8650-d83d59cafe37';

async function verifyCatalogMetadata(page, mobile) {
  const image = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
  let lyricRequests = 0;
  let artworkRequests = 0;
  await page.addInitScript(({ title, artist, album, genre }) => {
    const key = 'groovebox.state.v1';
    if (localStorage.getItem(key)) return;
    const tracks = [
      { id: 'catalog-1', title, artist, album, genres: [genre], src: '/api/baidu/stream?id=101' },
      { id: 'catalog-2', title: 'Quiet Afternoon', artist, album: 'Day Sessions', genres: ['Ambient'], src: '/api/baidu/stream?id=102' },
    ].map(track => ({ ...track, provider: 'baidu', duration: 164, albumIsFallback: false }));
    localStorage.setItem(key, JSON.stringify({ tracks, settings: { autoMatchLyrics: true, onlineCover: true, demos: false } }));
  }, { title, artist, album, genre });
  await page.route('**/api/baidu/stream?**', async route => {
    const url = new URL('/assets/demo-1.m4a', route.request().url()).href;
    await route.fulfill({ response: await route.fetch({ url }) });
  });
  await page.route('**/api/artwork/album?**', route => {
    artworkRequests++;
    expect(Object.fromEntries(new URL(route.request().url()).searchParams)).toEqual({ artist, album });
    return route.fulfill({ json: { cover } });
  });
  await page.route('**' + cover, route => route.fulfill({ contentType: 'image/jpeg', body: image }));
  await page.route('https://lrclib.net/api/get?**', route => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Lrclib-Client',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    lyricRequests++;
    expect(Object.fromEntries(new URL(route.request().url()).searchParams))
      .toEqual({ track_name: title, artist_name: artist, album_name: album, duration: '164' });
    return route.fulfill({ headers, json: { syncedLyrics: '[00:01.00]First fixture line\n[00:06.00]Second fixture line' } });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '你的云端唱片室' })).toBeVisible();
  if (mobile) await page.getByRole('button', { name: '菜单' }).click();
  await page.locator('#sidebar [data-nav="genres"]').press('Enter');
  const content = page.locator('#content');
  await content.getByRole('button', { name: new RegExp(genre) }).press('Enter');
  await expect(content.getByRole('heading', { name: genre, exact: true })).toBeVisible();
  await expect(content.getByText('Quiet Afternoon')).toHaveCount(0);
  await content.getByRole('button', { name: title + ' ' + artist, exact: true }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText(title);
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
  const playerCover = page.locator('#player-art img');
  await expect(playerCover).toHaveAttribute('src', cover);
  await expect.poll(() => playerCover.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);

  const playerPanel = page.locator('#now');
  const openLyrics = async () => {
    if (!(await playerPanel.isVisible())) await page.locator('.player-options [data-action="queue-panel"]').press('Enter');
    await playerPanel.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  };
  await openLyrics();
  const line = playerPanel.getByRole('button', { name: 'Second fixture line' });
  await line.press('Enter');
  await expect(line).toHaveClass(/\bcurrent\b/);
  await expect(playerPanel.locator('.now-cover img')).toHaveAttribute('src', cover);

  await page.reload();
  await expect(content.getByRole('heading', { name: genre, exact: true })).toBeVisible();
  await expect(playerCover).toHaveAttribute('src', cover);
  await openLyrics();
  await expect(line).toBeVisible();
  expect(lyricRequests).toBe(1);
  expect(artworkRequests).toBe(1);
}

test('plays a genre and reuses its online cover and synchronized lyrics on desktop', ({ page }) => verifyCatalogMetadata(page, false));
test('plays a genre and reuses its online cover and synchronized lyrics @mobile', ({ page }) => verifyCatalogMetadata(page, true));
