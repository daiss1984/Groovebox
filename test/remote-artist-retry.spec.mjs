import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const artist = 'Fixture Retry Artist';
const source = index => ({ id: '829d6186-a651-47dd-9096-' + String(index).padStart(12, '0'),
  name: 'Fixture ' + index, type: index % 2 ? 'webdav' : 'smb' });
const cover = record => '/api/sources/' + record.id + '/cover?id=' + String(record.id.slice(-12)).repeat(2);
const nav = (page, route) => page.locator('#sidebar [data-nav="' + route + '"]').press('Enter');
const portrait = page => page.locator('#content .artist-portrait img');

async function stage(page, records, { distinct = false } = {}) {
  const image = await readFile(new URL('../public/assets/cover-2.jpg', import.meta.url));
  await page.addInitScript(({ records, artist, distinct }) => {
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { demos: false, language: 'en', onlineCover: true },
      tracks: records.map((record, index) => ({ id: record.id + ':recording', provider: record.type,
        src: '/api/sources/' + record.id + '/stream?id=recording', title: 'Fixture Track ' + index,
        artist: distinct ? artist + ' ' + index : artist, album: 'Fixture Album', albumIsFallback: false })) }));
  }, { records, artist, distinct });
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: records } }));
  let onlineQueries = 0;
  await page.route('**/api/artwork/artist?**', route => {
    onlineQueries++;
    return route.fulfill({ status: 404 });
  });
  for (const record of records) await page.route('**' + cover(record), route => route.fulfill({ body: image, contentType: 'image/jpeg' }));
  return () => onlineQueries;
}

test('retries a failed folder portrait after a delay and immediately when connectivity returns', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    let failures = 0;
    window.fetch = async (input, options) => {
      const response = await fetch(input, options);
      const path = new URL(input instanceof Request ? input.url : input, location.href).pathname;
      if (!response.ok && path.endsWith('/artist-portraits')) {
        const json = response.json.bind(response);
        // Wait for the app to consume the failed response before advancing its backoff clock.
        response.json = async () => {
          const value = await json();
          document.documentElement.dataset.fixturePortraitFailures = String(++failures);
          return value;
        };
      }
      return response;
    };
  });
  const record = source(1);
  const queries = await stage(page, [record]);
  let reads = 0;
  await page.route('**/api/sources/' + record.id + '/artist-portraits', route => {
    reads++;
    return reads < 3 ? route.fulfill({ status: 503, json: { error: 'Fixture temporarily busy' } }) :
      route.fulfill({ json: { portraits: [{ artist, cover: cover(record) }] } });
  });
  await page.goto('/#' + encodeURIComponent('artist/' + artist));
  await expect(page.getByRole('heading', { name: artist, exact: true })).toBeVisible();
  await expect.poll(() => reads).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-fixture-portrait-failures', '1');
  await nav(page, 'artists');
  await page.locator('#content button.card[data-action="group"]').press('Enter');
  await page.clock.fastForward(29000);
  expect(reads).toBe(1);
  await page.clock.fastForward(1000);
  await expect.poll(() => reads).toBe(2);
  await expect(page.locator('html')).toHaveAttribute('data-fixture-portrait-failures', '2');
  expect(queries()).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => reads).toBe(3);
  await expect(portrait(page)).toHaveAttribute('src', cover(record));
  await expect.poll(() => portrait(page).evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  expect(queries()).toBe(0);
});

test('limits simultaneous folder portrait queries across WebDAV and SMB sources', async ({ page }) => {
  const records = Array.from({ length: 7 }, (_, index) => source(index + 1));
  await stage(page, records, { distinct: true });
  const pending = [];
  let reads = 0;
  let active = 0;
  let maximum = 0;
  await page.route('**/api/sources/*/artist-portraits', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    const index = records.findIndex(record => record.id === id);
    reads++;
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => pending.push(async () => {
      active--;
      await route.fulfill({ json: { portraits: [{ artist: artist + ' ' + index, cover: cover(records[index]) }] } });
      resolve();
    }));
  });
  await page.goto('/#artists');
  await expect(page.locator('#content button.card')).toHaveCount(records.length);
  await expect.poll(() => pending.length).toBe(3);
  expect(reads).toBe(3);
  for (let index = 0; index < records.length; index++) {
    await expect.poll(() => pending.length).toBeGreaterThan(0);
    await pending.shift()();
  }
  await expect(page.locator('#content button.card img')).toHaveCount(records.length);
  expect(reads).toBe(records.length);
  expect(maximum).toBe(3);
});

test('keeps a failed source unresolved until retry before choosing a same-name artist portrait', async ({ page }) => {
  const first = source(1), second = source(2);
  const queries = await stage(page, [first, second]);
  let fail = true;
  let failedReads = 0;
  await page.route('**/api/sources/' + first.id + '/artist-portraits', route => {
    failedReads++;
    return fail ? route.fulfill({ status: 503, json: { error: 'Fixture busy' } }) : route.fulfill({ json: { portraits: [] } });
  });
  await page.route('**/api/sources/' + second.id + '/artist-portraits', route =>
    route.fulfill({ json: { portraits: [{ artist, cover: cover(second) }] } }));
  await page.goto('/#' + encodeURIComponent('artist/' + artist));
  await expect(page.getByRole('heading', { name: artist, exact: true })).toBeVisible();
  await expect.poll(() => failedReads).toBe(1);
  await expect(portrait(page)).toHaveCount(0);
  expect(queries()).toBe(0);
  fail = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(portrait(page)).toHaveAttribute('src', cover(second));
  expect(failedReads).toBe(2);
  expect(queries()).toBe(0);
});
