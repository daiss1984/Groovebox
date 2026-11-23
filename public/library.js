import { binaryBlob, needsBinaryFallback, toBinary, transactionRequest } from './media-storage.js';
import { parseKaraoke } from './karaoke-formats.js';
import { normalizeGenres } from './genres.js';
import { normalizeAudioEncoding } from './audio-encoding.js';
import { normalizeReleaseYear, normalizeTrackModified } from './track-sort.js';

export { normalizeGenres } from './genres.js';
export { normalizeReleaseYear } from './track-sort.js';

const STATE_KEY = 'groovebox.state.v1';
const STATE_SCOPE = /^groovebox\.state\.restore\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
let boundStateScope = STATE_KEY;
const DATABASE = 'groovebox.library';
const TRACKS = 'tracks';
const SERVER_PLAYLISTS = 'serverPlaylists';
const ARTIST_IMAGES = 'artistImages';
const COLLECTIONS = 'collections';
const IMPORT_STORES = [TRACKS, ARTIST_IMAGES, COLLECTIONS];
const AUDIO_EXTENSION = /\.(?:mp3|flac|wav|wave|m4a|mp4|aac|ape|opus|ogg|oga|aiff?|aifc|alac|wma|mka|m4b|webm|amr|ac3|dsf|dff|wv|tta|dts)$/i;
const LYRIC_EXTENSION = /\.(?:lrc|vtt|yrc|qrc|krc)$/i;
const FOLDER_COVER_NAME = /^cover\.(png|jpe?g)$/i;
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']);
const urls = new Map();
const artistImageUrls = new Map();
let databasePromise;
let metadataParser;
let importJob = Promise.resolve();
let binaryFallback = false;

export function isAudioName(name) {
  return typeof name === 'string' && AUDIO_EXTENSION.test(name);
}

export class StateScopeError extends Error {
  constructor(code, cause) {
    super('Browser settings could not be read.', { cause });
    this.name = 'StateScopeError';
    this.code = code;
  }
}
function validateStateScope(scope) {
  if (scope !== STATE_KEY && (typeof scope !== 'string' || !STATE_SCOPE.test(scope))) {
    throw new StateScopeError('state-scope-invalid');
  }
}
export function bindStateScope(scope) {
  validateStateScope(scope);
  boundStateScope = scope;
}
export const currentStateScope = () => boundStateScope;
export function readStateTextAtScope(scope) {
  validateStateScope(scope);
  try { return globalThis.localStorage.getItem(scope); }
  catch (cause) { throw new StateScopeError('state-scope-storage', cause); }
}
function parseScopedState(scope, text, required) {
  if (text === null && !required) return {};
  try {
    const state = JSON.parse(text);
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
        (scope !== STATE_KEY && state._grooveboxStateScope !== scope)) throw new Error('Invalid settings scope');
    return state;
  } catch (cause) { throw new StateScopeError('state-scope-invalid', cause); }
}
export function readStateAtScope(scope, { required = scope !== STATE_KEY } = {}) {
  return parseScopedState(scope, readStateTextAtScope(scope), required);
}
export function readState() {
  if (boundStateScope !== STATE_KEY) return readStateAtScope(boundStateScope);
  try { return readStateAtScope(STATE_KEY); }
  catch { return {}; }
}
export function writeStateTextAtScope(scope, text) {
  try {
    validateStateScope(scope);
    if (typeof text !== 'string') return false;
    parseScopedState(scope, text, true);
    globalThis.localStorage.setItem(scope, text);
    return true;
  } catch { return false; }
}
export function writeStateAtScope(scope, state) {
  try {
    validateStateScope(scope);
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    if (scope !== STATE_KEY && state._grooveboxStateScope !== undefined && state._grooveboxStateScope !== scope) return false;
    return writeStateTextAtScope(scope, JSON.stringify(scope === STATE_KEY ? state : { ...state, _grooveboxStateScope: scope }));
  } catch { return false; }
}
export function writeState(state) {
  return writeStateAtScope(boundStateScope, state);
}

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 4);
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        reject(Object.assign(new Error('Local library upgrade blocked'), { code: 'local-library-upgrade-blocked' }));
      };
      request.onupgradeneeded = event => {
        if (event.oldVersion < 1) request.result.createObjectStore(TRACKS, { keyPath: 'id' });
        if (event.oldVersion < 2) request.result.createObjectStore(SERVER_PLAYLISTS, { keyPath: 'id' });
        if (event.oldVersion < 3) request.result.createObjectStore(ARTIST_IMAGES, { keyPath: 'id' });
        if (event.oldVersion < 4) request.result.createObjectStore(COLLECTIONS, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) {
          database.close();
          return;
        }
        database.onversionchange = () => {
          database.close();
          databasePromise = undefined;
        };
        database.onclose = () => { databasePromise = undefined; };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      if (error.code !== 'local-library-upgrade-blocked') databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

async function transact(mode, operation) {
  return transactionRequest(await openDatabase(), TRACKS, mode, operation);
}

export async function readServerPlaylistMirrors() {
  return transactionRequest(await openDatabase(), SERVER_PLAYLISTS, 'readonly', store => store.getAll());
}

export async function addServerPlaylistMirror(mirror) {
  await transactionRequest(await openDatabase(), SERVER_PLAYLISTS, 'readwrite', store => store.add(mirror));
}

export async function putServerPlaylistMirror(mirror) {
  await transactionRequest(await openDatabase(), SERVER_PLAYLISTS, 'readwrite', store => store.put(mirror));
}

export async function updateServerPlaylistMirror(mirror) {
  const previous = await transactionRequest(await openDatabase(), SERVER_PLAYLISTS, 'readwrite', store => {
    const request = store.get(mirror.id);
    request.onsuccess = () => { if (request.result) store.put(mirror); };
    return request;
  });
  return Boolean(previous);
}

export async function deleteServerPlaylistMirror(id) {
  await transactionRequest(await openDatabase(), SERVER_PLAYLISTS, 'readwrite', store => store.delete(id));
}

const localRevision = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(36)).join('-');

