import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSourcesHandler } from '../server/sources.mjs';
import { createSourceSessionStore } from '../server/source-session-store.mjs';

const target = 'http://music.fixture.invalid/music/';
const api = '/api/sources';
const sessionLife = 7 * 24 * 60 * 60 * 1000;
const audio = Buffer.from([1, 2, 3, 4, 5, 6]);
const jpeg = Buffer.from([255, 216, 255, 224, 0, 4, 255, 217]);
const media = () => new Response(audio.subarray(1, 4), { status: 206,
  headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 1-3/6', 'Content-Length': '3' } });
const cover = () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
const user = '1'.repeat(32);
const itemId = '2'.repeat(32);

async function harness(t) {
  const sessionDirectory = await mkdtemp(join(tmpdir(), 'groovebox-source-restore-'));
  const sessionKey = randomBytes(32);
  let clock = Date.now();
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  async function start(fetchImpl, options = {}) {
    const handler = createSourcesHandler({ sessionDirectory, sessionKey, now: () => clock, fetchImpl, ...options });
    const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const stop = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    t.after(stop);
    const request = (path, cookie, options = {}) => fetch(origin + path, { ...options,
      headers: { Origin: origin, ...(cookie && { Cookie: cookie }), ...options.headers } });
    return { request, stop };
  }
  return { sessionDirectory, sessionKey, start, advance: ms => { clock += ms; } };
}

async function responseJson(response, status = 200) {
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
async function connect(app, type, fields = {}, cookie, status = 201) {
  const response = await app.request(api, cookie, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, url: target, name: 'Durable ' + type, username: 'fixture-user', password: 'fixture-password', ...fields }) });
  const { source, code } = await responseJson(response, status);
  return { cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie, source, code };
}
async function list(app, cookie, source, path = '/') {
  const data = await responseJson(await app.request(api + '/' + source.id + '/list?path=' + encodeURIComponent(path), cookie));
  return data.items;
}
async function assertOldStream(app, cookie, path) {
  const response = await app.request(path, cookie, { headers: { Range: 'bytes=1-3' } });
  assert.equal(response.status, 206, await response.clone().text());
  assert.equal(response.headers.get('content-range'), 'bytes 1-3/6');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio.subarray(1, 4));
}
function davIndex(entries) {
  return new Response('<multistatus xmlns="DAV:">' + entries.map(([path, folder]) => '<response><href>' + path + '</href><propstat>' +
    '<prop><resourcetype>' + (folder ? '<collection/>' : '') + '</resourcetype></prop><status>HTTP/1.1 200 OK</status>' +
    '</propstat></response>').join('') + '</multistatus>', { headers: { 'Content-Type': 'application/xml' } });
}

