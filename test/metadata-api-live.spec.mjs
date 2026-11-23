import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

const project = fileURLToPath(new URL('../', import.meta.url));
const stateKey = 'groovebox.state.v1';
const metadataPath = '/api/metadata/';
const settings = page => page.locator('#sidebar [data-nav=settings]');
const configure = page => page.getByRole('button', { name: 'Configure Lyric API', exact: true });
const now = page => page.locator('#now');
const playing = page => page.locator('#audio');
const trackButton = (page, title, artist) => page.locator('#content').getByRole('button', { name: title + ' ' + artist, exact: true });
const accessHeader = 'Bearer Disposable-Metadata-Header-A';
const customHeaderName = 'X-Fixture-Metadata-Token';
const customHeaderValue = 'disposable+literal=part';
const headerForm = 'Authorization=' + accessHeader + '&' + customHeaderName + '=' + customHeaderValue;

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function launchUpstream(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const request = { method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams), headers: req.headers };
    requests.push(request);
    void Promise.resolve().then(() => handler(request, res)).catch(() => {
      if (!res.headersSent) json(res, { error: 'Fixture response failed' }, 500);
      else res.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    requests,
    close: () => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

async function launchApp(data, port = 0) {
  const processState = spawn(process.execPath, ['server/index.mjs'], {
    cwd: project,
    env: { HOST: '127.0.0.1', PORT: String(port), GROOVEBOX_DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const close = async () => {
    if (processState.exitCode !== null || processState.signalCode !== null || !processState.pid) return;
    const exited = once(processState, 'exit');
    processState.kill('SIGTERM');
    await exited;
  };
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      processState.stdout.on('data', chunk => {
        output += chunk;
        const match = /^Groovebox: (http:\/\/127\.0\.0\.1:(\d+))$/m.exec(output);
        if (match) resolve(match[1]);
      });
      processState.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
      processState.once('error', reject);
      processState.once('exit', code => reject(new Error('Fixture server exited (' + code + ')\n' + errors)));
    });
    return { url, port: Number(new URL(url).port), close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function profile(page, settings = {}, tracks = [], publicResults = []) {
  await page.addInitScript(({ key, settings, tracks }) => {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({
      settings: { language: 'en', demos: false, onlineCover: false, artistImageEngine: false, autoMatchLyrics: true, ...settings },
      tracks,
    }));
  }, { key: stateKey, settings, tracks });
  const publicLookups = [];
  await page.route(/^https:\/\/lrclib\.net\//, route => {
    const request = route.request();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Lrclib-Client' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    publicLookups.push({ url: request.url(), headers: request.headers() });
    return route.fulfill({ json: publicResults, headers });
  });
  return publicLookups;
}

async function sample(title, artist, album, lyrics) {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  return {
    name: title + '.m4a',
    mimeType: 'audio/mp4',
    buffer: Buffer.from(await updateBuffer(audio, { title, artist, album, ...(lyrics && { lyrics }) })),
  };
}

async function addTrack(page, title, artist, album, lyrics) {
  await page.locator('#import-files').setInputFiles(await sample(title, artist, album, lyrics));
  await expect(trackButton(page, title, artist)).toBeVisible();
}

async function openLyrics(page, title, artist) {
  await trackButton(page, title, artist).click();
  await expect(page.locator('#player-title')).toHaveText(title);
  await expect.poll(() => playing(page).evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
  const tab = now(page).getByRole('button', { name: 'Lyrics', exact: true });
  if (!await tab.evaluate(button => button.classList.contains('active'))) await tab.click();
}

async function saveMetadata(page, configuration) {
  await settings(page).click();
  await configure(page).click();
  return submitMetadata(page, configuration);
}

async function submitMetadata(page, { adapter, url, headersAction = 'keep', headers }) {
  const provider = page.locator('#metadata-lyrics-adapter');
  await provider.selectOption(adapter);
  if (url !== undefined) await page.locator('#metadata-lyrics-url').fill(url);
  await page.locator('#metadata-headers-action').selectOption(headersAction);
  if (headers !== undefined) await page.locator('#metadata-headers').fill(headers);
  const put = page.waitForResponse(response => new URL(response.url()).pathname === metadataPath + 'config' &&
    response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save API settings', exact: true }).click();
  const response = await put;
  expect(response.status()).toBe(200);
  const state = await response.json();
  await expect(page.locator('#dialog')).not.toBeVisible();
  return state;
}

const apiStatus = app => fetch(app.url + metadataPath + 'status').then(response => response.json());
const editableConfig = app => fetch(app.url + metadataPath + 'config').then(response => response.json());
const lyric = (page, line) => now(page).getByRole('button', { name: line, exact: true });

async function clearFixture(app, upstream, directory) {
  await app?.close();
  await upstream?.close();
  await rm(directory, { recursive: true, force: true });
}

test('saves a write-only LRCLIB header, plays actual custom lyrics, and restores the configuration after restart', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-metadata-'));
  const title = 'Night Rain & Wind';
  const artist = 'Fixture Artist';
  const album = 'Fixture Album Ω';
  const line = 'Custom LRCLIB result';
  let app, upstream;
  try {
    upstream = await launchUpstream((request, res) => json(res, {
      trackName: request.params.track_name, instrumental: false,
      syncedLyrics: '[00:01.00]' + line, plainLyrics: 'Unsynced unused result',
    }));
    app = await launchApp(directory);
    const publicLookups = await profile(page);
    await page.context().addCookies([{ name: 'fixture_browser_cookie', value: 'private-browser-cookie-value', url: app.url }]);
    await page.goto(app.url + '/#settings');
    const configured = await saveMetadata(page, {
      adapter: 'lrclib', url: upstream.url + '/exact/lookup', headersAction: 'replace', headers: headerForm,
    });
    expect(configured).toMatchObject({ configured: true, lyrics: { adapter: 'lrclib', revision: expect.any(String) } });
    expect(upstream.requests).toHaveLength(0);
    const status = await apiStatus(app);
    expect(status).toEqual(configured);
    expect(JSON.stringify(status)).not.toContain(upstream.url);
    const redacted = await editableConfig(app);
    expect(redacted).toEqual({ lyrics: { adapter: 'lrclib', url: upstream.url + '/exact/lookup', hasHeaders: true } });
    const generated = await readFile(join(directory, 'metadata-settings.bin'));
    expect(generated.includes(Buffer.from(accessHeader))).toBe(false);
    expect(generated.includes(Buffer.from(customHeaderName))).toBe(false);
    if (process.platform !== 'win32') expect((await stat(join(directory, 'metadata-settings.bin'))).mode & 0o077).toBe(0);

    await page.locator('#sidebar [data-nav=offline]').click();
    await addTrack(page, title, artist, album);
    await openLyrics(page, title, artist);
    await expect(lyric(page, line)).toBeVisible();
    const duration = Math.round(await playing(page).evaluate(audio => audio.duration));
    expect(duration).toBeGreaterThan(0);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'GET', path: '/exact/lookup',
      params: { track_name: title, artist_name: artist, album_name: album, duration: String(duration) },
      headers: { accept: 'application/json', authorization: accessHeader, [customHeaderName.toLowerCase()]: customHeaderValue },
    });
    expect(upstream.requests[0].headers.cookie).toBeUndefined();
    expect(publicLookups).toEqual([]);

    await settings(page).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export backup', exact: true }).click();
    const backup = await readFile(await (await download).path(), 'utf8');
    const storage = await page.evaluate(() => JSON.stringify({
      local: Object.entries(localStorage), session: Object.entries(sessionStorage),
    }));
    for (const surface of [JSON.stringify(status), JSON.stringify(redacted), storage, backup]) {
      for (const forbidden of [accessHeader, customHeaderName, customHeaderValue, headerForm, 'private-browser-cookie-value']) {
        expect(surface).not.toContain(forbidden);
      }
    }
    expect(storage).not.toContain(upstream.url);
    expect(backup).not.toContain(upstream.url);

    const previousPort = app.port;
    await app.close();
    app = await launchApp(directory, previousPort);
    await page.reload();
    await configure(page).click();
    await expect(page.locator('#metadata-lyrics-adapter')).toHaveValue('lrclib');
    await expect(page.locator('#metadata-lyrics-url')).toHaveValue(upstream.url + '/exact/lookup');
    await page.locator('#metadata-headers-action').selectOption('replace');
    await expect(page.locator('#metadata-headers')).toHaveValue('');
    expect(await apiStatus(app)).toEqual(configured);
    expect(await editableConfig(app)).toEqual(redacted);
    const replied = await fetch(app.url + metadataPath + 'lyrics', { method: 'POST', headers: {
      Origin: app.url, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ title, artist, album, duration }) });
    expect(replied.status).toBe(200);
    expect(await replied.json()).toMatchObject({
      adapter: 'lrclib', revision: configured.lyrics.revision, syncedLyrics: '[00:01.00]' + line,
    });
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1].headers.authorization).toBe(accessHeader);
  } finally { await clearFixture(app, upstream, directory); }
});

