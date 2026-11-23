import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStreamBitrates, preferredStreamBitrate, supportsStreamBitrate } from '../public/stream-bitrate.js';

test('uses a precise connection type or an explicit choice for streaming bitrate', () => {
  const profiles = normalizeStreamBitrates({ wifi: 192, cellular: 96 });
  assert.equal(preferredStreamBitrate(profiles, { type: 'wifi' }), 192);
  assert.equal(preferredStreamBitrate(profiles, { type: 'ethernet' }), 192);
  assert.equal(preferredStreamBitrate(profiles, { type: 'cellular' }), 96);
  assert.equal(preferredStreamBitrate(profiles, { effectiveType: '4g' }), 0);
  assert.equal(preferredStreamBitrate({ ...profiles, network: 'wifi' }, { type: 'cellular' }), 192);
  assert.equal(preferredStreamBitrate({ ...profiles, network: 'cellular' }), 96);
  assert.deepEqual(normalizeStreamBitrates({ network: '5g', wifi: '64', cellular: 321 }), { network: 'auto', wifi: 0, cellular: 0 });
  assert.equal(supportsStreamBitrate('navidrome'), true);
  assert.equal(supportsStreamBitrate('baidu'), false);
});
