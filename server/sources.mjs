import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { XMLParser } from 'fast-xml-parser';
import { createSmbSource, SmbError } from './smb.mjs';
import { prepareFnMusicSource, FnMusicError } from './fnmusic.mjs';
import { readEmbyLyrics } from './emby-lyrics.mjs';
import { imageSignature } from './artwork.mjs';
import { createPlexAuthorization, PlexAuthError } from './plex-auth.mjs';
import { normalizeArtists, normalizeGenres } from '../public/genres.js';
import { streamBitrates, supportsStreamBitrate } from '../public/stream-bitrate.js';
import { createSourceSessionStore, SourceSessionStoreError } from './source-session-store.mjs';
import { readSourceIndex } from './source-session-index.mjs';

const pathPrefix = '/api/sources';
const maxSourceAddress = 8192;
const cookieName = 'groovebox_sources';
const sessionLife = 7 * 24 * 60 * 60 * 1000;
const sourceTypes = new Set(['webdav', 'subsonic', 'opensubsonic', 'navidrome', 'jellyfin', 'emby', 'plex', 'kodi', 'smb', 'songloft', 'fnmusic']);
const playlistSourceTypes = new Set(['subsonic', 'opensubsonic', 'navidrome', 'emby', 'jellyfin']);
const audioTypes = new Map(Object.entries({
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'audio/mp4',
  aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', wave: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff',
  ape: 'audio/x-ape', wma: 'audio/x-ms-wma', m4b: 'audio/mp4', webm: 'audio/webm',
  dsf: 'audio/x-dsf', dff: 'audio/x-dff',
}));
const lyricExtensions = new Set(['lrc', 'vtt']);
const maxLyricBytes = 1_000_000;
const backupFile = 'groovebox-playlists.json';
const maxBackupBytes = 1_000_000;
const lyricTypes = new Set([
  '', 'text/plain', 'text/vtt', 'text/lrc', 'text/x-lrc',
  'application/lrc', 'application/x-lrc', 'application/octet-stream', 'binary/octet-stream',
]);
const safeImages = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const maxUntypedKodiCoverBytes = 8 * 1024 * 1024;
const maxDavCoverBytes = 8 * 1024 * 1024;
const davCoverFile = /^cover\.(png|jpe?g)$/i;
const embyPlaybackRoutes = { start: 'Sessions/Playing', progress: 'Sessions/Playing/Progress', stop: 'Sessions/Playing/Stopped' };
const embyProgressReasons = new Set(['TimeUpdate', 'Pause', 'Unpause']);
const playbackSessionLifetime = 24 * 60 * 60 * 1000;
const playbackSessionSaveInterval = 5 * 60 * 1000;
const xml = new XMLParser({ removeNSPrefix: true, parseTagValue: false });
const davQuery = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><displayname/><resourcetype/><getcontentlength/><getcontenttype/><getetag/><getlastmodified/></prop></propfind>';

class SourceError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function array(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? [value] : [];
}

function text(value, limit = 4096) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function releaseYear(value) {
  if (typeof value === 'string' && /^\d{4}(?:-\d{2}-\d{2})?$/.test(value)) value = Number(value.slice(0, 4));
  return Number.isInteger(value) && value >= 1000 && value <= 9999 ? value : undefined;
}

async function readBody(body, maxSize) {
  if (!body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += Buffer.byteLength(chunk);
    if (total > maxSize) throw new SourceError(413, '请求或响应内容过大');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

async function bodyText(body, maxSize) {
  return (await readBody(body, maxSize)).toString('utf8');
}

async function requestData(fetchImpl, source, endpoint, { missingIsEmpty = false, ...options } = {}) {
  const response = await upstream(fetchImpl, source, endpoint, options);
  if (!response.ok) {
    await response.body?.cancel();
    if (missingIsEmpty && response.status === 404) return;
    if ([401, 403].includes(response.status)) throw new SourceError(401, '媒体服务器拒绝访问，请检查凭据');
    throw new SourceError(502, '媒体服务器返回错误（' + response.status + '）');
  }
  return bodyText(response.body, 8 * 1024 * 1024);
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new SourceError(502, '媒体服务器返回的格式不正确');
  }
}

function localHost(host) {
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host || '');
}

