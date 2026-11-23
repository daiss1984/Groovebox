import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeEqBands, equalizerPresets, equalizerProfileName, legacyEqualizerBands,
  maxEqualizerProfiles, normalizeEqualizerSettings, standardEqualizerBands,
} from '../public/equalizer-settings.js';

test('matches the ten observed Cotton 5.5.0 frequencies and each displayed preset', () => {
  deepEqual(standardEqualizerBands, [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  deepEqual(legacyEqualizerBands, [60, 250, 1000, 4000, 12000]);
  deepEqual(equalizerPresets, {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
    jazz: [4, 3, 1, 2, -2, -2, 0, 1, 3, 4],
    rock: [5, 4, 3, 1, -1, -1, 0, 2, 4, 5],
    dance: [6, 5, 2, 0, 0, -2, -1, 0, 4, 5],
    classical: [5, 4, 3, 2, -1, -1, 0, 2, 3, 4],
    'hip-hop': [5, 4, 1, 3, -1, -1, 1, 0, 2, 3],
    'late-night': [3, 2, 1, 0, -1, 0, 1, 2, 3, 3],
  });
  deepEqual(Object.keys(equalizerPresets), ['flat', 'vocal', 'jazz', 'rock', 'dance', 'classical', 'hip-hop', 'late-night']);
});

test('keeps existing adjusted five-band audio and profile gains while migrating a flat setup', () => {
  const legacyGain = Object.freeze([-12, -1.5, 3.25, 0, 12]);
  const legacyFlat = Object.freeze([0, 0, 0, 0, 0]);
  const profiles = [{ name: 'Existing', gains: legacyGain }, { name: 'Legacy Flat', gains: legacyFlat }];
  const old = normalizeEqualizerSettings({ eq: legacyGain, eqProfiles: profiles, eqProfile: 'existing' });
  deepEqual(old, { eq: legacyGain, eqEnabled: true, eqProfiles: profiles, eqProfile: 'existing' });
  equal(activeEqBands(old.eq), legacyEqualizerBands);
  equal(activeEqBands(old.eqProfiles[1].gains), legacyEqualizerBands);
  const flat = normalizeEqualizerSettings({ eq: legacyFlat, eqProfiles: profiles });
  deepEqual(flat.eq, equalizerPresets.flat);
  equal(flat.eqEnabled, false);
  equal(activeEqBands(flat.eq), standardEqualizerBands);
  old.eq[0] = 0;
  old.eqProfiles[0].gains[0] = 1;
  equal(legacyGain[0], -12);
});

test('retains independent enable state and safely normalizes finite gains', () => {
  const malformed = [13, -200, 1.75, Infinity, -Infinity, NaN, '3', Symbol(), true, null];
  const off = normalizeEqualizerSettings({ eq: malformed, eqEnabled: false });
  deepEqual(off.eq, [12, -12, 1.75, 0, 0, 0, 3, 0, 1, 0]);
  equal(off.eqEnabled, false);
  equal(normalizeEqualizerSettings({ eq: equalizerPresets.rock, eqEnabled: 'false' }).eqEnabled, true);
  equal(normalizeEqualizerSettings({ eq: equalizerPresets.flat, eqEnabled: true }).eqEnabled, true);
  const defaults = { eq: equalizerPresets.flat, eqEnabled: false, eqProfiles: [], eqProfile: '' };
  deepEqual(normalizeEqualizerSettings(), defaults);
  deepEqual(normalizeEqualizerSettings({ eq: [12, -12], eqEnabled: 'true' }), defaults);
  deepEqual(normalizeEqualizerSettings({ eq: { length: 5, 0: 12 } }), defaults);
  deepEqual(normalizeEqualizerSettings({ eq: new Array(10) }), defaults);
});

test('normalizes profile names with legacy NFC, length and first case-insensitive match semantics', () => {
  const settings = normalizeEqualizerSettings({
    eqProfile: 'éclair',
    eqProfiles: [
      null, { name: ' ' }, { name: 'Malformed', gains: [8, 3] },
      { name: '  E\u0301clair  ', gains: [1, 2, 3, 4, 5] },
      { name: 'éCLAIR', gains: equalizerPresets.jazz },
      { name: 'Ten bands', gains: equalizerPresets.jazz },
      ...Array.from({ length: 31 }, (_, index) => ({ name: 'Profile ' + index, gains: equalizerPresets.flat })),
    ],
  });
  equal(settings.eqProfile, 'éclair');
  equal(settings.eqProfiles.length, maxEqualizerProfiles);
  deepEqual(settings.eqProfiles.slice(0, 2), [
    { name: 'Éclair', gains: [1, 2, 3, 4, 5] },
    { name: 'Ten bands', gains: equalizerPresets.jazz },
  ]);
  equal(settings.eqProfiles.at(-1).name, 'Profile 27');
  equal(equalizerProfileName('  ' + 'a'.repeat(51) + '  '), 'a'.repeat(48));
  equal(normalizeEqualizerSettings({ eqProfile: 'missing', eqProfiles: settings.eqProfiles }).eqProfile, '');
});
