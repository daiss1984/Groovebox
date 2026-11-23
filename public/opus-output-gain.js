const maxOggPageBytes = 65307;
const maxVerifiedBytes = 32 * 1024 * 1024;
const maxPeakCheckPackets = 500;
const probeDeltas = [0, -12, 6];
let decoderCapability;

const signature = (bytes, offset, chars) => [...chars].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
function pageAt(bytes, start) {
  if (bytes.length < start + 27 || !signature(bytes, start, 'OggS') || bytes[start + 4] !== 0) return;
  const data = start + 27 + bytes[start + 26];
  if (data > bytes.length) return;
  let end = data;
  for (let offset = start + 27; offset < data; offset++) end += bytes[offset];
  if (end > bytes.length) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start);
  return { flags: bytes[start + 5], serial: view.getUint32(14, true), sequence: view.getUint32(18, true),
    storedChecksum: view.getUint32(22, true), data, end };
}
function oggCrc(bytes, end) {
  let crc = 0;
  for (let offset = 0; offset < end; offset++) {
    if (offset < 22 || offset > 25) crc ^= bytes[offset] << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}
export function opusHeader(bytes) {
  const page = pageAt(bytes, 0);
  if (!page || page.flags !== 2 || page.sequence !== 0 || page.end - page.data < 19 ||
      !signature(bytes, page.data, 'OpusHead') || (bytes[page.data + 8] & 0xf0) || !bytes[page.data + 9] ||
      bytes[page.data - 1] === 255 || oggCrc(bytes, page.end) !== page.storedChecksum) return;
  for (let offset = 27; offset < page.data - 1; offset++) if (bytes[offset] !== 255) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  if (view.getBigUint64(6, true) !== 0n) return;
  const channels = bytes[page.data + 9];
  const mapping = bytes[page.data + 18];
  if ((mapping === 0 && channels > 2) || (mapping !== 0 && page.end - page.data < 21 + channels)) return;
  return { gainDb: view.getInt16(page.data + 16, true) / 256, channels, serial: page.serial };
}
function packetCountInSingleStream(bytes, header) {
  let sequence = 0;
  let packets = 0;
  for (let cursor = 0; cursor < bytes.length;) {
    const page = pageAt(bytes, cursor);
    if (!page || page.serial !== header.serial || page.sequence !== sequence++ || (cursor && page.flags & 2)) return;
    for (let offset = cursor + 27; offset < page.data; offset++) if (bytes[offset] < 255) packets++;
    if (page.flags & 4) return page.end === bytes.length ? packets : undefined;
    cursor = page.end;
  }
}
export function signedProbeSample(input, gainDb) {
  const bytes = new Uint8Array(input);
  const page = pageAt(bytes, 0);
  const view = new DataView(bytes.buffer);
  view.setInt16(page.data + 16, gainDb * 256, true);
  view.setUint32(22, oggCrc(bytes, page.end), true);
  return bytes.buffer;
}
function rms(samples) {
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}
export function classifyOpusProbe(amplitudes) {
  if (amplitudes.length !== probeDeltas.length || amplitudes.some(value => !Number.isFinite(value) || value < .0001 || value > .8)) return 'unknown';
  const deltas = amplitudes.map(value => 20 * Math.log10(value / amplitudes[0]));
  if (deltas.every((value, index) => Math.abs(value - probeDeltas[index]) < .65)) return 'applied';
  return deltas.every(value => Math.abs(value) < .65) ? 'ignored' : 'unknown';
}
export function opusDecoderCapability() {
  const OfflineContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  // A detached decode has been verified against desktop media elements. Touch devices can use a different media path.
  if (!OfflineContext || navigator.maxTouchPoints > 0) return Promise.resolve('unknown');
  return decoderCapability ??= (async () => {
    const response = await fetch('/assets/opus-gain-probe.opus', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return 'unknown';
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (opusHeader(bytes)?.gainDb !== 0) return 'unknown';
    const context = new OfflineContext(1, 24000, 48000);
    const amplitudes = await Promise.all(probeDeltas.map(async gain => {
      const audio = await context.decodeAudioData(signedProbeSample(bytes, gain));
      return rms(audio.getChannelData(0).subarray(8000, 24000));
    }));
    return classifyOpusProbe(amplitudes);
  })().catch(() => 'unknown');
}

export async function verifiedOpusOutputGain(blob) {
  if (!blob?.size || blob.size > maxVerifiedBytes) return 0;
  const prefix = await blob.slice(0, maxOggPageBytes).arrayBuffer();
  const header = opusHeader(new Uint8Array(prefix));
  if (!header?.gainDb) return 0;
  const input = blob.size <= maxOggPageBytes ? prefix : await blob.arrayBuffer();
  const packets = packetCountInSingleStream(new Uint8Array(input), header);
  if (!(packets >= 3)) return 0;
  if (header.gainDb < 0) return header.gainDb;
  // Each Opus packet is at most 120 ms. Decode only bounded tracks to verify headroom before boosting.
  if (packets > maxPeakCheckPackets || header.channels > 2) return 0;
  const OfflineContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineContext) return 0;
  const context = new OfflineContext(header.channels, 24000, 48000);
  const audio = await context.decodeAudioData(input);
  const ceiling = .999 * 10 ** (-header.gainDb / 20);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    if (audio.getChannelData(channel).some(value => !Number.isFinite(value) || Math.abs(value) > ceiling)) return 0;
  }
  return header.gainDb;
}
