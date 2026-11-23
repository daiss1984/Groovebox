import { expect, test } from '@playwright/test';

const artist = 'Fixture Remote Recovery';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=', 'base64');
const source = index => ({ id: '829d6186-a651-47dd-9096-' + String(index).padStart(12, '0'),
  name: 'Fixture ' + index, type: index % 2 ? 'smb' : 'webdav' });
const cover = record => '/api/sources/' + record.id + '/cover?id=' + record.id.slice(-12).repeat(2);
const artistRoute = '/#' + encodeURIComponent('artist/' + artist);
const portrait = page => page.locator('#content .artist-portrait img');
const signalOnline = page => page.evaluate(() => window.dispatchEvent(new Event('online')));

async function stage(page, records) {
  let onlineQueries = 0;
  await page.addInitScript(({ records, artist }) => {
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { demos: false, language: 'en', onlineCover: true },
      tracks: records.map((record, index) => ({ id: record.id + ':recording', provider: record.type,
        src: '/api/sources/' + record.id + '/stream?id=recording', title: 'Fixture Track ' + index,
        artist, album: 'Fixture Album', albumIsFallback: false })) }));
  }, { records, artist });
  await page.route('**/api/artwork/artist?**', route => {
    onlineQueries++;
    return route.fulfill({ status: 404 });
  });
  return () => onlineQueries;
}

async function expectImage(page, path) {
  await expect(portrait(page)).toHaveAttribute('src', path);
  await expect.poll(() => portrait(page).evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
}

test('rediscovers private portrait sources after an offline startup without sending an online lookup', async ({ page }) => {
  const record = source(1);
  const onlineQueries = await stage(page, [record]);
  let reachable = false;
  let discovers = 0;
  let privateReads = 0;
  await page.route('**/api/sources', route => {
    discovers++;
    return reachable ? route.fulfill({ json: { sources: [record] } }) : route.abort('internetdisconnected');
  });
  await page.route('**/api/sources/*/artist-portraits', route => {
    privateReads++;
    return route.fulfill({ json: { portraits: [{ artist, cover: cover(record) }] } });
  });
  await page.route('**' + cover(record), route => route.fulfill({ contentType: 'image/png', body: image }));
  const failedDiscovery = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/sources');
  await page.goto(artistRoute);
  await failedDiscovery;
  await expect(page.getByRole('heading', { name: artist, exact: true })).toBeVisible();
  expect({ discovers, privateReads, online: onlineQueries() }).toEqual({ discovers: 1, privateReads: 0, online: 0 });
  reachable = true;
  await signalOnline(page);
  await expectImage(page, cover(record));
  expect({ discovers, privateReads, online: onlineQueries() }).toEqual({ discovers: 2, privateReads: 1, online: 0 });
});

test('drops unstarted portrait requests when leaving the artist directory and resumes them on return', async ({ page }) => {
  const records = Array.from({ length: 5 }, (_, index) => source(index + 1));
  await stage(page, records);
  const requested = [];
  const pending = [];
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: records } }));
  await page.route('**/api/sources/*/artist-portraits', async route => {
    requested.push({ id: new URL(route.request().url()).pathname.split('/')[3], route: new URL(page.url()).hash });
    await new Promise(resolve => pending.push(async () => {
      try { await route.fulfill({ json: { portraits: [] } }); }
      finally { resolve(); }
    }));
  });
  const nav = route => page.locator('#sidebar [data-nav="' + route + '"]').click();
  try {
    await page.goto('/#artists');
    await expect.poll(() => pending.length).toBe(3);
    await nav('songs');
    await expect(page).toHaveURL(/#songs$/);
    const initial = pending.splice(0);
    await Promise.all(initial.map(release => release()));
    await nav('favorites');
    await expect(page).toHaveURL(/#favorites$/);
    expect(requested).toHaveLength(3);
    await nav('artists');
    await expect(page).toHaveURL(/#artists$/);
    await expect.poll(() => requested.length).toBe(records.length);
    expect(requested.map(row => row.id).sort()).toEqual(records.map(record => record.id).sort());
    expect(requested.every(row => row.route === '#artists')).toBe(true);
  } finally {
    await Promise.allSettled(pending.splice(0).map(release => release()));
  }
});

test('retries a failed authenticated portrait image on reconnect without reloading its index', async ({ page }) => {
  const record = source(1);
  await stage(page, [record]);
  let reachable = false;
  let indexReads = 0;
  let photoReads = 0;
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [record] } }));
  await page.route('**/api/sources/*/artist-portraits', route => {
    indexReads++;
    return route.fulfill({ json: { portraits: [{ artist, cover: cover(record) }] } });
  });
  await page.route('**' + cover(record), route => {
    photoReads++;
    return reachable ? route.fulfill({ contentType: 'image/png', body: image }) : route.fulfill({ status: 503 });
  });
  await page.goto(artistRoute);
  await expect.poll(() => photoReads).toBe(1);
  await expect(portrait(page)).toHaveCount(0);
  reachable = true;
  await signalOnline(page);
  await expectImage(page, cover(record));
  expect({ indexReads, photoReads }).toEqual({ indexReads: 1, photoReads: 2 });
});

test('retains a reconnect signal received while the failed index request is still in flight', async ({ page }) => {
  const record = source(1);
  const onlineQueries = await stage(page, [record]);
  let indexReads = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [record] } }));
  await page.route('**/api/sources/*/artist-portraits', async route => {
    if (++indexReads === 1) {
      await pending;
      return route.fulfill({ status: 503, json: { error: 'Fixture still finishing its failed offline request' } });
    }
    return route.fulfill({ json: { portraits: [{ artist, cover: cover(record) }] } });
  });
  await page.route('**' + cover(record), route => route.fulfill({ contentType: 'image/png', body: image }));
  try {
    await page.goto(artistRoute);
    await expect.poll(() => indexReads).toBe(1);
    await signalOnline(page);
    expect(indexReads).toBe(1);
  } finally { release(); }
  await expectImage(page, cover(record));
  expect({ indexReads, online: onlineQueries() }).toEqual({ indexReads: 2, online: 0 });
});

test('allows online matching once a reconnect retry confirms there is no private portrait', async ({ page }) => {
  const record = source(1);
  const onlineQueries = await stage(page, [record]);
  let indexReads = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [record] } }));
  await page.route('**/api/sources/*/artist-portraits', async route => {
    if (++indexReads === 1) {
      await pending;
      return route.fulfill({ status: 503, json: { error: 'Fixture still finishing its failed offline request' } });
    }
    return route.fulfill({ json: { portraits: [] } });
  });
  try {
    await page.goto(artistRoute);
    await expect.poll(() => indexReads).toBe(1);
    await signalOnline(page);
    expect({ indexReads, online: onlineQueries() }).toEqual({ indexReads: 1, online: 0 });
  } finally { release(); }
  await expect.poll(onlineQueries).toBe(1);
  expect(indexReads).toBe(2);
});