async function readImportSnapshot() {
  let queries;
  await transactionRequest(await openDatabase(), IMPORT_STORES, 'readonly', (_, transaction) => {
    queries = IMPORT_STORES.map(table => transaction.objectStore(table).getAll());
  });
  const [tracks, images, entries] = queries.map(query => query.result);
  const collections = new Map(entries.filter(entry => entry.id).map(entry => [entry.id, entry]));
  for (const { path, originalRoot } of tracks) {
    const separator = path.indexOf('/');
    if (separator < 0) continue;
    const id = path.slice(0, separator).normalize('NFC');
    if (!collections.has(id)) collections.set(id, { id, original: originalRoot ?? id });
  }
  for (const { root } of images) if (!collections.has(root)) collections.set(root, { id: root, original: root });
  return { tracks, images, collections, revision: entries.find(entry => !entry.id)?.revision };
}

async function writeImport(revision, records, images = {}, collections = []) {
  let stale = false;
  let writeFailure;
  const next = localRevision();
  try {
    await transactionRequest(await openDatabase(), IMPORT_STORES, 'readwrite', (tracks, transaction) => {
      const collectionStore = transaction.objectStore(COLLECTIONS);
      const generation = collectionStore.get('');
      generation.onsuccess = () => {
        if (generation.result?.revision !== revision) {
          stale = true;
          transaction.abort();
          return;
        }
        try {
          for (const record of records) tracks.put(record);
          const artistImages = transaction.objectStore(ARTIST_IMAGES);
          for (const id of images.remove ?? []) artistImages.delete(id);
          for (const record of images.put ?? []) artistImages.put(record);
          for (const collection of collections) collectionStore.put(collection);
          collectionStore.put({ id: '', revision: next });
        } catch (error) {
          writeFailure = error;
          transaction.abort();
        }
      };
    });
  } catch (error) {
    if (stale) throw Object.assign(new Error('The local library changed during import'), { code: 'stale-local-import' });
    throw writeFailure || error;
  }
  return next;
}

async function persistImport(revision, records, images, collections) {
  if (!binaryFallback) {
    try {
      await writeImport(revision, records, images, collections);
      return;
    } catch (error) {
      if (!needsBinaryFallback(error)) throw error;
      binaryFallback = true;
    }
  }
  const converted = [];
  for (const { audioFile, coverFile, ...data } of records) {
    if (audioFile) data.audioBinary = await toBinary(audioFile);
    if (coverFile) data.coverBinary = await toBinary(coverFile);
    converted.push(data);
  }
  await writeImport(revision, converted, images, collections);
}

function vttTime(value) {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match) return NaN;
  const [, hours = 0, minutes, seconds, milliseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) return NaN;
  return ((Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(milliseconds)) / 1000;
}

function lrcMilliseconds(value) {
  const match = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(value);
  if (!match || Number(match[2]) > 59) return NaN;
  const [, minutes, seconds, fraction = '0'] = match;
  return (Number(minutes) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, '0'));
}

function decodeVttText(text) {
  return text.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, name) => (
    { amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f' }[name]
  ));
}

