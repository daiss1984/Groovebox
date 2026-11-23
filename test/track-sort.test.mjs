import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTrackModified, sortNumericTracks } from '../public/track-sort.js';

test('accepts only integral file times within the Date range, including epoch and pre-epoch', () => {
  for (const value of [0, -1000, 8_640_000_000_000_000, -8_640_000_000_000_000]) {
    equal(normalizeTrackModified(value), value);
  }
  for (const value of [undefined, null, '', '1000', false, Infinity, NaN, 1.5, 8_640_000_000_000_001]) {
    equal(normalizeTrackModified(value), undefined);
  }
});

test('sorts release years ascending with unknown first and stable duplicate occurrences', () => {
  const late = { title: 'A late song', releaseYear: 2024 };
  const first = { title: 'Zulu song', releaseYear: '1999-10-13' };
  const second = { title: 'Alpha song', releaseYear: 1999 };
  const unknown = { title: 'Unknown', releaseYear: 0 };
  const invalid = { title: 'Invalid', releaseYear: 'recent' };
  const tracks = Object.freeze([late, first, unknown, second, first, invalid]);
  deepEqual(sortNumericTracks(tracks, 'release-year'), [unknown, invalid, first, second, first, late]);
});

test('uses provider file mtime for modification but aliases date added only for local and WebDAV', () => {
  const local = { provider: 'local', modified: 200 };
  const dav = { provider: 'webdav', modified: 100 };
  const server = { provider: 'subsonic', modified: 300 };
  const earlier = { provider: 'local', modified: -20 };
  const missing = { provider: 'webdav' };
  const epoch = { provider: 'local', modified: 0 };
  const tracks = Object.freeze([local, dav, server, earlier, missing, epoch]);
  deepEqual(sortNumericTracks(tracks, 'added-at'), [earlier, server, missing, epoch, dav, local]);
  deepEqual(sortNumericTracks(tracks, 'added-at-desc'), [local, dav, server, missing, epoch, earlier]);
  deepEqual(sortNumericTracks(tracks, 'modified-at'), [earlier, missing, epoch, dav, local, server]);
  deepEqual(sortNumericTracks(tracks, 'modified-at-desc'), [server, local, dav, missing, epoch, earlier]);
});
