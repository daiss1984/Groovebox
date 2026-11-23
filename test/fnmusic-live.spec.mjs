import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const bridgeImage = process.env.YINQIAO_TEST_IMAGE;
const exec = promisify(execFile);
const artist = { guid: 'artist-1', name: 'Fixture Bridge Artist', albumCount: 1, trackCount: 1, coverId: 'artist-cover' };
const album = { guid: 'album-1', name: 'Fixture Bridge Album', artists: [artist], coverId: 'album-cover' };
const title = 'Fixture Bridge Recording';
const username = 'groovebox-fixture';

function docker(args) {
  return exec('docker', args, { timeout: 15_000 });
}

function envelope(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, data }));
}

function sendAudio(req, res, file) {
  const headers = { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes' };
  if (!req.headers.range) {
    res.writeHead(200, { ...headers, 'Content-Length': file.length }).end(file);
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
  const start = match ? Number(match[1]) : file.length;
  const end = match?.[2] ? Math.min(Number(match[2]), file.length - 1) : file.length - 1;
  if (start > end) {
    res.writeHead(416, { 'Content-Range': 'bytes */' + file.length }).end();
    return;
  }
  const bytes = file.subarray(start, end + 1);
  res.writeHead(206, {
    ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + file.length, 'Content-Length': bytes.length,
  }).end(bytes);
}

async function mockYinqiaoApi(audio, covers, password, calls) {
  const token = randomBytes(24).toString('hex');
  const passwordHash = createHash('sha256').update(password).digest('hex');
  const song = {
    guid: 'track-1', title, duration: 164000, album, artists: [artist], coverId: 'track-cover',
    audioSpec: { extension: 'm4a', codec: 'aac', container: 'm4a', duration: 164000, size: audio.length },
  };
  const lists = {
    '/catalog/artists/all': [artist],
    '/catalog/albums/by-artist': [album],
    '/catalog/tracks/by-album': [song],
    '/catalog/lyrics': [{ guid: 'lyric-1', content: '[00:01.00]Fixture bridge lyric\n[00:02.50]Second bridge lyric' }],
  };
  async function handler(req, res) {
    const { pathname } = new URL(req.url, 'http://fixture');
    calls.push(pathname);
    if (pathname === '/') return envelope(res, { name: 'yinqiao-api', apiVersion: 'v1' });
    if (pathname === '/ready') return envelope(res, { status: 'ready', upstream: 'ready' });
    if (pathname === '/auth/login/password' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const user = JSON.parse(Buffer.concat(chunks).toString());
      if (user.username !== username || user.password !== passwordHash) return res.writeHead(401).end();
      return envelope(res, { userToken: token, user: { name: username, role: 'member' } });
    }
    if (req.headers.authorization !== 'Bearer ' + token) return res.writeHead(401).end();
    if (Object.hasOwn(lists, pathname)) return envelope(res, { list: lists[pathname], total: lists[pathname].length });
    if (pathname === '/catalog/artists/detail') return envelope(res, artist);
    if (pathname === '/catalog/albums/detail') return envelope(res, album);
    if (pathname === '/media/tracks/track-1/stream') return sendAudio(req, res, audio);
    const art = /^\/media\/covers\/(artist|album|track)-cover$/.exec(pathname);
    if (art) return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(covers[art[1]]);
    return res.writeHead(404).end();
  }
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function assertCover(page, button, pixels) {
  const image = button.locator('img');
  const source = await image.getAttribute('src');
  expect(source).toMatch(/^\/api\/sources\/[\w-]+\/cover\?id=[\w-]+$/);
  await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  const imageResponse = await page.request.get(source);
  expect(imageResponse.headers()['content-type']).toBe('image/jpeg');
  expect(await imageResponse.body()).toEqual(pixels);
}

// Run the actual released AMD64 yinqiao-service as the image entry point.
// https://github.com/qianlipp/fn-music-bridge/releases/latest
// The underlying Yinqiao/fnOS APIs below are a local fixture without a NAS.
test('plays through a real 音桥 service backed by a mock lower Yinqiao API', async ({ page }) => {
  test.skip(!bridgeImage, 'Provide YINQIAO_TEST_IMAGE with the published yinqiao-service as its entry point.');
  test.setTimeout(45_000);
  const password = randomBytes(24).toString('hex');
  const name = 'groovebox-fnmusic-' + randomUUID();
  const [audio, artistCover, albumCover, trackCover] = await Promise.all(
    ['demo-1.m4a', 'cover-1.jpg', 'cover-2.jpg', 'cover-3.jpg'].map(file => readFile(new URL('../public/assets/' + file, import.meta.url))),
  );
  const calls = [];
  const api = await mockYinqiaoApi(audio, { artist: artistCover, album: albumCover, track: trackCover }, password, calls);
  try {
    await docker([
      'run', '--detach', '--rm', '--pull=never', '--platform=linux/amd64', '--name', name,
      '--publish', '127.0.0.1::14040/tcp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec',
      '--env', 'YINQIAO_SERVICE_LISTEN=0.0.0.0:14040',
      '--env', 'YINQIAO_API_URL=http://host.docker.internal:' + api.address().port,
      bridgeImage,
    ]);
    const { stdout } = await docker(['port', name, '14040/tcp']);
    const bridge = 'http://' + stdout.trim();
    expect(bridge).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect.poll(async () => {
      try { return (await fetch(bridge + '/yinqiao/status', { signal: AbortSignal.timeout(2000) })).status; }
      catch { return 0; }
    }).toBe(200);
    const enrolled = await fetch(bridge + '/yinqiao/enroll', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: bridge },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(5000),
    });
    expect(enrolled.ok).toBe(true);

    await page.goto('/#sources');
    await page.getByRole('button', { name: /添加媒体服务器/ }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('协议').selectOption('fnmusic');
    await dialog.getByLabel('名称').fill('Bridge fixture');
    await dialog.getByLabel('服务地址').fill(bridge);
    await dialog.getByLabel('用户名').fill(username);
    await dialog.getByLabel('密码').fill(password);
    const [connected] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/sources') && response.request().method() === 'POST'),
      dialog.getByRole('button', { name: '连接', exact: true }).press('Enter'),
    ]);
    expect(connected.status()).toBe(201);
    const artistFolder = page.getByRole('button', { name: artist.name, exact: true });
    await assertCover(page, artistFolder, artistCover);
    await artistFolder.press('Enter');
    const albumFolder = page.getByRole('button', { name: album.name, exact: true });
    await assertCover(page, albumFolder, albumCover);
    await albumFolder.press('Enter');
    const track = page.locator('#content').getByRole('button', { name: new RegExp(title) });
    await assertCover(page, track, trackCover);
    const [stream] = await Promise.all([
      page.waitForResponse(res => /\/api\/sources\/[^/]+\/stream\?id=[\w-]+$/.test(res.url()) && !res.url().endsWith('-lyrics')),
      track.press('Enter'),
    ]);
    expect(stream.ok()).toBe(true);
    await expect(page.locator('#player-title')).toHaveText(title);
    await expect.poll(() => page.locator('#audio').evaluate(player => player.currentTime)).toBeGreaterThan(0.1);
    const range = await page.request.get(stream.url(), { headers: { Range: 'bytes=20-59' } });
    expect(range.status()).toBe(206);
    expect(range.headers()['content-range']).toBe('bytes 20-59/' + audio.length);
    expect(await range.body()).toEqual(audio.subarray(20, 60));
    await page.locator('#player-art').press('Enter');
    await expect(page.getByRole('button', { name: 'Fixture bridge lyric', exact: true })).toBeVisible();
    expect(calls).toEqual(expect.arrayContaining([
      '/auth/login/password', '/catalog/artists/all', '/catalog/albums/by-artist', '/catalog/tracks/by-album',
      '/catalog/lyrics', '/media/covers/artist-cover', '/media/covers/album-cover', '/media/covers/track-cover',
      '/media/tracks/track-1/stream',
    ]));
  } finally {
    await docker(['rm', '-f', name]).catch(() => {});
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  }
});
