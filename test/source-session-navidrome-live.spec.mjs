import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const navidromeBin = process.env.NAVIDROME_TEST_BIN;
const ffmpegBin = process.env.FFMPEG_TEST_BIN;
const title = 'Restart Fixture Recording';
const artist = 'Restart Fixture Artist';
const album = 'Restart Fixture Album';
const playlistName = 'Restart server playlist';
const sourceName = 'Restart Navidrome';
const introduction = 'Song before a service restart';
const chorus = 'Song after a service restart';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function availablePort() {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(close => reservation.close(close));
  return port;
}

async function runningPlayer(data, port = 0) {
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: project,
    env: { HOST: '127.0.0.1', PORT: String(port), GROOVEBOX_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let buffered = '';
      child.stdout.on('data', chunk => {
        buffered = (buffered + chunk).slice(-1024);
        const found = /^Groovebox: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(buffered)?.[1];
        if (found) resolve(found);
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Player exited during startup (' + code + ')')));
    });
    return { child, url };
  } catch (error) { await stop(child); throw error; }
}

test('real Navidrome plays original bytes and structured lyrics from the same opaque links after a server restart', async ({ page }) => {
  test.skip(!navidromeBin || !ffmpegBin, 'Provide NAVIDROME_TEST_BIN and FFMPEG_TEST_BIN for the live fixture.');
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-navidrome-restart-'));
  const fold = join(root, 'music', 'Performers', 'Album');
  const recording = join(fold, 'Recording.flac');
  const data = join(root, 'player-data');
  const password = randomBytes(24).toString('hex');
  let app;
  let navidrome;
  try {
    await mkdir(fold, { recursive: true });
    await Promise.all([
      exec(ffmpegBin, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
        '-metadata', 'artist=' + artist, '-metadata', 'album=' + album, '-metadata', 'title=' + title,
        '-c:a', 'flac', recording], { timeout: 10_000 }),
      writeFile(join(fold, 'cover.jpg'), await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url))),
      writeFile(join(fold, 'Recording.lrc'), '[00:00.00]' + introduction + '\n[00:03.00]' + chorus + '\n'),
    ]);
    const port = await availablePort();
    const upstreamOrigin = 'http://127.0.0.1:' + port;
    navidrome = spawn(resolve(navidromeBin), [], { cwd: root, env: {
      PATH: process.env.PATH, ND_ADDRESS: '127.0.0.1', ND_PORT: String(port), ND_MUSICFOLDER: join(root, 'music'),
      ND_DATAFOLDER: join(root, 'db'), ND_FFMPEGPATH: resolve(ffmpegBin), ND_DEVAUTOCREATEADMINPASSWORD: password,
      ND_ENABLEINSIGHTSCOLLECTOR: 'false', ND_ENABLEEXTERNALSERVICES: 'false', ND_LOGLEVEL: 'error',
    }, stdio: 'ignore' });
    let startupError;
    navidrome.once('error', error => { startupError = error.code; });
    const salt = randomBytes(16).toString('hex');
    const token = createHash('md5').update(password + salt).digest('hex');
    async function upstream(action, params) {
      const query = new URLSearchParams({ u: 'admin', t: token, s: salt, v: '1.16.1', c: 'GrooveboxTest', f: 'json', ...params });
      const response = await fetch(upstreamOrigin + '/rest/' + action + '.view?' + query, { signal: AbortSignal.timeout(1500) });
      return (await response.json())['subsonic-response'];
    }
    let songId;
    await expect.poll(async () => {
      if (startupError || navidrome.exitCode !== null) return 'Navidrome stopped indexing';
      try {
        const result = await upstream('search3', { query: title, songCount: 1 });
        songId = result.searchResult3?.song?.find(song => song.title === title)?.id;
        return Boolean(songId);
      } catch { return false; }
    }, { timeout: 14_000 }).toBe(true);
    expect((await upstream('createPlaylist', { name: playlistName, songId })).status).toBe('ok');
    const playCount = async () => (await upstream('getSong', { id: songId })).song.playCount ?? 0;
    expect(await playCount()).toBe(0);

    app = await runningPlayer(data);
    const origin = app.url;
    const context = page.context();
    await page.addInitScript(() => {
      const key = 'groovebox.state.v1';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: {
        language: 'en', demos: false, artistImageEngine: false, onlineCover: false, reportServerPlayback: true,
      } }));
    });
    await page.goto(origin + '/#sources');
    await page.getByRole('button', { name: /Add Media Server/ }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Protocol').selectOption('navidrome');
    await dialog.getByLabel('Name', { exact: true }).fill(sourceName);
    await dialog.getByLabel('Server URL').fill(upstreamOrigin);
    await dialog.getByLabel('Username').fill('admin');
    await dialog.getByLabel('Password').fill(password);
    const connect = page.waitForResponse(response => response.url() === origin + '/api/sources' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Connect', exact: true }).press('Enter');
    const connected = await connect;
    expect(connected.status()).toBe(201);
    const { source } = await connected.json();
    const sourceCookie = async () => (await context.cookies()).find(cookie => cookie.name === 'groovebox_sources');
    const cookie = await sourceCookie();
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/sources' });
    const base = origin + '/api/sources/' + source.id;
    const list = async path => {
      const response = await context.request.get(base + '/list?' + new URLSearchParams({ path }));
      expect(response.status()).toBe(200);
      return (await response.json()).items;
    };
    const [artistFolder] = await list('/');
    const [albumFolder] = await list(artistFolder.path);
    const [track] = await list(albumFolder.path);
    expect([artistFolder.name, albumFolder.name, track.title]).toEqual([artist, album, title]);
    const [serverPlaylist] = await list('playlists');
    expect(serverPlaylist.name).toBe(playlistName);
    const oldCover = await context.request.get(origin + track.cover);
    expect(oldCover.ok()).toBe(true);
    const coverHash = sha(await oldCover.body());

    const content = page.locator('#content');
    await content.getByRole('button', { name: artist, exact: true }).press('Enter');
    await content.getByRole('button', { name: album, exact: true }).press('Enter');
    await content.getByRole('button', { name: 'Scan and Add to Library', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toHaveText('Scan complete. Found 1 song.');
    await page.locator('#sidebar [data-nav=songs]').press('Enter');
    const song = content.getByRole('button', { name: title + ' ' + artist, exact: true });
    await expect(song).toBeVisible();

    await stop(app.child);
    app = await runningPlayer(data, Number(new URL(origin).port));
    expect(app.url).toBe(origin);
    const listings = [];
    const reconnects = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/sources/' + source.id + '/list') listings.push(url.search);
      if (url.pathname === '/api/sources' && request.method() === 'POST') reconnects.push(true);
    });
    await page.reload();
    const registry = await context.request.get(origin + '/api/sources');
    expect((await registry.json()).sources).toEqual([source]);
    expect((await sourceCookie()).value === cookie.value).toBe(true);
    const original = await readFile(recording);
    const full = await context.request.get(origin + track.streamUrl);
    expect(full.status()).toBe(200);
    expect(sha(await full.body())).toBe(sha(original));
    const range = await context.request.get(origin + track.streamUrl, { headers: { Range: 'bytes=64-255' } });
    expect(range.status()).toBe(206);
    expect(range.headers()['content-range']).toBe('bytes 64-255/' + original.length);
    expect(await range.body()).toEqual(original.subarray(64, 256));
    const replayedCover = await context.request.get(origin + track.cover);
    expect(replayedCover.ok()).toBe(true);
    expect(sha(await replayedCover.body())).toBe(coverHash);
    const lyrics = await context.request.get(origin + track.lyricsUrl);
    expect(lyrics.status()).toBe(200);
    expect((await lyrics.json()).lines).toEqual([{ time: 0, text: introduction }, { time: 3, text: chorus }]);

    await song.press('Enter');
    const player = page.locator('#audio');
    await expect.poll(() => player.evaluate(element => element.paused ? 0 : element.currentTime)).toBeGreaterThan(0.1);
    await expect(page.locator('#player-title')).toHaveText(title);
    await expect.poll(() => player.evaluate(element => element.currentSrc)).toBe(origin + track.streamUrl);
    await page.locator('#now').getByRole('button', { name: 'Lyrics', exact: true }).press('Enter');
    await expect(page.locator('#now').getByRole('button', { name: chorus, exact: true })).toBeVisible();
    const scrobbled = page.waitForResponse(response => response.request().method() === 'POST' &&
      response.url() === origin + track.streamUrl.replace('/stream?', '/played?'));
    await player.evaluate(element => { element.currentTime = 10; element.playbackRate = 4; });
    expect((await scrobbled).status()).toBe(200);
    await expect.poll(playCount).toBe(1);
    expect(listings).toEqual([]);
    expect(reconnects).toEqual([]);
    expect(await list(albumFolder.path)).toEqual([track]);
    expect((await list(serverPlaylist.path)).map(item => item.streamUrl)).toEqual([track.streamUrl]);
  } finally {
    await Promise.all([stop(app?.child), stop(navidrome)]);
    await rm(root, { recursive: true, force: true });
  }
});
