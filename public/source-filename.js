const tokenPattern = /(name|artist|track)/u;
const literalSeparator = /^[\p{P}\p{S}\p{Zs}]+$/u;
const fields = { name: 'title', artist: 'artist', track: 'trackNumber' };

export const defaultFilenamePattern = 'name';

function readField(field, raw) {
  const value = raw.trim();
  if (!value) return undefined;
  if (field !== 'trackNumber') return value;
  if (!/^\d+$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function uniqueFields(input, fields, literals) {
  // If a track number is at an edge, check it before trying title or artist boundaries.
  const fromRight = fields.at(-1) === 'trackNumber';
  const fieldNames = fromRight ? fields.toReversed() : fields;
  const separators = fromRight ? literals.toReversed() : literals;
  let match;
  let ambiguous = false;
  const values = [];
  function search(index, cursor) {
    const field = fieldNames[index];
    if (index === separators.length) {
      const value = readField(field, fromRight ? input.slice(0, cursor) : input.slice(cursor));
      if (value === undefined) return;
      values[index] = value;
      if (!match) match = [...values];
      else if (values.some((part, position) => part !== match[position])) ambiguous = true;
      return;
    }
    const separator = separators[index];
    const find = offset => fromRight ? (offset < 0 ? -1 : input.lastIndexOf(separator, offset)) : input.indexOf(separator, offset);
    for (let boundary = find(fromRight ? cursor - separator.length - 1 : cursor + 1);
      boundary !== -1 && !ambiguous; boundary = find(boundary + (fromRight ? -1 : 1))) {
      const raw = fromRight ? input.slice(boundary + separator.length, cursor) : input.slice(cursor, boundary);
      const value = readField(field, raw);
      // Extending a nonempty invalid numeric field cannot turn it into a decimal integer.
      if (value === undefined && field === 'trackNumber' && raw.trim()) break;
      if (value === undefined) continue;
      values[index] = value;
      search(index + 1, fromRight ? boundary : boundary + separator.length);
    }
  }
  search(0, fromRight ? input.length : 0);
  return match && !ambiguous ? Object.fromEntries(fieldNames.map((field, index) => [field, match[index]])) : undefined;
}

function filenameStem(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(0, dot) : filename;
}

/** Compile a case-sensitive pattern made of the FAQ's field names and literal separators. */
export function compileFilenamePattern(pattern = defaultFilenamePattern) {
  if (typeof pattern !== 'string') throw new TypeError('Expected a filename pattern string.');
  const segments = pattern.trim().split(tokenPattern);
  const tokens = segments.filter((_, index) => index % 2 === 1);
  const separators = segments.slice(1, -1).filter((_, index) => index % 2 === 1);
  if (segments[0] || segments.at(-1) || !tokens.includes('name') || new Set(tokens).size !== tokens.length ||
    separators.some(separator => !literalSeparator.test(separator))) {
    throw new RangeError('Use name exactly once, optional artist and track, and literal separators between tokens.');
  }
  const fieldNames = tokens.map(token => fields[token]);
  return function parseFilename(filename, folderName) {
    if (typeof filename !== 'string') throw new TypeError('Expected a raw filename string.');
    const title = filenameStem(filename);
    // A repeated separator can make several field assignments possible. Keep the title intact in that case.
    const song = separators.length ? uniqueFields(title, fieldNames, separators) : undefined;
    const folder = typeof folderName === 'string' ? uniqueFields(folderName, ['album', 'albumArtist'], ['-']) : undefined;
    return { ...folder, ...(folder && { artist: folder.albumArtist }), ...(song || { title }) };
  };
}
