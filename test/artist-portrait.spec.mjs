import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const artist = '测试艺人';
const album = '测试专辑';
const portraitUrl = '/api/artwork/artist-cover?id=9d9d89d4-f21e-467e-9d24-556de5cd6a77';
const attribution = {
  name: 'Fixture portrait.jpg', url: 'https://commons.wikimedia.org/wiki/File:Fixture_portrait.jpg',
  author: '摄影者 <example>', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
};

async function fixture(page, { onlineCover = false, credit = attribution, imageStatus = 200 } = {}) {
  await page.addInitScript(({ artist, album, onlineCover }) => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { language: 'en', demos: false, onlineCover, artistAlbumCoverFallback: false }, tracks: [{
      id: 'baidu:portrait-fixture', provider: 'baidu', title: '测试歌曲', artist, album,
      albumIsFallback: false, src: '/api/baidu/stream?id=310', cover: '/assets/cover-1.jpg',
    }, {
      id: 'baidu:other-cover', provider: 'baidu', title: '独立歌曲', artist: '无专辑艺人', album: '单曲',
      albumIsFallback: true, src: '/api/baidu/stream?id=311', cover: '/assets/cover-2.jpg',
    }] }));
  }, { artist, album, onlineCover });
  const image = await readFile(new URL('../public/assets/cover-2.jpg', import.meta.url));
  const queries = [];
  await page.route('**/api/artwork/artist?*', route => {
    queries.push(Object.fromEntries(new URL(route.request().url()).searchParams));
    return route.fulfill({ json: { cover: portraitUrl, attribution: credit } });
  });
  await page.route('**' + portraitUrl, route => route.fulfill({
    status: imageStatus, body: imageStatus === 200 ? image : '', contentType: 'image/jpeg',
  }));
  return queries;
}

test('shows a verified artist portrait and visible attribution while keeping the album cover', async ({ page }) => {
  const queries = await fixture(page);
  await page.goto('/#artists');
  const artistCard = page.locator('.card-grid button').filter({ hasText: artist });
  await expect(artistCard.locator('img')).toHaveCount(0);
  await artistCard.press('Enter');
  await expect(page.getByRole('heading', { name: artist })).toBeVisible();
  expect(queries).toEqual([]);
  await page.getByRole('button', { name: 'Find Artist Photo' }).press('Enter');
  const portrait = page.locator('.artist-portrait');
  await expect(portrait.locator('img')).toHaveAttribute('src', portraitUrl);
  await expect.poll(() => portrait.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await expect(portrait.getByRole('link', { name: attribution.name })).toHaveAttribute('href', attribution.url);
  await expect(portrait.getByRole('link', { name: attribution.license })).toHaveAttribute('href', attribution.licenseUrl);
  await expect(portrait).toContainText(attribution.author);
  await expect(page.locator('.track-table img')).toHaveAttribute('src', '/assets/cover-1.jpg');
  expect(queries).toEqual([{ artist, album }]);

  await page.reload();
  await expect(portrait.locator('img')).toHaveAttribute('src', portraitUrl);
  await page.locator('#sidebar [data-nav=artists]').press('Enter');
  await expect(artistCard.locator('img')).toHaveAttribute('src', portraitUrl);
  await expect(page.locator('.artist-artwork-card').getByRole('link', { name: attribution.license })).toBeVisible();
  expect(queries).toHaveLength(1);
});

test('uses opted-in artist matching and ignores attribution from an untrusted origin', async ({ page }) => {
  const queries = await fixture(page, { onlineCover: true, credit: { ...attribution, url: 'https://example.invalid/wiki/File:portrait.jpg' } });
  await page.goto('/#' + encodeURIComponent('artist/' + artist));
  await expect(page.getByRole('heading', { name: artist })).toBeVisible();
  await expect.poll(() => queries.length).toBe(1);
  await expect(page.locator('.artist-portrait')).toHaveCount(0);
  expect(queries).toEqual([{ artist, album }]);
});

test('opts into scoped album cover fallback, preserves manual portrait priority and restores the setting from backup', async ({ page }) => {
  const queries = await fixture(page);
  const navigate = name => page.locator('#sidebar [data-nav="' + name + '"]').press('Enter');
  const artistCard = page.locator('.card-grid button').filter({ hasText: artist });
  const otherCard = page.locator('.card-grid button').filter({ hasText: '无专辑艺人' });
  const portrait = page.locator('.artist-portrait');
  const setting = page.getByRole('checkbox', { name: 'Use an album cover when the artist photo is missing' });
  const metadataSetting = page.getByRole('checkbox', { name: 'Use track artist when the album artist tag is missing' });
  const findPortrait = page.getByRole('button', { name: 'Find Artist Photo' });

  await page.goto('/#settings');
  await expect(setting).not.toBeChecked();
  await setting.check();
  await expect(metadataSetting).not.toBeChecked();
  await navigate('artists');
  await expect(artistCard.locator('img')).toHaveAttribute('src', '/assets/cover-1.jpg');
  await expect(otherCard.locator('img')).toHaveCount(0);
  await artistCard.press('Enter');
  await expect(portrait.locator('img')).toHaveAttribute('src', '/assets/cover-1.jpg');
  await expect(portrait.locator('figcaption')).toHaveCount(0);
  await expect(findPortrait).toBeVisible();
  await page.reload();
  await expect(portrait.locator('img')).toHaveAttribute('src', '/assets/cover-1.jpg');
  expect(queries).toHaveLength(0);

  await navigate('settings');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).press('Enter');
  const file = await (await download).path();
  expect(JSON.parse(await readFile(file, 'utf8')).settings.artistAlbumCoverFallback).toBe(true);
  await setting.uncheck();
  await navigate('artists');
  await expect(artistCard.locator('img')).toHaveCount(0);
  await navigate('settings');
  await page.locator('#restore-file').setInputFiles(file);
  await expect(setting).toBeChecked();
  await expect(metadataSetting).not.toBeChecked();
  await navigate('artists');
  await expect(artistCard.locator('img')).toHaveAttribute('src', '/assets/cover-1.jpg');
  await artistCard.press('Enter');
  await findPortrait.press('Enter');
  await expect(portrait.locator('img')).toHaveAttribute('src', portraitUrl);
  await expect(portrait.getByRole('link', { name: attribution.license })).toBeVisible();
  await navigate('artists');
  await expect(artistCard.locator('img')).toHaveAttribute('src', portraitUrl);
  expect(queries).toEqual([{ artist, album }]);
});

test('returns to the album cover if a matched portrait image cannot load', async ({ page }) => {
  await fixture(page, { imageStatus: 404 });
  await page.goto('/#settings');
  await page.getByRole('checkbox', { name: 'Use an album cover when the artist photo is missing' }).check();
  await page.locator('#sidebar [data-nav="artists"]').press('Enter');
  await page.locator('.card-grid button').filter({ hasText: artist }).press('Enter');
  const find = page.getByRole('button', { name: 'Find Artist Photo' });
  await find.press('Enter');
  await expect(page.getByText('Artist photo added.', { exact: true })).toBeVisible();
  await expect(page.locator('.artist-portrait img')).toHaveAttribute('src', '/assets/cover-1.jpg');
  await expect(page.locator('.artist-portrait figcaption')).toHaveCount(0);
  await expect(find).toBeVisible();
});
