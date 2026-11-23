import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

const project = fileURLToPath(new URL('../', import.meta.url));
const stateKey = 'groovebox.state.v1';
const metadata = '/api/metadata/artwork/';
const opaqueImage = /^\/api\/metadata\/artwork\/image\?id=[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const auth = 'Bearer Disposable-Cover-Key-A';
const extraHeader = 'X-Fixture-Cover-Auth';
const extraValue = 'image+value=local';
const credentials = 'Authorization=' + auth + '&' + extraHeader + '=' + extraValue;
const jpeg = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
const otherJpeg = await readFile(new URL('../public/assets/cover-2.jpg', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=', 'base64');

const nav = (page, name) => page.locator('#sidebar [data-nav="' + name + '"]').click();
const card = (page, name) => page.locator('#content [data-action=group]').filter({ hasText: name });
const coverOf = (page, name) => card(page, name).locator('img');
const configButton = page => page.getByRole('button', { name: 'Configure Cover API', exact: true });
const configForm = page => page.locator('[data-form="metadata-artwork-api"]');

function raster(response, body, contentType) {
  response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length });
  response.end(body);
}

async function startUpstream(handler) {
  const requests = [];
  const server = createServer((incoming, response) => {
    const url = new URL(incoming.url, 'http://127.0.0.1');
    const request = { method: incoming.method, path: url.pathname, params: Object.fromEntries(url.searchParams), headers: incoming.headers };
    requests.push(request);
    Promise.resolve().then(() => handler(request, response)).catch(() => response.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests, url: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

async function startApp(data, port = 0) {
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: project,
    env: { HOST: '127.0.0.1', PORT: String(port), GROOVEBOX_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  const close = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  };
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = /^Groovebox: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output);
        if (match) resolve(match[1]);
      });
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Fixture server exited (' + code + ')\n' + errors)));
    });
    return { url, port: Number(new URL(url).port), close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function cleanup(app, upstream, directory) {
  await app?.close();
  await upstream?.close();
  await rm(directory, { recursive: true, force: true });
}

const simulatedCloudTrack = (id, title, artist, album, extra) => ({
  id: 'baidu:' + id, title, artist, album, albumIsFallback: false, provider: 'baidu',
  src: '/api/baidu/stream?id=' + id, ...extra,
});

async function profile(page, tracks, overrides = {}, { observePublic = true } = {}) {
  await page.addInitScript(({ key, tracks, overrides }) => {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({ tracks, settings: {
      language: 'en', demos: false, onlineCover: false, artistImageEngine: false, artistAlbumCoverFallback: false,
      ...overrides,
    } }));
  }, { key: stateKey, tracks, overrides });
  const publicLookups = [];
  if (observePublic) {
    await page.route('**/api/artwork/{album,artist}?**', intercepted => {
      publicLookups.push(intercepted.request().url());
      return intercepted.fulfill({ status: 404 });
    });
  }
  return publicLookups;
}

async function saveConfig(page, { url, album, artist, headersAction = 'keep', headers }) {
  await nav(page, 'settings');
  await configButton(page).click();
  const form = configForm(page);
  await form.locator('[name=adapter]').selectOption('hisatri');
  await form.locator('[name=url]').fill(url);
  await form.locator('[name=album]').setChecked(album);
  await form.locator('[name=artist]').setChecked(artist);
  await form.locator('[name=headersAction]').selectOption(headersAction);
  if (headers !== undefined) await form.locator('[name=headers]').fill(headers);
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === metadata + 'config' &&
    response.request().method() === 'PUT');
  await form.getByRole('button', { name: 'Save API settings', exact: true }).click();
  const outcome = await saved;
  expect(outcome.status()).toBe(200);
  const dto = await outcome.json();
  await expect(form).not.toBeVisible();
  return dto;
}

async function coverImage(image, app, bytes, mimeType) {
  await expect(image).toHaveAttribute('src', opaqueImage);
  await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
  const src = await image.getAttribute('src');
  const response = await fetch(app.url + src);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(mimeType);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  return src;
}

