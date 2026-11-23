import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLyrics } from '../public/library.js';

test('preserves plain line timing, repeated stamps, and lyric text', () => {
  const source = '\uFEFF[ti:清晨]\r\n[00:05.200][00:01:50]  夜风 [00:30] 静静吹。 \r\n[00:63]无效\r\n[00:03.2]\r\n';
  assert.deepEqual(parseLyrics(source), [
    { time: 1.5, text: '夜风 [00:30] 静静吹。' },
    { time: 5.2, text: '夜风 [00:30] 静静吹。' },
  ]);
});

test('enhanced LRC preserves word times, punctuation and spaces', () => {
  const [line] = parseLyrics('[00:12.34]<00:12.34> 第一 <00:12.89><b>行，</b><00:13.456>歌词！<00:14.55> ');
  assert.deepEqual(line, {
    time: 12.34,
    text: '第一 行，歌词！',
    words: [
      { time: 12.34, text: '第一 ', endTime: 12.89 },
      { time: 12.89, text: '行，', endTime: 13.456 },
      { time: 13.456, text: '歌词！', endTime: 14.55 },
    ],
  });
  assert.equal(line.words.map(word => word.text).join(''), line.text);
});

test('enhanced LRC includes untimed prefixes and applies offsets to repeated lines', () => {
  const source = '[offset:-1250]\n[00:01.000][00:31.000] Hello <00:01.625>世界';
  assert.deepEqual(parseLyrics(source), [
    { time: 0, text: 'Hello 世界', words: [{ time: 0, text: 'Hello ', endTime: 0.375 }, { time: 0.375, text: '世界' }] },
    { time: 29.75, text: 'Hello 世界', words: [{ time: 29.75, text: 'Hello ', endTime: 30.375 }, { time: 30.375, text: '世界' }] },
  ]);
  assert.deepEqual(parseLyrics('[00:00] Intro<00:02.000>'), [{ time: 0, text: 'Intro' }]);
});

test('enhanced LRC preserves leading, interior and trailing lyric gaps through repeated timestamps and offset', () => {
  const source = '[offset:-500]\n[00:04][00:24]<00:05>Pine <00:06.5> <00:08>Meadow <00:12> <00:13>Dusk<00:14>\n[00:42]Next';
  const [first, repeated, next] = parseLyrics(source);
  assert.equal(first.time, 3.5);
  assert.equal(first.text, 'Pine  Meadow  Dusk');
  assert.deepEqual(first.words, [
    { time: 4.5, text: 'Pine ', endTime: 6 },
    { time: 6, text: ' ', endTime: 7.5 },
    { time: 7.5, text: 'Meadow ', endTime: 11.5 },
    { time: 11.5, text: ' ', endTime: 12.5 },
    { time: 12.5, text: 'Dusk', endTime: 13.5 },
  ]);
  assert.equal(repeated.time, 23.5);
  assert.deepEqual(repeated.words.at(-1), { time: 32.5, text: 'Dusk', endTime: 33.5 });
  assert.deepEqual(next, { time: 41.5, text: 'Next' });
});

test('LRC groups exact shared times with every translation and keeps the primary word timings', () => {
  const source = '[offset:-1000]\n[00:00.500]Opening\n[00:01.000][00:05.000]<00:01.000>Good <00:01.500>morning' +
    '\n[00:01.000][00:05.000]早上好\n[00:01.000]Buenos días\n[00:01.000]早上好\n[00:05.000]Bonjour';
  assert.deepEqual(parseLyrics(source), [
    { time: 0, text: 'Opening' },
    { time: 0, text: 'Good morning', translation: '早上好\nBuenos días',
      words: [{ time: 0, text: 'Good ', endTime: .5 }, { time: .5, text: 'morning' }] },
    { time: 4, text: 'Good morning', translation: '早上好\nBonjour',
      words: [{ time: 4, text: 'Good ', endTime: 4.5 }, { time: 4.5, text: 'morning' }] },
  ]);
});

test('LRC preserves independent word-timed lyric rows with the same start', () => {
  assert.deepEqual(parseLyrics('[00:02.000]<00:02.000>Lead\n[00:02.000]<00:03.500>Answer'), [
    { time: 2, text: 'Lead', words: [{ time: 2, text: 'Lead' }] },
    { time: 2, text: 'Answer', words: [{ time: 3.5, text: 'Answer' }] },
  ]);
});

test('WebVTT parses multiline timestamp tags, entities and cue classes as plain text', () => {
  const source = [
    'WEBVTT', '', 'first-cue', '00:01:00.000 --> 00:01:06.250 position:10%',
    '<v Music>Hello &amp; <c.friend><00:01:02.250>世界</c>',
    '<00:01:04.000>&lt;literal&gt;</v>', '',
    'NOTE hidden text', 'this cue must be skipped', '',
    '01:07.000 --> 01:08.000', '<i>普通一行</i>',
  ].join('\n');
  assert.deepEqual(parseLyrics(source, 'track.VTT'), [
    { time: 60, text: 'Hello & 世界\n<literal>', words: [
      { time: 60, text: 'Hello & ', endTime: 62.25 },
      { time: 62.25, text: '世界\n', endTime: 64 },
      { time: 64, text: '<literal>', endTime: 66.25 },
    ] },
    { time: 67, text: '普通一行' },
  ]);
});

test('WebVTT ignores invalid inline boundaries without discarding lyric text', () => {
  const source = [
    'WEBVTT', '', '00:01.000 --> 00:04.000',
    '<00:01.000>等起点 <00:00.999>过早 <00:02.000>有效 <00:01.500>倒退 <00:03.345>又有效 <00:04.000>等终点 <00:05.000>超出',
  ].join('\n');
  assert.deepEqual(parseLyrics(source), [{
    time: 1,
    text: '等起点 过早 有效 倒退 又有效 等终点 超出',
    words: [
      { time: 1, text: '等起点 过早 ', endTime: 2 },
      { time: 2, text: '有效 倒退 ', endTime: 3.345 },
      { time: 3.345, text: '又有效 等终点 超出', endTime: 4 },
    ],
  }]);
});
