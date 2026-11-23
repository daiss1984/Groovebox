const renderModes = new Set(['off', 'opacity-gradient', 'slide-uniform', 'slide-accurate']);

export function normalizeWordRenderMode(value) {
  return renderModes.has(value) ? value : 'opacity-gradient';
}

const isTime = value => Number.isFinite(value) && value >= 0;
const firstEndAtOrAfter = (time, ...ends) => ends.find(end => isTime(end) && end >= time);

function fractionAt(position, start, end) {
  if (position < start) return 0;
  if (position >= end) return 1;
  return (position - start) / (end - start);
}

function timedWords(words, lineEnd, nextTime, duration) {
  const timed = [];
  let previous = -1;
  for (const [index, word] of words.entries()) {
    if (!isTime(word?.time) || word.time < previous || typeof word.text !== 'string') continue;
    timed.push({ index, start: word.time, end: word.endTime ?? word.end, visible: Boolean(word.text.trim()) });
    previous = word.time;
  }
  const visible = [];
  for (const [index, word] of timed.entries()) {
    if (!word.visible) continue;
    const followingStart = timed[index + 1]?.start;
    const end = firstEndAtOrAfter(word.start, word.end, followingStart, lineEnd, nextTime, duration, word.start);
    visible.push({ ...word, end: Math.min(end, followingStart ?? Infinity) });
  }
  return visible;
}

// Accept a parsed cue and the same offset-adjusted seconds used to select the current line.
// Opacities retain source word indices, even for whitespace-only or untimed fragments.
export function lyricWordFrame(line, position, { mode, nextTime, duration } = {}) {
  const words = Array.isArray(line?.words) ? line.words : [];
  const opacities = Array.from(words, () => 1);
  const renderMode = normalizeWordRenderMode(mode);
  if (!isTime(line?.time) || !words.length || renderMode === 'off') return { opacities, progress: 1 };

  const lineEnd = firstEndAtOrAfter(line.time, line.endTime, line.end);
  const visible = timedWords(words, lineEnd, nextTime, duration);
  if (!visible.length) return { opacities, progress: 1 };

  const time = Number.isFinite(position) ? position : -1;
  if (renderMode === 'slide-uniform') {
    return { opacities, progress: fractionAt(time, visible[0].start, visible.at(-1).end) };
  }

  if (renderMode === 'slide-accurate') {
    const index = visible.findIndex(word => time < word.end);
    if (index < 0) return { opacities, progress: 1 };
    const { start, end } = visible[index];
    // Cotton follows the next word's timing through a gap. Its extrapolated
    // fraction can be negative, so clamp the whole line clip after scaling.
    const fraction = end === start ? 0 : (time - start) / (end - start);
    return { opacities, progress: Math.max(0, (index + fraction) / visible.length) };
  }

  for (const word of visible) {
    if (time < word.start) opacities[word.index] = 0.35;
    else {
      const fraction = fractionAt(time, word.start, word.end);
      // Smoothstep fits the observed whole-word fade on the reference desktop player.
      opacities[word.index] = 0.5 + 0.5 * fraction * fraction * (3 - 2 * fraction);
    }
  }
  return { opacities, progress: 1 };
}
