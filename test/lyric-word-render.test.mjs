import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLyrics } from '../public/library.js';
import { lyricWordFrame, normalizeWordRenderMode } from '../public/lyric-word-render.js';

// The enhanced LRC fixture played in the Cotton 5.4.2 native reference.
const [asymmetric] = parseLyrics(
  '[00:04]<00:04>Alpha <00:05>BravoLong <00:12>Charlie <00:14>Delta <00:20>',
);
const [gapLine] = parseLyrics(
  '[00:04]<00:05>Pine <00:06.50> <00:08>MeadowLong <00:12> <00:13>Dusk<00:14>',
);

const frame = (mode, position, line = asymmetric, context = {}) => lyricWordFrame(line, position, { mode, ...context });

test('unknown saved settings use native default and Off leaves a whole line visible', () => {
  for (const value of [undefined, null, {}, '', 'unknown']) {
    assert.equal(normalizeWordRenderMode(value), 'opacity-gradient');
  }
  for (const mode of ['off', 'opacity-gradient', 'slide-uniform', 'slide-accurate']) {
    assert.equal(normalizeWordRenderMode(mode), mode);
  }
  assert.deepEqual(frame('off', 8), { opacities: [1, 1, 1, 1], progress: 1 });
  assert.deepEqual(frame('slide-uniform', 2, { time: 2, text: 'Line only' }), { opacities: [], progress: 1 });
});

test('the default mode fades the whole current word and leaves past and future words distinct', () => {
  assert.deepEqual(frame(undefined, 4), { opacities: [0.5, 0.35, 0.35, 0.35], progress: 1 });
  assert.deepEqual(frame(undefined, 4.25).opacities, [0.578125, 0.35, 0.35, 0.35]);
  assert.deepEqual(frame(undefined, 8.5).opacities, [1, 0.75, 0.35, 0.35]);
  assert.deepEqual(frame(undefined, 12).opacities, [1, 1, 0.5, 0.35]);
  assert.deepEqual(frame(undefined, 20).opacities, [1, 1, 1, 1]);
  assert.deepEqual(frame(undefined, 5).opacities, [1, 0.5, 0.35, 0.35]);
});

test('the two slide clips match measured asymmetric native frames', () => {
  // Pixel clip bounds measured on raw Retina captures. The calibrated time is
  // estimated from the public seek slider, so allow 1.5% of rendered line width.
  const lineLeft = 1122;
  const lineWidth = 651;
  const capture = [
    { time: 4.65, uniform: [1147, 1149], accurate: [1227, 1229] },
    { time: 8.14, uniform: [1289, 1290], accurate: [1356, 1358] },
    { time: 10.16, uniform: [1371, 1372], accurate: [1400, 1405] },
    { time: 12.60, uniform: [1469, 1471], accurate: [1478, 1497] },
    { time: 17.13, uniform: [1644, 1663], accurate: [1687, 1694] },
  ];
  for (const { time, uniform, accurate } of capture) {
    for (const [mode, [dark, dim]] of [['slide-uniform', uniform], ['slide-accurate', accurate]]) {
      const clip = lineLeft + frame(mode, time).progress * lineWidth;
      assert(clip >= dark - lineWidth * 0.015 && clip <= dim + lineWidth * 0.015, `${mode} at ${time}: ${clip}`);
    }
  }
  assert.equal(frame('slide-accurate', 5).progress, 0.25);
  assert.equal(frame('slide-accurate', 12).progress, 0.5);
  assert.equal(frame('slide-accurate', 14).progress, 0.75);
});

test('uniform slides between the first and last words across explicit cue gaps', () => {
  const line = gapLine;
  const context = { nextTime: 22, duration: 64 };
  assert.equal(frame('slide-uniform', 4.8, line, context).progress, 0);
  assert.equal(frame('slide-uniform', 9.5, line, context).progress, 0.5);
  assert.equal(frame('slide-uniform', 14, line, context).progress, 1);
  assert.equal(frame('slide-uniform', 21, line, context).progress, 1);
  assert.deepEqual(frame('opacity-gradient', 4.8, line, context).opacities, [0.35, 1, 0.35, 1, 0.35]);
  assert.deepEqual(frame('opacity-gradient', 7, line, context).opacities, [1, 1, 0.35, 1, 0.35]);
  assert.deepEqual(frame('opacity-gradient', 21, line, context).opacities, [1, 1, 1, 1, 1]);
});

test('accurate slides reproduce the native rewind through a timed whitespace gap', () => {
  const line = gapLine;
  assert.equal(line.words.length, 5);
  const lineLeft = 1122;
  const lineWidth = 528;
  for (const [time, dark, dim] of [[6.82, 1250, 1252], [11.90, 1462, 1470], [12.11, 1312, 1314]]) {
    const clip = lineLeft + frame('slide-accurate', time, line).progress * lineWidth;
    assert(clip >= dark - 8 && clip <= dim + 8, `native clip at ${time}: ${clip}`);
  }
  assert(frame('slide-accurate', 12.11, line).progress < frame('slide-accurate', 11.90, line).progress);
  assert.equal(frame('slide-accurate', 5, line).progress, 0);
  assert.equal(frame('slide-accurate', 8, line).progress, 1 / 3);
  assert.equal(frame('slide-accurate', 13, line).progress, 2 / 3);
  assert.equal(frame('slide-accurate', 14, line).progress, 1);
});

test('implicitly timed enhanced LRC uses the next boundary and leaves input untouched', () => {
  const [line, next] = parseLyrics('[00:04]<00:04>Alpha <00:05>BravoLong\n[00:12]Next line');
  Object.freeze(line);
  line.words.forEach(Object.freeze);
  Object.freeze(line.words);
  const context = { nextTime: next.time, duration: 64 };
  assert.equal(frame('slide-uniform', 8, line, context).progress, 0.5);
  assert.equal(frame('slide-accurate', 5, line, context).progress, 0.5);
  assert.equal(frame('slide-uniform', 8, { ...line, endTime: 10 }, context).progress, 2 / 3);
  assert.equal(frame('slide-uniform', 8, line, { duration: 20 }).progress, 0.25);
});

test('negative seek, missing ends and malformed timing have deterministic rendering', () => {
  const line = {
    time: 2,
    words: [
      { time: -1, text: 'Bad' },
      { time: 2, endTime: 1, text: 'Valid' },
      { time: NaN, text: 'Untimed' },
      { time: 3, endTime: 3, text: 'Instant' },
    ],
  };
  assert.deepEqual(frame(undefined, -2, line).opacities, [1, 0.35, 1, 0.35]);
  assert.deepEqual(frame(undefined, NaN, line).opacities, [1, 0.35, 1, 0.35]);
  assert.deepEqual(frame(undefined, 2.5, line).opacities, [1, 0.75, 1, 0.35]);
  assert.deepEqual(frame(undefined, 3, line).opacities, [1, 1, 1, 1]);
  assert.equal(frame('slide-uniform', 3, line).progress, 1);
  assert.equal(frame('slide-accurate', 3, { ...line, time: -1 }).progress, 1);
});
