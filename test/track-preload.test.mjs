import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrackPreloader } from '../public/track-preload.js';

const track = id => ({ id, title: id, src: '/api/baidu/stream?id=' + id });
const flush = () => new Promise(resolve => setImmediate(resolve));
const audioResponse = (bytes, end, size, etag = '"v1"', type = 'audio/ogg') => new Response(new Uint8Array(bytes), { status: 206,
  headers: { 'Content-Range': 'bytes 0-' + end + '/' + size, 'Content-Type': type, ETag: etag } });

test('keeps a complete validated track once and rejects oversized and changed resources', async () => {
  const calls = [];
  const preloader = createTrackPreloader({ fetchImpl(src, { headers, redirect, priority }) {
    assert.equal(priority, 'low');
    calls.push([src, headers.Range, headers['If-Range'], redirect]);
    if (src.endsWith('big')) return audioResponse([1], 0, 8 * 1024 * 1024 + 1);
    if (headers.Range === 'bytes=0-0') return audioResponse([1], 0, 3);
    return audioResponse([1, 2, 3], 2, 3, src.endsWith('changed') ? '"v2"' : '"v1"', src.endsWith('wrong-mime') ? 'audio/flac' : 'audio/ogg');
  } });
  const small = track('small');
  preloader.prepare(small);
  preloader.prepare(small);
  await flush();
  const blob = preloader.take(small);
  assert.equal(blob.type, 'audio/ogg');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
  assert.equal(preloader.take(small), undefined);
  assert.deepEqual(calls, [[small.src, 'bytes=0-0', undefined, 'error'], [small.src, 'bytes=0-2', '"v1"', 'error']]);

  for (const id of ['big', 'changed', 'wrong-mime']) {
    const candidate = track(id);
    preloader.prepare(candidate);
    await flush();
    assert.equal(preloader.take(candidate), undefined);
  }
  assert.equal(calls.filter(([src]) => src.endsWith('big')).length, 1);
  assert.equal(calls.filter(([src]) => src.endsWith('changed')).length, 2);
  assert.equal(calls.filter(([src]) => src.endsWith('wrong-mime')).length, 2);
});

test('aborts superseded cloud requests and rejects non-stream endpoints', async () => {
  const calls = [];
  const preloader = createTrackPreloader({ fetchImpl(src, { signal }) {
    calls.push({ src, signal });
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const first = track('first');
  const second = track('second');
  preloader.prepare(first);
  preloader.prepare(second);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].signal.aborted, false);
  preloader.prepare({ ...first, src: 'https://untrusted.invalid/api/baidu/stream?id=third' });
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls.length, 2);
  assert.equal(preloader.take(second), undefined);
  await flush();
});

test('offers a large track prefix only to a service worker and only for a strong entity tag', async () => {
  const size = 9 * 1024 * 1024;
  const limit = 256 * 1024;
  const calls = [];
  let transferred;
  const worker = { postMessage(message, [bytes, port]) {
    transferred = structuredClone(message, { transfer: [bytes] });
    port.postMessage(true);
    port.close();
  } };
  const preloader = createTrackPreloader({ worker: () => worker, fetchImpl(src, { headers }) {
    calls.push(headers.Range);
    if (headers.Range === 'bytes=0-0') return audioResponse([3], 0, size, src.endsWith('strong') ? '"v1"' : 'W/"v1"');
    assert.equal(headers['If-Range'], '"v1"');
    return audioResponse(new Uint8Array(limit).fill(3), limit - 1, size);
  } });
  const weak = track('weak');
  preloader.prepare(weak);
  await flush();
  assert.equal(preloader.take(weak), undefined);
  const strong = track('strong');
  preloader.prepare(strong);
  await flush();
  assert.equal(await preloader.take(strong), strong.src + '&_groovebox_prefix=1');
  assert.deepEqual(calls, ['bytes=0-0', 'bytes=0-0', 'bytes=0-' + (limit - 1)]);
  assert.equal(transferred.bytes.byteLength, limit);
  assert.equal(new Uint8Array(transferred.bytes)[0], 3);
  assert.equal(transferred.validator, '"v1"');
});