function timedLyric(payload, start, end, vtt = false) {
  const parts = [];
  let current = start;
  let cursor = 0;
  let buffer = '';
  let timed = false;
  for (const tag of payload.matchAll(/<((?:\/?[a-z]|!(?:--|[a-z])|\d+:)[^<>]*)>/gi)) {
    buffer += payload.slice(cursor, tag.index);
    cursor = tag.index + tag[0].length;
    const time = vtt ? vttTime(tag[1]) : lrcMilliseconds(tag[1]);
    const inOrder = time > current || (!vtt && !timed && time === start);
    if (!Number.isFinite(time) || !inOrder || time >= end) continue;
    if (buffer) parts.push({
      time: current, text: buffer, timed,
      ...(time > current && { endTime: time }),
    });
    buffer = '';
    current = time;
    timed = true;
  }
  parts.push({
    time: current, text: buffer + payload.slice(cursor), timed,
    ...(Number.isFinite(end) && end > current && { endTime: end }),
  });
  if (vtt) for (const part of parts) part.text = decodeVttText(part.text);

  const first = parts.findIndex(part => part.text.trim());
  if (first === -1) return null;
  const last = parts.findLastIndex(part => part.text.trim());
  parts[first].text = parts[first].text.trimStart();
  parts[last].text = parts[last].text.trimEnd();
  const visible = parts.slice(first, last + 1).filter(part => part.text);
  const text = visible.map(part => part.text).join('');
  if (!visible.some(part => part.timed && part.text.trim())) return { time: start, text };
  return { time: start, text, words: visible.map(({ timed, ...word }) => word) };
}

