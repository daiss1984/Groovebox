import assert from 'node:assert/strict';
import test from 'node:test';
import { matchM3u, maxM3uBytes, parseM3u } from '../public/m3u.js';

const encode = value => new TextEncoder().encode(value);
const local = (id, path, artist = '', title = '') => ({ id, path, artist, title, provider: 'local' });

test('preserves the imported title, BOM-safe Windows paths and extended entry tags', () => {
  const result = parseM3u(encode('\uFEFF#EXTM3U\r\n#PLAYLIST: 雨 & 夜\r\n#EXTART: 飞鸟\r\n#EXTINF:123,曲目, II\r\nC:\\音乐\\一.wav\r\n# note\r\n../二.mp3\r\n'), 'original.m3u8');
  assert.deepEqual(result, {
    name: '雨 & 夜',
    entries: [
      { artist: '飞鸟', detail: '曲目, II', path: 'C:\\音乐\\一.wav' },
      { artist: '', detail: '', path: '../二.mp3' },
    ],
  });
  assert.equal(parseM3u(encode('song.wav'), '静夜.2026.M3U').name, '静夜.2026');
  assert.equal(parseM3u(Buffer.concat([Buffer.from([255, 254]), Buffer.from('歌.wav', 'utf16le')]), '歌单.m3u').entries[0].path, '歌.wav');
  assert.equal(parseM3u(Buffer.from('#EXTENC:windows-1252\nCafé.wav', 'latin1'), 'legacy.m3u').entries[0].path, 'Café.wav');
});

test('only resolves trusted local tracks, preserving order and refusing ambiguity and duplicate entries', () => {
  const data = parseM3u(encode([
    'C:\\Archive\\One\\Music\\Album B\\共同.flac',
    'file://localhost/private/Music/Album%20A/%E5%85%B1%E5%90%8C.flac',
    '#EXTINF:-1,艺人乙 - 再见', '共同.flac',
    '#EXTINF:-1,艺人甲 - 再见', '共同.flac',
    '共同.flac',
    './single.wav',
    'https://example.test/single.wav',
    'file://remote/single.wav',
    'file:////remote/single.wav',
    '//example.test/single.wav',
    'data:audio/mp3,a',
    'Cloud Only.wav',
    'missing.wav',
  ].join('\n')), 'mixed.m3u8');
  const output = matchM3u(data.entries, [
    local('a', 'Music/Album A/共同.flac', '艺人甲', '再见'),
    local('b', 'Music/Album B/共同.flac', '艺人乙', '再见'),
    local('c', 'Other/共同.flac', '第三位', '其他'),
    local('unique', 'Music/single.wav'),
    { ...local('cloud-only', 'Cloud Only.wav'), provider: 'baidu' },
  ]);
  assert.deepEqual(output, { trackIds: ['b', 'a', 'unique'], skipped: 10 });
  const ambiguous = parseM3u(encode('#EXTINF:-1,艺人甲 - 再见\n共同.flac'), 'tags.m3u');
  assert.deepEqual(matchM3u(ambiguous.entries, [
    local('a', 'Music/A/共同.flac', '艺人甲', '再见'), local('b', 'Music/B/共同.flac', '艺人乙', '再见'),
  ]), { trackIds: ['a'], skipped: 0 });
});

test('rejects streams, invalid UTF-8 M3U8 and oversized inputs', () => {
  assert.throws(() => parseM3u(encode('#EXTM3U\n#EXT-X-TARGETDURATION:8\none.aac'), 'live.m3u8'), { code: 'stream' });
  assert.throws(() => parseM3u(Uint8Array.of(0xff, 0x00), 'bad.m3u8'), { code: 'encoding' });
  assert.throws(() => parseM3u(encode('#EXTENC:unrecognized-charset\nsong.wav'), 'bad.m3u'), { code: 'encoding' });
  assert.throws(() => parseM3u(new Uint8Array(maxM3uBytes + 1), 'huge.m3u'), { code: 'too-large' });
  assert.throws(() => parseM3u(encode('track.mp3\n'.repeat(10001)), 'huge.m3u'), { code: 'too-large' });
});

test('matches indexed cloud proxy URLs and exact WebDAV URLs without accepting new external sources', () => {
  const origin = 'http://localhost:5187';
  const path = '/Music/Caf%C3%A9%20session.flac';
  const proxy = '/api/sources/first/stream?id=known';
  const baidu = '/api/baidu/stream?id=123';
  const tracks = [
    { id: 'dav', title: 'Recording', provider: 'webdav', src: proxy, playlistLocation: 'https://nas.example' + path },
    { id: 'other', title: 'Recording', provider: 'webdav', src: '/api/sources/second/stream?id=known',
      playlistLocation: 'https://second.example' + path },
    { id: 'baidu', title: 'Baidu', provider: 'baidu', src: baidu },
  ];
  const { entries } = parseM3u(encode([
    origin + baidu, 'https://nas.example' + path, proxy, 'https://second.example' + path,
    'https://elsewhere.example' + path, 'https://account:pass@nas.example' + path,
    'https://nas.example' + path + '?access=unknown', 'http://another.test' + baidu,
  ].join('\n')), 'cloud.m3u8');
  assert.deepEqual(matchM3u(entries, tracks, origin), { trackIds: ['baidu', 'dav', 'other'], skipped: 5 });
  assert.deepEqual(matchM3u([{ path: 'https://nas.example' + path }], [
    ...tracks, { ...tracks[0], id: 'shared-user', src: '/api/sources/shared/stream?id=known' },
  ], origin), { trackIds: [], skipped: 1 });
  const cohosted = { ...tracks[0], playlistLocation: origin + '/api/dav' + path };
  assert.deepEqual(matchM3u([{ path: cohosted.playlistLocation }], [cohosted], origin), { trackIds: ['dav'], skipped: 0 });
});

test('matches a Subsonic library export by catalog file paths and leaves ambiguous provider paths unresolved', () => {
  const track = (id, album) => ({ id, provider: 'navidrome', title: 'Opening', artist: album,
    src: '/api/sources/source-one/stream?id=' + id, playlistLocation: album + '/01.flac' });
  const a = track('a', 'A');
  const b = track('b', 'B');
  const origin = 'http://localhost:5187';
  const entries = parseM3u(encode('C:\\Music\\B\\01.flac\n./A/01.flac\n01.flac\nhttps://nas.test/A/01.flac'), 'portable.m3u').entries;
  assert.deepEqual(matchM3u(entries, [a, b], origin), { trackIds: ['b', 'a'], skipped: 2 });
  assert.deepEqual(matchM3u([{ path: 'A/01.flac' }], [a, { ...a, id: 'other', src: '/api/sources/other/stream?id=two' }], origin),
    { trackIds: [], skipped: 1 });
  const tagged = parseM3u(encode('#EXTINF:10,A - Opening\n/volume/unmapped.wav\n#EXTINF:10,B - Opening\nhttps://new.test/unmapped.wav'), 'exported.m3u').entries;
  assert.deepEqual(matchM3u(tagged, [a, b], origin), { trackIds: ['a'], skipped: 1 });
  assert.deepEqual(matchM3u(tagged, [a, b, { ...a, id: 'other', src: '/api/sources/other/stream?id=two' }], origin),
    { trackIds: [], skipped: 2 });
});
