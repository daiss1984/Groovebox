import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describePlaybackEncoding, normalizeAudioEncoding } from '../public/audio-encoding.js';

const origin = 'http://127.0.0.1:5187';
const src = '/api/sources/812f3c30-109e-4ac8-9c3b-8cc71a03a9a0/stream?id=track';
const source = { codec: 'FLAC', bitrate: 342432 };
const track = { provider: 'navidrome', src, encoding: source };
const compatibilityUrl = 'blob:' + origin + '/8d3ce2f5-60b8-46c7-940b-45dc261e7777';

test('keeps approved audio properties and discards ambiguous or malformed fields', () => {
  assert.deepEqual(normalizeAudioEncoding({ codec: 'ALAC', container: 'M4A/isom/iso2',
    bitrate: 310842.15, sampleRate: 44100, bitsPerSample: 24, numberOfChannels: 2, lossless: true, overallBitrate: 325282, tags: [],
  }), { codec: 'ALAC', container: 'M4A/isom/iso2', bitrate: 310842.15, sampleRate: 44100,
    bitsPerSample: 24, numberOfChannels: 2, lossless: true });
  assert.equal(normalizeAudioEncoding({ codec: '<img>', container: 'https://unknown.invalid',
    bitrate: '96000', overallBitrate: 100000, sampleRate: Infinity, bitsPerSample: 65,
    numberOfChannels: -1, lossless: 'false',
  }), undefined);
});

test('cannot convert a URL request cap into measured encoding facts', () => {
  const describe = (requestedUrl, candidate = track, currentUrl = origin + requestedUrl) =>
    describePlaybackEncoding({ track: candidate, origin, requestedUrl, currentUrl });
  const request = src + '&maxBitRate=96';
  assert.deepEqual(describe(request), { source, active: { kind: 'requested-limit', capKbps: 96 } });
  for (const invalid of [
    src + '&maxBitRate=97', request + '&maxBitRate=96', request + '&arbitrary=0', request.replace('id=track', 'id=other'),
  ]) assert.deepEqual(describe(invalid), { source });
  assert.deepEqual(describe(request, { ...track, provider: 'webdav' }), { source });
  assert.deepEqual(describe(request, track, origin + src), { source });
  assert.deepEqual(describe(request, { ...track, src: request }), { source });
  const foreign = 'https://server.invalid' + request;
  assert.deepEqual(describe(foreign, track, foreign), { source });
});

test('uses measured compatibility facts from the selected FLAC or MP3 file only', () => {
  const selection = { track, origin, requestedUrl: compatibilityUrl, currentUrl: compatibilityUrl };
  const describe = compatible => describePlaybackEncoding({ ...selection, compatible });
  assert.deepEqual(describe({ url: compatibilityUrl, mime: 'audio/flac', encoding: { codec: 'MP3', bitrate: 96000 } }),
    { source, active: { kind: 'compatible', encoding: { codec: 'FLAC', lossless: true } } });
  assert.deepEqual(describe({ url: compatibilityUrl, mime: 'audio/mpeg',
    encoding: { codec: 'MPEG 2 Layer 3', bitrate: 67270, sampleRate: 22050, lossless: false },
  }), { source, active: { kind: 'compatible', encoding: { codec: 'MP3', bitrate: 67270, sampleRate: 22050, lossless: false } } });
  assert.deepEqual(describe({ url: compatibilityUrl + '-stale', mime: 'audio/flac' }), { source });
});
