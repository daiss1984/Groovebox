const databaseName = 'groovebox.cloud-catalog';
const catalogStore = 'sourceCatalogs';
const controlStore = 'catalogControl';
const headKey = 'head';
export const legacyCloudCatalogScope = 'groovebox.state.v1';
const restoreScopePrefix = 'groovebox.state.restore.';
const stateScopeMarker = '_grooveboxStateScope';
const providerIds = new Set(['baidu', 'gdrive', 'onedrive', 'dropbox', 'box', 'pcloud', 'aliyundrive',
  'drive123', 'drive115', 'guangya']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sourceUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[48][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const credentials = /^(?:authorization|(?:access|refresh|auth|api|client|x[_-](?:plex|emby))[_-]?(?:token|key|secret)|token|secret|password|cookie|headers)$/i;
const listeners = new Set();
let databasePromise;
let changes;

export class CloudCatalogError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'CloudCatalogError';
    this.code = code;
  }
}

function invalid(message) {
  return new CloudCatalogError('cloud-catalog-invalid', message);
}

function storageError(cause) {
  return new CloudCatalogError('cloud-catalog-storage', 'Could not access the cloud catalog', cause);
}

function canceled() {
  return new DOMException('Cloud catalog operation was canceled', 'AbortError');
}

export function isCloudCatalogSourceId(sourceId) {
  return typeof sourceId === 'string' && (providerIds.has(sourceId) || sourceUuid.test(sourceId));
}

const validSource = isCloudCatalogSourceId;

function validRevision(revision) {
  return typeof revision === 'string' && uuid.test(revision);
}

