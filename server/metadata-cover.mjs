import { imageSignature } from './artwork.mjs';

const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const maxImageBytes = 2 * 1024 * 1024;

export class MetadataCoverError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const invalidLookup = () => new MetadataCoverError(400, 'metadata_invalid_lookup', 'Provide a valid artist or album name for this cover lookup.');
const unavailable = () => new MetadataCoverError(502, 'metadata_unavailable', 'The configured cover service returned an unavailable response.');

function metadataText(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidLookup();
  }
  return value.trim();
}

function coverParameters(input) {
  const artist = metadataText(input?.artist);
  const album = metadataText(input?.album);
  const scope = input?.scope;
  if (scope === 'artist' && artist) return new URLSearchParams({ artist, sourceType: 'api' });
  if (scope === 'album' && album) {
    return new URLSearchParams({ album, ...(artist && { artist }), sourceType: 'api' });
  }
  throw invalidLookup();
}

function retryDelay(value) {
  const seconds = /^\d+$/.test(value ?? '') ? Number(value) : value ? Math.ceil((Date.parse(value) - Date.now()) / 1000) : NaN;
  return Math.min(3600, Math.max(1, Number.isNaN(seconds) ? 60 : seconds));
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* The fetch can already have been aborted. */ }
}

async function readRaster(response, contentType) {
  if (!imageTypes.has(contentType) || !response.body ||
      Number(response.headers.get('content-length')) > maxImageBytes) {
    await discard(response);
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxImageBytes) {
        await reader.cancel();
        throw unavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  if (!imageSignature(bytes, contentType)) throw unavailable();
  return bytes;
}

// config is selected and authorized by the server before querying this fixed endpoint.
export async function queryMetadataCover(config, input, { signal, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const params = coverParameters(input);
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    requestSignal.throwIfAborted();
    const target = new URL(config.url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
      throw unavailable();
    }
    target.search = params.toString();
    const headers = new Headers(config.headers);
    headers.set('Accept', '*/*');
    headers.set('User-Agent', 'Groovebox/1.0.0');
    const response = await fetchImpl(target, {
      method: 'GET', headers, redirect: 'error', credentials: 'omit', signal: requestSignal,
    });
    if (response.redirected || response.status !== 200) {
      await discard(response);
      if (!response.redirected && response.status === 404) {
        throw new MetadataCoverError(404, 'metadata_not_found', 'The configured service found no matching cover.');
      }
      if (!response.redirected && response.status === 429) {
        throw new MetadataCoverError(429, 'metadata_rate_limited', 'The configured cover service is rate limiting requests.',
          retryDelay(response.headers.get('retry-after')));
      }
      throw unavailable();
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    const bytes = await readRaster(response, contentType);
    requestSignal.throwIfAborted();
    return { bytes, contentType };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('The cover request was canceled.', 'AbortError');
    if (deadline.aborted) throw new MetadataCoverError(504, 'metadata_timeout', 'The configured cover service did not respond in time.');
    throw error instanceof MetadataCoverError ? error : unavailable();
  }
}
