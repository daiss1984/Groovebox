import { expect, test } from '@playwright/test';

const fixture = '/assets/cover-1.jpg';
const moduleUrl = '/cloud-catalog.js';

test('persists twenty thousand metadata rows with their folder graph and takes a snapshot of inputs', async ({ page }) => {
  await page.goto(fixture);
  const first = await page.evaluate(async url => {
    const { commitCloudCatalog } = await import(url);
    const sourceId = '7ed869d6-4dbe-8980-8a4b-51837f6fe1fc';
    const tracks = Array.from({ length: 20_000 }, (_, index) => ({
      id: sourceId + ':' + index,
      src: '/api/sources/' + sourceId + '/stream?id=' + index,
      cover: '/api/sources/' + sourceId + '/cover?id=' + index,
      path: '/Music/Long WebDAV Fixture Name ' + index + '.mp3',
      title: 'Track ' + index,
      lyrics: [[0, 'Words. '.repeat(56)]],
    }));
    const snapshots = [['/', ['/Music'], []], ['/Music', [], tracks.map(track => track.id), 'Music']];
    const result = commitCloudCatalog(sourceId, { tracks, snapshots }, { expectedRevision: null });
    tracks[19_999].title = 'Mutated before transaction creation';
    snapshots[1][2].pop();
    const committed = await result;
    return { sourceId, revision: committed.revision, trackCount: committed.tracks.length };
  }, moduleUrl);
  expect(first.trackCount).toBe(20_000);
  expect(first.revision).toMatch(/^[a-z\d-]{36}$/);
  await page.reload();
  const restored = await page.evaluate(async url => {
    const { hydrateCloudCatalogs } = await import(url);
    const [source] = await hydrateCloudCatalogs();
    return {
      sourceId: source.sourceId, revision: source.revision, trackCount: source.tracks.length,
      lastTrack: source.tracks.at(-1).title, lastFolder: source.snapshots[1][2].at(-1), folderSize: source.snapshots[1][2].length,
      localBytes: localStorage.length,
    };
  }, moduleUrl);
  expect(restored).toEqual({ ...first, lastTrack: 'Track 19999', lastFolder: first.sourceId + ':19999', folderSize: 20_000, localBytes: 0 });
});

test('uses cross-tab revision guards, preserves unrelated sources on selective replacement and reports durable revisions', async ({ page, context }) => {
  await page.goto(fixture);
  const peer = await context.newPage();
  try {
    await peer.goto(fixture);
    await peer.evaluate(async url => {
      const { subscribeCloudCatalogs } = await import(url);
      window.catalogChanges = [];
      subscribeCloudCatalogs(change => window.catalogChanges.push(...change.sources));
    }, moduleUrl);
    const initial = await page.evaluate(async url => {
      const { commitCloudCatalog } = await import(url);
      return Promise.all(['baidu', 'gdrive'].map(sourceId => commitCloudCatalog(sourceId, {
        tracks: [{ id: sourceId + ':track', title: sourceId }],
        snapshots: [['/', [], [sourceId + ':track']]],
      }, { expectedRevision: null })));
    }, moduleUrl);
    await expect.poll(() => peer.evaluate(() => window.catalogChanges.length)).toBe(2);
    expect(await peer.evaluate(() => window.catalogChanges)).toEqual(expect.arrayContaining(initial.map(({ sourceId, revision }) => ({ sourceId, revision }))));
    const updated = await peer.evaluate(async ({ url, initial }) => {
      const { updateCloudCatalogTracks } = await import(url);
      return updateCloudCatalogTracks('baidu', {
        upsert: [{ id: 'baidu:track', title: 'Peer edit' }, { id: 'baidu:new', title: 'Added' }],
      }, { expectedRevision: initial[0].revision });
    }, { url: moduleUrl, initial });
    expect(updated.snapshots).toEqual(initial[0].snapshots);
    expect(updated.tracks.map(track => track.title)).toEqual(['Peer edit', 'Added']);
    const observed = await page.evaluate(async ({ url, initial, updated }) => {
      const { commitCloudCatalog, readCloudCatalogs, replaceCloudCatalogs } = await import(url);
      const stale = await commitCloudCatalog('baidu', { tracks: [], snapshots: [] }, {
        expectedRevision: initial[0].revision,
      }).catch(error => error.code);
      const unexpectedSource = await replaceCloudCatalogs([], {
        expectedRevisions: new Map([['baidu', updated.revision]]), replaceAll: true,
      }).catch(error => error.code);
      const original = await readCloudCatalogs();
      const replacement = (await replaceCloudCatalogs([{ sourceId: 'dropbox', tracks: [], snapshots: [] }], {
        expectedRevisions: new Map([['baidu', updated.revision], ['dropbox', null]]),
      }))[0];
      const retained = await readCloudCatalogs();
      await replaceCloudCatalogs([], { expectedRevisions: new Map(retained.map(item => [item.sourceId, item.revision])), replaceAll: true });
      return { stale, unexpectedSource, original, replacement, retained, emptied: await readCloudCatalogs() };
    }, { url: moduleUrl, initial, updated });
    expect(observed.stale).toBe('cloud-catalog-conflict');
    expect(observed.unexpectedSource).toBe('cloud-catalog-conflict');
    expect(observed.original).toEqual([updated, initial[1]]);
    expect(observed.retained).toEqual([observed.replacement, initial[1]]);
    expect(observed.emptied).toEqual([]);
  } finally {
    await peer.close();
  }
});

