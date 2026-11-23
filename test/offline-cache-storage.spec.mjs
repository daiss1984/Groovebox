import { expect, test } from '@playwright/test';

const moduleUrl = '/offline.js';
const fixture = '/assets/cover-1.jpg';

test('migrates v2 audio and attached artwork as pinned and promotes an existing automatic copy without another download', async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('groovebox.offline', 2);
    open.onupgradeneeded = () => {
      const audio = open.result.createObjectStore('audio', { keyPath: 'id' });
      const cover = open.result.createObjectStore('folder-covers', { keyPath: 'id' });
      audio.put({ id: 'legacy', binary: { buffer: Uint8Array.of(5, 4, 3).buffer, type: 'audio/mpeg' } });
      cover.put({ id: 'legacy', source: '/old-cover', binary: { buffer: Uint8Array.of(7, 8).buffer, type: 'image/jpeg' } });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { open.result.close(); resolve(); };
  }));
  let networkReads = 0;
  await page.route('**/must-not-download.mp3', route => { networkReads++; return route.abort(); });
  const observed = await page.evaluate(async moduleUrl => {
    const cache = await import(moduleUrl);
    await cache.hydrateOffline();
    const initial = await cache.readOfflineCachePolicy();
    const track = { id: 'promote', src: '/must-not-download.mp3' };
    const data = new Blob([Uint8Array.of(6, 7, 8, 9)], { type: 'audio/mpeg' });
    await cache.saveOfflineTrack(track, data, { mode: 'automatic', generation: initial.generation });
    const automatic = cache.offlineTrackMode(track.id);
    await cache.cacheAudio(track);
    const pinned = cache.offlineTrackMode(track.id);
    const cleared = await cache.clearAutomaticAudioCache();
    const legacy = Array.from(new Uint8Array(await (await cache.readOfflineBlob('legacy')).arrayBuffer()));
    const promoted = Array.from(new Uint8Array(await (await cache.readOfflineBlob(track.id)).arrayBuffer()));
    return { initial, automatic, pinned, cleared, legacy, promoted };
  }, moduleUrl);
  expect(observed.initial).toEqual({ limitMiB: 1024, generation: 0, paused: false, automaticBytes: 0, automaticCount: 0,
    pinnedBytes: 3, pinnedCount: 1, automaticArtworkBytes: 0, pinnedArtworkBytes: 2, attachedArtworkBytes: 2, totalBytes: 5 });
  expect(observed.automatic).toBe('automatic');
  expect(observed.pinned).toBe('pinned');
  expect(observed.cleared).toMatchObject({ generation: 1, paused: true, automaticCount: 0, pinnedCount: 2,
    pinnedBytes: 7, attachedArtworkBytes: 2, totalBytes: 9 });
  expect(observed.legacy).toEqual([5, 4, 3]);
  expect(observed.promoted).toEqual([6, 7, 8, 9]);
  expect(networkReads).toBe(0);
  await page.reload();
  expect(await page.evaluate(async url => (await import(url)).readOfflineCachePolicy(), moduleUrl)).toEqual(observed.cleared);
});