function newRevision() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function plainObject(value) {
  return value != null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function plainArray(value) {
  if (!Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === value.length && keys.every((key, index) => key === String(index));
}

function metadata(value, depth = 0) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return true;
  if (depth > 24) return false;
  if (Array.isArray(value)) return plainArray(value) && value.every(entry => metadata(entry, depth + 1));
  return plainObject(value) && Object.entries(value).every(([name, entry]) =>
    !credentials.test(name) && safeMetadataLink(name, entry) && metadata(entry, depth + 1));
}

function safeMetadataLink(name, value) {
  if (!['src', 'cover', 'folderCover', 'lyrics'].includes(name) || typeof value !== 'string' ||
    !/^(?:https?:|\/)/i.test(value)) return true;
  try {
    const url = new URL(value, 'https://groovebox.invalid');
    return !url.username && !url.password && !Array.from(url.searchParams.keys()).some(key => credentials.test(key));
  } catch {
    return false;
  }
}

const nonempty = value => typeof value === 'string' && value.length > 0;
const trackId = (sourceId, id) => typeof id === 'string' && id.startsWith(sourceId + ':') && id.length > sourceId.length + 1;

function trackRecords(sourceId, tracks) {
  const indexed = new Map();
  if (!plainArray(tracks)) throw invalid('Invalid cloud catalog tracks');
  for (const track of tracks) {
    if (!plainObject(track) || !trackId(sourceId, track.id) || indexed.has(track.id) || !metadata(track)) {
      throw invalid('Invalid cloud catalog track');
    }
    if (track.src != null) {
      const streamPath = '/api/' + (providerIds.has(sourceId) ? sourceId : 'sources/' + sourceId) + '/stream?id=';
      if (typeof track.src !== 'string' || !track.src.startsWith(streamPath) ||
          !/^[a-z\d!._%~-]+$/i.test(track.src.slice(streamPath.length))) throw invalid('Invalid cloud stream reference');
    }
    indexed.set(track.id, track);
  }
  return indexed;
}

function validateSnapshots(sourceId, snapshots) {
  if (!plainArray(snapshots)) throw invalid('Invalid cloud catalog folders');
  const folders = new Set();
  for (const folder of snapshots) {
    if (!plainArray(folder) || folder.length < 3 || folder.length > 5) throw invalid('Invalid cloud catalog folder');
    const [path, children, tracks, name, parents] = folder;
    if (!nonempty(path) || folders.has(path) || !plainArray(children) || !children.every(nonempty) ||
      !plainArray(tracks) || !tracks.every(id => trackId(sourceId, id)) || (name != null && !nonempty(name)) ||
      (parents != null && (!plainArray(parents) || !parents.every(parent =>
        plainObject(parent) && nonempty(parent.path) && nonempty(parent.name) && metadata(parent))))) {
      throw invalid('Invalid cloud catalog folder');
    }
    folders.add(path);
  }
}

function validateRecord(sourceId, record) {
  if (!validSource(sourceId) || !plainObject(record)) throw invalid('Invalid cloud catalog source');
  trackRecords(sourceId, record.tracks);
  validateSnapshots(sourceId, record.snapshots);
}

function copyMetadata(value) {
  try { return structuredClone(value); }
  catch { throw invalid('Cloud catalog metadata could not be cloned'); }
}

function storedRecord(record) {
  try {
    validateRecord(record?.sourceId, record);
    if (!validRevision(record.revision) || Object.keys(record).length !== 4) throw invalid('Invalid cloud catalog record');
    return record;
  } catch (error) {
    throw storageError(error);
  }
}

function checkExpected(sourceId, expected, record) {
  if ((record?.revision ?? null) !== expected) {
    throw new CloudCatalogError('cloud-catalog-conflict', 'Cloud catalog changed for ' + sourceId);
  }
}

function restoreScope(id) {
  return restoreScopePrefix + id;
}

function validScope(scope) {
  return scope === legacyCloudCatalogScope || (typeof scope === 'string' && scope.startsWith(restoreScopePrefix) &&
    validRevision(scope.slice(restoreScopePrefix.length)));
}

function checkScope(scope, expected) {
  if (!validScope(expected)) throw invalid('Invalid expected cloud catalog scope');
  if (scope !== expected) throw new CloudCatalogError('cloud-catalog-conflict', 'Cloud catalog scope changed');
}

function validStateText(text, scope) {
  if (typeof text !== 'string') return false;
  try {
    const state = JSON.parse(text);
    return plainObject(state) && state[stateScopeMarker] === scope && metadata(state);
  } catch {
    return false;
  }
}

function storedHead(value, controlOnly = false) {
  if (value === undefined) return { scope: legacyCloudCatalogScope };
  try {
    if (!plainObject(value) || !validScope(value.scope) || (value.scope === legacyCloudCatalogScope
      ? value.restoredFrom !== undefined
      : !validScope(value.restoredFrom) || value.restoredFrom === value.scope)) throw invalid('Invalid cloud catalog scope');
    const active = { scope: value.scope, ...(value.restoredFrom !== undefined && { restoredFrom: value.restoredFrom }) };
    if (value.pending === undefined) return active;
    const { id, scope, records, revisions, stateText } = value.pending;
    if (!validRevision(id) || scope !== restoreScope(id) || scope === value.scope) {
      throw invalid('Invalid cloud catalog restore journal');
    }
    if (controlOnly) return { ...active, pending: { id, scope } };
    if (!plainArray(records) || !plainArray(revisions) ||
        !revisions.every(row => plainArray(row) && row.length === 2 && validSource(row[0]) && (row[1] === null || validRevision(row[1]))) ||
        (stateText !== undefined && !validStateText(stateText, scope))) {
      throw invalid('Invalid cloud catalog restore journal');
    }
    const baseRevisions = new Map(revisions);
    if (baseRevisions.size !== revisions.length || new Set(records.map(record => record?.sourceId)).size !== records.length ||
      records.some(record => !baseRevisions.has(storedRecord(record).sourceId))) throw invalid('Invalid staged cloud catalog records');
    return { ...active, pending: { id, scope, records, revisions, ...(stateText !== undefined && { stateText }) } };
  } catch (error) {
    throw storageError(error);
  }
}

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);
      let blocked = false;
      request.onupgradeneeded = event => {
        if (event.oldVersion < 1) request.result.createObjectStore(catalogStore, { keyPath: 'sourceId' });
        if (event.oldVersion < 2) request.result.createObjectStore(controlStore);
      };
      request.onblocked = () => {
        blocked = true;
        reject(new CloudCatalogError('cloud-catalog-blocked', 'Cloud catalog database is open in another tab'));
      };
      request.onerror = () => reject(storageError(request.error));
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        const forget = () => { databasePromise = undefined; };
        db.onversionchange = () => { db.close(); forget(); };
        db.onclose = forget;
        resolve(db);
      };
    }).catch(error => {
      databasePromise = undefined;
      throw error instanceof CloudCatalogError ? error : storageError(error);
    });
  }
  return databasePromise;
}