test('decodes custom album and artist grids independently, preserves server-only headers, and replaces stale image IDs', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-artwork-api-'));
  const artist = '海岛 & Fixture Ensemble';
  const album = '黄昏 + Fixture Album';
  const albumOnly = 'Album With No Named Artist';
  let app, upstream;
  try {
    upstream = await startUpstream((request, response) => {
      if (request.params.album) raster(response, jpeg, 'image/jpeg');
      else raster(response, png, 'image/png');
    });
    app = await startApp(directory);
    const port = app.port;
    const publicLookups = await profile(page, [
      simulatedCloudTrack('741', 'Primary Recording', artist, album),
      simulatedCloudTrack('742', 'Album-only Metadata', '未知艺人', albumOnly, { artistIsFallback: true }),
    ]);
    await page.context().addCookies([{ name: 'fixture_source_cookie', value: 'private-fixture-cookie', url: app.url }]);
    await page.goto(app.url + '/#settings');
    const endpoint = upstream.url + '/exact/cover';
    const albumsOnly = await saveConfig(page, {
      url: endpoint, album: true, artist: false, headersAction: 'replace', headers: credentials,
    });
    expect(albumsOnly).toMatchObject({ configured: true, artwork: { adapter: 'hisatri', album: true, artist: false } });
    await expect(page.locator('#online-cover')).not.toBeChecked();
    await expect(page.locator('#artist-image-engine')).not.toBeChecked();
    expect(upstream.requests).toHaveLength(0);

    await nav(page, 'artists');
    await expect(card(page, artist)).toBeVisible();
    await expect(coverOf(page, artist)).toHaveCount(0);
    expect(upstream.requests).toHaveLength(0);
    await nav(page, 'albums');
    const oldAlbumId = await coverImage(coverOf(page, album), app, jpeg, 'image/jpeg');
    await coverImage(coverOf(page, albumOnly), app, jpeg, 'image/jpeg');
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests.map(request => request.params)).toEqual(expect.arrayContaining([
      { album, artist, sourceType: 'api' }, { album: albumOnly, sourceType: 'api' },
    ]));
    for (const request of upstream.requests) {
      expect(request).toMatchObject({ method: 'GET', path: '/exact/cover',
        headers: { accept: '*/*', authorization: auth, [extraHeader.toLowerCase()]: extraValue } });
      expect(request.headers.cookie).toBeUndefined();
    }

    const cached = await fetch(app.url + metadata + 'cover', { method: 'POST', headers: {
      Origin: app.url, 'Content-Type': 'application/json', 'X-Metadata-Revision': albumsOnly.artwork.revision,
    }, body: JSON.stringify({ scope: 'album', artist, album }) });
    expect(cached.status).toBe(200);
    expect((await cached.json()).cover).toBe(oldAlbumId);
    expect(upstream.requests).toHaveLength(2);

    const artistsOnly = await saveConfig(page, { url: endpoint, album: false, artist: true });
    expect(artistsOnly).toMatchObject({ configured: true, artwork: { adapter: 'hisatri', album: false, artist: true } });
    expect(artistsOnly.artwork.revision).not.toBe(albumsOnly.artwork.revision);
    const stale = await fetch(app.url + oldAlbumId);
    expect(stale.status).toBe(404);
    expect(upstream.requests).toHaveLength(2);
    await nav(page, 'albums');
    await expect(card(page, album)).toBeVisible();
    await expect(coverOf(page, album)).toHaveCount(0);
    await nav(page, 'artists');
    const oldArtistId = await coverImage(coverOf(page, artist), app, png, 'image/png');
    const credit = page.locator('.artist-artwork-card .artwork-credit');
    await expect(credit).toHaveText('Configured cover source: HisAtri');
    await expect(credit.getByRole('link')).toHaveCount(0);
    expect(upstream.requests).toHaveLength(3);
    expect(upstream.requests[2]).toMatchObject({ params: { artist, sourceType: 'api' }, headers: { authorization: auth } });
    expect(publicLookups).toEqual([]);

    await nav(page, 'settings');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export backup', exact: true }).click();
    const backup = await readFile(await (await download).path(), 'utf8');
    const storage = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
    const status = await fetch(app.url + metadata + 'status').then(response => response.json());
    const config = await fetch(app.url + metadata + 'config').then(response => response.json());
    expect(status).toEqual(artistsOnly);
    expect(config).toEqual({ artwork: { adapter: 'hisatri', url: endpoint, album: false, artist: true, hasHeaders: true } });
    for (const surface of [storage, backup, JSON.stringify(config), JSON.stringify(status)]) {
      for (const value of [auth, extraHeader, extraValue, 'private-fixture-cookie']) expect(surface).not.toContain(value);
    }
    for (const surface of [storage, backup, JSON.stringify(status)]) expect(surface).not.toContain(endpoint);
    const encryptedFile = join(directory, 'metadata-artwork-settings.bin');
    expect((await readFile(encryptedFile)).includes(Buffer.from(auth))).toBe(false);
    if (process.platform !== 'win32') expect((await stat(encryptedFile)).mode & 0o077).toBe(0);

    await app.close();
    app = await startApp(directory, port);
    expect(await fetch(app.url + metadata + 'status').then(response => response.json())).toEqual(artistsOnly);
    expect((await fetch(app.url + oldArtistId)).status).toBe(404);
    expect(upstream.requests).toHaveLength(3);
    await page.reload();
    await configButton(page).click();
    await expect(configForm(page).locator('[name=url]')).toHaveValue(endpoint);
    await expect(configForm(page).locator('[name=headers]')).toHaveValue('');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await nav(page, 'artists');
    const newArtistId = await coverImage(coverOf(page, artist), app, png, 'image/png');
    expect(newArtistId).not.toBe(oldArtistId);
    expect(upstream.requests).toHaveLength(4);
    expect(upstream.requests[3].headers.authorization).toBe(auth);
  } finally { await cleanup(app, upstream, directory); }
});

