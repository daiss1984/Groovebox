import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const image = process.env.KODI_TEST_IMAGE;
const ffmpeg = process.env.FFMPEG_TEST_BIN;
const exec = promisify(execFile);
const username = 'groovebox-fixture';
const artist = 'Kodi Fixture Artist';
const album = 'Kodi Fixture Album';
const title = 'Kodi Fixture Recording';

function docker(args) {
  return exec('docker', args, { timeout: 15_000 });
}

async function rpc(origin, auth, method, params) {
  const response = await fetch(origin + '/jsonrpc', {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: auth }) },
    signal: AbortSignal.timeout(3000), redirect: 'error',
  });
  return { status: response.status, value: response.ok ? await response.json() : undefined };
}

async function prepareProfile(userdata, password) {
  await mkdir(userdata, { recursive: true });
  await Promise.all([
    writeFile(join(userdata, 'advancedsettings.xml'), `
      <advancedsettings>
        <services>
          <webserver>true</webserver>
          <webserverport>8080</webserverport>
          <webserverauthentication>true</webserverauthentication>
          <webserverusername>${username}</webserverusername>
          <webserverpassword>${password}</webserverpassword>
          <esallinterfaces>false</esallinterfaces>
          <zeroconf>false</zeroconf>
        </services>
        <musiclibrary>
          <downloadinfo>false</downloadinfo>
        </musiclibrary>
      </advancedsettings>`, { mode: 0o600 }),
    writeFile(join(userdata, 'sources.xml'), `
      <sources><music><source>
        <name>Groovebox Kodi fixture</name>
        <path pathversion="1">/music/</path>
        <allowsharing>true</allowsharing>
      </source></music></sources>`),
  ]);
}

// Kodi Omega on Debian with a virtual X11 display and software rendering.
// https://packages.debian.org/trixie/kodi
// https://kodi.wiki/view/JSON-RPC_API
test('browses and streams a real Kodi music library through authenticated JSON-RPC and VFS', async ({ page }) => {
  test.skip(!image || !ffmpeg, 'Provide local KODI_TEST_IMAGE with Kodi and a virtual X11 display, plus FFMPEG_TEST_BIN.');
  test.setTimeout(85_000);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'groovebox-kodi-live-')));
  const data = join(temporary, 'kodi-home');
  const music = join(temporary, 'music');
  const albumDirectory = join(music, artist, album);
  const audioFile = join(albumDirectory, '01 - 合成录音.flac');
  const renderer = 'groovebox-kodi-' + randomUUID();
  const password = randomBytes(20).toString('hex');
  const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  let launched = false;
  try {
    await Promise.all([mkdir(albumDirectory, { recursive: true }), prepareProfile(join(data, '.kodi', 'userdata'), password)]);
    const coverFile = join(albumDirectory, 'folder.jpg');
    await exec(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=180x180:d=1', '-frames:v', '1', coverFile,
    ], { timeout: 10000 });
    await exec(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-i', coverFile, '-map', '0:a:0', '-map', '1:v:0',
      '-metadata', 'artist=' + artist, '-metadata', 'album_artist=' + artist, '-metadata', 'album=' + album,
      '-metadata', 'title=' + title, '-metadata', 'track=1', '-metadata', 'genre=Fixture',
      '-metadata:s:v:0', 'comment=Cover (front)', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', audioFile,
    ], { timeout: 10000 });
    launched = true;
    await docker([
      'run', '--detach', '--rm', '--pull=never', '--name', renderer, '--publish', '127.0.0.1::8080/tcp',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--env', 'HOME=/fixture-home',
      '--mount', 'type=bind,source=' + data + ',target=/fixture-home',
      '--mount', 'type=bind,source=' + music + ',target=/music,readonly',
      image,
    ]);
    const { stdout } = await docker(['port', renderer, '8080/tcp']);
    const origin = 'http://' + stdout.trim();
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect.poll(async () => {
      try { return (await rpc(origin, auth, 'JSONRPC.Ping')).value?.result; }
      catch { return undefined; }
    }, { timeout: 26000, message: 'Kodi should start its authenticated HTTP server' }).toBe('pong');
    expect((await rpc(origin, undefined, 'JSONRPC.Ping')).status).toBe(401);
    expect((await rpc(origin, auth, 'AudioLibrary.Scan', { directory: '/music/', showdialogs: false })).value?.result).toBe('OK');
    const fields = { properties: ['title', 'thumbnail', 'art', 'file'] };
    await expect.poll(async () => {
      const payload = (await rpc(origin, auth, 'AudioLibrary.GetSongs', fields)).value;
      return payload?.result?.songs?.map(song => song.title) || [];
    }, { timeout: 16000, message: 'Kodi should scan the isolated tagged FLAC' }).toContain(title);
    const song = (await rpc(origin, auth, 'AudioLibrary.GetSongs', fields)).value.result.songs.find(item => item.title === title);
    expect(song.file).toContain('合成录音.flac');
    expect(song.thumbnail).toMatch(/^image:\/\//);
    const rawCover = await fetch(origin + '/image/' + encodeURIComponent(song.thumbnail), {
      headers: { Accept: 'image/*', Authorization: auth }, redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    expect(rawCover.status).toBe(200);
    const rawCoverBody = Buffer.from(await rawCover.arrayBuffer());
    expect(rawCoverBody.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    await page.goto('/#sources');
    await page.getByRole('button', { name: /添加媒体服务器/ }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('协议').selectOption('kodi');
    await dialog.getByLabel('名称').fill('Kodi fixture');
    await dialog.getByLabel('服务地址').fill(origin);
    await dialog.getByLabel('用户名').fill(username);
    await dialog.getByLabel('密码').fill(password);
    const [connected] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/sources') && response.request().method() === 'POST'),
      dialog.getByRole('button', { name: '连接', exact: true }).press('Enter'),
    ]);
    expect(connected.status()).toBe(201);
    await page.getByRole('button', { name: album, exact: true }).press('Enter');
    const track = page.locator('#content').getByRole('button', { name: new RegExp(title + ' ' + artist) });
    await expect(track).toBeVisible();
    const [stream] = await Promise.all([
      page.waitForResponse(response => /\/api\/sources\/[\w-]+\/stream\?id=[\w-]+$/.test(response.url())),
      track.press('Enter'),
    ]);
    expect(stream.ok()).toBe(true);
    expect(stream.headers()['content-type']).toBe('audio/flac');
    await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
    const ranged = await page.request.get(stream.url(), { headers: { Range: 'bytes=5-40' } });
    const audio = await readFile(audioFile);
    expect(ranged.status()).toBe(206);
    expect(ranged.headers()['content-range']).toBe('bytes 5-40/' + audio.length);
    expect(await ranged.body()).toEqual(audio.subarray(5, 41));
    const art = track.locator('img');
    await expect(art).toBeVisible();
    const cover = await art.getAttribute('src');
    expect(cover).toMatch(/^\/api\/sources\/[\w-]+\/cover\?id=[\w-]+$/);
    const imageResponse = await page.request.get(cover);
    expect(imageResponse.status()).toBe(200);
    expect(imageResponse.headers()['content-type']).toBe('image/jpeg');
    expect(await imageResponse.body()).toEqual(rawCoverBody);
    await expect.poll(() => art.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  } finally {
    if (launched) await docker(['rm', '-f', renderer]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});