test('parses real HisAtri LRC, keeps embedded and private lyrics first, and leaves a configured 404 as a miss', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-hisatri-'));
  const artist = 'HisAtri Fixture Artist';
  const album = 'HisAtri Fixture Album';
  const sourceTrack = {
    id: 'fixture-server-song', title: 'Device Private Audio', artist, album, albumIsFallback: false, provider: 'jellyfin',
    src: '/api/sources/fixture-server/stream?id=audio', lyrics: '/api/sources/fixture-server/stream?id=lyric',
  };
  const embedded = 'Embedded Source Fixture';
  const sidecar = 'Sidecar Source Fixture';
  const success = 'Custom HisAtri Fixture';
  const missing = 'Missing Custom Fixture';
  const upstreamLine = 'HisAtri from the actual upstream';
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  let app, upstream;
  try {
    upstream = await launchUpstream((request, res) => {
      if (request.params.title === missing) return json(res, { message: 'Missing' }, 404);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('[00:01.00]' + upstreamLine + '\n[00:07.00]Second line');
    });
    app = await launchApp(directory);
    const publicLookups = await profile(page, {}, [sourceTrack]);
    const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    await page.route('**' + sourceTrack.src, route => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      if (!range) return route.fulfill({ contentType: 'audio/mp4', body: audio, headers: { 'Accept-Ranges': 'bytes' } });
      const first = Number(range[1]);
      const last = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      return route.fulfill({ status: 206, contentType: 'audio/mp4', body: audio.subarray(first, last + 1),
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + first + '-' + last + '/' + audio.length } });
    });
    await page.route('**' + sourceTrack.lyrics, async route => {
      waiting.resolve();
      await release.promise;
      await route.fulfill({ json: { lines: [{ time: 0, text: 'Private provider lyric' }] } });
    });
    await page.goto(app.url + '/#settings');
    const configured = await saveMetadata(page, { adapter: 'hisatri', url: upstream.url + '/hisatri' });
    expect(configured).toMatchObject({ configured: true, lyrics: { adapter: 'hisatri' } });
    await page.locator('#sidebar [data-nav=offline]').click();
    await addTrack(page, embedded, artist, album, '[00:00.00]Embedded local lyric');
    await openLyrics(page, embedded, artist);
    await expect(lyric(page, 'Embedded local lyric')).toBeVisible();
    expect(upstream.requests).toHaveLength(0);
    await page.locator('#import-files').setInputFiles([
      await sample(sidecar, artist, album),
      { name: sidecar + '.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:00.00]Local sidecar lyric') },
    ]);
    await openLyrics(page, sidecar, artist);
    await expect(lyric(page, 'Local sidecar lyric')).toBeVisible();
    expect(upstream.requests).toHaveLength(0);

    await page.locator('#sidebar [data-nav=songs]').click();
    await openLyrics(page, sourceTrack.title, artist);
    await waiting.promise;
    expect(upstream.requests).toHaveLength(0);
    release.resolve();
    await expect(lyric(page, 'Private provider lyric')).toBeVisible();
    expect(upstream.requests).toHaveLength(0);

    await page.locator('#sidebar [data-nav=offline]').click();
    await addTrack(page, success, artist, album);
    await openLyrics(page, success, artist);
    await expect(lyric(page, upstreamLine)).toBeVisible();
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({ method: 'GET', path: '/hisatri',
      params: { title: success, artist, album }, headers: { accept: 'application/json' } });

    await addTrack(page, missing, artist, album);
    const miss = page.waitForResponse(response => new URL(response.url()).pathname === metadataPath + 'lyrics' && response.status() === 404);
    await openLyrics(page, missing, artist);
    expect(await (await miss).json()).toMatchObject({ code: 'metadata_not_found' });
    await expect(now(page).getByText('No lyrics available', { exact: true })).toBeVisible();
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1].params).toEqual({ title: missing, artist, album });
    expect(publicLookups).toEqual([]);
    await now(page).getByRole('button', { name: 'Browse Other Versions', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Search sends the song details you enter to LRCLIB/)).toBeVisible();
    expect(publicLookups).toEqual([]);
    await dialog.getByRole('button', { name: 'Search lyrics', exact: true }).click();
    await expect.poll(() => publicLookups.length).toBe(1);
    const manualSearch = new URL(publicLookups[0].url);
    expect(manualSearch.pathname).toBe('/api/search');
    expect(Object.fromEntries(manualSearch.searchParams)).toEqual({ track_name: missing, artist_name: artist });
    expect(publicLookups[0].headers.authorization).toBeUndefined();
    expect(upstream.requests).toHaveLength(2);
  } finally {
    release.resolve();
    await clearFixture(app, upstream, directory);
  }
});