function parseVtt(text) {
  const lyrics = [];
  for (const block of text.split(/\n[\t ]*\n/)) {
    const lines = block.trim().split('\n');
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
    const index = lines.findIndex((line, lineIndex) => lineIndex < 2 && line.includes('-->'));
    if (index < 0) continue;
    const timing = /^(\S+)\s+-->\s+(\S+)/.exec(lines[index]);
    if (!timing) continue;
    const start = vttTime(timing[1]);
    const end = vttTime(timing[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const line = timedLyric(lines.slice(index + 1).join('\n'), start, end, true);
    if (line) lyrics.push(line);
  }
  return lyrics;
}

function parseLrc(text) {
  const offsetValue = Number(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im.exec(text)?.[1] ?? 0);
  const offset = Number.isFinite(offsetValue) ? offsetValue : 0;
  const lyrics = [];
  const firstAtTime = new Map();
  for (const row of text.split('\n')) {
    const trimmed = row.trimStart();
    const marks = /^(?:\[\d+:\d{1,2}(?:[.:]\d{1,3})?\])+/u.exec(trimmed)?.[0];
    if (!marks) continue;
    const times = [...marks.matchAll(/\[([^\]]+)\]/g)]
      .map(([, time]) => lrcMilliseconds(time)).filter(Number.isFinite);
    if (!times.length) continue;
    const line = timedLyric(trimmed.slice(marks.length), times[0], Infinity);
    if (!line) continue;
    for (const time of times) {
      const shift = time - line.time + offset;
      const toSeconds = value => Math.max(0, value + shift) / 1000;
      const cue = { time: toSeconds(line.time), text: line.text };
      if (line.words) cue.words = line.words.map(word => ({
        time: toSeconds(word.time), text: word.text,
        ...(word.endTime !== undefined && { endTime: toSeconds(word.endTime) }),
      }));
      const previous = firstAtTime.get(time);
      if (!previous || (cue.words && cue.text !== previous.cue.text)) {
        const entry = { cue, translations: new Set() };
        lyrics.push(entry);
        if (!previous) firstAtTime.set(time, entry);
      } else if (cue.text !== previous.cue.text) previous.translations.add(cue.text);
      else if (!previous.cue.words && cue.words) previous.cue.words = cue.words;
    }
  }
  return lyrics.map(({ cue, translations }) =>
    translations.size ? { ...cue, translation: [...translations].join('\n') } : cue);
}

export function parseLyrics(text, format = '') {
  if (typeof text !== 'string') return [];
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const karaoke = parseKaraoke(normalized, format);
  if (karaoke.length) return karaoke;
  const isVtt = /vtt$/i.test(format) || /^WEBVTT(?:\s|$)/.test(normalized) || /\d{2}:\d{2}\.\d{3}\s+-->/.test(normalized);
  return (isVtt ? parseVtt(normalized) : parseLrc(normalized)).sort((a, b) => a.time - b.time);
}

function filePath(file) {
  return file.webkitRelativePath || file.name;
}

function parentDirectory(path) {
  return path.slice(0, path.lastIndexOf('/') + 1).normalize('NFC');
}

function detachedBlob(file, type) {
  // Consume the stream so stored blobs do not rely on the selected file's inode.
  return new Response(file.stream().pipeThrough(new TransformStream()), {
    headers: { 'Content-Type': type || 'application/octet-stream' },
  }).blob();
}

async function imageBlob(file, png) {
  const header = await file.slice(0, 8).arrayBuffer().catch(() => undefined);
  if (!header) return;
  const bytes = new Uint8Array(header);
  const signature = png ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
  if (signature.every((value, index) => bytes[index] === value)) {
    return detachedBlob(file, png ? 'image/png' : 'image/jpeg');
  }
}

async function readFolderCovers(entries) {
  const covers = new Map();
  for (const { file, path } of entries) {
    const extension = FOLDER_COVER_NAME.exec(file.name)?.[1].toLowerCase();
    if (!extension) continue;
    const directory = parentDirectory(path);
    const png = extension === 'png';
    if (covers.has(directory) && (!png || covers.get(directory).file.type === 'image/png')) continue;
    const image = await imageBlob(file, png);
    if (!image) continue;
    covers.set(directory, {
      file: image,
      revision: JSON.stringify([file.name, file.lastModified, file.size]),
    });
  }
  return covers;
}

async function localArtistImageChanges(entries, previous) {
  const roots = new Set();
  const images = new Map();
  for (const { file, path } of entries) {
    const parts = path.normalize('NFC').split('/');
    if (parts.length < 2) continue;
    const [root, folder, name] = parts;
    roots.add(root);
    if (parts.length !== 3 || folder.toLowerCase() !== 'artist') continue;
    const match = /^(.*)\.(png|jpe?g)$/i.exec(name);
    const artist = match?.[1].trim().toLowerCase();
    if (!artist) continue;
    const id = JSON.stringify([root, artist]);
    const png = match[2].toLowerCase() === 'png';
    if (images.has(id) && (!png || images.get(id).image.type === 'image/png')) continue;
    const image = await imageBlob(file, png);
    if (image) images.set(id, { id, root, artist, image });
  }
  const stored = new Map(previous.map(record => [record.id, record]));
  const put = [];
  for (const { image, ...record } of images.values()) {
    const old = stored.get(record.id)?.binary;
    if (old?.type === image.type && await equalMedia(image, old.buffer)) continue;
    put.push({ ...record, revision: localRevision(), binary: await toBinary(image) });
  }
  return { remove: previous.filter(record => roots.has(record.root) && !images.has(record.id)).map(record => record.id), put };
}

export async function hydrateLocalArtistImages() {
  const records = await transactionRequest(await openDatabase(), ARTIST_IMAGES, 'readonly', store => store.getAll());
  const images = new Map(records.map(record => [record.id, record]));
  for (const [id, cached] of artistImageUrls) {
    if (images.get(id)?.revision === cached.revision) continue;
    URL.revokeObjectURL(cached.cover);
    artistImageUrls.delete(id);
  }
  for (const { id, binary, revision } of records) {
    if (!artistImageUrls.has(id)) artistImageUrls.set(id, { cover: URL.createObjectURL(binaryBlob(binary)), revision });
  }
  return new Map([...artistImageUrls].map(([id, { cover }]) => [id, { cover }]));
}

function stem(path) {
  return path.replace(/\.[^.\/]+$/, '').normalize('NFC').toLowerCase();
}

async function lyricFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

function embeddedLyrics(lyrics) {
  for (const tag of lyrics ?? []) {
    if (tag.timeStampFormat === 2 && tag.syncText?.length) {
      const lines = tag.syncText
        .filter((line) => Number.isFinite(line.timestamp) && line.text?.trim())
        .map((line) => ({ time: line.timestamp / 1000, text: line.text.trim() }))
        .sort((a, b) => a.time - b.time);
      if (lines.length) return lines;
    }
    const text = typeof tag === 'string' ? tag : tag.text;
    const timed = parseLyrics(text);
    if (timed.length) return timed;
    if (text?.trim()) return [{ time: null, text: text.trim() }];
  }
  return [];
}

async function metadata(file, duration = true) {
  metadataParser ??= import('/metadata.bundle.js').then((module) => module.parseBlob);
  try {
    const parseBlob = await metadataParser;
    return await parseBlob(file, { duration });
  } catch {
    return {};
  }
}

export async function readAudioEncoding(file) {
  const { format } = await metadata(file, false);
  return normalizeAudioEncoding(format) ?? null;
}

export function mayHaveR128Gain(filename) {
  return typeof filename === 'string' && /\.(?:opus|ogg|oga)$/i.test(filename);
}

function opusR128Gains({ format, native } = {}) {
  if (format?.container !== 'Ogg' || format.codec !== 'Opus' || !Array.isArray(native?.vorbis)) return {};
  const read = key => {
    const tags = native.vorbis.filter(comment => typeof comment?.id === 'string' && comment.id.toUpperCase() === key);
    const value = tags.length === 1 ? tags[0].value : undefined;
    // RFC 7845 §5.2.1 uses signed Q7.8 gain relative to the Opus decoder's output gain.
    if (typeof value !== 'string' || value.length > 6 || value !== value.trim() || !/^[+-]?[0-9]+$/u.test(value)) return undefined;
    const integer = Number(value);
    return integer >= -32768 && integer <= 32767 ? integer / 256 : undefined;
  };
  const track = read('R128_TRACK_GAIN');
  const album = read('R128_ALBUM_GAIN');
  return {
    ...(Number.isFinite(track) && { r128TrackGain: track }),
    ...(Number.isFinite(album) && { r128AlbumGain: album }),
  };
}

export function replayGainTags(common, metadata) {
  const gain = common.replaygain_track_gain?.dB;
  const peak = common.replaygain_track_peak?.ratio ?? common.replaygain_track_peak_ratio;
  const albumGain = common.replaygain_album_gain?.dB;
  const albumPeak = common.replaygain_album_peak?.ratio;
  return {
    ...(Number.isFinite(gain) && Math.abs(gain) <= 100 && { replayGain: gain }),
    ...(Number.isFinite(peak) && peak > 0 && peak <= 10 && { replayGainPeak: peak }),
    ...(Number.isFinite(albumGain) && Math.abs(albumGain) <= 100 && { replayGainAlbum: albumGain }),
    ...(Number.isFinite(albumPeak) && albumPeak > 0 && albumPeak <= 10 && { replayGainAlbumPeak: albumPeak }),
    ...opusR128Gains(metadata),
  };
}

export function releaseYearTag(common) {
  return normalizeReleaseYear(common.releasedate) ?? normalizeReleaseYear(common.year) ?? normalizeReleaseYear(common.date);
}

export function normalizeAlbumArtist(value) {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300) || undefined;
}

