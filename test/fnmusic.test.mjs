import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { FnMusicError, prepareFnMusicSource } from '../server/fnmusic.mjs';
import { createSourcesHandler } from '../server/sources.mjs';

const credentials = { username: '音乐账号', password: 'fixture-password' };

test('fnOS Music bridge accepts the documented port and preserves explicit reverse-proxy settings', () => {
  assert.deepEqual(prepareFnMusicSource({ url: 'http://nas.local', ...credentials }), {
    url: 'http://nas.local:14040/',
    ...credentials,
  });
  assert.equal(prepareFnMusicSource({ url: 'http://127.0.0.1:23200', ...credentials }).url, 'http://127.0.0.1:23200/');
  assert.equal(prepareFnMusicSource({ url: 'http://nas.local:80', ...credentials }).url, 'http://nas.local/');
  assert.equal(prepareFnMusicSource({ url: 'https://nas.example.org/player', ...credentials }).url, 'https://nas.example.org/player');
});

test('fnOS Music bridge requires a configured address and credentials for the music account', () => {
  for (const url of [
    'fn.example.com', 'fn://nas', 'https://user:password@bridge.example.org',
    'http://nas/music', 'http://nas/music/api/v1', 'http://nas/rest',
    'https://example.org/?token=test', 'http://nas/%2fcredentials', 'http://nas#fragment',
  ]) {
    assert.throws(() => prepareFnMusicSource({ url, ...credentials }),
      error => error instanceof FnMusicError && error.status === 400, url);
  }
  assert.throws(() => prepareFnMusicSource({ url: 'http://nas', password: 'fixture-password' }), /飞牛音乐独立账号/);
  assert.throws(() => prepareFnMusicSource({ url: 'http://nas', username: '音乐账号' }), /飞牛音乐独立账号/);
});

test('the 音桥 OpenSubsonic contract uses the music account for artist and album artwork, song lyrics and Range audio', async t => {
  const requested = [];
  const handler = createSourcesHandler({ fetchImpl: async (endpoint, options) => {
    const url = new URL(endpoint);
    assert.equal(url.origin, 'http://music-nas.local:14040');
    assert.equal(options.method, 'GET');
    assert.equal(url.searchParams.get('u'), credentials.username);
    const salt = url.searchParams.get('s');
    assert.match(salt, /^[0-9a-f]{32}$/);
    assert.equal(url.searchParams.get('t'), createHash('md5').update(credentials.password + salt).digest('hex'));
    assert.equal(url.searchParams.has('p'), false);
    const action = url.pathname.match(/^\/rest\/(\w+)\.view$/)?.[1];
    requested.push(action);
    const id = url.searchParams.get('id');
    const reply = data => Response.json({ 'subsonic-response': { status: 'ok', ...data } });
    if (action === 'getArtists') return reply({ artists: { index: [{ artist: [
      { id: 'a1', name: '独立艺人', coverArt: 'artist-art' }, { id: 'a2', name: '无封面艺人' },
    ] }] } });
    if (action === 'getArtist' && id === 'a1') return reply({ artist: { album: [
      { id: 'b1', name: '现场专辑', coverArt: 'album-art' },
    ] } });
    if (action === 'getAlbum' && id === 'b1') return reply({ album: { song: [
      { id: 'c1', title: '雨夜', artist: '独立艺人', album: '现场专辑', duration: 42, suffix: 'wav', coverArt: 'song-art' },
      { id: 'c2', title: '夜风', artist: '独立艺人', album: '现场专辑', duration: 32, suffix: 'wav' },
    ] } });
    if (action === 'getCoverArt' && ['artist-art', 'album-art', 'song-art'].includes(id)) {
      return new Response(id, { headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (action === 'getLyricsBySongId') {
      assert.equal(id, 'c1');
      assert.equal(url.searchParams.get('enhanced'), 'true');
      return reply({ lyricsList: { structuredLyrics: [{ displayArtist: '', displayTitle: '', lang: 'und', synced: true,
        line: [{ start: 3200, value: '雨落窗前' }, { start: 8500, value: '夜色如歌' }],
      }] } });
    }
    assert.equal(action, 'stream');
    assert.equal(id, 'c1');
    assert.equal(options.headers.Range, 'bytes=4-7');
    return new Response('data', {
      status: 206, headers: { 'Content-Type': 'audio/wav', 'Content-Range': 'bytes 4-7/20', 'Content-Length': '4' },
    });
  } });
  const server = createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://127.0.0.1'))) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = 'http://127.0.0.1:' + server.address().port;
  const connected = await fetch(root + '/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'fnmusic', url: 'http://music-nas.local', ...credentials }),
  });
  assert.equal(connected.status, 201);
  const Cookie = connected.headers.get('set-cookie').split(';')[0];
  const { source } = await connected.json();
  assert.deepEqual(Object.keys(source).sort(), ['id', 'name', 'type']);
  assert.equal(source.type, 'fnmusic');
  const endpoint = root + '/api/sources/' + source.id + '/list';
  const items = async folder => (await (await fetch(endpoint + (folder ? '?path=' + folder.path : ''), {
    headers: { Cookie },
  })).json()).items;
  const [artist, withoutArt] = await items();
  const [album] = await items(artist);
  const [song, inherited] = await items(album);
  assert.equal(withoutArt.cover, undefined);
  assert.equal(artist.streamUrl, undefined);
  assert.equal(album.streamUrl, undefined);
  for (const [record, id] of [[artist, 'artist-art'], [album, 'album-art'], [song, 'song-art'], [inherited, 'album-art']]) {
    assert.match(record.cover, /^\/api\/sources\/[a-f0-9-]+\/cover\?id=[\w-]+$/);
    assert.equal((await fetch(root + record.cover)).status, 404);
    const art = await fetch(root + record.cover, { headers: { Cookie } });
    assert.equal(art.headers.get('content-type'), 'image/jpeg');
    assert.equal(await art.text(), id);
  }
  assert.equal((await fetch(root + artist.cover.replace('/cover?', '/stream?'), { headers: { Cookie } })).status, 404);
  assert.equal(song.title, '雨夜');
  assert.equal(song.duration, 42);
  assert.equal((await fetch(root + song.streamUrl)).status, 404);
  assert.equal((await fetch(root + song.lyricsUrl)).status, 404);
  const lyrics = await fetch(root + song.lyricsUrl, { headers: { Cookie } });
  assert.equal(lyrics.status, 200);
  assert.equal(lyrics.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await lyrics.json()).lines, [{ time: 3.2, text: '雨落窗前' }, { time: 8.5, text: '夜色如歌' }]);
  const response = await fetch(root + song.streamUrl, { headers: { Cookie, Range: 'bytes=4-7' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 4-7/20');
  assert.equal(await response.text(), 'data');
  assert.ok(['getArtists', 'getArtist', 'getAlbum', 'stream', 'getCoverArt', 'getLyricsBySongId'].every(action => requested.includes(action)));
});
