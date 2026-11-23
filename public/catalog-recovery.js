import { readCloudCatalogState, finalizeCloudCatalogRestore, cancelCloudCatalogRestore,
  CloudCatalogError, legacyCloudCatalogScope } from './cloud-catalog.js';
import { readStateTextAtScope, StateScopeError } from './library.js';

export function withCatalogRestoreLock(operation) {
  return globalThis.navigator?.locks?.request
    ? navigator.locks.request('groovebox.catalog-restore', { mode: 'exclusive' }, operation)
    : operation();
}

const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function parseScopedAppState(text, scope) {
  try {
    if (typeof text !== 'string') throw new Error();
    const value = JSON.parse(text);
    if (!object(value) || value._grooveboxStateScope !== scope || !object(value.settings) ||
        !Array.isArray(value.playlists) || !value.playlists.every(list => object(list) &&
          typeof list.id === 'string' && typeof list.name === 'string' && Array.isArray(list.tracks) &&
          list.tracks.every(id => typeof id === 'string')) ||
        !Array.isArray(value.favorites) || !value.favorites.every(id => typeof id === 'string') ||
        !Array.isArray(value.tracks) || !value.tracks.every(track => object(track) && typeof track.id === 'string')) throw new Error();
    return value;
  } catch (cause) { throw new StateScopeError('state-scope-invalid', cause); }
}

export function recoverCloudCatalogState() {
  return withCatalogRestoreLock(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const active = await readCloudCatalogState();
      if (!active.pending) return active;
      const { pending } = active;
      const text = readStateTextAtScope(pending.scope);
      try {
        if (text === null) {
          await cancelCloudCatalogRestore(pending.id, { expectedScope: active.scope });
        } else {
          if (typeof pending.stateText !== 'string' || text !== pending.stateText) throw new StateScopeError('state-scope-invalid');
          parseScopedAppState(text, pending.scope);
          await finalizeCloudCatalogRestore(pending.id, { expectedScope: active.scope, candidateText: text });
        }
      } catch (error) {
        // A peer may have finalized or canceled after this coherent snapshot was read.
        if (!(error instanceof CloudCatalogError) || error.code !== 'cloud-catalog-conflict') throw error;
      }
    }
    throw new CloudCatalogError('cloud-catalog-restore-pending', 'Cloud library recovery is still in progress');
  });
}

export function readScopedAppState(scope) {
  if (scope === legacyCloudCatalogScope) throw new StateScopeError('state-scope-invalid');
  return parseScopedAppState(readStateTextAtScope(scope), scope);
}
