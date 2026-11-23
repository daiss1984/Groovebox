import { binaryBlob, needsBinaryFallback, toBinary, transactionRequest } from './media-storage.js';
import { automaticEvictions, checkAutomaticCache, defaultAudioCacheMiB, offlineCacheStats, validAudioCacheLimit } from './offline-policy.js';

export { OfflineCachePolicyError, defaultAudioCacheMiB, minimumAudioCacheMiB } from './offline-policy.js';

const defaultAudioLimit = 60 * 1024 * 1024;
export const playlistAudioLimit = 256 * 1024 * 1024;
const folderCoverLimit = 8 * 1024 * 1024;
const coverTable = 'folder-covers';
const entryTable = 'cache-entries';
const policyTable = 'cache-policy';
const policyKey = 'audio';
const media = new Map();
const retiredMedia = new Set();
const storedEntries = new Map();
const folderCoverIds = new Set();
const folderCovers = new Map();
const folderCoverReads = new Map();
const cacheListeners = new Set();
const changes = typeof window !== 'undefined' && typeof BroadcastChannel === 'function' ? new BroadcastChannel('groovebox.offline-cache') : undefined;
let databasePromise;
let binaryFallback = false;
let hydrationRequest = 0;
let notifyCacheChange = false;
const defaultPolicy = () => ({ limitMiB: defaultAudioCacheMiB, generation: 0, paused: false, clock: 0 });
const bodySize = record => record?.blob?.size ?? record?.binary?.buffer?.byteLength ?? 0;

function upgradeCache(connection, transaction, hasOldAudio) {
  const metadata = connection.createObjectStore(entryTable, { keyPath: 'id' });
  connection.createObjectStore(policyTable).put(defaultPolicy(), policyKey);
  if (!hasOldAudio) return;
  const cover = transaction.objectStore(coverTable);
  const cursor = transaction.objectStore('audio').openCursor();
  cursor.onsuccess = () => {
    const row = cursor.result;
    if (!row) return;
    const artwork = cover.get(row.primaryKey);
    artwork.onsuccess = () => {
      metadata.put({ id: row.primaryKey, mode: 'pinned', bytes: bodySize(row.value), coverBytes: bodySize(artwork.result), lastAccess: 0 });
      row.continue();
    };
  };
}

function database() {
  databasePromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('groovebox.offline', 3);
    let blocked = false;
    open.onupgradeneeded = event => {
      if (event.oldVersion < 1) open.result.createObjectStore('audio', { keyPath: 'id' });
      if (event.oldVersion < 2) open.result.createObjectStore(coverTable, { keyPath: 'id' });
      if (event.oldVersion < 3) upgradeCache(open.result, open.transaction, event.oldVersion > 0);
    };
    open.onsuccess = () => {
      const connection = open.result;
      if (blocked) { connection.close(); return; }
      connection.onversionchange = () => { connection.close(); databasePromise = undefined; };
      connection.onclose = () => { databasePromise = undefined; };
      resolve(connection);
    };
    open.onblocked = () => {
      blocked = true;
      reject(new DOMException('Offline music storage upgrade is blocked by another tab.', 'InvalidStateError'));
    };
    open.onerror = () => reject(open.error);
  }).catch(error => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}
async function store(mode, operation, table = 'audio') {
  return transactionRequest(await database(), table, mode, operation);
}

async function cacheTransaction({ write = false, mediaTables = false, id } = {}, work) {
  const tables = [entryTable, policyTable, ...(mediaTables ? ['audio', coverTable] : [])];
  let result, failure;
  try {
    await store(write ? 'readwrite' : 'readonly', (metadata, transaction) => {
      const policyStore = transaction.objectStore(policyTable);
      const policy = policyStore.get(policyKey);
      const entries = id === undefined ? metadata.getAll() : metadata.get(id);
      let remaining = 2;
      const receive = (request, callback) => { request.onsuccess = () => {
        try { callback(request.result); }
        catch (error) { failure = error; transaction.abort(); }
      }; };
      const ready = () => {
        if (--remaining) return;
        const value = policy.result ?? defaultPolicy();
        const rows = id === undefined ? entries.result : entries.result ? [entries.result] : [];
        const savePolicy = () => policyStore.put(value, policyKey);
        const saveEntry = entry => metadata.put(entry);
        const audio = mediaTables && transaction.objectStore('audio');
        const cover = mediaTables && transaction.objectStore(coverTable);
        const remove = id => { metadata.delete(id); audio.delete(id); cover.delete(id); };
        const setResult = value => { result = value; };
        result = work({ policy: value, rows, savePolicy, saveEntry, audio, cover, remove, receive, setResult });
      };
      receive(policy, ready);
      receive(entries, ready);
    }, tables);
  } catch (error) { throw failure ?? error; }
  return result;
}

