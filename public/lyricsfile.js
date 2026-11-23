const validTime = value => Number.isSafeInteger(value) && value >= 0;

export async function lyricsFromYaml(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 100000) return [];
  try {
    const { parseDocument } = await import('./lyricsfile-yaml.bundle.js');
    const doc = parseDocument(source, { strict: true, merge: false });
    if (doc.errors.length || doc.warnings.length) return [];
    const value = doc.toJS({ maxAliasCount: 0 });
    if (value?.version !== '1.0' || value.metadata?.instrumental === true) return [];
    const lines = (Array.isArray(value.lines) ? value.lines : []).flatMap(line => {
      if (typeof line?.text !== 'string' || !line.text.trim() || !validTime(line.start_ms)) return [];
      const words = Array.isArray(line.words) ? line.words : [];
      const useWords = words.length && words.every((word, index) =>
        typeof word?.text === 'string' && validTime(word.start_ms) &&
        (!index || word.start_ms >= words[index - 1].start_ms) &&
        (word.end_ms === undefined || (validTime(word.end_ms) && word.end_ms >= word.start_ms))) &&
        words.map(word => word.text).join('') === line.text;
      return [{
        time: line.start_ms / 1000,
        text: line.text,
        ...(useWords && { words: words.map(word => ({
          time: word.start_ms / 1000,
          text: word.text,
          ...(word.end_ms !== undefined && { endTime: word.end_ms / 1000 }),
        })) }),
      }];
    });
    if (lines.length) return lines.sort((a, b) => a.time - b.time);
    return typeof value.plain === 'string' && value.plain.trim() ? [{ time: null, text: value.plain.trim() }] : [];
  } catch {
    return [];
  }
}