export function albumArtistTag(common) {
  return normalizeAlbumArtist(common.albumartist) ??
    normalizeAlbumArtist(Array.isArray(common.albumartists) ? common.albumartists.join(', ') : undefined);
}

function albumTags(common) {
  return { releaseYear: releaseYearTag(common) ?? null, albumArtist: albumArtistTag(common) ?? null };
}

async function identify({ file, audioFile, id, path, originalRoot }, sidecar, folderCover) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const split = /^(.*?)\s+[-–—]\s+(.+)$/.exec(name);
  const parsed = await metadata(audioFile);
  const { common = {}, format = {} } = parsed;
  const picture = common.picture?.find((item) => COVER_TYPES.has(item.format?.toLowerCase()) && item.data?.length);
  const coverFile = picture ? new Blob([picture.data], { type: picture.format }) : folderCover?.file;
  const artist = common.artist?.trim() || common.artists?.join(', ') || split?.[1];
  const album = common.album?.trim();
  return {
    id,
    provider: 'local',
    path,
    originalRoot,
    title: common.title?.trim() || split?.[2] || name,
    artist: artist || '未知艺人',
    artistIsFallback: !artist,
    album: album || '本地音乐',
    albumIsFallback: !album,
    ...albumTags(common),
    genres: normalizeGenres(common.genre),
    duration: Number.isFinite(format.duration) ? format.duration : 0,
    encoding: normalizeAudioEncoding(format) ?? null,
    ...replayGainTags(common, parsed),
    replayGainAlbumRead: true,
    r128GainRead: true,
    modified: file.lastModified,
    audioRevision: localRevision(),
    audioDetached: true,
    audioFile,
    coverFile,
    folderCoverRevision: picture ? undefined : folderCover?.revision,
    lyrics: sidecar?.lyrics ?? embeddedLyrics(common.lyrics),
    lyricsSource: sidecar?.source ?? 'embedded',
  };
}

function revoke(id, retainAudioURL) {
  const cached = urls.get(id);
  if (!cached) return;
  if (cached.src && !retainAudioURL?.(cached.src)) URL.revokeObjectURL(cached.src);
  if (cached.cover) URL.revokeObjectURL(cached.cover);
  urls.delete(id);
}

const localAudioSize = record => record.audioFile?.size ?? record.audioBinary?.buffer.byteLength;