test('ignores a delayed old proxy reply after replacing the configured adapter on the same playing track', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-metadata-revision-'));
  const title = 'Custom Revision Fixture Title';
  const artist = 'Custom Revision Fixture Artist';
  const album = 'Custom Revision Fixture Album';
  const oldLine = 'Old configuration lyric must not be adopted';
  const newLine = 'New configuration lyric';
  const prepared = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  let app, upstream;
  try {
    upstream = await launchUpstream((request, res) => {
      if (request.path === '/old') return json(res, { syncedLyrics: '[00:00.00]' + oldLine });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('[00:00.00]' + newLine);
    });
    app = await launchApp(directory);
    const publicLookups = await profile(page);
    let responses = 0;
    await page.route('**/api/metadata/lyrics', async route => {
      const response = await route.fetch();
      if (++responses === 1) {
        try {
          prepared.resolve({ status: response.status(), body: await response.json() });
          await release.promise;
          await route.fulfill({ response }).catch(() => {
            // The browser may abort delivery after replacing the configuration.
          });
        } finally { delivered.resolve(); }
      } else await route.fulfill({ response });
    });
    await page.goto(app.url + '/#settings');
    const original = await saveMetadata(page, { adapter: 'lrclib', url: upstream.url + '/old' });
    await page.locator('#sidebar [data-nav=offline]').click();
    await addTrack(page, title, artist, album);
    await openLyrics(page, title, artist);
    const first = await prepared.promise;
    expect(first).toMatchObject({ status: 200, body: { revision: original.lyrics.revision, syncedLyrics: '[00:00.00]' + oldLine } });
    const resumed = await playing(page).evaluate(audio => ({ src: audio.src, position: audio.currentTime }));

    const replacement = await saveMetadata(page, { adapter: 'hisatri', url: upstream.url + '/new' });
    expect(replacement.lyrics.revision).not.toBe(original.lyrics.revision);
    release.resolve();
    await delivered.promise;
    await expect(lyric(page, newLine)).toBeVisible();
    await expect(lyric(page, oldLine)).toHaveCount(0);
    expect(upstream.requests.map(request => request.path)).toEqual(['/old', '/new']);
    expect(publicLookups).toEqual([]);
    const current = await playing(page).evaluate(audio => ({ src: audio.src, position: audio.currentTime, paused: audio.paused }));
    expect(current).toMatchObject({ src: resumed.src, paused: false });
    expect(current.position).toBeGreaterThanOrEqual(resumed.position);
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).onlineLyrics, stateKey);
    expect(JSON.stringify(saved)).toContain(newLine);
    expect(JSON.stringify(saved)).not.toContain(oldLine);
  } finally {
    release.resolve();
    await clearFixture(app, upstream, directory);
  }
});