function forgetMemory(id, retainPlayback = true) {
  storedEntries.delete(id);
  if (media.has(id)) {
    const { url } = media.get(id);
    if (retainPlayback) retiredMedia.add(url);
    else URL.revokeObjectURL(url);
    media.delete(id);
  }
  folderCoverIds.delete(id);
  folderCoverReads.delete(id);
  if (folderCovers.has(id)) URL.revokeObjectURL(folderCovers.get(id).url);
  folderCovers.delete(id);
}

async function refreshCache(notify) {
  if (notify) notifyCacheChange = true;
  const version = ++hydrationRequest;
  const { policy, rows } = await cacheTransaction({}, ({ policy, rows }) => ({ policy, rows }));
  const stats = offlineCacheStats(policy, rows);
  if (version === hydrationRequest) {
    const known = new Set(rows.map(row => row.id));
    for (const id of storedEntries.keys()) if (!known.has(id)) forgetMemory(id);
    for (const row of rows) {
      const previous = storedEntries.get(row.id);
      if (previous && previous.revision !== row.revision) forgetMemory(row.id);
      storedEntries.set(row.id, row);
      if (row.coverBytes > 0) folderCoverIds.add(row.id);
    }
    if (notifyCacheChange) {
      notifyCacheChange = false;
      for (const listener of cacheListeners) listener(stats);
    }
  }
  return stats;
}

changes?.addEventListener('message', () => { void refreshCache(true).catch(() => {}); });
export function hydrateOffline() { return refreshCache(false); }
export function readOfflineCachePolicy() { return refreshCache(false); }
export async function offlineCacheGeneration() {
  return (await store('readonly', entries => entries.get(policyKey), policyTable))?.generation ?? 0;
}
export function subscribeOfflineCache(listener) {
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
}
async function changedCache() {
  changes?.postMessage('updated');
  return refreshCache(true);
}
export const hasOffline = id => storedEntries.has(id);
export const offlineTrackMode = id => storedEntries.get(id)?.mode;

export async function configureOfflineCache({ limitMiB }) {
  if (!validAudioCacheLimit(limitMiB)) throw new RangeError('Invalid audio cache capacity');
  await cacheTransaction({ write: true, mediaTables: true }, ({ policy, rows, remove, savePolicy }) => {
    for (const id of automaticEvictions(rows, limitMiB)) remove(id);
    policy.limitMiB = limitMiB;
    savePolicy();
  });
  return changedCache();
}

export async function clearAutomaticAudioCache() {
  await cacheTransaction({ write: true, mediaTables: true }, ({ policy, rows, remove, savePolicy }) => {
    for (const { id, mode } of rows) if (mode === 'automatic') remove(id);
    policy.paused = true;
    policy.generation++;
    savePolicy();
  });
  return changedCache();
}

export async function resumeAutomaticAudioCache() {
  await cacheTransaction({ write: true, id: policyKey }, ({ policy, savePolicy }) => {
    if (policy.paused) {
      policy.paused = false;
      policy.generation++;
      savePolicy();
    }
  });
  return changedCache();
}

function updateAccess(entry, mode, { policy, saveEntry, savePolicy }) {
  if (entry.mode !== 'automatic') return false;
  if (mode === 'pinned') entry.mode = 'pinned';
  else {
    entry.lastAccess = ++policy.clock;
    savePolicy();
  }
  saveEntry(entry);
  return mode === 'pinned';
}

async function findOfflineEntry(id, mode, generation, signal) {
  const { entry, promoted } = await cacheTransaction({ write: true, id }, access => {
    signal?.throwIfAborted();
    if (mode === 'automatic') checkAutomaticCache(access.policy, generation);
    const entry = access.rows[0];
    return { entry, promoted: entry && updateAccess(entry, mode, access) };
  });
  if (promoted) await changedCache();
  return entry;
}

