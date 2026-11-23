import { expect, test } from '@playwright/test';

const fixture = '/assets/cover-1.jpg';
const moduleUrl = '/cloud-catalog.js';

test('upgrades the v1 catalog with its legacy scope, unchanged records and no pending restore', async ({ page }) => {
  await page.goto(fixture);
  const value = await page.evaluate(async url => {
    const record = { sourceId: 'baidu', revision: '603321c6-9eda-4d53-8d49-a33a14811d7a', tracks: [{ id: 'baidu:old' }], snapshots: [] };
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('groovebox.cloud-catalog', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('sourceCatalogs', { keyPath: 'sourceId' }).put(record);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => { open.result.close(); resolve(); };
    });
    const store = await import(url);
    return { legacy: store.legacyCloudCatalogScope, oldRecord: record, state: await store.readCloudCatalogState(),
      compat: await store.readCloudCatalogs() };
  }, moduleUrl);
  expect(value.legacy).toBe('groovebox.state.v1');
  expect(value.state).toEqual({ scope: value.legacy, records: [value.oldRecord] });
  expect(value.compat).toEqual([value.oldRecord]);
});

test('reads the pending and active scope without touching source records or rebinding a legacy reader', async ({ page }) => {
  await page.goto(fixture);
  const result = await page.evaluate(async url => {
    const store = await import(url);
    const transaction = IDBDatabase.prototype.transaction;
    const requests = [];
    const readControl = async () => {
      IDBDatabase.prototype.transaction = function (names, mode, ...options) {
        requests.push({ names, mode });
        return transaction.call(this, names, mode, ...options);
      };
      try { return await store.readCloudCatalogControl(); }
      finally { IDBDatabase.prototype.transaction = transaction; }
    };
    const prior = await readControl();
    const staged = await store.prepareCloudCatalogRestore([{ sourceId: 'baidu', tracks: [{ id: 'baidu:a' }], snapshots: [] }], {
      expectedRevisions: { baidu: null }, candidateState: { playlists: [] },
    });
    const pending = await readControl();
    await store.finalizeCloudCatalogRestore(staged.id, { candidateText: staged.stateText });
    const active = await readControl();
    const stale = await store.readCloudCatalogs().catch(error => error.code);
    return { prior, pending, active, stale, requests, id: staged.id, scope: staged.scope };
  }, moduleUrl);
  expect(result.prior).toEqual({ scope: 'groovebox.state.v1' });
  expect(result.pending).toEqual({ scope: 'groovebox.state.v1', pending: { id: result.id, scope: result.scope } });
  expect(result.active).toEqual({ scope: result.scope });
  expect(result.stale).toBe('cloud-catalog-conflict');
  expect(result.requests).toEqual(Array(3).fill({ names: 'catalogControl', mode: 'readonly' }));
});

