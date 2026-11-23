import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test.use({ serviceWorkers: 'allow' });

function wav() {
  const sampleRate = 8000;
  const samples = sampleRate * 4;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    bytes.writeInt16LE(Math.round(2000 * Math.sin(index * 2 * Math.PI * 262 / sampleRate)), 44 + index * 2);
  }
  return bytes;
}

async function closeServer(server) {
  if (server.pid && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}

async function closeFixture(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('reloads the installed shell with no network and still plays downloaded Baidu audio', async ({ page, context }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-offline-shell-'));
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env, GROOVEBOX_DATA_DIR: directory, HOST: '127.0.0.1', PORT: '0',
      BAIDU_CLIENT_ID: '', BAIDU_CLIENT_SECRET: '', BAIDU_REDIRECT_URI: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fixture;
  try {
    const upstream = await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      server.once('error', reject);
      server.once('exit', code => reject(new Error('Offline test server exited with code ' + code + '\n' + errors)));
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const found = /Groovebox: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
        if (found) resolve(found);
      });
      server.stderr.on('data', chunk => { errors += chunk.toString(); });
    });

    const sourceFile = '/api/baidu/stream?id=9123';
    const albumCover = '/api/artwork/cover?id=905a104c-d081-48ee-8650-d83d59cafe37';
    const bytes = wav();
    const picture = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
    const newRevision = 'f'.repeat(24);
    const manifest = await readFile(new URL('../public/sw-build.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
    let updatedShell = false;
    let streamRequests = 0;
    fixture = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url, upstream);
      const json = value => outgoing.writeHead(200, {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      }).end(JSON.stringify(value));
      if (updatedShell && url.pathname === '/sw-build.js') {
        return outgoing.writeHead(200, { 'Content-Type': 'text/javascript' })
          .end(manifest.replace(/"revision":"[0-9a-f]{24}"/, '"revision":"' + newRevision + '"'));
      }
      if (updatedShell && url.pathname === '/style.css') {
        return outgoing.writeHead(200, { 'Content-Type': 'text/css' }).end(css + '\n/* Updated shell */');
      }
      if (url.pathname === '/api/baidu/status') return json({ configured: true, connected: true });
      if (url.pathname === '/api/baidu/list') return json({
        items: [{ id: '9123', folder: false, name: '离线合奏.wav', path: '/离线合奏.wav', streamUrl: sourceFile,
          artist: '海岛乐团', album: '演奏实录' }],
      });
      if (url.pathname === '/api/artwork/album') return json({ cover: albumCover });
      if (incoming.url === albumCover) {
        return outgoing.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).end(picture);
      }
      if (incoming.url === sourceFile) {
        streamRequests++;
        return outgoing.writeHead(200, {
          'Content-Type': 'audio/wav', 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
        }).end(bytes);
      }
      const proxy = request(url, { method: incoming.method, headers: incoming.headers }, response => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      });
      proxy.on('error', () => outgoing.writeHead(502).end());
      incoming.pipe(proxy);
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const origin = 'http://127.0.0.1:' + fixture.address().port;

    await page.goto(origin + '/#sources');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.getByRole('button', { name: /百度网盘 已连接/ }).press('Enter');
    const track = page.getByRole('button', { name: /离线合奏/ });
    await expect(track).toBeVisible();
    await page.locator('#content tr').filter({ has: track }).locator('[data-action=track-menu]').press('Enter');
    await page.getByRole('dialog').getByRole('button', { name: '离线保存' }).press('Enter');
    await expect(page.getByRole('status').filter({ hasText: '音频已保存到离线歌曲' })).toBeVisible();
    expect(streamRequests).toBe(1);
    await page.locator('#content tr').filter({ has: track }).locator('[data-action=track-menu]').press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '查找在线封面' }).press('Enter');
    const rowCover = page.locator('#content tr').filter({ has: track }).locator('img');
    await expect(rowCover).toHaveAttribute('src', albumCover);
    await expect.poll(() => rowCover.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await page.locator('#content tr').filter({ has: track }).locator('[data-action=track-menu]').press('Enter');
    await dialog.getByRole('button', { name: '添加到歌单' }).press('Enter');
    await dialog.getByRole('button', { name: '新建歌单' }).press('Enter');
    await dialog.getByRole('textbox').fill('断网歌单');
    await dialog.getByRole('button', { name: '创建' }).press('Enter');
    await page.locator('#sidebar [data-nav=offline]').press('Enter');
    await expect(page.getByRole('heading', { name: '已下载音乐' })).toBeVisible();
    await expect(track).toBeVisible();

    const cachedPaths = await page.evaluate(async () => {
      const shell = (await caches.keys()).filter(key => key.startsWith('groovebox-shell-'));
      const cache = await caches.open(shell[0]);
      return (await cache.keys()).map(request => new URL(request.url).pathname);
    });
    expect(cachedPaths).toEqual(expect.arrayContaining(['/', '/app.js', '/locale.js', '/translations.js', '/style.css', '/offline.js']));
    expect(cachedPaths.every(path => !path.startsWith('/api/') && !path.endsWith('.m4a') && !path.endsWith('.wav'))).toBe(true);

    updatedShell = true;
    await page.evaluate(async () => (await navigator.serviceWorker.ready).update().then(() => {}));
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(key => key.startsWith('groovebox-shell-'))))
      .toEqual(['groovebox-shell-' + newRevision]);

    await page.locator('#sidebar [data-nav=settings]').press('Enter');
    await page.getByLabel('界面语言').selectOption('ja');
    await page.locator('#sidebar [data-nav=offline]').press('Enter');
    await expect(page.getByRole('heading', { name: 'ダウンロード済みの音楽' })).toBeVisible();

    await closeFixture(fixture);
    await closeServer(server);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'ダウンロード済みの音楽' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(track).toBeVisible();
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    const updatedStylesheet = await page.evaluate(async () => (await (await fetch('/style.css')).text()).endsWith('/* Updated shell */'));
    expect(updatedStylesheet).toBe(true);
    const apiUnavailable = await page.evaluate(() => fetch('/api/baidu/status', { cache: 'no-store' }).then(() => false, () => true));
    expect(apiUnavailable).toBe(true);
    await track.press('Enter');
    await expect(page.locator('#player-title')).toHaveText('离线合奏');
    const playingCover = page.locator('#player-art img');
    await expect(playingCover).toHaveAttribute('src', albumCover);
    await expect.poll(() => playingCover.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
    expect(await page.locator('#audio').evaluate(audio => audio.currentSrc)).toMatch(/^blob:/);
    await page.locator('#playlist-nav').getByRole('button', { name: '断网歌单' }).press('Enter');
    await page.getByRole('button', { name: 'プレイリストをダウンロード', exact: true }).press('Enter');
    const exportLink = page.getByRole('link', { name: 'ZIP を保存' });
    await expect(exportLink).toBeVisible();
    const download = page.waitForEvent('download');
    await exportLink.press('Enter');
    const archive = await readFile(await (await download).path());
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.includes(bytes)).toBe(true);
    expect(streamRequests).toBe(1);
  } finally {
    await closeFixture(fixture);
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps the player usable while an older tab holds the offline database open', async ({ page, context }) => {
  const older = await context.newPage();
  try {
    await older.goto('/assets/cover-1.jpg');
    await older.evaluate(() => new Promise((resolve, reject) => {
      const opening = indexedDB.open('groovebox.offline', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('audio', { keyPath: 'id' });
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => { window.fixtureOfflineV1 = opening.result; resolve(); };
    }));
    await page.goto('/#offline');
    await expect(page.locator('#toast')).toHaveText('浏览器无法打开离线歌曲存储。');
    await page.locator('#sidebar [data-nav=songs]').press('Enter');
    await expect(page.getByRole('heading', { name: '全部歌曲', exact: true })).toBeVisible();
  } finally {
    await older.close();
  }
  await page.reload();
  expect(await page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('groovebox.offline');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => { resolve(opening.result.version); opening.result.close(); };
  }))).toBe(3);
});