export async function pinOfflineTrack(id) { return Boolean(await findOfflineEntry(id, 'pinned')); }
export function authenticatedFolderCover(track) {
  const url = track?.folderCover;
  if (typeof url !== 'string' || typeof track.id !== 'string') return '';
  if (track.provider === 'baidu') {
    const route = /^\/api\/baidu\/cover\?ids=[1-9]\d{0,18}(?:%2C[1-9]\d{0,18}){0,2}&folder=[\w-]{22}&v=[\w-]{22}&proof=[\w-]{43}$/;
    return track.id.startsWith('baidu:') && route.test(url) ? url : '';
  }
  if (track.provider !== 'webdav' && track.provider !== 'smb') return '';
  const match = /^\/api\/sources\/([a-f0-9-]{36})\/cover\?id=[\w-]+$/.exec(url);
  return match && track.id.startsWith(match[1] + ':') ? url : '';
}
export function offlineFolderCover(id, source, onLoad) {
  if (!folderCoverIds.has(id)) return;
  const cached = folderCovers.get(id);
  if (cached) return cached.source === source ? cached.url : undefined;
  if (folderCoverReads.has(id)) return null;
  const request = store('readonly', entries => entries.get(id), coverTable);
  folderCoverReads.set(id, request);
  void request.then(record => {
    if (folderCoverReads.get(id) !== request) return;
    const blob = record?.blob || binaryBlob(record?.binary);
    if (!blob) { folderCoverIds.delete(id); return; }
    folderCovers.set(id, { source: record.source, url: URL.createObjectURL(blob) });
  }).catch(() => {
    if (folderCoverReads.get(id) === request) folderCoverIds.delete(id);
  }).finally(() => {
    if (folderCoverReads.get(id) !== request) return;
    folderCoverReads.delete(id);
    onLoad();
  });
  return null;
}
async function readAvailableAudio(id) {
  const saved = await cacheTransaction({ write: true, mediaTables: true, id }, access => {
    const entry = access.rows[0];
    if (!entry) return;
    updateAccess(entry, undefined, access);
    access.receive(access.audio.get(id), record => {
      if (record) access.setResult({ blob: record.blob || binaryBlob(record.binary), revision: entry.revision });
    });
  });
  if (!saved?.blob) { forgetMemory(id); return; }
  return saved;
}
export async function readOfflineBlob(id) { return (await readAvailableAudio(id))?.blob; }
export async function loadOfflineUrl(id, protectedUrl) {
  for (const url of retiredMedia) if (url !== protectedUrl) {
    URL.revokeObjectURL(url);
    retiredMedia.delete(url);
  }
  if (media.has(id)) {
    const entry = await findOfflineEntry(id);
    if (!entry) { forgetMemory(id); return; }
    const cached = media.get(id);
    if (cached && cached.revision === entry.revision) {
      media.delete(id);
      media.set(id, cached);
      return cached.url;
    }
    if (cached) forgetMemory(id);
  }
  const saved = await readAvailableAudio(id);
  if (!saved) return;
  if (media.get(id)?.revision === saved.revision && media.has(id)) return media.get(id).url;
  if (media.has(id)) forgetMemory(id);
  const url = URL.createObjectURL(saved.blob);
  media.set(id, { url, revision: saved.revision });
  if (media.size > 3) {
    const [oldId, { url: oldUrl }] = [...media].find(([key, value]) => key !== id && value.url !== protectedUrl);
    media.delete(oldId);
    URL.revokeObjectURL(oldUrl);
  }
  return url;
}
export class UncacheableAudioError extends Error {}
async function readBlob(response, contentType, maxBytes, oversize) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel();
    throw oversize();
  }
  const reader = response.body.getReader();
  const pieces = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw oversize();
      }
      pieces.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(pieces, { type: contentType });
}
export async function fetchAudioBlob(src, { signal, allowUnknownType = false, maxBytes = defaultAudioLimit } = {}) {
  const response = await fetch(src, { signal });
  const contentType = (response.headers.get('content-type') || '').split(';')[0];
  if (response.status !== 200 || !response.body ||
    (!(allowUnknownType && !contentType) && !/^(?:audio\/|application\/(?:octet-stream|ogg)$|video\/(?:mp4|webm)$)/.test(contentType))) {
    await response.body?.cancel();
    const ErrorType = response.status === 200 ? UncacheableAudioError : Error;
    throw new ErrorType('来源未返回可保存的音频。');
  }
  const blob = await readBlob(response, contentType, maxBytes,
    () => new UncacheableAudioError('单首音频最多可读取 ' + Math.floor(maxBytes / 1024 / 1024) + ' MB。'));
  if (!blob.size) throw new UncacheableAudioError('音频文件为空。');
  return blob;
}
const customCoverPath = /^\/api\/metadata\/artwork\/image\?id=[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function customCoverIdentity(value) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  const match = /^(custom-artwork:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:)(.+)$/.exec(value);
  if (!match) return '';
  try {
    const key = JSON.parse(match[2]);
    if (!Array.isArray(key) || key.length !== 3 || key[0] !== 'album' || !key[1] ||
        key.slice(1).some(text => typeof text !== 'string' || text.length > 200 || /[\u0000-\u001f\u007f]/u.test(text))) return '';
    return match[1] + JSON.stringify(['album', ...key.slice(1).map(text => text.normalize('NFC').toLowerCase())]);
  } catch { return ''; }
}
function coverSignature(bytes, type) {
  const starts = values => values.every((value, index) => bytes[index] === value);
  if (type === 'image/png') return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (type === 'image/jpeg') return starts([255, 216, 255]);
  if (type === 'image/gif') return starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]);
  return type === 'image/webp' && starts([82, 73, 70, 70]) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value);
}
async function fetchCover(source, id, signal, custom = false) {
  if (!source) return;
  const timeout = AbortSignal.timeout(5000);
  try {
    const response = await fetch(source, { redirect: 'error', credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (response.status !== 200 || !response.body || !(custom ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] : ['image/png', 'image/jpeg']).includes(type)) {
      await response.body?.cancel();
      return;
    }
    const blob = await readBlob(response, type, folderCoverLimit, () => new Error('图片超过 8 MB。'));
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (coverSignature(bytes, type)) return { id, source, blob };
  } catch { /* The audio copy remains available if artwork cannot be saved. */ }
}

async function storeMedia(record, artwork, { mode, generation, signal }) {
  const { id } = record;
  const change = await cacheTransaction({ write: true, mediaTables: true }, access => {
    signal?.throwIfAborted();
    const { policy, rows, saveEntry, savePolicy, audio, cover, remove } = access;
    const bytes = bodySize(record);
    const coverBytes = bodySize(artwork);
    if (mode === 'automatic') checkAutomaticCache(policy, generation, bytes);
    const existing = rows.find(entry => entry.id === id);
    if (existing) return updateAccess(existing, mode, access);
    const publish = () => {
      if (mode === 'automatic') {
        for (const victim of automaticEvictions(rows, policy.limitMiB, bytes)) remove(victim);
      }
      const revision = ++policy.clock;
      savePolicy();
      saveEntry({ id, mode, bytes, coverBytes, lastAccess: revision, revision });
    };
    // WebKit's Blob serialization can fail before its storage request finishes.
    // Wait for each payload before queuing the index writes so abort can finish.
    access.receive(audio.put(record), () => {
      if (artwork) access.receive(cover.put(artwork), publish);
      else publish();
    });
    return true;
  });
  if (change) await changedCache();
}

async function persistMedia(record, cover, options) {
  if (!binaryFallback) {
    try { await storeMedia(record, cover, options); return; }
    catch (error) {
      if (!needsBinaryFallback(error)) throw error;
      binaryFallback = true;
    }
  }
  const [binary, coverBinary] = await Promise.all([toBinary(record.blob), toBinary(cover?.blob)]);
  await storeMedia({ id: record.id, binary }, cover && { id: cover.id, source: cover.source, binary: coverBinary }, options);
}

export async function cacheAudio(track, options = {}) {
  const { mode = 'pinned', generation, signal } = options;
  if (await findOfflineEntry(track.id, mode, generation, signal)) return;
  const blob = await fetchAudioBlob(track.src, options);
  await saveOfflineTrack(track, blob, options);
}
export async function saveOfflineTrack(track, blob, { signal, coverSource, coverIdentity, mode = 'pinned', generation } = {}) {
  const { id } = track;
  if (await findOfflineEntry(id, mode, generation, signal)) return;
  signal?.throwIfAborted();
  let cover = await fetchCover(authenticatedFolderCover(track), track.id, signal);
  if (!cover && typeof coverSource === 'string' && customCoverPath.test(coverSource)) {
    signal?.throwIfAborted();
    cover = await fetchCover(coverSource, track.id, signal, true);
    if (cover) cover.source = customCoverIdentity(coverIdentity) || coverSource;
  }
  signal?.throwIfAborted();
  const record = { id, blob };
  const options = { mode, generation, signal };
  try {
    await persistMedia(record, cover, options);
  } catch (error) {
    if (!cover || error?.name !== 'QuotaExceededError') throw error;
    signal?.throwIfAborted();
    cover = undefined;
    await persistMedia(record, undefined, options);
  }
}
export async function removeOffline(id) {
  await cacheTransaction({ write: true, mediaTables: true, id }, ({ remove }) => remove(id));
  forgetMemory(id, false);
  await changedCache();
}