test('reopens the WebDAV registry and opaque nested streams, sidecars and artwork before a new listing', async t => {
  const env = await harness(t);
  const methods = [];
  const fetchDav = (url, options) => {
    methods.push([options.method, url.pathname]);
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64'));
    if (options.method === 'PROPFIND') {
      if (url.pathname === '/music/') return davIndex([['/music/Disc/', true]]);
      if (url.pathname === '/music/artist/') return davIndex([['/music/artist/Performer.jpg', false]]);
      return davIndex([['/music/Disc/song.mp3', false], ['/music/Disc/song.lrc', false], ['/music/Disc/cover.jpg', false]]);
    }
    if (url.pathname.endsWith('.lrc')) return new Response('[00:01.00]Offline reference', { headers: { 'Content-Type': 'text/plain' } });
    if (url.pathname.endsWith('.jpg')) return cover();
    return media();
  };
  let app = await env.start(fetchDav);
  const { cookie, source } = await connect(app, 'webdav');
  const [folder] = await list(app, cookie, source);
  const [track, lyric] = await list(app, cookie, source, folder.path);
  const portraitPath = api + '/' + source.id + '/artist-portraits';
  const { portraits: [portrait] } = await responseJson(await app.request(portraitPath, cookie));
  await app.stop();

  methods.length = 0;
  app = await env.start(fetchDav);
  assert.deepEqual(await responseJson(await app.request(api, cookie)), { sources: [source] });
  assert.deepEqual(await responseJson(await app.request(api, undefined)), { sources: [] });
  assert.equal((await app.request(track.streamUrl, undefined)).status, 404);
  assert.deepEqual(methods, []);
  await assertOldStream(app, cookie, track.streamUrl);
  assert.equal(await (await app.request(lyric.streamUrl, cookie)).text(), '[00:01.00]Offline reference');
  for (const path of [track.folderCover, portrait.cover]) {
    const response = await app.request(path, cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
  }
  assert.ok(methods.every(([method]) => method !== 'PROPFIND'));
  assert.deepEqual(await list(app, cookie, source, folder.path), [track, lyric]);
  await responseJson(await app.request(portraitPath, cookie, { method: 'DELETE' }));
  await app.stop();

  app = await env.start(fetchDav);
  assert.equal((await app.request(portrait.cover, cookie)).status, 404);
  await responseJson(await app.request(api + '/' + source.id, cookie, { method: 'DELETE' }));
  await app.stop();
  app = await env.start(fetchDav);
  assert.deepEqual(await responseJson(await app.request(api, cookie)), { sources: [] });
  assert.equal((await app.request(track.streamUrl, cookie)).status, 404);
});

test('cached ids expire at the original lifetime and corrupt ciphertext never yields sources or upstream traffic', async t => {
  const env = await harness(t);
  let calls = 0;
  const fetchDav = () => { calls++; return davIndex([['/music/Track.mp3', false]]); };
  let app = await env.start(fetchDav);
  const first = await connect(app, 'webdav');
  env.advance(sessionLife - 1);
  assert.equal((await responseJson(await app.request(api, first.cookie))).sources.length, 1);
  env.advance(1);
  await app.stop();
  app = await env.start(fetchDav);
  assert.deepEqual(await responseJson(await app.request(api, first.cookie)), { sources: [] });
  const second = await connect(app, 'webdav');
  assert.notEqual(second.cookie, first.cookie);
  const [file] = await readdir(env.sessionDirectory);
  await writeFile(join(env.sessionDirectory, file), 'corrupt authenticated source record');
  await app.stop();
  app = await env.start(fetchDav);
  const observed = calls;
  const { code } = await responseJson(await app.request(api, second.cookie), 401);
  assert.equal(code, 'source_session_unreadable');
  assert.equal(calls, observed);
  const repaired = await connect(app, 'webdav', {}, second.cookie);
  assert.notEqual(repaired.cookie, second.cookie);
  assert.equal((await responseJson(await app.request(api, repaired.cookie))).sources.length, 1);
});

test('failed publication preserves previous registry and a held listing cannot resurrect a deleted source', async t => {
  const env = await harness(t);
  const actual = createSourceSessionStore(env.sessionDirectory, env.sessionKey);
  let blocked = false;
  const store = { ...actual, write(...args) { if (blocked) throw new Error('fixture write failed'); actual.write(...args); },
    remove(...args) { if (blocked) throw new Error('fixture remove failed'); actual.remove(...args); } };
  let release;
  let started;
  const received = new Promise(resolve => { started = resolve; });
  const fetchDav = async url => {
    if (url.pathname !== '/music/') {
      started();
      await new Promise(resolve => { release = resolve; });
    }
    return davIndex([['/music/Disc/', true]]);
  };
  const app = await env.start(fetchDav, { sessionStore: store });
  blocked = true;
  const denied = await connect(app, 'webdav', {}, undefined, 503);
  assert.equal(denied.code, 'sources_storage_unavailable');
  assert.equal(denied.cookie, undefined);
  blocked = false;
  const { cookie, source } = await connect(app, 'webdav');
  const [folder] = await list(app, cookie, source);
  const disconnect = () => app.request(api + '/' + source.id, cookie, { method: 'DELETE' });
  blocked = true;
  assert.equal((await responseJson(await disconnect(), 503)).code, 'sources_storage_unavailable');
  assert.deepEqual((await responseJson(await app.request(api, cookie))).sources, [source]);
  blocked = false;
  const listing = app.request(api + '/' + source.id + '/list?path=' + folder.path, cookie);
  await received;
  try {
    const response = await disconnect();
    await responseJson(response);
    assert.match(response.headers.get('set-cookie'), /^groovebox_sources=; Path=\/api\/sources; Max-Age=0; HttpOnly; SameSite=Strict$/);
  }
  finally { release(); }
  assert.equal((await listing).status, 404);
  const restarted = await env.start(fetchDav);
  assert.deepEqual(await responseJson(await restarted.request(api, cookie)), { sources: [] });
  const reconnected = await connect(app, 'webdav', {}, cookie);
  assert.notEqual(reconnected.cookie, cookie);
  assert.deepEqual(await responseJson(await app.request(api, cookie)), { sources: [] });
});

function subsonicFixture(url, options) {
  assert.equal(url.searchParams.get('u'), 'fixture-user');
  assert.match(url.searchParams.get('t'), /^[a-f\d]{32}$/);
  const action = url.pathname.split('/').at(-1);
  const track = { id: 'song-id', title: 'Fixture song', coverArt: 'cover-id', suffix: 'mp3' };
  const respond = data => Response.json({ 'subsonic-response': { status: 'ok', ...data } });
  if (action === 'getArtists.view') return respond({ artists: { index: [{ artist: [{ id: 'artist-id', name: 'Fixture artist' }] }] } });
  if (action === 'getArtist.view') return respond({ artist: { album: [{ id: 'album-id', name: 'Fixture album', year: 1999, coverArt: 'cover-id' }] } });
  if (action === 'getAlbum.view') return respond({ album: { song: [track] } });
  if (action === 'getCoverArt.view') return cover();
  if (action === 'getLyricsBySongId.view') return respond({ lyricsList: { structuredLyrics: [{ kind: 'main', synced: true, line: [{ start: 1000, value: 'Fixture line' }] }] } });
  assert.equal(action, 'stream.view');
  assert.equal(url.searchParams.get('id'), track.id);
  assert.equal(options.headers.Range, 'bytes=1-3');
  return media();
}

function embyOrJellyfin(type, mode, canElevate = () => true) {
  let client;
  return (url, options) => {
    const path = url.pathname.slice('/music/'.length);
    if (path === 'Users/AuthenticateByName') {
      assert.equal(mode, undefined);
      assert.ok(!client, 'only one password authentication');
      assert.equal(JSON.parse(options.body).Pw, 'fixture-password');
      client = options.headers.Authorization;
      return Response.json({ AccessToken: 'fixture-access-token', User: { Id: user }, ServerId: 'fixture-server' });
    }
    if (type === 'emby') assert.equal(options.headers['X-Emby-Token'], 'fixture-access-token');
    else {
      client ??= options.headers.Authorization.split(', Token=')[0];
      assert.equal(options.headers.Authorization, client + ', Token="fixture-access-token"');
    }
    if (path === 'Users/Me') return mode === 'api-key' ? new Response(null, { status: 400 }) : Response.json({ Id: user });
    if (path === 'System/Configuration/MetadataOptions/Default') return canElevate() ? Response.json({}) : new Response(null, { status: 403 });
    if (path === 'Users/' + user) return Response.json({ Id: user });
    if (path === 'System/Info/Public') return Response.json({ Version: '10.11.1', Id: itemId });
    if (path === 'Items' || path === 'Users/' + user + '/Items') {
      return Response.json({ Items: [{ Id: itemId, Name: 'Fixture song', Type: 'Audio', ImageTags: { Primary: 'image' },
        MediaSources: [{ Id: 'media-id', Container: 'mp3' }] }], TotalRecordCount: 1 });
    }
    if (path.endsWith('/Images/Primary')) return cover();
    if (path.endsWith('/Lyrics')) return Response.json({ Lyrics: [{ Start: 10000000, Text: 'Fixture line' }] });
    assert.equal(path, 'Audio/' + itemId + '/stream');
    assert.equal(url.searchParams.get('MediaSourceId'), 'media-id');
    return media();
  };
}

function plexFixture() {
  let client;
  return (url, options) => {
    assert.equal(options.headers['X-Plex-Token'], 'fixture-plex-token');
    client ??= options.headers['X-Plex-Client-Identifier'];
    assert.equal(options.headers['X-Plex-Client-Identifier'], client);
    assert.ok(client);
    const path = url.pathname.slice('/music/'.length);
    if (path === 'library/sections') {
      return Response.json({ MediaContainer: { Directory: [{ type: 'artist', key: '1', title: 'Fixture collection' }] } });
    }
    if (path === 'library/sections/1/all') {
      return Response.json({ MediaContainer: { Metadata: [{ type: 'album', ratingKey: '2', title: 'Fixture album',
        key: '/library/metadata/2', year: 1999 }] } });
    }
    if (path === 'library/metadata/2/children') {
      return Response.json({ MediaContainer: { Metadata: [{ type: 'track', ratingKey: '3', title: 'Fixture song', thumb: '/library/metadata/2/thumb',
        Media: [{ container: 'mp3', Part: [{ key: '/library/parts/3/file.mp3' }] }] }] } });
    }
    if (path === 'library/metadata/2/thumb') return cover();
    assert.equal(path, 'library/parts/3/file.mp3');
    return media();
  };
}

function kodiFixture(url, options) {
  assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64'));
  if (url.pathname.endsWith('/jsonrpc')) {
    const method = JSON.parse(options.body).method;
    if (method === 'AudioLibrary.GetAlbums') return Response.json({ result: { limits: { total: 1 }, albums: [{ albumid: 1, label: 'Fixture album', year: 1999 }] } });
    assert.equal(method, 'AudioLibrary.GetSongs');
    return Response.json({ result: { limits: { total: 1 }, songs: [{ songid: 2, title: 'Fixture song', file: 'smb://music/Disc/song.mp3', thumbnail: 'image://music/cover.jpg' }] } });
  }
  if (url.pathname.startsWith('/music/image/')) return cover();
  assert.match(url.pathname, /^\/music\/vfs\/smb%3A%2F%2F/);
  return media();
}

for (const [type, fixture, depths, fields] of [
  ...['subsonic', 'opensubsonic', 'navidrome'].map(type => [type, subsonicFixture, 2, {}]),
  ['fnmusic', (url, options) => { assert.equal(url.port, '14040'); return subsonicFixture(url, options); }, 2,
    { url: 'http://music.fixture.invalid/' }],
  ['emby', embyOrJellyfin('emby'), 0, {}],
  ['emby', embyOrJellyfin('emby', 'token'), 0, { token: 'fixture-access-token', userId: user }],
  ['jellyfin', embyOrJellyfin('jellyfin'), 0, {}],
  ['jellyfin', embyOrJellyfin('jellyfin', 'token'), 0, { token: 'fixture-access-token', userId: user }],
  ['plex', plexFixture(), 2, { token: 'fixture-plex-token' }],
  ['kodi', kodiFixture, 1, {}],
]) test(`restores ${type}${fields.token && type !== 'plex' ? ' token mode' : ''} credentials and its published playback paths without relogin or relisting`, async t => {
  const env = await harness(t);
  const calls = [];
  const fetchImpl = (url, options) => { calls.push(url.pathname); return fixture(url, options); };
  let app = await env.start(fetchImpl);
  const { cookie, source } = await connect(app, type, fields);
  let tracks = await list(app, cookie, source);
  for (let depth = 0; depth < depths; depth++) {
    const folder = tracks.find(item => item.folder && item.name.startsWith('Fixture'));
    tracks = await list(app, cookie, source, folder.path);
  }
  const [track] = tracks;
  assert.equal(track.title, 'Fixture song');
  await app.stop();

  calls.length = 0;
  app = await env.start(fetchImpl);
  assert.deepEqual((await responseJson(await app.request(api, cookie))).sources, [source]);
  assert.deepEqual(calls, []);
  await assertOldStream(app, cookie, track.streamUrl);
  assert.equal(calls.length, 1);
  const artwork = await app.request(track.cover, cookie);
  assert.equal(artwork.status, 200);
  assert.deepEqual(Buffer.from(await artwork.arrayBuffer()), jpeg);
  if (track.lyricsUrl) assert.equal((await responseJson(await app.request(track.lyricsUrl, cookie))).lines[0].text, 'Fixture line');
});

test('restored Jellyfin API-key mode rechecks native privileges before accepting playlist writes', async t => {
  const env = await harness(t);
  let authorized = true;
  const fixture = embyOrJellyfin('jellyfin', 'api-key', () => authorized);
  let app = await env.start(fixture);
  const { cookie, source } = await connect(app, 'jellyfin', { token: 'fixture-access-token', userId: user });
  assert.equal(source.playlistAuthority, 'api-key');
  const [track] = await list(app, cookie, source);
  await app.stop();

  authorized = false;
  app = await env.start(fixture);
  assert.deepEqual((await responseJson(await app.request(api, cookie))).sources, [source]);
  await assertOldStream(app, cookie, track.streamUrl);
  await responseJson(await app.request(api + '/' + source.id + '/playlist?path=playlists', cookie, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', name: 'Must not send' }),
  }), 403);
});