test('manually uses configured lyrics with automatic matching off and can switch back to original lyrics', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-metadata-manual-'));
  const title = 'Manual Override Fixture';
  const artist = 'Manual Fixture Artist';
  const album = 'Manual Fixture Album';
  const sourceLine = 'Original embedded lyric';
  const manualLine = 'Explicit HisAtri lyric';
  let app, upstream;
  try {
    upstream = await launchUpstream((request, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('[00:00.00]' + manualLine);
    });
    app = await launchApp(directory);
    const publicLookups = await profile(page, { autoMatchLyrics: false });
    await page.goto(app.url + '/#settings');
    await saveMetadata(page, { adapter: 'hisatri', url: upstream.url + '/manual' });
    await page.locator('#sidebar [data-nav=offline]').click();
    await addTrack(page, title, artist, album, '[00:00.00]' + sourceLine);
    await openLyrics(page, title, artist);
    await expect(lyric(page, sourceLine)).toBeVisible();
    expect(upstream.requests).toHaveLength(0);

    await now(page).getByRole('button', { name: 'Find lyrics online', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/configured HisAtri API/)).toBeVisible();
    expect(upstream.requests).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Search lyrics', exact: true }).click();
    await expect(lyric(page, manualLine)).toBeVisible();
    await expect(now(page).locator('[data-custom-lyric-source]')).toHaveText('Lyrics from configured HisAtri API');
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].params).toEqual({ title, artist, album });
    const original = now(page).getByRole('button', { name: 'Use original lyrics', exact: true });
    await original.click();
    await expect(lyric(page, sourceLine)).toBeVisible();
    await expect(now(page).locator('[data-custom-lyric-source]')).toHaveCount(0);

    await now(page).getByRole('button', { name: 'Browse Other Versions', exact: true }).click();
    await expect(dialog.getByText(/Search sends the song details you enter to LRCLIB/)).toBeVisible();
    expect(upstream.requests).toHaveLength(1);
    expect(publicLookups).toEqual([]);
  } finally { await clearFixture(app, upstream, directory); }
});