test('stages exact compact state and fences old reads and writes after the atomic scope switch', async ({ page }) => {
  await page.goto(fixture);
  const value = await page.evaluate(async url => {
    const store = await import(url);
    const legacy = store.legacyCloudCatalogScope;
    const before = await store.commitCloudCatalog('baidu', { tracks: [{ id: 'baidu:old' }], snapshots: [] }, { expectedRevision: null });
    const expectedRevisions = { baidu: before.revision, gdrive: null };
    const incoming = [{ sourceId: 'gdrive', tracks: [{ id: 'gdrive:new' }], snapshots: [] }];
    const candidateState = { tracks: [], playlists: [{ id: 'list', tracks: ['gdrive:new'] }] };
    const seen = [];
    store.subscribeCloudCatalogs(change => seen.push(change));
    const prepared = await store.prepareCloudCatalogRestore(incoming, { expectedRevisions, candidateState });
    candidateState.playlists[0].tracks.splice(0);
    const staged = await store.readCloudCatalogState();
    const oldRead = await store.readCloudCatalogs();
    const conflicts = await Promise.all([
      store.commitCloudCatalog('baidu', { tracks: [], snapshots: [] }, { expectedRevision: before.revision }),
      store.updateCloudCatalogTracks('baidu', { remove: ['baidu:old'] }, { expectedRevision: before.revision }),
      store.replaceCloudCatalogs(incoming, { expectedRevisions, replaceAll: true }),
      store.prepareCloudCatalogRestore(incoming, { expectedRevisions }),
      store.finalizeCloudCatalogRestore(prepared.id),
      store.finalizeCloudCatalogRestore(prepared.id, { candidateText: prepared.stateText + ' ' }),
      store.cancelCloudCatalogRestore('2f19ff40-7e42-4a31-90f3-cff9a0aec659'),
    ].map(job => job.catch(error => error.code)));
    const afterRejected = await store.readCloudCatalogState();
    const active = await store.finalizeCloudCatalogRestore(prepared.id, { candidateText: prepared.stateText });
    const repeated = await store.finalizeCloudCatalogRestore(prepared.id, { candidateText: prepared.stateText });
    const stale = await Promise.all([
      store.readCloudCatalogs(),
      store.commitCloudCatalog('baidu', { tracks: [], snapshots: [] }, { expectedRevision: null }),
      store.replaceCloudCatalogs([], { expectedRevisions: {}, replaceAll: true }),
    ].map(job => job.catch(error => error.code)));
    const current = await store.readCloudCatalogs({ expectedScope: active.scope });
    return { legacy, before, staged, prepared, afterRejected, oldRead, conflicts, active, repeated, stale, current, seen };
  }, moduleUrl);
  expect(value.prepared.scope).toBe('groovebox.state.restore.' + value.prepared.id);
  expect(JSON.parse(value.prepared.stateText)).toEqual({ tracks: [], playlists: [{ id: 'list', tracks: ['gdrive:new'] }],
    _grooveboxStateScope: value.prepared.scope });
  expect(value.staged).toEqual({ scope: value.legacy, records: [value.before], pending: value.prepared });
  expect(value.oldRead).toEqual([value.before]);
  expect(value.afterRejected).toEqual(value.staged);
  expect(value.conflicts).toEqual([...Array(4).fill('cloud-catalog-restore-pending'), ...Array(3).fill('cloud-catalog-conflict')]);
  expect(value.active).toEqual({ scope: value.prepared.scope, records: value.prepared.records });
  expect(value.repeated).toEqual(value.active);
  expect(value.current).toEqual(value.active.records);
  expect(value.stale).toEqual(Array(3).fill('cloud-catalog-conflict'));
  expect(value.seen).toEqual([{ scope: value.active.scope, restore: true, sources: [
    { sourceId: 'baidu', revision: null }, { sourceId: 'gdrive', revision: value.active.records[0].revision },
  ] }]);
});

