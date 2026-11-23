import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automaticEvictions, checkAutomaticCache, offlineCacheStats, validAudioCacheLimit } from '../public/offline-policy.js';

const mib = 1024 * 1024;
const policy = { limitMiB: 200, generation: 4, paused: false };

test('enforces the minimum integer capacity and fences stale or paused automatic writes', () => {
  for (const limit of [undefined, '200', 199, 200.1, Infinity, Number.MAX_SAFE_INTEGER]) assert.equal(validAudioCacheLimit(limit), false);
  assert.equal(validAudioCacheLimit(200), true);
  assert.equal(validAudioCacheLimit(1024), true);
  assert.throws(() => checkAutomaticCache(policy, 3, 1), { code: 'offline-cache-stale' });
  assert.throws(() => checkAutomaticCache({ ...policy, paused: true }, 4, 1), { code: 'offline-cache-paused' });
  assert.throws(() => checkAutomaticCache(policy, 4, 200 * mib + 1), { code: 'offline-cache-limit' });
  assert.doesNotThrow(() => checkAutomaticCache(policy, 4, 200 * mib));
});

test('budgets automatic audio bytes only and reports attached artwork separately from actual pinned audio', () => {
  const entries = [
    { id: 'recent', mode: 'automatic', bytes: 97 * mib, coverBytes: 20, lastAccess: 3 },
    { id: 'pinned', mode: 'pinned', bytes: 128 * mib, coverBytes: 42, lastAccess: 0 },
    { id: 'old', mode: 'automatic', bytes: 97 * mib, coverBytes: 15, lastAccess: 2 },
  ];
  assert.deepEqual(automaticEvictions(entries, 200, 6 * mib), []);
  assert.deepEqual(automaticEvictions(entries, 200, 6 * mib + 1), ['old']);
  assert.deepEqual(automaticEvictions(entries, 200, 190 * mib), ['old', 'recent']);
  assert.deepEqual(entries.map(entry => entry.id), ['recent', 'pinned', 'old']);
  assert.deepEqual(offlineCacheStats(policy, entries), {
    limitMiB: 200, generation: 4, paused: false, automaticBytes: 194 * mib, automaticCount: 2, pinnedBytes: 128 * mib,
    pinnedCount: 1, automaticArtworkBytes: 35, pinnedArtworkBytes: 42, attachedArtworkBytes: 77, totalBytes: 322 * mib + 77,
  });
});