function loopback(address) {
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function authorizeClient(req, plexReturn = false) {
  if (!loopback(req.socket.remoteAddress) || !localHost(req.headers.host)) {
    throw new SourceError(403, '媒体服务器连接仅在本机播放器开放');
  }
  const origin = req.headers.origin;
  if (!plexReturn && ((req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
    || (origin && origin !== 'http://' + req.headers.host && origin !== 'https://' + req.headers.host))) {
    throw new SourceError(403, '请求来源与播放器地址不一致');
  }
}

function safeEndpoint(source, endpoint) {
  const url = new URL(endpoint instanceof URL ? endpoint.href : endpoint, source.base);
  const relative = url.pathname.slice(source.base.pathname.length);
  const kodiResource = source.type === 'kodi' && /^(?:vfs|image)\/(?:[a-z\d_.!~*'()-]|%[a-f\d]{2})+$/i.test(relative);
  if (url.origin !== source.base.origin || url.username || url.password || url.hash
    || !url.pathname.startsWith(source.base.pathname)
    || (/%(?:2f|5c|00)/i.test(url.pathname) && !kodiResource)) {
    throw new SourceError(502, '媒体服务器指向了音乐来源之外的地址');
  }
  return url;
}

function internal(source, path, params = {}) {
  const url = safeEndpoint(source, path);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function upstream(fetchImpl, source, endpoint, options = {}) {
  let url = safeEndpoint(source, endpoint);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const headerTimeout = new AbortController();
    const timer = setTimeout(() => headerTimeout.abort(), 15000);
    let response;
    try {
      response = await fetchImpl(url, {
        method: options.method || 'GET',
        headers: {
          'Accept-Encoding': 'identity',
          ...source.headers,
          ...options.headers,
        },
        body: options.body,
        redirect: 'manual',
        signal: options.signal ? AbortSignal.any([options.signal, headerTimeout.signal]) : headerTimeout.signal,
      });
    } catch {
      throw new SourceError(502, '无法连接媒体服务器，请检查地址和网络');
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get('location');
    if (options.followRedirects === false || ![301, 302, 307, 308].includes(response.status) || !location) return response;
    await response.body?.cancel();
    if (source.type === 'kodi' || source.type === 'songloft') throw new SourceError(502, '媒体服务器返回了重定向，请检查服务地址');
    url = safeEndpoint(source, new URL(location, url));
  }
  throw new SourceError(502, '媒体服务器重定向次数过多');
}

function parseBase(raw, type) {
  if (typeof raw !== 'string' || raw.length > maxSourceAddress) throw new SourceError(400, '服务器地址过长');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError(400, '请输入完整的 HTTP 或 HTTPS 服务器地址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /%(?:2f|5c|00)/i.test(url.pathname)) {
    throw new SourceError(400, '服务器地址只接受不含账号、参数或片段的 HTTP(S) URL');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  if (type === 'emby' && url.pathname === '/') url.pathname = '/emby/';
  if (url.href.length > maxSourceAddress) throw new SourceError(400, '服务器地址过长');
  return url;
}

function endpointFromServer(source, raw, prefix) {
  if (typeof raw !== 'string' || !raw.startsWith(prefix) || raw.startsWith('//')) return null;
  try {
    const target = safeEndpoint(source, raw.slice(1));
    target.searchParams.delete('X-Plex-Token');
    target.searchParams.delete('api_key');
    return target;
  } catch {
    return null;
  }
}

function publicSource(source) {
  return { id: source.id, name: source.name, type: source.type, ...(source.playlistWritable && {
    playlistWritable: true,
    ...(source.playlistAuthority === 'api-key' && { playlistAuthority: 'api-key' }),
  }) };
}

function stableKey(value) {
  return createHash('sha256').update(String(value)).digest('base64url').slice(0, 24);
}

function stableSourceId(source, username) {
  const identity = JSON.stringify([source.type, source.base.href, source.userId || username]);
  const bytes = createHash('sha256').update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const id = bytes.toString('hex');
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}

function emitItems(source, records) {
  return records.map((record) => {
    const id = stableKey(record.key);
    const route = pathPrefix + '/' + source.id;
    const cover = record.art ? { cover: route + '/cover?id=' + id } : {};
    const year = releaseYear(record.releaseYear);
    const release = year === undefined ? {} : { releaseYear: year };
    if (record.folder) {
      source.folders.set(id, record.location);
      if (record.art) source.media.set(id, { art: record.art });
      return { id, name: record.name, path: id, folder: true, size: 0, ...cover, ...release,
        ...(record.albumDiscFolder && { albumDiscFolder: true }), ...(record.artist && { artist: record.artist }),
        ...(record.browseKind && { browseKind: record.browseKind }),
        ...(record.playlistWritable != null && { playlistWritable: record.playlistWritable }) };
    }
    source.media.set(id, record);
    const result = {
      id,
      name: record.name,
      path: record.path || id,
      folder: false,
      size: record.size || 0,
      streamUrl: route + '/stream?id=' + id,
      ...cover,
      ...release,
      ...(Number.isSafeInteger(record.modified) && Math.abs(record.modified) <= 8_640_000_000_000_000 && { modified: record.modified }),
    };
    for (const field of ['title', 'artist', 'album', 'albumArtist', 'albumKey', 'discNumber', 'trackNumber', 'duration', 'playlistLocation', 'fileName']) {
      if (record[field] != null) result[field] = record[field];
    }
    if (record.folderCover) {
      const { id: coverId, candidates } = record.folderCover;
      if (!source.media.has(coverId)) source.media.set(coverId, { folderCoverCandidates: candidates });
      result.folderCover = route + '/cover?id=' + coverId;
    }
    if (record.playlistEntry) result.playlistEntry = record.playlistEntry;
    if (record.playlistRemoveEntry) {
      result.playlistRemoveEntry = record.playlistRemoveEntry;
      result.playlistRemoveCount = record.playlistRemoveCount;
    }
    const artistNames = normalizeArtists(record.artistNames);
    if (artistNames.length) result.artistNames = artistNames;
    const genres = normalizeGenres(record.genres);
    if (genres.length) result.genres = genres;
    if (record.lyric) {
      const lyricId = id + '-lyrics';
      source.media.set(lyricId, { serverLyrics: record.lyric });
      result.lyricsUrl = route + '/stream?id=' + lyricId;
    }
    return result;
  });
}

async function davChildren(fetchImpl, source, target, missingIsEmpty = false) {
  const body = await requestData(fetchImpl, source, target, {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body: davQuery,
    missingIsEmpty,
  });
  if (body === undefined) return [];
  if (/<!DOCTYPE/i.test(body)) throw new SourceError(502, '媒体服务器返回的 XML 格式不受支持');
  const multistatus = xml.parse(body).multistatus;
  if (multistatus == null) throw new SourceError(502, '服务器地址未返回 WebDAV 目录');
  const children = [];
  const directoryName = decodeURIComponent(target.pathname).replace(/\/$/, '');
  for (const entry of array(multistatus.response)) {
    const props = array(entry.propstat).find((propstat) => /\s200\s/.test(propstat.status || ''))?.prop;
    if (!props || typeof entry.href !== 'string') continue;
    try {
      const location = safeEndpoint(source, new URL(entry.href, target));
      if (location.search) continue;
      const pathname = decodeURIComponent(location.pathname).replace(/\/$/, '');
      if (!pathname.startsWith(directoryName + '/')) continue;
      const fallback = pathname.slice(directoryName.length + 1);
      if (!fallback || fallback.includes('/') || fallback === backupFile) continue;
      const folder = typeof props.resourcetype === 'object' && Object.hasOwn(props.resourcetype, 'collection');
      children.push({ props, location, pathname, fileName: fallback, folder });
    } catch (error) {
      if (!(error instanceof URIError || error instanceof SourceError || error instanceof TypeError)) throw error;
    }
  }
  return children;
}

function davRasterCandidate(location, props, extension) {
  return { location, type: extension === 'png' ? 'image/png' : 'image/jpeg',
    revision: [props.getetag, props.getlastmodified, props.getcontentlength] };
}

function davModified(value) {
  if (typeof value !== 'string' || value.length > 100 || !/(?:\bGMT|\bUTC|[+-]\d{2}:?\d{2}|Z)$/i.test(value.trim())) return;
  const modified = Date.parse(value);
  return Number.isSafeInteger(modified) && Math.abs(modified) <= 8_640_000_000_000_000 ? modified : undefined;
}

function orderedDavRasters(rasters) {
  return ['png', 'jpg', 'jpeg'].map(extension => rasters.get(extension)).filter(Boolean);
}

function davRasterKey(kind, candidates) {
  return stableKey(JSON.stringify([kind, ...candidates.map(({ location, revision }) => [location.pathname, ...revision])]));
}

async function listDav(fetchImpl, source, directory) {
  const records = [];
  const covers = new Map();
  for (const { props, location, pathname, fileName, folder } of await davChildren(fetchImpl, source, directory || source.base)) {
    const displayName = text(props.displayname).trim();
    const extension = fileName.split('.').pop().toLowerCase();
    if (!folder && davCoverFile.test(fileName)) {
      if (!covers.has(extension)) covers.set(extension, davRasterCandidate(location, props, extension));
      continue;
    }
    const sidecar = !folder && lyricExtensions.has(extension) && fileName.includes('.');
    const name = sidecar && !displayName.toLowerCase().endsWith('.' + extension) ? fileName : displayName || fileName;
    const mime = audioTypes.get(extension);
    if (!folder && !sidecar && !mime && !String(props.getcontenttype).startsWith('audio/')) continue;
    records.push({
      key: 'dav:' + pathname, name, fileName: folder ? undefined : fileName, path: pathname, folder, location,
      stream: folder ? null : location, playlistLocation: !folder && !sidecar ? location.href : undefined,
      type: mime, sidecar, size: Number(props.getcontentlength) || 0,
      modified: davModified(props.getlastmodified),
    });
  }
  if (covers.size) {
    const candidates = orderedDavRasters(covers);
    const id = davRasterKey('dav-cover', candidates);
    const folderCover = { id, candidates };
    for (const record of records) if (!record.folder && !record.sidecar) record.folderCover = folderCover;
  }
  return records;
}

async function readDavArtistPortraits(fetchImpl, source) {
  const target = internal(source, 'artist/');
  const artists = new Map();
  for (const { props, location, fileName, folder } of await davChildren(fetchImpl, source, target, true)) {
    const match = !folder && /^([^\x00-\x1f\x7f]+)\.(png|jpe?g)$/i.exec(fileName);
    const artist = match && match[1].normalize('NFC').trim().toLowerCase();
    if (!artist) continue;
    const extension = match[2].toLowerCase();
    const rasters = artists.get(artist) || new Map();
    // Equally ranked names that normalize to one artist are ambiguous.
    rasters.set(extension, rasters.has(extension) ? null : davRasterCandidate(location, props, extension));
    artists.set(artist, rasters);
  }
  return [...artists].map(([artist, rasters]) => [artist, orderedDavRasters(rasters)]).filter(([, candidates]) => candidates.length);
}

function listArtistPortraits(fetchImpl, source) {
  if (source.portraitIndex) return source.portraitIndex.request;
  const index = { ids: new Set() };
  const smb = source.type === 'smb';
  const request = smb ? source.smb.listArtistPortraits() : readDavArtistPortraits(fetchImpl, source);
  index.request = request.then(artists => {
    if (source.portraitIndex !== index) return [];
    index.portraits = artists.map(([artist, candidates]) => {
      const id = smb ? stableKey(JSON.stringify(['smb-artist', candidates])) : davRasterKey('dav-artist', candidates);
      index.ids.add(id);
      source.media.set(id, { folderCoverCandidates: candidates });
      return { artist, cover: pathPrefix + '/' + source.id + '/cover?id=' + id };
    });
    return index.portraits;
  }).catch(error => {
    if (source.portraitIndex === index) source.portraitIndex = undefined;
    throw error;
  });
  source.portraitIndex = index;
  return index.request;
}

function invalidateArtistPortraits(source) {
  for (const id of source.portraitIndex?.ids || []) source.media.delete(id);
  source.portraitIndex = undefined;
}

function subsonicEndpoint(source, action, params = {}) {
  const path = source.base.pathname.endsWith('/rest/') ? '' : 'rest/';
  return internal(source, path + action + '.view', params);
}

function subsonicAuth(source, endpoint) {
  const url = new URL(endpoint);
  const salt = randomBytes(16).toString('hex');
  const token = createHash('md5').update(source.password + salt).digest('hex');
  for (const [key, value] of Object.entries({ u: source.username, t: token, s: salt, v: '1.16.1', c: 'Groovebox', f: 'json' })) {
    url.searchParams.set(key, value);
  }
  return url;
}

function subsonicArt(source, id) {
  return id ? subsonicEndpoint(source, 'getCoverArt', { id, size: 640 }) : null;
}

function subsonicAlbumYear(item) {
  return releaseYear(item?.releaseDate?.year) ?? releaseYear(item?.year) ?? releaseYear(item?.originalReleaseDate?.year);
}

function subsonicAlbumRecords(source, albums) {
  return array(albums).filter(item => item?.id != null && typeof item.name === 'string' && item.name).map(item => {
    const year = subsonicAlbumYear(item);
    return { key: 'album:' + item.id, name: item.name, artist: text(item.displayArtist || item.artist, 300), folder: true, browseKind: 'album',
      art: subsonicArt(source, item.coverArt), releaseYear: year,
      location: { action: 'getAlbum', id: item.id, coverArt: item.coverArt, releaseYear: year } };
  });
}

async function reportSubsonicPlayback(fetchImpl, source, record) {
  if (!['subsonic', 'opensubsonic', 'navidrome'].includes(source.type)) {
    throw new SourceError(405, '此来源不支持播放完成回传');
  }
  const id = record?.stream?.searchParams.get('id');
  if (!id || record.key !== 'song:' + id) throw new SourceError(404, '找不到可回传的曲目');
  const endpoint = subsonicEndpoint(source, 'scrobble', { id, submission: true, time: Date.now() });
  const response = await requestData(fetchImpl, source, subsonicAuth(source, endpoint), { signal: AbortSignal.timeout(8000) });
  const result = parseJson(response)['subsonic-response'];
  if (result?.status === 'ok') return;
  if ([40, 41, 50].includes(Number(result?.error?.code))) throw new SourceError(401, '媒体服务器拒绝访问，请检查凭据');
  throw new SourceError(502, '媒体服务器未接受播放记录');
}

async function listSubsonic(fetchImpl, source, folder) {
  const recentAlbums = folder?.action === 'getAlbumList2';
  const parameters = recentAlbums ? { type: 'newest', size: 4 } : { id: folder?.id };
  const response = await requestData(fetchImpl, source, subsonicAuth(source, subsonicEndpoint(source, folder?.action || 'getArtists', parameters)),
    recentAlbums ? { signal: AbortSignal.timeout(8000) } : undefined);
  const api = parseJson(response)['subsonic-response'];
  if (!api) throw new SourceError(502, '服务器地址未返回 Subsonic 数据');
  if (api.status !== 'ok') {
    if ([40, 41, 50].includes(Number(api.error?.code))) throw new SourceError(401, '媒体服务器拒绝访问，请检查凭据');
    throw new SourceError(502, 'Subsonic 服务器返回错误');
  }
  if (recentAlbums) return subsonicAlbumRecords(source, array(api.albumList2?.album).slice(0, 4));
  if (folder?.action === 'getPlaylists') {
    return array(api.playlists?.playlist).filter(item => item?.id != null).map(item => ({
      key: 'playlist:' + item.id,
      name: item.name || '未命名歌单',
      folder: true,
      art: subsonicArt(source, item.coverArt),
      location: { action: 'getPlaylist', id: item.id },
    }));
  }
  if (!folder) {
    return array(api.artists?.index).flatMap((index) => array(index.artist)).filter((item) => item.id != null).map((item) => ({
      key: 'artist:' + item.id,
      name: item.name,
      folder: true,
      browseKind: 'artist',
      art: subsonicArt(source, item.coverArt),
      location: { action: 'getArtist', id: item.id },
    }));
  }
  if (folder.action === 'getArtist') {
    return subsonicAlbumRecords(source, api.artist?.album);
  }
  const playlist = folder.action === 'getPlaylist';
  const entries = playlist ? api.playlist?.entry : api.album?.song;
  const albumYear = subsonicAlbumYear(api.album) ?? folder.releaseYear;
  const albumArtist = api.album?.displayArtist || array(api.album?.artists).map(artist => artist?.name).filter(Boolean).join(', ');
  return array(entries).filter(item => item?.id != null && (!playlist || (!item.isDir && !item.isVideo))).map((item) => ({
    key: 'song:' + item.id,
    name: item.title || item.path || '未知歌曲',
    title: item.title,
    artist: item.displayArtist || item.artist,
    artistNames: array(item.artists).map(artist => artist?.name),
    album: item.album || api.album?.name,
    albumArtist: item.displayAlbumArtist || array(item.albumArtists).map(artist => artist?.name).filter(Boolean).join(', ') || albumArtist || undefined,
    releaseYear: releaseYear(item.year) ?? albumYear,
    genres: [...array(item.genres).map(genre => genre?.name ?? genre), item.genre],
    duration: item.duration,
    size: item.size,
    playlistLocation: ['subsonic', 'opensubsonic', 'navidrome'].includes(source.type) && typeof item.path === 'string' ? item.path : undefined,
    stream: subsonicEndpoint(source, 'stream', { id: item.id, format: 'raw' }),
    art: subsonicArt(source, item.coverArt || api.album?.coverArt || folder.coverArt),
    lyric: ['opensubsonic', 'navidrome', 'fnmusic'].includes(source.type) ? subsonicEndpoint(source, 'getLyricsBySongId', { id: item.id, enhanced: true }) : null,
    type: audioTypes.get(item.suffix) || item.contentType,
  }));
}

function jellyfinId(value) {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)) return;
  const id = value.replaceAll('-', '').toLowerCase();
  if (id !== '0'.repeat(32)) return id;
}

async function jellyfinKeyAuthority(fetchImpl, source, options, nonUserVerified = false) {
  if (!nonUserVerified) {
    const me = await upstream(fetchImpl, source, 'Users/Me', options);
    await me.body?.cancel();
    if (me.status !== 400) return false;
  }
  const elevation = await upstream(fetchImpl, source, 'System/Configuration/MetadataOptions/Default', options);
  await elevation.body?.cancel();
  if (elevation.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(elevation.headers.get('content-type') ?? '')) return false;
  const target = parseJson(await requestData(fetchImpl, source, 'Users/' + encodeURIComponent(source.userId), options));
  return jellyfinId(target?.Id) === jellyfinId(source.userId);
}

async function jellyfinPlaylistAuthority(fetchImpl, source, configuredUserId, userVerified) {
  const userId = jellyfinId(source.userId);
  if (!userId) return;
  const options = { followRedirects: false, signal: AbortSignal.timeout(5000) };
  try {
    let authority = 'user';
    if (!userVerified) {
      const response = await upstream(fetchImpl, source, 'Users/Me', options);
      if (response.status === 200) {
        const user = parseJson(await bodyText(response.body, 8 * 1024 * 1024));
        if (jellyfinId(user?.Id) !== userId) return;
      } else {
        await response.body?.cancel();
        // Jellyfin documents 400 here for a token not owned by a user. Prove elevation separately.
        if (response.status !== 400 || jellyfinId(configuredUserId) !== userId ||
            !await jellyfinKeyAuthority(fetchImpl, source, options, true)) return;
        authority = 'api-key';
      }
    }
    const system = parseJson(await requestData(fetchImpl, source, 'System/Info/Public', options));
    const version = /^(\d+)\.(\d+)\.\d+(?:[.+-][\da-z.-]+)?$/i.exec(system?.Version ?? '');
    if (version && (Number(version[1]) > 10 || (Number(version[1]) === 10 && Number(version[2]) >= 9))) {
      source.jellyfinInstanceId = jellyfinId(system.Id);
      return authority;
    }
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
  }
}

async function mediaBrowserLogin(fetchImpl, source, config) {
  const client = mediaBrowserClient(source);
  let token = config.token;
  let userVerified = false;
  if (config.token) {
    source.userId = config.userId;
  } else {
    if (!config.username) throw new SourceError(400, '请输入账号或访问令牌');
    const response = await requestData(fetchImpl, source, 'Users/AuthenticateByName', {
      method: 'POST',
      headers: { Authorization: client, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: config.username, Pw: config.password }),
    });
    const { AccessToken, User, ServerId } = parseJson(response);
    if (!AccessToken || !User?.Id) throw new SourceError(502, '媒体服务器未返回有效的登录数据');
    token = AccessToken;
    source.userId = User.Id;
    userVerified = true;
    if (source.type === 'emby') source.embyServerId = text(ServerId, 128);
  }
  setMediaBrowserCredential(source, token);
  if (!source.userId) {
    try {
      const current = parseJson(await requestData(fetchImpl, source, 'Users/Me'));
      source.userId = current.Id;
      userVerified = Boolean(current.Id);
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
    }
  }
  if (!source.userId && source.type === 'emby') {
    throw new SourceError(400, '使用 Emby API 令牌时请输入用户 ID');
  }
  if (source.type === 'jellyfin') {
    source.playlistAuthority = await jellyfinPlaylistAuthority(fetchImpl, source, config.token && config.userId, userVerified);
    source.playlistWritable = Boolean(source.playlistAuthority);
  }
}

function mediaBrowserClient(source) {
  return 'MediaBrowser Client="Groovebox", Device="Web", DeviceId="' + source.clientId + '", Version="1.0.0"';
}
function setMediaBrowserCredential(source, token) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token) || /["\\]/.test(token)) {
    throw new SourceError(400, '媒体服务器令牌格式不正确');
  }
  source.sourceToken = token;
  const client = mediaBrowserClient(source);
  if (source.type === 'jellyfin') source.headers.Authorization = client + ', Token="' + token + '"';
  else {
    source.headers['X-Emby-Token'] = token;
    source.playbackAuthorization = client;
    source.playbackSessions = new Map();
  }
}

async function reportEmbyPlayback(fetchImpl, source, mediaId, req) {
  if (source.type !== 'emby') throw new SourceError(405, '此来源不支持播放状态回传');
  const record = source.media.get(mediaId);
  if (!record?.playback) throw new SourceError(404, '找不到可回传的曲目');
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new SourceError(415, '请使用 JSON 提交播放状态');
  }
  let input;
  try {
    input = JSON.parse(await bodyText(req, 2048));
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(400, '无法读取播放状态');
  }
  const { event, playSessionId, positionSeconds, paused, reason } = input || {};
  const ticks = Number.isFinite(positionSeconds) ? Math.round(positionSeconds * 10000000) : NaN;
  if (typeof event !== 'string' || !Object.hasOwn(embyPlaybackRoutes, event)
    || typeof playSessionId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(playSessionId)
    || positionSeconds < 0 || !Number.isSafeInteger(ticks)
    || typeof paused !== 'boolean' || (reason !== undefined && (event !== 'progress' || !embyProgressReasons.has(reason)))) {
    throw new SourceError(400, '播放状态参数无效');
  }
  const sessions = source.playbackSessions;
  const sessionId = playSessionId.toLowerCase();
  const now = Date.now();
  for (const [id, playback] of sessions) {
    if (!playback.pending && now - playback.updated >= playbackSessionLifetime) sessions.delete(id);
  }
  let playback = sessions.get(sessionId);
  if (playback && (playback.mediaId !== mediaId || playback.pending)) throw new SourceError(409, '播放会话正在处理或与曲目不匹配');
  if (event === 'start') {
    if (playback) {
      if (source.persistPlayback && !playback.persisted) {
        source.persistPlayback(sessions);
        playback.persisted = playback.updated;
      }
      return;
    }
    if (sessions.size >= 32) throw new SourceError(429, '已达到播放会话数量上限');
    playback = { mediaId, updated: now, pending: false };
    sessions.set(sessionId, playback);
  } else if (!playback) {
    throw new SourceError(409, '播放会话尚未开始或已经结束');
  }
  if (event === 'stop' && source.persistPlayback) {
    const remaining = new Map(sessions);
    remaining.delete(sessionId);
    source.persistPlayback(remaining);
    playback.acknowledged = false;
  }
  playback.pending = true;
  try {
    const { itemId, mediaSourceId } = record.playback;
    const durationTicks = Math.round(record.duration * 10000000);
    const body = {
      ItemId: itemId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: sessionId,
      PlayMethod: 'DirectPlay',
      PositionTicks: Number.isSafeInteger(durationTicks) && durationTicks > 0 ? Math.min(ticks, durationTicks) : ticks,
      IsPaused: paused,
      CanSeek: true,
      QueueableMediaTypes: ['Audio'],
      ...(event === 'progress' && { EventName: reason || 'TimeUpdate' }),
    };
    await requestData(fetchImpl, source, embyPlaybackRoutes[event], {
      method: 'POST',
      headers: { Authorization: source.playbackAuthorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      followRedirects: false,
    });
  } catch (error) {
    if (event === 'start' || (event === 'stop' && source.persistPlayback)) sessions.delete(sessionId);
    throw error;
  } finally {
    playback.pending = false;
  }
  if (event === 'stop') sessions.delete(sessionId);
  else {
    playback.updated = Date.now();
    playback.acknowledged = true;
    if (source.persistPlayback && playback.updated - (playback.persisted || 0) >= playbackSessionSaveInterval) {
      source.persistPlayback(sessions);
      playback.persisted = playback.updated;
    }
  }
}

const mediaBrowserFields = 'PrimaryImageAspectRatio,MediaSources,ChildCount,Genres';

async function mediaBrowserItems(fetchImpl, source, endpoint, params, options, pageInfo) {
  const result = [];
  const pageSize = 250;
  let total;
  let consistent = true;
  for (let start = 0; start < 10000;) {
    const data = parseJson(await requestData(fetchImpl, source, internal(source, endpoint,
      { ...params, StartIndex: start, Limit: pageSize }), options));
    if (!Array.isArray(data.Items)) throw new SourceError(502, '媒体服务器未返回音乐目录');
    if (pageInfo) {
      total ??= data.TotalRecordCount;
      consistent &&= Number.isSafeInteger(total) && total === data.TotalRecordCount &&
        (data.StartIndex == null || start === data.StartIndex);
    }
    result.push(...data.Items);
    start += data.Items.length;
    if (!data.Items.length || start >= (data.TotalRecordCount ?? start)) break;
  }
  if (pageInfo) pageInfo.complete = consistent && result.length === total;
  return result;
}

async function jellyfinTargetItem(fetchImpl, source, id, type, options) {
  const endpoint = internal(source, 'Items', { Ids: id, UserId: source.userId, IncludeItemTypes: type,
    Recursive: true, EnableImages: false, Limit: 1 });
  const data = parseJson(await requestData(fetchImpl, source, endpoint, options));
  const item = Array.isArray(data?.Items) && data.Items.length === 1 && data.Items[0];
  if (item?.Type === type && jellyfinId(item.Id) === jellyfinId(id)) return item;
}

async function jellyfinPlaylistPermission(fetchImpl, source, id, options = { followRedirects: false, signal: AbortSignal.timeout(5000) }) {
  if (!source.playlistWritable || !jellyfinId(id)) return false;
  try {
    if (source.playlistAuthority === 'api-key') {
      const playlist = await jellyfinTargetItem(fetchImpl, source, id, 'Playlist', options);
      return playlist?.MediaType === 'Audio';
    }
    const endpoint = 'Playlists/' + encodeURIComponent(id) + '/Users/' + encodeURIComponent(source.userId);
    const data = parseJson(await requestData(fetchImpl, source, endpoint, options));
    return data?.CanEdit === true && jellyfinId(data.UserId) === jellyfinId(source.userId);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    return false;
  }
}

function jellyfinPlaylistGroups(source, playlistId, items) {
  const groups = new Map();
  for (const item of items) {
    const raw = item?.PlaylistItemId;
    if (typeof raw !== 'string' || !/^[a-f\d]{32}$/.test(raw) || !jellyfinId(raw)) continue;
    const mediaId = item.Type === 'Audio' && jellyfinId(item.Id);
    let group = groups.get(raw);
    if (!group) {
      group = { raw, mediaId, count: 0 };
      groups.set(raw, group);
    }
    group.count++;
    if (!mediaId || group.mediaId !== mediaId) group.mediaId = undefined;
  }
  for (const [raw, group] of groups) {
    if (!group.mediaId) groups.delete(raw);
    else group.token = stableKey(JSON.stringify(['jellyfin-playlist-entry', source.id, playlistId, raw, group.mediaId, group.count]));
  }
  return groups;
}

function mediaBrowserRecords(items, source, parent, jellyfinGroups) {
  return items.flatMap((item) => {
    if (item.Id == null) return [];
    const id = encodeURIComponent(item.Id);
    if (item.Type !== 'Audio') {
      if (item.CollectionType && !['music', 'playlists', 'mixed'].includes(item.CollectionType)) return [];
      if (!item.IsFolder && !['MusicAlbum', 'MusicArtist', 'Folder', 'Playlist', 'CollectionFolder'].includes(item.Type)) return [];
      const art = item.ImageTags?.Primary ? internal(source, 'Items/' + id + '/Images/Primary', { maxWidth: 640 }) : null;
      const year = item.Type === 'MusicAlbum' ? releaseYear(item.ProductionYear) : undefined;
      const browseKind = item.Type === 'MusicAlbum' ? 'album' : item.Type === 'MusicArtist' ? 'artist' : undefined;
      const location = item.Type === 'Playlist' && item.MediaType === 'Audio'
        ? { action: 'getPlaylist', id: String(item.Id), serverId: text(item.ServerId, 128) }
        : year === undefined ? item.Id : { id: item.Id, releaseYear: year };
      return [{ key: 'folder:' + item.Id, folder: true, name: item.Name, location, art, releaseYear: year, browseKind,
        playlistWritable: source.type === 'jellyfin' && parent?.action === 'getPlaylists' ? item.playlistWritable : undefined }];
    }
    const media = array(item.MediaSources)[0];
    const coverKey = item.ImageTags?.Primary ? id : item.AlbumId && encodeURIComponent(item.AlbumId);
    const group = jellyfinGroups?.get(item.PlaylistItemId);
    const playlistEntry = source.type === 'emby' && parent?.action === 'getPlaylist' && item.PlaylistItemId != null
      ? embyPlaylistEntry(source, parent.id, item.PlaylistItemId) : group?.count === 1 ? group.token : undefined;
    return [{
      key: 'audio:' + item.Id,
      name: item.Name,
      title: item.Name,
      artist: array(item.Artists).join(', ') || item.AlbumArtist,
      artistNames: array(item.Artists).length ? array(item.Artists) : array(item.ArtistItems).map(artist => artist?.Name),
      album: item.Album,
      albumArtist: item.AlbumArtist || array(item.AlbumArtists).map(artist => artist?.Name).filter(Boolean).join(', ') || undefined,
      albumKey: item.AlbumId == null ? undefined : stableKey('album:' + item.AlbumId),
      discNumber: Number.isSafeInteger(item.ParentIndexNumber) && item.ParentIndexNumber > 0 ? item.ParentIndexNumber : undefined,
      trackNumber: Number.isSafeInteger(item.IndexNumber) && item.IndexNumber > 0 ? item.IndexNumber : undefined,
      releaseYear: releaseYear(item.ProductionYear) ?? parent?.releaseYear,
      genres: [...array(item.Genres), ...array(item.GenreItems).map(genre => genre?.Name)],
      duration: Number(item.RunTimeTicks || 0) / 10000000,
      size: Number(media?.Size || 0),
      stream: internal(source, 'Audio/' + id + '/stream', { Static: true, MediaSourceId: media?.Id }),
      playback: source.type === 'emby' ? { itemId: String(item.Id), mediaSourceId: media?.Id } : undefined,
      jellyfinItemId: source.type === 'jellyfin' && jellyfinId(item.Id) ? String(item.Id) : undefined,
      playlistEntry,
      ...(group?.count > 1 && { playlistRemoveEntry: group.token, playlistRemoveCount: group.count }),
      art: coverKey ? internal(source, 'Items/' + coverKey + '/Images/Primary', { maxWidth: 640 }) : null,
      lyric: source.type === 'jellyfin' ? internal(source, 'Audio/' + id + '/Lyrics') :
        { itemId: item.Id, userId: source.userId, mediaSourceId: media?.Id },
      type: audioTypes.get(media?.Container),
    }];
  });
}

async function listMediaBrowser(fetchImpl, source, parent) {
  const endpoint = source.type === 'emby' ? 'Users/' + encodeURIComponent(source.userId) + '/Items' : 'Items';
  if (parent?.action === 'getPlaylists') {
    const items = await mediaBrowserItems(fetchImpl, source, endpoint, {
      UserId: source.userId, IncludeItemTypes: 'Playlist', Recursive: true, SortBy: 'SortName',
    });
    return mediaBrowserRecords(await mediaBrowserAudioPlaylists(fetchImpl, source, items), source, parent);
  }
  if (parent?.action === 'getPlaylist') {
    const endpoint = 'Playlists/' + encodeURIComponent(parent.id) + '/Items';
    const pageInfo = source.type === 'jellyfin' ? {} : undefined;
    const items = await mediaBrowserItems(fetchImpl, source, endpoint, { UserId: source.userId, Fields: mediaBrowserFields }, undefined, pageInfo);
    let groups;
    if (source.type === 'emby') {
      source.playlistEntries.delete(parent.id);
      source.playlistEntries.set(parent.id, new Map());
      if (source.playlistEntries.size > 16) source.playlistEntries.delete(source.playlistEntries.keys().next().value);
    } else if (source.type === 'jellyfin') {
      parent.playlistWritable = await jellyfinPlaylistPermission(fetchImpl, source, parent.id);
      if (parent.playlistWritable && pageInfo.complete) groups = jellyfinPlaylistGroups(source, parent.id, items);
      source.playlistEntries.delete(parent.id);
      if (groups) source.playlistEntries.set(parent.id, new Map([...groups.values()].map(group => [group.token, group])));
      if (source.playlistEntries.size > 16) source.playlistEntries.delete(source.playlistEntries.keys().next().value);
    }
    return mediaBrowserRecords(items.filter(item => item.Type === 'Audio'), source, parent, groups);
  }
  const params = {
    UserId: source.userId,
    ParentId: parent?.id ?? parent,
    IncludeItemTypes: parent ? 'Audio,MusicAlbum,MusicArtist,Folder,Playlist,CollectionFolder' : undefined,
    Recursive: false,
    Fields: mediaBrowserFields,
    SortBy: 'SortName',
  };
  const items = await mediaBrowserItems(fetchImpl, source, endpoint, params);
  if (source.type === 'emby' && !parent && !source.embyServerId) source.embyServerId = text(items[0]?.ServerId, 128);
  const records = mediaBrowserRecords(items, source, parent);
  const tracks = source.type === 'emby' && parent && await embyDiscAlbumTracks(fetchImpl, source, endpoint, params, items);
  return tracks ? [...records.map(record => ({ ...record, albumDiscFolder: true })), ...mediaBrowserRecords(tracks, source, parent)] : records;
}

async function embyDiscAlbumTracks(fetchImpl, source, endpoint, params, items) {
  if (items.length < 2 || !items.every(item => item.Type === 'Folder')) return;
  const discs = new Set(items.map(item => Number(/^(?:cd|disc|disk)[\s._-]*(\d{1,3})$/i.exec(item.Name)?.[1])));
  if (discs.size !== items.length || discs.has(0) || discs.has(NaN)) return;
  let tracks;
  try {
    // Emby may return the physical disc folders instead of the tagged album's tracks.
    tracks = await mediaBrowserItems(fetchImpl, source, endpoint, { ...params, IncludeItemTypes: 'Audio', Recursive: true },
      { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    return;
  }
  const albumId = tracks[0]?.AlbumId;
  if (!albumId || !tracks.every(track => track.Type === 'Audio' && track.AlbumId === albumId && discs.has(track.ParentIndexNumber))) return;
  if (new Set(tracks.map(track => track.ParentIndexNumber)).size === discs.size) return tracks;
}

function embyPlaylistHintKey(source, id, serverId) {
  return source.type === 'emby' && serverId ? JSON.stringify([source.id, serverId, String(id)]) : undefined;
}

function rememberEmbyAudioPlaylist(source, hint) {
  if (!hint) return;
  const hints = source.embyAudioPlaylists;
  hints.delete(hint);
  hints.add(hint);
  if (hints.size > 1024) hints.delete(hints.values().next().value);
}

function forgetMediaBrowserAudioPlaylist(source, itemId, hint) {
  if (hint) source.embyAudioPlaylists.delete(hint);
  const folderId = stableKey('folder:' + itemId);
  if (source.folders.get(folderId)?.action === 'getPlaylist') source.folders.delete(folderId);
}

async function mediaBrowserAudioPlaylists(fetchImpl, source, items) {
  const playlists = items.filter(item => item?.Type === 'Playlist' && item.Id != null);
  async function audioPlaylist(item) {
    const serverId = text(item.ServerId, 128);
    const hint = embyPlaylistHintKey(source, item.Id, serverId);
    if (item.MediaType) {
      if (item.MediaType !== 'Audio') {
        forgetMediaBrowserAudioPlaylist(source, item.Id, hint);
        return;
      }
      rememberEmbyAudioPlaylist(source, hint);
      return item;
    }
    // Some server versions omit MediaType on playlist folders.
    const endpoint = internal(source, 'Playlists/' + encodeURIComponent(item.Id) + '/Items',
      { UserId: source.userId, StartIndex: 0, Limit: 1 });
    try {
      const result = parseJson(await requestData(fetchImpl, source, endpoint, { signal: AbortSignal.timeout(5000) }));
      const media = result?.Items?.[0];
      const previous = source.folders.get(stableKey('folder:' + item.Id));
      const knownAudio = result?.TotalRecordCount === 0 && (
        (previous?.action === 'getPlaylist' && (!previous.serverId || !serverId || previous.serverId === serverId)) ||
        (hint && source.embyAudioPlaylists.has(hint)));
      if (media?.Type === 'Audio' || knownAudio) {
        rememberEmbyAudioPlaylist(source, hint);
        return { ...item, MediaType: 'Audio' };
      }
      if (media?.Type) forgetMediaBrowserAudioPlaylist(source, item.Id, hint);
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
    }
  }
  async function discover(item) {
    const playlist = await audioPlaylist(item);
    if (!playlist || source.type !== 'jellyfin') return playlist;
    if (source.playlistAuthority === 'api-key') return { ...playlist, playlistWritable: item.MediaType === 'Audio' };
    return { ...playlist, playlistWritable: await jellyfinPlaylistPermission(fetchImpl, source, playlist.Id) };
  }
  const audio = [];
  for (let i = 0; i < playlists.length; i += 4) {
    const batch = await Promise.all(playlists.slice(i, i + 4).map(discover));
    audio.push(...batch.filter(Boolean));
  }
  return audio;
}

function embyPlaylistEntry(source, playlistId, rawEntry) {
  const entry = String(rawEntry);
  if (!entry || entry.includes(',')) return undefined;
  const key = stableKey(JSON.stringify(['emby-playlist-entry', playlistId, entry]));
  source.playlistEntries.get(playlistId).set(key, entry);
  return key;
}

async function mutateMediaBrowserPlaylist(fetchImpl, source, path, req, playlistWrites, sourceActive) {
  if (source.type !== 'emby' && !(source.type === 'jellyfin' && source.playlistWritable)) {
    throw new SourceError(405, '此来源不支持编辑服务器歌单');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new SourceError(415, '请使用 JSON 提交歌单操作');
  }
  let input;
  try {
    input = JSON.parse(await bodyText(req, 2048));
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(400, '无法读取歌单操作');
  }
  const options = { followRedirects: false, signal: AbortSignal.timeout(10000) };
  if (!sourceActive()) throw new SourceError(404, '来源已断开，请重新连接');
  if (source.type === 'jellyfin') return mutateJellyfinPlaylist(fetchImpl, source, path, input, options, playlistWrites, sourceActive);
  return mutateEmbyPlaylist(fetchImpl, source, path, input, options);
}

async function mutateEmbyPlaylist(fetchImpl, source, path, input, options) {
  if (input?.action === 'create') {
    if (path !== 'playlists') throw new SourceError(404, '找不到此 Emby 歌单目录');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || /[\x00-\x1f\x7f/\\]/.test(name)) {
      throw new SourceError(400, '请输入有效的 Emby 歌单名称');
    }
    const endpoint = internal(source, 'Playlists', { UserId: source.userId, Name: name, MediaType: 'Audio' });
    const result = parseJson(await requestData(fetchImpl, source, endpoint, { ...options, method: 'POST' }));
    const id = typeof result?.Id === 'string' || Number.isSafeInteger(result?.Id) ? String(result.Id) : '';
    if (!/^[\w-]{1,128}$/.test(id)) throw new SourceError(502, 'Emby 未返回已创建的歌单');
    const [playlist] = emitItems(source, [{
      key: 'folder:' + id, name: text(result.Name, 80).trim() || name, folder: true,
      location: { action: 'getPlaylist', id, serverId: source.embyServerId },
    }]);
    rememberEmbyAudioPlaylist(source, embyPlaylistHintKey(source, id, source.embyServerId));
    return { playlist };
  }
  const playlist = source.folders.get(path);
  if (playlist?.action !== 'getPlaylist') throw new SourceError(404, '找不到此 Emby 歌单');
  const endpoint = 'Playlists/' + encodeURIComponent(playlist.id) + '/Items';
  if (input?.action === 'add') {
    const itemId = source.media.get(input.trackId)?.playback?.itemId;
    if (!itemId || itemId.includes(',')) throw new SourceError(404, '找不到可添加的 Emby 曲目');
    await requestData(fetchImpl, source, internal(source, endpoint, { UserId: source.userId, Ids: itemId }),
      { ...options, method: 'POST' });
  } else if (input?.action === 'remove') {
    const entries = source.playlistEntries.get(playlist.id);
    const entry = entries?.get(input.entryId);
    if (!entry) throw new SourceError(404, '找不到此歌单的条目，请刷新后重试');
    await requestData(fetchImpl, source, internal(source, endpoint, { EntryIds: entry }),
      { ...options, method: 'DELETE' });
    entries.delete(input.entryId);
  } else throw new SourceError(400, '不支持此歌单操作');
  return { updated: true };
}

function jellyfinPlaylistCommitUnknown() {
  return new SourceError(503, '暂时无法确认 Jellyfin 歌单是否已更新，请刷新后检查。', 'playlist_commit_unknown');
}

async function jellyfinPlaylistRequest(fetchImpl, source, endpoint, options, successStatuses) {
  const writing = successStatuses !== undefined;
  let response;
  try { response = await upstream(fetchImpl, source, endpoint, options); }
  catch (error) {
    if (writing && error instanceof SourceError && error.status >= 500) throw jellyfinPlaylistCommitUnknown();
    throw error;
  }
  if (response.ok && (!writing || successStatuses.includes(response.status))) return response;
  await response.body?.cancel().catch(() => {});
  if ([401, 403].includes(response.status)) throw new SourceError(response.status, 'Jellyfin 不允许编辑此歌单');
  if (response.status === 404) throw new SourceError(404, '找不到 Jellyfin 歌单或曲目');
  if (writing && (response.status < 400 || response.status === 408 || response.status >= 500)) throw jellyfinPlaylistCommitUnknown();
  throw new SourceError(502, 'Jellyfin 歌单操作失败（' + response.status + '）');
}

async function mutateJellyfinPlaylist(fetchImpl, source, path, input, options, playlistWrites, sourceActive) {
  function requireActive() {
    if (!sourceActive()) throw new SourceError(404, 'Jellyfin 来源已断开，请重新连接');
  }
  const apiKey = source.playlistAuthority === 'api-key';
  async function recheckAuthority() {
    if (!apiKey) return;
    let valid = false;
    try { valid = await jellyfinKeyAuthority(fetchImpl, source, options); }
    catch (error) { if (!(error instanceof SourceError)) throw error; }
    if (!valid) throw new SourceError(403, 'Jellyfin API 密钥或指定用户已不可用');
    requireActive();
  }
  requireActive();
  if (input?.action === 'create') {
    if (path !== 'playlists') throw new SourceError(404, '找不到此 Jellyfin 歌单目录');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || /[\x00-\x1f\x7f/\\]/.test(name)) throw new SourceError(400, '请输入有效的 Jellyfin 歌单名称');
    await recheckAuthority();
    const response = await jellyfinPlaylistRequest(fetchImpl, source, 'Playlists', {
      ...options, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Name: name, UserId: source.userId, MediaType: 'Audio', IsPublic: false }),
    }, [200, 201]);
    let created;
    try { created = parseJson(await bodyText(response.body, 8 * 1024 * 1024)); }
    catch { throw jellyfinPlaylistCommitUnknown(); }
    const id = created?.Id;
    if (!jellyfinId(id)) throw jellyfinPlaylistCommitUnknown();
    const [playlist] = emitItems(source, [{ key: 'folder:' + id, name: text(created.Name, 80).trim() || name, folder: true,
      location: { action: 'getPlaylist', id }, playlistWritable: true }]);
    return { playlist };
  }

  if (!['add', 'remove'].includes(input?.action)) throw new SourceError(400, '不支持此歌单操作');
  const playlist = source.folders.get(path);
  if (playlist?.action !== 'getPlaylist' || !jellyfinId(playlist.id)) throw new SourceError(404, '找不到此 Jellyfin 歌单');
  const lock = JSON.stringify([source.jellyfinInstanceId || source.base.href, jellyfinId(playlist.id)]);
  if (playlistWrites.has(lock)) throw new SourceError(409, '此 Jellyfin 歌单正在更新，请稍后重试');
  playlistWrites.add(lock);
  try {
    await recheckAuthority();
    if (!await jellyfinPlaylistPermission(fetchImpl, source, playlist.id, options)) throw new SourceError(403, 'Jellyfin 不允许编辑此歌单');
    const endpoint = 'Playlists/' + encodeURIComponent(playlist.id) + '/Items';
    if (input.action === 'add') {
      const id = source.media.get(input.trackId)?.jellyfinItemId;
      if (!id) throw new SourceError(404, '找不到可添加的 Jellyfin 曲目');
      const track = apiKey ? await jellyfinTargetItem(fetchImpl, source, id, 'Audio', options)
        : parseJson(await bodyText((await jellyfinPlaylistRequest(fetchImpl, source,
          internal(source, 'Items/' + encodeURIComponent(id), { UserId: source.userId }), options)).body, 8 * 1024 * 1024));
      if (track?.Type !== 'Audio' || jellyfinId(track.Id) !== jellyfinId(id)) throw new SourceError(404, '找不到可添加的 Jellyfin 曲目');
      requireActive();
      const response = await jellyfinPlaylistRequest(fetchImpl, source, internal(source, endpoint, { ids: id, userId: source.userId }),
        { ...options, method: 'POST' }, [204]);
      await response.body?.cancel();
    } else {
      const entries = source.playlistEntries.get(playlist.id);
      const removed = entries?.get(input.entryId);
      if (!removed) throw new SourceError(404, '找不到此 Jellyfin 歌单条目，请刷新后重试');
      const pageInfo = {};
      const current = await mediaBrowserItems(fetchImpl, source, endpoint, { UserId: source.userId }, options, pageInfo);
      const actual = jellyfinPlaylistGroups(source, playlist.id, current).get(removed.raw);
      if (!pageInfo.complete || actual?.token !== removed.token) throw new SourceError(409, 'Jellyfin 歌单条目已变化，请刷新后重试');
      requireActive();
      const response = await jellyfinPlaylistRequest(fetchImpl, source, internal(source, endpoint, { entryIds: removed.raw }),
        { ...options, method: 'DELETE' }, [204]);
      await response.body?.cancel();
      entries.delete(input.entryId);
    }
    return { updated: true };
  } finally { playlistWrites.delete(lock); }
}

