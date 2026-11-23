import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readLocalSettings, writeLocalSettings } from './local-settings.mjs';
import { MetadataCoverError, queryMetadataCover } from './metadata-cover.mjs';

const base = '/api/metadata/artwork/';
const methods = new Map([['status', ['GET']], ['config', ['GET', 'PUT']], ['cover', ['POST']], ['image', ['GET']]]);
const adapters = new Set(['none', 'hisatri']);
const headerActions = new Set(['keep', 'replace', 'remove']);
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const forwardingHeaders = /^(?:forwarded|via|x-forwarded-.+|x-real-ip)$/i;
const headerName = /^(?:authorization|authentication|x-[a-z0-9][a-z0-9-]{0,59})$/i;
const blockedHeaders = /^x-(?:forwarded-.+|real-ip|http-method(?:-override)?|rewrite-url|original-.+|host|url-scheme|remote-.+|user-agent)$/i;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const initialConfig = Object.freeze({ adapter: 'none', url: '', headers: [], revision: 'none', album: false, artist: false });
const maxImages = 128;
const maxCacheBytes = 32 * 1024 * 1024;
const imageAge = 30 * 60_000;
const decoder = new TextDecoder('utf-8', { fatal: true });

const invalidConfig = message => new MetadataCoverError(400, 'metadata_invalid_config', message);
const invalidLookup = () => new MetadataCoverError(400, 'metadata_invalid_lookup', 'Provide a valid artist or album name for this cover lookup.');
const configChanged = () => new MetadataCoverError(409, 'metadata_config_changed', 'The cover API settings changed. Reload the settings and try again.');
const configUnavailable = () => new MetadataCoverError(503, 'metadata_config_unavailable', 'The saved cover API settings could not be read. Save valid local settings to continue.');

const responseHeaders = {
  'Cache-Control': 'private, no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

function send(res, status, data, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { ...responseHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(data));
}

function checkOrigin(req, { local = false, required = true } = {}) {
  const host = req.headers.host ?? '';
  if (local && (!loopback.has(req.socket.remoteAddress) || !localHost.test(host) ||
      Object.keys(req.headers).some(name => forwardingHeaders.test(name)))) {
    throw new MetadataCoverError(403, 'metadata_local_config_only', 'Cover API configuration is only available directly on the Groovebox host.');
  }
  const supplied = req.headers.origin;
  let matching = host && !required && supplied === undefined;
  try {
    if (local) {
      matching ||= supplied === new URL((req.socket.encrypted ? 'https://' : 'http://') + host).origin;
    } else if (supplied !== undefined) {
      const origin = new URL(supplied);
      matching = ['http:', 'https:'].includes(origin.protocol) && origin.origin === supplied && origin.host === host.toLowerCase();
    }
  } catch {
    matching = false;
  }
  const site = req.headers['sec-fetch-site'];
  if (!matching || (site && site !== 'same-origin' && site !== 'none')) {
    throw new MetadataCoverError(403, 'metadata_origin_required', 'Use the Groovebox page on the same origin.');
  }
}

async function readInput(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new MetadataCoverError(415, 'metadata_json_required', 'Send an application/json request.');
  }
  const limit = 12_000;
  const tooLarge = () => new MetadataCoverError(413, 'metadata_input_too_large', 'The cover API request is too large.');
  if (Number(req.headers['content-length']) > limit) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw tooLarge();
    chunks.push(chunk);
  }
  try { return JSON.parse(decoder.decode(Buffer.concat(chunks, size))); }
  catch { throw new MetadataCoverError(400, 'metadata_invalid_json', 'The cover API request is invalid JSON.'); }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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
  if (url.href.length > 2000) throw invalidConfig('The cover API endpoint is too long.');
  return url;
}

function checkedHeaders(pairs) {
  if (!Array.isArray(pairs) || pairs.length > 12) throw invalidConfig('Use at most twelve cover API request headers.');
  const headers = new Map();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string')) {
      throw invalidConfig('Set request headers as key=value pairs separated by ampersands.');
    }
    const [key, value] = pair;
    const name = key.trim().toLowerCase();
    if (!/^[\x20-\x7e]+$/.test(key) || !headerName.test(name) || blockedHeaders.test(name) || headers.has(name) ||
        !/^[\x20-\x7e]{1,1000}$/.test(value) || !value.trim()) {
      throw invalidConfig('Use unique Authorization, Authentication or approved X- headers and valid values.');
    }
    headers.set(name, value.trim());
  }
  return [...headers].sort(([a], [b]) => a.localeCompare(b));
}

