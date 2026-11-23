function normalizeLabels(input, limit) {
  const labels = [];
  const seen = new Set();
  const values = Array.isArray(input) ? input : [input];
  for (const value of values.slice(0, 100)) {
    if (typeof value !== 'string') continue;
    const clean = value.slice(0, 512).normalize('NFC').replace(/[\x00-\x1f\x7f-\x9f\s]+/gu, ' ').trim();
    const name = Array.from(clean.replace(/[\ud800-\udfff]/gu, '\ufffd')).slice(0, limit).join('').trimEnd();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    labels.push(name);
    if (labels.length >= 24) break;
  }
  return labels;
}

export const normalizeGenres = values => normalizeLabels(values, 100);
export const normalizeArtists = values => normalizeLabels(values, 300);

function ruleLines(value) {
  if (typeof value === 'string') return value.slice(0, 3000).split(/\r\n?|\n/);
  return Array.isArray(value) ? value.slice(0, 100) : [];
}

function normalizeRules(value, normalize) {
  const separators = new Set();
  for (const separator of ruleLines(value?.separators)) {
    if (typeof separator !== 'string' || !separator.trim() || /[\x00-\x1f\x7f-\x9f]/u.test(separator)) continue;
    const literal = Array.from(separator.slice(0, 256).normalize('NFC').replace(/\s+/gu, ' ')
      .replace(/[\ud800-\udfff]/gu, '\ufffd')).slice(0, 32).join('');
    if (literal.trim()) separators.add(literal);
    if (separators.size >= 24) break;
  }
  return { separators: [...separators], exceptions: normalize(ruleLines(value?.exceptions)) };
}

function createClassifier(rules, normalize) {
  const { separators, exceptions } = normalizeRules(rules, normalize);
  if (!separators.length) return normalize;
  const keep = new Set(exceptions.map(name => name.toLowerCase()));
  const pattern = new RegExp(separators.sort((a, b) => b.length - a.length)
    .map(literal => literal.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')).join('|'), 'u');
  return values => normalize(normalize(values).flatMap(name =>
    keep.has(name.toLowerCase()) ? [name] : name.split(pattern)));
}

export const normalizeGenreRules = value => normalizeRules(value, normalizeGenres);
export const normalizeArtistRules = value => normalizeRules(value, normalizeArtists);
export const createGenreClassifier = rules => createClassifier(rules, normalizeGenres);
export const createArtistClassifier = rules => createClassifier(rules, normalizeArtists);
