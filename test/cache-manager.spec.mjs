import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { expect, test as base } from '@playwright/test';

const coverUrl = '/api/artwork/cover?id=7d02de44-01db-47c2-98b7-aef745a4592c';

const test = base.extend({
  cacheFixture: async ({ baseURL }, use) => {
    const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    const cover = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
    const requests = [];
    const fixture = { audio, requests, firstRequest: Promise.resolve() };
    const server = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url, baseURL);
      if (url.pathname === '/api/baidu/status') {
        outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ configured: true, connected: true }));
        return;
      }
      if (url.pathname === '/api/baidu/stream') {
        const id = url.searchParams.get('id');
        requests.push(id);
        const respond = () => outgoing.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': audio.length }).end(audio);
        if (id === '1') void fixture.firstRequest.then(respond);
        else respond();
        return;
      }
      if (url.pathname + url.search === coverUrl) {
        outgoing.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': cover.length }).end(cover);
        return;
      }
      const proxy = request(new URL(url.pathname + url.search, baseURL), {
        method: incoming.method, headers: incoming.headers,
      }, response => response.pipe(outgoing.writeHead(response.statusCode, response.headers)));
      proxy.on('error', () => outgoing.writeHead(502).end());
      incoming.pipe(proxy);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    fixture.origin = 'http://127.0.0.1:' + server.address().port;
    try {
      await use(fixture);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  },
});
test.use({ serviceWorkers: 'allow' });

const listId = 'cache-manager-list';
const listName = '缓存管理测试歌单';
const titles = ['预缓存样本一', '预缓存样本二', '预缓存样本三'];
const ids = titles.map((_, index) => 'baidu:' + (index + 1));
const action = (page, name) => page.locator('[data-action="' + name + '"]');
const navigate = (page, view) => page.locator('#sidebar [data-nav="' + view + '"]').click();
const openList = page => page.locator('#playlist-nav').getByRole('button', { name: listName }).click();
const manager = page => page.getByRole('dialog').locator('[data-cache-manager]');
const cache = page => page.evaluate(async () => {
  const { readOfflineCachePolicy } = await import('/offline.js');
  return readOfflineCachePolicy();
});
const imageCache = page => page.evaluate(async () => (await import('/image-cache-client.js')).readImageCachePolicy());
const entries = page => page.evaluate(async ids => {
  const { offlineTrackMode } = await import('/offline.js');
  return ids.map(id => offlineTrackMode(id) ?? null);
}, ids);

async function setup(page, fixture, firstTracks) {
  await page.addInitScript(({ listId, listName, titles, ids, firstTracks }) => {
    const key = 'groovebox.state.v1';
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({
      settings: { demos: false, language: 'zh-CN', autoMatchLyrics: false, onlineCover: false, artistImageEngine: false },
      tracks: titles.map((title, index) => ({
        id: ids[index], title, artist: '缓存演示艺人', album: '缓存演示唱片',
        provider: 'baidu', src: '/api/baidu/stream?id=' + (index + 1),
      })),
      playlists: [{ id: listId, name: listName, tracks: firstTracks }],
      onlineLyrics: [[ids[0], [{ time: 2, text: '缓存歌词样本' }]]],
    }));
  }, { listId, listName, titles, ids, firstTracks });

  await page.goto(fixture.origin);
  await openList(page);
}

async function trackAction(page, index, name) {
  await page.locator('#content [data-action="track-menu"][data-id="' + ids[index] + '"]').click();
  await page.getByRole('dialog').locator('[data-action="' + name + '"]').click();
}

async function addTrack(page, index) {
  await navigate(page, 'songs');
  await trackAction(page, index, 'pick-playlist');
  await page.getByRole('dialog').getByRole('button', { name: listName }).click();
  await openList(page);
  await expect(page.locator('#content').getByText(titles[index], { exact: true })).toBeVisible();
}

async function openManager(page) {
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await navigate(page, 'settings');
  await page.locator('#content [data-action="cache-manager"]').click();
  await expect(manager(page).locator('#audio-cache-limit')).toBeEnabled();
}