test('restores acknowledged Emby reporting without resending start and keeps confirmed empty audio playlists', async t => {
  const env = await harness(t);
  const fixture = embyOrJellyfin('emby');
  const reporting = [];
  let nativeCreated = false;
  const playlistId = '56789';
  const fetchImpl = (url, options) => {
    const path = url.pathname.slice('/music/'.length);
    if (path === 'Playlists' && options.method === 'POST') {
      nativeCreated = true;
      return Response.json({ Id: playlistId });
    }
    if (path === 'Playlists/' + playlistId + '/Items') return Response.json({ Items: [], TotalRecordCount: 0 });
    if (path === 'Users/' + user + '/Items' && url.searchParams.get('IncludeItemTypes') === 'Playlist') {
      return Response.json({ Items: nativeCreated ? [{ Id: playlistId, Name: 'Confirmed empty', Type: 'Playlist', ServerId: 'fixture-server' }] : [] });
    }
    if (path.startsWith('Sessions/Playing')) {
      assert.equal(options.headers['X-Emby-Token'], 'fixture-access-token');
      assert.match(options.headers.Authorization, /^MediaBrowser Client="Groovebox"/);
      reporting.push([path, JSON.parse(options.body).ItemId]);
      return new Response(null, { status: 204 });
    }
    return fixture(url, options);
  };
  let app = await env.start(fetchImpl);
  const { cookie, source } = await connect(app, 'emby');
  const [track] = await list(app, cookie, source);
  const playlist = api + '/' + source.id + '/playlist?path=playlists';
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await responseJson(await app.request(playlist, cookie, json('POST', { action: 'create', name: 'Confirmed empty' })), 201);
  const playSessionId = 'abcdef01-2345-6789-abcd-ef0123456789';
  const report = event => app.request(track.streamUrl.replace('/stream?', '/playback?'), cookie,
    json('POST', { event, playSessionId, positionSeconds: 1, paused: false }));
  await responseJson(await report('start'));
  await app.stop();

  // Test the durable positive hint independently of the folder descriptor cache.
  const raw = createSourceSessionStore(env.sessionDirectory, env.sessionKey);
  const sid = cookie.split('=')[1];
  const record = raw.read(sid, Date.now());
  assert.ok(record.sources[0].embyHints.length);
  record.sources[0].index.folders = [];
  raw.write(sid, record, Date.now());
  app = await env.start(fetchImpl);
  assert.equal((await list(app, cookie, source, 'playlists'))[0].name, 'Confirmed empty');
  await responseJson(await report('start'));
  await responseJson(await report('progress'));
  await responseJson(await report('stop'));
  assert.deepEqual(reporting, [['Sessions/Playing', itemId], ['Sessions/Playing/Progress', itemId], ['Sessions/Playing/Stopped', itemId]]);
  await app.stop();
  app = await env.start(fetchImpl);
  await responseJson(await report('progress'), 409);
  assert.equal(reporting.length, 3);
});

