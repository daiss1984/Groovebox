import { SourceSessionStoreError } from './source-session-store.mjs';

const opaqueKey = /^[A-Za-z0-9_-]{24}$/;
const mediaKey = /^[A-Za-z0-9_-]{24}(?:-lyrics)?$/;
const serverFolderActions = new Set(['getArtist', 'getAlbum', 'getPlaylist']);
const subsonicTypes = new Set(['subsonic', 'opensubsonic', 'navidrome', 'fnmusic']);
const imageTypes = new Set(['image/jpeg', 'image/png']);

function invalid() { throw new SourceSessionStoreError('invalid'); }
function checkedText(value, limit, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function id(value) { return Number.isSafeInteger(value) ? value : checkedText(value, 4096); }
function year(value) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1000 || value > 9999) invalid();
  return value;
}
function object(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return value;
}
function pairs(value, limit, pattern, convert) {
  const entries = value instanceof Map ? [...value] : value;
  if (!Array.isArray(entries) || entries.length > limit) invalid();
  const result = new Map();
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pattern.test(pair[0]) || result.has(pair[0])) invalid();
    result.set(pair[0], convert(pair[1]));
  }
  return result;
}

function smbParts(value) {
  if (!Array.isArray(value) || !value.length || value.length > 40) invalid();
  return value.map(part => {
    if (checkedText(part, 255) === '.' || part === '..' || /[\\/:*?"<>|]|[ .]$/.test(part)) invalid();
    return part;
  });
}

function providerEndpoint(source, value, scoped, kind) {
  const raw = checkedText(value instanceof URL ? value.href : value, 8192);
  const endpoint = scoped(source, raw);
  const path = endpoint.pathname.slice(source.base.pathname.length);
  if ([...endpoint.searchParams.keys()].some(key => /^(?:access_token|token|api_key|x-plex-token|authorization|password)$/i.test(key))) invalid();
  if (source.type === 'webdav' && endpoint.search) invalid();
  if (subsonicTypes.has(source.type)) {
    const action = { stream: 'stream', cover: 'getCoverArt', lyrics: 'getLyricsBySongId' }[kind];
    const prefix = source.base.pathname.endsWith('/rest/') ? '' : 'rest/';
    if (!action || path !== prefix + action + '.view' ||
        [...endpoint.searchParams.keys()].some(key => /^(?:u|p|s|t)$/i.test(key))) invalid();
  }
  if (source.type === 'kodi' && !path.startsWith(kind === 'stream' ? 'vfs/' : 'image/')) invalid();
  if (source.type === 'songloft') {
    const suffix = { stream: 'play', cover: 'cover', lyrics: 'lyric' }[kind];
    if (!suffix || !new RegExp('^api/v1/songs/[1-9]\\d*/' + suffix + '$').test(path)) invalid();
  }
  if (source.type === 'emby' || source.type === 'jellyfin') {
    const shape = { stream: /^Audio\/[^/]+\/stream$/, cover: /^Items\/[^/]+\/Images\/Primary$/, lyrics: /^Audio\/[^/]+\/Lyrics$/ }[kind];
    if (!shape?.test(path)) invalid();
  }
  if (source.type === 'plex') {
    const valid = kind === 'stream' ? path.startsWith('library/parts/') : kind === 'folder' ?
      /^(?:library\/sections\/\d+\/all|library\/metadata\/.+\/children)$/.test(path) : path.startsWith('library/metadata/');
    if (!valid) invalid();
  }
  return endpoint;
}

function folderLocation(source, value, scoped) {
  const type = source.type;
  if (type === 'smb') return smbParts(value);
  if (type === 'webdav') return providerEndpoint(source, value, scoped, 'folder');
  if (type === 'plex') {
    if (value instanceof URL || typeof value === 'string') return providerEndpoint(source, value, scoped, 'folder');
    const { endpoint, releaseYear } = object(value);
    return { endpoint: providerEndpoint(source, endpoint, scoped, 'folder'), releaseYear: year(releaseYear) };
  }
  if (type === 'kodi') {
    if (value === 'singles') return value;
    const folder = object(value);
    if (!Number.isSafeInteger(folder.id) || folder.id <= 0) invalid();
    return { id: folder.id, releaseYear: year(folder.releaseYear) };
  }
  if (subsonicTypes.has(type)) {
    const folder = object(value);
    if (!serverFolderActions.has(folder.action)) invalid();
    return { action: folder.action, id: id(folder.id), releaseYear: year(folder.releaseYear),
      coverArt: folder.coverArt == null ? undefined : id(folder.coverArt) };
  }
  if (type === 'emby' || type === 'jellyfin') {
    if (typeof value === 'string' || Number.isSafeInteger(value)) return id(value);
    const folder = object(value);
    if (folder.action === 'getPlaylist') return { action: folder.action, id: id(folder.id),
      serverId: folder.serverId == null ? undefined : checkedText(folder.serverId, 128, true) };
    if (folder.action !== undefined) invalid();
    return { id: id(folder.id), releaseYear: year(folder.releaseYear) };
  }
  return invalid();
}

function coverCandidates(source, value, scoped) {
  if (!['webdav', 'smb'].includes(source.type) || !Array.isArray(value) || !value.length || value.length > 3) invalid();
  return value.map(candidate => {
    const { type, location, parts, size, modified } = object(candidate);
    if (!imageTypes.has(type)) invalid();
    return source.type === 'smb'
      ? { type, parts: smbParts(parts), size: sizeValue(size), modified: Number.isFinite(modified) ? modified : undefined }
      : { type, location: providerEndpoint(source, location, scoped, 'cover') };
  });
}

function sizeValue(value) {
  const size = typeof value === 'string' && /^\d{1,18}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function mediaLocation(source, input, scoped) {
  const { stream, art, serverLyrics, sidecar, type, size, key, playback, duration, jellyfinItemId, folderCoverCandidates } = object(input);
  const result = {};
  if (stream != null) result.stream = source.type === 'smb' ? smbParts(stream) : providerEndpoint(source, stream, scoped, 'stream');
  if (art != null) result.art = providerEndpoint(source, art, scoped, 'cover');
  if (serverLyrics != null) {
    if (source.type === 'emby') {
      const lyric = object(serverLyrics);
      if (String(lyric.userId) !== String(source.userId)) invalid();
      result.serverLyrics = { itemId: id(lyric.itemId), userId: id(lyric.userId),
        mediaSourceId: lyric.mediaSourceId == null ? undefined : id(lyric.mediaSourceId) };
    } else if (subsonicTypes.has(source.type) || ['jellyfin', 'songloft'].includes(source.type)) {
      result.serverLyrics = providerEndpoint(source, serverLyrics, scoped, 'lyrics');
    } else invalid();
  }
  if (folderCoverCandidates !== undefined) result.folderCoverCandidates = coverCandidates(source, folderCoverCandidates, scoped);
  if (!Object.keys(result).length) invalid();
  if (sidecar === true) result.sidecar = true;
  if (typeof type === 'string' && /^audio\/[a-z\d.+-]+$/i.test(type)) result.type = type;
  const safeSize = sizeValue(size);
  if (safeSize !== undefined) result.size = safeSize;
  if (typeof key === 'string') result.key = checkedText(key, 8192);
  if (playback != null) {
    if (source.type !== 'emby') invalid();
    const info = object(playback);
    result.playback = { itemId: checkedText(info.itemId, 4096),
      mediaSourceId: info.mediaSourceId == null ? undefined : id(info.mediaSourceId) };
    if (Number.isFinite(duration) && duration >= 0) result.duration = duration;
  }
  if (jellyfinItemId !== undefined) {
    if (source.type !== 'jellyfin' || !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(jellyfinItemId)) invalid();
    result.jellyfinItemId = jellyfinItemId;
  }
  return result;
}

export function readSourceIndex(source, index, scoped) {
  const { folders, media, portraitEntries = [] } = object(index);
  const foldersById = pairs(folders, 25000, opaqueKey, location => folderLocation(source, location, scoped));
  const mediaById = pairs(media, 60000, mediaKey, record => mediaLocation(source, record, scoped));
  if (!Array.isArray(portraitEntries) || portraitEntries.length > 20000) invalid();
  const portraits = portraitEntries.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[1] !== 'string' || !opaqueKey.test(entry[1]) ||
        !mediaById.get(entry[1])?.folderCoverCandidates) invalid();
    return [checkedText(entry[0], 4096), entry[1]];
  });
  return { folders: foldersById, media: mediaById, portraitEntries: portraits };
}
