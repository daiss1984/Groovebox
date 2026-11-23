importScripts('/sw-build.js');
const cachePrefix = 'groovebox-shell-';
const cacheName = cachePrefix + self.grooveboxShell.revision;
const shell = new Set(self.grooveboxShell.urls);
const artworkCache = 'groovebox-album-artwork-v1';
const artworkMiB = 1024 * 1024;
const artworkBudget = { defaultMiB: 250, minMiB: 50, maxMiB: 2048 };
const albumCoverQuery = /^\?id=[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const artworkGeneration = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const artworkTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const artworkPaths = new Set(['/api/artwork/cover', '/api/artwork/artist-cover', '/api/metadata/artwork/image']);
const artworkMeasureHeader = 'X-Groovebox-Artwork-Measurement';
const artworkBytesHeader = 'X-Groovebox-Artwork-Bytes';
const artworkAccessHeader = 'X-Groovebox-Artwork-Access';
const artworkActions = new Set(['artwork-cache-policy', 'artwork-cache-configure', 'artwork-cache-clear', 'artwork-cache-resume']);
let artworkDatabase;
let artworkQueue = Promise.resolve();
let artworkAccess = 0;
const audioPrefixes = new Map();
const mediaStreamPath = /^\/api\/(?:sources\/[a-z0-9-]+|baidu|gdrive|onedrive|dropbox|box|pcloud|aliyundrive|drive123|drive115|guangya)\/stream$/i;
const streamType = /^(?:audio\/[\w.+-]+|application\/(?:ogg|octet-stream)|video\/mp4)$/i;

self.addEventListener('message', event => {
  if (artworkActions.has(event.data?.action)) {
    const port = event.ports[0];
    if (event.source?.id && port) {
      event.waitUntil(manageArtwork(event.data).then(
        value => port.postMessage({ ok: true, value }),
        error => port.postMessage({ ok: false, code: error instanceof RangeError ? 'invalid_budget' : 'storage_unavailable' }),
      ));
    }
    return;
  }
  const client = event.source?.id;
  const { action, src, bytes, size, type, validator } = event.data || {};
  if (action !== 'prepare-audio-prefix' || !client || typeof src !== 'string' || !src.startsWith('/api/') ||
      !(bytes instanceof ArrayBuffer) || bytes.byteLength !== 256 * 1024 || !Number.isSafeInteger(size) || size <= bytes.byteLength ||
      !streamType.test(type) || !/^"[^"\r\n]+"$/.test(validator)) return;
  const url = new URL(src, self.location.origin);
  if (url.origin !== self.location.origin || !mediaStreamPath.test(url.pathname)) return;
  url.search = url.searchParams.toString();
  audioPrefixes.delete(client);
  if (audioPrefixes.size >= 8) audioPrefixes.delete(audioPrefixes.keys().next().value);
  audioPrefixes.set(client, { url: url.href, bytes, size, type, validator, expires: Date.now() + 15000 });
  event.ports[0]?.postMessage(true);
});

async function networkAudio(request, url) {
  // Use the same response path for later ranges, even after the prefix was consumed.
  const response = await fetch(url, { signal: request.signal, cache: 'no-store', redirect: 'error',
    credentials: request.credentials, headers: request.headers });
  return new Response(response.body, { status: response.status, headers: response.headers });
}

async function playWithPrefix(request, prefix, discardPrefix) {
  const originalRange = request.headers.get('Range');
  const range = originalRange && /^bytes=(\d+)-(\d*)$/i.exec(originalRange);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), prefix.size - 1) : prefix.size - 1;
  const length = prefix.bytes.byteLength;
  if ((originalRange && !range) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end ||
      ['If-Match', 'If-Modified-Since', 'If-None-Match', 'If-Unmodified-Since'].some(name => request.headers.has(name)) ||
      (request.headers.has('If-Range') && request.headers.get('If-Range') !== prefix.validator) || start >= length) {
    return networkAudio(request, prefix.url);
  }

  const needsTail = end >= length;
  const offset = needsTail ? length : 0;
  const last = needsTail ? end : 0;
  let tail;
  try {
    const header = 'bytes=' + offset + '-' + last;
    tail = await fetch(prefix.url, { signal: request.signal, cache: 'no-store', redirect: 'error', credentials: request.credentials,
      headers: { Range: header, 'If-Range': prefix.validator } });
    if (tail.status !== 206 || !tail.body || tail.headers.get('ETag') !== prefix.validator ||
        tail.headers.get('Content-Range') !== 'bytes ' + offset + '-' + last + '/' + prefix.size ||
        tail.headers.get('Content-Type')?.split(';', 1)[0] !== prefix.type ||
        (tail.headers.has('Content-Encoding') && tail.headers.get('Content-Encoding') !== 'identity') ||
        Number(tail.headers.get('Content-Length')) !== last - offset + 1) throw new Error('Audio changed');
  } catch {
    void tail?.body?.cancel().catch(() => {});
    discardPrefix();
    return networkAudio(request, prefix.url);
  }
  let body = new Uint8Array(prefix.bytes, start, Math.min(length, end + 1) - start);
  if (needsTail) {
    discardPrefix();
    const reader = tail.body.getReader();
    let first = body;
    body = new ReadableStream({
      async pull(controller) {
        if (first) {
          controller.enqueue(first);
          first = undefined;
          return;
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: reason => reader.cancel(reason),
    });
  } else void tail.body.cancel().catch(() => {});
  const headers = new Headers({ 'Content-Type': prefix.type, 'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes', ETag: prefix.validator, 'Cache-Control': 'no-store' });
  if (range) headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + prefix.size);
  return new Response(body, { status: range ? 206 : 200, headers });
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll([...shell].map(path => new Request(path, {
      cache: 'reload', credentials: 'omit', redirect: 'error',
    })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const previous = (await caches.keys()).filter(name => name.startsWith(cachePrefix) && name !== cacheName);
    await Promise.all(previous.map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function permittedArtwork(url) {
  return url.origin === self.location.origin && artworkPaths.has(url.pathname) && albumCoverQuery.test(url.search);
}

function validArtworkBudget(limitMiB) {
  return Number.isInteger(limitMiB) && limitMiB >= artworkBudget.minMiB && limitMiB <= artworkBudget.maxMiB;
}

function openArtworkDatabase() {
  if (!artworkDatabase) {
    artworkDatabase = new Promise((resolve, reject) => {
      const request = indexedDB.open('groovebox-artwork-policy', 1);
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore('policy');
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Artwork policy is in use'));
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          artworkDatabase = undefined;
          db.close();
        };
        resolve(db);
      };
    }).catch(error => {
      artworkDatabase = undefined;
      throw error;
    });
  }
  return artworkDatabase;
}

async function artworkPolicy(update) {
  const db = await openArtworkDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('policy', 'readwrite');
    const store = tx.objectStore('policy');
    const request = store.get('active');
    let policy;
    tx.oncomplete = () => resolve(policy);
    tx.onabort = () => reject(tx.error || new Error('Artwork policy update failed'));
    request.onsuccess = () => {
      const previous = request.result;
      if (previous !== undefined &&
        (!previous || !artworkGeneration.test(previous.measurementKey) || !validArtworkBudget(previous.limitMiB) ||
          typeof previous.paused !== 'boolean' ||
          (previous.generation !== 'initial' && !artworkGeneration.test(previous.generation)))) {
        tx.abort();
        return;
      }
      policy = previous || { generation: 'initial', measurementKey: crypto.randomUUID(), limitMiB: artworkBudget.defaultMiB, paused: false };
      if (update) policy = update(policy);
      if (!previous || update) store.put(policy, 'active');
    };
  });
}

