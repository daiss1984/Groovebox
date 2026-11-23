import { expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const image = process.env.KODI_TEST_IMAGE;
const ffmpeg = process.env.FFMPEG_TEST_BIN;
const project = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const username = 'groovebox-restart-fixture';
const title = 'Kodi Restart Recording';
const artist = 'Kodi Restart Artist';
const album = 'Kodi Restart Album';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function docker(...args) {
  return exec('docker', args, { timeout: 15_000 });
}

async function launchApp(directory, port = 0) {
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: project,
    env: { HOST: '127.0.0.1', PORT: String(port), GROOVEBOX_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'] });
  async function close() {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      child.stderr.resume();
      child.stdout.on('data', chunk => {
        output += chunk;
        const url = /^Groovebox: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output)?.[1];
        if (url) resolve(url);
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Isolated Groovebox exited (' + code + ')')));
    });
    return { origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function startKodi(directory, password, name) {
  const home = join(directory, 'profile');
  const userdata = join(home, '.kodi', 'userdata');
  const music = join(directory, 'music');
  const collection = join(music, artist, album);
  await Promise.all([mkdir(userdata, { recursive: true }), mkdir(collection, { recursive: true })]);
  const cover = join(collection, 'folder.jpg');
  const file = join(collection, '重启录音.flac');
  await Promise.all([
    writeFile(join(userdata, 'advancedsettings.xml'), `<advancedsettings><services>
      <webserver>true</webserver><webserverport>8080</webserverport><webserverauthentication>true</webserverauthentication>
      <webserverusername>${username}</webserverusername><webserverpassword>${password}</webserverpassword>
      <esallinterfaces>false</esallinterfaces><zeroconf>false</zeroconf>
      </services><musiclibrary><downloadinfo>false</downloadinfo></musiclibrary></advancedsettings>`, { mode: 0o600 }),
    writeFile(join(userdata, 'sources.xml'), `<sources><music><source><name>Restart Fixture</name>
      <path pathversion="1">/music/</path><allowsharing>true</allowsharing></source></music></sources>`),
    exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=180x180:d=1', '-frames:v', '1', cover], { timeout: 10_000 }),
  ]);
  await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-i', cover, '-map', '0:a:0', '-map', '1:v:0', '-metadata', 'artist=' + artist,
    '-metadata', 'album_artist=' + artist, '-metadata', 'album=' + album, '-metadata', 'title=' + title,
    '-metadata:s:v:0', 'comment=Cover (front)', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', file],
  { timeout: 10_000 });
  await docker('run', '--detach', '--rm', '--pull=never', '--name', name, '--publish', '127.0.0.1::8080/tcp',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--env', 'HOME=/fixture-home',
    '--mount', 'type=bind,source=' + home + ',target=/fixture-home',
    '--mount', 'type=bind,source=' + music + ',target=/music,readonly', image);
  const { stdout } = await docker('port', name, '8080/tcp');
  const origin = 'http://' + stdout.trim();
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  const rpc = async (method, params, authenticated = true) => {
    const response = await fetch(origin + '/jsonrpc', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      headers: { 'Content-Type': 'application/json', ...(authenticated && { Authorization: auth }) },
      signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    return { status: response.status, result: response.ok ? (await response.json()).result : undefined };
  };
  await expect.poll(async () => {
    try { return (await rpc('JSONRPC.Ping')).result; } catch { return undefined; }
  }, { timeout: 26_000 }).toBe('pong');
  expect((await rpc('JSONRPC.Ping', undefined, false)).status).toBe(401);
  expect((await rpc('AudioLibrary.Scan', { directory: '/music/', showdialogs: false })).result).toBe('OK');
  const songs = async () => (await rpc('AudioLibrary.GetSongs', { properties: ['title', 'file', 'thumbnail'] })).result?.songs || [];
  await expect.poll(async () => (await songs()).map(song => song.title), { timeout: 20_000 }).toEqual([title]);
  const [song] = await songs();
  expect(song.file).toContain('重启录音.flac');
  expect(song.thumbnail).toMatch(/^image:\/\//);
  const art = await fetch(origin + '/image/' + encodeURIComponent(song.thumbnail), {
    headers: { Accept: 'image/*', Authorization: auth }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  expect(art.status).toBe(200);
  return { origin, audio: await readFile(file), cover: Buffer.from(await art.arrayBuffer()) };
}

test('restores an actual authenticated Kodi source and its original media links after Groovebox restarts', async ({ page, browser }) => {
  test.skip(!image || !ffmpeg, 'Requires local KODI_TEST_IMAGE and FFMPEG_TEST_BIN');
  test.setTimeout(90_000);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'groovebox-kodi-restart-')));
  const name = 'groovebox-kodi-restart-' + randomUUID();
  const password = randomBytes(20).toString('hex');
  let app, outsider;
  try {
    const native = await startKodi(temporary, password, name);
    const data = join(temporary, 'groovebox');
    app = await launchApp(data);
    const { origin } = app;
    const connect = await page.request.post(origin + '/api/sources', {
      headers: { Origin: origin }, data: { type: 'kodi', name: 'Kodi Restart Source', url: native.origin, username, password },
    });
    expect(connect.status()).toBe(201);
    expect((await connect.text()).includes(password)).toBe(false);
    const { source } = await connect.json();
    const base = origin + '/api/sources/' + source.id;
    async function list(path) {
      const response = await page.request.get(base + '/list?' + new URLSearchParams({ path }));
      expect(response.status()).toBe(200);
      return (await response.json()).items;
    }
    const folder = (await list('/')).find(item => item.name === album);
    expect(folder?.path).toBeTruthy();
    const track = (await list(folder.path)).find(item => item.title === title);
    expect(track).toMatchObject({ name: title, artist, album });
    const stream = new URL(track.streamUrl, origin).href;
    const artwork = new URL(track.cover, origin).href;
    expect(stream).toMatch(/\/stream\?id=[\w-]+$/);
    expect(artwork).toMatch(/\/cover\?id=[\w-]+$/);
    await app.close();
    app = await launchApp(data, Number(new URL(origin).port));

    // Media requests are deliberately the first requests to the replacement app.
    const range = await page.request.get(stream, { headers: { Range: 'bytes=7-59' } });
    expect(range.status()).toBe(206);
    expect(range.headers()['content-range']).toBe('bytes 7-59/' + native.audio.length);
    expect(await range.body()).toEqual(native.audio.subarray(7, 60));
    const whole = await page.request.get(stream);
    expect(whole.status()).toBe(200);
    expect(digest(await whole.body())).toBe(digest(native.audio));
    const decoded = await page.request.get(artwork);
    expect(decoded.status()).toBe(200);
    expect(decoded.headers()['content-type']).toBe('image/jpeg');
    expect(digest(await decoded.body())).toBe(digest(native.cover));

    outsider = await browser.newContext();
    expect((await outsider.request.get(stream)).status()).toBe(404);
    expect((await outsider.request.get(artwork)).status()).toBe(404);
    expect(await (await outsider.request.get(origin + '/api/sources')).json()).toEqual({ sources: [] });

    await page.goto(origin + '/#source/' + source.id);
    await page.getByRole('button', { name: album, exact: true }).press('Enter');
    const button = page.locator('#content').getByRole('button', { name: new RegExp(title + ' ' + artist) });
    await button.press('Enter');
    await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.15);
    await expect.poll(() => button.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  } finally {
    await outsider?.close();
    await app?.close();
    await docker('rm', '-f', name).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});

const nativeFixtures = [{
  type: 'subsonic',
  label: 'classic Subsonic',
  fixture: 'SUBSONIC',
  username: 'admin',
  password: 'admin',
  folders: ['Fixture Artist', 'Fixture Album'],
  title: 'Fixture Track',
}, {
  type: 'songloft',
  label: 'Songloft',
  fixture: 'SONGLOFT',
  username: 'fixture-singer',
  password: 'fixture-dav-password',
  folders: [],
  title: 'Fixture Songloft Track',
  lyric: 'Songloft fixture intro',
}];

for (const fixture of nativeFixtures) {
  test('restores actual ' + fixture.label + ' links without relisting after a Groovebox restart', async ({ page, browser }) => {
    const root = process.env['GROOVEBOX_' + fixture.fixture + '_TEST_URL'];
    const file = process.env['GROOVEBOX_' + fixture.fixture + '_TEST_AUDIO'];
    test.skip(!root || !file, 'Requires isolated native ' + fixture.label + ' fixture URL and original audio');
    expect(new URL(root).hostname).toBe('127.0.0.1');
    const audio = await readFile(file);
    const data = await mkdtemp(join(tmpdir(), 'groovebox-' + fixture.type + '-restart-'));
    let app, outsider;
    try {
      app = await launchApp(data);
      const { origin } = app;
      const connection = await page.request.post(origin + '/api/sources', {
        headers: { Origin: origin },
        data: { type: fixture.type, name: fixture.label + ' Restart Fixture', url: root, username: fixture.username, password: fixture.password },
      });
      expect(connection.status()).toBe(201);
      const { source } = await connection.json();
      const base = origin + '/api/sources/' + source.id;
      async function list(path) {
        const response = await page.request.get(base + '/list?' + new URLSearchParams({ path }));
        expect(response.status()).toBe(200);
        return (await response.json()).items;
      }
      let items = await list('/');
      for (const name of fixture.folders) {
        const folder = items.find(item => item.folder && item.name === name);
        expect(folder?.path).toBeTruthy();
        items = await list(folder.path);
      }
      const track = items.find(item => item.title === fixture.title);
      expect(track?.streamUrl).toMatch(/\/stream\?id=[\w-]+$/);
      expect(track.cover).toMatch(/\/cover\?id=[\w-]+$/);
      const stream = origin + track.streamUrl;
      const art = origin + track.cover;
      const previousArt = await page.request.get(art);
      expect(previousArt.status()).toBe(200);
      expect(previousArt.headers()['content-type']).toMatch(/^image\/(jpeg|png)$/);
      const previousCoverHash = digest(await previousArt.body());
      if (fixture.lyric) expect(track.lyricsUrl).toMatch(/\/stream\?id=[\w-]+-lyrics$/);
      else expect(track.lyricsUrl).toBeUndefined();

      await app.close();
      app = await launchApp(data, Number(new URL(origin).port));

      const range = await page.request.get(stream, { headers: { Range: 'bytes=16-63' } });
      expect(range.status()).toBe(206);
      expect(range.headers()['content-range']).toBe('bytes 16-63/' + audio.length);
      expect(await range.body()).toEqual(audio.subarray(16, 64));
      const original = await page.request.get(stream);
      expect(original.status()).toBe(200);
      expect(digest(await original.body())).toBe(digest(audio));
      const restoredArt = await page.request.get(art);
      expect(restoredArt.status()).toBe(200);
      expect(digest(await restoredArt.body())).toBe(previousCoverHash);
      if (fixture.lyric) {
        const restoredLyrics = await page.request.get(origin + track.lyricsUrl);
        expect(restoredLyrics.status()).toBe(200);
        expect(restoredLyrics.headers()['content-type']).toMatch(/^text\/plain/);
        expect(await restoredLyrics.text()).toMatch(new RegExp('^\\[\\d+:\\d+\\.\\d+\\]' + fixture.lyric, 'm'));
      }
      outsider = await browser.newContext();
      for (const url of [stream, art, ...(fixture.lyric ? [origin + track.lyricsUrl] : [])]) {
        expect((await outsider.request.get(url)).status()).toBe(404);
      }
      expect(await (await outsider.request.get(origin + '/api/sources')).json()).toEqual({ sources: [] });

      await page.goto(origin + '/#source/' + source.id);
      for (const name of fixture.folders) await page.getByRole('button', { name, exact: true }).press('Enter');
      const row = page.locator('#content').getByRole('button', { name: new RegExp(fixture.title) });
      await row.press('Enter');
      await expect.poll(() => page.locator('#audio').evaluate(player => player.currentTime)).toBeGreaterThan(0.15);
      if (fixture.lyric) {
        await page.locator('#now').getByRole('button', { name: '歌词', exact: true }).press('Enter');
        await expect(page.getByRole('button', { name: fixture.lyric })).toBeVisible();
      }
    } finally {
      await outsider?.close();
      await app?.close();
      await rm(data, { recursive: true, force: true });
    }
  });
}
