import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const jellyfinBin = process.env.JELLYFIN_TEST_BIN;
const ffmpegBin = process.env.FFMPEG_TEST_BIN;
const project = fileURLToPath(new URL('../', import.meta.url));
const title = 'Actual Jellyfin Restart Track';
const artist = 'Actual Restart Ensemble';
const album = 'Actual Restart Album';
const sourceName = 'Actual restart API key source';
const listName = 'Actual private restart playlist';
const exec = promisify(execFile);

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function launchApp(directory, port = 0) {
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: project,
    env: { HOST: '127.0.0.1', PORT: String(port), GROOVEBOX_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const address = await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        const url = /^Groovebox: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output)?.[1];
        if (url) resolve(url);
      });
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Fixture app exited (' + code + ')\n' + errors)));
    });
    return { url: address, port: Number(new URL(address).port), close: () => stop(child) };
  } catch (error) { await stop(child); throw error; }
}

function nativeApi(origin) {
  return (path, { method = 'GET', token, body } = {}) => fetch(origin + path, {
    method,
    headers: { Authorization: 'MediaBrowser Client="Restart Fixture", Device="Node", DeviceId="RestartFixture", Version="1.0.0"' +
        (token ? ', Token="' + token + '"' : ''), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(7000),
  });
}

async function configureNative(api, music) {
  const username = 'restart-fixture-admin';
  const password = randomBytes(24).toString('hex');
  await expect.poll(async () => {
    try {
      const response = await api('/System/Info/Public');
      return response.ok && (await response.json()).StartupWizardCompleted === false;
    } catch { return false; }
  }, { timeout: 35_000 }).toBe(true);
  expect((await api('/Startup/User')).status).toBe(200);
  expect((await api('/Startup/User', { method: 'POST', body: { Name: username, Password: password } })).status).toBe(204);
  expect((await api('/Startup/Complete', { method: 'POST' })).status).toBe(204);
  const auth = await api('/Users/AuthenticateByName', { method: 'POST', body: { Username: username, Pw: password } });
  expect(auth.status).toBe(200);
  const { AccessToken: token, User: { Id: userId } } = await auth.json();
  const folder = await api('/Library/VirtualFolders?' + new URLSearchParams({
    name: 'Actual Restart Library', collectionType: 'music', paths: music,
  }), { method: 'POST', token, body: { LibraryOptions: { EnableRealtimeMonitor: false, EnableInternetProviders: false } } });
  expect(folder.status).toBe(204);
  expect((await api('/Library/Refresh', { method: 'POST', token })).status).toBe(204);
  const query = new URLSearchParams({ UserId: userId, IncludeItemTypes: 'Audio', Recursive: 'true' });
  await expect.poll(async () => {
    const response = await api('/Items?' + query, { token });
    return response.ok ? (await response.json()).Items.map(item => item.Name) : 'Jellyfin HTTP ' + response.status;
  }, { timeout: 35_000 }).toEqual([title]);

  const appName = 'Actual Groovebox restart key';
  const generated = await api('/Auth/Keys?' + new URLSearchParams({ app: appName }), { method: 'POST', token });
  expect([200, 204]).toContain(generated.status);
  const key = generated.status === 200 ? (await generated.json()).AccessToken :
    (await (await api('/Auth/Keys', { token })).json()).Items.find(item => item.AppName === appName).AccessToken;
  expect(typeof key).toBe('string');
  return { userId, token, key };
}

test('keeps an actual Jellyfin API key and empty private playlist usable immediately after Groovebox restarts', async ({ page }) => {
  test.skip(!jellyfinBin || !ffmpegBin, 'Requires JELLYFIN_TEST_BIN and FFMPEG_TEST_BIN with ffprobe');
  test.setTimeout(110_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'groovebox-live-jellyfin-restart-')));
  const data = join(root, 'groovebox');
  const config = join(root, 'config');
  const cache = join(root, 'cache');
  const music = join(root, 'music');
  const file = join(music, artist, album, 'Recording.flac');
  let jellyfin, app;
  try {
    await Promise.all([mkdir(data), mkdir(config), mkdir(cache), mkdir(dirname(file), { recursive: true })]);
    await exec(ffmpegBin, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-metadata', 'title=' + title, '-metadata', 'artist=' + artist, '-metadata', 'album=' + album,
      '-metadata', 'album_artist=' + artist, '-metadata', 'track=1', '-c:a', 'flac', file], { timeout: 10_000 });
    const bytes = await readFile(file);
    const port = await availablePort();
    await writeFile(join(config, 'network.xml'), `<NetworkConfiguration>
      <InternalHttpPort>${port}</InternalHttpPort>
      <LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses>
      <AutoDiscovery>false</AutoDiscovery><EnableIPv6>false</EnableIPv6><EnableRemoteAccess>false</EnableRemoteAccess>
    </NetworkConfiguration>`);
    jellyfin = spawn(resolve(jellyfinBin), ['--datadir', join(root, 'jellyfin-data'), '--configdir', config, '--cachedir', cache,
      '--logdir', join(root, 'logs'), '--ffmpeg', resolve(ffmpegBin), '--nowebclient', '--nonetchange'], {
      cwd: root, env: {
        ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }),
        PATH: dirname(resolve(ffmpegBin)) + delimiter + process.env.PATH,
        XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: root,
      }, stdio: 'ignore',
    });
    jellyfin.on('error', () => {});
    const native = 'http://127.0.0.1:' + port;
    const api = nativeApi(native);
    const { token, userId, key } = await configureNative(api, music);

    app = await launchApp(data);
    const appPort = app.port;
    const origin = app.url;
    await page.goto(origin + '/#sources');
    const connected = await page.request.post(origin + '/api/sources', {
      headers: { Origin: origin }, data: { type: 'jellyfin', url: native, name: sourceName, token: key, userId },
    });
    expect(connected.status()).toBe(201);
    const { source } = await connected.json();
    expect(source).toMatchObject({ type: 'jellyfin', name: sourceName, playlistWritable: true, playlistAuthority: 'api-key' });
    expect(JSON.stringify(source).includes(key)).toBe(false);
    const sourceBase = origin + '/api/sources/' + source.id;
    const browse = async path => {
      const response = await page.request.get(sourceBase + '/list?' + new URLSearchParams({ path }));
      expect(response.status()).toBe(200);
      return (await response.json()).items;
    };
    const mutation = (path, data) => page.request.post(sourceBase + '/playlist?' + new URLSearchParams({ path }), {
      headers: { Origin: origin }, data,
    });
    let track;
    const pending = ['/'];
    const seen = new Set();
    while (!track && pending.length && seen.size < 10) {
      const path = pending.shift();
      if (seen.has(path)) continue;
      seen.add(path);
      const items = await browse(path);
      track = items.find(item => !item.folder && (item.title === title || item.name === title));
      pending.push(...items.filter(item => item.folder && item.path !== 'playlists').map(item => item.path));
    }
    expect(track).toMatchObject({ id: expect.any(String), streamUrl: expect.stringMatching(/\/stream\?id=/) });

    const created = await mutation('playlists', { action: 'create', name: listName });
    expect(created.status()).toBe(201);
    const { playlist } = await created.json();
    expect(await browse(playlist.path)).toEqual([]);
    const nativeLists = await api('/Items?' + new URLSearchParams({ UserId: userId, IncludeItemTypes: 'Playlist', Recursive: 'true' }), { token });
    expect(nativeLists.status).toBe(200);
    const nativeList = (await nativeLists.json()).Items.find(item => item.Name === listName);
    expect(nativeList).toBeTruthy();
    const privacy = await api('/Playlists/' + nativeList.Id, { token });
    expect((await privacy.json()).OpenAccess).toBe(false);
    await app.close();
    app = await launchApp(data, appPort);

    const restored = await page.request.get(origin + '/api/sources');
    expect(restored.status()).toBe(200);
    expect((await restored.json()).sources).toEqual([source]);
    const original = await page.request.get(origin + track.streamUrl, { headers: { Range: 'bytes=0-255' } });
    expect(original.status()).toBe(206);
    expect(await original.body()).toEqual(bytes.subarray(0, 256));

    // The empty playlist path and song ID predate the restart. No listing has rebuilt them.
    const added = await mutation(playlist.path, { action: 'add', trackId: track.id });
    expect(added.status()).toBe(200);
    const nativeItems = async () => {
      const response = await api('/Playlists/' + nativeList.Id + '/Items?' + new URLSearchParams({ UserId: userId }), { token });
      expect(response.status).toBe(200);
      return (await response.json()).Items.map(item => item.Name);
    };
    expect(await nativeItems()).toEqual([title]);
    const tracks = await browse(playlist.path);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].playlistEntry).toMatch(/^[\w-]{24}$/);
    const removed = await mutation(playlist.path, { action: 'remove', entryId: tracks[0].playlistEntry });
    expect(removed.status()).toBe(200);
    expect(await nativeItems()).toEqual([]);
    const protectedFiles = await readdir(join(data, 'source-sessions'));
    expect(protectedFiles).toHaveLength(1);
    expect((await readFile(join(data, 'source-sessions', protectedFiles[0]))).includes(Buffer.from(key))).toBe(false);
    expect(await page.evaluate(secret => JSON.stringify(Object.entries(localStorage)).includes(secret), key)).toBe(false);
  } finally {
    await app?.close();
    await stop(jellyfin);
    await rm(root, { recursive: true, force: true });
  }
});