function materialize(record, retainAudioURL) {
  const { audioFile, coverFile, audioBinary, coverBinary, modified, folderCoverRevision, audioRevision, audioDetached, lyricsSource, originalRoot, ...track } = record;
  const size = localAudioSize(record);
  let cached = urls.get(track.id);
  if (!cached || cached.size !== size || cached.audioRevision !== audioRevision || (!audioRevision && cached.modified !== modified)) {
    revoke(track.id, retainAudioURL);
    const blob = audioFile || binaryBlob(audioBinary);
    cached = {
      src: URL.createObjectURL(blob),
      size,
      modified,
      audioRevision,
    };
    urls.set(track.id, cached);
  }
  if (cached.cover === undefined || cached.folderCoverRevision !== folderCoverRevision) {
    if (cached.cover) URL.revokeObjectURL(cached.cover);
    const cover = coverFile || binaryBlob(coverBinary);
    cached.cover = cover ? URL.createObjectURL(cover) : '';
    cached.folderCoverRevision = folderCoverRevision;
  }
  return { ...track, modified: normalizeTrackModified(modified), src: cached.src, cover: cached.cover };
}

export async function hydrateLocals() {
  const records = await transact('readonly', (store) => store.getAll());
  return records.map(record => materialize(record));
}

export function readMissingLocalAlbumTags() {
  const job = importJob.then(async () => {
    const records = await transact('readonly', store => store.getAll());
    const pending = [];
    for (const record of records) {
      if (record.releaseYear !== undefined && record.albumArtist !== undefined) continue;
      const audio = record.audioFile || binaryBlob(record.audioBinary);
      const { common = {} } = await metadata(audio, false);
      pending.push({ id: record.id, modified: record.modified, size: localAudioSize(record), audioRevision: record.audioRevision, tags: albumTags(common) });
    }
    const updated = new Map();
    if (pending.length) await transact('readwrite', store => {
      for (const { id, modified, size, audioRevision, tags } of pending) {
        const request = store.get(id);
        request.onsuccess = () => {
          const current = request.result;
          if (!current || current.modified !== modified || localAudioSize(current) !== size || current.audioRevision !== audioRevision) return;
          if (current.releaseYear === undefined || current.albumArtist === undefined) {
            if (current.releaseYear === undefined) current.releaseYear = tags.releaseYear;
            if (current.albumArtist === undefined) current.albumArtist = tags.albumArtist;
            store.put(current);
          }
          updated.set(id, { releaseYear: current.releaseYear, albumArtist: current.albumArtist });
        };
      }
    });
    return updated;
  });
  importJob = job.catch(() => {});
  return job;
}

export function readLocalReplayGain(id) {
  const job = importJob.then(async () => {
    const record = await transact('readonly', store => store.get(id));
    if (!record) return;
    if (record.replayGainAlbumRead && (record.r128GainRead || !mayHaveR128Gain(record.path))) {
      const { replayGainAlbum, replayGainAlbumPeak, replayGainAlbumRead, r128TrackGain, r128AlbumGain, r128GainRead } = record;
      return { replayGainAlbum, replayGainAlbumPeak, replayGainAlbumRead, r128TrackGain, r128AlbumGain, r128GainRead };
    }
    const audio = record.audioFile || binaryBlob(record.audioBinary);
    const parsed = await metadata(audio, false);
    const gains = parsed.common ? replayGainTags(parsed.common, parsed) : record;
    const { replayGainAlbum, replayGainAlbumPeak, r128TrackGain, r128AlbumGain } = gains;
    const tags = { replayGainAlbum, replayGainAlbumPeak, replayGainAlbumRead: true, r128TrackGain, r128AlbumGain, r128GainRead: true };
    let saved = false;
    await transact('readwrite', store => {
      const request = store.get(id);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || current.modified !== record.modified || localAudioSize(current) !== localAudioSize(record) ||
            current.audioRevision !== record.audioRevision) return;
        store.put({ ...current, ...tags });
        saved = true;
      };
    });
    return saved ? tags : undefined;
  });
  importJob = job.catch(() => {});
  return job;
}

export function readLocalAudioEncoding(id) {
  const job = importJob.then(async () => {
    const record = await transact('readonly', store => store.get(id));
    if (!record || record.encoding !== undefined) return record?.encoding;
    const encoding = await readAudioEncoding(record.audioFile || binaryBlob(record.audioBinary));
    let saved = false;
    await transact('readwrite', store => {
      const request = store.get(id);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || current.modified !== record.modified || localAudioSize(current) !== localAudioSize(record) ||
            current.audioRevision !== record.audioRevision) return;
        store.put({ ...current, encoding });
        saved = true;
      };
    });
    return saved ? encoding : undefined;
  });
  importJob = job.catch(() => {});
  return job;
}

async function equalMedia(file, stored) {
  const blob = stored instanceof Blob;
  if (file.size !== (blob ? stored.size : stored?.byteLength)) return false;
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, file.size);
    const incoming = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const previous = blob ? new Uint8Array(await stored.slice(offset, end).arrayBuffer()) : new Uint8Array(stored, offset, end - offset);
    if (!incoming.every((value, index) => value === previous[index])) return false;
  }
  return true;
}