test('supersedes a held status read on a peer update and discovers a new external revision after reload', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-metadata-peer-'));
  const title = 'Metadata Peer Fixture';
  const artist = 'Metadata Peer Artist';
  const album = 'Metadata Peer Album';
  const oldLine = 'Lyrics from the first revision';
  const peerLine = 'Lyrics from the peer revision';
  const restartedLine = 'Lyrics from the external revision';
  const prepared = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  let app, upstream, editor;
  try {
    upstream = await launchUpstream((request, res) => {
      const line = ({ '/first': oldLine, '/peer': peerLine, '/external': restartedLine })[request.path];
      if (!line) return json(res, {}, 404);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('[00:00.00]' + line);
    });
    app = await launchApp(directory);
    await profile(page);
    await page.goto(app.url + '/#settings');
    const first = await saveMetadata(page, { adapter: 'hisatri', url: upstream.url + '/first' });
    await page.locator('#sidebar [data-nav=offline]').click();
    await addTrack(page, title, artist, album);
    await openLyrics(page, title, artist);
    await expect(lyric(page, oldLine)).toBeVisible();

    let hold = true;
    await page.route('**/api/metadata/status', async route => {
      const response = await route.fetch();
      if (!hold) return route.fulfill({ response });
      hold = false;
      try {
        prepared.resolve(await response.json());
        await release.promise;
        await route.fulfill({ response }).catch(() => {
          // A superseded read may be aborted by the browser.
        });
      } finally { delivered.resolve(); }
    });
    await page.evaluate(() => {
      const channel = new BroadcastChannel('groovebox.metadata-api');
      channel.postMessage('fixture status refresh');
      channel.close();
    });
    expect(await prepared.promise).toEqual(first);

    editor = await page.context().newPage();
    await editor.goto(app.url + '/#settings');
    const peer = await saveMetadata(editor, { adapter: 'hisatri', url: upstream.url + '/peer' });
    expect(peer.lyrics.revision).not.toBe(first.lyrics.revision);
    await expect(lyric(page, peerLine)).toBeVisible();
    release.resolve();
    await delivered.promise;
    await expect(lyric(page, oldLine)).toHaveCount(0);

    const external = await fetch(app.url + metadataPath + 'config', { method: 'PUT', headers: {
      Origin: app.url, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ lyrics: { adapter: 'hisatri', url: upstream.url + '/external', headersAction: 'keep' } }) });
    expect(external.status).toBe(200);
    const externalStatus = await external.json();
    expect(externalStatus.lyrics.revision).not.toBe(peer.lyrics.revision);
    const startupRead = page.waitForResponse(response => new URL(response.url()).pathname === metadataPath + 'status' &&
      response.request().method() === 'GET' && response.ok());
    await page.reload();
    expect(await (await startupRead).json()).toEqual(externalStatus);
    await openLyrics(page, title, artist);
    await expect(lyric(page, restartedLine)).toBeVisible();
    await expect(lyric(page, peerLine)).toHaveCount(0);
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).onlineLyrics, stateKey);
    expect(saved.some(([, lines, , source]) => lines.some(line => line.text === restartedLine) && source?.revision === externalStatus.lyrics.revision)).toBe(true);
  } finally {
    release.resolve();
    await editor?.close();
    await clearFixture(app, upstream, directory);
  }
});