function serializeArtwork(task) {
  // An origin lock also coordinates workers during a shell update where the API is available.
  const run = () => self.navigator.locks ? self.navigator.locks.request(artworkCache, task) : task();
  const result = artworkQueue.then(run);
  artworkQueue = result.catch(() => {});
  return result;
}

function artworkCacheName(policy) {
  return policy.generation === 'initial' ? artworkCache : artworkCache + '-' + policy.generation;
}

async function deleteOldArtworkCaches() {
  const names = await caches.keys();
  const current = artworkCacheName(await artworkPolicy());
  await Promise.all(names.filter(name => name !== current && (name === artworkCache ||
    (name.startsWith(artworkCache + '-') && artworkGeneration.test(name.slice(artworkCache.length + 1)))))
    .map(name => caches.delete(name)));
}

function artworkResponse(response, body, measurement) {
  const headers = new Headers(response.headers);
  headers.delete(artworkMeasureHeader);
  headers.delete(artworkBytesHeader);
  headers.delete(artworkAccessHeader);
  headers.delete('Content-Encoding');
  if (measurement) {
    headers.set('Content-Length', String(measurement.bytes));
    headers.set(artworkMeasureHeader, measurement.key);
    headers.set(artworkBytesHeader, String(measurement.bytes));
    headers.set(artworkAccessHeader, String(measurement.access));
  }
  return new Response(body, { status: response.status, headers });
}