test('one-shot pre-cache completes only the original playlist membership and allows a new explicit run', async ({ page, cacheFixture }) => {
  const held = Promise.withResolvers();
  cacheFixture.firstRequest = held.promise;
  await setup(page, cacheFixture, [ids[0]]);
  const { requests } = cacheFixture;
  try {
    await action(page, 'precache-playlist').click();
    await expect.poll(() => requests).toEqual(['1']);
    await expect(action(page, 'cancel-playlist-precache')).toBeVisible();
    await addTrack(page, 1);
    await expect(action(page, 'cancel-playlist-precache')).toBeVisible();
  } finally {
    held.resolve();
  }
  await expect(action(page, 'precache-playlist')).toBeVisible();
  await expect.poll(() => entries(page)).toEqual(['automatic', null, null]);
  expect(requests).toEqual(['1']);

  await page.reload();
  await expect(action(page, 'precache-playlist')).toBeEnabled();
  await expect(page.locator('[data-playlist-cache-status]')).toContainText('已缓存 1 / 2 首');
  await action(page, 'precache-playlist').click();
  await expect.poll(() => entries(page)).toEqual(['automatic', 'automatic', null]);
  await expect(action(page, 'precache-playlist')).toBeVisible();
  expect(requests).toEqual(['1', '2']);
});

test('deleting a downloaded track cancels a running one-shot before it can fetch that track again', async ({ page, cacheFixture }) => {
  const held = Promise.withResolvers();
  cacheFixture.firstRequest = held.promise;
  await setup(page, cacheFixture, ids.slice(0, 2));
  const { requests } = cacheFixture;
  await page.evaluate(async id => {
    const { cacheAudio, offlineCacheGeneration } = await import('/offline.js');
    await cacheAudio({ id, provider: 'baidu', src: '/api/baidu/stream?id=2' }, {
      mode: 'automatic', generation: await offlineCacheGeneration(),
    });
  }, ids[1]);
  await expect.poll(() => entries(page)).toEqual([null, 'automatic', null]);
  expect(requests).toEqual(['2']);
  try {
    await action(page, 'precache-playlist').click();
    await expect.poll(() => requests).toEqual(['2', '1']);
    await expect(action(page, 'cancel-playlist-precache')).toBeVisible();
    await navigate(page, 'offline');
    await page.locator('#content [data-action="remove-download"][data-id="' + ids[1] + '"]').click();
    await page.getByRole('dialog').locator('[data-action="confirm-remove-download"]').click();
    await expect(page.locator('#content tr[data-track="' + ids[1] + '"]')).toHaveCount(0);
    await expect.poll(() => entries(page)).toEqual([null, null, null]);
  } finally {
    held.resolve();
  }
  await openList(page);
  await expect(action(page, 'precache-playlist')).toBeEnabled();
  await expect(page.locator('[data-playlist-cache-status]')).toContainText('已缓存 0 / 2 首');
  expect(await entries(page)).toEqual([null, null, null]);
  expect(requests).toEqual(['2', '1']);
});

test('cache manager persists limits and clears temporary audio while pinned copies and device downloads survive', async ({ page, cacheFixture }) => {
  await setup(page, cacheFixture, ids);
  const { requests, audio } = cacheFixture;
  await action(page, 'precache-playlist').click();
  await expect.poll(() => entries(page)).toEqual(['automatic', 'automatic', 'automatic']);
  await expect(action(page, 'precache-playlist')).toBeVisible();
  await trackAction(page, 1, 'pin-offline');
  await expect.poll(() => entries(page)).toEqual(['automatic', 'pinned', 'automatic']);

  const downloadPromise = page.waitForEvent('download');
  await trackAction(page, 2, 'save-original-audio');
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(await readFile(downloadPath)).toEqual(audio);
  await expect.poll(() => entries(page)).toEqual(['automatic', 'pinned', 'pinned']);

  await openManager(page);
  const audioLimit = manager(page).locator('#audio-cache-limit');
  const imageLimit = manager(page).locator('#image-cache-limit');
  await expect(audioLimit).toHaveValue('1024');
  await expect(imageLimit).toHaveValue('250');
  await expect(imageLimit).toBeEnabled();
  await expect(manager(page).locator('[data-audio-cache-stats]')).toContainText('1 首');
  await expect(manager(page).getByText(/固定离线音频.*2 首/)).toBeVisible();
  await audioLimit.fill('0');
  await imageLimit.fill('0');
  await manager(page).locator('[data-form="cache-budgets"] button[type="submit"]').click();
  await expect(audioLimit).toHaveValue('200');
  await expect(imageLimit).toHaveValue('50');

  await page.reload();
  await page.locator('#content [data-action="cache-manager"]').click();
  await expect(audioLimit).toHaveValue('200');
  await expect(imageLimit).toHaveValue('50');
  await manager(page).locator('[data-action="clear-audio-cache"]').click();
  await page.getByRole('dialog').locator('[data-action="confirm-managed-cache-clear"][data-id="audio"]').click();
  await expect.poll(() => cache(page)).toMatchObject({
    limitMiB: 200, automaticCount: 0, pinnedCount: 2, paused: true,
  });
  await expect(manager(page).locator('[data-action="resume-managed-caches"]')).toBeVisible();
  await expect.poll(() => entries(page)).toEqual([null, 'pinned', 'pinned']);
  await page.keyboard.press('Escape');
  await navigate(page, 'offline');
  await expect(page.locator('#content').getByText(titles[0], { exact: true })).toHaveCount(0);
  await expect(page.locator('#content').getByText(titles[1], { exact: true })).toBeVisible();
  await expect(page.locator('#content').getByText(titles[2], { exact: true })).toBeVisible();
  expect(await readFile(downloadPath)).toEqual(audio);
  expect(requests).toEqual(['1', '2', '3']);
});

