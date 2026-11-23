import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const project = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.GROOVEBOX_WEBDAV_TEST_PYTHON;
const certificate = process.env.GROOVEBOX_WEBDAV_TEST_CERT;
const key = process.env.GROOVEBOX_WEBDAV_TEST_KEY;
const ca = process.env.NODE_EXTRA_CA_CERTS;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function child(command, args, options, ready) {
  const process = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  const url = new Promise((resolve, reject) => {
    process.stdout.on('data', data => { output += data; const value = ready(output); if (value) resolve(value); });
    process.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
    process.once('error', reject);
    process.once('exit', code => reject(new Error('Isolated fixture exited (' + code + '): ' + errors)));
  });
  void url.catch(() => {});
  return {
    url,
    async close() {
      if (process.exitCode !== null || process.signalCode !== null) return;
      const ended = once(process, 'exit');
      process.kill('SIGTERM');
      await ended;
    },
  };
}

function dav(directory) {
  const script = [
    'import sys',
    'from cheroot.ssl.builtin import BuiltinSSLAdapter',
    'from cheroot.wsgi import Server',
    'from wsgidav.wsgidav_app import WsgiDAVApp',
    'root, cert, key = sys.argv[1:]',
    'app = WsgiDAVApp({"provider_mapping": {"/": root}, "verbose": 0, "dir_browser": {"enable": False},',
    ' "http_authenticator": {"accept_basic": True, "accept_digest": False, "default_to_digest": False},',
    ' "simple_dc": {"user_mapping": {"*": {"large-fixture": {"password": "isolated-large-library-password"}}}}})',
    'server = Server(("127.0.0.1", 0), app)',
    'server.ssl_adapter = BuiltinSSLAdapter(cert, key)',
    'server.prepare()',
    'print("PORT=" + str(server.bind_addr[1]), flush=True)',
    'server.serve()',
  ].join('\n');
  return child(python, ['-c', script, directory, certificate, key], {}, output => {
    const port = /^PORT=(\d+)$/m.exec(output)?.[1];
    return port && 'https://127.0.0.1:' + port;
  });
}

async function app(directory, port = 0) {
  const instance = child(process.execPath, ['server/index.mjs'], { cwd: project, env: {
    HOST: '127.0.0.1', PORT: String(port), GROOVEBOX_DATA_DIR: directory, NODE_EXTRA_CA_CERTS: ca,
  } }, output => /^Groovebox: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output)?.[1]);
  try { return { ...instance, origin: await instance.url }; }
  catch (error) { await instance.close(); throw error; }
}