function configForInput(body, previous) {
  const input = body?.artwork;
  if (!object(body) || !object(input) || !adapters.has(input.adapter) || !headerActions.has(input.headersAction) ||
      typeof input.album !== 'boolean' || typeof input.artist !== 'boolean' || Object.keys(body).some(key => key !== 'artwork') ||
      Object.keys(input).some(key => !['adapter', 'url', 'album', 'artist', 'headersAction', 'headers'].includes(key))) {
    throw invalidConfig('Choose a cover adapter, scopes and header action.');
  }
  if (input.adapter === 'none') return initialConfig;
  const url = endpoint(input.url);
  let headers = [];
  if (input.headersAction === 'keep' && previous.url && url.origin === new URL(previous.url).origin) headers = previous.headers;
  if (input.headersAction === 'replace') {
    if (typeof input.headers !== 'string' || !input.headers || input.headers.length > 4096) {
      throw invalidConfig('Set request headers as key=value pairs separated by ampersands.');
    }
    headers = checkedHeaders(input.headers.split('&').map(pair => {
      const delimiter = pair.indexOf('=');
      return delimiter <= 0 ? [] : [pair.slice(0, delimiter), pair.slice(delimiter + 1)];
    }));
  }
  return { adapter: input.adapter, url: url.href, headers, album: input.album, artist: input.artist };
}

function restoreConfig(file) {
  if (!file) return initialConfig;
  const saved = readLocalSettings(file);
  if (saved === null && !existsSync(file)) return initialConfig;
  if (!object(saved) || typeof saved.revision !== 'string' || !uuid.test(saved.revision) || !adapters.has(saved.adapter) ||
      typeof saved.album !== 'boolean' || typeof saved.artist !== 'boolean') throw configUnavailable();
  const headers = checkedHeaders(saved.headers);
  if (saved.adapter === 'none') {
    if (saved.url !== '' || headers.length || saved.album || saved.artist) throw configUnavailable();
    return { ...initialConfig, revision: saved.revision };
  }
  return { adapter: saved.adapter, url: endpoint(saved.url).href, headers, revision: saved.revision, album: saved.album, artist: saved.artist };
}

function normalizeLookup(body) {
  if (!object(body) || !['album', 'artist'].includes(body.scope) ||
      Object.keys(body).some(key => !['scope', 'album', 'artist'].includes(key))) throw invalidLookup();
  const [album, artist] = ['album', 'artist'].map(key => {
    const value = body[key];
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalidLookup();
    return value.trim().normalize('NFC');
  });
  if (body.scope === 'artist' && artist) return { scope: 'artist', artist, album: '' };
  if (body.scope === 'album' && album) return { scope: 'album', artist, album };
  throw invalidLookup();
}