async function transact(mode, signal, work, { strict = false, controlOnly = false } = {}) {
  if (signal?.aborted) throw canceled();
  const database = await openDatabase();
  if (signal?.aborted) throw canceled();
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      const stores = controlOnly ? controlStore : [catalogStore, controlStore];
      if (strict) {
        try { transaction = database.transaction(stores, mode, { durability: 'strict' }); }
        catch (error) {
          if (error?.name !== 'TypeError') throw error;
          transaction = database.transaction(stores, mode);
        }
      } else transaction = database.transaction(stores, mode);
    }
    catch (error) { reject(storageError(error)); return; }
    let value, failure, requestError;
    const onCancel = () => {
      try { transaction.abort(); failure = canceled(); }
      catch { /* It may have already committed. Report the actual outcome. */ }
    };
    const fail = error => {
      failure ??= error;
      try { transaction.abort(); } catch { /* An earlier cancel may have ended the transaction. */ }
    };
    const receive = (request, next) => {
      request.onsuccess = () => {
        try { next(request.result); }
        catch (error) { fail(error); }
      };
    };
    transaction.oncomplete = () => { signal?.removeEventListener('abort', onCancel); resolve(value); };
    transaction.onabort = () => {
      signal?.removeEventListener('abort', onCancel);
      const error = failure || transaction.error || requestError;
      reject(error instanceof CloudCatalogError || error?.name === 'AbortError' && failure ? error : storageError(error));
    };
    transaction.onerror = event => { requestError ??= event.target.error; };
    signal?.addEventListener('abort', onCancel, { once: true });
    try {
      work(controlOnly ? undefined : transaction.objectStore(catalogStore), receive,
        result => { value = result; }, transaction.objectStore(controlStore));
    }
    catch (error) { fail(error); }
  });
}

function readHead(control, receive, next) {
  receive(control.get(headKey), value => next(storedHead(value)));
}

function scopedTransaction(mode, signal, expectedScope, work) {
  return transact(mode, signal, (store, receive, complete, control) => {
    readHead(control, receive, head => {
      checkScope(head.scope, expectedScope);
      if (mode === 'readwrite' && head.pending) {
        throw new CloudCatalogError('cloud-catalog-restore-pending', 'A cloud catalog restore is pending');
      }
      work(store, receive, complete);
    });
  });
}

function notify(change, remote) {
  for (const listener of listeners) {
    try { listener(change, { remote }); } catch { /* An observer cannot change the commit outcome. */ }
  }
}

function channel() {
  if (!changes && typeof window !== 'undefined' && typeof BroadcastChannel === 'function') {
    try {
      changes = new BroadcastChannel(databaseName);
      changes.onmessage = ({ data }) => {
        if (validScope(data?.scope) && Array.isArray(data.sources) && data.sources.every(item =>
          validSource(item?.sourceId) && (item.revision === null || validRevision(item.revision)))) notify(data, true);
      };
    } catch { /* IndexedDB remains authoritative. */ }
  }
  return changes;
}

function publish(sources, scope, restore = false) {
  if (!sources.length && !restore) return;
  const event = { sources, scope, ...(restore && { restore: true }) };
  try { channel()?.postMessage(event); } catch { /* A notification is best effort. */ }
  notify(event, false);
}

export function subscribeCloudCatalogs(listener) {
  listeners.add(listener);
  channel();
  return () => listeners.delete(listener);
}

export function readCloudCatalogs({ expectedScope = legacyCloudCatalogScope } = {}) {
  return scopedTransaction('readonly', undefined, expectedScope, (store, receive, complete) => {
    receive(store.getAll(), records => complete(records.map(storedRecord)));
  });
}

export const hydrateCloudCatalogs = readCloudCatalogs;

export async function commitCloudCatalog(sourceId, { tracks, snapshots } = {}, {
  expectedRevision, expectedScope = legacyCloudCatalogScope, signal,
} = {}) {
  const metadata = copyMetadata({ tracks, snapshots });
  validateRecord(sourceId, metadata);
  if (expectedRevision !== null && !validRevision(expectedRevision)) throw invalid('Expected cloud catalog revision is required');
  const record = await scopedTransaction('readwrite', signal, expectedScope, (store, receive, complete) => {
    receive(store.get(sourceId), current => {
      checkExpected(sourceId, expectedRevision, current && storedRecord(current));
      const updated = { sourceId, revision: newRevision(), ...metadata };
      store.put(updated);
      complete(updated);
    });
  });
  publish([{ sourceId, revision: record.revision }], expectedScope);
  return record;
}

