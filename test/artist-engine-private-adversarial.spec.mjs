import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const profileKey = 'groovebox.state.v1';
const artist = 'Provider-private portrait fixture';
const album = 'Fixture album';
const source = { id: '876cd744-3524-43fb-9bae-61fbea15f04c', name: 'Private HTTPS WebDAV', type: 'webdav' };
const privateImage = '/api/sources/' + source.id + '/cover?id=b44bbc2f49044d6585df4bde';
const cachedImage = '/api/artwork/artist-cover?id=e15a50dc-a53d-476a-948f-a23f44bfba42';
const publicCredit = { name: 'Previously matched portrait', url: 'https://commons.wikimedia.org/wiki/File:Portrait.jpg',
  license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' };

test('uses an authenticated artist portrait ahead of cached online and album art when both automatic engines are disabled', async ({ page }) => {
  const image = await readFile(new URL('../public/assets/cover-2.jpg', import.meta.url));
  await page.addInitScript(({ profileKey, artist, album, source, cachedImage, publicCredit }) => {
    localStorage.setItem(profileKey, JSON.stringify({
      settings: { demos: false, language: 'en', onlineCover: false, artistImageEngine: false, artistAlbumCoverFallback: true },
      artistPortraits: [[JSON.stringify([artist.toLowerCase(), album.toLowerCase()]), { cover: cachedImage, attribution: publicCredit }]],
      tracks: [{ id: source.id + ':recording', provider: source.type, title: 'Private media', artist, album, albumIsFallback: false,
        cover: '/assets/cover-1.jpg', src: '/api/sources/' + source.id + '/stream?id=recording' }],
    }));
  }, { profileKey, artist, album, source, cachedImage, publicCredit });
  const release = Promise.withResolvers();
  let privateReads = 0;
  let publicLookups = 0;
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [source] } }));
  await page.route('**/api/sources/*/artist-portraits', async route => {
    privateReads++;
    await release.promise;
    await route.fulfill({ json: { portraits: [{ artist, cover: privateImage }] } });
  });
  await page.route('**' + privateImage, route => route.fulfill({ contentType: 'image/jpeg', body: image }));
  await page.route('**' + cachedImage, route => route.fulfill({ contentType: 'image/jpeg', body: image }));
  await page.route('**/api/artwork/{album,artist}?**', route => {
    publicLookups++;
    return route.fulfill({ status: 404 });
  });
  const portrait = page.locator('#content .artist-portrait img');
  try {
    await page.goto('/#' + encodeURIComponent('artist/' + artist));
    await expect(portrait).toHaveAttribute('src', cachedImage);
    await expect.poll(() => privateReads).toBe(1);
    release.resolve();
    await expect(portrait).toHaveAttribute('src', privateImage);
    await expect.poll(() => portrait.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('#content .artist-portrait figcaption')).toHaveCount(0);
    expect({ publicLookups, privateReads }).toEqual({ publicLookups: 0, privateReads: 1 });
    await page.locator('#sidebar [data-nav=settings]').press('Enter');
    await expect(page.locator('#online-cover')).not.toBeChecked();
    await expect(page.locator('#artist-image-engine')).not.toBeChecked();
    await expect(page.locator('#artist-album-cover-fallback')).toBeChecked();
  } finally { release.resolve(); }
});
