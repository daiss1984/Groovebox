import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readLocalSettings, writeLocalSettings } from './local-settings.mjs';

const methods = new Map([
  ['/api/metadata/status', ['GET']],
  ['/api/metadata/config', ['GET', 'PUT']],
  ['/api/metadata/lyrics', ['POST']],
]);
const adapters = new Set(['none', 'lrclib', 'hisatri']);
const headerActions = new Set(['keep', 'replace', 'remove']);
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const blockedHeaders = /^(?:x-(?:forwarded-.+|real-ip|http-method(?:-override)?|rewrite-url|original-.+|host|url-scheme|remote-.+|user-agent))$/i;
const forwardingHeaders = /^(?:forwarded|via|x-forwarded-.+|x-real-ip)$/i;
const headerName = /^(?:authorization|authentication|lrclib-(?:api-key|app-id)|x-[a-z0-9][a-z0-9-]{0,59})$/i;
const maxResponse = 256_000;
const decoder = new TextDecoder('utf-8', { fatal: true });
const initialConfig = Object.freeze({ adapter: 'none', url: '', headers: [], revision: 'none' });

class MetadataError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function invalidConfig(message) {
  return new MetadataError(400, 'metadata_invalid_config', message);
}

function invalidMetadata() {
  return new MetadataError(400, 'metadata_invalid_lookup', 'Provide a song title and valid artist, album and duration values.');
}

function unavailable() {
  return new MetadataError(502, 'metadata_unavailable', 'The configured lyrics service returned an unavailable response.');
}

function configChanged() {
  return new MetadataError(409, 'metadata_config_changed', 'The custom lyrics service changed. Reload its settings and try again.');
}

function configUnavailable() {
  return new MetadataError(503, 'metadata_config_unavailable', 'The saved lyric API settings could not be read. Open local settings and save a valid configuration.');
}

function send(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  }).end(JSON.stringify(body));
}

function checkOrigin(req, { local = false, required = true } = {}) {
  const host = req.headers.host ?? '';
  if (local && (!loopback.has(req.socket.remoteAddress) || !localHost.test(host) ||
      Object.keys(req.headers).some(name => forwardingHeaders.test(name)))) {
    throw new MetadataError(403, 'metadata_local_config_only', 'Metadata API configuration is only available directly on the Groovebox host.');
  }
  const supplied = req.headers.origin;
  let matchingOrigin = !required && supplied === undefined;
  try {
    if (local) {
      const directOrigin = new URL((req.socket.encrypted ? 'https://' : 'http://') + host).origin;
      matchingOrigin ||= supplied === directOrigin;
    } else {
      const origin = new URL(supplied);
      matchingOrigin = ['http:', 'https:'].includes(origin.protocol) && origin.origin === supplied && origin.host === host.toLowerCase();
    }
  } catch {
    matchingOrigin = false;
  }
  const site = req.headers['sec-fetch-site'];
  if (!matchingOrigin || (site && site !== 'same-origin' && site !== 'none')) {
    throw new MetadataError(403, 'metadata_origin_required', 'Use the Groovebox page on the same origin.');
  }
}

async function readInput(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new MetadataError(415, 'metadata_json_required', 'Send an application/json request.');
  }
  const tooLarge = () => new MetadataError(413, 'metadata_input_too_large', 'The metadata request is too large.');
  if (Number(req.headers['content-length']) > 12_000) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 12_000) throw tooLarge();
    chunks.push(chunk);
  }
  try { return JSON.parse(decoder.decode(Buffer.concat(chunks, size))); }
  catch { throw new MetadataError(400, 'metadata_invalid_json', 'The metadata request is invalid JSON.'); }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\s\u0000-\u001f\u007f?#\\]/u.test(value.trim())) {
    throw invalidConfig('Enter a complete HTTP or HTTPS endpoint without a query or fragment.');
  }
  let url;
  try { url = new URL(value.trim()); }
  catch { throw invalidConfig('Enter a valid HTTP or HTTPS endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/^https?:\/\/[^/]/i.test(value.trim())) {
    throw invalidConfig('The endpoint must use HTTP or HTTPS without credentials in the address.');
  }
  if (url.href.length > 2000) throw invalidConfig('The lyric API endpoint is too long.');
  return url;
}

function checkedHeaders(pairs) {
  if (!Array.isArray(pairs) || pairs.length > 12) throw invalidConfig('Use at most twelve metadata request headers.');
  const headers = new Map();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string')) {
      throw invalidConfig('Set request headers as key=value pairs separated by ampersands.');
    }
    const [key, value] = pair;
    const name = key.trim().toLowerCase();
    if (!/^[\x20-\x7e]+$/.test(key) || !headerName.test(name) || blockedHeaders.test(name) || headers.has(name) ||
        !/^[\x20-\x7e]{1,1000}$/.test(value) || !value.trim()) {
      throw invalidConfig('Use unique Authorization, Authentication, LRCLIB credentials or approved X- headers and valid values.');
    }
    headers.set(name, value.trim());
  }
  return [...headers].sort(([a], [b]) => a.localeCompare(b));
}