async function listPlex(fetchImpl, source, parent) {
  const items = [];
  const pageSize = 250;
  for (let start = 0; start < 10000;) {
    const data = parseJson(await requestData(fetchImpl, source, parent?.endpoint || parent || 'library/sections', {
      headers: { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': pageSize },
    })).MediaContainer;
    if (!data) throw new SourceError(502, '服务器地址未返回 Plex 音乐目录');
    const records = array(parent ? data.Metadata : data.Directory);
    items.push(...records);
    start += records.length;
    if (!records.length || start >= (data.totalSize ?? start)) break;
  }
  const result = [];
  for (const item of items) {
    if (!parent && item.type !== 'artist') continue;
    const name = item.title || '音乐';
    if (!parent) {
      if (!/^\d+$/.test(String(item.key))) continue;
      result.push({ key: 'section:' + item.key, name, folder: true, location: 'library/sections/' + item.key + '/all?type=8' });
    } else if (['artist', 'album'].includes(item.type)) {
      const target = endpointFromServer(source, item.key, '/library/metadata/');
      if (!target) continue;
      if (!target.pathname.endsWith('/children')) target.pathname += '/children';
      const year = item.type === 'album' ? releaseYear(item.year) ?? releaseYear(item.originallyAvailableAt) : undefined;
      const location = year === undefined ? target : { endpoint: target, releaseYear: year };
      result.push({ key: 'folder:' + item.ratingKey, name, folder: true, location, releaseYear: year, browseKind: item.type });
    } else if (item.type === 'track') {
      const media = array(item.Media)[0];
      const part = array(media?.Part)[0];
      const stream = endpointFromServer(source, part?.key, '/library/parts/');
      if (!stream) continue;
      const art = endpointFromServer(source, item.thumb || item.parentThumb, '/library/metadata/');
      result.push({
        key: 'track:' + item.ratingKey,
        name,
        title: name,
        artist: item.originalTitle || item.grandparentTitle,
        album: item.parentTitle,
        albumArtist: item.grandparentTitle,
        releaseYear: releaseYear(item.year) ?? releaseYear(item.originallyAvailableAt) ?? parent?.releaseYear,
        genres: array(item.Genre).map(genre => genre?.tag),
        duration: Number(item.duration || 0) / 1000,
        size: Number(part.size || 0),
        stream,
        art,
        type: audioTypes.get(media.container),
      });
    }
  }
  return result;
}

async function kodiItems(fetchImpl, source, method, field, params) {
  const items = [];
  const pageSize = 250;
  let start = 0;
  for (;;) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, limits: { start, end: start + pageSize } },
    });
    const data = parseJson(await requestData(fetchImpl, source, 'jsonrpc', {
      method: 'POST', body, headers: { 'Content-Type': 'application/json' },
    }));
    if (data?.error || !Number.isSafeInteger(data?.result?.limits?.total)) {
      throw new SourceError(502, 'Kodi 未返回音乐目录，请确认已启用 HTTP 控制并扫描音乐库');
    }
    const batch = array(data.result[field]);
    items.push(...batch);
    start += batch.length;
    if (start >= data.result.limits.total) return items;
    if (!batch.length || data.result.limits.end !== start) {
      throw new SourceError(502, 'Kodi 返回了无效的音乐目录分页');
    }
  }
}

