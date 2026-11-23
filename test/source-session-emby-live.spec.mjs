import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const image = process.env.EMBY_TEST_IMAGE;
const ffmpeg = process.env.FFMPEG_TEST_BIN;
const user = 'fixture-restart';
const library = 'Restart Emby Library';
const artist = 'Restart Emby Artist';
const album = 'Restart Emby Album';
const title = 'Restart Emby Track';
const sourceName = 'Restart Emby Server';
const playlistName = 'Empty restart audio playlist';
const lyrics = '[00:01.00]Emby first line\n[00:03.00]Emby second line\n';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function docker(args) { return exec('docker', args, { timeout: 18_000 }); }

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function runningPlayer(data, port = 0) {
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: project,
    env: { HOST: '127.0.0.1', PORT: String(port), GROOVEBOX_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => {
        output = (output + chunk).slice(-1024);
        const found = /^Groovebox: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output)?.[1];
        if (found) resolve(found);
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Player exited during startup (' + code + ')')));
    });
    return { child, url };
  } catch (error) { await stop(child); throw error; }
}

function nativeEmby(origin, path, { method = 'GET', token, body, contentType = 'application/json' } = {}) {
  return fetch(origin + '/emby' + path, {
    method, headers: {
      Authorization: 'Emby Client="Restart Fixture", Device="Node", DeviceId="RestartFixture", Version="1.0.0"',
      ...(token && { 'X-Emby-Token': token }), ...(body && { 'Content-Type': contentType }),
    }, body: body && (contentType === 'application/json' ? JSON.stringify(body) : body),
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
}

async function setupEmby(origin, password, artwork) {
  await expect.poll(async () => {
    try {
      const response = await nativeEmby(origin, '/System/Info/Public');
      return response.ok && (await response.json()).StartupWizardCompleted !== true;
    } catch { return false; }
  }, { timeout: 25_000 }).toBe(true);
  expect((await nativeEmby(origin, '/Startup/User')).status).toBe(200);
  expect((await nativeEmby(origin, '/Startup/User', { method: 'POST', body: { Name: user, Password: password } })).ok).toBe(true);
  expect((await nativeEmby(origin, '/Startup/RemoteAccess', { method: 'POST',
    body: { EnableRemoteAccess: false, EnableAutomaticPortMapping: false } })).ok).toBe(true);
  expect((await nativeEmby(origin, '/Startup/Complete', { method: 'POST' })).ok).toBe(true);
  const login = await nativeEmby(origin, '/Users/AuthenticateByName', { method: 'POST', body: { Username: user, Pw: password } });
  expect(login.status).toBe(200);
  const { AccessToken: token, User: { Id: userId } } = await login.json();
  expect((await nativeEmby(origin, '/Library/VirtualFolders', { method: 'POST', token,
    body: { Name: library, CollectionType: 'music', Paths: ['/music'], RefreshLibrary: false,
      LibraryOptions: { EnableRealtimeMonitor: false, EnableEmbeddedTitles: true } } })).ok).toBe(true);
  expect((await nativeEmby(origin, '/Library/Refresh', { method: 'POST', token })).ok).toBe(true);
  let track;
  await expect.poll(async () => {
    const response = await nativeEmby(origin, '/Users/' + encodeURIComponent(userId) + '/Items?' + new URLSearchParams({
      IncludeItemTypes: 'Audio', Recursive: 'true', Fields: 'MediaSources',
    }), { token });
    track = response.ok && (await response.json()).Items.find(item => item.Name === title && item.Album === album);
    return Boolean(track?.AlbumId);
  }, { timeout: 35_000 }).toBe(true);
  expect((await nativeEmby(origin, '/Items/' + encodeURIComponent(track.AlbumId) + '/Images/Primary', {
    method: 'POST', token, contentType: 'image/jpeg', body: artwork.toString('base64'),
  })).ok).toBe(true);
  return { token, userId, itemId: track.Id };
}

test('real Emby restores playback leases, authenticated media and empty audio playlists across player restart', async ({ page }) => {
  test.skip(!image || !ffmpeg, 'Provide a local official EMBY_TEST_IMAGE and FFMPEG_TEST_BIN.');
  test.setTimeout(100_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'groovebox-emby-restart-')));
  const music = join(root, 'music');
  const albumDirectory = join(music, artist, album);
  const config = join(root, 'config');
  const data = join(root, 'player');
  const recording = join(albumDirectory, 'Recording.flac');
  const container = 'groovebox-emby-restart-' + randomUUID();
  const password = randomBytes(24).toString('hex');
  let app;
  let launchAttempted = false;
  try {
    await Promise.all([mkdir(config), mkdir(albumDirectory, { recursive: true })]);
    await Promise.all([
      exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15',
        '-metadata', 'artist=' + artist, '-metadata', 'album_artist=' + artist, '-metadata', 'album=' + album,
        '-metadata', 'title=' + title, '-metadata', 'lyrics=' + lyrics, '-c:a', 'flac', recording], { timeout: 10_000 }),
      writeFile(join(albumDirectory, 'Recording.lrc'), lyrics),
    ]);
    launchAttempted = true;
    await docker(['run', '--detach', '--rm', '--pull=never', '--name', container, '--publish', '127.0.0.1::8096/tcp',
      '--security-opt', 'no-new-privileges', '--mount', 'type=bind,source=' + config + ',target=/config',
      '--mount', 'type=bind,source=' + music + ',target=/music', image]);
    const { stdout } = await docker(['port', container, '8096/tcp']);
    const emby = 'http://' + stdout.trim();
    expect(emby).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const upstream = await setupEmby(emby, password, await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url)));
    const native = async path => {
      const response = await nativeEmby(emby, path, { token: upstream.token });
      expect(response.status).toBe(200);
      return response.json();
    };
    const dashboard = async () => (await native('/Sessions')).find(session => session.Client === 'Groovebox');
    const playCount = async () => (await native('/Users/' + upstream.userId + '/Items/' + upstream.itemId)).UserData?.PlayCount ?? 0;
    const initialPlays = await playCount();

    app = await runningPlayer(data);
    const origin = app.url;
    const context = page.context();
    await page.addInitScript(() => {
      const key = 'groovebox.state.v1';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: {
        language: 'en', demos: false, artistImageEngine: false, onlineCover: false, reportEmbyPlayback: true,
      } }));
    });
    await page.goto(origin + '/#sources');
    await page.getByRole('button', { name: /Add Media Server/ }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Protocol').selectOption('emby');
    await dialog.getByLabel('Name', { exact: true }).fill(sourceName);
    await dialog.getByLabel('Server URL').fill(emby);
    await dialog.getByLabel('Username').fill(user);
    await dialog.getByLabel('Password').fill(password);
    const connected = page.waitForResponse(response => response.url() === origin + '/api/sources' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Connect', exact: true }).press('Enter');
    const result = await connected;
    expect(result.status()).toBe(201);
    const { source } = await result.json();
    const sourceCookie = async () => (await context.cookies()).find(cookie => cookie.name === 'groovebox_sources');
    const cookie = await sourceCookie();
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/sources' });
    const base = origin + '/api/sources/' + source.id;
    const list = async path => {
      const response = await context.request.get(base + '/list?' + new URLSearchParams({ path }));
      expect(response.status()).toBe(200);
      return response.json();
    };
    const mutatePlaylist = (path, data) => context.request.post(base + '/playlist?' + new URLSearchParams({ path }), {
      headers: { Origin: origin }, data,
    });
    const locateFolder = async (path, name) => {
      const folder = (await list(path)).items.find(item => item.folder && item.name === name);
      expect(folder).toBeTruthy();
      return folder;
    };
    const libraryFolder = await locateFolder('/', library);
    const artistFolder = await locateFolder(libraryFolder.path, artist);
    const albumFolder = await locateFolder(artistFolder.path, album);
    const [track] = (await list(albumFolder.path)).items;
    expect(track.title).toBe(title);
    const initialCover = await context.request.get(origin + track.cover);
    expect(initialCover.status()).toBe(200);
    const coverHash = sha(await initialCover.body());
    const create = await mutatePlaylist('playlists', { action: 'create', name: playlistName });
    expect(create.status()).toBe(201);
    const { playlist } = await create.json();
    expect(await list(playlist.path)).toMatchObject({ items: [], serverOrder: true });

    const content = page.locator('#content');
    for (const name of [library, artist, album]) await content.getByRole('button', { name, exact: true }).press('Enter');
    await content.getByRole('button', { name: 'Scan and Add to Library', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toHaveText('Scan complete. Found 1 song.');
    await page.locator('#sidebar [data-nav=songs]').press('Enter');
    const song = content.getByRole('button', { name: title + ' ' + artist, exact: true });
    const player = page.locator('#audio');
    const toggle = page.locator('#player-toggle');
    const reportEndpoint = origin + track.streamUrl.replace('/stream?', '/playback?');
    const waitForReport = (event, reason) => page.waitForResponse(response => {
      if (response.url() !== reportEndpoint || response.request().method() !== 'POST') return false;
      const payload = response.request().postDataJSON();
      return payload.event === event && payload.reason === reason;
    });
    const start = waitForReport('start');
    await song.press('Enter');
    const started = await start;
    expect(started.status()).toBe(200);
    const { playSessionId } = started.request().postDataJSON();
    await expect.poll(() => player.evaluate(element => element.paused ? 0 : element.currentTime)).toBeGreaterThan(0.1);
    await expect.poll(async () => (await dashboard())?.NowPlayingItem?.Id).toBe(upstream.itemId);
    const pause = waitForReport('progress', 'Pause');
    await toggle.press('Enter');
    expect((await pause).status()).toBe(200);

    await stop(app.child);
    app = await runningPlayer(data, Number(new URL(origin).port));
    expect(app.url).toBe(origin);
    const lists = [];
    const reconnects = [];
    const reports = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/sources/' + source.id + '/list') lists.push(url.search);
      if (url.pathname === '/api/sources' && request.method() === 'POST') reconnects.push(true);
      if (request.url() === reportEndpoint && request.method() === 'POST') reports.push(request.postDataJSON());
    });
    const registry = await context.request.get(origin + '/api/sources');
    expect(registry.status()).toBe(200);
    expect((await registry.json()).sources).toEqual([source]);
    expect((await sourceCookie()).value === cookie.value).toBe(true);
    const bytes = await readFile(recording);
    const full = await context.request.get(origin + track.streamUrl);
    expect(full.status()).toBe(200);
    expect(sha(await full.body())).toBe(sha(bytes));
    const range = await context.request.get(origin + track.streamUrl, { headers: { Range: 'bytes=64-255' } });
    expect(range.status()).toBe(206);
    expect(range.headers()['content-range']).toBe('bytes 64-255/' + bytes.length);
    expect(await range.body()).toEqual(bytes.subarray(64, 256));
    const cover = await context.request.get(origin + track.cover);
    expect(cover.status()).toBe(200);
    expect(sha(await cover.body())).toBe(coverHash);
    const lyric = await context.request.get(origin + track.lyricsUrl);
    expect(lyric.status()).toBe(200);
    expect(await lyric.json()).toEqual({ lines: [{ time: 1, text: 'Emby first line' }, { time: 3, text: 'Emby second line' }] });

    const seek = waitForReport('progress', 'TimeUpdate');
    await page.locator('#seek').evaluate(element => {
      element.value = '500';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const seekResponse = await seek;
    expect(seekResponse.status()).toBe(200);
    const progress = seekResponse.request().postDataJSON();
    expect(progress.playSessionId).toBe(playSessionId);
    expect(progress.positionSeconds).toBeCloseTo(7.5, 1);
    await expect.poll(async () => (await dashboard())?.PlayState?.PositionTicks).toBe(Math.round(progress.positionSeconds * 10_000_000));
    const resume = waitForReport('progress', 'Unpause');
    await toggle.press('Enter');
    expect((await resume).status()).toBe(200);
    await expect.poll(async () => (await dashboard())?.PlayState?.IsPaused).toBe(false);
    await expect.poll(() => player.evaluate(element => element.paused ? 0 : element.currentTime)).toBeGreaterThan(7.5);
    await expect.poll(() => player.evaluate(element => element.currentSrc)).toBe(origin + track.streamUrl);
    const ended = waitForReport('stop');
    await player.evaluate(element => { element.playbackRate = 4; });
    expect((await ended).status()).toBe(200);
    expect(reports.every(report => report.playSessionId === playSessionId && report.event !== 'start')).toBe(true);
    expect(reports.filter(report => report.event === 'stop')).toHaveLength(1);
    expect(reports.at(-1)?.event).toBe('stop');
    await expect.poll(async () => (await dashboard())?.NowPlayingItem?.Id).toBeUndefined();
    await expect.poll(playCount).toBe(initialPlays + 1);
    expect(lists).toEqual([]);
    expect(reconnects).toEqual([]);

    expect((await list(albumFolder.path)).items).toEqual([track]);
    expect((await list('playlists')).items.find(item => item.name === playlistName)?.path).toBe(playlist.path);
    expect(await list(playlist.path)).toMatchObject({ items: [], serverOrder: true });
    expect((await mutatePlaylist(playlist.path, { action: 'add', trackId: track.id })).status()).toBe(200);
    expect((await list(playlist.path)).items.map(item => item.title)).toEqual([title]);
    const upstreamPlaylists = await native('/Users/' + upstream.userId + '/Items?' + new URLSearchParams({ IncludeItemTypes: 'Playlist', Recursive: 'true' }));
    const saved = upstreamPlaylists.Items.find(item => item.Name === playlistName);
    const entries = await native('/Playlists/' + encodeURIComponent(saved.Id) + '/Items?' + new URLSearchParams({ UserId: upstream.userId }));
    expect(entries.Items.map(item => item.Id)).toEqual([upstream.itemId]);
  } finally {
    await stop(app?.child);
    if (launchAttempted) await docker(['rm', '-f', container]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