function availableCollectionId(collections, name) {
  if (!collections.has(name)) return name;
  let copy = 2;
  while (collections.has(name + ' (' + copy + ')')) copy++;
  return name + ' (' + copy + ')';
}

async function importPaths(files, collections, resolveConflict) {
  const roots = new Map();
  const entries = [];
  for (const file of files) {
    const path = filePath(file);
    const separator = file.webkitRelativePath ? path.indexOf('/') : -1;
    if (separator < 0) {
      entries.push({ file, path });
      continue;
    }
    const originalRoot = path.slice(0, separator).normalize('NFC');
    if (!roots.has(originalRoot)) {
      const existing = [...collections.values()].filter(entry => entry.original === originalRoot);
      let id;
      if (existing.length) {
        const decision = await resolveConflict({ kind: 'folder', name: originalRoot,
          existing: existing.map(entry => ({ id: entry.id, label: entry.id })) });
        if (!decision) return;
        if (decision.action === 'replace') {
          if (!existing.some(entry => entry.id === decision.id)) return;
          id = decision.id;
        } else if (decision.action !== 'keep') return;
      }
      id ??= availableCollectionId(collections, originalRoot);
      const collection = { id, original: originalRoot };
      roots.set(originalRoot, collection);
      collections.set(id, collection);
    }
    entries.push({ file, originalRoot, path: roots.get(originalRoot).id + path.slice(separator) });
  }
  return { entries, collections: [...roots.values()] };
}