export async function updateCloudCatalogTracks(sourceId, { upsert = [], remove = [] } = {}, {
  expectedRevision, expectedScope = legacyCloudCatalogScope, signal,
} = {}) {
  if (!validSource(sourceId) || !validRevision(expectedRevision)) throw invalid('Expected cloud catalog revision is required');
  const additions = trackRecords(sourceId, copyMetadata(upsert));
  if (!Array.isArray(remove) || !remove.every(id => trackId(sourceId, id) && !additions.has(id))) {
    throw invalid('Invalid cloud catalog track removals');
  }
  const removals = [...remove];
  const record = await scopedTransaction('readwrite', signal, expectedScope, (store, receive, complete) => {
    receive(store.get(sourceId), current => {
      checkExpected(sourceId, expectedRevision, current && storedRecord(current));
      const tracks = new Map(current.tracks.map(track => [track.id, track]));
      for (const id of removals) tracks.delete(id);
      for (const [id, track] of additions) tracks.set(id, track);
      const updated = { ...current, revision: newRevision(), tracks: [...tracks.values()] };
      store.put(updated);
      complete(updated);
    });
  });
  publish([{ sourceId, revision: record.revision }], expectedScope);
  return record;
}

function replacementInput(records, expectedRevisions) {
  if (!Array.isArray(records) || !(expectedRevisions instanceof Map || plainObject(expectedRevisions))) {
    throw invalid('Expected cloud catalog revisions are required');
  }
  const expected = new Map(expectedRevisions instanceof Map ? expectedRevisions : Object.entries(expectedRevisions));
  for (const [sourceId, revision] of expected) {
    if (!validSource(sourceId) || (revision !== null && !validRevision(revision))) throw invalid('Invalid expected cloud catalog revision');
  }
  const incoming = new Map();
  for (const record of copyMetadata(records)) {
    validateRecord(record?.sourceId, record);
    if (!expected.has(record.sourceId) || incoming.has(record.sourceId)) throw invalid('Invalid replacement cloud catalog source');
    incoming.set(record.sourceId, record);
  }
  return { incoming, expected };
}

function checkReplacement(current, expected, all) {
  if (all) for (const [sourceId, record] of current) {
    if (!expected.has(sourceId)) checkExpected(sourceId, null, record);
  }
  for (const [sourceId, revision] of expected) checkExpected(sourceId, revision, current.get(sourceId));
}

function revisedRecords(incoming) {
  return [...incoming].map(([sourceId, record]) =>
    ({ sourceId, revision: newRevision(), tracks: record.tracks, snapshots: record.snapshots }));
}

function readRecords(store, receive, next) {
  receive(store.getAll(), current => next(current.map(storedRecord)));
}

function catalogMap(records) {
  return new Map(records.map(record => [record.sourceId, record]));
}

export async function replaceCloudCatalogs(records, {
  expectedRevisions, expectedScope = legacyCloudCatalogScope, signal, replaceAll = false,
} = {}) {
  const { incoming, expected } = replacementInput(records, expectedRevisions);
  const { written, revisions } = await scopedTransaction('readwrite', signal, expectedScope, (store, receive, complete) => {
    const replace = current => {
      checkReplacement(current, expected, replaceAll);
      const written = [];
      const updated = catalogMap(revisedRecords(incoming));
      const revisions = [];
      for (const [sourceId, revision] of expected) {
        const record = updated.get(sourceId);
        if (record) {
          store.put(record);
          written.push(record);
          revisions.push({ sourceId, revision: record.revision });
        } else if (revision !== null) {
          store.delete(sourceId);
          revisions.push({ sourceId, revision: null });
        }
      }
      complete({ written, revisions });
    };
    if (replaceAll) {
      readRecords(store, receive, current => replace(catalogMap(current)));
    } else {
      const current = new Map();
      let remaining = expected.size;
      if (!remaining) replace(current);
      for (const sourceId of expected.keys()) receive(store.get(sourceId), record => {
        if (record) current.set(sourceId, storedRecord(record));
        if (--remaining === 0) replace(current);
      });
    }
  });
  publish(revisions, expectedScope);
  return written;
}

