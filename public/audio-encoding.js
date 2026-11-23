import { streamBitrates, supportsStreamBitrate } from './stream-bitrate.js';

const audioFormatName = /^[\p{L}\p{N}][\p{L}\p{N} ._+/'(),-]*$/u;
const serverStream = /^\/api\/sources\/[0-9a-f-]{36}\/stream$/;
const compatibilityCodecs = new Map([
  ['audio/flac', { codec: 'FLAC', lossless: true }],
  ['audio/mpeg', { codec: 'MP3', lossless: false }],
]);
const mp3Codec = /^MPEG (?:1|2|2\.5) Layer 3$/;

function formatName(value) {
  if (typeof value !== 'string' || value.length > 80) return undefined;
  const name = value.trim();
  return audioFormatName.test(name) ? name : undefined;
}

function positiveInteger(value, max) {
  return Number.isInteger(value) && value > 0 && value <= max ? value : undefined;
}

export function normalizeAudioEncoding(format) {
  const codec = formatName(format?.codec);
  const container = formatName(format?.container);
  const bitrate = Number.isFinite(format?.bitrate) && format.bitrate > 0 && format.bitrate <= 4_294_967_296
    ? format.bitrate : undefined;
  const sampleRate = positiveInteger(format?.sampleRate, 100_000_000);
  const bitsPerSample = positiveInteger(format?.bitsPerSample, 64);
  const numberOfChannels = positiveInteger(format?.numberOfChannels, 256);
  const lossless = typeof format?.lossless === 'boolean' ? format.lossless : undefined;
  const encoding = {
    ...(codec && { codec }),
    ...(container && { container }),
    ...(bitrate && { bitrate }),
    ...(sampleRate && { sampleRate }),
    ...(bitsPerSample && { bitsPerSample }),
    ...(numberOfChannels && { numberOfChannels }),
    ...(lossless !== undefined && { lossless }),
  };
  return Object.keys(encoding).length ? encoding : undefined;
}

function mediaUrl(value, origin) {
  if (typeof value !== 'string' || !value || value.length > 8192 || !origin) return undefined;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) return undefined;
    if (url.protocol !== 'blob:' && !/^\/(api|assets)\//.test(url.pathname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function requestedBitrate(selected, original, provider) {
  if (!original || !supportsStreamBitrate(provider) || !serverStream.test(original.pathname)
      || selected.pathname !== original.pathname || original.searchParams.has('maxBitRate')) return undefined;
  const caps = selected.searchParams.getAll('maxBitRate');
  const cap = streamBitrates.find(rate => rate > 0 && String(rate) === caps[0]);
  if (caps.length !== 1 || cap === undefined) return undefined;
  const withoutCap = new URL(selected);
  withoutCap.searchParams.delete('maxBitRate');
  return withoutCap.searchParams.toString() === original.searchParams.toString() ? cap : undefined;
}

// The selected alternate must match the media element's confirmed current URL.
export function describePlaybackEncoding({ track, requestedUrl, currentUrl, compatible, origin }) {
  const source = normalizeAudioEncoding(track?.encoding);
  const selected = mediaUrl(requestedUrl, origin);
  const current = mediaUrl(currentUrl, origin);
  if (!track || !selected || current?.href !== selected.href) return { source };
  const original = mediaUrl(track.src, origin);
  const converted = mediaUrl(compatible?.url, origin);
  if (converted?.protocol === 'blob:' && converted.href === selected.href) {
    const declared = compatibilityCodecs.get(compatible.mime);
    if (!declared) return { source };
    const inspected = normalizeAudioEncoding(compatible.encoding);
    // The optional parse belongs to this exact Blob. Conflicting parses cannot
    // replace the representation already verified by the compatibility request.
    const compatibleCodec = inspected?.codec === declared.codec ||
      (declared.codec === 'MP3' && mp3Codec.test(inspected?.codec));
    const verified = compatibleCodec ? inspected : undefined;
    return { source, active: { kind: 'compatible', encoding: { ...verified, ...declared } } };
  }
  const capKbps = requestedBitrate(selected, original, track.provider);
  if (capKbps !== undefined) return { source, active: { kind: 'requested-limit', capKbps } };
  return { source };
}
