import { parseLyrics } from '../public/library.js';

const maxPayloadBytes = 1_000_000;
const ticksPerSecond = 10_000_000;
const missing = () => ({ status: 404, lines: [] });

function idSegment(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && /^[\w.~-]{1,256}$/.test(id) && id !== '.' && id !== '..' ? id : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeLines(items) {
  const lines = array(items).flatMap(item => {
    const value = text(item?.Text ?? item?.text);
    const ticks = item?.Start ?? item?.start ?? item?.StartPositionTicks ?? item?.startPositionTicks;
    return value ? [{ time: Number.isFinite(ticks) && ticks >= 0 ? ticks / ticksPerSecond : null, text: value }] : [];
  });
  if (lines.length && lines.every(line => line.time === null)) {
    return rawLines(lines.map(line => line.text).join('\n'));
  }
  return lines.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
}

function rawLines(raw) {
  const value = text(raw);
  if (!value || Buffer.byteLength(value) > maxPayloadBytes || value.includes('\0')) return [];
  const timed = parseLyrics(value);
  return timed.length ? timed : [{ time: null, text: value }];
}

async function json(request, path) {
  const response = await request(path);
  const body = response.body;
  if (!response.ok) {
    await body?.cancel();
    return { status: response.status };
  }
  if (!body) return { status: 502 };
  if (Number(response.headers.get('content-length')) > maxPayloadBytes) {
    await body.cancel();
    return { status: 413 };
  }
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxPayloadBytes) {
        await reader.cancel();
        return { status: 413 };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return { status: 200, payload: JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')) };
  } catch {
    return { status: 502 };
  }
}

function isMissing(status) {
  return [404, 405, 501].includes(status);
}

function isLyricStream(stream) {
  return stream?.Type === 'Subtitle' && (
    stream.Codec === 'lrc' || (stream.Codec === 'text' && /^lyrics$/i.test(text(stream.Title)))
  );
}

// request takes only relative paths. Its caller supplies the existing authenticated, same-source requester.
export async function readEmbyLyrics(request, { itemId, userId, mediaSourceId } = {}) {
  const id = idSegment(itemId);
  const user = idSegment(userId);
  if (!id || !user) return missing();

  // Modern Emby client contract: see AudioMuse-AI's authenticated Emby get_lyrics.
  const direct = await json(request, 'Items/' + id + '/Lyrics');
  const directLines = normalizeLines(direct.payload?.Lyrics ?? direct.payload?.lyrics);
  if (directLines.length) return { status: 200, lines: directLines };
  if (direct.status !== 200 && !isMissing(direct.status)) return { status: direct.status, lines: [] };

  // Older Emby exposes LRC as subtitle events and inline lyric tags as text Extradata.
  const info = await json(request, 'Items/' + id + '/PlaybackInfo?' + new URLSearchParams({ UserId: user }));
  if (info.status !== 200) return isMissing(info.status) ? missing() : { status: info.status, lines: [] };
  const sources = array(info.payload?.MediaSources);
  const source = sources.find(source => mediaSourceId && source?.Id === mediaSourceId) || sources[0];
  const streams = array(source?.MediaStreams).filter(isLyricStream);
  const embedded = streams.map(stream => rawLines(stream.Extradata)).find(lines => lines.length) || [];
  const sourceId = idSegment(source?.Id);
  // Index 0 is a valid subtitle index. Ignore URL fields returned by the service.
  const lrc = streams.find(stream => stream.Codec === 'lrc' && Number.isSafeInteger(stream.Index) && stream.Index >= 0);
  if (sourceId && lrc) {
    const subtitle = await json(request, 'Items/' + id + '/' + sourceId + '/Subtitles/' + lrc.Index + '/Stream.js');
    const lines = normalizeLines(subtitle.payload?.TrackEvents);
    if (lines.length) return { status: 200, lines };
    if (!embedded.length && subtitle.status !== 200 && !isMissing(subtitle.status)) return { status: subtitle.status, lines: [] };
  }
  return embedded.length ? { status: 200, lines: embedded } : missing();
}