test('keeps local embedded and folder covers and waits for a connected private portrait before any custom lookup', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-artwork-priority-'));
  const privateSource = { id: '6ae5654f-cbc7-4e36-a084-f34d5d15361b', name: 'Scoped private share', type: 'webdav' };
  const privateId = '/api/sources/' + privateSource.id + '/cover?id=82143224fc60425a80af6d2d';
  const privateArtist = 'Private Portrait Fixture';
  const privateAlbum = 'Private Existing Album';
  const embeddedAlbum = 'Actual Embedded Album';
  const folderAlbum = 'Actual Folder Sidecar Album';
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  let app, upstream;
  try {
    upstream = await startUpstream((_, response) => raster(response, png, 'image/png'));
    app = await startApp(directory);
    const publicLookups = await profile(page, [{
      id: privateSource.id + ':song', title: 'Private Song', artist: privateArtist, album: privateAlbum, albumIsFallback: false,
      src: '/api/sources/' + privateSource.id + '/stream?id=song', provider: 'webdav', cover: '/assets/cover-1.jpg',
    }]);
    await page.route('**/api/sources', intercepted => intercepted.fulfill({ json: { sources: [privateSource] } }));
    await page.route('**/api/sources/' + privateSource.id + '/artist-portraits', async intercepted => {
      waiting.resolve();
      await release.promise;
      await intercepted.fulfill({ json: { portraits: [{ artist: privateArtist, cover: privateId }] } });
    });
    await page.route('**' + privateId, intercepted => intercepted.fulfill({ contentType: 'image/jpeg', body: jpeg }));
    const sample = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    const inner = join(directory, 'Local Library', 'Folder Release');
    await mkdir(inner, { recursive: true });
    await Promise.all([
      writeFile(join(inner, 'Folder Recording.m4a'), Buffer.from(await updateBuffer(sample, {
        title: 'Folder Recording', artist: 'Local Folder Artist', album: folderAlbum,
      }))),
      writeFile(join(inner, 'cover.jpg'), otherJpeg),
    ]);

    await page.goto(app.url + '/#settings');
    await saveConfig(page, { url: upstream.url + '/priority', album: true, artist: true });
    await nav(page, 'offline');
    await page.locator('#import-files').setInputFiles({
      name: 'Embedded Recording.m4a', mimeType: 'audio/mp4',
      buffer: Buffer.from(await updateBuffer(sample, { title: 'Embedded Recording', artist: 'Local Embedded Artist', album: embeddedAlbum,
        picture: [{ type: 'Cover (front)', format: 'image/jpeg', data: jpeg }] })),
    });
    await expect(page.locator('#content .track-name').filter({ hasText: 'Embedded Recording' })).toBeVisible();
    await page.locator('#import-folder').setInputFiles(join(directory, 'Local Library'));
    await expect(page.locator('#content .track-name').filter({ hasText: 'Folder Recording' })).toBeVisible();
    await nav(page, 'albums');
    for (const name of [embeddedAlbum, folderAlbum]) {
      await expect(coverOf(page, name)).toHaveAttribute('src', /^blob:/);
      await expect.poll(() => coverOf(page, name).evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    }
    expect(await coverOf(page, embeddedAlbum).evaluate(async image => [...new Uint8Array(await (await fetch(image.src)).arrayBuffer())])).toEqual([...jpeg]);
    expect(await coverOf(page, folderAlbum).evaluate(async image => [...new Uint8Array(await (await fetch(image.src)).arrayBuffer())])).toEqual([...otherJpeg]);
    expect(upstream.requests.filter(request => request.params.album)).toEqual([]);

    await nav(page, 'artists');
    await waiting.promise;
    await expect(card(page, privateArtist)).toBeVisible();
    expect(upstream.requests.some(request => request.params.artist === privateArtist)).toBe(false);
    release.resolve();
    await expect(coverOf(page, privateArtist)).toHaveAttribute('src', privateId);
    await expect.poll(() => coverOf(page, privateArtist).evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    expect(upstream.requests.some(request => request.params.artist === privateArtist)).toBe(false);
    expect(publicLookups).toEqual([]);
  } finally {
    release.resolve();
    await cleanup(app, upstream, directory);
  }
});

for (const fault of [404, 502]) test('does not query public artwork after the configured source replies with ' + fault, async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-artwork-unavailable-'));
  const artist = 'Custom Failure Artist';
  const album = 'Custom Failure Album';
  let app, upstream;
  try {
    upstream = await startUpstream((_, response) => fault === 404 ? response.writeHead(404).end() :
      raster(response, Buffer.from('<svg>unsafe input</svg>'), 'image/jpeg'));
    app = await startApp(directory);
    const publicLookups = await profile(page, [simulatedCloudTrack('820', 'Failure Track', artist, album)], {
      onlineCover: true, artistImageEngine: true,
    });
    await page.goto(app.url + '/#settings');
    await saveConfig(page, { url: upstream.url + '/bad', album: true, artist: true });
    const failure = () => page.waitForResponse(response => new URL(response.url()).pathname === metadata + 'cover' && response.status() === fault);
    const code = fault === 404 ? 'metadata_not_found' : 'metadata_unavailable';
    const missingAlbum = failure();
    await nav(page, 'albums');
    await card(page, album).click();
    expect(await (await missingAlbum).json()).toMatchObject({ code });
    await expect(page.locator('#content .album-detail-cover img')).toHaveCount(0);

    const missingPortrait = failure();
    await nav(page, 'artists');
    await card(page, artist).click();
    expect(await (await missingPortrait).json()).toMatchObject({ code });
    await expect(page.locator('#content .artist-portrait img')).toHaveCount(0);
    expect(upstream.requests.map(request => request.params)).toEqual([
      { album, artist, sourceType: 'api' }, { artist, sourceType: 'api' },
    ]);
    expect(publicLookups).toEqual([]);
    await saveConfig(page, { url: upstream.url + '/bad', album: false, artist: true });
    await nav(page, 'albums');
    await card(page, album).click();
    await expect.poll(() => publicLookups.map(url => new URL(url).pathname)).toEqual(['/api/artwork/album']);
    expect(upstream.requests).toHaveLength(2);
  } finally { await cleanup(app, upstream, directory); }
});