test('preserves old catalogs on prepare quota failure and keeps a decided restore recoverable after an aborted finalize', async ({ page }) => {
  await page.goto(fixture);
  const value = await page.evaluate(async url => {
    const store = await import(url);
    const old = await store.commitCloudCatalog('baidu', { tracks: [{ id: 'baidu:old' }], snapshots: [] }, { expectedRevision: null });
    const input = [{ sourceId: 'baidu', tracks: [{ id: 'baidu:new' }], snapshots: [] }];
    const options = { expectedRevisions: { baidu: old.revision }, candidateState: { tracks: [], playlists: [] } };
    const put = IDBObjectStore.prototype.put;
    const failed = error => [error.code, error.cause?.name];
    let prepareQuota, finalQuota, canceled, afterFailedPrepare, afterFailedFinalize, afterAbort, pending;
    try {
      IDBObjectStore.prototype.put = function (record, ...rest) {
        if (this.name === 'catalogControl' && record.pending) throw new DOMException('prepare quota fixture', 'QuotaExceededError');
        return put.call(this, record, ...rest);
      };
      prepareQuota = await store.prepareCloudCatalogRestore(input, options).catch(failed);
      afterFailedPrepare = await store.readCloudCatalogState();
      IDBObjectStore.prototype.put = put;
      pending = await store.prepareCloudCatalogRestore(input, options);
      IDBObjectStore.prototype.put = function (record, ...rest) {
        if (this.name === 'sourceCatalogs') throw new DOMException('finalize quota fixture', 'QuotaExceededError');
        return put.call(this, record, ...rest);
      };
      finalQuota = await store.finalizeCloudCatalogRestore(pending.id, { candidateText: pending.stateText }).catch(failed);
      afterFailedFinalize = await store.readCloudCatalogState();
      const controller = new AbortController();
      IDBObjectStore.prototype.put = function (record, ...rest) {
        const request = put.call(this, record, ...rest);
        if (this.name === 'catalogControl' && record.scope === pending.scope) controller.abort();
        return request;
      };
      canceled = await store.finalizeCloudCatalogRestore(pending.id, {
        candidateText: pending.stateText, signal: controller.signal,
      }).catch(error => error.name);
      afterAbort = await store.readCloudCatalogState();
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const restored = await store.finalizeCloudCatalogRestore(pending.id, { candidateText: pending.stateText });
    return { old, pending, restored, prepareQuota, finalQuota, canceled, afterFailedPrepare, afterFailedFinalize, afterAbort, legacy: store.legacyCloudCatalogScope };
  }, moduleUrl);
  expect(value.prepareQuota).toEqual(['cloud-catalog-storage', 'QuotaExceededError']);
  expect(value.finalQuota).toEqual(value.prepareQuota);
  expect(value.canceled).toBe('AbortError');
  expect(value.afterFailedPrepare).toEqual({ scope: value.legacy, records: [value.old] });
  expect(value.afterFailedFinalize).toEqual({ ...value.afterFailedPrepare, pending: value.pending });
  expect(value.afterAbort).toEqual(value.afterFailedFinalize);
  expect(value.restored).toEqual({ scope: value.pending.scope, records: value.pending.records });
});

test('a peer can cancel only the exact abandoned stage and old scope retries cannot undo a later restore', async ({ page, context }) => {
  await page.goto(fixture);
  const peer = await context.newPage();
  try {
    await peer.goto(fixture);
    const staged = await page.evaluate(async url => {
      const store = await import(url);
      return store.prepareCloudCatalogRestore([], { expectedRevisions: {}, candidateState: { playlists: [] } });
    }, moduleUrl);
    const canceled = await peer.evaluate(async ({ url, staged }) => {
      const store = await import(url);
      return store.cancelCloudCatalogRestore(staged.id);
    }, { url: moduleUrl, staged });
    expect(canceled).toEqual({ scope: 'groovebox.state.v1', records: [] });
    const result = await page.evaluate(async ({ url, staged }) => {
      const store = await import(url);
      const discarded = await store.finalizeCloudCatalogRestore(staged.id, { candidateText: staged.stateText }).catch(error => error.code);
      const first = await store.prepareCloudCatalogRestore([], { expectedRevisions: {} });
      const activated = await store.finalizeCloudCatalogRestore(first.id);
      const newer = await store.prepareCloudCatalogRestore([], { expectedRevisions: {}, expectedScope: activated.scope });
      const current = await store.finalizeCloudCatalogRestore(newer.id, { expectedScope: activated.scope });
      const stalePredecessor = await store.finalizeCloudCatalogRestore(newer.id).catch(error => error.code);
      const lateCancel = await store.cancelCloudCatalogRestore(first.id).catch(error => error.code);
      return { current, newer, discarded, stalePredecessor, lateCancel };
    }, { url: moduleUrl, staged });
    expect(result.discarded).toBe('cloud-catalog-conflict');
    expect(result.stalePredecessor).toBe('cloud-catalog-conflict');
    expect(result.lateCancel).toBe('cloud-catalog-conflict');
    expect(result.current).toEqual({ scope: result.newer.scope, records: [] });
  } finally {
    await peer.close();
  }
});

test('concurrent finalization and cancellation from different tabs publish only one coherent generation', async ({ page, context }) => {
  const peer = await context.newPage();
  try {
    await Promise.all([page.goto(fixture), peer.goto(fixture)]);
    const seed = await page.evaluate(async url => {
      const store = await import(url);
      const old = await store.commitCloudCatalog('baidu', { tracks: [{ id: 'baidu:before' }], snapshots: [] }, { expectedRevision: null });
      const staged = await store.prepareCloudCatalogRestore([{ sourceId: 'baidu', tracks: [{ id: 'baidu:after' }], snapshots: [] }], {
        expectedRevisions: { baidu: old.revision }, candidateState: { playlists: [] },
      });
      return { staged, old };
    }, moduleUrl);
    const [finish, cancel] = await Promise.all([
      page.evaluate(async ({ url, staged }) => {
        const store = await import(url);
        return store.finalizeCloudCatalogRestore(staged.id, { candidateText: staged.stateText }).catch(error => error.code);
      }, { url: moduleUrl, staged: seed.staged }),
      peer.evaluate(async ({ url, id }) => {
        const store = await import(url);
        return store.cancelCloudCatalogRestore(id).catch(error => error.code);
      }, { url: moduleUrl, id: seed.staged.id }),
    ]);
    const active = await peer.evaluate(async url => (await import(url)).readCloudCatalogState(), moduleUrl);
    if (finish === 'cloud-catalog-conflict') {
      expect(cancel).toEqual({ scope: 'groovebox.state.v1', records: [seed.old] });
      expect(active).toEqual(cancel);
    } else {
      expect(cancel).toBe('cloud-catalog-conflict');
      expect(finish).toEqual({ scope: seed.staged.scope, records: seed.staged.records });
      expect(active).toEqual(finish);
    }
  } finally {
    await peer.close();
  }
});