test('ongoing playlist cache skips storage-evicted copies across reload while admitting a newly added track', async ({ page, cacheFixture }) => {
  await setup(page, cacheFixture, ids.slice(0, 2));
  const { requests } = cacheFixture;
  await action(page, 'toggle-playlist-cache').click();
  await expect.poll(() => entries(page)).toEqual(['automatic', 'automatic', null]);
  await expect(page.locator('[data-playlist-cache-status]')).toContainText('已缓存 2 / 2 首');
  expect(requests).toEqual(['1', '2']);

  // Remove the bytes directly as storage reclamation does, without the app's manual-removal exclusion.
  await page.evaluate(async id => (await import('/offline.js')).removeOffline(id), ids[0]);
  await expect.poll(() => entries(page)).toEqual([null, 'automatic', null]);
  await page.reload();
  await expect(action(page, 'toggle-playlist-cache')).toHaveText('停止自动缓存');
  await expect(page.locator('[data-playlist-cache-status]')).toContainText('已缓存 1 / 2 首');
  await addTrack(page, 2);
  await expect.poll(() => entries(page)).toEqual([null, 'automatic', 'automatic']);
  await expect(page.locator('[data-playlist-cache-status]')).toContainText('已缓存 2 / 3 首');
  expect(requests).toEqual(['1', '2', '3']);
});

test('finishing a queued cache clear leaves the dismissed confirmation closed', async ({ page, cacheFixture }) => {
  await setup(page, cacheFixture, ids.slice(0, 1));
  await openManager(page);
  await manager(page).locator('[data-action="clear-audio-cache"]').click();
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('groovebox.offline');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('cache-policy', 'readwrite');
      const store = transaction.objectStore('cache-policy');
      let keepOpen = true;
      window.releaseCacheTransaction = () => { keepOpen = false; };
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => reject(transaction.error);
      function hold() {
        store.get('audio').onsuccess = () => {
          if (keepOpen) hold();
          resolve();
        };
      }
      hold();
    };
  }));
  try {
    const confirmation = page.getByRole('dialog').locator('[data-action="confirm-managed-cache-clear"]');
    await confirmation.click();
    await expect(confirmation).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await page.evaluate(() => window.releaseCacheTransaction());
  }
  await expect(page.getByRole('status').filter({ hasText: '已清理所选缓存。' })).toBeVisible();
  await expect.poll(() => cache(page)).toMatchObject({ paused: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a delayed image policy cannot replace the newer audio clear from another tab', async ({ page, context, cacheFixture }) => {
  await setup(page, cacheFixture, [ids[0]]);
  await action(page, 'precache-playlist').click();
  await expect.poll(() => entries(page)).toEqual(['automatic', null, null]);
  await expect(action(page, 'precache-playlist')).toBeEnabled();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await navigate(page, 'settings');

  await page.evaluate(() => {
    const post = ServiceWorker.prototype.postMessage;
    const getAll = IDBObjectStore.prototype.getAll;
    const pending = window.heldCachePolicies = {};
    ServiceWorker.prototype.postMessage = function (message, ...args) {
      if (message?.action !== 'artwork-cache-policy' || pending.forward) return post.call(this, message, ...args);
      pending.forward = () => post.call(this, message, ...args);
    };
    IDBObjectStore.prototype.getAll = function (...args) {
      const request = getAll.apply(this, args);
      if (pending.forward && !pending.audio && this.name === 'cache-entries' && this.transaction.mode === 'readonly') {
        this.transaction.addEventListener('complete', () => {
          pending.audio = request.result.map(({ id, mode }) => ({ id, mode }));
        }, { once: true });
      }
      return request;
    };
    pending.release = () => {
      ServiceWorker.prototype.postMessage = post;
      IDBObjectStore.prototype.getAll = getAll;
      pending.forward?.();
    };
  });
  const peer = await context.newPage();
  try {
    await peer.goto(cacheFixture.origin + '/assets/cover-1.jpg');
    await page.locator('#content [data-action="cache-manager"]').click();
    await expect.poll(() => page.evaluate(() => window.heldCachePolicies.audio)).toEqual([{ id: ids[0], mode: 'automatic' }]);
    await expect(manager(page).getByRole('status')).toHaveText('正在读取…');
    const cleared = await peer.evaluate(async () => (await import('/offline.js')).clearAutomaticAudioCache());
    expect(cleared).toMatchObject({ generation: 1, automaticCount: 0, paused: true });
    await expect.poll(() => entries(page)).toEqual([null, null, null]);
  } finally {
    await page.evaluate(() => window.heldCachePolicies.release());
    await peer.close();
  }
  await expect(manager(page).locator('[data-audio-cache-stats]')).toContainText('0 首');
  await expect(manager(page).locator('[data-image-cache-stats]')).toContainText('0 张');
  await expect(manager(page).locator('[data-action="resume-managed-caches"]')).toBeVisible();
});