test('drops a completed old album lookup delivered after the custom scope changes', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-artwork-old-revision-'));
  const artist = 'Revision Change Artist';
  const album = 'Revision Change Album';
  const prepared = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  let app, upstream;
  try {
    upstream = await startUpstream((request, response) => request.path === '/old'
      ? raster(response, jpeg, 'image/jpeg') : raster(response, png, 'image/png'));
    app = await startApp(directory);
    const publicLookups = await profile(page, [simulatedCloudTrack('831', 'Revision Track', artist, album)]);
    await page.goto(app.url + '/#settings');
    const old = await saveConfig(page, { url: upstream.url + '/old', album: true, artist: false });
    let hold = true;
    await page.route('**' + metadata + 'cover', async intercepted => {
      const response = await intercepted.fetch();
      if (!hold) return intercepted.fulfill({ response });
      hold = false;
      try {
        prepared.resolve({ status: response.status(), body: await response.json() });
        await release.promise;
        await intercepted.fulfill({ response }).catch(() => {});
      } finally { delivered.resolve(); }
    });
    await nav(page, 'albums');
    const previous = await prepared.promise;
    expect(previous).toMatchObject({ status: 200, body: { cover: expect.stringMatching(opaqueImage), revision: old.artwork.revision, scope: 'album' } });
    await saveConfig(page, { url: upstream.url + '/new', album: false, artist: true });
    release.resolve();
    await delivered.promise;
    expect((await fetch(app.url + previous.body.cover)).status).toBe(404);
    expect(upstream.requests.map(request => request.path)).toEqual(['/old']);
    await nav(page, 'albums');
    await expect(card(page, album)).toBeVisible();
    await expect(coverOf(page, album)).toHaveCount(0);

    await nav(page, 'artists');
    const fresh = await coverImage(coverOf(page, artist), app, png, 'image/png');
    expect(fresh).not.toEqual(previous.body.cover);
    expect(upstream.requests.map(request => request.path)).toEqual(['/old', '/new']);
    expect(upstream.requests[1].params).toEqual({ artist, sourceType: 'api' });
    expect(publicLookups).toEqual([]);
  } finally {
    release.resolve();
    await cleanup(app, upstream, directory);
  }
});

