import { readPlaylistCreationDates } from './playlist-overview.js';

export const maxPlaylistSnapshotBytes = 1_000_000;
const format = 'groovebox-playlists';
const playlistId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// This is a server-derived, application-namespaced binding to a provider account ID.
// A session ID, access token, refresh token, or email address must never be used here.
const accountKey = /^[A-Za-z0-9_-]{43}$/;
const decimal = /^(?:0|[1-9][0-9]{0,19})$/;
const signedLimit = 9223372036854775807n;
const baiduFile = id => typeof id === 'string' && decimal.test(id) && id !== '0' && BigInt(id) <= signedLimit;
const googleDriveFile = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id);
const dropboxFile = id => typeof id === 'string' && /^id:[A-Za-z0-9_-]{1,256}$/.test(id);
const oneDriveFile = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_!.-]{0,255}$/.test(id);
const fileValidators = new Map([['baidu', baiduFile], ['gdrive', googleDriveFile], ['dropbox', dropboxFile], ['onedrive', oneDriveFile]]);
const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const labelKeys = ['title', 'artist', 'album'];
const suspiciousLabel = /\p{Cc}|(?:\b(?:https?|ftp)\s*(?::|%3a)\s*(?:\/|%2f){2}|\b(?:data|blob|file):|\b(?:bearer|basic)\s+[A-Za-z0-9+/._~-]{12,}|\b(?:access_token|refresh_token|client_secret|authorization|x-amz-[a-z-]+|signature|sig)\s*(?::|=|%3a|%3d))/iu;
const localPath = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/(?:home|Users|private|mnt|Volumes)\/)/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const validCreatedAt = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

function requireValue(condition, message) {
  if (!condition) throw new TypeError(message);
}

function shape(value, required, optional = []) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function isLabel(value, length) {
  return typeof value === 'string' && value.length <= length && Boolean(value.trim())
    && !suspiciousLabel.test(value) && !localPath.test(value.trim());
}

function isUuid(value) {
  return typeof value === 'string' && playlistId.test(value);
}

function isScope(scope) {
  return shape(scope, ['provider', 'account']) && fileValidators.has(scope.provider)
    && typeof scope.account === 'string' && accountKey.test(scope.account);
}

export function validPlaylistSnapshotFile(provider, id) {
  return fileValidators.get(provider)?.(id) === true;
}

function validateSnapshot(value, expectedScope) {
  requireValue(isScope(expectedScope), 'Invalid expected cloud account');
  requireValue(shape(value, ['format', 'version', 'operation', 'scope', 'tracks', 'playlists', 'favorites'])
    && value.format === format && [1, 2, 3].includes(value.version) && typeof value.operation === 'string' && operationId.test(value.operation)
    && Array.isArray(value.tracks) && Array.isArray(value.playlists) && Array.isArray(value.favorites),
  'Invalid playlist snapshot');
  requireValue(isScope(value.scope) && value.scope.provider === expectedScope.provider
    && value.scope.account === expectedScope.account, 'Snapshot belongs to a different cloud account');

  const files = new Set();
  for (const track of value.tracks) {
    requireValue(shape(track, [], ['file', ...labelKeys]), 'Unknown snapshot track field');
    if (Object.hasOwn(track, 'file')) {
      requireValue(validPlaylistSnapshotFile(value.scope.provider, track.file) && !files.has(track.file),
        'Invalid or duplicate cloud file reference');
      files.add(track.file);
    }
    for (const key of labelKeys) {
      requireValue(!Object.hasOwn(track, key) || isLabel(track[key], 256), 'Invalid snapshot track label');
    }
  }

  const references = new Set();
  function checkTrackReferences(entries) {
    requireValue(Array.isArray(entries), 'Invalid snapshot track order');
    for (const index of entries) {
      requireValue(Number.isSafeInteger(index) && index >= 0 && index < value.tracks.length,
        'Invalid snapshot track reference');
      references.add(index);
    }
  }

  const listIds = new Set();
  for (const list of value.playlists) {
    const optional = value.version === 3 ? ['id', 'createdAt', 'modifiedAt'] : value.version === 2 ? ['id', 'createdAt'] : ['id'];
    requireValue(shape(list, ['name', 'tracks'], optional) && isLabel(list.name, 80), 'Invalid snapshot playlist');
    requireValue(!Object.hasOwn(list, 'createdAt') || validCreatedAt(list.createdAt), 'Invalid playlist creation date');
    requireValue(!Object.hasOwn(list, 'modifiedAt') || validCreatedAt(list.modifiedAt), 'Invalid playlist modification date');
    if (Object.hasOwn(list, 'id')) {
      requireValue(isUuid(list.id) && !listIds.has(list.id), 'Invalid or duplicate playlist ID');
      listIds.add(list.id);
    }
    checkTrackReferences(list.tracks);
  }
  checkTrackReferences(value.favorites);
  requireValue(new Set(value.favorites).size === value.favorites.length, 'Duplicate snapshot favorite');
  requireValue(references.size === value.tracks.length, 'Unreferenced track in snapshot');
  return value;
}