test('clear all empties audio, image and online lyrics caches while local and pinned audio still play byte for byte', async ({ page, cacheFixture }) => {
  await setup(page, cacheFixture, ids.slice(0, 2));
  await action(page, 'precache-playlist').click();
  await expect.poll(() => entries(page)).toEqual(['automatic', 'automatic', null]);
  await expect(action(page, 'precache-playlist')).toBeVisible();
  await trackAction(page, 1, 'pin-offline');
  await expect.poll(() => entries(page)).toEqual(['automatic', 'pinned', null]);

  const localAudio = await readFile(new URL('../public/assets/demo-2.m4a', import.meta.url));
  await page.locator('#import-files').setInputFiles({ name: '测试艺人 - 本地缓存原件.m4a', mimeType: 'audio/mp4', buffer: localAudio });
  await expect(page.locator('#toast')).toContainText('已导入或更新 1 首本地歌曲');
  await openManager(page);
  await page.evaluate(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not load artwork fixture');
    await response.arrayBuffer();
  }, coverUrl);
  await expect.poll(() => imageCache(page)).toMatchObject({ entryCount: 1, paused: false });
  const onlineLyrics = () => page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')).onlineLyrics);
  expect(await onlineLyrics()).toHaveLength(1);
  await manager(page).locator('[data-action="clear-all-caches"]').click();
  await page.getByRole('dialog').locator('[data-action="confirm-managed-cache-clear"][data-id="all"]').click();
  await expect(manager(page).locator('[data-audio-cache-stats]')).toContainText('0 首');
  await expect(manager(page).locator('[data-image-cache-stats]')).toContainText('0 张');
  await expect(manager(page).locator('[data-lyric-cache-stats]')).toContainText('0 MiB');
  await expect(page.locator('#toast')).toHaveText('已清理所选缓存。');
  expect(await onlineLyrics()).toEqual([]);
  await expect.poll(() => cache(page)).toMatchObject({ automaticCount: 0, pinnedCount: 1, paused: true });
  expect(await imageCache(page)).toMatchObject({ entryCount: 0, usedBytes: 0, paused: true });

  await page.keyboard.press('Escape');
  await navigate(page, 'offline');
  await expect(page.locator('#content tr[data-track="' + ids[0] + '"]')).toHaveCount(0);
  const player = page.locator('#audio');
  const verifyPlayback = async (row, original) => {
    const previous = await player.evaluate(element => element.currentSrc);
    await row.locator('[data-action="play-row"]').click();
    await expect.poll(() => player.evaluate(element => element.currentSrc)).not.toBe(previous);
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
    const digest = await player.evaluate(async element => {
      if (!element.currentSrc.startsWith('blob:')) return '';
      const response = await fetch(element.currentSrc);
      const hash = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
      return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    });
    expect(digest).toBe(createHash('sha256').update(original).digest('hex'));
  };
  await verifyPlayback(page.locator('#content tr[data-track="' + ids[1] + '"]'), cacheFixture.audio);
  await verifyPlayback(page.locator('#content tr[data-track^="local:"]'), localAudio);
  expect(cacheFixture.requests).toEqual(['1', '2']);
});