test.describe('offline custom artwork', () => {
  test.use({ serviceWorkers: 'allow' });

  test('retains exact downloaded audio and custom cover bytes after app and media servers stop', async ({ page, context }) => {
    const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-artwork-offline-'));
    const title = 'Offline Custom Recording';
    const siblingTitle = 'Offline Sibling Recording';
    const artist = 'Offline Fixture Ensemble';
    const album = 'Offline Download Album';
    const sourceName = 'Download WebDAV fixture';
    const audioPath = '/media/recording.m4a';
    const siblingPath = '/media/sibling.m4a';
    const sourceCredential = 'Basic ' + Buffer.from('fixture-reader:different-media-secret').toString('base64');
    const sample = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    const original = Buffer.from(await updateBuffer(sample, { title, artist, album }));
    const sibling = Buffer.from(await updateBuffer(sample, { title: siblingTitle, artist, album }));
    let albumImage = jpeg;
    let app, upstream;
    try {
      upstream = await startUpstream((request, response) => {
        if (request.path === '/artwork') return raster(response, albumImage, 'image/jpeg');
        if (request.headers.authorization !== sourceCredential) return response.writeHead(401).end();
        if (request.method === 'PROPFIND' && request.path === '/media/') {
          response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
          const entry = (path, display, size) => '<d:response><d:href>' + path + '</d:href>' +
            '<d:propstat><d:prop><d:displayname>' + display + '</d:displayname><d:resourcetype/>' +
            '<d:getcontenttype>audio/mp4</d:getcontenttype><d:getcontentlength>' + size + '</d:getcontentlength>' +
            '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
          return response.end('<d:multistatus xmlns:d="DAV:">' + entry(audioPath, 'First Recording.m4a', original.length) +
            entry(siblingPath, 'Sibling Recording.m4a', sibling.length) + '</d:multistatus>');
        }
        const bytes = request.path === audioPath ? original : request.path === siblingPath ? sibling : undefined;
        if (!bytes) return response.writeHead(404).end();
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(bytes.length - 1, Number(range[2])) : bytes.length - 1;
        response.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/mp4', 'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes', ETag: '"offline-fixture"', ...(range && { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }),
        });
        response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
      });
      app = await startApp(directory);
      const port = app.port;
      // Firefox needs an unintercepted navigation to reload through the real offline service worker.
      await profile(page, [], {}, { observePublic: false });
      await page.goto(app.url + '/#settings');
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      const config = await saveConfig(page, {
        url: upstream.url + '/artwork', album: true, artist: false, headersAction: 'replace', headers: credentials,
      });

      const source = await page.request.post(app.url + '/api/sources', { headers: { Origin: app.url },
        data: { type: 'webdav', name: sourceName, url: upstream.url + '/media/', username: 'fixture-reader', password: 'different-media-secret' } });
      expect(source.status()).toBe(201);
      await page.reload();
      await nav(page, 'sources');
      await page.locator('[data-action=open-cloud]').filter({ hasText: sourceName }).click();
      await page.getByRole('button', { name: 'Scan and Add to Library', exact: true }).click();
      await page.getByRole('button', { name: 'Rescan Folder', exact: true }).waitFor();
      await nav(page, 'songs');
      const dialog = page.getByRole('dialog');
      const rowFor = name => page.locator('#content tbody tr').filter({ has: page.locator('.track-name').filter({ hasText: name }) });
      const readTags = async (filename, taggedTitle) => {
        await rowFor(filename).locator('[data-action=track-menu]').click();
        await dialog.getByRole('button', { name: 'Read Audio Tags', exact: true }).click();
        await expect(rowFor(taggedTitle)).toBeVisible();
      };
      await readTags('First Recording', title);
      await readTags('Sibling Recording', siblingTitle);
      const row = rowFor(title);
      await nav(page, 'albums');
      const custom = await coverImage(coverOf(page, album), app, jpeg, 'image/jpeg');
      await nav(page, 'songs');
      await row.locator('[data-action=track-menu]').click();
      await dialog.getByRole('button', { name: 'Save for Offline Playback', exact: true }).click();
      await expect(page.locator('#toast')).toContainText('Audio saved to Downloaded Music');
      const trackId = await row.getAttribute('data-track');
      expect(trackId).toBeTruthy();
      const browserBytes = await page.evaluate(id => new Promise((resolve, reject) => {
        const open = indexedDB.open('groovebox.offline');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(['audio', 'folder-covers'], 'readonly');
          const audio = tx.objectStore('audio').get(id);
          const cover = tx.objectStore('folder-covers').get(id);
          tx.onerror = () => reject(tx.error);
          tx.oncomplete = async () => {
            open.result.close();
            try {
              const hash = async item => {
                const data = item.blob ? await item.blob.arrayBuffer() : item.binary.buffer;
                return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
                  .map(value => value.toString(16).padStart(2, '0')).join('');
              };
              resolve({ source: cover.result.source, cover: await hash(cover.result), audio: await hash(audio.result) });
            } catch (error) { reject(error); }
          };
        };
      }), trackId);
      const expectedAudio = createHash('sha256').update(original).digest('hex');
      const expectedCover = createHash('sha256').update(jpeg).digest('hex');
      const identity = 'custom-artwork:' + config.artwork.revision + ':' + JSON.stringify(['album', album.toLowerCase(), artist.toLowerCase()]);
      expect(browserBytes).toEqual({ source: identity, audio: expectedAudio, cover: expectedCover });
      const coverRequests = upstream.requests.filter(request => request.path === '/artwork');
      expect(coverRequests).toHaveLength(1);
      expect(coverRequests[0]).toMatchObject({ params: { album, artist, sourceType: 'api' }, headers: { authorization: auth } });

      // Keep the audio download, while leaving the sibling as the album grid's visible track.
      await row.locator('[data-action=track-menu]').click();
      await dialog.getByRole('button', { name: 'Remove from Library', exact: true }).click();
      await expect(dialog.locator('#remove-library-copy')).not.toBeChecked();
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(row).toHaveCount(0);
      await nav(page, 'albums');
      await app.close();
      albumImage = otherJpeg;
      app = await startApp(directory, port);
      expect(await fetch(app.url + metadata + 'status').then(response => response.json())).toEqual(config);
      expect((await fetch(app.url + custom)).status).toBe(404);
      await page.reload();
      const renewed = await coverImage(coverOf(page, album), app, otherJpeg, 'image/jpeg');
      expect(renewed).not.toBe(custom);
      expect(upstream.requests.filter(request => request.path === '/artwork')).toHaveLength(2);

      await nav(page, 'offline');
      await expect(row.locator('.track-main img')).toHaveAttribute('src', /^blob:/);
      await page.waitForURL(/#offline$/);
      await page.waitForFunction(async () => navigator.serviceWorker.controller?.state === 'activated' &&
        Boolean(await caches.match('/')) && Boolean(await caches.match('/app.js')));
      await context.setOffline(true);
      await app.close();
      await upstream.close();
      await page.reload();
      const offlineRow = page.locator('#content tbody tr').filter({ hasText: title });
      await expect(offlineRow).toBeVisible();
      await offlineRow.locator('.track-main').click();
      const audio = page.locator('#audio');
      const playerCover = page.locator('#player-art img');
      await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
      await expect(playerCover).toHaveAttribute('src', /^blob:/);
      await expect.poll(() => playerCover.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
      const hashFromSrc = element => element.evaluate(async element => {
        const bytes = await (await fetch(element.currentSrc || element.src)).arrayBuffer();
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(value => value.toString(16).padStart(2, '0')).join('');
      });
      expect(await hashFromSrc(audio)).toBe(expectedAudio);
      expect(await hashFromSrc(playerCover)).toBe(expectedCover);
    } finally {
      await context.setOffline(false);
      await cleanup(app, upstream, directory);
    }
  });

  test('reopens recently viewed custom album and artist images from service worker cache without downloading music', async ({ page, context }) => {
    const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-artwork-recent-'));
    const artist = 'Recent Artwork Artist';
    const album = 'Recent Artwork Album';
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const cachedBytes = paths => page.evaluate(async paths => {
      const cache = await caches.open('groovebox-album-artwork-v1');
      return Promise.all(paths.map(async path => {
        const image = await cache.match(path);
        if (!image) return null;
        const hash = await crypto.subtle.digest('SHA-256', await image.arrayBuffer());
        return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
      }));
    }, paths);
    async function expectOfflineImage(locator, src, expected) {
      await expect(locator).toHaveAttribute('src', src);
      await expect.poll(() => locator.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
      expect(await locator.evaluate(async image => {
        const pixels = await (await fetch(image.currentSrc)).arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', pixels);
        return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
      })).toBe(expected);
    }
    let app, upstream;
    try {
      upstream = await startUpstream((request, response) => request.params.album
        ? raster(response, jpeg, 'image/jpeg') : raster(response, png, 'image/png'));
      app = await startApp(directory);
      await profile(page, [simulatedCloudTrack('849', 'Metadata Fixture Track', artist, album)], {}, { observePublic: false });
      await page.goto(app.url + '/#settings');
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
      await saveConfig(page, { url: upstream.url + '/recent', album: true, artist: true });

      await nav(page, 'albums');
      const albumImage = await coverImage(coverOf(page, album), app, jpeg, 'image/jpeg');
      await nav(page, 'artists');
      const artistImage = await coverImage(coverOf(page, artist), app, png, 'image/png');
      const albumHash = digest(jpeg);
      const artistHash = digest(png);
      await expect.poll(() => cachedBytes([albumImage, artistImage])).toEqual([albumHash, artistHash]);
      expect(upstream.requests.map(request => request.params)).toEqual([
        { album, artist, sourceType: 'api' }, { artist, sourceType: 'api' },
      ]);
      await card(page, artist).click();
      const portrait = page.locator('#content .artist-portrait img');
      await expect(portrait).toHaveAttribute('src', artistImage);
      const counts = await page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('groovebox.offline');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(['audio', 'folder-covers'], 'readonly');
          const audio = tx.objectStore('audio').count();
          const art = tx.objectStore('folder-covers').count();
          tx.onerror = () => reject(tx.error);
          tx.oncomplete = () => { open.result.close(); resolve([audio.result, art.result]); };
        };
      }));
      expect(counts).toEqual([0, 0]);

      await context.setOffline(true);
      await app.close();
      await upstream.close();
      await page.reload();
      expect(await page.evaluate(async pathname => {
        try { await fetch(pathname, { cache: 'no-store' }); return true; }
        catch { return false; }
      }, metadata + 'status')).toBe(false);
      await expectOfflineImage(portrait, artistImage, artistHash);
      await nav(page, 'artists');
      await expectOfflineImage(coverOf(page, artist), artistImage, artistHash);
      await nav(page, 'albums');
      await page.reload();
      await expectOfflineImage(coverOf(page, album), albumImage, albumHash);
      expect(upstream.requests).toHaveLength(2);
    } finally {
      await context.setOffline(false);
      await cleanup(app, upstream, directory);
    }
  });
});

