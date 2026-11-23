const encoder = new TextEncoder();
const maxFilenameBytes = 240;
const maxEntries = 0xffff;
const maxArchiveBytes = 0xfffffffe;
const endRecordSize = 22;
const utf8 = 0x0800;
const dosDate = 0x0021; // 1980-01-01, the first valid DOS date.

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc;
});

export function safeDownloadName(value) {
  const name = (typeof value === 'string' ? value : '').normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu, '_')
    .trim().replace(/^[. ]+|[. ]+$/g, '');
  if (!name) return 'audio';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i.test(name) ? '_' + name : name;
}

function truncateUtf8(text, limit) {
  if (encoder.encode(text).length <= limit) return text;
  let size = 0;
  let end = 0;
  for (const character of text) {
    size += encoder.encode(character).length;
    if (size > limit) break;
    end += character.length;
  }
  return text.slice(0, end).trimEnd();
}

function uniqueName(value, used, nextNumbers) {
  const filename = safeDownloadName(value);
  const extension = /\.[A-Za-z0-9]{1,12}$/.exec(filename)?.[0] || '';
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const key = filename.toLowerCase();
  let number = nextNumbers.get(key) || 1;
  for (;;) {
    const suffix = (number === 1 ? '' : ' (' + number + ')') + extension;
    const name = truncateUtf8(stem, maxFilenameBytes - suffix.length) + suffix;
    number++;
    const normalized = name.toLowerCase();
    if (used.has(normalized)) continue;
    used.add(normalized);
    nextNumbers.set(key, number);
    return name;
  }
}

async function crc32(blob, signal) {
  const reader = blob.stream().getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  let crc = 0xffffffff;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) return (crc ^ 0xffffffff) >>> 0;
      for (const byte of value) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function localRecord(filename, size, crc) {
  const data = new Uint8Array(30 + filename.length);
  const header = new DataView(data.buffer);
  header.setUint32(0, 0x04034b50, true);
  header.setUint16(4, 20, true);
  header.setUint16(6, utf8, true);
  header.setUint16(12, dosDate, true);
  header.setUint32(14, crc, true);
  header.setUint32(18, size, true);
  header.setUint32(22, size, true);
  header.setUint16(26, filename.length, true);
  data.set(filename, 30);
  return data;
}

function centralRecord(filename, size, crc, offset) {
  const data = new Uint8Array(46 + filename.length);
  const header = new DataView(data.buffer);
  header.setUint32(0, 0x02014b50, true);
  header.setUint16(4, 20, true);
  header.setUint16(6, 20, true);
  header.setUint16(8, utf8, true);
  header.setUint16(14, dosDate, true);
  header.setUint32(16, crc, true);
  header.setUint32(20, size, true);
  header.setUint32(24, size, true);
  header.setUint16(28, filename.length, true);
  header.setUint32(42, offset, true);
  data.set(filename, 46);
  return data;
}

function endRecord(count, size, offset) {
  const data = new Uint8Array(endRecordSize);
  const header = new DataView(data.buffer);
  header.setUint32(0, 0x06054b50, true);
  header.setUint16(8, count, true);
  header.setUint16(10, count, true);
  header.setUint32(12, size, true);
  header.setUint32(16, offset, true);
  return data;
}

// Packs original bytes as stored entries. Keep each audio file as a Blob part so
// calculating its checksum never requires materializing a buffer for the archive.
export async function buildPlaylistArchive(entries, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  const data = [];
  const central = [];
  const used = new Set();
  const nextNumbers = new Map();
  const total = Array.isArray(entries) ? entries.length : null;
  let offset = 0;
  let centralSize = 0;
  let bytes = 0;
  if (total > maxEntries) throw new RangeError('ZIP 歌单最多可包含 65,535 个文件。');

  for await (const entry of entries) {
    signal?.throwIfAborted();
    if (central.length >= maxEntries) throw new RangeError('ZIP 歌单最多可包含 65,535 个文件。');
    if (!(entry?.blob instanceof Blob)) throw new TypeError('歌单中的音频必须是 Blob。');
    const { blob } = entry;
    const name = uniqueName(entry.name, used, nextNumbers);
    const filename = encoder.encode(name);
    const nextOffset = offset + 30 + filename.length + blob.size;
    const nextCentralSize = centralSize + 46 + filename.length;
    if (nextOffset + nextCentralSize + endRecordSize > maxArchiveBytes) {
      throw new RangeError('歌单超过 4 GB 的 ZIP 大小上限。');
    }
    const crc = await crc32(blob, signal);
    data.push(localRecord(filename, blob.size, crc), blob);
    central.push(centralRecord(filename, blob.size, crc, offset));
    offset = nextOffset;
    centralSize = nextCentralSize;
    bytes += blob.size;
    onProgress?.({ processed: central.length, total, bytes, name });
  }
  signal?.throwIfAborted();
  return new Blob([...data, ...central, endRecord(central.length, centralSize, offset)], { type: 'application/zip' });
}
