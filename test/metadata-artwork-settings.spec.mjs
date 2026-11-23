import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const status = (revision, album = true, artist = true) => ({ configured: true, artwork: { adapter: 'hisatri', revision, album, artist } });
const base = '/api/metadata/artwork/';
const artist = 'Controlled Cover Artist';
const album = 'Controlled Cover Album';
const oldCover = base + 'image?id=f9260e4b-9ad2-460a-a64d-a0000000000a';
const newCover = base + 'image?id=f9260e4b-9ad2-460a-a64d-a0000000000b';
const jpeg = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
const nav = (page, view) => page.locator('#sidebar [data-nav="' + view + '"]').press('Enter');
const group = (page, name) => page.locator('#content [data-action="group"]').filter({ hasText: name });
const art = (page, name) => group(page, name).locator('img');

async function stage(page, { recordedCover } = {}) {
  await page.addInitScript(({ artist, album, recordedCover }) => {
    if (!localStorage.getItem('groovebox.state.v1')) localStorage.setItem('groovebox.state.v1', JSON.stringify({
      settings: { demos: false, language: 'en', onlineCover: true, artistImageEngine: true },
      tracks: [{ id: 'baidu:901', provider: 'baidu', src: '/api/baidu/stream?id=901', title: 'Controlled Cover Song',
        artist, album, artistIsFallback: false, albumIsFallback: false }],
    }));
    if (recordedCover && !localStorage.getItem('groovebox.custom-artwork.v1')) {
      localStorage.setItem('groovebox.custom-artwork.v1', JSON.stringify([[JSON.stringify(['album', album.toLowerCase(), artist.toLowerCase()]),
        { scope: 'album', revision: 'revision-a', cover: recordedCover }]]));
    }
  }, { artist, album, recordedCover });
  const publicRequests = [];
  await page.route('**/api/artwork/{album,artist}?**', route => {
    publicRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404 });
  });
  return publicRequests;
}