for (const replacement of ['none', 'hisatri']) test('refuses an open custom lyric form after a peer switches to ' + (replacement === 'none' ? 'public matching' : 'another endpoint'), async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-metadata-old-form-'));
  const title = 'Old Form Fixture';
  const artist = 'Old Form Artist';
  const album = 'Old Form Album';
  let app, upstream, editor;
  try {
    upstream = await launchUpstream((request, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('[00:00.00]Different lyric for ' + request.path);
    });
    app = await launchApp(directory);
    const publicLookups = await profile(page, { autoMatchLyrics: false });
    await page.goto(app.url + '/#settings');
    const original = await saveMetadata(page, { adapter: 'hisatri', url: upstream.url + '/original' });
    await page.locator('#sidebar [data-nav=offline]').click();
    await addTrack(page, title, artist, album);
    await openLyrics(page, title, artist);
    await now(page).getByRole('button', { name: 'Find lyrics online', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/configured HisAtri API/)).toBeVisible();
    expect(upstream.requests).toEqual([]);

    editor = await page.context().newPage();
    await editor.goto(app.url + '/#settings');
    const notification = page.waitForResponse(async response => {
      if (!response.ok() || new URL(response.url()).pathname !== metadataPath + 'status') return false;
      const status = await response.json().catch(() => null);
      return status?.lyrics.adapter === replacement && status.lyrics.revision !== original.lyrics.revision;
    });
    const chosen = await saveMetadata(editor, { adapter: replacement, url: replacement === 'none' ? '' : upstream.url + '/changed' });
    expect(await (await notification).json()).toEqual(chosen);
    await dialog.getByRole('button', { name: 'Search lyrics', exact: true }).click();
    await expect(dialog.locator('[data-lyric-status]')).toContainText(/settings changed/i);
    expect(upstream.requests).toEqual([]);
    expect(publicLookups).toEqual([]);
  } finally {
    await editor?.close();
    await clearFixture(app, upstream, directory);
  }
});

test('completes one manual custom search when a focus refresh supersedes its held status read for the same configuration', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-metadata-focus-'));
  const title = 'Focus Fixture';
  const artist = 'Focus Artist';
  const album = 'Focus Album';
  const line = 'Result after status refresh';
  const held = Promise.withResolvers();
  const refreshed = Promise.withResolvers();
  const release = Promise.withResolvers();
  let app, upstream;
  try {
    upstream = await launchUpstream((_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('[00:00.00]' + line);
    });
    app = await launchApp(directory);
    const publicLookups = await profile(page, { autoMatchLyrics: false });
    await page.goto(app.url + '/#settings');
    const configured = await saveMetadata(page, { adapter: 'hisatri', url: upstream.url + '/focus' });
    await page.locator('#sidebar [data-nav=offline]').click();
    await addTrack(page, title, artist, album);
    await openLyrics(page, title, artist);
    await now(page).getByRole('button', { name: 'Find lyrics online', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/configured HisAtri API/)).toBeVisible();

    let reads = 0;
    await page.route('**/api/metadata/status', async route => {
      const number = ++reads;
      const response = await route.fetch();
      if (number === 1) {
        held.resolve(await response.json());
        await release.promise;
        await route.fulfill({ response }).catch(() => {});
      } else {
        const status = await response.json();
        await route.fulfill({ response });
        refreshed.resolve(status);
      }
    });
    const request = page.waitForRequest(req => new URL(req.url()).pathname === metadataPath + 'lyrics' && req.method() === 'POST');
    await dialog.getByRole('button', { name: 'Search lyrics', exact: true }).click();
    expect(await held.promise).toEqual(configured);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(await refreshed.promise).toEqual(configured);
    release.resolve();
    await expect(lyric(page, line)).toBeVisible();
    expect((await request).headers()['x-metadata-revision']).toBe(configured.lyrics.revision);
    await expect(dialog).not.toBeVisible();
    expect(upstream.requests).toHaveLength(1);
    expect(publicLookups).toEqual([]);
  } finally {
    release.resolve();
    await clearFixture(app, upstream, directory);
  }
});

