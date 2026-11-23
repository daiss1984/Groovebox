import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackHistoryRecorder } from '../public/playback-history.js';

function played(...ranges) {
  return { length: ranges.length, start: index => ranges[index][0], end: index => ranges[index][1] };
}

test('counts measured playback once after half a short track or three minutes of a long track', () => {
  let time = 1000;
  const entries = [];
  const update = createPlaybackHistoryRecorder(entry => entries.push(entry), () => time);
  const short = { track: { id: 'short' }, duration: 90 };
  const long = { track: { id: 'long' }, duration: 500 };
  const first = { token: Symbol() };
  const second = { token: Symbol() };

  update(short, first, played([0, 20], [64, 88]));
  assert.deepEqual(entries, []);
  ++time;
  update(short, first, played([0, 20], [64, 89]));
  update(short, first, played([0, 20], [64, 90]));
  assert.deepEqual(entries, [{ id: 'short', at: 1000 }]);

  update(long, second, played([0, 80], [370, 469]));
  assert.equal(entries.length, 1);
  ++time;
  update(long, second, played([0, 80], [370, 470]));
  update(long, second, played([0, 80], [370, 490]));
  assert.deepEqual(entries, [{ id: 'short', at: 1000 }, { id: 'long', at: 1001 }]);
});