test('rolls back writes and revisions after quota failure or cancellation inside an IndexedDB replacement', async ({ page }) => {
  await page.goto(fixture);
  const result = await page.evaluate(async url => {
    const { commitCloudCatalog, readCloudCatalogs, replaceCloudCatalogs, subscribeCloudCatalogs } = await import(url);
    const initial = await Promise.all(['baidu', 'gdrive'].map(sourceId => commitCloudCatalog(sourceId, {
      tracks: [{ id: sourceId + ':track', title: 'Original' }], snapshots: [],
    }, { expectedRevision: null })));
    const revisions = new Map(initial.map(({ sourceId, revision }) => [sourceId, revision]));
    const changes = [];
    subscribeCloudCatalogs(change => changes.push(change));
    const replacements = initial.map(({ sourceId }) => ({
      sourceId, tracks: [{ id: sourceId + ':new', title: 'Replacement' }], snapshots: [],
    }));
    const controller = new AbortController();
    const put = IDBObjectStore.prototype.put;
    try {
      IDBObjectStore.prototype.put = function (data) {
        if (data.sourceId === 'gdrive') throw new DOMException('Simulated quota', 'QuotaExceededError');
        return put.call(this, data);
      };
      const quota = await replaceCloudCatalogs(replacements, { expectedRevisions: revisions }).catch(error => [error.code, error.cause?.name]);
      const afterQuota = await readCloudCatalogs();
      IDBObjectStore.prototype.put = function (data) {
        const queued = put.call(this, data);
        if (data.sourceId === 'baidu') controller.abort('User canceled');
        return queued;
      };
      const canceled = await replaceCloudCatalogs(replacements, { expectedRevisions: revisions, signal: controller.signal }).catch(error => error.name);
      return { initial, quota, afterQuota, canceled, afterCancel: await readCloudCatalogs(), changes };
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  }, moduleUrl);
  expect(result.quota).toEqual(['cloud-catalog-storage', 'QuotaExceededError']);
  expect(result.canceled).toBe('AbortError');
  expect(result.afterQuota).toEqual(result.initial);
  expect(result.afterCancel).toEqual(result.initial);
  expect(result.changes).toEqual([]);
});

test('rejects credentials and binary data and exposes corrupt durable rows as storage errors', async ({ page }) => {
  await page.goto(fixture);
  const result = await page.evaluate(async url => {
    const { commitCloudCatalog, readCloudCatalogs } = await import(url);
    const invalidInputs = [
      { password: 'test fixture' },
      { embeddedTags: { cover: new Blob(['not metadata']) } },
      { embeddedTags: Object.assign([], { password: 'test fixture' }) },
      { cover: '/api/baidu/cover?id=a&access_token=fixture' },
      { src: '/api/gdrive/stream?id=b' },
      { id: 'other:a' },
    ];
    const invalid = await Promise.all(invalidInputs.map(fields => commitCloudCatalog('baidu', {
      tracks: [{ id: 'baidu:a', ...fields }], snapshots: [],
    }, { expectedRevision: null }).catch(error => error.code)));
    const empty = await readCloudCatalogs();
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('groovebox.cloud-catalog');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const writing = database.transaction('sourceCatalogs', 'readwrite');
        writing.objectStore('sourceCatalogs').put({ sourceId: 'baidu', revision: 'corrupt', tracks: [], snapshots: [] });
        writing.oncomplete = () => { database.close(); resolve(); };
        writing.onabort = () => { database.close(); reject(writing.error); };
      };
    });
    const corrupt = await readCloudCatalogs().catch(error => error.code);
    const overwrite = await commitCloudCatalog('baidu', { tracks: [], snapshots: [] }, { expectedRevision: null }).catch(error => error.code);
    return { invalid, empty, corrupt, overwrite };
  }, moduleUrl);
  expect(result).toEqual({ invalid: Array(6).fill('cloud-catalog-invalid'), empty: [],
    corrupt: 'cloud-catalog-storage', overwrite: 'cloud-catalog-storage' });
});

test('reports a blocked catalog open and reopens storage on an explicit retry', async ({ page }) => {
  await page.goto(fixture);
  const result = await page.evaluate(async url => {
    const { readCloudCatalogs, commitCloudCatalog } = await import(url);
    const nativeOpen = IDBFactory.prototype.open;
    let lateHandleClosed = 0;
    const isolatedRequest = { result: { close: () => { lateHandleClosed++; } } };
    try {
      IDBFactory.prototype.open = function () {
        queueMicrotask(() => isolatedRequest.onblocked());
        return isolatedRequest;
      };
      const blocked = await readCloudCatalogs().catch(error => error.code);
      isolatedRequest.onsuccess();
      IDBFactory.prototype.open = nativeOpen;
      const row = await commitCloudCatalog('box', { tracks: [], snapshots: [] }, { expectedRevision: null });
      return { blocked, lateHandleClosed, recovered: (await readCloudCatalogs())[0]?.revision === row.revision };
    } finally {
      IDBFactory.prototype.open = nativeOpen;
    }
  }, moduleUrl);
  expect(result).toEqual({ blocked: 'cloud-catalog-blocked', lateHandleClosed: 1, recovered: true });
});
