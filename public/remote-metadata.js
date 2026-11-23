import { albumArtistTag, normalizeGenres, parseLyrics, releaseYearTag, replayGainTags } from './library.js';
import { normalizeAudioEncoding } from './audio-encoding.js';

const pageSize = 64 * 1024;
const requestLimit = 24;
const byteLimit = requestLimit * pageSize;
const imageLimit = 512 * 1024;
const supportedImages = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

export class RemoteMetadataError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'RemoteMetadataError';
    this.code = code;
  }
}

function mediaEndpoint(src) {
  if (typeof src !== 'string' || /[\x00-\x1f\\]/.test(src)) return null;
  const origin = globalThis.location?.origin || 'https://groovebox.invalid';
  let url;
  try { url = new URL(src, origin); } catch { return null; }
  if (url.origin !== origin || url.username || url.password || url.hash) return null;
  if (!/^\/api\/(?:sources\/[\w-]+|(?!sources\/)\w+)\/stream$/.test(url.pathname)) return null;
  const id = url.searchParams.get('id');
  if (url.searchParams.size !== 1 || !id || id.length > 2048 || /[\x00-\x1f]/.test(id)) return null;
  return url.pathname + '?' + new URLSearchParams({ id });
}

function unavailableRange() {
  return new RemoteMetadataError('range-unavailable', '音源未提供可用于读取标签的字节范围。');
}

async function readRangeBody(body, size, signal) {
  if (!body) throw unavailableRange();
  const reader = body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > size - offset) throw unavailableRange();
      bytes.set(value, offset);
      offset += value.length;
    }
    if (offset !== size) throw unavailableRange();
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

class SparseRemoteFile {
  constructor(endpoint, signal, fetchImpl) {
    this.endpoint = endpoint;
    this.signal = signal;
    this.fetchImpl = fetchImpl;
    this.pages = new Map();
    this.requestCount = 0;
    this.requestedBytes = 0;
  }

  async readPage(start) {
    this.signal.throwIfAborted();
    if (this.pages.has(start)) return this.pages.get(start);
    const length = Math.min(pageSize, (this.size ?? Number.MAX_SAFE_INTEGER) - start);
    if (this.requestCount >= requestLimit || this.requestedBytes + length > byteLimit) {
      throw new RemoteMetadataError('budget', '音频标签超出远程读取范围。');
    }
    this.requestCount++;
    this.requestedBytes += length;
    const end = start + length - 1;
    const headers = { Range: 'bytes=' + start + '-' + end };
    if (this.validator) headers['If-Range'] = this.validator.value;
    const response = await this.fetchImpl(this.endpoint, {
      headers,
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: this.signal,
    });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
    const encoding = response.headers.get('content-encoding')?.toLowerCase();
    const etag = response.headers.get('etag');
    const modified = response.headers.get('last-modified');
    const validator = etag && /^"[^"]*"$/.test(etag) ? { name: 'etag', value: etag } :
      modified && { name: 'last-modified', value: modified };
    const comparable = this.validator && response.headers.get(this.validator.name);
    const total = Number(match?.[3]);
    const actualEnd = Math.min(end, total - 1);
    const declaredLength = response.headers.get('content-length');
    const responseSize = actualEnd - start + 1;
    if (response.status !== 206 || !match || (encoding && encoding !== 'identity') || !Number.isSafeInteger(total) ||
      Number(match[1]) !== start || Number(match[2]) !== actualEnd || responseSize <= 0 ||
      (this.size !== undefined && this.size !== total) || (comparable && this.validator.value !== comparable) ||
      (declaredLength !== null && Number(declaredLength) !== responseSize)) {
      await response.body?.cancel().catch(() => {});
      throw unavailableRange();
    }
    const bytes = await readRangeBody(response.body, responseSize, this.signal);
    if (this.size === undefined) {
      this.size = total;
      this.mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    }
    this.validator ||= validator;
    this.pages.set(start, bytes);
    return bytes;
  }
}