test('20,000 real WebDAV files survive server restart, whole-library scan, browser reload and portable backup restore', async ({ page, context, browser }) => {
  test.skip(!(python && certificate && key && ca), 'Requires the isolated HTTPS WsgiDAV installation and CA');
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-large-dav-'));
  const media = join(root, 'media');
  const state = join(root, 'state');
  const audio = await Promise.all([1, 2, 3].map(index => readFile(join(project, 'public/assets/demo-' + index + '.m4a'))));
  const cover = await readFile(join(project, 'public/assets/cover-1.jpg'));
  const lyrics = '[00:00.00]Large library restart verification\n';
  let upstream, running, outsider;
  const measurements = { tracks: 20_000 };
  try {
    await mkdir(media);
    const started = performance.now();
    for (let album = 0; album < 20; album++) {
      const folder = join(media, 'Album ' + String(album).padStart(2, '0'));
      await mkdir(folder);
      const original = join(folder, 'Fixture 0000.m4a');
      await writeFile(original, audio[album % 3]);
      // Hard links give WsgiDAV a genuine directory of distinct file paths without duplicating audio bytes.
      for (let chunk = 0; chunk < 10; chunk++) await Promise.all(Array.from({ length: 100 }, (_, offset) => chunk * 100 + offset)
        .filter(index => index > 0).map(index => link(original, join(folder, 'Fixture ' + String(index).padStart(4, '0') + '.m4a'))));
      await writeFile(join(folder, 'cover.jpg'), cover);
      await writeFile(join(folder, 'Fixture 0000.lrc'), lyrics);
    }
    measurements.fixtureMilliseconds = Math.round(performance.now() - started);
    upstream = dav(media);
    running = await app(state);
    const base = await upstream.url;
    const response = await context.request.post(running.origin + '/api/sources', { headers: { Origin: running.origin }, data: {
      type: 'webdav', name: 'Large isolated WebDAV library', url: base,
      username: 'large-fixture', password: 'isolated-large-library-password',
    } });
    expect(response.status()).toBe(201);
    const { source } = await response.json();
    const endpoint = '/api/sources/' + source.id;
    const listed = await context.request.get(running.origin + endpoint + '/list');
    expect(listed.status()).toBe(200);
    const folders = (await listed.json()).items.filter(item => item.folder).sort((a, b) => a.name.localeCompare(b.name));
    expect(folders).toHaveLength(20);
    const ids = new Set();
    const samples = [];
    const listingStarted = performance.now();
    for (const [album, folder] of folders.entries()) {
      const listing = await context.request.get(running.origin + endpoint + '/list?path=' + encodeURIComponent(folder.path));
      expect(listing.status()).toBe(200);
      const items = (await listing.json()).items;
      const tracks = items.filter(item => !item.folder && /\.m4a$/i.test(item.name));
      expect(tracks).toHaveLength(1000);
      for (const track of tracks) { expect(ids.has(track.id)).toBe(false); ids.add(track.id); }
      if ([0, 10, 19].includes(album)) {
        const first = tracks.find(item => item.name === 'Fixture 0000.m4a');
        expect(first.folderCover).toBeTruthy();
        const lyric = items.find(item => item.name === 'Fixture 0000.lrc');
        expect(lyric.streamUrl).toBeTruthy();
        samples.push({ track: first, lyric: lyric.streamUrl, album, folder });
      }
    }
    expect(ids.size).toBe(20_000);
    measurements.indexMilliseconds = Math.round(performance.now() - listingStarted);
    const sessionFiles = await readdir(join(state, 'source-sessions'));
    expect(sessionFiles).toHaveLength(1);
    measurements.encryptedSnapshotBytes = (await stat(join(state, 'source-sessions', sessionFiles[0]))).size;
    expect(measurements.encryptedSnapshotBytes).toBeLessThan(16 * 1024 * 1024);
    const previousOrigin = running.origin;
    const restartStarted = performance.now();
    await running.close();
    running = await app(state, Number(new URL(previousOrigin).port));
    expect(running.origin).toBe(previousOrigin);
    measurements.restartMilliseconds = Math.round(performance.now() - restartStarted);
    // Do not refresh /sources or any listing before all three stored paths are used.
    const coldReadStarted = performance.now();
    for (const { track, lyric, album } of samples) {
      const range = await context.request.get(running.origin + track.streamUrl, { headers: { Range: 'bytes=64-255' } });
      expect(range.status()).toBe(206);
      expect(await range.body()).toEqual(audio[album % 3].subarray(64, 256));
      measurements.firstColdRangeMilliseconds ??= Math.round(performance.now() - coldReadStarted);
      const full = await context.request.get(running.origin + track.streamUrl);
      expect(full.status()).toBe(200);
      expect(hash(await full.body())).toBe(hash(audio[album % 3]));
      const picture = await context.request.get(running.origin + track.folderCover);
      expect(picture.status()).toBe(200);
      expect(hash(await picture.body())).toBe(hash(cover));
      const text = await context.request.get(running.origin + lyric);
      expect(text.status()).toBe(200);
      expect(await text.text()).toBe(lyrics);
    }
    outsider = await browser.newContext();
    expect((await outsider.request.get(running.origin + samples[0].track.streamUrl)).status()).toBe(404);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(running.origin + '/#source/' + source.id);
    await page.locator('#content [data-action="open-folder"]').filter({ hasText: samples[0].folder.name }).click();
    await expect(page.locator('#content tbody tr')).toHaveCount(1000);
    await page.locator('#content tbody tr').filter({ hasText: 'Fixture 0000' }).locator('.track-main').click();
    await expect.poll(() => page.locator('#audio').evaluate(element => element.currentTime)).toBeGreaterThan(.1);
    await page.locator('[data-action="crumb"][data-index="0"]').click();
    await expect(page.locator('#content [data-action="open-folder"]')).toHaveCount(20);
    const clientScanStarted = performance.now();
    await page.locator('[data-action="scan-cloud"]').click();
    await expect(page.locator('[data-scan-status]')).toBeVisible();
    await expect(page.locator('[data-scan-status]')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('#toast')).toContainText('扫描完成');
    const catalogCount = () => page.evaluate(async () => {
      const { readCloudCatalogState } = await import('/cloud-catalog.js');
      return (await readCloudCatalogState()).records.reduce((total, catalog) => total + catalog.tracks.length, 0);
    });
    await expect.poll(catalogCount).toBe(20_000);
    measurements.clientScanMilliseconds = Math.round(performance.now() - clientScanStarted);
    expect(await page.evaluate(() => localStorage.getItem('groovebox.state.v1').length)).toBeLessThan(1_000_000);
    await page.locator('#player-heart').click();
    await expect(page.locator('#player-heart')).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.locator('#player-title')).toHaveText('Fixture 0000');
    await expect(page.locator('#player-heart')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(catalogCount).toBe(20_000);
    await page.locator('#search').fill('Fixture 0999');
    await expect(page.locator('#content tbody tr')).toHaveCount(20);
    await page.locator('#sidebar [data-nav="settings"]').click();
    const downloadReady = page.waitForEvent('download');
    await page.locator('[data-action="export"]').click();
    const backup = JSON.parse(await readFile(await (await downloadReady).path(), 'utf8'));
    expect(backup.version).toBe(1);
    expect(backup.tracks).toHaveLength(20_000);
    const removed = backup.tracks.find(track => track.title === 'Fixture 0999');
    expect(removed).toBeTruthy();
    const smaller = { ...backup, tracks: backup.tracks.filter(track => track.id !== removed.id) };
    await page.locator('#restore-file').setInputFiles({ name: 'large-subset.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(smaller)) });
    await expect(page.locator('#toast')).toHaveText('备份已恢复。');
    await expect.poll(catalogCount).toBe(19_999);
    await page.reload();
    await expect.poll(catalogCount).toBe(19_999);
    await page.locator('#search').fill('Fixture 0999');
    await expect(page.locator('#content tbody tr')).toHaveCount(19);
    await page.locator('#sidebar [data-nav="settings"]').click();
    await page.locator('#restore-file').setInputFiles({ name: 'large-complete.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await expect(page.locator('#toast')).toHaveText('备份已恢复。');
    await expect.poll(catalogCount).toBe(20_000);
    await page.reload();
    await expect.poll(catalogCount).toBe(20_000);
    await page.locator('#search').fill('Fixture 0999');
    await expect(page.locator('#content tbody tr')).toHaveCount(20);
    expect(errors).toEqual([]);
    console.log('LARGE_DAV_MEASUREMENTS ' + JSON.stringify(measurements));
  } finally {
    await outsider?.close();
    await running?.close();
    await upstream?.close();
    await rm(root, { recursive: true, force: true });
  }
});
