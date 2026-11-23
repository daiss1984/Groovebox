import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';

// Optional fixture: official Songloft v2.13.12+ on 127.0.0.1 with
// fixture-singer / fixture-dav-password. Scan the tagged fixture M4A and its
// same-name LRC before running, then pass the server URL and local M4A path.
const target = process.env.GROOVEBOX_SONGLOFT_TEST_URL;
const sourceFile = process.env.GROOVEBOX_SONGLOFT_TEST_AUDIO;
const remoteTarget = process.env.GROOVEBOX_SONGLOFT_REMOTE_TEST_URL;
const remoteAudio = process.env.GROOVEBOX_SONGLOFT_REMOTE_TEST_AUDIO;

// Use the same disposable account as above on a separate fixture server. Register
// `Remote Songloft Fixture` by `Remote Fixture Artist` using /api/v1/songs/remote.
// Its remote URL must serve the exact M4A passed in GROOVEBOX_SONGLOFT_REMOTE_TEST_AUDIO.
test('plays actual Songloft remote audio after exchanging a real refresh token', async ({ page }) => {
  test.skip(!remoteTarget || !remoteAudio, 'Requires GROOVEBOX_SONGLOFT_REMOTE_TEST_URL and GROOVEBOX_SONGLOFT_REMOTE_TEST_AUDIO fixtures');
  const original = await readFile(remoteAudio);
  const upstream = new URL(remoteTarget);
  expect(upstream.protocol).toBe('http:');
  expect(upstream.hostname).toBe('127.0.0.1');
  expect(upstream.pathname).toBe('/');
  expect(upstream.username + upstream.password).toBe('');
  const relay = await launchRefreshFixture(upstream);

  try {
    const title = 'Remote Songloft Fixture';
    const artist = 'Remote Fixture Artist';
    const sourceName = 'Official Songloft remote';
    await page.goto('/#sources');
    await page.getByRole('button', { name: /^添加媒体服务器/ }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('协议').selectOption('songloft');
    await dialog.getByLabel('名称', { exact: true }).fill(sourceName);
    await dialog.getByLabel('服务地址').fill(relay.url);
    await dialog.getByLabel('用户名').fill('fixture-singer');
    await dialog.getByLabel('密码').fill('fixture-dav-password');
    const connected = page.waitForResponse(response => response.url().endsWith('/api/sources') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '连接', exact: true }).press('Enter');
    expect((await connected).status()).toBe(201);
    await expect(page.getByRole('heading', { name: sourceName })).toBeVisible();
    const track = page.locator('#content').getByRole('button', { name: `${title} ${artist}` });
    await expect(track).toBeVisible();
    await track.press('Enter');
    await expect(page.locator('#player-title')).toHaveText(title);
    const audio = page.locator('#audio');
    await expect.poll(() => audio.evaluate(player => player.currentTime)).toBeGreaterThan(0.1);
    const src = new URL(await audio.evaluate(player => player.currentSrc));
    expect(src.origin).toBe(new URL(page.url()).origin);
    expect(src.pathname).toMatch(/^\/api\/sources\/[a-z0-9-]+\/stream$/);
    expect([...src.searchParams.keys()]).toEqual(['id']);

    const range = await page.request.get(src.href, { headers: { Range: 'bytes=64-127' } });
    expect(range.status()).toBe(206);
    expect(range.headers()['content-range']).toBe(`bytes 64-127/${original.length}`);
    expect(await range.body()).toEqual(original.subarray(64, 128));
    expect(relay.stats).toMatchObject({ login: 1, refresh: 1, issuedNewAccessToken: 1 });
    expect(relay.stats.listedWithRefreshedToken).toBeGreaterThanOrEqual(1);
    expect(relay.stats.streamedWithRefreshedToken).toBeGreaterThanOrEqual(1);
  } finally {
    await relay.close();
  }
});

