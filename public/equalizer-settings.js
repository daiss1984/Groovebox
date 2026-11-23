export const standardEqualizerBands = Object.freeze([32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
export const legacyEqualizerBands = Object.freeze([60, 250, 1000, 4000, 12000]);
export const maxEqualizerProfiles = 30;

// Preset gains follow standardEqualizerBands in the order shown by Cotton Music 5.5.0.
export const equalizerPresets = Object.freeze({
  flat: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  vocal: Object.freeze([-2, -1, 0, 2, 4, 4, 3, 1, 0, -1]),
  jazz: Object.freeze([4, 3, 1, 2, -2, -2, 0, 1, 3, 4]),
  rock: Object.freeze([5, 4, 3, 1, -1, -1, 0, 2, 4, 5]),
  dance: Object.freeze([6, 5, 2, 0, 0, -2, -1, 0, 4, 5]),
  classical: Object.freeze([5, 4, 3, 2, -1, -1, 0, 2, 3, 4]),
  'hip-hop': Object.freeze([5, 4, 1, 3, -1, -1, 1, 0, 2, 3]),
  'late-night': Object.freeze([3, 2, 1, 0, -1, 0, 1, 2, 3, 3]),
});

export function activeEqBands(gains) {
  return Array.isArray(gains) && gains.length === legacyEqualizerBands.length ? legacyEqualizerBands : standardEqualizerBands;
}

export function equalizerProfileName(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim().slice(0, 48) : '';
}

function equalizerCurve(gains) {
  if (!Array.isArray(gains)) return;
  const bands = activeEqBands(gains);
  if (gains.length !== bands.length) return;
  return bands.map((_, index) => {
    const gain = gains[index];
    const value = ['number', 'string', 'boolean'].includes(typeof gain) ? Number(gain) : 0;
    return Number.isFinite(value) ? Math.max(-12, Math.min(12, value)) : 0;
  });
}

export function normalizeEqualizerSettings(settings) {
  const gains = equalizerCurve(settings?.eq);
  const hasAdjustments = gains?.some(value => value !== 0) ?? false;
  // Keep the legacy frequencies for adjusted curves. Flat playback can start on the ten standard bands.
  const eq = gains?.length === standardEqualizerBands.length || hasAdjustments ? gains : [...equalizerPresets.flat];
  const eqEnabled = typeof settings?.eqEnabled === 'boolean' ? settings.eqEnabled : hasAdjustments;

  const profiles = new Map();
  for (const entry of Array.isArray(settings?.eqProfiles) ? settings.eqProfiles : []) {
    const name = equalizerProfileName(entry?.name);
    if (!name) continue;
    const gains = equalizerCurve(entry.gains);
    if (!gains) continue;
    const id = name.toLowerCase();
    if (!profiles.has(id)) profiles.set(id, { name, gains });
    if (profiles.size >= maxEqualizerProfiles) break;
  }
  return {
    eq, eqEnabled, eqProfiles: [...profiles.values()], eqProfile: profiles.has(settings?.eqProfile) ? settings.eqProfile : '',
  };
}