function pendingDetails({ id, scope, records, stateText }) {
  return { id, scope, records, ...(stateText !== undefined && { stateText }) };
}

export function readCloudCatalogState() {
  return transact('readonly', undefined, (store, receive, complete, control) => {
    readHead(control, receive, ({ scope, pending }) => {
      readRecords(store, receive, records => complete({ scope, records, ...(pending && { pending: pendingDetails(pending) }) }));
    });
  });
}

export function readCloudCatalogControl() {
  return transact('readonly', undefined, (_store, receive, complete, control) => {
    receive(control.get(headKey), value => {
      const { scope, pending } = storedHead(value, true);
      complete({ scope, ...(pending && { pending }) });
    });
  }, { controlOnly: true });
}

export async function prepareCloudCatalogRestore(records, {
  expectedRevisions, expectedScope = legacyCloudCatalogScope, signal, candidateState,
} = {}) {
  const { incoming, expected } = replacementInput(records, expectedRevisions);
  const candidate = candidateState === undefined ? undefined : copyMetadata(candidateState);
  if (candidate !== undefined && (!plainObject(candidate) || !metadata(candidate))) throw invalid('Invalid cloud restore preferences');
  return transact('readwrite', signal, (store, receive, complete, control) => {
    readHead(control, receive, head => {
      checkScope(head.scope, expectedScope);
      if (head.pending) throw new CloudCatalogError('cloud-catalog-restore-pending', 'A cloud catalog restore is pending');
      readRecords(store, receive, current => {
        checkReplacement(catalogMap(current), expected, true);
        const id = newRevision();
        const scope = restoreScope(id);
        const stateText = candidate === undefined ? undefined : JSON.stringify({ ...candidate, [stateScopeMarker]: scope });
        const pending = { id, scope, records: revisedRecords(incoming), revisions: [...expected],
          ...(stateText !== undefined && { stateText }) };
        control.put({ ...head, pending }, headKey);
        complete(pendingDetails(pending));
      });
    });
  }, { strict: true });
}

function expectedPending(head, id, expectedScope) {
  checkScope(head.scope, expectedScope);
  if (head.pending?.id !== id) throw new CloudCatalogError('cloud-catalog-conflict', 'Cloud catalog restore changed');
  return head.pending;
}

export async function finalizeCloudCatalogRestore(id, { expectedScope = legacyCloudCatalogScope, signal, candidateText } = {}) {
  if (!validRevision(id)) throw invalid('Invalid cloud catalog restore ID');
  const { state, sources } = await transact('readwrite', signal, (store, receive, complete, control) => {
    readHead(control, receive, head => {
      if (head.scope === restoreScope(id) && head.restoredFrom === expectedScope) {
        readRecords(store, receive, records => complete({ state: { scope: head.scope, records } }));
        return;
      }
      const pending = expectedPending(head, id, expectedScope);
      if (pending.stateText !== undefined && candidateText !== pending.stateText) {
        throw new CloudCatalogError('cloud-catalog-conflict', 'Cloud restore preferences did not match the prepared state');
      }
      readRecords(store, receive, current => {
        checkReplacement(catalogMap(current), new Map(pending.revisions), true);
        const next = catalogMap(pending.records);
        const sources = [...current.filter(record => !next.has(record.sourceId)).map(({ sourceId }) => ({ sourceId, revision: null })),
          ...pending.records.map(({ sourceId, revision }) => ({ sourceId, revision }))];
        store.clear();
        for (const record of pending.records) store.put(record);
        control.put({ scope: pending.scope, restoredFrom: head.scope }, headKey);
        complete({ state: { scope: pending.scope, records: pending.records }, sources });
      });
    });
  }, { strict: true });
  if (sources) publish(sources, state.scope, true);
  return state;
}

export async function cancelCloudCatalogRestore(id, { expectedScope = legacyCloudCatalogScope, signal } = {}) {
  if (!validRevision(id)) throw invalid('Invalid cloud catalog restore ID');
  return transact('readwrite', signal, (store, receive, complete, control) => {
    readHead(control, receive, head => {
      expectedPending(head, id, expectedScope);
      readRecords(store, receive, records => {
        const { pending, ...active } = head;
        control.put(active, headKey);
        complete({ scope: active.scope, records });
      });
    });
  }, { strict: true });
}