test('keeps public Browse Other Versions usable immediately after the custom lyric service is throttled', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-metadata-throttle-'));
  const title = 'Throttle Fixture';
  const artist = 'Throttle Artist';
  const album = 'Throttle Album';
  const publicAlbum = 'Public Lyric Version Album';
  const publicLine = 'Public manual result while custom is throttled';
  let app, upstream;
  try {
    upstream = await launchUpstream((_, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '300' });
      res.end(JSON.stringify({ error: 'Local fixture is throttled' }));
    });
    app = await launchApp(directory);
    const publicLookups = await profile(page, { autoMatchLyrics: false }, [], [{
      trackName: title, artistName: artist, albumName: publicAlbum, duration: 180, syncedLyrics: '[00:00.00]' + publicLine,
    }]);
    await page.goto(app.url + '/#settings');
    await saveMetadata(page, { adapter: 'hisatri', url: upstream.url + '/rate-limit' });
    await page.locator('#sidebar [data-nav=offline]').click();
    await addTrack(page, title, artist, album);
    await openLyrics(page, title, artist);
    await now(page).getByRole('button', { name: 'Find lyrics online', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const throttle = page.waitForResponse(response => new URL(response.url()).pathname === metadataPath + 'lyrics' && response.status() === 429);
    await dialog.getByRole('button', { name: 'Search lyrics', exact: true }).click();
    expect(await (await throttle).json()).toMatchObject({ code: 'metadata_rate_limited', retryAfter: 300 });
    await expect(dialog.locator('[data-lyric-status]')).toContainText(/configured lyric API is busy/i);
    expect(upstream.requests).toHaveLength(1);
    expect(publicLookups.length).toBe(0);

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await now(page).getByRole('button', { name: 'Browse Other Versions', exact: true }).click();
    await expect(dialog.getByText(/Search sends the song details you enter to LRCLIB/)).toBeVisible();
    expect(publicLookups.length).toBe(0);
    await dialog.getByRole('button', { name: 'Search lyrics', exact: true }).click();
    const version = dialog.getByRole('button', { name: /Public Lyric Version Album/ });
    await expect(version).toBeVisible();
    expect(publicLookups).toHaveLength(1);
    expect(new URL(publicLookups[0].url).pathname).toBe('/api/search');
    expect(publicLookups[0].headers.authorization).toBeUndefined();
    await version.click();
    await expect(lyric(page, publicLine)).toBeVisible();
    expect(upstream.requests).toHaveLength(1);
  } finally { await clearFixture(app, upstream, directory); }
});

test('blocks an old manual search when actual playback advances to the next queued track', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-metadata-track-change-'));
  const first = 'Alpha Stale Form Fixture';
  const next = 'Beta Next Playback Fixture';
  const artist = 'Queued Fixture Artist';
  const album = 'Queued Fixture Album';
  let app, upstream;
  try {
    upstream = await launchUpstream((_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('[00:00.00]Stale form must never look up this lyric');
    });
    app = await launchApp(directory);
    const publicLookups = await profile(page, { autoMatchLyrics: false });
    await page.goto(app.url + '/#settings');
    await saveMetadata(page, { adapter: 'hisatri', url: upstream.url + '/queued' });
    await page.locator('#sidebar [data-nav=offline]').click();
    await page.locator('#import-files').setInputFiles(await Promise.all([sample(first, artist, album), sample(next, artist, album)]));
    await expect(trackButton(page, next, artist)).toBeVisible();
    await openLyrics(page, first, artist);
    await now(page).getByRole('button', { name: 'Find lyrics online', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: 'Song title' })).toHaveValue(first);

    await playing(page).evaluate(audio => { audio.currentTime = audio.duration - 0.2; });
    await expect(page.locator('#player-title')).toHaveText(next);
    await dialog.getByRole('button', { name: 'Search lyrics', exact: true }).click();
    await expect(dialog.locator('[data-lyric-status]')).toContainText(/playing track changed/i);
    expect(upstream.requests).toEqual([]);
    expect(publicLookups).toEqual([]);
  } finally { await clearFixture(app, upstream, directory); }
});