async function measureArtwork(response, limitBytes) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) {
      void reader.cancel().catch(() => {});
      return;
    }
    parts.push(value);
  }
  if (size) return new Blob(parts);
}

function knownArtworkMeasurement(response, policy) {
  const bytes = Number(response.headers.get(artworkBytesHeader));
  const access = Number(response.headers.get(artworkAccessHeader));
  if (response.headers.get(artworkMeasureHeader) === policy.measurementKey &&
    Number.isSafeInteger(bytes) && bytes > 0 && Number.isSafeInteger(access) && access > 0) return { bytes, access };
}

async function trimArtwork(cache, policy) {
  const entries = [];
  const limitBytes = policy.limitMiB * artworkMiB;
  let usedBytes = 0;
  let legacyAccess = 0;
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (!response) continue;
    if (!permittedArtwork(new URL(request.url)) || response.status !== 200 ||
      !artworkTypes.has(response.headers.get('Content-Type'))) {
      await cache.delete(request);
      continue;
    }
    let measurement = knownArtworkMeasurement(response, policy);
    if (!measurement) {
      // Legacy entries have no usage record. Preserve their Cache Storage insertion order.
      const body = await measureArtwork(response, limitBytes);
      if (!body) {
        await cache.delete(request);
        continue;
      }
      measurement = { bytes: body.size, access: ++legacyAccess };
      await cache.put(request, artworkResponse(response, body, { ...measurement, key: policy.measurementKey }));
    }
    const { bytes, access } = measurement;
    artworkAccess = Math.max(artworkAccess, access);
    entries.push({ request, bytes, access });
    usedBytes += bytes;
  }
  entries.sort((a, b) => a.access - b.access);
  let entryCount = entries.length;
  for (const { request, bytes } of entries) {
    if (usedBytes <= limitBytes) break;
    await cache.delete(request);
    usedBytes -= bytes;
    entryCount -= 1;
  }
  return { usedBytes, entryCount };
}

async function manageArtwork({ action, limitMiB }) {
  if (action === 'artwork-cache-configure' && !validArtworkBudget(limitMiB)) throw new RangeError('Invalid artwork budget');
  return serializeArtwork(async () => {
    let update;
    if (action === 'artwork-cache-configure') update = policy => ({ ...policy, limitMiB });
    if (action === 'artwork-cache-clear') {
      update = policy => ({ ...policy, generation: crypto.randomUUID(), paused: true });
    }
    if (action === 'artwork-cache-resume') update = policy => ({ ...policy, paused: false });
    const policy = await artworkPolicy(update);
    await deleteOldArtworkCaches();
    const usage = policy.paused
      ? { usedBytes: 0, entryCount: 0 }
      : await trimArtwork(await caches.open(artworkCacheName(policy)), policy);
    return { ...usage, limitMiB: policy.limitMiB, paused: policy.paused };
  });
}