function audioInput({ file }) {
  return isAudioName(file.name) || (/^audio\//.test(file.type) && !LYRIC_EXTENSION.test(file.name));
}

async function localSidecars(entries) {
  const sidecars = new Map();
  for (const { file, path, originalRoot } of entries.filter(({ file }) => LYRIC_EXTENSION.test(file.name))) {
    const parsed = parseLyrics(await lyricFile(file), file.name);
    const key = stem(path);
    const previous = sidecars.get(key);
    const hasWords = parsed.some(line => line.words?.length);
    if (parsed.length && (!previous || (hasWords && !previous.lyrics.some(line => line.words?.length)))) {
      sidecars.set(key, { lyrics: parsed, source: originalRoot ? 'folder' : 'manual' });
    }
  }
  return sidecars;
}

async function updateLocalAudio(entry, existing, unchanged, sidecar, folderCover) {
  const { audioFile, originalRoot } = entry;
  const manualLyrics = existing?.lyricsSource === 'manual' ? { lyrics: existing.lyrics, source: 'manual' } : undefined;
  const selected = sidecar?.source === 'manual' ? sidecar : manualLyrics ?? sidecar;
  if (!unchanged) return identify(entry, selected, folderCover);

  const refreshR128 = !existing.r128GainRead && mayHaveR128Gain(existing.path);
  const clearFolderLyric = originalRoot && !selected && (existing.lyricsSource === 'folder' || existing.lyricsSource === undefined);
  const parsed = clearFolderLyric || refreshR128 || existing.genres === undefined || existing.releaseYear === undefined || existing.albumArtist === undefined
    ? await metadata(audioFile, false) : {};
  const { common = {} } = parsed;
  const tags = albumTags(common);
  const record = { ...existing, originalRoot, genres: existing.genres ?? normalizeGenres(common.genre),
    ...(originalRoot && entry.file && { modified: entry.file.lastModified }),
    releaseYear: existing.releaseYear === undefined ? tags.releaseYear : existing.releaseYear,
    albumArtist: existing.albumArtist === undefined ? tags.albumArtist : existing.albumArtist,
    ...(refreshR128 && parsed.common && { ...opusR128Gains(parsed), r128GainRead: true }) };
  if (existing.audioFile && existing.audioFile !== audioFile && !existing.audioDetached) {
    record.audioFile = audioFile;
    record.audioDetached = true;
  }
  if (selected) {
    record.lyrics = selected.lyrics;
    record.lyricsSource = selected.source;
  } else if (clearFolderLyric) {
    record.lyrics = embeddedLyrics(common.lyrics);
    record.lyricsSource = 'embedded';
  }
  const oldCover = existing.coverFile || existing.coverBinary?.buffer;
  if (existing.folderCoverRevision || !oldCover) {
    const cover = folderCover?.file;
    const sameCover = cover && (existing.coverFile?.type || existing.coverBinary?.type) === cover.type && await equalMedia(cover, oldCover);
    if ((originalRoot || cover) && !sameCover) {
      record.coverFile = cover;
      delete record.coverBinary;
      record.folderCoverRevision = cover ? localRevision() : undefined;
    }
  }
  return record;
}

async function importFiles(files, { resolveConflict = () => ({ action: 'keep' }), lyricsTarget, retainAudioURL } = {}) {
  const snapshot = await readImportSnapshot();
  const prepared = await importPaths(files, snapshot.collections, resolveConflict);
  if (!prepared) return null;
  const { entries, collections } = prepared;
  const [covers, sidecars, images] = await Promise.all([
    readFolderCovers(entries), localSidecars(entries), localArtistImageChanges(entries, snapshot.images),
  ]);

  const records = new Map();
  const byPath = new Map();
  for (const record of snapshot.tracks) {
    const key = record.path.normalize('NFC');
    if (!byPath.has(key)) byPath.set(key, new Map());
    byPath.get(key).set(record.id, record);
  }
  const seen = new Set();
  const audio = entries.filter(audioInput);
  const audioStems = new Map();
  for (const { path } of audio) {
    const key = stem(path);
    audioStems.set(key, (audioStems.get(key) ?? 0) + 1);
  }
  for (const entry of audio) {
    const { file, path, originalRoot } = entry;
    const blob = await detachedBlob(file, file.type);
    const audioFile = new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
    const key = path.normalize('NFC');
    const candidates = byPath.get(key) ?? new Map();
    let existing;
    for (const candidate of candidates.values()) {
      if (!await equalMedia(audioFile, candidate.audioFile || candidate.audioBinary?.buffer)) continue;
      existing = candidate;
      break;
    }
    const unchanged = Boolean(existing);
    if (!existing && candidates.size) {
      if (originalRoot && candidates.size === 1 && !seen.has(key)) existing = candidates.values().next().value;
      else {
        const decision = await resolveConflict({ kind: 'file', name: file.name,
          existing: [...candidates.values()].map(track => ({ id: track.id, label: [track.title, track.artist].filter(Boolean).join(' · ') || file.name })) });
        if (!decision) return null;
        if (decision.action === 'replace' && candidates.has(decision.id)) existing = candidates.get(decision.id);
        else if (decision.action !== 'keep') return null;
      }
    }
    const id = existing?.id ?? (candidates.size ? 'local:copy/' + localRevision() : 'local:' + key);
    const lyricStem = stem(path);
    const sidecar = audioStems.get(lyricStem) === 1 ? sidecars.get(lyricStem) : undefined;
    const record = await updateLocalAudio({ ...entry, id, audioFile }, existing, unchanged, sidecar, covers.get(parentDirectory(path)));
    records.set(id, record);
    candidates.set(id, record);
    byPath.set(key, candidates);
    seen.add(key);
  }
  if (sidecars.size || collections.length) {
    const selectedRoots = new Map(collections.map(collection => [collection.id, collection.original]));
    const filenameCount = new Map();
    if (sidecars.size) {
      for (const candidates of byPath.values()) for (const record of candidates.values()) {
        const base = stem(record.path.split('/').at(-1));
        filenameCount.set(base, (filenameCount.get(base) ?? 0) + 1);
      }
    }
    for (const record of snapshot.tracks) {
      const { id, path } = record;
      if (records.has(id)) continue;
      const components = path.split('/');
      const base = stem(components.at(-1));
      const folder = components.length > 1 ? sidecars.get(stem(path)) : undefined;
      const manual = !audioStems.has(base) && (lyricsTarget ? lyricsTarget === id : filenameCount.get(base) === 1) ? sidecars.get(base) : undefined;
      const originalRoot = components.length > 1 ? selectedRoots.get(components[0].normalize('NFC')) : undefined;
      if (originalRoot) {
        const audioFile = record.audioFile || binaryBlob(record.audioBinary);
        records.set(id, await updateLocalAudio({ audioFile, originalRoot }, record, true, manual ?? folder, covers.get(parentDirectory(path))));
        continue;
      }
      const sidecar = manual ?? (record.lyricsSource === 'manual' ? undefined : folder);
      if (sidecar) records.set(id, { ...record, lyrics: sidecar.lyrics, lyricsSource: sidecar.source });
    }
  }
  if (records.size || images.put.length || images.remove.length) {
    await persistImport(snapshot.revision, [...records.values()], images, collections);
  }
  return [...records.values()].map(record => materialize(record, retainAudioURL));
}

export function importLocalFiles(input, options) {
  const files = Array.from(input ?? []);
  const job = importJob.then(() => importFiles(files, options));
  importJob = job.catch(() => {});
  return job;
}

export async function removeLocal(id) {
  const job = importJob.then(async () => {
    await transactionRequest(await openDatabase(), [TRACKS, COLLECTIONS], 'readwrite', (tracks, transaction) => {
      tracks.delete(id);
      transaction.objectStore(COLLECTIONS).put({ id: '', revision: localRevision() });
    });
    revoke(id);
  });
  importJob = job.catch(() => {});
  return job;
}
