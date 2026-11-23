import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

test.use({ serviceWorkers: 'allow' });

const mib = 1024 * 1024;
const assets = {
  '/sw.js': new URL('../public/sw.js', import.meta.url),
  '/image-cache-client.js': new URL('../public/image-cache-client.js', import.meta.url),
};
const artworkPaths = { public: '/api/artwork/cover', custom: '/api/metadata/artwork/image', artist: '/api/artwork/artist-cover' };
const cover = (id, kind = 'public') => artworkPaths[kind] +
  '?id=00000000-0000-4000-8000-' + String(id).padStart(12, '0');

async function fixture() {
  const contents = Object.fromEntries(await Promise.all(Object.entries(assets).map(async ([path, source]) => [path, await readFile(source)])));
  const replies = new Map();
  let revision = 1;
  const server = createServer(async (request, response) => {
    const { url } = request;
    response.setHeader('Cache-Control', 'no-store');
    if (contents[url] || url === '/sw-build.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(url === '/sw-build.js' ? `self.grooveboxShell={ revision: 'image-fixture-${revision}', urls: ['/'] };`
        : url === '/sw.js' ? Buffer.concat([contents[url], Buffer.from(`\n// Revision ${revision}\n`)]) : contents[url]);
      return;
    }
    if (url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Artwork Cache Fixture</title>');
      return;
    }
    const reply = replies.get(url);
    if (!reply) {
      response.writeHead(404).end();
      return;
    }
    reply.received?.();
    if (reply.hold) await reply.hold;
    response.writeHead(reply.status || 200, {
      'Content-Type': 'image/png',
      ...(reply.location ? { Location: reply.location } : {}),
      ...(reply.encoding ? { 'Content-Encoding': reply.encoding, 'Content-Length': reply.body.length } : {}),
    });
    response.end(reply.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed;
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    replies,
    update() { revision += 1; },
    close() {
      if (!closed) {
        closed = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
      }
      return closed;
    },
  };
}

async function register(page) {
  await page.evaluate(() => navigator.serviceWorker.register('/sw.js'));
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

function policy(page, action = 'readImageCachePolicy', args) {
  return page.evaluate(async ({ action, args }) => {
    const client = await import('/image-cache-client.js');
    try {
      return await client[action](args);
    } catch (error) {
      return { code: error.code };
    }
  }, { action, args });
}

function requestImage(page, url) {
  return page.evaluate(async path => {
    try {
      const response = await fetch(path);
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength, internal: response.headers.has('X-Groovebox-Artwork-Bytes') };
    } catch {
      return { offline: true };
    }
  }, url);
}

function expectImage(page, url, bytes) {
  return expect(requestImage(page, url)).resolves.toEqual({ status: 200, bytes, internal: false });
}

function advanceWorker(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const changed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    await registration.update();
    await changed;
  });
}

function holdImage(remote, path, body) {
  let release;
  let received;
  const arrive = new Promise(resolve => { received = resolve; });
  remote.replies.set(path, { body, received, hold: new Promise(resolve => { release = resolve; }) });
  return { arrive, release };
}

test('measures legacy and HTTP-encoded covers and evicts least recently accessed artwork by bytes', async ({ page }) => {
  const remote = await fixture();
  try {
    await page.goto(remote.origin);
    await expect(policy(page)).resolves.toEqual({ code: 'unsupported' });
    const legacyCache = 'groovebox-album-artwork-v1';
    const old = cover(1);
    const first = cover(2, 'custom');
    const older = cover(3, 'artist');
    const image = Buffer.alloc(9 * mib + 1, 42);
    await page.evaluate(async ({ legacyCache, old, length }) => {
      const cache = await caches.open(legacyCache);
      await cache.put(old, new Response(new Uint8Array(length), {
        headers: { 'Content-Type': 'image/png', 'Content-Length': '7', 'X-Groovebox-Artwork-Bytes': '7' },
      }));
    }, { legacyCache, old, length: image.length });
    await register(page);
    await expect(policy(page)).resolves.toEqual({ usedBytes: image.length, entryCount: 1, limitMiB: 250, paused: false });
    await expect(policy(page, 'configureImageCache', { limitMiB: 49 })).resolves.toEqual({ code: 'invalid_budget' });
    await expect(policy(page, 'configureImageCache', { limitMiB: 55 })).resolves.toMatchObject({ limitMiB: 55 });
    remote.replies.set(first, { body: gzipSync(image), encoding: 'gzip' });
    await expectImage(page, first, image.length);
    for (const path of [older, cover(4), cover(5)]) {
      remote.replies.set(path, { body: image });
      await expectImage(page, path, image.length);
    }
    await expect.poll(() => policy(page)).toEqual({ usedBytes: 5 * image.length, entryCount: 5, limitMiB: 55, paused: false });
    remote.replies.set(old, { status: 503 });
    remote.replies.set(first, { status: 503 });
    await expectImage(page, old, image.length);
    await expectImage(page, first, image.length);
    const last = cover(6);
    remote.replies.set(last, { body: image });
    await expectImage(page, last, image.length);
    await expect.poll(() => policy(page)).toMatchObject({ usedBytes: 6 * image.length, entryCount: 6 });
    const reduced = { usedBytes: 5 * image.length, entryCount: 5, limitMiB: 50, paused: false };
    await expect(policy(page, 'configureImageCache', { limitMiB: 50 })).resolves.toEqual(reduced);
    const newPath = cover(7, 'artist');
    remote.replies.set(newPath, { body: image });
    await expectImage(page, newPath, image.length);
    await expect.poll(() => page.evaluate(async name => (await (await caches.open(name)).keys())
      .map(entry => new URL(entry.url).search).sort(), legacyCache))
      .toEqual([old, first, cover(5), last, newPath].map(path => new URL(path, remote.origin).search));
    await expect(policy(page)).resolves.toEqual(reduced);
    remote.replies.delete(first);
    await expect(requestImage(page, first)).resolves.toMatchObject({ status: 404 });
    await remote.close();
    await expectImage(page, old, image.length);
    await expect(requestImage(page, older)).resolves.toEqual({ offline: true });
  } finally {
    await remote.close();
  }
});