test('cross-tab clearing fences an in-flight write after resume and keeps the retired playback URL usable', async ({ page, context }) => {
  const peer = await context.newPage();
  try {
    await Promise.all([page.goto(fixture), peer.goto(fixture)]);
    await page.evaluate(async url => {
      const cache = await import(url);
      await cache.hydrateOffline();
      const blob = new Blob([Uint8Array.of(1, 2, 3)], { type: 'audio/mpeg' });
      await cache.saveOfflineTrack({ id: 'playing' }, blob, { mode: 'automatic', generation: await cache.offlineCacheGeneration() });
      window.fixtureCachedAudio = await cache.loadOfflineUrl('playing');
      cache.subscribeOfflineCache(stats => { window.fixtureCachePauses = stats.paused; });
    }, moduleUrl);
    let release;
    let requestStarted;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { requestStarted = resolve; });
    let requests = 0;
    const arrived = () => { if (++requests === 2) requestStarted(); };
    await page.route('**/held-audio.mp3', async route => {
      arrived();
      await gate;
      await route.fulfill({ contentType: 'audio/mpeg', body: Buffer.from([4, 5]) });
    });
    const cover = '/api/metadata/artwork/image?id=12345678-1234-4abc-8abc-1234567890ab';
    await page.route('**' + cover, async route => {
      arrived();
      await gate;
      await route.fulfill({ contentType: 'image/png', body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
    });
    const stale = page.evaluate(async ({ url, coverSource }) => {
      const cache = await import(url);
      const options = { mode: 'automatic', generation: await cache.offlineCacheGeneration() };
      return Promise.all([
        cache.cacheAudio({ id: 'late-audio', src: '/held-audio.mp3' }, options).catch(error => error.code),
        cache.saveOfflineTrack({ id: 'late-cover' }, new Blob(['audio'], { type: 'audio/mpeg' }), { ...options, coverSource })
          .catch(error => error.code),
      ]);
    }, { url: moduleUrl, coverSource: cover });
    try {
      await started;
      const cleared = await peer.evaluate(async url => (await import(url)).clearAutomaticAudioCache(), moduleUrl);
      expect(cleared).toMatchObject({ paused: true, generation: 1, automaticCount: 0 });
      await expect.poll(() => page.evaluate(() => window.fixtureCachePauses)).toBe(true);
      const retained = await page.evaluate(async url => {
        const cache = await import(url);
        const available = cache.hasOffline('playing');
        const response = await fetch(window.fixtureCachedAudio);
        return { available, packed: [...new Uint8Array(await response.arrayBuffer())] };
      }, moduleUrl);
      expect(retained).toEqual({ available: false, packed: [1, 2, 3] });
      const resumed = await peer.evaluate(async url => (await import(url)).resumeAutomaticAudioCache(), moduleUrl);
      expect(resumed).toMatchObject({ paused: false, generation: 2, automaticCount: 0 });
    } finally { release(); }
    expect(await stale).toEqual(['offline-cache-stale', 'offline-cache-stale']);
    expect(await peer.evaluate(async url => (await import(url)).readOfflineCachePolicy(), moduleUrl)).toMatchObject({ automaticCount: 0 });
  } finally { await peer.close(); }
});

test('evicts by recent reads under a real 200 MiB byte budget and keeps the active copy and manual download', async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto(fixture);
  const observed = await page.evaluate(async url => {
    const cache = await import(url);
    const limit = await cache.configureOfflineCache({ limitMiB: 200 });
    const options = { mode: 'automatic', generation: limit.generation };
    const chunk = new Blob([new Uint8Array(1024 * 1024)]);
    const body = new Blob(Array(97).fill(chunk), { type: 'audio/mpeg' });
    await cache.saveOfflineTrack({ id: 'manual' }, new Blob(['two'], { type: 'audio/mpeg' }));
    await cache.saveOfflineTrack({ id: 'A' }, body, options);
    await cache.saveOfflineTrack({ id: 'B' }, body, options);
    const playback = await cache.loadOfflineUrl('A');
    await cache.saveOfflineTrack({ id: 'C' }, body, options);
    const survived = ['A', 'B', 'C'].filter(cache.hasOffline);
    await cache.readOfflineBlob('C');
    await cache.saveOfflineTrack({ id: 'D' }, body, options);
    const final = ['A', 'B', 'C', 'D', 'manual'].filter(cache.hasOffline);
    const response = await fetch(playback);
    await response.body.cancel();
    return { survived, final, size: Number(response.headers.get('Content-Length')), stats: await cache.readOfflineCachePolicy() };
  }, moduleUrl);
  expect(observed.survived).toEqual(['A', 'C']);
  expect(observed.final).toEqual(['C', 'D', 'manual']);
  expect(observed.size).toBe(97 * 1024 * 1024);
  expect(observed.stats).toMatchObject({ limitMiB: 200, automaticCount: 2, automaticBytes: 194 * 1024 * 1024, pinnedCount: 1, pinnedBytes: 3 });
});