function createTokenizer(file, api, name) {
  const { AbstractTokenizer, EndOfStreamError } = api;
  return new class extends AbstractTokenizer {
    constructor() {
      super({ abortSignal: file.signal, maxBufferSize: byteLimit });
      this.fileInfo = { size: file.size, mimeType: file.mimeType, path: name };
    }

    supportsRandomAccess() { return true; }

    setPosition(position) {
      this.validateLength(position, 'position');
      this.position = position;
    }

    async peekBuffer(buffer, options) {
      file.signal.throwIfAborted();
      const { length, position, mayBeLess } = this.normalizeOptions(buffer, options);
      this.validateBufferSize(length);
      const available = Math.max(0, Math.min(length, file.size - position));
      if (length !== available && !mayBeLess) throw new EndOfStreamError();
      for (let written = 0; written < available;) {
        const cursor = position + written;
        const pageStart = Math.floor(cursor / pageSize) * pageSize;
        const startInPage = cursor - pageStart;
        const page = await file.readPage(pageStart);
        const segment = page.subarray(startInPage, startInPage + available - written);
        buffer.set(segment, written);
        written += segment.length;
      }
      return available;
    }

    async readBuffer(buffer, options) {
      const normalized = this.normalizeOptions(buffer, options);
      const count = await this.peekBuffer(buffer, normalized);
      this.position = normalized.position + count;
      return count;
    }
  }();
}

function cleanTag(value, limit = 500) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, limit) : '';
}

function embeddedLyrics(tags) {
  for (const tag of tags || []) {
    if (tag?.timeStampFormat === 2 && Array.isArray(tag.syncText)) {
      const cues = tag.syncText.slice(0, 2000)
        .filter(line => Number.isFinite(line?.timestamp) && line.timestamp >= 0 && cleanTag(line.text))
        .map(line => ({ time: line.timestamp / 1000, text: cleanTag(line.text) }))
        .sort((a, b) => a.time - b.time);
      if (cues.length) return cues;
    }
    const raw = typeof tag === 'string' ? tag : tag?.text;
    if (typeof raw !== 'string') continue;
    const text = raw.slice(0, 48000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
    const cues = parseLyrics(text).slice(0, 2000);
    if (cues.length) return cues;
    if (text) return [{ time: null, text }];
  }
  return [];
}

function summarize(metadata) {
  const { common, format } = metadata;
  const result = {};
  for (const key of ['title', 'artist', 'album']) {
    const value = cleanTag(common[key]);
    if (value) result[key] = value;
  }
  if (!result.artist && Array.isArray(common.artists)) {
    const value = cleanTag(common.artists.slice(0, 20).map(name => cleanTag(name)).filter(Boolean).join(', '));
    if (value) result.artist = value;
  }
  const genres = normalizeGenres(common.genre);
  if (genres.length) result.genres = genres;
  const releaseYear = releaseYearTag(common);
  if (releaseYear) result.releaseYear = releaseYear;
  const albumArtist = albumArtistTag(common);
  if (albumArtist) result.albumArtist = albumArtist;
  if (Number.isFinite(format.duration) && format.duration > 0) result.duration = format.duration;
  const encoding = normalizeAudioEncoding(format);
  if (encoding) result.encoding = encoding;
  Object.assign(result, replayGainTags(common, metadata));
  const pictures = (common.picture || []).filter(picture => supportedImages.has(picture.format) &&
    picture.data?.length > 0 && picture.data.length <= imageLimit);
  const picture = pictures.find(item => item.type?.toLowerCase()?.includes('front')) || pictures[0];
  if (picture) result.cover = new Blob([picture.data], { type: picture.format });
  const lyrics = embeddedLyrics(common.lyrics);
  if (lyrics.length) result.lyrics = lyrics;
  return result;
}

// Read metadata through same-origin media endpoints without accepting full-file responses.
async function inspectRemoteMetadata(src, { name, signal, fetchImpl = (...args) => globalThis.fetch(...args) } = {}, skipCovers = false) {
  const endpoint = mediaEndpoint(src);
  if (!endpoint) throw new RemoteMetadataError('invalid-source', '仅支持读取应用内远程音源的标签。');
  const deadline = AbortSignal.timeout(15000);
  const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  probeSignal.throwIfAborted();
  const api = await import('./metadata.bundle.js');
  const file = new SparseRemoteFile(endpoint, probeSignal, fetchImpl);
  await file.readPage(0);
  const tokenizer = createTokenizer(file, api, cleanTag(name));
  try {
    // A forced duration scan can read the whole MPEG payload without improving tag extraction.
    return await api.parseFromTokenizer(tokenizer, {
      maxMemoryAllocation: byteLimit,
      maxMetadataEntries: 10000,
      skipCovers,
    });
  } catch (error) {
    if (error instanceof RemoteMetadataError || probeSignal.aborted) throw error;
    throw new RemoteMetadataError('unrecognized', '没有读到可用的远程音频标签。', { cause: error });
  } finally {
    await tokenizer.close();
  }
}

export async function inspectRemoteTrack(src, options) {
  return summarize(await inspectRemoteMetadata(src, options));
}

export async function inspectRemoteEncoding(src, options) {
  const { format } = await inspectRemoteMetadata(src, options, true);
  return normalizeAudioEncoding(format) ?? null;
}