// verifiedFiles contains local-track-ID → provider-file-ID mappings that the adapter
// verified for this account. Never populate it by parsing stored stream URLs or track IDs.
export function createPlaylistSnapshot(input, { scope, operation, verifiedFiles }) {
  requireValue(isScope(scope) && verifiedFiles instanceof Map, 'Invalid backup destination');
  const { tracks, playlists, favorites } = input;
  requireValue(Array.isArray(tracks) && Array.isArray(playlists) && Array.isArray(favorites), 'Invalid playlist state');
  const dates = readPlaylistCreationDates(input.playlistCreationDates, playlists);
  const modificationDates = readPlaylistCreationDates(input.playlistModificationDates, playlists);
  const tracksById = new Map(tracks.map(track => [track.id, track]));
  const indexById = new Map();
  const indexByFile = new Map();
  const descriptors = [];

  function useTrack(id) {
    requireValue(typeof id === 'string' && Boolean(id), 'Invalid library track ID');
    if (indexById.has(id)) return indexById.get(id);
    const track = tracksById.get(id);
    const file = verifiedFiles.get(id);
    if (file !== undefined) requireValue(validPlaylistSnapshotFile(scope.provider, file), 'Invalid verified file ID');
    const previousIndex = indexByFile.get(file);
    const index = previousIndex ?? descriptors.length;
    if (previousIndex === undefined) {
      const description = file === undefined ? {} : { file };
      for (const key of labelKeys) {
        if (isLabel(track?.[key], 256)) description[key] = track[key];
      }
      descriptors.push(description);
      if (file !== undefined) indexByFile.set(file, index);
    }
    indexById.set(id, index);
    return index;
  }

  const snapshot = {
    format,
    version: playlists.some(list => modificationDates.has(list.id)) ? 3 : playlists.some(list => dates.has(list.id)) ? 2 : 1,
    operation,
    scope: { provider: scope.provider, account: scope.account },
    tracks: descriptors,
    playlists: playlists.map(list => ({
      ...(isUuid(list.id) && { id: list.id }),
      ...(dates.has(list.id) && { createdAt: dates.get(list.id) }),
      ...(modificationDates.has(list.id) && { modifiedAt: modificationDates.get(list.id) }),
      name: list.name,
      tracks: list.tracks.map(useTrack),
    })),
    favorites: [...new Set(favorites.map(useTrack))],
  };
  validateSnapshot(snapshot, scope);
  const bytes = textEncoder.encode(JSON.stringify(snapshot));
  requireValue(bytes.byteLength <= maxPlaylistSnapshotBytes, 'Playlist snapshot exceeds the size limit');
  return bytes;
}

export function readPlaylistSnapshot(bytes, expectedScope) {
  requireValue(bytes instanceof Uint8Array && bytes.byteLength <= maxPlaylistSnapshotBytes,
    'Playlist snapshot exceeds the size limit or is unreadable');
  let value;
  let text;
  try {
    text = textDecoder.decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new TypeError('Invalid UTF-8 playlist snapshot JSON');
  }
  validateSnapshot(value, expectedScope);
  // Reject ambiguous input, including duplicate keys JSON.parse would otherwise discard.
  requireValue(JSON.stringify(value) === text, 'Noncanonical playlist snapshot JSON');
  return value;
}