test('stops automatic lookups with damaged encrypted settings and recovers from the settings dialog', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-live-metadata-damaged-'));
  const file = join(directory, 'metadata-settings.bin');
  const title = 'Damaged Config Fixture';
  const artist = 'Damaged Config Artist';
  const album = 'Damaged Config Album';
  const recoveredLine = 'Lyrics after recovering the configuration';
  const warning = 'Saved API settings could not be read. Automatic lookup is stopped. Saving will replace the damaged settings.';
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  let app, upstream;
  try {
    upstream = await launchUpstream((_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('[00:00.00]' + recoveredLine);
    });
    app = await launchApp(directory);
    const port = app.port;
    const publicLookups = await profile(page);
    await page.goto(app.url + '/#settings');
    await saveMetadata(page, { adapter: 'hisatri', url: upstream.url + '/previous', headersAction: 'replace', headers: headerForm });
    await app.close();
    const encrypted = await readFile(file);
    encrypted[encrypted.length - 1] ^= 1;
    await writeFile(file, encrypted);
    app = await launchApp(directory, port);

    const failedStatus = await fetch(app.url + metadataPath + 'status');
    expect(failedStatus.status).toBe(503);
    expect(await failedStatus.json()).toMatchObject({ code: 'metadata_config_unavailable' });
    const failed = page.waitForResponse(response => new URL(response.url()).pathname === metadataPath + 'status' && response.status() === 503);
    await page.reload();
    await failed;
    const customCalls = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === metadataPath + 'lyrics') customCalls.push(request.url());
    });
    await page.locator('#sidebar [data-nav=offline]').click();
    await addTrack(page, title, artist, album);
    await openLyrics(page, title, artist);
    await expect(now(page).getByText('No lyrics available', { exact: true })).toBeVisible();
    expect(customCalls).toEqual([]);
    expect(upstream.requests).toEqual([]);
    expect(publicLookups).toEqual([]);

    await settings(page).click();
    await configure(page).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(warning, { exact: true })).toBeVisible();
    await expect(page.locator('#metadata-lyrics-url')).toHaveValue('');
    await expect(page.locator('#metadata-headers')).toHaveValue('');

    let hold = true;
    await page.route('**/api/metadata/status', async route => {
      const response = await route.fetch();
      if (!hold) return route.fulfill({ response });
      hold = false;
      held.resolve(response.status());
      try {
        await release.promise;
        await route.fulfill({ response }).catch(() => {});
      } finally { delivered.resolve(); }
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(await held.promise).toBe(503);
    const repaired = await submitMetadata(page, { adapter: 'hisatri', url: upstream.url + '/recovered', headersAction: 'remove' });
    release.resolve();
    await delivered.promise;
    expect(repaired).toMatchObject({ configured: true, lyrics: { adapter: 'hisatri' } });
    await expect(lyric(page, recoveredLine)).toBeVisible();
    expect(upstream.requests.map(request => request.path)).toEqual(['/recovered']);
    expect(upstream.requests[0].headers.authorization).toBeUndefined();
    expect(publicLookups).toEqual([]);

    await app.close();
    app = await launchApp(directory, port);
    expect(await apiStatus(app)).toEqual(repaired);
    await page.reload();
    await configure(page).click();
    await expect(dialog.getByText(warning, { exact: true })).toHaveCount(0);
    await expect(page.locator('#metadata-lyrics-url')).toHaveValue(upstream.url + '/recovered');
  } finally {
    release.resolve();
    await clearFixture(app, upstream, directory);
  }
});