test('rechecks a cached disabled state before public artwork when another profile enables a custom cover', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-artwork-fresh-public-'));
  const artist = 'External Config Artist';
  const album = 'External Config Album';
  let app, upstream;
  try {
    upstream = await startUpstream((_, response) => raster(response, png, 'image/png'));
    app = await startApp(directory);
    const publicLookups = await profile(page, [simulatedCloudTrack('841', 'External Config Recording', artist, album)], { onlineCover: true });
    const initial = page.waitForResponse(response => new URL(response.url()).pathname === metadata + 'status' && response.ok());
    await page.goto(app.url + '/#settings');
    expect(await (await initial).json()).toEqual({
      configured: false, artwork: { adapter: 'none', revision: 'none', album: false, artist: false },
    });
    await configButton(page).click();
    await expect(configForm(page).locator('[name=adapter]')).toHaveValue('none');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

    // Write through an independent client, without a browser notification to this page.
    const updated = await fetch(app.url + metadata + 'config', { method: 'PUT', headers: { Origin: app.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ artwork: { adapter: 'hisatri', url: upstream.url + '/external', album: true, artist: false, headersAction: 'keep' } }) });
    expect(updated.status).toBe(200);
    await nav(page, 'albums');
    await card(page, album).click();
    await coverImage(page.locator('#content .album-detail-cover img'), app, png, 'image/png');
    expect(upstream.requests.map(request => request.params)).toEqual([{ artist, album, sourceType: 'api' }]);
    expect(publicLookups).toEqual([]);
  } finally { await cleanup(app, upstream, directory); }
});

