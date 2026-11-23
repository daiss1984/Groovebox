const sampleRate = 2_822_400;
const blockBytes = 4096;

function id3Tag(title, artist, album) {
  const frame = (id, text) => {
    const content = Buffer.from('\0' + text, 'ascii');
    const header = Buffer.alloc(10);
    header.write(id);
    header.writeUInt32BE(content.length, 4);
    return Buffer.concat([header, content]);
  };
  const frames = Buffer.concat([frame('TIT2', title), frame('TPE1', artist), frame('TALB', album)]);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, frames.length >> 7, frames.length & 127]);
  return Buffer.concat([header, frames]);
}

function dsf(audio, tag) {
  const header = Buffer.alloc(92);
  header.write('DSD ');
  header.writeBigUInt64LE(28n, 4);
  header.writeBigUInt64LE(BigInt(header.length + audio.length + tag.length), 12);
  header.writeBigUInt64LE(BigInt(header.length + audio.length), 20);
  header.write('fmt ', 28);
  header.writeBigUInt64LE(52n, 32);
  header.writeUInt32LE(1, 40); // Format version.
  header.writeUInt32LE(1, 48); // Mono channel layout.
  header.writeUInt32LE(1, 52);
  header.writeUInt32LE(sampleRate, 56);
  header.writeUInt32LE(1, 60); // Least-significant bit first.
  header.writeBigUInt64LE(BigInt(audio.length) * 8n, 64);
  header.writeUInt32LE(blockBytes, 72);
  header.write('data', 80);
  header.writeBigUInt64LE(BigInt(audio.length + 12), 84);
  return Buffer.concat([header, audio, tag]);
}

function iffChunk(id, data) {
  const header = Buffer.alloc(12);
  header.write(id);
  header.writeBigUInt64BE(BigInt(data.length), 4);
  const chunks = [header, data];
  if (data.length % 2) chunks.push(Buffer.alloc(1));
  return Buffer.concat(chunks);
}

function dff(audio, tag) {
  const frequency = Buffer.alloc(4);
  frequency.writeUInt32BE(sampleRate);
  const properties = Buffer.concat([
    Buffer.from('SND '),
    iffChunk('FS  ', frequency),
    iffChunk('CHNL', Buffer.from('\0\x01C   ')),
    iffChunk('CMPR', Buffer.from('DSD \x03DSD')),
  ]);
  const form = Buffer.concat([
    Buffer.from('DSD '), iffChunk('FVER', Buffer.from([1, 5, 0, 0])),
    iffChunk('PROP', properties), iffChunk('DSD ', audio), iffChunk('ID3 ', tag),
  ]);
  return iffChunk('FRM8', form);
}

// DSD64 mono sine, independently verified with FFmpeg's DSF and DSDIFF demuxers.
export function dsdFixture(format, { seconds = 1, artist = 'Synthetic Artist', album = 'Quality Test' } = {}) {
  const audio = Buffer.alloc(Math.ceil(seconds * sampleRate / 8 / blockBytes) * blockBytes);
  const angularFrequency = 2 * Math.PI * 440 / sampleRate;
  let accumulatedError = 0;
  for (let index = 0; index < audio.length * 8; index++) {
    accumulatedError += 0.2 * Math.sin(index * angularFrequency);
    if (accumulatedError >= 0) {
      accumulatedError -= 1;
      const bit = index % 8;
      audio[index >> 3] |= 1 << (format === 'dsf' ? bit : 7 - bit);
    } else {
      accumulatedError += 1;
    }
  }
  const tag = id3Tag(format.toUpperCase() + ' Studio Test', artist, album);
  return format === 'dsf' ? dsf(audio, tag) : dff(audio, tag);
}