test('waits for revision status and refreshes an expired image once without public fallback', async ({ page }) => {
  const publicRequests = await stage(page, { recordedCover: oldCover });
  const requestedStatus = Promise.withResolvers();
  const releaseStatus = Promise.withResolvers();
  let statusReads = 0;
  let oldImages = 0;
  let lookups = 0;
  await page.route('**' + base + 'status', async route => {
    statusReads++;
    requestedStatus.resolve();
    await releaseStatus.promise;
    await route.fulfill({ json: status('revision-a') }).catch(() => {});
  });
  await page.route('**' + oldCover, route => {
    oldImages++;
    return route.fulfill({ status: 404 });
  });
  await page.route('**' + newCover, route => route.fulfill({ body: jpeg, contentType: 'image/jpeg' }));
  await page.route('**' + base + 'cover', route => {
    lookups++;
    expect(route.request().headers()['x-metadata-revision']).toBe('revision-a');
    expect(route.request().postDataJSON()).toEqual({ scope: 'album', album, artist });
    return route.fulfill({ json: { scope: 'album', adapter: 'hisatri', revision: 'revision-a', cover: newCover } });
  });

  try {
    await page.goto('/#albums');
    await requestedStatus.promise;
    await expect(group(page, album)).toBeVisible();
    await expect(art(page, album)).toHaveCount(0);
    expect(lookups).toBe(0);
    expect(oldImages).toBe(0);
  } finally { releaseStatus.resolve(); }
  await expect(art(page, album)).toHaveAttribute('src', newCover);
  await expect.poll(() => art(page, album).evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  expect(lookups).toBe(1);
  expect(oldImages).toBeGreaterThanOrEqual(1);
  expect(statusReads).toBeGreaterThanOrEqual(2);
  expect(publicRequests).toEqual([]);

  await page.reload();
  await expect(art(page, album)).toHaveAttribute('src', newCover);
  expect(lookups).toBe(1);
});

test('retries the same opaque image once after a transient failure and keeps the album focused', async ({ page }) => {
  await stage(page, { recordedCover: oldCover });
  const requestedImage = Promise.withResolvers();
  const returnError = Promise.withResolvers();
  let imageReads = 0;
  let lookups = 0;
  await page.route('**' + base + 'status', route => route.fulfill({ json: status('revision-a') }));
  await page.route('**' + oldCover, async route => {
    if (++imageReads === 1) {
      requestedImage.resolve();
      await returnError.promise;
      await route.fulfill({ status: 502 });
    } else await route.fulfill({ contentType: 'image/jpeg', body: jpeg });
  });
  await page.route('**' + base + 'cover', route => {
    lookups++;
    return route.fulfill({ json: { scope: 'album', adapter: 'hisatri', revision: 'revision-a', cover: oldCover } });
  });
  try {
    await page.goto('/#albums', { waitUntil: 'domcontentloaded' });
    await requestedImage.promise;
    await group(page, album).focus();
  } finally { returnError.resolve(); }
  await expect.poll(() => art(page, album).evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  expect(lookups).toBe(1);
  expect(imageReads).toBeGreaterThanOrEqual(2);
  await expect(group(page, album)).toBeFocused();
});

test('custom misses stay on their selected API for automatic and manual lookups', async ({ page }) => {
  const publicRequests = await stage(page);
  const calls = [];
  await page.route('**' + base + 'status', route => route.fulfill({ json: status('revision-miss') }));
  await page.route('**' + base + 'cover', route => {
    calls.push(route.request().postDataJSON().scope);
    return route.fulfill({ status: 404, json: { code: 'metadata_not_found' } });
  });
  await page.goto('/#' + encodeURIComponent('artist/' + artist));
  const manualArtist = page.getByRole('button', { name: 'Find Artist Photo', exact: true });
  await expect.poll(() => calls).toEqual(['artist']);
  await manualArtist.press('Enter');
  await expect(page.locator('#toast')).toContainText('The custom cover API found no matching artwork.');
  expect(calls).toEqual(['artist', 'artist']);
  await expect(page.locator('.artist-portrait img')).toHaveCount(0);
  await nav(page, 'albums');
  await expect.poll(() => calls).toEqual(['artist', 'artist', 'album']);
  await group(page, album).press('Enter');
  await page.getByRole('button', { name: 'Find Cover Online', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('The custom cover API found no matching artwork.');
  expect(calls).toEqual(['artist', 'artist', 'album', 'album']);
  expect(publicRequests).toEqual([]);
});

test('a late status reply cannot overwrite the revision just saved in Settings', async ({ page }) => {
  const publicRequests = await stage(page);
  await page.addInitScript(({ base, previous }) => {
    const actualFetch = window.fetch.bind(window);
    let held = false;
    window.fetch = (input, options) => {
      const path = new URL(input instanceof Request ? input.url : input, location.origin).pathname;
      if (path === base + 'status' && !held) {
        held = true;
        return new Promise(resolve => {
          window.finishOldCoverStatus = () => resolve(Response.json(previous));
        });
      }
      return actualFetch(input, options);
    };
  }, { base, previous: status('revision-a', true, false) });
  await page.route('**' + base + 'status', route => route.fulfill({ json: status('revision-new', false, true) }));
  let saved;
  await page.route('**' + base + 'config', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { artwork: { adapter: 'none', url: '', hasHeaders: false } } });
    saved = route.request().postDataJSON();
    return route.fulfill({ json: status('revision-new', false, true) });
  });
  const lookedUp = [];
  await page.route('**' + base + 'cover', route => {
    const scope = route.request().postDataJSON().scope;
    lookedUp.push([scope, route.request().headers()['x-metadata-revision']]);
    return route.fulfill({ json: { scope, adapter: 'hisatri', revision: 'revision-new', cover: newCover } });
  });
  await page.route('**' + newCover, route => route.fulfill({ contentType: 'image/jpeg', body: jpeg }));
  await page.goto('/#settings');
  await page.waitForFunction(() => Boolean(window.finishOldCoverStatus));
  await page.getByRole('button', { name: 'Configure Cover API' }).press('Enter');
  const form = page.locator('form[data-form="metadata-artwork-api"]');
  await form.locator('[name=adapter]').selectOption('hisatri');
  await form.locator('[name=url]').fill('https://fixture.invalid/cover');
  await form.getByRole('checkbox', { name: 'Use custom album covers' }).uncheck();
  await form.getByRole('button', { name: 'Save API settings' }).press('Enter');
  await expect(page.locator('#toast')).toContainText('Cover API settings saved.');
  expect(saved?.artwork).toEqual({ adapter: 'hisatri', url: 'https://fixture.invalid/cover', album: false, artist: true, headersAction: 'keep' });
  await page.evaluate(() => window.finishOldCoverStatus());
  await nav(page, 'artists');
  await expect(art(page, artist)).toHaveAttribute('src', newCover);
  await expect(page.getByText('Configured cover source: HisAtri', { exact: true })).toBeVisible();
  await nav(page, 'albums');
  await expect(group(page, album)).toBeVisible();
  await expect(art(page, album)).toHaveCount(0);
  expect(lookedUp).toEqual([['artist', 'revision-new']]);
  expect(publicRequests).toEqual([]);
});

test('rechecks an earlier disabled setting before disclosing metadata to a public provider', async ({ page }) => {
  const publicRequests = await stage(page);
  let active = false;
  await page.route('**' + base + 'status', route => route.fulfill({ json: active ? status('enabled-elsewhere', false, true) :
    { configured: false, artwork: { adapter: 'none', revision: 'none', album: false, artist: false } } }));
  const firstStatus = page.waitForResponse(response => response.url().endsWith(base + 'status'));
  await page.goto('/#settings');
  expect(await (await firstStatus).json()).toMatchObject({ configured: false });
  await expect(page.getByRole('button', { name: 'Configure Cover API' })).toBeVisible();
  active = true;
  const custom = [];
  await page.route('**' + base + 'cover', route => {
    custom.push([route.request().postDataJSON(), route.request().headers()['x-metadata-revision']]);
    return route.fulfill({ json: { scope: 'artist', adapter: 'hisatri', revision: 'enabled-elsewhere', cover: newCover } });
  });
  await page.route('**' + newCover, route => route.fulfill({ contentType: 'image/jpeg', body: jpeg }));
  await nav(page, 'artists');
  await group(page, artist).press('Enter');
  await expect(page.locator('.artist-portrait img')).toHaveAttribute('src', newCover);
  expect(custom).toEqual([[{ scope: 'artist', artist }, 'enabled-elsewhere']]);
  expect(publicRequests).toEqual([]);
});
