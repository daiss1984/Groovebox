// YRC and QRC use absolute milliseconds: https://amll.dev/en/guides/lyric/formats
// Plaintext KRC uses word offsets from the line start: https://github.com/chenmozhijin/LDDC/blob/main/LDDC/core/parser/krc.py
const lineHeader = /^\s*\[(\d+),(\d+)\]/;
const wordMarkers = {
  yrc: /\((\d+),(\d+),\d+\)/g,
  qrc: /\((\d+),(\d+)\)/g,
  krc: /<(\d+),(\d+),\d+>/g,
};
const xmlWrapper = /^\s*(?:<\?xml\b[\s\S]*?\?>\s*)?<(?:QrcInfos|Lyric_1)(?=[\s/>])/i;
const namedEntities = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };

function decodeXmlAttribute(value) {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|apos|gt|lt|quot);/gi, (whole, name) => {
    if (name[0] !== '#') return namedEntities[name] ?? whole;
    const hexadecimal = name[1].toLowerCase() === 'x';
    const point = hexadecimal ? Number('0x' + name.slice(2)) : Number(name.slice(1));
    return Number.isInteger(point) && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : '\uFFFD';
  });
}

function unwrapQrc(source) {
  const primary = /<Lyric_1(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(source)?.[0];
  if (!primary) return '';
  const attributes = new Map();
  for (const [, name, , value] of primary.matchAll(/([a-z_][\w:-]*)\s*=\s*(["'])([\s\S]*?)\2/gi)) {
    attributes.set(name.toLowerCase(), value);
  }
  const type = attributes.get('lyrictype');
  if (type && type !== '1') return '';
  return decodeXmlAttribute(attributes.get('lyriccontent') || '');
}

function plain(input) {
  return input.replace(/^[\uFEFF]/, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

function parseInterval(start, duration, offset = 0) {
  const begin = Number(start) + offset;
  const end = begin + Number(duration);
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end)) return null;
  return { time: begin / 1000, endTime: end / 1000 };
}

function readWords(body, format, offset) {
  const words = [];
  let cursor = 0;
  let timing = null;
  let prefix = '';
  function append(text, interval) {
    if (!text) return;
    if (interval) {
      words.push({ ...interval, text: prefix + text });
      prefix = '';
    } else if (words.length) words.at(-1).text += text;
    else prefix += text;
  }
  for (const match of body.matchAll(wordMarkers[format])) {
    const text = body.slice(cursor, match.index);
    const next = parseInterval(match[1], match[2], offset);
    append(text, format === 'qrc' ? next : timing);
    timing = next;
    cursor = match.index + match[0].length;
  }
  append(body.slice(cursor), format === 'qrc' ? null : timing);

  if (!words.length) return { text: prefix.trim(), words };
  const text = words.map(word => word.text).join('').trim();
  const first = words.findIndex(word => word.text.trim());
  if (first < 0) return { text, words: [] };
  const last = words.findLastIndex(word => word.text.trim());
  const visible = words.slice(first, last + 1);
  visible[0].text = visible[0].text.trimStart();
  visible.at(-1).text = visible.at(-1).text.trimEnd();
  const ordered = visible.every((word, index) => index === 0 || visible[index - 1].time <= word.time);
  return { text, words: ordered ? visible : [] };
}

function detectFormat(lines) {
  for (const line of lines) {
    const match = lineHeader.exec(line);
    if (!match) continue;
    const body = line.slice(match[0].length);
    for (const [format, marker] of Object.entries(wordMarkers)) {
      if (body.search(marker) !== -1) return format;
    }
  }
  return null;
}

// Returns plain text; call sites should render text using their usual HTML escaping.
export function parseKaraoke(text, format = '') {
  if (typeof text !== 'string' || !text || text.length > 1_000_000 || typeof format !== 'string') return [];
  const hint = /(?:^|\.)(yrc|qrc|krc)$/i.exec(format.trim())?.[1]?.toLowerCase();
  if (format.trim() && !hint) return [];
  const initial = plain(text);
  const wrapped = xmlWrapper.test(initial);
  if (wrapped && hint && hint !== 'qrc') return [];
  const lines = (wrapped ? plain(unwrapQrc(initial)) : initial).split('\n');
  const kind = hint || (wrapped ? 'qrc' : detectFormat(lines));
  if (!kind) return [];

  const lyrics = [];
  for (const line of lines) {
    const match = lineHeader.exec(line);
    if (!match) continue;
    const timing = parseInterval(match[1], match[2]);
    if (!timing) continue;
    const parsed = readWords(line.slice(match[0].length), kind, kind === 'krc' ? Number(match[1]) : 0);
    if (parsed.text) lyrics.push({ ...timing, ...parsed });
  }
  return lyrics.sort((first, second) => first.time - second.time);
}