function normalizeConfig(body, previous) {
  const input = body?.lyrics;
  if (!object(body) || !object(input) || !adapters.has(input.adapter) || !headerActions.has(input.headersAction) ||
      Object.keys(body).some(key => key !== 'lyrics') ||
      Object.keys(input).some(key => !['adapter', 'url', 'headersAction', 'headers'].includes(key))) {
    throw invalidConfig('Choose a lyrics adapter and header action.');
  }
  if (input.adapter === 'none') return { adapter: 'none', url: '', headers: [] };
  const target = endpoint(input.url);
  let headers = [];
  if (input.headersAction === 'keep' && previous.url && target.origin === new URL(previous.url).origin) {
    headers = previous.headers;
  }
  if (input.headersAction === 'replace') {
    if (typeof input.headers !== 'string' || !input.headers || input.headers.length > 4096) {
      throw invalidConfig('Set request headers as key=value pairs separated by ampersands.');
    }
    headers = checkedHeaders(input.headers.split('&').map(pair => {
      const delimiter = pair.indexOf('=');
      return delimiter <= 0 ? [] : [pair.slice(0, delimiter), pair.slice(delimiter + 1)];
    }));
  }
  return { adapter: input.adapter, url: target.href, headers };
}

function restoreConfig(file) {
  if (!file) return initialConfig;
  const saved = readLocalSettings(file);
  if (saved === null && !existsSync(file)) return initialConfig;
  if (!object(saved) || typeof saved.revision !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(saved.revision) ||
      !adapters.has(saved.adapter)) throw configUnavailable();
  const headers = checkedHeaders(saved.headers);
  if (saved.adapter === 'none') {
    if (saved.url !== '' || headers.length) throw configUnavailable();
    return { ...initialConfig, revision: saved.revision };
  }
  return { adapter: saved.adapter, url: endpoint(saved.url).href, headers, revision: saved.revision };
}

function normalizeLookup(body, adapter) {
  if (!object(body) || Object.keys(body).some(key => !['title', 'artist', 'album', 'duration'].includes(key))) {
    throw invalidMetadata();
  }
  const strings = ['title', 'artist', 'album'].map(key => {
    const value = body[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalidMetadata();
    return value.trim();
  });
  const [title, artist, album] = strings;
  if (!title || (adapter === 'lrclib' && !artist) ||
      (body.duration != null && (!Number.isFinite(body.duration) || body.duration < 0))) throw invalidMetadata();
  const duration = Math.round(body.duration ?? 0);
  return { title, artist, album, duration: duration > 0 && duration <= 3600 ? duration : undefined };
}

function lyricsTarget(config, { title, artist, album, duration }) {
  const url = new URL(config.url);
  if (config.adapter === 'lrclib') {
    url.searchParams.set('track_name', title);
    url.searchParams.set('artist_name', artist);
    if (album) url.searchParams.set('album_name', album);
    if (duration) url.searchParams.set('duration', String(duration));
  } else {
    url.searchParams.set('title', title);
    if (artist) url.searchParams.set('artist', artist);
    if (album) url.searchParams.set('album', album);
  }
  return url;
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* The request can already be aborted. */ }
}

async function readLyrics(response) {
  if (!response.body || Number(response.headers.get('content-length')) > maxResponse) {
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
      if (size > maxResponse) {
        await reader.cancel();
        throw unavailable();
      }
      chunks.push(value);
    }
    return decoder.decode(Buffer.concat(chunks, size));
  } finally {
    reader.releaseLock();
  }
}

function lyricText(value) {
  return typeof value === 'string' && value.trim() && value.length <= 100_000 ? value : null;
}