test('rejects an authenticated index snapshot with a media endpoint outside the provider base', async t => {
  const env = await harness(t);
  let hits = 0;
  const fetchDav = () => { hits++; return davIndex([['/music/track.mp3', false]]); };
  let app = await env.start(fetchDav);
  const { cookie, source } = await connect(app, 'webdav');
  const [track] = await list(app, cookie, source);
  await app.stop();
  const raw = createSourceSessionStore(env.sessionDirectory, env.sessionKey);
  const sid = cookie.split('=')[1];
  const record = raw.read(sid, Date.now());
  record.sources[0].index.media[0][1].stream = 'http://private.invalid/media.mp3';
  raw.write(sid, record, Date.now());
  const previous = hits;
  app = await env.start(fetchDav);
  assert.equal((await responseJson(await app.request(track.streamUrl, cookie), 401)).code, 'source_session_unreadable');
  assert.equal(hits, previous);
});

test('keeps a rotated Songloft refresh token across a second restart without password relogin', async t => {
  const env = await harness(t);
  let logins = 0;
  let rotations = 0;
  let active = 'access-original';
  const fetchImpl = (url, options) => {
    const path = url.pathname;
    if (path.endsWith('/auth/login')) {
      logins++;
      return Response.json({ access_token: active, refresh_token: 'refresh-original', expires_in: 3600 });
    }
    if (path.endsWith('/auth/refresh')) {
      assert.equal(JSON.parse(options.body).refresh_token, rotations === 0 ? 'refresh-original' : 'refresh-first');
      rotations++;
      return Response.json({ access_token: active, refresh_token: 'refresh-first', expires_in: 3600 });
    }
    if (options.headers.Authorization !== 'Bearer ' + active) return new Response(null, { status: 401 });
    if (path.endsWith('/songs')) return Response.json({ songs: [{ id: '10987654321987654321', title: 'Fixture Songloft', cover_url: true, format: 'mp3' }], total: 1 });
    if (path.endsWith('/cover')) return cover();
    if (path.endsWith('/lyric')) return Response.json({ lyric: '[00:01.00]Fixture Songloft lyric' });
    assert.equal(url.searchParams.get('access_token'), active);
    assert.equal(url.searchParams.get('normalize'), '0');
    return media();
  };
  let app = await env.start(fetchImpl);
  const { cookie, source } = await connect(app, 'songloft');
  const [track] = await list(app, cookie, source);
  for (const token of ['access-first', 'access-second']) {
    await app.stop();
    active = token;
    app = await env.start(fetchImpl);
    await assertOldStream(app, cookie, track.streamUrl);
    assert.equal(await (await app.request(track.lyricsUrl, cookie)).text(), '[00:01.00]Fixture Songloft lyric');
  }
  assert.equal(rotations, 2);
  assert.equal(logins, 1);
});