export function createMetadataArtworkHandler({ dataDir, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const file = dataDir && join(dataDir, 'metadata-artwork-settings.bin');
  let config = initialConfig;
  let configurationError = false;
  try { config = restoreConfig(file); }
  catch { configurationError = true; }
  let generation = new AbortController();
  const images = new Map();
  const requestIds = new Map();
  let cacheBytes = 0;

  function getImage(id) {
    const image = images.get(id);
    if (!image) return;
    if (image.expiresAt <= Date.now()) {
      removeImage(id);
      return;
    }
    images.delete(id);
    images.set(id, image);
    return image;
  }

  function removeImage(id) {
    const image = images.get(id);
    requestIds.delete(image.key);
    cacheBytes -= image.bytes.length;
    images.delete(id);
  }

  function cacheImage(key, raster) {
    const existingId = requestIds.get(key);
    if (getImage(existingId)) return existingId;
    while (images.size >= maxImages || cacheBytes + raster.bytes.length > maxCacheBytes) {
      removeImage(images.keys().next().value);
    }
    const id = randomUUID();
    images.set(id, { ...raster, key, expiresAt: Date.now() + imageAge });
    requestIds.set(key, id);
    cacheBytes += raster.bytes.length;
    return id;
  }

  function status() {
    if (configurationError) throw configUnavailable();
    const { adapter, revision, album, artist } = config;
    return { configured: adapter !== 'none', artwork: { adapter, revision, album, artist } };
  }

  async function cover(req, res) {
    checkOrigin(req);
    if (configurationError) throw configUnavailable();
    const input = normalizeLookup(await readInput(req));
    const selected = config;
    const revisionSignal = generation.signal;
    const expected = req.headers['x-metadata-revision'];
    if (expected !== undefined && expected !== selected.revision) throw configChanged();
    if (selected.adapter === 'none') throw new MetadataCoverError(404, 'metadata_not_configured', 'No custom cover API is configured.');
    if (!selected[input.scope]) throw new MetadataCoverError(404, 'metadata_scope_disabled', 'This type of custom cover lookup is disabled.');
    const cacheKey = JSON.stringify([selected.revision, input.scope, input.artist, input.album]);
    const sendCover = id => send(res, 200, { cover: base + 'image?id=' + id, adapter: selected.adapter, revision: selected.revision, scope: input.scope });
    const hit = requestIds.get(cacheKey);
    if (getImage(hit)) return sendCover(hit);

    const client = new AbortController();
    const disconnect = () => client.abort();
    res.once('close', disconnect);
    if (res.destroyed || req.aborted) disconnect();
    const signal = AbortSignal.any([revisionSignal, client.signal]);
    try {
      const raster = await queryMetadataCover(selected, input, { fetchImpl, timeoutMs, signal });
      signal.throwIfAborted();
      sendCover(cacheImage(cacheKey, raster));
    } catch (error) {
      if (client.signal.aborted) return;
      if (revisionSignal.aborted) throw configChanged();
      throw error;
    } finally {
      res.removeListener('close', disconnect);
    }
  }

  function image(req, res, url) {
    checkOrigin(req, { required: false });
    const id = url.searchParams.get('id');
    const cached = id && uuid.test(id) && getImage(id);
    if (!cached) throw new MetadataCoverError(404, 'metadata_image_not_found', 'This cached cover is no longer available.');
    res.writeHead(200, { ...responseHeaders, 'Content-Type': cached.contentType, 'Content-Length': cached.bytes.length }).end(cached.bytes);
  }

  return async function metadataArtwork(req, res, url) {
    if (!url.pathname.startsWith(base)) return false;
    const action = url.pathname.slice(base.length);
    const allowed = methods.get(action);
    if (!allowed) return false;
    try {
      if (!allowed.includes(req.method)) {
        send(res, 405, { error: 'Unsupported cover API method.', code: 'metadata_method' }, { Allow: allowed.join(', ') });
      } else if (action === 'status') {
        send(res, 200, status());
      } else if (action === 'cover') {
        await cover(req, res);
      } else if (action === 'image') {
        image(req, res, url);
      } else {
        checkOrigin(req, { local: true, required: req.method === 'PUT' });
        if (req.method === 'GET') {
          const { adapter, url, headers, album, artist } = config;
          send(res, 200, { ...(configurationError && { configurationError }), artwork: { adapter, url, hasHeaders: headers.length > 0, album, artist } });
        } else {
          if (!file) throw new MetadataCoverError(403, 'metadata_config_read_only', 'This installation cannot save cover API configuration.');
          const next = configForInput(await readInput(req), config);
          if (configurationError || next.adapter !== config.adapter || next.url !== config.url ||
              next.album !== config.album || next.artist !== config.artist || JSON.stringify(next.headers) !== JSON.stringify(config.headers)) {
            const updated = { ...next, revision: randomUUID() };
            writeLocalSettings(file, updated);
            config = updated;
            configurationError = false;
            generation.abort();
            generation = new AbortController();
            images.clear();
            requestIds.clear();
            cacheBytes = 0;
          }
          send(res, 200, status());
        }
      }
    } catch (error) {
      const failure = error instanceof MetadataCoverError ? error :
        new MetadataCoverError(500, 'metadata_config_unavailable', 'Could not read or save the cover API settings.');
      const { retryAfter } = failure;
      send(res, failure.status, { error: failure.message, code: failure.code, ...(retryAfter && { retryAfter }) },
        retryAfter ? { 'Retry-After': String(retryAfter) } : {});
    }
    return true;
  };
}
