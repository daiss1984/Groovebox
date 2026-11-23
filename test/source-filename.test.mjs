import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFilenamePattern, defaultFilenamePattern } from '../public/source-filename.js';

test('follows all five official filename examples', () => {
  const cases = [
    ['name', '快乐崇拜.mp3', { title: '快乐崇拜' }],
    ['name-artist', '快乐崇拜-潘玮柏.mp3', { title: '快乐崇拜', artist: '潘玮柏' }],
    ['name_artist', '快乐崇拜_潘玮柏.mp3', { title: '快乐崇拜', artist: '潘玮柏' }],
    ['track-name-artist', '1-快乐崇拜-潘玮柏.mp3', { title: '快乐崇拜', artist: '潘玮柏', trackNumber: 1 }],
    ['track-name', '1-快乐崇拜.mp3', { title: '快乐崇拜', trackNumber: 1 }],
  ];
  for (const [pattern, filename, expected] of cases) assert.deepEqual(compileFilenamePattern(pattern)(filename), expected);
});

test('defaults to the whole stem without splitting metadata or mutating the source filename', () => {
  assert.equal(defaultFilenamePattern, 'name');
  const source = Object.freeze({ filename: 'Artist - Title.Title.FLAC', folder: 'Music' });
  assert.deepEqual(compileFilenamePattern()(source.filename, source.folder), { title: 'Artist - Title.Title' });
  assert.equal(source.filename, 'Artist - Title.Title.FLAC');
  assert.deepEqual(compileFilenamePattern()('extensionless'), { title: 'extensionless' });
  assert.deepEqual(compileFilenamePattern()('.hidden'), { title: '.hidden' });
  assert.deepEqual(compileFilenamePattern()('海洋.'), { title: '海洋.' });
});

test('matches separators literally, including a different separator between fields', () => {
  const parse = compileFilenamePattern(' track.[name] + artist ');
  assert.deepEqual(parse('005.[Sea.Mix] + 海.flac'), { title: 'Sea.Mix', artist: '海', trackNumber: 5 });
  assert.deepEqual(parse('005x[Sea.Mix] + 海.flac'), { title: '005x[Sea.Mix] + 海' });
  assert.deepEqual(compileFilenamePattern('artist｜name')('王菲｜人间.FLAC'), { title: '人间', artist: '王菲' });
  assert.deepEqual(compileFilenamePattern('name·track·artist')('Sea·015·Guest.mp3'), { title: 'Sea', artist: 'Guest', trackNumber: 15 });
});

test('falls back when the configured complete parse is missing or malformed', () => {
  const parse = compileFilenamePattern('track-name-artist');
  for (const filename of ['Missing separators.mp3', 'Artist-Title.mp3', 'x-Title-Artist.mp3', '1--Artist.mp3',
    '1-Title- .mp3', '9007199254740992-Title-Artist.mp3', '1.5-Title-Artist.mp3']) {
    assert.deepEqual(parse(filename), { title: filename.slice(0, -4) });
  }
});

test('does not guess ambiguous separator placement and preserves hyphens in unambiguous titles', () => {
  assert.deepEqual(compileFilenamePattern('name-artist')('Sun-Rise-Guest.mp3'), { title: 'Sun-Rise-Guest' });
  assert.deepEqual(compileFilenamePattern('track-name-artist')('12-Sun-Rise-Guest.mp3'), { title: '12-Sun-Rise-Guest' });
  assert.deepEqual(compileFilenamePattern('track-name')('12-Sun-Rise.mp3'), { title: 'Sun-Rise', trackNumber: 12 });
  assert.deepEqual(compileFilenamePattern('name track')('Sun Rise   02.mp3'), { title: 'Sun Rise', trackNumber: 2 });
});

test('derives a folder album and falls back to the album artist only when needed', () => {
  const parse = compileFilenamePattern('track-name-artist');
  assert.deepEqual(parse('1-On The Tide-Guest Artist.flac', 'Sea Sessions-Resident Artist'), {
    title: 'On The Tide', artist: 'Guest Artist', trackNumber: 1, album: 'Sea Sessions', albumArtist: 'Resident Artist',
  });
  assert.deepEqual(parse('On The Tide.flac', 'Sea Sessions - Resident Artist'), {
    title: 'On The Tide', artist: 'Resident Artist', album: 'Sea Sessions', albumArtist: 'Resident Artist',
  });
  for (const folder of ['Music', ' - Resident Artist', 'Compilation - ', 'Sea - Live - Resident Artist']) {
    assert.deepEqual(compileFilenamePattern()('Song.flac', folder), { title: 'Song' });
  }
});

test('rejects missing, repeated and unknown tokens, empty separators and literal affixes', () => {
  for (const pattern of ['', 'artist', 'track-artist', 'name-name', 'track-name-track', 'name-auteur',
    'nameartist', '-name', 'name-', 'NAME', 'filename', 'name-artist-genre', 'name\nartist']) {
    assert.throws(() => compileFilenamePattern(pattern), RangeError, pattern);
  }
  assert.throws(() => compileFilenamePattern(null), TypeError);
  assert.throws(() => compileFilenamePattern()(null), TypeError);
});

test('keeps malformed repeated separators bounded when track is not the first token', () => {
  const title = 'a-'.repeat(6000) + '1x';
  for (const pattern of ['name-artist-track', 'name-track-artist']) {
    assert.deepEqual(compileFilenamePattern(pattern)(title + '.mp3'), { title });
  }
  assert.deepEqual(compileFilenamePattern('artist-name-track')('Guest-Song-007.mp3'), {
    title: 'Song', artist: 'Guest', trackNumber: 7,
  });
});
