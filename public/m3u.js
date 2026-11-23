import { validCloudTrack } from './playlist-sync.js';

export const maxM3uBytes = 1024 * 1024;

export class M3uError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function decodeM3u(bytes, filename) {
  try {
    if (/\.m3u8$/i.test(filename)) return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    const header = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1024));
    const encoding = /^#EXTENC:\s*([\w-]+)\s*$/im.exec(header)?.[1];
    if (encoding) return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return new TextDecoder('windows-1252').decode(bytes); }
  } catch {
    throw new M3uError('encoding');
  }
}

const safeTitle = value => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 80);
const basename = path => path.split(/[\\/]/).at(-1) || '';
const fold = value => value.normalize('NFC').toLowerCase();
const subsonicPlaylistSources = new Set(['navidrome', 'subsonic', 'opensubsonic']);

export function parseM3u(input, filename) {
  const bytes = new Uint8Array(input);
  if (bytes.byteLength > maxM3uBytes) throw new M3uError('too-large');
  const text = decodeM3u(bytes, filename);
  if (text.includes('\0')) throw new M3uError('encoding');
  const entries = [];
  let name;
  let detail = '';
  let artist = '';
  for (const source of text.split(/\r\n|\n|\r/)) {
    const line = source.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/^#EXT-X-/i.test(line)) throw new M3uError('stream');
      name ||= safeTitle(/^#PLAYLIST:\s*(.+)$/i.exec(line)?.[1] || '');
      detail = /^#EXTINF:[^,]*,(.*)$/i.exec(line)?.[1]?.trim() ?? detail;
      artist = /^#EXTART:\s*(.*)$/i.exec(line)?.[1]?.trim() ?? artist;
      continue;
    }
    if (entries.length >= 10_000) throw new M3uError('too-large');
    entries.push({ path: line, detail, artist });
    detail = '';
    artist = '';
  }
  return { name: name || safeTitle(basename(filename).replace(/\.m3u8?$/i, '')), entries };
}

function normalizedPath(path) {
  if (/[\x00-\x1f\x7f-\x9f]/.test(path) || path.length > 4096) return '';
  const parts = [];
  for (const part of path.replaceAll('\\', '/').normalize('NFC').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function localPath(value) {
  let path = value;
  if (/^file:/i.test(path)) {
    try {
      const uri = new URL(path);
      if ((uri.hostname && uri.hostname !== 'localhost') || uri.search || uri.hash || /%(?:2f|5c)/i.test(uri.pathname)) return '';
      path = decodeURIComponent(uri.pathname);
      if (path.startsWith('//')) return '';
    } catch { return ''; }
  } else if (/^[/\\]{2}/.test(path) || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[/\\]/i.test(path))) return '';
  return normalizedPath(path);
}

function suffixLength(left, right) {
  let count = 0;
  while (left.at(-count - 1) && left.at(-count - 1) === right.at(-count - 1)) count++;
  return count;
}
function entryTags(detail, artist) {
  return artist ? { artist, title: detail } : /^(?<artist>.+?)\s+[-–—]\s+(?<title>.+)$/.exec(detail)?.groups;
}
function tagKey(artist, title) {
  if (typeof artist === 'string' && typeof title === 'string' && artist.trim() && title.trim()) {
    return JSON.stringify([fold(artist.trim()), fold(title.trim())]);
  }
}

function identify(path, detail, artist, candidates) {
  const exact = candidates.filter(candidate => candidate.path === path);
  if (exact.length === 1) return exact[0];
  const lower = fold(path);
  const folded = candidates.filter(candidate => candidate.folded === lower);
  if (folded.length === 1) return folded[0];
  const parts = lower.split('/');
  let best = 0;
  let matched = [];
  for (const candidate of exact.length ? exact : folded.length ? folded : candidates) {
    const score = suffixLength(parts, candidate.parts);
    if (score > best) { best = score; matched = [candidate]; }
    else if (score === best) matched.push(candidate);
  }
  if (matched.length <= 1) return matched[0];
  const tagged = entryTags(detail, artist);
  if (!tagged?.title) return;
  const byTags = matched.filter(({ track }) => !track.artistIsFallback &&
    fold(track.artist ?? '') === fold(tagged.artist) && fold(track.title ?? '') === fold(tagged.title));
  if (byTags.length === 1) return byTags[0];
}

function remoteLocation(value, origin, upstream = false) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) return;
  const proxy = value.startsWith('/api/');
  if (!proxy && !/^https?:\/\//i.test(value)) return;
  try {
    const url = proxy ? new URL(value, origin) : new URL(value);
    if (url.username || url.password || url.hash || /%(?:2f|5c|00)/i.test(url.pathname)) return;
    if (!upstream && url.origin === origin && url.pathname.startsWith('/api/')) {
      return 'proxy:' + url.href;
    }
    if (!proxy && !url.search) return 'webdav:' + url.origin + decodeURIComponent(url.pathname);
  } catch { /* Invalid URL. */ }
}

export function matchM3u(entries, catalog, origin) {
  const filenames = new Map();
  const locations = new Map();
  const tags = new Map();
  function indexUnique(map, key, id) {
    if (!key) return;
    map.set(key, map.has(key) && map.get(key) !== id ? null : id);
  }
  for (const track of catalog) {
    let filePath;
    if (validCloudTrack(track)) {
      indexUnique(locations, remoteLocation(track.src, origin), track.id);
      if (track.provider === 'webdav') indexUnique(locations, remoteLocation(track.playlistLocation, origin, true), track.id);
      if (subsonicPlaylistSources.has(track.provider)) {
        filePath = track.playlistLocation;
        // Some servers expose virtual names in their API but export physical paths in M3U files.
        if (!track.artistIsFallback) indexUnique(tags, tagKey(track.artist, track.title), track.id);
      }
    }
    if (track.provider === 'local') filePath = track.path;
    if (typeof filePath !== 'string' || typeof track.id !== 'string') continue;
    const path = track.provider === 'local' ? normalizedPath(filePath) : localPath(filePath);
    if (!path) continue;
    const folded = fold(path);
    const parts = folded.split('/');
    const name = parts.at(-1);
    const candidates = filenames.get(name) || [];
    candidates.push({ track, path, folded, parts });
    filenames.set(name, candidates);
  }

  const trackIds = [];
  const seen = new Set();
  for (const entry of entries) {
    const reference = remoteLocation(entry.path, origin);
    let id;
    if (reference) {
      const key = locations.has(reference) ? reference : remoteLocation(entry.path, origin, true);
      id = locations.get(key);
    } else {
      const path = localPath(entry.path);
      if (path) {
        const candidates = filenames.get(fold(basename(path))) || [];
        if (candidates.length) id = identify(path, entry.detail, entry.artist, candidates)?.track.id;
        else {
          const tagged = entryTags(entry.detail, entry.artist);
          id = tags.get(tagKey(tagged?.artist, tagged?.title));
        }
      }
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    trackIds.push(id);
  }
  return { trackIds, skipped: entries.length - trackIds.length };
}

