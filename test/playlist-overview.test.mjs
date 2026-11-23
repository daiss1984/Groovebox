import assert from 'node:assert/strict';
import { test } from 'node:test';
import { datesAfterPlaylistChanges, normalizePlaylistCreatedAt, normalizePlaylistOverviewOrder, playlistContents,
  readPlaylistCreationDates, sortPlaylistOverview } from '../public/playlist-overview.js';

const list = (id, name) => Object.freeze({ id, name, tracks: Object.freeze(['demo-1', 'demo-2']) });
const manual = Object.freeze([
  list('legacy-z', 'Zulu'),
  list('newest', 'Alpha'),
  list('earliest', 'Middle'),
  list('another-name-equal', 'Alpha'),
  list('legacy-x', 'Legacy'),
  list('same-created-at', 'Beta'),
]);
const createdAt = new Map([['newest', 300], ['earliest', 100], ['another-name-equal', 200], ['same-created-at', 200]]);
const compareNames = new Intl.Collator('en', { sensitivity: 'base' }).compare;
const options = { compareNames, createdAt };
const ids = values => values.map(item => item.id);
const sort = order => ids(sortPlaylistOverview(manual, order, options));

test('manual and unknown preferences preserve the canonical array and each playlist object', () => {
  for (const value of ['manual', undefined, 'invalid', {}]) {
    assert.equal(normalizePlaylistOverviewOrder(value), 'manual');
    assert.equal(sortPlaylistOverview(manual, value, options), manual);
  }
});

test('name sorting runs in both directions and leaves equal names in manual order', () => {
  assert.deepEqual(sort('name'), ['newest', 'another-name-equal', 'same-created-at', 'legacy-x', 'earliest', 'legacy-z']);
  assert.deepEqual(sort('name-desc'), ['legacy-z', 'earliest', 'legacy-x', 'same-created-at', 'newest', 'another-name-equal']);
  assert.equal(sortPlaylistOverview(manual, 'name', options)[0], manual[1]);
  assert.deepEqual(sort('manual'), ids(manual));
});

test('creation sorting puts unknown dates last and retains manual order for ties and unknown dates', () => {
  assert.deepEqual(sort('created-at'), ['earliest', 'another-name-equal', 'same-created-at', 'newest', 'legacy-z', 'legacy-x']);
  assert.deepEqual(sort('created-at-desc'), ['newest', 'another-name-equal', 'same-created-at', 'earliest', 'legacy-z', 'legacy-x']);
  const mixed = new Map([['legacy-z', '1'], ['newest', 1], ['earliest', NaN], ['same-created-at', -1]]);
  assert.deepEqual(ids(sortPlaylistOverview(manual, 'created-at-desc', { compareNames, createdAt: mixed })),
    ['newest', 'legacy-z', 'earliest', 'another-name-equal', 'legacy-x', 'same-created-at']);
});

test('sorts by known modification timestamps independently of creation timestamps', () => {
  const modifiedAt = new Map([['legacy-z', 0], ['earliest', 300], ['same-created-at', 300], ['legacy-x', 100]]);
  assert.deepEqual(ids(sortPlaylistOverview(manual, 'modified-at-desc', { ...options, modifiedAt })),
    ['earliest', 'same-created-at', 'legacy-x', 'legacy-z', 'newest', 'another-name-equal']);
});

test('timestamps new playlists, renames and changes in repeat counts, preserving legacy and reorder-only dates', () => {
  const changed = { id: 'membership', name: 'Count', tracks: ['a', 'b', 'a'] };
  const reordered = { id: 'reorder', name: 'Order', tracks: ['a', 'b', 'a'] };
  const renamed = { id: 'name', name: 'Previous', tracks: [] };
  const legacy = { id: 'legacy', name: 'Old', tracks: [] };
  const before = playlistContents([changed, reordered, renamed, legacy]);
  changed.tracks.splice(2, 1, 'b');
  reordered.tracks.splice(1, 2, 'a', 'b');
  renamed.name = 'Renamed';
  const recent = { id: 'new', name: 'New', tracks: [] };
  const dates = datesAfterPlaylistChanges(before, playlistContents([renamed, legacy, recent, reordered, changed]), {
    createdAt: new Map([['reorder', 100], ['membership', 110], ['name', 120]]),
    modifiedAt: new Map([['reorder', 140], ['membership', 150]]),
  }, 200);
  assert.deepEqual(Object.fromEntries(dates.createdAt), { name: 120, new: 200, reorder: 100, membership: 110 });
  assert.deepEqual(Object.fromEntries(dates.modifiedAt), { name: 200, new: 200, reorder: 140, membership: 200 });
});

test('renaming a playlist only changes its displayed name order and retains its track IDs and creation order', () => {
  const renamed = manual.map(item => item.id === 'earliest' ? { ...item, name: 'Aardvark' } : item);
  assert.equal(sortPlaylistOverview(renamed, 'name', options)[0], renamed[2]);
  assert.deepEqual(ids(sortPlaylistOverview(renamed, 'created-at-desc', options)), sort('created-at-desc'));
  assert.equal(renamed[2].tracks, manual[2].tracks);
  assert.equal(manual[2].name, 'Middle');
});

test('creation time accepts only safe JSON millisecond numbers within the Date range', () => {
  for (const timestamp of [0, 1000, 8_640_000_000_000_000]) {
    assert.equal(normalizePlaylistCreatedAt(timestamp), timestamp);
  }
  for (const malformed of [undefined, null, '1000', 1.5, Infinity, NaN, -1, 8_640_000_000_000_001]) {
    assert.equal(normalizePlaylistCreatedAt(malformed), undefined);
  }
});

test('ignores missing, invalid, duplicate and unrecognized saved creation dates', () => {
  assert.deepEqual([...readPlaylistCreationDates(undefined, manual)], []);
  const restored = readPlaylistCreationDates([
    ['newest', 300], ['unrecognized', 50], ['newest', 100], ['earliest', '100'], ['legacy-x', 20, 'extra'],
    ['another-name-equal', 200], ['same-created-at', -1], null,
  ], manual);
  assert.deepEqual([...restored], [['newest', 300], ['another-name-equal', 200]]);
});
