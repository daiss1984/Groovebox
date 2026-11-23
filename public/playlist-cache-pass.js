const legacyKey = 'groovebox.playlist-cache-pass.v1';
export const playlistCachePassMarkerPrefix = 'groovebox.playlist-cache-pass.v2:';
const legacyPrefix = playlistCachePassMarkerPrefix + 'legacy:';

function validGeneration(generation) {
  return Number.isSafeInteger(generation) && generation >= 0;
}

function validId(id) {
  return typeof id === 'string' && id.length > 0;
}

function marker(generation, id) {
  return playlistCachePassMarkerPrefix + generation + ':' + id;
}

function legacyIds(storage, generation) {
  try {
    const previous = JSON.parse(storage.getItem(legacyKey));
    if (previous?.generation === generation && Array.isArray(previous.attempted)) return previous.attempted.filter(validId);
  } catch {
    // A missing or damaged legacy record does not affect the independent markers.
  }
  return [];
}

export function readPlaylistCachePass(generation, storage) {
  const attempted = new Set();
  if (!validGeneration(generation)) return attempted;
  const reset = new Set();
  const obsolete = [];
  try {
    storage ??= globalThis.localStorage;
    for (let index = 0, count = storage.length; index < count; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(playlistCachePassMarkerPrefix)) continue;
      const legacy = key.startsWith(legacyPrefix);
      const suffix = key.slice((legacy ? legacyPrefix : playlistCachePassMarkerPrefix).length);
      const separator = suffix.indexOf(':');
      const version = suffix.slice(0, separator);
      const id = suffix.slice(separator + 1);
      const value = Number(version);
      if (separator < 1 || !validId(id) || !validGeneration(value) || String(value) !== version) continue;
      if (value < generation) obsolete.push(key);
      if (value !== generation) continue;
      const entry = storage.getItem(key);
      if (entry === '1') attempted.add(id);
      if (entry === '0' && !legacy) reset.add(id);
    }
    const migrate = [];
    for (const id of legacyIds(storage, generation)) {
      if (attempted.has(id) || reset.has(id)) continue;
      attempted.add(id);
      migrate.push(id);
    }
    for (const key of obsolete) storage.removeItem(key);
    // Keep migration separate so it can never overwrite an explicit record or reset from another tab.
    for (const id of migrate) storage.setItem(legacyPrefix + generation + ':' + id, '1');
  } catch {
    // In-memory tracking can still be used when persistent storage is blocked or full.
  }
  for (const id of reset) attempted.delete(id);
  return attempted;
}

export function recordPlaylistCacheAttempt(generation, id, storage) {
  if (!validGeneration(generation) || !validId(id)) return;
  try {
    storage ??= globalThis.localStorage;
    storage.setItem(marker(generation, id), '1');
  } catch {
    // The caller also records the attempt in memory.
  }
}

export function resetPlaylistCacheAttempts(generation, ids, storage) {
  if (!validGeneration(generation)) return;
  try {
    storage ??= globalThis.localStorage;
    for (const id of ids) {
      // An explicit reset takes precedence over compat markers and the old shared record.
      if (validId(id)) storage.setItem(marker(generation, id), '0');
    }
  } catch {
    // The caller can still reset the attempt in its current tab.
  }
}