function nextArtworkAccess() {
  artworkAccess = Math.max(Date.now(), artworkAccess + 1);
  return artworkAccess;
}

async function saveArtwork(request, response, body, started) {
  await serializeArtwork(async () => {
    const policy = await artworkPolicy();
    if (policy.paused || policy.generation !== started.generation || body.size > policy.limitMiB * artworkMiB) return;
    const cache = await caches.open(artworkCacheName(policy));
    const measurement = { key: policy.measurementKey, bytes: body.size, access: nextArtworkAccess() };
    await cache.put(request, artworkResponse(response, body, measurement));
    // Without Web Locks another worker can still change the durable budget during the write.
    const current = await artworkPolicy();
    if (current.generation !== policy.generation) {
      await caches.delete(artworkCacheName(policy));
      return;
    }
    await trimArtwork(cache, current);
  });
}

async function cachedArtwork(request) {
  return serializeArtwork(async () => {
    const policy = await artworkPolicy();
    if (policy.paused) return;
    const cache = await caches.open(artworkCacheName(policy));
    const response = await cache.match(request);
    if (response?.status !== 200 || !artworkTypes.has(response.headers.get('Content-Type'))) return;
    try {
      const known = knownArtworkMeasurement(response, policy);
      const body = known ? response.clone().body : await measureArtwork(response.clone(), policy.limitMiB * artworkMiB);
      if (body) {
        artworkAccess = Math.max(artworkAccess, known?.access || 0);
        const measurement = { key: policy.measurementKey, bytes: known?.bytes ?? body.size, access: nextArtworkAccess() };
        await cache.put(request, artworkResponse(response, body, measurement));
      }
    } catch {
      // A failed recency update does not prevent displaying an already cached image.
    }
    if ((await artworkPolicy()).generation === policy.generation) return artworkResponse(response, response.body);
  });
}

async function albumCover(request) {
  const started = await artworkPolicy().catch(() => undefined);
  let response;
  try {
    response = await fetch(request, { cache: 'no-store', redirect: 'error' });
  } catch {
    // An already displayed cover is available when the player is offline.
  }
  if (response?.status === 200 && artworkTypes.has(response.headers.get('Content-Type'))) {
    const stored = started && !started.paused
      ? measureArtwork(response.clone(), started.limitMiB * artworkMiB)
        .then(body => body && saveArtwork(request, response, body, started)).catch(() => {})
      : undefined;
    return { response, stored };
  }
  if (response && response.status !== 429 && response.status < 500) return { response };
  const cached = await cachedArtwork(request).catch(() => undefined);
  return { response: cached || response || Response.error() };
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.destination === 'audio' && mediaStreamPath.test(url.pathname) && url.searchParams.get('_groovebox_prefix') === '1') {
    url.searchParams.delete('_groovebox_prefix');
    const prefix = audioPrefixes.get(event.clientId);
    const discardPrefix = () => {
      if (audioPrefixes.get(event.clientId) === prefix) audioPrefixes.delete(event.clientId);
    };
    if (prefix && prefix.expires < Date.now()) discardPrefix();
    if (prefix?.url === url.href && prefix.expires >= Date.now()) event.respondWith(playWithPrefix(request, prefix, discardPrefix));
    else event.respondWith(networkAudio(request, url.href));
    return;
  }
  if (request.headers.has('Range')) return;
  if (permittedArtwork(url)) {
    const cover = albumCover(request);
    event.respondWith(cover.then(result => result.response));
    event.waitUntil(cover.then(result => result.stored));
    return;
  }
  if (url.search || !shell.has(url.pathname)) return;
  event.respondWith((async () => {
    let network;
    try {
      network = await fetch(request);
      if (network.status < 500) return network;
    } catch {
      // The installed shell lets local audio and IndexedDB downloads work without a connection.
    }
    const cached = await caches.match(url.pathname, { cacheName }).catch(() => undefined);
    return cached || network || Response.error();
  })());
});