async function launchRefreshFixture(origin) {
  const stats = { login: 0, refresh: 0, issuedNewAccessToken: 0, listedWithRefreshedToken: 0, streamedWithRefreshedToken: 0 };
  let loginToken;
  let refreshedToken;
  const server = createServer((incoming, outgoing) => {
    const fail = () => outgoing.headersSent ? outgoing.destroy() : outgoing.writeHead(502).end();
    const url = new URL(incoming.url, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith('/api/v1/')) return outgoing.writeHead(404).end();
    const upstream = httpRequest(url, { method: incoming.method, headers: { ...incoming.headers, host: origin.host } }, async response => {
      try {
        const login = url.pathname === '/api/v1/auth/login';
        const refresh = url.pathname === '/api/v1/auth/refresh';
        if (response.statusCode === 200 && (login || refresh)) {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          const payload = JSON.parse(Buffer.concat(chunks));
          if (typeof payload.access_token !== 'string' || !payload.access_token) return fail();
          if (login) {
            stats.login += 1;
            loginToken = payload.access_token;
            // Trigger proactive refresh immediately. Keep the signed JWT untouched.
            payload.expires_in = 1;
            return outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
          }
          stats.refresh += 1;
          refreshedToken = payload.access_token;
          if (refreshedToken !== loginToken) stats.issuedNewAccessToken += 1;
          return outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(Buffer.concat(chunks));
        }
        const usedRefreshedToken = refreshedToken && incoming.headers.authorization === `Bearer ${refreshedToken}`;
        if (usedRefreshedToken && response.statusCode === 200 && url.pathname === '/api/v1/songs') stats.listedWithRefreshedToken += 1;
        if (usedRefreshedToken && response.statusCode === 206 && url.pathname.startsWith('/api/v1/songs/')) stats.streamedWithRefreshedToken += 1;
        outgoing.writeHead(response.statusCode, response.headers);
        response.on('error', fail);
        response.pipe(outgoing);
      } catch {
        fail();
      }
    });
    upstream.on('error', fail);
    outgoing.once('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

test('logs in to real Songloft and plays its indexed M4A, cover, Range and synchronized lyrics', async ({ page, request }) => {
  test.skip(!target || !sourceFile, 'Requires GROOVEBOX_SONGLOFT_TEST_URL and GROOVEBOX_SONGLOFT_TEST_AUDIO fixtures');
  expect(new URL(target).hostname).toBe('127.0.0.1');
  const source = { type: 'songloft', name: 'Official Songloft', url: target, username: 'fixture-singer' };
  const denied = await request.post('/api/sources', { data: { ...source, password: 'invalid-fixture-password' } });
  expect(denied.status()).toBe(401);

  await page.goto('/#sources');
  await page.getByRole('button', { name: /^添加媒体服务器/ }).press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('协议').selectOption(source.type);
  await dialog.getByLabel('名称', { exact: true }).fill(source.name);
  await dialog.getByLabel('服务地址').fill(source.url);
  await dialog.getByLabel('用户名').fill(source.username);
  await dialog.getByLabel('密码').fill('fixture-dav-password');
  const connected = page.waitForResponse(response => response.url().endsWith('/api/sources') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '连接', exact: true }).press('Enter');
  const connection = await connected;
  expect(connection.status()).toBe(201);
  const { source: media } = await connection.json();
  await expect(page.getByRole('heading', { name: source.name })).toBeVisible();
  const items = await page.request.get('/api/sources/' + media.id + '/list');
  expect(items.status()).toBe(200);
  const { items: library } = await items.json();
  expect(library).toEqual([expect.objectContaining({
    title: 'Fixture Songloft Track', artist: 'Fixture Songloft Artist', album: 'Fixture Songloft Album',
  })]);
  const [track] = library;
  const cover = await page.request.get(track.cover);
  expect(cover.status()).toBe(200);
  expect(cover.headers()['content-type']).toBe('image/jpeg');
  expect((await cover.body()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

  await page.getByRole('button', { name: 'Fixture Songloft Track Fixture Songloft Artist' }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText(track.title);
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(player => player.currentTime)).toBeGreaterThan(0.2);
  const src = await audio.evaluate(player => player.currentSrc);
  expect(new URL(src).pathname).toMatch(/^\/api\/sources\/[a-z0-9-]+\/stream$/);
  expect(new URL(src).searchParams.has('access_token')).toBe(false);

  const range = await page.request.get(src, { headers: { Range: 'bytes=16-63' } });
  expect(range.status()).toBe(206);
  expect(range.headers()['content-range']).toMatch(/^bytes 16-63\/\d+$/);
  expect(await range.body()).toEqual((await readFile(sourceFile)).subarray(16, 64));

  const now = page.locator('#now');
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await expect(now.getByRole('button', { name: 'Songloft fixture intro' })).toBeVisible();
  const second = now.getByRole('button', { name: 'Songloft fixture second' });
  await second.press('Enter');
  await expect.poll(() => audio.evaluate(player => player.currentTime)).toBeGreaterThanOrEqual(10);
});