test('retries a transient image read with the same opaque ID and keeps the album card keyboard focus', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-artwork-image-focus-'));
  const artist = 'Transient Image Artist';
  const album = 'Transient Image Album';
  const prepared = Promise.withResolvers();
  const release = Promise.withResolvers();
  let app, upstream;
  try {
    upstream = await startUpstream((_, response) => raster(response, jpeg, 'image/jpeg'));
    app = await startApp(directory);
    const publicLookups = await profile(page, [simulatedCloudTrack('842', 'Transient Image Recording', artist, album)]);
    await page.goto(app.url + '/#settings');
    await saveConfig(page, { url: upstream.url + '/transient', album: true, artist: false });

    let hold = true;
    await page.route('**' + metadata + 'cover', async intercepted => {
      const response = await intercepted.fetch();
      if (hold) {
        hold = false;
        prepared.resolve(await response.json());
        await release.promise;
      }
      await intercepted.fulfill({ response });
    });
    const imageReads = [];
    await page.route('**' + metadata + 'image?**', intercepted => {
      imageReads.push(intercepted.request().url());
      return imageReads.length === 1 ? intercepted.fulfill({ status: 503 }) : intercepted.continue();
    });
    await nav(page, 'albums');
    const initial = await prepared.promise;
    await card(page, album).focus();
    await expect(card(page, album)).toBeFocused();
    release.resolve();
    const recovered = await coverImage(coverOf(page, album), app, jpeg, 'image/jpeg');
    expect(recovered).toBe(initial.cover);
    expect(imageReads).toEqual([app.url + recovered, app.url + recovered]);
    expect(upstream.requests).toHaveLength(1);
    expect(publicLookups).toEqual([]);
    await expect(card(page, album)).toBeFocused();
  } finally {
    release.resolve();
    await cleanup(app, upstream, directory);
  }
});