function normalizedLyrics(body, adapter) {
  if (adapter === 'hisatri') {
    const syncedLyrics = lyricText(body);
    if (!syncedLyrics || !/^\s*\[\d+:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(syncedLyrics)) throw unavailable();
    return { instrumental: false, syncedLyrics, plainLyrics: null };
  }
  const item = JSON.parse(body);
  if (!object(item)) throw unavailable();
  const instrumental = item.instrumental === true;
  const syncedLyrics = lyricText(item.syncedLyrics);
  const plainLyrics = lyricText(item.plainLyrics);
  if (!instrumental && !syncedLyrics && !plainLyrics) throw unavailable();
  return { instrumental, syncedLyrics, plainLyrics };
}

function retryDelay(value) {
  const delay = /^\d+$/.test(value ?? '') ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Math.min(3600, Math.max(1, Number.isNaN(delay) ? 60 : delay));
}

async function queryLyrics(fetchImpl, config, info, signal) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Groovebox/1.0.0', ...Object.fromEntries(config.headers) };
  const response = await fetchImpl(lyricsTarget(config, info), { headers, redirect: 'error', signal });
  if (!response.ok) {
    await discard(response);
    if (response.status === 404) throw new MetadataError(404, 'metadata_not_found', 'The configured service found no matching lyrics.');
    if (response.status === 429) {
      throw new MetadataError(429, 'metadata_rate_limited', 'The configured lyrics service is rate limiting requests.',
        retryDelay(response.headers.get('retry-after')));
    }
    throw unavailable();
  }
  const type = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  const valid = config.adapter === 'lrclib' ? type === 'application/json' || type.endsWith('+json') : type === 'text/plain';
  if (!valid) {
    await discard(response);
    throw unavailable();
  }
  return normalizedLyrics(await readLyrics(response), config.adapter);
}

export function createMetadataHandler({ dataDir, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const file = dataDir && join(dataDir, 'metadata-settings.bin');
  let config = initialConfig;
  let configurationError = false;
  try { config = restoreConfig(file); }
  catch { configurationError = true; }
  let generation = new AbortController();
  function status() {
    if (configurationError) throw configUnavailable();
    return { configured: config.adapter !== 'none', lyrics: { adapter: config.adapter, revision: config.revision } };
  }

  async function lookup(req, res) {
    checkOrigin(req);
    if (configurationError) throw configUnavailable();
    const input = await readInput(req);
    const selected = config;
    const revisionSignal = generation.signal;
    const expectedRevision = req.headers['x-metadata-revision'];
    if (expectedRevision !== undefined && expectedRevision !== selected.revision) throw configChanged();
    if (selected.adapter === 'none') {
      throw new MetadataError(404, 'metadata_not_configured', 'No custom lyrics service is configured.');
    }
    const info = normalizeLookup(input, selected.adapter);
    const deadline = AbortSignal.timeout(timeoutMs);
    const client = new AbortController();
    const disconnect = () => client.abort();
    res.once('close', disconnect);
    if (res.destroyed || req.aborted) disconnect();
    const signal = AbortSignal.any([client.signal, deadline, revisionSignal]);
    try {
      signal.throwIfAborted();
      const lyrics = await queryLyrics(fetchImpl, selected, info, signal);
      signal.throwIfAborted();
      send(res, 200, { adapter: selected.adapter, revision: selected.revision, ...lyrics });
    } catch (error) {
      if (client.signal.aborted) return;
      if (revisionSignal.aborted) throw configChanged();
      if (deadline.aborted) throw new MetadataError(504, 'metadata_timeout', 'The configured lyrics service did not respond in time.');
      throw error instanceof MetadataError ? error : unavailable();
    } finally {
      res.removeListener('close', disconnect);
    }
  }

  return async function metadata(req, res, url) {
    const allowed = methods.get(url.pathname);
    if (!allowed) return false;
    try {
      if (!allowed.includes(req.method)) {
        send(res, 405, { error: 'Unsupported metadata request method.', code: 'metadata_method' }, { Allow: allowed.join(', ') });
      } else if (url.pathname === '/api/metadata/status') {
        send(res, 200, status());
      } else if (url.pathname === '/api/metadata/lyrics') {
        await lookup(req, res);
      } else {
        checkOrigin(req, { local: true, required: req.method === 'PUT' });
        if (req.method === 'GET') {
          send(res, 200, { ...(configurationError && { configurationError }),
            lyrics: { adapter: config.adapter, url: config.url, hasHeaders: config.headers.length > 0 } });
        } else {
          if (!file) throw new MetadataError(403, 'metadata_config_read_only', 'This installation cannot save metadata configuration.');
          const input = await readInput(req);
          const next = normalizeConfig(input, config);
          if (configurationError || next.adapter !== config.adapter || next.url !== config.url ||
              JSON.stringify(next.headers) !== JSON.stringify(config.headers)) {
            const updated = { ...next, revision: randomUUID() };
            writeLocalSettings(file, updated);
            config = updated;
            configurationError = false;
            generation.abort();
            generation = new AbortController();
          }
          send(res, 200, status());
        }
      }
    } catch (error) {
      const failure = error instanceof MetadataError ? error :
        new MetadataError(500, 'metadata_config_unavailable', 'Could not save metadata configuration. Check the Groovebox data directory.');
      const { retryAfter } = failure;
      send(res, failure.status, { error: failure.message, code: failure.code, ...(retryAfter && { retryAfter }) },
        retryAfter ? { 'Retry-After': String(retryAfter) } : {});
    }
    return true;
  };
}
