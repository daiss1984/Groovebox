import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchSmb2 } from './helpers/smb-fixture.mjs';

const python = process.env.SMB_TEST_PYTHON;
const nav = (page, section) => page.locator('#sidebar [data-nav="' + section + '"]');

test.use({ serviceWorkers: 'allow' });

test('plays the original SMB2 recording and its authenticated folder cover after an offline reload', async ({ page, context }) => {
  test.skip(!python, 'Requires SMB_TEST_PYTHON with smbprotocol and impacket');
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-smb-offline-cover-'));
  const server = launchSmb2(python, root);
  try {
    const input = await server.input;
    const original = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=', 'base64');
    const jpg = await readFile(new URL('../public/assets/cover-2.jpg', import.meta.url));
    const album = join(root, '音乐');
    await mkdir(album);
    await Promise.all([
      writeFile(join(album, 'cover.png'), png),
      writeFile(join(album, 'Saved Recording.m4a'), original),
      writeFile(join(album, 'Unsaved Recording.m4a'), original),
    ]);
    await page.goto('/');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await nav(page, 'sources').press('Enter');
    await page.locator('[data-action=add-source]').press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('协议').selectOption('smb');
    await dialog.getByLabel('名称').fill('Offline Covers SMB');
    await dialog.getByLabel('服务地址').fill(input.url + '/' + encodeURIComponent('音乐'));
    await dialog.getByLabel('用户名').fill(input.username);
    await dialog.getByLabel('密码').fill(input.password);
    await dialog.getByRole('button', { name: '连接', exact: true }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Offline Covers SMB', exact: true })).toBeVisible();

    const content = page.locator('#content');
    const saved = content.locator('tr').filter({ has: page.getByRole('button', { name: /^Saved Recording/ }) });
    const unsaved = content.locator('tr').filter({ has: page.getByRole('button', { name: /^Unsaved Recording/ }) });
    const savedArt = saved.locator('.track-main img');
    const unsavedArt = unsaved.locator('.track-main img');
    const imageBytes = image => image.evaluate(async element => Array.from(new Uint8Array(await (await fetch(element.src)).arrayBuffer())));
    await expect(content.locator('.track-main')).toHaveCount(2);
    await expect(savedArt).toHaveAttribute('src', /^\/api\/sources\/[\w-]+\/cover\?id=/);
    await expect(unsavedArt).toHaveAttribute('src', await savedArt.getAttribute('src'));
    expect(await imageBytes(savedArt)).toEqual([...png]);
    await content.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 2 首歌曲');
    await nav(page, 'songs').press('Enter');

    await saved.locator('.track-main').press('Enter');
    const playerArt = page.locator('#player-art img');
    const audio = page.locator('#audio');
    const playback = () => audio.evaluate(element => ({ source: element.currentSrc, position: element.currentTime, paused: element.paused }));
    await expect.poll(async () => (await playback()).position).toBeGreaterThan(0.1);
    const initial = await playback();
    await expect(playerArt).toHaveAttribute('src', await savedArt.getAttribute('src'));
    await rm(join(album, 'cover.png'));
    await writeFile(join(album, 'cover.jpg'), jpg);
    await content.getByRole('button', { name: '刷新曲库', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toContainText('曲库已刷新');
    await expect(playerArt).toHaveAttribute('src', await savedArt.getAttribute('src'));
    const cover = await page.request.get(await playerArt.getAttribute('src'));
    expect(await cover.body()).toEqual(jpg);
    expect(await playback()).toMatchObject({ source: initial.source, paused: false });
    await expect.poll(async () => (await playback()).position).toBeGreaterThan(initial.position);

    await saved.getByRole('button', { name: '歌曲选项' }).press('Enter');
    await dialog.getByRole('button', { name: '离线保存', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toContainText('音频已保存');
    await server.stop();
    await context.setOffline(true);
    await page.reload();
    await expect(savedArt).toHaveAttribute('src', /^blob:/);
    await expect(unsavedArt).toHaveCount(0);
    await nav(page, 'offline').press('Enter');
    await saved.locator('.track-main').press('Enter');
    await expect(playerArt).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => playerArt.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    const data = element => element.evaluate(async media => {
      const contents = await (await fetch(media.currentSrc || media.src)).arrayBuffer();
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', contents));
      return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    });
    expect(await data(playerArt)).toBe(createHash('sha256').update(jpg).digest('hex'));
    await expect.poll(async () => (await playback()).position).toBeGreaterThan(0.1);
    expect(await data(audio)).toBe(createHash('sha256').update(original).digest('hex'));
  } finally {
    await context.setOffline(false);
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('loads scoped artist portraits on demand from authenticated SMB2 directories', async ({ page, browser }) => {
  test.skip(!python, 'Requires SMB_TEST_PYTHON with smbprotocol and impacket');
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-smb-portraits-'));
  const server = launchSmb2(python, root);
  try {
    const input = await server.input;
    const artist = 'ÉCHO 乐队';
    const raster = 'e\u0301cho 乐队';
    const names = ['SMB Alpha', 'SMB Beta'];
    const [audio, first, second, replacement] = await Promise.all(['demo-1.m4a', 'cover-1.jpg', 'cover-2.jpg', 'cover-3.jpg']
      .map(file => readFile(new URL('../public/assets/' + file, import.meta.url))));
    for (const [index, branch] of ['alpha', 'beta'].entries()) {
      const folder = join(root, branch);
      const portraits = join(folder, 'artist');
      await mkdir(portraits, { recursive: true });
      await writeFile(join(folder, artist + ' - Recording ' + branch + '.m4a'), audio);
      await writeFile(join(portraits, raster + '.JPG'), index === 0 ? first : second);
    }
    await writeFile(join(root, 'alpha', 'artist', raster + '.png'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(root, 'alpha', 'artist', raster + ' 合辑.jpg'), second);
    await writeFile(join(root, 'alpha', raster + '.jpg'), second);

    await page.addInitScript(() => {
      const key = 'groovebox.state.v1';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { demos: false, onlineCover: false } }));
    });
    const artistReads = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && path.endsWith('/artist-portraits')) artistReads.push(path);
    });
    const content = page.locator('#content');
    const buttons = label => content.getByRole('button', { name: label, exact: true });
    const card = content.locator('button.card').filter({ has: page.getByText(artist, { exact: true }) });
    const portrait = content.locator('.artist-portrait img');
    const srcCard = label => content.locator('.source-card-group').filter({ has: page.getByText(label, { exact: true }) });
    const assertPortrait = async (image, bytes) => {
      await expect(image).toHaveAttribute('src', /^\/api\/sources\/[a-f\d-]+\/cover\?id=[\w-]{24}$/);
      await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
      const path = await image.getAttribute('src');
      const response = await page.request.get(path);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toBe('image/jpeg');
      expect(response.headers()['cache-control']).toBe('private, no-store');
      expect(await response.body()).toEqual(bytes);
      return path;
    };
    const connect = async (branch, name) => {
      await nav(page, 'sources').click();
      await content.locator('[data-action=add-source]').click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('协议').selectOption('smb');
      await dialog.getByLabel('名称').fill(name);
      await dialog.getByLabel('服务地址').fill(input.url + '/' + branch);
      await dialog.getByLabel('用户名').fill(input.username);
      await dialog.getByLabel('密码').fill(input.password);
      await dialog.getByRole('button', { name: '连接', exact: true }).click();
      await expect(content.getByRole('heading', { name, exact: true })).toBeVisible();
      const id = decodeURIComponent(new URL(page.url()).hash).split('/').at(-1);
      await buttons('扫描并加入曲库').click();
      await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
      return '/api/sources/' + id;
    };

    await page.goto('/#sources');
    const alpha = await connect('alpha', names[0]);
    expect(artistReads).toEqual([]);
    await nav(page, 'artists').click();
    const alphaCover = await assertPortrait(card.locator('img'), first);
    await card.click();
    expect(await assertPortrait(portrait, first)).toBe(alphaCover);
    expect(artistReads).toEqual([alpha + '/artist-portraits']);
    const anonymous = await browser.newContext();
    try {
      for (const path of [alphaCover, alpha + '/artist-portraits']) {
        expect((await anonymous.request.get(new URL(path, page.url()).href)).status()).toBe(404);
      }
    } finally { await anonymous.close(); }

    const beta = await connect('beta', names[1]);
    const indexed = page.waitForResponse(response => response.ok() && new URL(response.url()).pathname === beta + '/artist-portraits');
    await nav(page, 'artists').click();
    await indexed;
    await card.click();
    await expect(content.getByRole('heading', { name: artist, exact: true })).toBeVisible();
    await expect(portrait).toHaveCount(0);
    expect((await page.request.get(alphaCover.replace(alpha + '/', beta + '/'))).status()).toBe(404);

    await nav(page, 'sources').click();
    await srcCard(names[0]).getByRole('button', { name: '从曲库隐藏', exact: true }).click();
    await nav(page, 'artists').click();
    await card.click();
    const betaCover = await assertPortrait(portrait, second);
    expect((await page.request.delete(beta + '/artist-portraits', { headers: { Origin: 'https://unrelated.invalid' } })).status()).toBe(403);
    const refreshBeta = async () => {
      await nav(page, 'sources').click();
      await srcCard(names[1]).locator('button.source-card').click();
      await expect(content.locator('.track-main')).toHaveCount(1);
      const refreshed = page.waitForResponse(response => response.ok() && new URL(response.url()).pathname === beta + '/list');
      await buttons('刷新目录').click();
      await refreshed;
      await expect(content.locator('.track-main')).toHaveCount(1);
    };
    await writeFile(join(root, 'beta', 'artist', raster + '.JPG'), replacement);
    await refreshBeta();
    await nav(page, 'artists').click();
    await card.click();
    const changed = await assertPortrait(portrait, replacement);
    expect(changed).not.toBe(betaCover);
    expect((await page.request.get(betaCover)).status()).toBe(404);

    await page.addInitScript(() => {
      const key = 'groovebox.state.v1';
      const saved = JSON.parse(localStorage.getItem(key));
      saved.settings.onlineCover = true;
      for (const track of saved.tracks.filter(track => track.provider === 'smb')) {
        track.album = 'Fixture Album';
        track.albumIsFallback = false;
      }
      localStorage.setItem(key, JSON.stringify(saved));
      const originalFetch = window.fetch.bind(window);
      const discover = new Promise(resolve => window.addEventListener('fixture-discover-sources', resolve, { once: true }));
      window.fetch = async (input, options) => {
        const path = new URL(input instanceof Request ? input.url : input, location.href).pathname;
        if (path === '/api/sources' && (!options?.method || options.method === 'GET')) {
          document.documentElement.dataset.fixtureSourceDiscovery = 'held';
          await discover;
        }
        if (path === '/api/artwork/artist') {
          document.documentElement.dataset.fixtureOnlinePortrait = 'called';
          return new Response(null, { status: 404 });
        }
        return originalFetch(input, options);
      };
    });
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-fixture-source-discovery', 'held');
      await expect(content.getByRole('heading', { name: artist, exact: true })).toBeVisible();
      await expect(buttons('查找艺人照片')).toBeVisible();
      await expect(portrait).toHaveCount(0);
    } finally { await page.evaluate(() => window.dispatchEvent(new Event('fixture-discover-sources'))); }
    expect(await assertPortrait(portrait, replacement)).toBe(changed);
    expect(await page.locator('html').getAttribute('data-fixture-online-portrait')).toBeNull();

    await rm(join(root, 'beta', 'artist', raster + '.JPG'));
    await refreshBeta();
    const afterRemoval = page.waitForResponse(response => response.ok() && response.request().method() === 'GET' &&
      new URL(response.url()).pathname === beta + '/artist-portraits');
    await nav(page, 'artists').click();
    expect(await (await afterRemoval).json()).toEqual({ portraits: [] });
    await card.click();
    await expect(content.getByRole('heading', { name: artist, exact: true })).toBeVisible();
    await expect(portrait).toHaveCount(0);
    expect((await page.request.get(changed)).status()).toBe(404);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