test('clear isolates held and paused requests across resume and worker replacement while preserving other storage', async ({ page }) => {
  const remote = await fixture();
  const data = Buffer.from('recent artwork');
  const first = cover(21, 'artist');
  const pending = cover(22, 'custom');
  const paused = cover(23);
  const fresh = cover(24, 'custom');
  const privateImage = '/api/sources/test/cover?id=00000000-0000-4000-8000-000000000021';
  const redirected = cover(25);
  const wrongQuery = first + '&other=1';
  try {
    await page.goto(remote.origin);
    await register(page);
    await policy(page, 'configureImageCache', { limitMiB: 75 });
    await page.evaluate(async () => {
      const unrelated = await caches.open('fixture-local-download');
      await unrelated.put('/saved-local-cover', new Response('keep locally saved cover'));
    });
    for (const path of [first, privateImage, wrongQuery]) {
      remote.replies.set(path, { body: data });
      await expectImage(page, path, data.length);
    }
    let redirectFollowed = false;
    remote.replies.get(privateImage).received = () => { redirectFollowed = true; };
    remote.replies.set(redirected, { status: 302, location: privateImage });
    await expect(requestImage(page, redirected)).resolves.toEqual({ offline: true });
    expect(redirectFollowed).toBe(false);
    await expect.poll(() => policy(page)).toEqual({ usedBytes: data.length, entryCount: 1, limitMiB: 75, paused: false });

    const beforeClear = holdImage(remote, pending, data);
    const oldRequest = requestImage(page, pending);
    await beforeClear.arrive;
    const empty = { usedBytes: 0, entryCount: 0, limitMiB: 75 };
    await expect(policy(page, 'clearImageCache')).resolves.toEqual({ ...empty, paused: true });

    const whilePaused = holdImage(remote, paused, data);
    const pausedRequest = requestImage(page, paused);
    await whilePaused.arrive;
    await expect(policy(page, 'resumeImageCache')).resolves.toEqual({ ...empty, paused: false });
    beforeClear.release();
    whilePaused.release();
    await expect(oldRequest).resolves.toMatchObject({ status: 200, bytes: data.length });
    await expect(pausedRequest).resolves.toMatchObject({ status: 200, bytes: data.length });
    for (const path of [pending, paused]) remote.replies.set(path, { status: 503 });
    await expect(requestImage(page, pending)).resolves.toMatchObject({ status: 503 });
    await expect(requestImage(page, paused)).resolves.toMatchObject({ status: 503 });
    await expect(policy(page)).resolves.toEqual({ ...empty, paused: false });

    await expect(policy(page, 'clearImageCache')).resolves.toEqual({ ...empty, paused: true });
    // Simulate one late physical write from the original, pre-policy worker's old cache.
    await page.evaluate(async path => {
      await (await caches.open('groovebox-album-artwork-v1')).put(path, new Response('obsolete', {
        headers: { 'Content-Type': 'image/png' },
      }));
    }, first);
    remote.update();
    await advanceWorker(page);
    await expect(policy(page)).resolves.toEqual({ ...empty, paused: true });
    await expect(page.evaluate(async legacy => {
      const names = await caches.keys();
      const cache = await caches.open('fixture-local-download');
      return {
        legacy: names.includes(legacy),
        shell: names.some(name => name === 'groovebox-shell-image-fixture-2'),
        retained: await (await cache.match('/saved-local-cover')).text(),
      };
    }, 'groovebox-album-artwork-v1')).resolves.toEqual({ legacy: false, shell: true, retained: 'keep locally saved cover' });

    await expect(policy(page, 'resumeImageCache')).resolves.toEqual({ ...empty, paused: false });
    remote.replies.set(fresh, { body: data });
    await expectImage(page, fresh, data.length);
    await expect.poll(() => policy(page)).toEqual({ usedBytes: data.length, entryCount: 1, limitMiB: 75, paused: false });
    await remote.close();
    await expectImage(page, fresh, data.length);
    for (const path of [first, pending, paused, privateImage, wrongQuery]) {
      await expect(requestImage(page, path)).resolves.toEqual({ offline: true });
    }
    await page.reload();
    await expect(page).toHaveTitle('Artwork Cache Fixture');
  } finally {
    await remote.close();
  }
});