async function listKodi(fetchImpl, source, folder) {
  if (folder === null) {
    const albums = await kodiItems(fetchImpl, source, 'AudioLibrary.GetAlbums', 'albums', {
      properties: ['year'],
      sort: { method: 'album', order: 'ascending' },
    });
    return [{ key: 'singles', name: '单曲', folder: true, location: 'singles' },
      ...albums.filter(album => Number.isSafeInteger(album.albumid) && album.albumid > 0 && album.label).map(album => {
        const year = releaseYear(album.year);
        return { key: 'album:' + album.albumid, name: album.label, folder: true, browseKind: 'album',
          location: { id: album.albumid, releaseYear: year }, releaseYear: year };
      })];
  }
  const singles = folder === 'singles';
  const songs = await kodiItems(fetchImpl, source, 'AudioLibrary.GetSongs', 'songs', {
    ...(singles ? { singlesonly: true } : { filter: { albumid: folder.id } }),
    properties: ['title', 'artist', 'album', 'albumartist', 'genre', 'duration', 'file', 'thumbnail', 'year'],
    sort: { method: singles ? 'title' : 'track', order: 'ascending' },
  });
  return songs.flatMap(song => {
    const file = song.file;
    const title = song.title || song.label;
    if (!title || !Number.isSafeInteger(song.songid) || typeof file !== 'string' || !file || /[\x00-\x1f]/.test(file)
      || file === '.' || file === '..') return [];
    const extension = /\.([a-z\d]+)$/i.exec(file)?.[1]?.toLowerCase();
    const art = typeof song.thumbnail === 'string' && /^image:\/\//.test(song.thumbnail)
      ? internal(source, 'image/' + encodeURIComponent(song.thumbnail)) : null;
    return [{
      key: 'song:' + song.songid,
      name: title,
      title,
      artist: array(song.artist).join(', '),
      artistNames: array(song.artist),
      album: song.album,
      albumArtist: array(song.albumartist).join(', ') || undefined,
      releaseYear: releaseYear(song.year) ?? folder?.releaseYear,
      genres: song.genre,
      duration: Number(song.duration) || 0,
      stream: internal(source, 'vfs/' + encodeURIComponent(file)),
      art,
      type: audioTypes.get(extension),
    }];
  });
}

