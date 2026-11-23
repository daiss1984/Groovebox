import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKaraoke } from '../public/karaoke-formats.js';

test('YRC preserves absolute millisecond timing from independent line and word intervals', () => {
  const [line] = parseKaraoke('\uFEFF[ti:测试]\r\n[1845,541](1870,198,0)早 (2154,312,0)点', '原曲.YRC');
  assert.deepEqual(line, {
    time: 1.845, endTime: 2.386, text: '早 点',
    words: [
      { time: 1.87, endTime: 2.068, text: '早 ' },
      { time: 2.154, endTime: 2.466, text: '点' },
    ],
  });
});

test('QRC retains literal parentheses and marks the lyric fragment before each timestamp', () => {
  const [line] = parseKaraoke('[3250,900]醒 (和声)(3260,385)来(3645,480)！', '.qrc');
  assert.deepEqual(line, {
    time: 3.25, endTime: 4.15, text: '醒 (和声)来！',
    words: [
      { time: 3.26, endTime: 3.645, text: '醒 (和声)' },
      { time: 3.645, endTime: 4.125, text: '来！' },
    ],
  });
});

test('QRC reads LyricContent from plaintext XML, independent of attribute order and quoting', () => {
  const source = `<?xml version="1.0"?>
<QrcInfos><LyricInfo LyricCount="2">
  <Lyric_1 LyricContent='[ti:测试]&#10;[5000,300]&quot;A &amp; B&quot;(5000,300)&#x0A;[5450,300]&lt;字&gt;(5450,300)' LyricType="1" />
  <Lyric_2 LyricType="2" LyricContent="[5000,300]第二首(5000,300)" />
</LyricInfo></QrcInfos>`;
  const lyrics = parseKaraoke(source);
  assert.deepEqual(lyrics.map(line => line.text), ['"A & B"', '<字>']);
  assert.equal(lyrics[1].words[0].time, 5.45);
  assert.equal(lyrics[1].words[0].endTime, 5.75);
});

test('KRC detects plaintext, converts offsets relative to each line, and skips metadata', () => {
  const source = '[language:bm90LWFjdHVhbC1tZXRhZGF0YQ==]\r[10000,900]<20,220,0>潮 <430,330,0>汐';
  const [line] = parseKaraoke(source);
  assert.deepEqual(line, {
    time: 10, endTime: 10.9, text: '潮 汐',
    words: [
      { time: 10.02, endTime: 10.24, text: '潮 ' },
      { time: 10.43, endTime: 10.76, text: '汐' },
    ],
  });
});

test('YRC handles sorted output, zero duration marks, duplicate line starts and corrupt word order', () => {
  const input = [
    '[9000,100]空白拍',
    '[7000,800](7350,100,0)无(7200,130,0)序',
    '[9000,7](9000,0,0)并',
    '[612,200](630,100,0)',
  ].join('\n');
  const lyrics = parseKaraoke(input, 'yrc');
  assert.deepEqual(lyrics, [
    { time: 7, endTime: 7.8, text: '无序', words: [] },
    { time: 9, endTime: 9.1, text: '空白拍', words: [] },
    { time: 9, endTime: 9.007, text: '并', words: [{ time: 9, endTime: 9, text: '并' }] },
  ]);
});

test('removes unsafe control codes but preserves text, spaces, and valid Unicode', () => {
  const [line] = parseKaraoke('[0,1000] \u0000(0,250,0)🪷 \u007f(350,250,0) 条\u001b件 ', 'yrc');
  assert.equal(line.text, '🪷  条件');
  assert.deepEqual(line.words.map(word => word.text), ['🪷 ', ' 条件']);
});

test('declines unsupported and binary-like input without trying another encoding or XML resolver', () => {
  assert.deepEqual(parseKaraoke('[0,150](0,150,0)普通', 'track.lrc'), []);
  assert.deepEqual(parseKaraoke('[00:14.50]普通'), []);
  assert.deepEqual(parseKaraoke('98 25 B0 AC E3 02 83 68 EE FC 6C', 'qrc'), []);
  assert.deepEqual(parseKaraoke('krc1\ufffd\u0000\u0005', 'krc'), []);
  assert.deepEqual(parseKaraoke('[9007199254740990,10](0,10,0)超出范围', 'yrc'), []);
  assert.deepEqual(parseKaraoke('', 'yrc'), []);
  assert.deepEqual(parseKaraoke(`<!DOCTYPE QrcInfos SYSTEM 'https://example.invalid/lyric'>
    <QrcInfos><Lyric_1 LyricContent='&external;' LyricType='1'/></QrcInfos>`, 'qrc'), []);
});
