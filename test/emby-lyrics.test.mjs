import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { readEmbyLyrics } from '../server/emby-lyrics.mjs';

const track = { itemId: '9007199254740995', userId: 'user-1' };
const noLyrics = () => new Response(null, { status: 404 });

test('Emby lyrics API reads an authenticated track and normalizes sortable times from ticks', async t => {
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/music/emby/Items/9007199254740995/Lyrics');
    assert.equal(req.headers['x-emby-token'], 'test-session-token');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ Lyrics: [
      { Text: '第 2 行', Start: 25_000_000 },
      { Text: '第 1 行', Start: 0 },
      { Text: '', Start: 50_000_000 },
    ] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = new URL('http://127.0.0.1:' + server.address().port + '/music/emby/');
  const result = await readEmbyLyrics(relative => fetch(new URL(relative, base), { headers: { 'X-Emby-Token': 'test-session-token' } }), track);
  assert.deepEqual(result, { status: 200, lines: [{ time: 0, text: '第 1 行' }, { time: 2.5, text: '第 2 行' }] });
});

test('Emby lyrics API falls back to a single untimed block for plain text', async () => {
  const result = await readEmbyLyrics(async () => Response.json({ Lyrics: [
    { Text: 'verse one' },
    { Text: 'verse two', Start: -1 },
  ] }), track);
  assert.deepEqual(result, { status: 200, lines: [{ time: null, text: 'verse one\nverse two' }] });
});

test('Emby legacy subtitle API scopes a timed LRC to the selected variant and stream index', async () => {
  const calls = [];
  const result = await readEmbyLyrics(async path => {
    calls.push(path);
    if (path.endsWith('/Lyrics')) return noLyrics();
    if (path.includes('/PlaybackInfo?')) {
      return Response.json({ MediaSources: [
        { Id: 'different', MediaStreams: [{ Type: 'Subtitle', Codec: 'lrc', Index: 3 }] },
        { Id: 'preferred', MediaStreams: [
          { Type: 'Subtitle', Codec: 'srt', Index: 7 },
          { Type: 'Subtitle', Codec: 'lrc', Index: 0, DeliveryUrl: 'https://foreign.invalid/never-follow' },
        ] },
      ] });
    }
    return Response.json({ TrackEvents: [{ Text: '歌词', StartPositionTicks: 35_000_000 }] }, {
      headers: { 'Content-Type': 'application/javascript' },
    });
  }, { ...track, mediaSourceId: 'preferred' });
  assert.deepEqual(calls, [
    'Items/' + track.itemId + '/Lyrics',
    'Items/' + track.itemId + '/PlaybackInfo?UserId=user-1',
    'Items/' + track.itemId + '/preferred/Subtitles/0/Stream.js',
  ]);
  assert.deepEqual(result, { status: 200, lines: [{ time: 3.5, text: '歌词' }] });
});

test('Emby embedded LRC retains enhanced timing when no sidecar lyrics are available', async () => {
  const result = await readEmbyLyrics(async path => {
    if (path.endsWith('/Lyrics') || path.endsWith('/Stream.js')) return noLyrics();
    return Response.json({ MediaSources: [{ Id: 'source1', MediaStreams: [
      { Type: 'Subtitle', Codec: 'lrc', Index: 12 },
      { Type: 'Subtitle', Codec: 'text', Title: 'Lyrics', Extradata: '[00:01.00]<00:01.20>雪<00:01.60>花<00:02.40>' },
    ] }] });
  }, track);
  assert.deepEqual(result, { status: 200, lines: [{
    time: 1, text: '雪花', words: [{ time: 1.2, text: '雪', endTime: 1.6 }, { time: 1.6, text: '花', endTime: 2.4 }],
  }] });
});

test('Emby lyric handler avoids external paths, unrelated streams, and unauthorized fallback', async () => {
  let calls = 0;
  const forbidden = async () => {
    calls++;
    return new Response(null, { status: 403 });
  };
  assert.deepEqual(await readEmbyLyrics(forbidden, { ...track, itemId: '%2f..' }), { status: 404, lines: [] });
  assert.equal(calls, 0);
  assert.deepEqual(await readEmbyLyrics(forbidden, track), { status: 403, lines: [] });
  assert.equal(calls, 1);
  const noLyricStream = await readEmbyLyrics(async path => path.endsWith('/Lyrics') ? noLyrics() : Response.json({
    MediaSources: [{ Id: '../outside', MediaStreams: [
      { Type: 'Audio', Codec: 'text', Title: 'Lyrics', Extradata: 'ignore' },
      { Type: 'Subtitle', Codec: 'srt', Index: 2 },
      { Type: 'Subtitle', Codec: 'lrc', Index: -1 },
    ] }],
  }), track);
  assert.deepEqual(noLyricStream, { status: 404, lines: [] });
});

test('Emby lyric responses are bounded with or without a content length header', async () => {
  const length = await readEmbyLyrics(async () => new Response('x', { headers: { 'Content-Length': '1000001' } }), track);
  assert.deepEqual(length, { status: 413, lines: [] });
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(400_000));
      controller.close();
    },
  });
  const chunked = await readEmbyLyrics(async () => new Response(body), track);
  assert.deepEqual(chunked, { status: 413, lines: [] });
});