async function songloftToken(fetchImpl, source, action, input) {
  const fields = parseJson(await requestData(fetchImpl, source, 'api/v1/auth/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }));
  const token = fields?.data || fields;
  if (!/^[a-z0-9._~+/=-]+$/i.test(token?.access_token || '') || !Number.isFinite(token?.expires_in)) {
    throw new SourceError(502, 'Songloft 未返回有效的登录信息');
  }
  const next = {
    access: token.access_token,
    refresh: token.refresh_token || source.songloft?.refresh,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
  if (source.persistSongloft) {
    source.pendingSongloft = next;
    source.persistSongloft(next);
    source.pendingSongloft = undefined;
  }
  source.songloft = next;
  return next.access;
}

async function songloftAccess(fetchImpl, source, stale) {
  source = source.runtimeSource || source;
  if (source.pendingSongloft) {
    source.persistSongloft(source.pendingSongloft);
    source.songloft = source.pendingSongloft;
    source.pendingSongloft = undefined;
  }
  if (source.songloft.access !== stale && source.songloft.expiresAt > Date.now() + 30000) return source.songloft.access;
  if (!source.songloft.refresh) throw new SourceError(401, 'Songloft 登录已失效，请重新连接');
  source.songloftRefresh ??= songloftToken(fetchImpl, source, 'refresh', {
    refresh_token: source.songloft.refresh,
  }).finally(() => { source.songloftRefresh = undefined; });
  return source.songloftRefresh;
}

async function songloftRequest(fetchImpl, source, endpoint, options = {}, media = false) {
  const request = token => {
    const target = new URL(endpoint, source.base);
    if (media) target.searchParams.set('access_token', token);
    return upstream(fetchImpl, source, target, {
      ...options, headers: { ...options.headers, Authorization: 'Bearer ' + token },
    });
  };
  const token = await songloftAccess(fetchImpl, source);
  const response = await request(token);
  if (response.status !== 401) return response;
  await response.body?.cancel();
  return request(await songloftAccess(fetchImpl, source, token));
}

async function listSongloft(fetchImpl, source) {
  const records = new Map();
  const limit = 200;
  let offset = 0;
  while (true) {
    // Songloft compares type to one value. Browse all pages and skip radio entries.
    const endpoint = internal(source, 'api/v1/songs', { sort: 'id', order: 'asc', limit, offset });
    const response = await songloftRequest(fetchImpl, source, endpoint);
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceError(response.status === 401 ? 401 : 502, '无法读取 Songloft 歌曲列表');
    }
    const json = (await bodyText(response.body, 8 * 1024 * 1024)).replace(/("id"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"');
    const data = parseJson(json);
    if (!Array.isArray(data?.songs)) throw new SourceError(502, 'Songloft 未返回歌曲列表');
    let newItems = 0;
    for (const song of data.songs) {
      const id = String(song?.id);
      if (!/^[1-9]\d*$/.test(id) || records.has(id)) continue;
      newItems++;
      if (song.type === 'radio') {
        records.set(id, null);
        continue;
      }
      const title = song.title || '未命名歌曲';
      records.set(id, {
        key: 'songloft:' + id,
        name: title,
        title,
        artist: song.artist,
        album: song.album,
        genres: song.genre,
        duration: Number(song.duration) > 0 ? Number(song.duration) : undefined,
        size: Number(song.file_size) || 0,
        stream: internal(source, 'api/v1/songs/' + id + '/play', { normalize: 0 }),
        art: song.cover_url ? internal(source, 'api/v1/songs/' + id + '/cover') : null,
        lyric: internal(source, 'api/v1/songs/' + id + '/lyric'),
        type: audioTypes.get(String(song.format).toLowerCase().replace(/^\./, '')),
      });
    }
    offset += data.songs.length;
    if (!data.songs.length || offset >= (Number(data.total) || Infinity)) return [...records.values()].filter(Boolean);
    if (!newItems) throw new SourceError(502, 'Songloft 歌曲列表分页重复');
    if (!Number.isFinite(Number(data.total)) && data.songs.length < limit) return [...records.values()].filter(Boolean);
  }
}

async function proxySongloftLyrics(fetchImpl, source, endpoint, req, res) {
  const response = await songloftRequest(fetchImpl, source, endpoint, { signal: AbortSignal.timeout(15000) }, true);
  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceError(response.status === 404 ? 404 : 502, '找不到 Songloft 歌词');
  }
  const data = parseJson(await bodyText(response.body, maxLyricBytes));
  const lyrics = data?.data || data;
  const value = [lyrics?.lxlyric, lyrics?.lyric].find(text => typeof text === 'string' && /^\s*\[\d+:/m.test(text));
  if (!value) throw new SourceError(404, '找不到 Songloft 同步歌词');
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(value),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  }).end(req.method === 'HEAD' ? undefined : value);
}

async function readList(fetchImpl, source, folder) {
  switch (source.type) {
    case 'webdav': return listDav(fetchImpl, source, folder);
    case 'jellyfin':
    case 'emby': return listMediaBrowser(fetchImpl, source, folder);
    case 'plex': return listPlex(fetchImpl, source, folder);
    case 'kodi': return listKodi(fetchImpl, source, folder);
    case 'smb': return source.smb.list(folder);
    case 'songloft': return listSongloft(fetchImpl, source);
    default: return listSubsonic(fetchImpl, source, folder);
  }
}

function prepareSource(input, clientId = randomUUID()) {
  const config = {
    username: text(input?.username, 512),
    password: text(input?.password),
    token: text(input?.token),
    userId: text(input?.userId, 512),
  };
  const type = input?.type;
  if (!sourceTypes.has(type)) throw new SourceError(400, '请选择受支持的媒体来源');
  if (/[\0-\x1f\x7f]/.test(config.token)) throw new SourceError(400, '媒体服务器令牌格式不正确');
  const address = typeof input?.url === 'string' ? input.url.trim() : '';
  if (address.length > maxSourceAddress) throw new SourceError(400, '服务器地址过长');
  const url = type === 'fnmusic' ? prepareFnMusicSource({ url: address, ...config }).url : address;
  const smb = type === 'smb' ? createSmbSource({ ...config, url }) : null;
  const base = smb?.base || parseBase(url, type);
  if (base.href.length > maxSourceAddress) throw new SourceError(400, '服务器地址过长');
  const source = {
    id: clientId,
    clientId,
    type,
    name: text(input?.name, 100).trim() || base.hostname,
    base,
    smb,
    headers: { Accept: 'application/json' },
    folders: new Map(),
    media: new Map(),
  };
  source.identityName = type === 'plex' ? '' : config.username;
  if (!['jellyfin', 'emby', 'plex', 'songloft'].includes(type)) {
    source.credentials = { username: config.username, password: config.password };
  }
  if (type === 'webdav' || type === 'kodi') {
    if (type === 'webdav') source.headers.Accept = '*/*';
    if (config.username || config.password) {
      source.headers.Authorization = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');
    }
  } else if (type === 'plex') {
    if (!config.token) throw new SourceError(400, '请输入 Plex 访问令牌');
    source.sourceToken = config.token;
    source.headers['X-Plex-Token'] = config.token;
    source.headers['X-Plex-Client-Identifier'] = clientId;
    source.headers['X-Plex-Product'] = 'Groovebox';
  } else if (!smb && !['jellyfin', 'emby', 'songloft'].includes(type)) {
    if (!config.username || !config.password) throw new SourceError(400, '请输入账号密码');
    source.username = config.username;
    source.password = config.password;
  }
  return { source, config };
}

async function newSource(fetchImpl, input, plexClientId) {
  const { source, config } = prepareSource(input, plexClientId);
  if (source.type === 'jellyfin' || source.type === 'emby') {
    await mediaBrowserLogin(fetchImpl, source, config);
    source.playlistEntries = new Map();
  } else if (source.type === 'songloft') {
    if (!config.username || !config.password) throw new SourceError(400, '请输入 Songloft 用户名和密码');
    await songloftToken(fetchImpl, source, 'login', { username: config.username, password: config.password });
  }
  source.id = stableSourceId(source, source.identityName);
  emitItems(source, await readList(fetchImpl, source, null));
  return source;
}

function invalidSourceSession() { throw new SourceSessionStoreError('invalid'); }
function sessionText(value, max, allowEmpty = false, secret = false) {
  if (typeof value !== 'string' || value.length > max || (!value && !allowEmpty) || (!secret && /[\x00-\x1f\x7f]/.test(value))) invalidSourceSession();
  return value;
}
const sourceClientId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

function embyHintOwner(value) {
  if (typeof value !== 'string' || value.length > 8192) return;
  try {
    const [id, server, playlist, ...extra] = JSON.parse(value);
    if (!extra.length && sourceClientId.test(id) && typeof server === 'string' && server.length <= 128 && server &&
        typeof playlist === 'string' && playlist.length <= 4096 && playlist && !/[\x00-\x1f\x7f]/.test(server + playlist)) return id;
  } catch { /* Unrecognized hints are never restored. */ }
}

function snapshotSource(source, embyHints) {
  const portraitEntries = source.portraitIndex?.portraits?.map(({ artist, cover }) => [artist, cover.slice(cover.indexOf('=') + 1)]);
  const index = readSourceIndex(source, { folders: source.folders, media: source.media, portraitEntries }, safeEndpoint);
  return {
    id: source.id, type: source.type, name: source.name, url: source.base.href, clientId: source.clientId,
    identityName: source.identityName, credentials: source.credentials, token: source.sourceToken, userId: source.userId,
    embyServerId: source.embyServerId, jellyfinInstanceId: source.jellyfinInstanceId,
    playlistAuthority: source.playlistAuthority, songloft: source.songloft,
    ...(source.type === 'emby' && {
      embyHints: [...embyHints].filter(hint => embyHintOwner(hint) === source.id),
      playback: [...source.playbackSessions].filter(([, value]) => value.acknowledged &&
        value.updated + playbackSessionLifetime > Date.now() && source.media.get(value.mediaId)?.playback)
        .map(([id, { mediaId, updated }]) => [id, mediaId, updated]),
    }),
    index: { folders: [...index.folders], media: [...index.media], portraitEntries: index.portraitEntries },
  };
}

function hydrateSource(record) {
  if (!record || !sourceTypes.has(record.type) || typeof record.clientId !== 'string' || !sourceClientId.test(record.clientId)) invalidSourceSession();
  const { type, clientId, credentials, songloft, userId, playlistAuthority, jellyfinInstanceId, embyServerId, token } = record;
  const username = sessionText(record.identityName, 512, true, true);
  const name = sessionText(record.name, 100, false, true);
  const url = sessionText(record.url, 8192);
  const rawCredentials = !['jellyfin', 'emby', 'plex', 'songloft'].includes(type);
  if (rawCredentials && (!credentials || credentials.username !== username)) invalidSourceSession();
  const { source } = prepareSource({ type, name, url, username,
    password: rawCredentials ? sessionText(credentials.password, 4096, true, true) : '',
    token: type === 'plex' ? sessionText(token, 4096) : '',
  }, clientId);
  if (source.base.href !== url || source.identityName !== username) invalidSourceSession();
  if (type === 'emby' || type === 'jellyfin') {
    source.userId = userId && (Number.isSafeInteger(userId) ? userId : sessionText(userId, 4096));
    if (type === 'emby' && !source.userId) invalidSourceSession();
    setMediaBrowserCredential(source, sessionText(token, 8192));
    source.playlistEntries = new Map();
    if (type === 'emby' && embyServerId !== undefined) source.embyServerId = sessionText(embyServerId, 128, true);
    if (type === 'jellyfin' && playlistAuthority !== undefined) {
      if (!['user', 'api-key'].includes(playlistAuthority) || !source.userId) invalidSourceSession();
      source.playlistAuthority = playlistAuthority;
      source.playlistWritable = true;
    }
    if (type === 'jellyfin' && jellyfinInstanceId !== undefined) {
      if (!jellyfinId(jellyfinInstanceId)) invalidSourceSession();
      source.jellyfinInstanceId = jellyfinInstanceId;
    }
  }
  if (type === 'songloft') {
    if (!Number.isSafeInteger(songloft?.expiresAt)) invalidSourceSession();
    const access = sessionText(songloft.access, 8192);
    if (!/^[a-z0-9._~+/=-]+$/i.test(access)) invalidSourceSession();
    source.songloft = { access, refresh: songloft.refresh == null ? undefined : sessionText(songloft.refresh, 8192), expiresAt: songloft.expiresAt };
  }
  source.id = stableSourceId(source, source.identityName);
  if (source.id !== record.id) invalidSourceSession();
  const index = readSourceIndex(source, record.index, safeEndpoint);
  source.folders = index.folders;
  source.media = index.media;
  if (type === 'emby') {
    const hints = record.embyHints ?? [];
    if (!Array.isArray(hints) || hints.length > 1024 || !hints.every(hint => embyHintOwner(hint) === source.id)) invalidSourceSession();
    source.embyAudioPlaylists = new Set(hints);
    const playback = record.playback ?? [];
    if (!Array.isArray(playback) || playback.length > 32) invalidSourceSession();
    for (const entry of playback) {
      if (!Array.isArray(entry) || entry.length !== 3) invalidSourceSession();
      const [id, mediaId, updated] = entry;
      if (typeof id !== 'string' || !sourceClientId.test(id) || source.playbackSessions.has(id) ||
          !source.media.get(mediaId)?.playback || !Number.isSafeInteger(updated) || updated <= 0) invalidSourceSession();
      if (updated + playbackSessionLifetime > Date.now()) {
        source.playbackSessions.set(id, { mediaId, updated, persisted: updated, acknowledged: true, pending: false });
      }
    }
  }
  if (index.portraitEntries.length) {
    const portraits = index.portraitEntries.map(([artist, id]) => ({ artist, cover: pathPrefix + '/' + source.id + '/cover?id=' + id }));
    source.portraitIndex = { ids: new Set(index.portraitEntries.map(entry => entry[1])), portraits, request: Promise.resolve(portraits) };
  }
  return source;
}

function parseBackup(body, status) {
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new SourceError(status, '备份文件无法读取');
  }
  if (payload?.version !== 1 || !Array.isArray(payload.playlists)) {
    throw new SourceError(status, '无法识别此 Groovebox 备份');
  }
  return payload;
}

async function syncBackup(fetchImpl, source, req, res) {
  if (source.type !== 'webdav') throw new SourceError(400, '此操作需要 WebDAV 来源');
  let body;
  const headers = { Accept: 'application/json' };
  if (req.method === 'PUT') {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      throw new SourceError(415, '请提交 JSON 备份');
    }
    if (Number(req.headers['content-length']) > maxBackupBytes) {
      throw new SourceError(413, '备份文件过大');
    }
    const incoming = await readBody(req.iterator({ destroyOnReturn: false }), maxBackupBytes);
    body = JSON.stringify(parseBackup(incoming, 400));
    headers['Content-Type'] = 'application/json; charset=utf-8';
    const match = req.headers['if-match'];
    const absent = req.headers['if-none-match'];
    if ((match && (absent || !/^"[!#-~]{0,255}"$/.test(match))) || (absent && absent !== '*')) {
      throw new SourceError(400, '无效的云端歌单版本');
    }
    if (match) headers['If-Match'] = match;
    if (absent) headers['If-None-Match'] = absent;
  }

  const response = await upstream(fetchImpl, source, backupFile, {
    method: req.method,
    body,
    headers,
    followRedirects: false,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (req.method === 'GET' && response.status === 404) throw new SourceError(404, 'WebDAV 中暂无 Groovebox 备份');
    if (response.status === 412) throw new SourceError(412, '云端歌单已更新，请重新读取');
    if ([401, 403].includes(response.status)) throw new SourceError(403, 'WebDAV 未授予备份所需的访问权限');
    throw new SourceError(502, 'WebDAV 备份请求失败（' + response.status + '）');
  }
  if (req.method === 'PUT') {
    await response.body?.cancel();
    return sendJson(res, 200, { saved: true });
  }
  if (Number(response.headers.get('content-length')) > maxBackupBytes) {
    await response.body?.cancel();
    throw new SourceError(413, '备份文件过大');
  }
  const payload = parseBackup(await readBody(response.body, maxBackupBytes), 502);
  const etag = response.headers.get('etag');
  if (etag && /^"[!#-~]{0,255}"$/.test(etag)) res.setHeader('ETag', etag);
  sendJson(res, 200, payload);
}

async function proxyLyric(fetchImpl, source, record, req, res) {
  if (record.size > maxLyricBytes) throw new SourceError(413, '歌词文件过大');
  const upstreamRes = await upstream(fetchImpl, source, record.stream, {
    method: req.method,
    headers: { Accept: 'text/plain, text/vtt, */*;q=0.1' },
    signal: AbortSignal.timeout(15000),
  });
  const length = upstreamRes.headers.get('content-length');
  const contentType = upstreamRes.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
  if (upstreamRes.status !== 200 || !lyricTypes.has(contentType) || Number(length) > maxLyricBytes) {
    await upstreamRes.body?.cancel();
    if (upstreamRes.status === 404) throw new SourceError(404, '找不到歌词文件');
    if (Number(length) > maxLyricBytes) throw new SourceError(413, '歌词文件过大');
    throw new SourceError(502, '媒体服务器未返回有效歌词');
  }
  const isHead = req.method === 'HEAD';
  const body = isHead ? undefined : await readBody(upstreamRes.body, maxLyricBytes);
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  if (!isHead) headers['Content-Length'] = body.length;
  else if (length != null && !upstreamRes.headers.has('content-encoding')) headers['Content-Length'] = length;
  res.writeHead(200, headers).end(body);
}

function timedTranslations(lines) {
  const result = new Map();
  for (const [time, text] of lines) {
    if (!Number.isFinite(time) || typeof text !== 'string') continue;
    const translations = result.get(time) || new Set();
    for (const line of text.split(/\r\n?|\n/)) {
      const value = line.trim();
      if (value) translations.add(value);
    }
    if (translations.size) result.set(time, translations);
  }
  return new Map(Array.from(result, ([time, translations]) => [time, [...translations].join('\n')]));
}

function jellyfinLyrics(payload) {
  const tracks = array(payload?.Tracks ?? payload?.tracks);
  const lineData = track => array(track?.Lyrics ?? track?.lyrics ?? track?.Lines ?? track?.lines);
  const main = tracks.find(track => (track?.Type ?? track?.type) === 'Main') || tracks[0] || payload;
  const translations = timedTranslations(tracks.filter(track => track !== main && (track?.Type ?? track?.type) === 'Translation')
    .flatMap(track => lineData(track).map(line => [line?.Start ?? line?.start, line?.Text ?? line?.text])));
  return lineData(main).flatMap(line => {
    const text = line?.Text ?? line?.text;
    if (typeof text !== 'string' || !text.trim()) return [];
    const ticks = line.Start ?? line.start;
    const time = Number.isFinite(ticks) ? Math.max(0, ticks / 10000000) : null;
    const words = array(line.Syllables ?? line.syllables ?? line.Cues ?? line.cues).flatMap(cue => {
      const start = cue.Start ?? cue.start;
      const value = cue.Text ?? cue.text;
      return Number.isFinite(start) && typeof value === 'string' ? [{ time: Math.max(0, start / 10000000), text: value }] : [];
    });
    const translation = translations.get(ticks);
    return [{ time, text, ...(typeof translation === 'string' && { translation }),
      ...(words.length && words.map(word => word.text).join('') === text && { words }) }];
  });
}

function subsonicLyricLines(main, translations = new Map()) {
  const enhanced = new Map(array(main?.cueLine).filter(line => Number.isSafeInteger(line?.index) && line.index >= 0)
    .map(line => [line.index, line]));
  const lines = array(main?.line);
  const source = lines.length ? lines : [...enhanced.values()];
  // OpenSubsonic defines a positive offset as moving a lyric earlier.
  const offset = Number.isFinite(main?.offset) ? main.offset : 0;
  return source.flatMap((line, index) => {
    if (typeof line?.value !== 'string' || !line.value.trim()) return [];
    const milliseconds = Number.isFinite(line.start) ? line.start - offset : undefined;
    const time = main.synced && Number.isFinite(milliseconds) ? Math.max(0, milliseconds / 1000) : null;
    const words = array(enhanced.get(lines.length ? index : line.index)?.cue).flatMap(cue => Number.isFinite(cue?.start) && typeof cue.value === 'string'
      ? [{ time: Math.max(0, (cue.start - offset) / 1000), text: cue.value }] : []);
    const translated = translations.get(milliseconds);
    return [{ time, text: line.value, ...(typeof translated === 'string' && { translation: translated }),
      ...(words.length && words.map(word => word.text).join('') === line.value && { words }) }];
  });
}

function subsonicLyrics(payload) {
  const tracks = array(payload?.['subsonic-response']?.lyricsList?.structuredLyrics);
  const candidates = [...tracks.filter(track => track?.kind === 'main'), ...tracks.filter(track => track && !track.kind)];
  const versions = new Map();
  let primary;
  for (const candidate of candidates) {
    const lines = subsonicLyricLines(candidate);
    if (!lines.length) continue;
    const language = text(candidate.lang, 40);
    const title = text(candidate.displayTitle, 150);
    const id = createHash('sha256').update(JSON.stringify([language, title, lines])).digest('hex').slice(0, 24);
    if (versions.has(id)) continue;
    primary ??= candidate;
    versions.set(id, { id, language, title, timed: lines.some(line => Number.isFinite(line.time)), lines });
  }
  if (versions.size > 1) {
    // The response has no key linking translations to a particular main version.
    const [{ lines, ...defaultVersion }, ...variants] = versions.values();
    return { lines, defaultVersion, variants };
  }
  // Retain the legacy single-track fallback for servers that omit a main track.
  primary ??= candidates[0] || tracks[0];
  const translations = timedTranslations(tracks.filter(track => track !== primary && track?.kind === 'translation').flatMap(track => {
    const offset = Number.isFinite(track.offset) ? track.offset : 0;
    return array(track.line).map(line => [Number.isFinite(line?.start) ? line.start - offset : undefined, line?.value]);
  }));
  return { lines: subsonicLyricLines(primary, translations) };
}

async function proxyStructuredLyrics(fetchImpl, source, endpoint, req, res) {
  const signal = AbortSignal.timeout(15000);
  let lyrics;
  if (source.type === 'emby') {
    const result = await readEmbyLyrics(path => upstream(fetchImpl, source, path, { signal }), endpoint);
    if (result.status !== 200) {
      const status = [401, 403, 404, 413].includes(result.status) ? result.status : 502;
      throw new SourceError(status, '找不到 Emby 服务器歌词');
    }
    lyrics = { lines: result.lines };
  } else {
    const isJellyfin = source.type === 'jellyfin';
    const response = await upstream(fetchImpl, source, isJellyfin ? endpoint : subsonicAuth(source, endpoint), { signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceError(response.status === 404 ? 404 : 502, '找不到服务器歌词');
    }
    const payload = parseJson(await bodyText(response.body, maxLyricBytes));
    lyrics = isJellyfin ? { lines: jellyfinLyrics(payload) } : subsonicLyrics(payload);
  }
  if (!lyrics.lines.length) throw new SourceError(404, '找不到服务器歌词');
  if (req.method === 'HEAD') return res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end();
  sendJson(res, 200, lyrics);
}

async function proxyDavFolderCover(fetchImpl, source, candidates, req, res, abortSignal) {
  const signal = AbortSignal.any([abortSignal, AbortSignal.timeout(15000)]);
  for (const { location, type } of candidates) {
    const response = await upstream(fetchImpl, source, location, { headers: { Accept: type }, signal }).catch(error => {
      if (signal.aborted || !(error instanceof SourceError)) throw error;
      return undefined;
    });
    if (!response) continue;
    const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (response.status !== 200 || Number(response.headers.get('content-length')) > maxDavCoverBytes ||
      (mime && mime !== type && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream')) {
      await response.body?.cancel();
      continue;
    }
    const bytes = await readBody(response.body, maxDavCoverBytes).catch(error => {
      if (!(error instanceof SourceError) || error.status !== 413) throw error;
      return undefined;
    });
    if (!bytes || !imageSignature(bytes, type)) continue;
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': bytes.length,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    return res.end(req.method === 'HEAD' ? undefined : bytes);
  }
  throw new SourceError(404, '找不到有效的目录封面');
}

async function proxyMedia(fetchImpl, source, record, cover, req, res, bitrate) {
  if (source.smb) {
    return cover ? source.smb.proxyCover(record.folderCoverCandidates, req, res) : source.smb.proxy(record, req, res);
  }
  if (record.serverLyrics && !cover) return source.songloft ?
    proxySongloftLyrics(fetchImpl, source, record.serverLyrics, req, res) :
    proxyStructuredLyrics(fetchImpl, source, record.serverLyrics, req, res);
  if (record.sidecar && !cover) return proxyLyric(fetchImpl, source, record, req, res);
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  try {
    if (cover && record.folderCoverCandidates) {
      return await proxyDavFolderCover(fetchImpl, source, record.folderCoverCandidates, req, res, controller.signal);
    }
    let endpoint = cover ? record.art : record.stream;
    if (!endpoint) throw new SourceError(404, '找不到该媒体');
    if (['subsonic', 'opensubsonic', 'navidrome', 'fnmusic'].includes(source.type)) endpoint = subsonicAuth(source, endpoint);
    if (bitrate) {
      endpoint.searchParams.set('maxBitRate', bitrate);
      endpoint.searchParams.set('format', 'mp3');
    }
    const headers = { Accept: cover ? 'image/*' : '*/*' };
    if (!cover && req.headers.range) {
      if (!/^bytes=(?:\d+-\d*|\d*-\d+)$/.test(req.headers.range)) {
        throw new SourceError(416, '音频范围格式不正确');
      }
      headers.Range = req.headers.range;
      if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
    }
    const checkKodiCover = cover && source.type === 'kodi';
    const signal = checkKodiCover ? AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) : controller.signal;
    const options = { method: req.method, headers, signal };
    const upstreamRes = source.songloft ? await songloftRequest(fetchImpl, source, endpoint, options, true) :
      await upstream(fetchImpl, source, endpoint, options);
    if (![200, 206, 416].includes(upstreamRes.status) || (upstreamRes.status === 416 && cover)) {
      await upstreamRes.body?.cancel();
      throw new SourceError(upstreamRes.status === 404 ? 404 : 502, '媒体服务器未返回文件');
    }
    const contentType = upstreamRes.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    const fallbackType = /^audio\/[a-z\d.+-]+$/i.test(record.type || '') ? record.type : 'application/octet-stream';
    let mime = cover ? contentType : contentType?.startsWith('audio/') ? contentType : fallbackType;
    let inspectedCover;
    // Kodi can serve raster textures from /image without a Content-Type header.
    if (checkKodiCover && upstreamRes.status === 200 && !upstreamRes.headers.has('content-type')) {
      const imageResponse = req.method === 'HEAD' ? await upstream(fetchImpl, source, endpoint, { ...options, method: 'GET' }) : upstreamRes;
      if (imageResponse.status !== 200 || imageResponse.headers.has('content-type')
        || Number(imageResponse.headers.get('content-length')) > maxUntypedKodiCoverBytes) {
        await imageResponse.body?.cancel();
        throw new SourceError(502, '媒体服务器返回了不受支持的文件类型');
      }
      inspectedCover = await readBody(imageResponse.body, maxUntypedKodiCoverBytes);
      mime = [...safeImages].find(type => imageSignature(inspectedCover, type));
    }
    if ((cover && !safeImages.has(mime)) || (!cover && upstreamRes.status !== 416 && contentType
      && !contentType.startsWith('audio/') && !['video/mp4', 'video/webm', 'application/octet-stream', 'binary/octet-stream', 'application/ogg'].includes(contentType))) {
      if (!inspectedCover) await upstreamRes.body?.cancel();
      throw new SourceError(502, '媒体服务器返回了不受支持的文件类型');
    }
    const output = {
      'Content-Type': mime,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    for (const header of ['accept-ranges', 'content-range', 'content-length', 'etag', 'last-modified']) {
      const value = upstreamRes.headers.get(header);
      if (value && (header !== 'content-length' || !upstreamRes.headers.get('content-encoding'))) output[header] = value;
    }
    if (inspectedCover) output['content-length'] = inspectedCover.length;
    res.writeHead(upstreamRes.status, output);
    if (req.method === 'HEAD' || !upstreamRes.body) return res.end();
    if (inspectedCover) return res.end(inspectedCover);
    await pipeline(Readable.fromWeb(upstreamRes.body), res);
  } finally {
    res.off('close', abort);
  }
}

export function createSourcesHandler({ fetchImpl = globalThis.fetch, sessionDirectory, sessionKey, sessionStore, now = Date.now } = {}) {
  const sessions = new Map();
  const playlistWrites = new Set();
  const indexWrites = new WeakMap();
  const plexAuthorization = createPlexAuthorization({ fetchImpl, bodyText, parseBase });
  let store = sessionStore;

  function storageError() {
    return new SourceError(503, '暂时无法保存或读取媒体来源，请稍后重试。', 'sources_storage_unavailable');
  }
  function staleSource() { return new SourceError(404, '来源已断开，请重新连接'); }
  function sessionCookie(req, sid, seconds) {
    return cookieName + '=' + sid + '; Path=/api/sources; Max-Age=' + seconds +
      '; HttpOnly; SameSite=Strict' + (req.socket.encrypted ? '; Secure' : '');
  }

  function openStore() {
    if (!sessionDirectory || store) return;
    try { store = createSourceSessionStore(sessionDirectory, typeof sessionKey === 'function' ? sessionKey() : sessionKey); }
    catch { throw storageError(); }
  }

  function storeSession(sid, session, sources = session.sources, embyHints = session.embyAudioPlaylists) {
    if (!store) return;
    try {
      if (!sources.size) store.remove(sid);
      else store.write(sid, { expires: session.expires, sources: [...sources.values()].map(source => snapshotSource(source, embyHints)) }, now());
    } catch { throw storageError(); }
  }

  function bindSource(sid, session, source) {
    if (source.type === 'emby') {
      for (const hint of source.embyAudioPlaylists || []) rememberEmbyAudioPlaylist({ embyAudioPlaylists: session.embyAudioPlaylists }, hint);
      source.embyAudioPlaylists = session.embyAudioPlaylists;
      if (store) source.persistPlayback = playbackSessions => {
        if (!sourceActive(sid, session, source)) throw staleSource();
        storeSession(sid, session, new Map(session.sources).set(source.id, { ...source, playbackSessions }));
      };
    }
    if (store && source.type === 'songloft') source.persistSongloft = songloft => {
      if (!sourceActive(sid, session, source)) throw staleSource();
      const sources = new Map(session.sources).set(source.id, { ...source, songloft });
      storeSession(sid, session, sources);
    };
  }

  function loadSession(sid, time) {
    openStore();
    if (!sid) return;
    let session = sessions.get(sid);
    if (!session && store) {
      let snapshot;
      try { snapshot = store.read(sid, time); }
      catch (error) {
        if (error instanceof SourceSessionStoreError && error.code === 'invalid') {
          throw new SourceError(401, '无法恢复媒体来源会话，请重新连接。', 'source_session_unreadable');
        }
        throw storageError();
      }
      if (snapshot?.expires > time) {
        try {
          if (!Array.isArray(snapshot.sources) || !snapshot.sources.length || snapshot.sources.length > 30) invalidSourceSession();
          session = { expires: snapshot.expires, sources: new Map(), embyAudioPlaylists: new Set(), revision: 0 };
          for (const record of snapshot.sources) {
            const source = hydrateSource(record);
            if (session.sources.has(source.id)) invalidSourceSession();
            bindSource(sid, session, source);
            session.sources.set(source.id, source);
          }
        } catch {
          throw new SourceError(401, '无法恢复媒体来源会话，请重新连接。', 'source_session_unreadable');
        }
        sessions.set(sid, session);
      }
    }
    if (session?.expires <= time) {
      sessions.delete(sid);
      return;
    }
    return session;
  }

  function sourceActive(sid, session, source) {
    return sessions.get(sid) === session && session.expires > now() && session.sources.get(source.id) === source;
  }

  function replaceSourceHints(session, sourceId, from) {
    const next = new Set([...session.embyAudioPlaylists].filter(hint => embyHintOwner(hint) !== sourceId));
    for (const hint of from) {
      if (embyHintOwner(hint) === sourceId) rememberEmbyAudioPlaylist({ embyAudioPlaylists: next }, hint);
    }
    return next;
  }

  function applyHints(session, hints) {
    session.embyAudioPlaylists.clear();
    for (const hint of hints) session.embyAudioPlaylists.add(hint);
  }

  async function publishIndex(sid, session, source, read, committedPlaylist = false) {
    if (!store) return read(source);
    const execute = async () => {
      if (!sourceActive(sid, session, source)) throw staleSource();
      const staged = { ...source, runtimeSource: source, media: new Map(source.media),
        folders: new Map([...source.folders].map(([id, folder]) => [id,
          Object.getPrototypeOf(folder) === Object.prototype ? { ...folder } : folder])),
        embyAudioPlaylists: source.embyAudioPlaylists && new Set(source.embyAudioPlaylists),
        playlistEntries: source.playlistEntries && new Map([...source.playlistEntries].map(([id, entries]) => [id, new Map(entries)])) };
      const result = await read(staged);
      const hints = staged.embyAudioPlaylists && replaceSourceHints(session, source.id, staged.embyAudioPlaylists);
      try {
        if (!sourceActive(sid, session, source)) throw staleSource();
        // Songloft may have renewed the live token during listing. Publish the updated
        // indexes together with the current credentials, never the staged old token.
        staged.songloft = source.songloft;
        if (!committedPlaylist || result.playlist) storeSession(sid, session, new Map(session.sources).set(source.id, staged), hints);
      } catch (error) {
        if (committedPlaylist) throw new SourceError(503, '歌单可能已更新，请刷新列表确认。', 'playlist_commit_unknown');
        throw error;
      }
      for (const field of ['folders', 'media', 'playlistEntries', 'portraitIndex', 'embyServerId']) source[field] = staged[field];
      if (hints) applyHints(session, hints);
      return result;
    };
    const previous = indexWrites.get(source);
    const operation = previous ? previous.then(execute, execute) : execute();
    indexWrites.set(source, operation);
    try { return await operation; }
    finally { if (indexWrites.get(source) === operation) indexWrites.delete(source); }
  }

  function saveSource(req, res, source, sid, session, revision) {
    const time = now();
    if (session?.sources.size >= 30 && !session.sources.has(source.id)) {
      throw new SourceError(409, '当前会话已连接过多来源');
    }
    const newSession = !session;
    if (newSession) {
      for (const [id, stored] of sessions) if (stored.expires <= time) sessions.delete(id);
      if (sessions.size >= 256) throw new SourceError(503, '媒体连接会话已满');
      session = { expires: time + sessionLife, sources: new Map(), embyAudioPlaylists: new Set(), revision: 0 };
      sid = randomBytes(32).toString('base64url');
    } else if (sessions.get(sid) !== session || session.expires <= time) throw staleSource();
    else if (session.revision !== revision) throw new SourceError(409, '媒体来源在连接过程中发生了变化，请重试。');
    storeSession(sid, session, new Map(session.sources).set(source.id, source));
    bindSource(sid, session, source);
    session.sources.set(source.id, source);
    session.revision++;
    if (newSession) {
      sessions.set(sid, session);
      res.setHeader('Set-Cookie', sessionCookie(req, sid, sessionLife / 1000));
    }
    return publicSource(source);
  }

  return async (req, res, url) => {
    if (url.pathname !== pathPrefix && !url.pathname.startsWith(pathPrefix + '/')) return false;
    try {
      const plexReturn = url.pathname === '/api/sources/plex-auth/return' && req.method === 'GET';
      authorizeClient(req, plexReturn);
      if (plexReturn) {
        plexAuthorization.returned(req, url);
        res.writeHead(303, { Location: '/?plex=authorized#sources', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end();
        return true;
      }
      const match = /^\/api\/sources(?:\/([0-9a-f-]{36})(?:\/(list|stream|cover|artist-portraits|backup|played|playback|playlist))?)?$/.exec(url.pathname);
      const plexAction = /^\/api\/sources\/plex-auth\/(start|choices|connect)$/.exec(url.pathname)?.[1];
      if (!match && !plexAction) throw new SourceError(404, '找不到该来源');
      const [, sourceId, action] = match || [];
      const cookies = req.headers.cookie || '';
      const sid = cookies.match(/(?:^|;\s*)groovebox_sources=([a-zA-Z0-9_-]{43})(?:;|$)/)?.[1];
      let session;
      try { session = loadSession(sid, now()); }
      catch (error) {
        const reconnecting = req.method === 'POST' && (url.pathname === pathPrefix || plexAction);
        if (!reconnecting || error.code !== 'source_session_unreadable') throw error;
      }
      const revision = session?.revision;
      if (plexAction) {
        const origin = (req.socket.encrypted ? 'https://' : 'http://') + req.headers.host;
        if (req.method !== 'POST') throw new SourceError(405, '该请求方式不受支持');
        if (req.headers.origin !== origin) throw new SourceError(403, 'Plex 登录只能由当前播放器发起');
        if (plexAction === 'choices') sendJson(res, 200, { choices: await plexAuthorization.choices(req) });
        else {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
            throw new SourceError(415, '请使用 JSON 提交 Plex 登录设置');
          }
          let input;
          try { input = JSON.parse(await bodyText(req, 12 * 1024)); }
          catch (error) {
            if (error instanceof SourceError) throw error;
            throw new SourceError(400, '无法读取 Plex 登录设置');
          }
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SourceError(400, '无法读取 Plex 登录设置');
          if (plexAction === 'start') sendJson(res, 200, await plexAuthorization.start(req, res, input, origin));
          else {
            const source = await plexAuthorization.connect(req, res, input.choice, async (config, clientId) =>
              saveSource(req, res, await newSource(fetchImpl, config, clientId), sid, session, revision));
            sendJson(res, 201, { source });
          }
        }
      } else if (!sourceId && req.method === 'GET') {
        sendJson(res, 200, { sources: session ? [...session.sources.values()].map(publicSource) : [] });
      } else if (!sourceId && req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
          throw new SourceError(415, '请使用 JSON 提交来源设置');
        }
        let config;
        try {
          config = JSON.parse(await bodyText(req, 24 * 1024));
        } catch (error) {
          if (error instanceof SourceError) throw error;
          throw new SourceError(400, '来源设置无法读取');
        }
        const source = await newSource(fetchImpl, config);
        sendJson(res, 201, { source: saveSource(req, res, source, sid, session, revision) });
      } else if (sourceId) {
        const source = session?.sources.get(sourceId);
        if (!source) throw new SourceError(404, '来源已断开，请重新连接');
        if (!action && req.method === 'DELETE') {
          const remaining = new Map(session.sources);
          remaining.delete(sourceId);
          const hints = store && source.type === 'emby' ? replaceSourceHints(session, sourceId, []) : undefined;
          storeSession(sid, session, remaining, hints);
          session.sources.delete(sourceId);
          if (hints) applyHints(session, hints);
          session.revision++;
          if (store && !remaining.size) {
            sessions.delete(sid);
            res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
          }
          sendJson(res, 200, { disconnected: true });
        } else if (action === 'list' && req.method === 'GET') {
          const result = await publishIndex(sid, session, source, async indexed => {
            const path = url.searchParams.get('path') || '/';
            const playlistRoot = path === 'playlists' && playlistSourceTypes.has(indexed.type);
            const recommendations = path === 'home-recommendations' && indexed.type === 'navidrome';
            const folder = path === '/' ? null : playlistRoot ? { action: 'getPlaylists' } : recommendations
              ? { action: 'getAlbumList2' } : indexed.folders.get(path);
            if (path !== '/' && !folder) throw new SourceError(404, '找不到该文件夹');
            const items = emitItems(indexed, await readList(fetchImpl, indexed, folder));
            const serverPlaylist = folder?.action === 'getPlaylist';
            const anonymous = serverPlaylist ? items.filter(item => !item.playlistEntry).map(item => item.id) : [];
            const playlistRevision = new Set(anonymous).size < anonymous.length
              ? stableKey(JSON.stringify(items.map(item => [item.id, item.playlistEntry]))) : undefined;
            return { items, ...(serverPlaylist && { serverOrder: true, playlistRevision }),
              ...(serverPlaylist && indexed.type === 'jellyfin' && { playlistWritable: folder.playlistWritable === true }) };
          });
          sendJson(res, 200, result);
        } else if (action === 'artist-portraits' && ['webdav', 'smb'].includes(source.type) && req.method === 'GET') {
          const portraits = await publishIndex(sid, session, source, indexed => listArtistPortraits(fetchImpl, indexed));
          sendJson(res, 200, { portraits });
        } else if (action === 'artist-portraits' && ['webdav', 'smb'].includes(source.type) && req.method === 'DELETE') {
          const origin = (req.socket.encrypted ? 'https://' : 'http://') + req.headers.host;
          if (req.headers.origin !== origin) throw new SourceError(403, '只能在当前播放器刷新艺人照片');
          await publishIndex(sid, session, source, invalidateArtistPortraits);
          sendJson(res, 200, { invalidated: true });
        } else if (action === 'backup' && ['GET', 'PUT'].includes(req.method)) {
          await syncBackup(fetchImpl, source, req, res);
        } else if (action === 'playlist' && req.method === 'POST') {
          const origin = (req.socket.encrypted ? 'https://' : 'http://') + req.headers.host;
          if (req.headers.origin !== origin) throw new SourceError(403, '歌单只能由当前播放器编辑');
          const result = await publishIndex(sid, session, source, indexed =>
            mutateMediaBrowserPlaylist(fetchImpl, indexed, url.searchParams.get('path'), req, playlistWrites,
              () => sourceActive(sid, session, source)), true);
          sendJson(res, result.playlist ? 201 : 200, result);
        } else if (['played', 'playback'].includes(action) && req.method === 'POST') {
          const origin = (req.socket.encrypted ? 'https://' : 'http://') + req.headers.host;
          if (req.headers.origin !== origin) throw new SourceError(403, '播放记录只能由当前播放器回传');
          const id = url.searchParams.get('id');
          if (action === 'played') await reportSubsonicPlayback(fetchImpl, source, source.media.get(id));
          else await reportEmbyPlayback(fetchImpl, source, id, req);
          sendJson(res, 200, { reported: true });
        } else if (['stream', 'cover'].includes(action) && ['GET', 'HEAD'].includes(req.method)) {
          const record = source.media.get(url.searchParams.get('id'));
          if (!record) throw new SourceError(404, '找不到该媒体');
          const rates = url.searchParams.getAll('maxBitRate');
          if (rates.length && (rates.length !== 1 || action !== 'stream' || !supportsStreamBitrate(source.type) ||
              !record.stream || !streamBitrates.some(rate => rate > 0 && String(rate) === rates[0]))) {
            throw new SourceError(400, '无效的串流码率');
          }
          await proxyMedia(fetchImpl, source, record, action === 'cover', req, res, rates[0]);
        } else throw new SourceError(405, '该请求方式不受支持');
      } else throw new SourceError(405, '该请求方式不受支持');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const handled = error instanceof SourceError || error instanceof SmbError || error instanceof FnMusicError || error instanceof PlexAuthError;
        sendJson(res, handled ? error.status : 502, {
          error: handled ? error.message : '媒体服务器返回异常',
          ...(error instanceof SourceError && error.code && { code: error.code }),
        });
      } else if (!res.destroyed && !res.writableEnded) res.destroy();
    }
    return true;
  };
}
