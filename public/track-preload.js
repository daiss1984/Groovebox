import { validCloudTrack } from './playlist-sync.js';

const byteLimit = 8 * 1024 * 1024;
const prefixLimit = 256 * 1024;
const mimeType = /^(?:audio\/[\w.+-]+|application\/(?:ogg|octet-stream)|video\/mp4)$/i;

function resourceValidator(response) {
  const etag = response.headers.get('etag');
  return etag && !etag.startsWith('W/') ? etag : response.headers.get('last-modified');
}

async function readBytes(response, expected) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const bytes = new Uint8Array(expected);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return offset === expected ? bytes : undefined;
      if (offset + value.byteLength > expected) return;
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

async function loadTrack(src, fetchImpl, signal, allowPrefix) {
  const load = (range, validator) => fetchImpl(src, { signal, cache: 'no-store', redirect: 'error', priority: 'low',
    headers: { Range: range, ...(validator && { 'If-Range': validator }) } });
  const probe = await load('bytes=0-0');
  const range = /^bytes 0-0\/(\d+)$/i.exec(probe.headers.get('content-range') || '');
  const size = Number(range?.[1]);
  const type = probe.headers.get('content-type')?.split(';', 1)[0];
  const validator = resourceValidator(probe);
  void probe.body?.cancel().catch(() => {});
  if (probe.status !== 206 || !Number.isSafeInteger(size) || size < 2 || !mimeType.test(type)) return;
  const partial = size > byteLimit;
  if (partial && (!allowPrefix || !/^"[^"\r\n]+"$/.test(validator))) return;
  const length = partial ? prefixLimit : size;
  const response = await load('bytes=0-' + (length - 1), validator);
  const actualType = response.headers.get('content-type')?.split(';', 1)[0];
  if (response.status !== 206 || response.headers.get('content-range') !== 'bytes 0-' + (length - 1) + '/' + size ||
      actualType !== type || (validator && resourceValidator(response) !== validator)) {
    void response.body?.cancel().catch(() => {});
    return;
  }
  const bytes = await readBytes(response, length);
  if (bytes) return partial ? { bytes: bytes.buffer, size, type, validator } : new Blob([bytes], { type });
}

async function activatePrefix(worker, src, prefix) {
  const channel = new MessageChannel();
  let timeout;
  try {
    const accepted = await new Promise(resolve => {
      timeout = setTimeout(resolve, 150);
      channel.port1.onmessage = event => resolve(event.data === true);
      worker.postMessage({ action: 'prepare-audio-prefix', src, ...prefix }, [prefix.bytes, channel.port2]);
    });
    if (accepted) return src + (src.includes('?') ? '&' : '?') + '_groovebox_prefix=1';
  } catch {
    // The usual stream endpoint is used when the worker is unavailable.
  } finally {
    clearTimeout(timeout);
    channel.port1.close();
  }
  return src;
}

export function createTrackPreloader({ fetchImpl = (...args) => fetch(...args), available = () => true,
  worker = () => globalThis.navigator?.serviceWorker?.controller } = {}) {
  let pending;
  const keyFor = track => track && validCloudTrack(track) && available(track) ? track.src : undefined;
  function clear() {
    pending?.controller.abort();
    pending = undefined;
  }
  return {
    clear,
    prepare(track) {
      const key = keyFor(track);
      if (!key || key !== pending?.key) clear();
      if (!key || pending) return;
      const job = pending = { key, controller: new AbortController() };
      const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(15_000)]);
      void loadTrack(key, fetchImpl, signal, Boolean(worker())).then(media => { job.media = media; }).catch(() => {});
    },
    take(track) {
      const src = keyFor(track);
      const media = pending?.key === src ? pending?.media : undefined;
      clear();
      if (!media || media instanceof Blob) return media;
      const active = worker();
      if (active) return activatePrefix(active, src, media);
    },
  };
}
