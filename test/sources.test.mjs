import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createSourcesHandler } from '../server/sources.mjs';

const username = 'fixture-user';
const password = 'fixture-pass';
const token = 'fixture-token';
const audioBytes = Buffer.from([10, 20, 30, 40, 50, 60]);
const mime = 'audio/mpeg';

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t, upstream) {
  // Collect assertion errors from the fixture rather than leave a waiting client dangling.
  const serverErrors = [];
  const target = await listen(t, async (req, res) => {
    try {
      await upstream(req, res, new URL(req.url, 'http://fixture'));
    } catch (error) {
      serverErrors.push(error);
      res.writeHead(500).end();
    }
  });
  t.after(() => assert.deepEqual(serverErrors, []));
  const handler = createSourcesHandler();
  const app = await listen(t, async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://app'))) res.writeHead(404).end();
  });
  return { target, app };
}

function reply(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
}

function rangedAudio(req, res) {
  assert.ok(['GET', 'HEAD'].includes(req.method));
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes' };
  if (req.headers.range) {
    assert.equal(req.headers.range, 'bytes=1-3');
    headers['Content-Range'] = 'bytes 1-3/' + audioBytes.length;
    headers['Content-Length'] = 3;
    res.writeHead(206, headers).end(req.method === 'HEAD' ? undefined : audioBytes.subarray(1, 4));
  } else {
    headers['Content-Length'] = audioBytes.length;
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : audioBytes);
  }
}

async function connect(app, config, cookie, { playlistWritable = false, playlistAuthority } = {}) {
  const res = await fetch(app + '/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app, ...(cookie && { Cookie: cookie }) },
    body: JSON.stringify(config),
  });
  const details = await res.json();
  assert.equal(res.status, 201, JSON.stringify(details));
  const source = details.source;
  const fields = ['id', 'name', 'type'];
  if (playlistWritable) fields.push('playlistWritable');
  if (playlistAuthority) fields.push('playlistAuthority');
  assert.deepEqual(Object.keys(source).sort(), fields.sort());
  if (playlistWritable) assert.equal(source.playlistWritable, true);
  if (playlistAuthority) assert.equal(source.playlistAuthority, playlistAuthority);
  assert.equal(source.name, config.name);
  assert.equal(source.type, config.type);
  assert.doesNotMatch(JSON.stringify(details), /fixture-(?:user|pass|token)/);
  const setCookie = res.headers.get('set-cookie');
  if (cookie) assert.equal(setCookie, null);
  else assert.match(setCookie, /Path=\/api\/sources.*HttpOnly; SameSite=Strict/);
  return { id: source.id, cookie: cookie || setCookie.split(';')[0] };
}

async function list(app, source, path = '/') {
  const url = new URL('/api/sources/' + source.id + '/list', app);
  url.searchParams.set('path', path);
  const res = await fetch(url, { headers: { Cookie: source.cookie } });
  const payload = await res.json();
  assert.equal(res.status, 200, JSON.stringify(payload));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(payload), /fixture-(?:user|pass|token)|\/rest\/stream\.view/);
  for (const item of payload.items) {
    if (item.streamUrl) assert.match(item.streamUrl, /^\/api\/sources\/[a-f0-9-]+\/stream\?id=\w[\w-]+$/);
  }
  return payload.items;
}

async function assertStream(app, source, track) {
  const headers = { Cookie: source.cookie, Range: 'bytes=1-3' };
  for (const method of ['GET', 'HEAD']) {
    const res = await fetch(app + track.streamUrl, { headers, method });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 1-3/6');
    assert.equal(res.headers.get('content-type'), mime);
    const body = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...body], method === 'HEAD' ? [] : [20, 30, 40]);
  }
}

function davEntry(path, name, isFolder = false, type = 'audio/mpeg') {
  return '<d:response><d:href>' + path + '</d:href><d:propstat><d:prop>' +
    '<d:displayname>' + name + '</d:displayname><d:resourcetype>' + (isFolder ? '<d:collection/>' : '') +
    '</d:resourcetype><d:getcontentlength>6</d:getcontentlength><d:getcontenttype>' + type +
    '</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
}

test('WebDAV exposes authenticated file modification dates and replaces missing dates on a fresh listing', async t => {
  const values = ['Mon, 01 Jan 2024 00:00:00 GMT', 'Thu, 01 Jan 1970 00:00:00 GMT',
    'Fri, 01 Jan 1960 00:00:00 GMT', undefined, 'not a date', '1704067200000'];
  const { target, app } = await fixture(t, async (req, res, url) => {
    const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    assert.equal(req.headers.authorization, authorization);
    assert.equal(req.method, 'PROPFIND');
    req.resume();
    const children = values.map((value, index) => {
      const entry = davEntry('/music/recording-' + index + '.mp3', 'Recording ' + index + '.mp3');
      return value === undefined ? entry : entry.replace('</d:prop>', '<d:getlastmodified>' + value + '</d:getlastmodified></d:prop>');
    }).join('');
    res.writeHead(207, { 'Content-Type': 'application/xml' }).end('<d:multistatus xmlns:d="DAV:">' +
      davEntry(url.pathname, 'self', true) + children + '</d:multistatus>');
  });
  const source = await connect(app, { type: 'webdav', name: 'File date fixture', url: target + '/music', username, password });
  const before = await list(app, source);
  assert.deepEqual(before.map(item => item.modified), [1704067200000, 0, -315619200000, undefined, undefined, undefined]);
  for (const item of before.slice(3)) assert.equal(Object.hasOwn(item, 'modified'), false);
  values[0] = 'Sat, 01 Jan 2000 00:00:00 GMT';
  values[1] = undefined;
  const after = await list(app, source);
  assert.deepEqual(after.map(item => item.id), before.map(item => item.id));
  assert.equal(after[0].modified, 946684800000);
  assert.equal(Object.hasOwn(after[1], 'modified'), false);
});

test('WebDAV probes auth, browses a Unicode folder and guards streaming by origin and session', async t => {
  const folder = '/music/' + encodeURIComponent('中文 歌曲') + '/';
  const file = folder + encodeURIComponent('夜色 & 风.mp3');
  const { target, app } = await fixture(t, async (req, res, url) => {
    const basic = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    if (req.headers.authorization !== basic) return res.writeHead(401).end();
    if (url.pathname === file) return rangedAudio(req, res);
    assert.equal(req.method, 'PROPFIND');
    assert.equal(req.headers.depth, '1');
    req.resume();
    const children = url.pathname === folder ?
      davEntry(file, '夜色 &amp; 风.mp3') + davEntry(folder + 'notes.txt', 'notes.txt', false, 'text/plain') :
      davEntry(folder, '中文 歌曲', true) + davEntry('/outside/hidden.mp3', 'hidden.mp3');
    res.writeHead(207, { 'Content-Type': 'application/xml' })
      .end('<d:multistatus xmlns:d="DAV:">' + davEntry(url.pathname, 'self', true) + children + '</d:multistatus>');
  });
  const config = { type: 'webdav', name: '光盘', url: target + '/music', username, password };
  const bad = await fetch(app + '/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...config, password: 'wrong' }) });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  await bad.json();

  const source = await connect(app, config);
  const [directory, extra] = await list(app, source);
  assert.equal(directory.name, '中文 歌曲');
  assert.equal(directory.folder, true);
  assert.equal(extra, undefined);
  const tracks = await list(app, source, directory.path);
  assert.deepEqual(tracks.map(track => track.name), ['夜色 & 风.mp3']);
  assert.equal(tracks[0].path, '/music/中文 歌曲/夜色 & 风.mp3');
  await assertStream(app, source, tracks[0]);

  const isolated = await fetch(app + tracks[0].streamUrl);
  assert.equal(isolated.status, 404);
  await isolated.json();
  const crossOrigin = await fetch(app + tracks[0].streamUrl, {
    headers: { Cookie: source.cookie, Origin: 'https://other.invalid', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossOrigin.status, 403);
  await crossOrigin.json();
  const disconnected = await fetch(app + '/api/sources/' + source.id, {
    method: 'DELETE', headers: { Cookie: source.cookie, Origin: app },
  });
  assert.deepEqual(await disconnected.json(), { disconnected: true });
  const removed = await fetch(app + '/api/sources', { headers: { Cookie: source.cookie } });
  assert.deepEqual(await removed.json(), { sources: [] });
});

test('preserves Emby playlist duplicates and limits edits to same-session opaque entries and audio', async t => {
  const writes = [];
  const audio = { Id: 'upstream-audio-1', Type: 'Audio', Name: 'Track', MediaSources: [{ Id: 'source-1', Container: 'mp3' }] };
  const upstreamPlaylists = [
    { Id: 'upstream-list-1', Type: 'Playlist', Name: 'Playlist 1', MediaType: 'Audio' },
    { Id: 'upstream-list-2', Type: 'Playlist', Name: 'Playlist 2' },
    { Id: 'upstream-video-list', Type: 'Playlist', Name: 'Movies', MediaType: 'Video' },
  ];
  const playlistItems = new Map([
    ['upstream-list-1', ['upstream-entry-a', 'upstream-entry-b']],
    ['upstream-list-2', ['upstream-entry-a']],
  ]);
  const { target, app } = await fixture(t, (req, res, url) => {
    assert.equal(req.headers['x-emby-token'], token);
    assert.equal(url.searchParams.has('api_key'), false);
    if (url.pathname === '/emby/Users/test-user/Items') {
      assert.equal(url.searchParams.get('UserId'), 'test-user');
      if (url.searchParams.get('IncludeItemTypes') === 'Playlist') {
        assert.equal(url.searchParams.has('MediaTypes'), false);
        assert.equal(url.searchParams.get('Recursive'), 'true');
        return reply(res, { Items: upstreamPlaylists, TotalRecordCount: 3 });
      }
      return reply(res, { Items: [audio], TotalRecordCount: 1 });
    }
    const id = /^\/emby\/Playlists\/([^/]+)\/Items$/.exec(url.pathname)?.[1];
    assert.ok(playlistItems.has(id), url.pathname);
    if (req.method === 'GET') {
      assert.equal(url.searchParams.has('SortBy'), false);
      const entries = playlistItems.get(id);
      return reply(res, { Items: entries.map(PlaylistItemId => ({ ...audio, PlaylistItemId })), TotalRecordCount: entries.length });
    }
    writes.push([req.method, id, Object.fromEntries(url.searchParams)]);
    return res.writeHead(204).end();
  });
  const source = await connect(app, { type: 'emby', name: 'Emby', url: target, userId: 'test-user', token });
  const playlists = await list(app, source, 'playlists');
  assert.deepEqual(playlists.map(item => item.name), ['Playlist 1', 'Playlist 2']);
  const [left, right] = await Promise.all(playlists.map(async playlist => {
    const response = await fetch(app + '/api/sources/' + source.id + '/list?' + new URLSearchParams({ path: playlist.path }),
      { headers: { Cookie: source.cookie } });
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.equal(left.serverOrder, true);
  assert.equal(left.items.length, 2);
  assert.equal(left.items[0].id, left.items[1].id);
  assert.notEqual(left.items[0].playlistEntry, left.items[1].playlistEntry);
  assert.notEqual(left.items[0].playlistEntry, right.items[0].playlistEntry);
  assert.doesNotMatch(JSON.stringify({ playlists, left, right }), /upstream-(?:entry|audio|list)-/);
  const update = (path, payload, headers = {}) => fetch(app + '/api/sources/' + source.id + '/playlist?' + new URLSearchParams({ path }), {
    method: 'POST', headers: { Cookie: source.cookie, Origin: app, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const append = { action: 'add', trackId: left.items[0].id };
  const remove = { action: 'remove', entryId: left.items[1].playlistEntry };
  assert.equal((await update(playlists[0].path, append, { Origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await update(playlists[0].path, append, { Cookie: '' })).status, 404);
  assert.equal((await update('upstream-list-1', append)).status, 404);
  assert.equal((await update(playlists[0].path, { action: 'add', trackId: 'upstream-audio-1' })).status, 404);
  assert.equal((await update(playlists[1].path, remove)).status, 404);
  assert.deepEqual(writes, []);
  assert.equal((await update(playlists[0].path, append)).status, 200);
  assert.equal((await update(playlists[0].path, remove)).status, 200);
  assert.equal((await update(playlists[0].path, remove)).status, 404);
  assert.deepEqual(writes, [
    ['POST', 'upstream-list-1', { UserId: 'test-user', Ids: 'upstream-audio-1' }],
    ['DELETE', 'upstream-list-1', { EntryIds: 'upstream-entry-b' }],
  ]);
});

test('creates scoped Emby audio playlists and can reopen them when the server omits an empty type', async t => {
  const name = '练习 & 小样';
  const id = '123456789';
  const creationCalls = [];
  let serverId = 'server-a';
  const { target, app } = await fixture(t, (req, res, url) => {
    assert.equal(req.headers['x-emby-token'], token);
    if (url.pathname === '/emby/Playlists') {
      assert.equal(req.method, 'POST');
      creationCalls.push(Object.fromEntries(url.searchParams));
      return reply(res, { Id: id, Name: name, ItemAddedCount: 0 });
    }
    if (url.pathname === '/emby/Playlists/' + id + '/Items') {
      assert.equal(req.method, 'GET');
      assert.equal(url.searchParams.get('UserId'), 'owner');
      return reply(res, { Items: [], TotalRecordCount: 0 });
    }
    assert.equal(url.pathname, '/emby/Users/owner/Items');
    const items = url.searchParams.get('IncludeItemTypes') === 'Playlist'
      ? creationCalls.length ? [{ Id: id, Name: name, Type: 'Playlist', ServerId: serverId }] : []
      : [{ Id: 'music', Name: 'Music', Type: 'Folder', ServerId: serverId }];
    return reply(res, { Items: items, TotalRecordCount: items.length });
  });
  const config = { type: 'emby', name: 'Emby', url: target, userId: 'owner', token };
  const source = await connect(app, config);
  const create = (name, { path = 'playlists', origin = app, cookie = source.cookie } = {}) =>
    fetch(app + '/api/sources/' + source.id + '/playlist?' + new URLSearchParams({ path }), {
      method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', name, mediaType: 'Video', userId: 'spoofed' }),
    });
  assert.equal((await create(name, { origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await create(name, { cookie: '' })).status, 404);
  assert.equal((await create(name, { path: '/' })).status, 404);
  for (const invalid of [' ', 'x'.repeat(81), '../逃逸', 'first\nsecond']) {
    assert.equal((await create(invalid)).status, 400);
  }
  assert.deepEqual(creationCalls, []);
  const created = await create('  ' + name + '  ');
  assert.equal(created.status, 201);
  const { playlist } = await created.json();
  assert.equal(playlist.name, name);
  assert.equal(playlist.folder, true);
  assert.notEqual(playlist.path, id);
  const contents = await fetch(app + '/api/sources/' + source.id + '/list?' + new URLSearchParams({ path: playlist.path }),
    { headers: { Cookie: source.cookie } });
  assert.deepEqual(await contents.json(), { items: [], serverOrder: true });
  assert.deepEqual(await list(app, source, 'playlists'), [playlist]);
  const deleted = await fetch(app + '/api/sources/' + source.id, { method: 'DELETE', headers: { Origin: app, Cookie: source.cookie } });
  assert.equal(deleted.status, 200);
  const reconnected = await connect(app, config, source.cookie);
  assert.deepEqual(await list(app, reconnected, 'playlists'), [playlist]);
  const other = await connect(app, config);
  assert.deepEqual(await list(app, other, 'playlists'), []);
  serverId = 'server-b';
  const replacedServer = await connect(app, config, source.cookie);
  assert.deepEqual(await list(app, replacedServer, 'playlists'), []);
  assert.deepEqual(creationCalls, [{ UserId: 'owner', Name: name, MediaType: 'Audio' }]);
});

test('WebDAV lists LRC and VTT sidecars and serves bounded, authenticated plain text', async t => {
  const lyrics = '[00:01.44]第一句\n[00:03.00]第二句';
  const captions = 'WEBVTT\n\n00:00:01.440 --> 00:00:03.000\nFirst line';
  const { target, app } = await fixture(t, (req, res, url) => {
    if (req.method === 'PROPFIND') {
      req.resume();
      const entries = [
        davEntry('/music/Night.mp3', 'Night.mp3'),
        davEntry('/music/Night.LRC', 'Night', false, 'application/octet-stream'),
        davEntry('/music/Night.vtt', 'Night.vtt', false, 'text/vtt'),
        davEntry('/music/Excess.lrc', 'Excess.lrc', false, 'text/plain'),
        davEntry('/music/Invalid.vtt', 'Invalid.vtt', false, 'text/html'),
        davEntry('/outside/Other.lrc', 'Other.lrc', false, 'text/plain'),
      ];
      return res.writeHead(207, { 'Content-Type': 'application/xml' })
        .end('<d:multistatus xmlns:d="DAV:">' + entries.join('') + '</d:multistatus>');
    }
    assert.equal(req.headers.range, undefined);
    if (url.pathname.endsWith('/Night.LRC')) {
      return res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(lyrics) })
        .end(req.method === 'HEAD' ? undefined : lyrics);
    }
    if (url.pathname.endsWith('/Night.vtt')) return res.writeHead(200, { 'Content-Type': 'text/vtt' }).end(captions);
    if (url.pathname.endsWith('/Invalid.vtt')) return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>');
    assert.ok(url.pathname.endsWith('/Excess.lrc'));
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write(Buffer.alloc(900_000, 65));
    res.end(Buffer.alloc(100_001, 65));
  });
  const source = await connect(app, { type: 'webdav', name: 'Sidecars', url: target + '/music' });
  const items = await list(app, source);
  assert.deepEqual(items.map(item => item.name), ['Night.mp3', 'Night.LRC', 'Night.vtt', 'Excess.lrc', 'Invalid.vtt']);
  const [, lrc, vtt, excess, invalid] = items;
  const headers = { Cookie: source.cookie };
  for (const [item, expected] of [[lrc, lyrics], [vtt, captions]]) {
    const response = await fetch(app + item.streamUrl, { headers: { ...headers, Range: 'bytes=1-3' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /sandbox/);
    assert.equal(await response.text(), expected);
  }
  const head = await fetch(app + lrc.streamUrl, { method: 'HEAD', headers });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(lyrics));
  assert.equal(await head.text(), '');
  for (const [item, status, options] of [[lrc, 404, {}], [excess, 413, { headers }], [invalid, 502, { headers }]]) {
    const response = await fetch(app + item.streamUrl, options);
    assert.equal(response.status, status);
    await response.json();
  }
});

test('WebDAV shares a session-only folder cover, ignores invalid PNG and never exposes the image as audio', async t => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const requests = [];
  const { target, app } = await fixture(t, (req, res, url) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from(username + ':' + password).toString('base64')) {
      return res.writeHead(401).end();
    }
    if (req.method === 'PROPFIND') {
      req.resume();
      const entries = url.pathname === '/music/Other/' ? [davEntry('/music/Other/Three.mp3', 'Three')] : [
        davEntry('/music/One.mp3', 'Track One'), davEntry('/music/Two.mp3', 'Track Two'),
        davEntry('/music/One.LRC', 'Alias.LRC', false, 'text/plain'),
        davEntry('/music/Other/', 'Other', true), davEntry('/outside/cover.png', 'cover.png', false, 'image/png'),
        davEntry('/music/COVER.png', 'Cover alias', false, 'image/png'),
        davEntry('/music/cover.JPG', 'JPEG alias', false, 'application/octet-stream'),
      ];
      return res.writeHead(207, { 'Content-Type': 'application/xml' })
        .end('<d:multistatus xmlns:d="DAV:">' + entries.join('') + '</d:multistatus>');
    }
    requests.push(url.pathname);
    assert.equal(req.headers.range, undefined);
    if (url.pathname === '/music/COVER.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end('<svg/>');
    assert.equal(url.pathname, '/music/cover.JPG');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(jpg);
  });
  const source = await connect(app, { type: 'webdav', name: 'Folder Cover', url: target + '/music', username, password });
  const [one, two, sidecar, other] = await list(app, source);
  assert.equal(one.name, 'Track One');
  assert.equal(one.fileName, 'One.mp3');
  assert.equal(sidecar.fileName, 'One.LRC');
  assert.equal(sidecar.folderCover, undefined);
  assert.equal(other.folderCover, undefined);
  assert.match(one.folderCover, /^\/api\/sources\/[a-f0-9-]+\/cover\?id=[\w-]+$/);
  assert.equal(one.folderCover, two.folderCover);
  assert.equal((await list(app, source, other.path))[0].folderCover, undefined);
  const cover = app + one.folderCover;
  assert.equal((await fetch(cover)).status, 404);
  const headers = { Cookie: source.cookie, Range: 'bytes=0-1' };
  assert.equal((await fetch(cover.replace('/cover?', '/stream?'), { headers })).status, 404);
  const response = await fetch(cover, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpg);
  const head = await fetch(cover, { method: 'HEAD', headers });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(jpg.length));
  assert.equal(await head.text(), '');
  assert.deepEqual(requests, ['/music/COVER.png', '/music/cover.JPG', '/music/COVER.png', '/music/cover.JPG']);
});

test('WebDAV artist images stay inside the configured artist folder and the authenticated source session', async t => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const artist = encodeURIComponent('O\u0301rbita 乐团');
  const directory = '/collection/artist/';
  const requests = [];
  let folderMissing = false;
  const { target, app } = await fixture(t, (req, res, url) => {
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from(username + ':' + password).toString('base64'));
    if (req.method === 'PROPFIND') {
      assert.equal(req.headers.depth, '1');
      req.resume();
      if (url.pathname === directory && folderMissing) return res.writeHead(404).end();
      const entries = url.pathname === '/collection/' ? [davEntry(directory, 'artist', true)] : [
        davEntry(directory + artist + '.JPG', 'Untrusted display label', false, 'image/jpeg'),
        davEntry(directory + 'Conflict.PNG', 'Conflict', false, 'image/png'),
        davEntry(directory + 'conflict.png', 'Conflict alias', false, 'image/png'),
        davEntry(directory + 'nested/Nested.jpg', 'Nested', false, 'image/jpeg'),
        davEntry('/collection/Other.jpg', 'Outside the artist folder', false, 'image/jpeg'),
        davEntry('http://other.invalid/collection/artist/Foreign.jpg', 'Foreign', false, 'image/jpeg'),
      ];
      assert.ok(['/collection/', directory].includes(url.pathname));
      return res.writeHead(207, { 'Content-Type': 'application/xml' })
        .end('<d:multistatus xmlns:d="DAV:">' + entries.join('') + '</d:multistatus>');
    }
    requests.push(url.pathname);
    assert.equal(url.pathname, directory + artist + '.JPG');
    return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(jpg);
  });
  const config = { type: 'webdav', name: 'Artist Folder', url: target + '/collection', username, password };
  const source = await connect(app, config);
  const endpoint = app + '/api/sources/' + source.id + '/artist-portraits';
  const headers = { Cookie: source.cookie };
  assert.equal((await fetch(endpoint)).status, 404);
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { portraits } = await response.json();
  assert.deepEqual(portraits.map(item => item.artist), ['órbita 乐团']);
  const cover = app + portraits[0].cover;
  assert.match(portraits[0].cover, /^\/api\/sources\/[a-f\d-]+\/cover\?id=[\w-]{24}$/);
  assert.equal((await fetch(cover)).status, 404);
  assert.equal((await fetch(cover.replace('/cover?', '/stream?'), { headers })).status, 404);
  const artwork = await fetch(cover, { headers });
  assert.equal(artwork.status, 200);
  assert.equal(artwork.headers.get('content-type'), 'image/jpeg');
  assert.equal(artwork.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await artwork.arrayBuffer()), jpg);
  assert.deepEqual(requests, [directory + artist + '.JPG']);

  folderMissing = true;
  assert.deepEqual(await (await fetch(endpoint, { headers })).json(), { portraits });
  assert.equal((await fetch(endpoint, { method: 'DELETE', headers })).status, 403);
  assert.deepEqual(await (await fetch(endpoint, { method: 'DELETE', headers: { ...headers, Origin: app } })).json(), { invalidated: true });
  assert.equal((await fetch(cover, { headers })).status, 404);
  assert.deepEqual(await (await fetch(endpoint, { headers })).json(), { portraits: [] });
  assert.equal((await fetch(cover, { headers })).status, 404);
});

test('WebDAV backs up and downloads versioned playlists from the configured directory', async t => {
  const storedPath = '/collection/groovebox-playlists.json';
  let backup;
  let readMode = 'normal';
  let puts = 0;
  const { target, app } = await fixture(t, async (req, res, url) => {
    assert.match(req.headers.authorization, /^Basic /);
    if (req.method === 'PROPFIND') {
      assert.equal(url.pathname, '/collection/');
      req.resume();
      return res.writeHead(207, { 'Content-Type': 'application/xml' })
        .end('<d:multistatus xmlns:d="DAV:">' + davEntry(storedPath, 'groovebox-playlists.json') + '</d:multistatus>');
    }
    assert.equal(url.pathname, storedPath);
    assert.equal(url.search, '');
    if (req.method === 'PUT') {
      assert.match(req.headers['content-type'], /^application\/json/);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      backup = Buffer.concat(chunks).toString('utf8');
      puts += 1;
      return res.writeHead(puts === 1 ? 201 : 204).end();
    }
    assert.equal(req.method, 'GET');
    if (readMode === 'redirect') return res.writeHead(302, { Location: '/collection/unexpected.json' }).end();
    if (readMode === 'invalid') return res.writeHead(200).end('not a backup');
    if (readMode === 'large') {
      res.writeHead(200);
      res.write(Buffer.alloc(900_000, 65));
      return res.end(Buffer.alloc(100_001, 65));
    }
    if (backup == null) return res.writeHead(404).end();
    return res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(backup);
  });
  const cfg = { type: 'webdav', name: 'Backups', url: target + '/collection', username, password };
  const source = await connect(app, cfg);
  const endpoint = app + '/api/sources/' + source.id + '/backup';
  const headers = { Cookie: source.cookie };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json', Origin: app };
  const playlist = { id: 'list-1', name: '晚间收藏', tracks: ['track-1', 'track-2'] };
  const doc = { version: 1, playlists: [playlist] };
  const upload = (body, options = {}) => fetch(endpoint, {
    method: 'PUT', body: JSON.stringify(body), headers: jsonHeaders, ...options,
  });
  const missing = await fetch(endpoint, { headers });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /暂无/);
  assert.deepEqual(await list(app, source), []);
  assert.equal((await upload({ version: 2, playlists: [] })).status, 400);
  assert.equal((await upload(doc, { headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await upload(doc, { headers: { ...jsonHeaders, Origin: 'https://elsewhere.invalid' } })).status, 403);
  assert.equal((await upload({ ...doc, padding: 'x'.repeat(1_000_000) })).status, 413);
  assert.equal((await upload(doc, {
    body: (async function* () { yield Buffer.alloc(900_000); yield Buffer.alloc(100_001); })(),
    duplex: 'half',
  })).status, 413);
  assert.equal(puts, 0);
  const saved = await upload(doc);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { saved: true });
  assert.deepEqual(JSON.parse(backup), doc);
  const replaced = await upload({ ...doc, favorites: ['track-2'] });
  assert.equal(replaced.status, 200);
  assert.equal(puts, 2);
  assert.equal((await fetch(endpoint)).status, 404);
  const secondSession = await connect(app, { ...cfg, url: cfg.url + '/', password: 'changed-fixture-pass' });
  assert.notEqual(secondSession.cookie, source.cookie);
  assert.equal(secondSession.id, source.id);
  const restored = await fetch(endpoint, { headers: { Cookie: secondSession.cookie } });
  assert.equal(restored.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await restored.json(), { ...doc, favorites: ['track-2'] });
  const otherUser = await connect(app, { ...cfg, username: 'another-user' });
  assert.notEqual(otherUser.id, source.id);
  assert.equal((await fetch(endpoint, { headers: { Cookie: otherUser.cookie } })).status, 404);
  for (const [mode, status] of [['redirect', 502], ['invalid', 502], ['large', 413]]) {
    readMode = mode;
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, status);
    await response.json();
  }
});

test('Subsonic, OpenSubsonic, and Navidrome browse artists and albums with authenticated ranges and artwork', async t => {
  let lyricOrder = 'default';
  const { target, app } = await fixture(t, (req, res, url) => {
    const salt = url.searchParams.get('s');
    assert.match(salt, /^[\da-f]{32}$/);
    assert.equal(url.searchParams.get('t'), createHash('md5').update(password + salt).digest('hex'));
    assert.equal(url.searchParams.get('u'), username);
    assert.equal(url.searchParams.has('p'), false);
    const actions = {
      '/rest/getArtists.view': { artists: { index: [{ artist: [{ id: 'a-1', name: '艺人' }] }] } },
      '/rest/getAlbumList2.view': { albumList2: { album: [{ id: 'ab-1', name: '专辑', artist: '艺人', coverArt: 'art-1', year: 2003 }] } },
      '/rest/getArtist.view': { artist: { album: [{ id: 'ab-1', name: '专辑', year: 2003 }] } },
      '/rest/getAlbum.view': { album: { year: 2003, releaseDate: { year: 2004 }, originalReleaseDate: { year: 1989 }, displayArtist: '唱片乐团', song: [
        { id: 't-1', title: '午夜', artist: '艺人', displayArtist: '艺人 feat. 嘉宾', artists: [{ name: '艺人' }, { name: '嘉宾' }],
          album: '专辑', albumArtists: [{ id: 'co-1', name: '唱片乐团' }], year: 2001,
          genres: [{ name: 'Jazz' }, { name: '爵士' }], genre: 'jazz', suffix: 'mp3', duration: 120, size: 6, coverArt: 'art-1' },
        { id: 't-2', title: '清晨', year: 0 },
      ] } },
    };
    if (url.pathname === '/rest/getAlbumList2.view') {
      assert.equal(url.searchParams.get('type'), 'newest');
      assert.equal(url.searchParams.get('size'), '4');
    }
    if (url.pathname === '/rest/stream.view') {
      assert.equal(url.searchParams.get('id'), 't-1');
      assert.equal(url.searchParams.get('format'), 'raw');
      return rangedAudio(req, res);
    }
    if (url.pathname === '/rest/getLyricsBySongId.view') {
      assert.equal(url.searchParams.get('id'), 't-1');
      assert.equal(url.searchParams.get('enhanced'), 'true');
      const versions = [
        { kind: 'translation', synced: true, offset: -100, line: [{ start: 3200, value: 'Good morning' }, { start: 3200, value: 'Good day' }] },
        { kind: 'main', lang: 'zho', synced: true, offset: -100, line: [{ start: 3200, value: '早安' }],
          cueLine: [{ index: 0, cue: [{ start: 3200, value: '早' }, { start: 3700, value: '安' }] }] },
        { kind: 'main', lang: 'jpn', synced: true, offset: 200, line: [{ start: 3500, value: 'おはよう' }],
          cueLine: [{ index: 0, cue: [{ start: 3500, value: 'おは' }, { start: 4000, value: 'よう' }] }] },
        { lang: 'eng', synced: false, line: [{ value: 'Alternate reading' }] },
        { kind: 'pronunciation', lang: 'zho-Latn', synced: false, line: [{ value: 'Zǎo ān' }] },
        { kind: 'translation', synced: true, offset: 200, line: [{ start: 3500, value: 'Buenos días\nGood day' },
          { start: 3600, value: 'Different cue' }] },
        { kind: 'translation', synced: true, line: [{ start: 3300, value: 'Bonjour' }, { start: 3200, value: 'Untouched timing' }] },
      ];
      const structuredLyrics = lyricOrder === 'single' ? versions.filter((_, index) => index !== 2 && index !== 3)
        : lyricOrder === 'reversed' ? versions.toReversed() : versions;
      return reply(res, { 'subsonic-response': { status: 'ok', lyricsList: { structuredLyrics } } });
    }
    if (url.pathname === '/rest/getCoverArt.view') {
      assert.equal(url.searchParams.get('id'), 'art-1');
      return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Uint8Array.of(255, 216, 255, 217));
    }
    assert.ok(Object.hasOwn(actions, url.pathname), url.pathname);
    return reply(res, { 'subsonic-response': { status: 'ok', ...actions[url.pathname] } });
  });
  let cookie;
  for (const type of ['subsonic', 'opensubsonic', 'navidrome']) {
    const source = await connect(app, { type, name: type, url: target, username, password }, cookie);
    cookie = source.cookie;
    const [artist] = await list(app, source);
    assert.equal(artist.name, '艺人');
    assert.equal(artist.browseKind, 'artist');
    const [album] = await list(app, source, artist.path);
    assert.equal(album.browseKind, 'album');
    assert.equal(album.releaseYear, 2003);
    if (type === 'navidrome') {
      const [recommended] = await list(app, source, 'home-recommendations');
      assert.equal(recommended.path, album.path);
      assert.equal(recommended.artist, '艺人');
      const artwork = await fetch(app + recommended.cover, { headers: { Cookie: source.cookie } });
      assert.equal(artwork.headers.get('content-type'), 'image/jpeg');
      await artwork.arrayBuffer();
    }
    const [track, fallbackYearTrack] = await list(app, source, album.path);
    assert.equal(track.title, '午夜');
    assert.equal(track.artist, '艺人 feat. 嘉宾');
    assert.deepEqual(track.artistNames, ['艺人', '嘉宾']);
    assert.equal(fallbackYearTrack.artistNames, undefined);
    assert.equal(track.album, '专辑');
    assert.equal(track.albumArtist, '唱片乐团');
    assert.equal(fallbackYearTrack.albumArtist, '唱片乐团');
    assert.equal(track.releaseYear, 2001);
    assert.equal(fallbackYearTrack.releaseYear, 2004);
    assert.deepEqual(track.genres, ['Jazz', '爵士']);
    assert.equal(track.duration, 120);
    await assertStream(app, source, track);
    const art = await fetch(app + track.cover, { headers: { Cookie: source.cookie } });
    assert.equal(art.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await art.arrayBuffer())], [255, 216, 255, 217]);
    if (type !== 'subsonic') {
      const lyrics = await fetch(app + track.lyricsUrl, { headers: { Cookie: source.cookie } });
      assert.equal(lyrics.status, 200);
      const payload = await lyrics.json();
      assert.deepEqual(payload.lines, [{
        text: '早安', time: 3.3, words: [{ time: 3.3, text: '早' }, { time: 3.8, text: '安' }],
      }]);
      assert.equal(payload.defaultVersion.language, 'zho');
      assert.match(payload.defaultVersion.id, /^[a-f0-9]{24}$/);
      assert.deepEqual(payload.variants.map(({ language, timed, lines }) => ({ language, timed, lines })), [
        { language: 'jpn', timed: true, lines: [{ text: 'おはよう', time: 3.3,
          words: [{ time: 3.3, text: 'おは' }, { time: 3.8, text: 'よう' }] }] },
        { language: 'eng', timed: false, lines: [{ text: 'Alternate reading', time: null }] },
      ]);
      const cached = await fetch(app + track.lyricsUrl, { headers: { Cookie: source.cookie } });
      assert.deepEqual(await cached.json(), payload);
      if (type === 'navidrome') {
        lyricOrder = 'reversed';
        const reversed = await fetch(app + track.lyricsUrl, { headers: { Cookie: source.cookie } });
        const alternate = await reversed.json();
        assert.equal(alternate.defaultVersion.id, payload.variants[0].id);
        assert.deepEqual(alternate.lines, payload.variants[0].lines);
        assert.deepEqual(alternate.variants[0].lines, payload.lines);
        lyricOrder = 'single';
        const single = await fetch(app + track.lyricsUrl, { headers: { Cookie: source.cookie } });
        assert.deepEqual(await single.json(), { lines: [{ ...payload.lines[0], translation: 'Good morning\nGood day\nBuenos días\nBonjour' }] });
      }
    }
  }
});

test('Subsonic-family playlist directories preserve server order and duplicate songs in an authenticated session', async t => {
  const first = { id: 'song-1', title: 'Alpha Song', suffix: 'mp3' };
  const second = { id: 'song-2', title: 'Zebra Song', suffix: 'mp3' };
  const { target, app } = await fixture(t, (req, res, url) => {
    const salt = url.searchParams.get('s');
    assert.equal(url.searchParams.get('u'), username);
    assert.equal(url.searchParams.get('t'), createHash('md5').update(password + salt).digest('hex'));
    const response = data => reply(res, { 'subsonic-response': { status: 'ok', ...data } });
    switch (url.pathname) {
      case '/rest/getArtists.view': return response({ artists: {} });
      case '/rest/getPlaylists.view': return response({ playlists: { playlist: { id: 'server-list-id', name: 'Server Mix' } } });
      case '/rest/getPlaylist.view':
        assert.equal(url.searchParams.get('id'), 'server-list-id');
        return response({ playlist: { entry: [second, { id: 'video', isVideo: true }, first, second] } });
      case '/rest/stream.view':
        assert.equal(url.searchParams.get('id'), second.id);
        return rangedAudio(req, res);
      default: assert.fail('Unexpected Subsonic route ' + url.pathname);
    }
  });
  let cookie;
  for (const type of ['subsonic', 'opensubsonic', 'navidrome']) {
    const source = await connect(app, { type, name: type, url: target, username, password }, cookie);
    cookie = source.cookie;
    assert.deepEqual(await list(app, source), []);
    const [playlist] = await list(app, source, 'playlists');
    assert.equal(playlist.name, 'Server Mix');
    assert.equal(playlist.folder, true);
    assert.notEqual(playlist.path, 'server-list-id');
    const endpoint = app + '/api/sources/' + source.id + '/list?path=';
    assert.equal((await fetch(endpoint + playlist.path)).status, 404);
    assert.equal((await fetch(endpoint + 'server-list-id', { headers: { Cookie: cookie } })).status, 404);
    const opened = await fetch(endpoint + playlist.path, { headers: { Cookie: cookie } });
    const payload = await opened.json();
    assert.equal(opened.status, 200, JSON.stringify(payload));
    assert.equal(payload.serverOrder, true);
    assert.deepEqual(payload.items.map(track => track.title), [second.title, first.title, second.title]);
    assert.equal(payload.items[0].streamUrl, payload.items[2].streamUrl);
    await assertStream(app, source, payload.items[2]);
  }
});

test('Emby combines tagged disc subfolders only when they contain one complete album layout', async t => {
  const albums = ['tagged-album', 'mixed-albums', 'missing-disc', 'ordinary-folders', 'unsupported-recursion'];
  const nestedRequests = [];
  const { target, app } = await fixture(t, (req, res, url) => {
    assert.equal(req.headers['x-emby-token'], token);
    assert.equal(url.pathname, '/emby/Users/test-user/Items');
    assert.equal(url.searchParams.get('UserId'), 'test-user');
    const parentId = url.searchParams.get('ParentId');
    if (!parentId) return reply(res, { Items: albums.map(Id => ({ Id, Name: Id, Type: 'Folder' })) });
    assert.ok(albums.includes(parentId));
    if (url.searchParams.get('Recursive') === 'false') {
      return reply(res, { Items: (parentId === 'ordinary-folders' ? ['Disc 1', 'Extras'] : ['CD 01', 'Disc 2']).map(Name =>
        ({ Id: parentId + ':' + Name, Name, Type: 'Folder' })) });
    }
    assert.equal(url.searchParams.get('Recursive'), 'true');
    assert.equal(url.searchParams.get('IncludeItemTypes'), 'Audio');
    nestedRequests.push(parentId);
    if (parentId === 'unsupported-recursion') return res.writeHead(400).end();
    const first = { Id: parentId + '-1', Name: 'First song', Type: 'Audio', AlbumId: 'one-album', ParentIndexNumber: 1, IndexNumber: 1 };
    const second = { ...first, Id: parentId + '-2', Name: 'Second song', ParentIndexNumber: 2,
      AlbumId: parentId === 'mixed-albums' ? 'another-album' : first.AlbumId };
    return reply(res, { Items: parentId === 'missing-disc' ? [first] : [first, second] });
  });
  const source = await connect(app, { type: 'emby', name: 'Emby', url: target, token, userId: 'test-user' });
  const [taggedAlbum, ...otherAlbums] = await list(app, source);
  assert.equal(taggedAlbum.browseKind, undefined);
  const contents = await list(app, source, taggedAlbum.path);
  const songs = contents.filter(item => !item.folder);
  assert.deepEqual(contents.filter(item => item.albumDiscFolder === true).map(folder => [folder.name, folder.folder]),
    [['CD 01', true], ['Disc 2', true]]);
  assert.deepEqual(songs.map(song => [song.title, song.discNumber]), [['First song', 1], ['Second song', 2]]);
  assert.equal(songs[0].albumKey, songs[1].albumKey);
  for (const album of otherAlbums) {
    const folders = await list(app, source, album.path);
    assert.deepEqual(folders.map(folder => folder.name), album.name === 'ordinary-folders' ? ['Disc 1', 'Extras'] : ['CD 01', 'Disc 2']);
    assert.ok(folders.every(folder => folder.folder && !Object.hasOwn(folder, 'albumDiscFolder')));
  }
  assert.deepEqual(nestedRequests, ['tagged-album', 'mixed-albums', 'missing-disc', 'unsupported-recursion']);
});

test('Jellyfin lists authenticated audio playlists in server order and scope', async t => {
  const tracks = [{ Id: 'jellyfin-z', Type: 'Audio', Name: 'Zulu' }, { Id: 'jellyfin-a', Type: 'Audio', Name: 'Alpha' }];
  const { target, app } = await fixture(t, (req, res, url) => {
    if (url.pathname === '/Users/AuthenticateByName') {
      return reply(res, { AccessToken: token, User: { Id: 'jellyfin-user' } });
    }
    assert.match(req.headers.authorization, /Token="fixture-token"$/);
    if (url.pathname === '/Audio/jellyfin-z/stream') return rangedAudio(req, res);
    assert.equal(req.method, 'GET');
    assert.equal(url.searchParams.get('UserId'), 'jellyfin-user');
    if (url.pathname === '/Items') {
      if (!url.searchParams.has('IncludeItemTypes')) return reply(res, { Items: [] });
      assert.equal(url.searchParams.get('IncludeItemTypes'), 'Playlist');
      assert.equal(url.searchParams.get('Recursive'), 'true');
      return reply(res, { Items: [
        { Id: 'jellyfin-audio-list', Type: 'Playlist', Name: 'Music' },
        { Id: 'jellyfin-video-list', Type: 'Playlist', Name: 'Movies', MediaType: 'Video' },
      ] });
    }
    assert.equal(url.pathname, '/Playlists/jellyfin-audio-list/Items');
    assert.equal(url.searchParams.has('SortBy'), false);
    if (url.searchParams.get('Limit') === '1') return reply(res, { Items: [tracks[0]], TotalRecordCount: 3 });
    return reply(res, { Items: [...tracks, tracks[0]], TotalRecordCount: 3 });
  });
  const source = await connect(app, { type: 'jellyfin', name: 'Jellyfin', url: target, username, password });
  const playlists = await list(app, source, 'playlists');
  assert.deepEqual(playlists.map(playlist => playlist.name), ['Music']);
  const listUrl = app + '/api/sources/' + source.id + '/list?path=';
  assert.equal((await fetch(listUrl + playlists[0].path)).status, 404);
  assert.equal((await fetch(listUrl + 'jellyfin-audio-list', { headers: { Cookie: source.cookie } })).status, 404);
  const listing = await fetch(listUrl + playlists[0].path, { headers: { Cookie: source.cookie } });
  assert.equal(listing.status, 200);
  const playlist = await listing.json();
  assert.equal(playlist.serverOrder, true);
  assert.deepEqual(playlist.items.map(item => item.title), ['Zulu', 'Alpha', 'Zulu']);
  assert.equal(playlist.items[0].id, playlist.items[2].id);
  assert.doesNotMatch(JSON.stringify({ playlists, playlist }), /jellyfin-(?:audio-list|z|user)|fixture-token/);
  await assertStream(app, source, playlist.items[0]);
  const write = await fetch(app + '/api/sources/' + source.id + '/playlist?path=' + playlists[0].path, {
    method: 'POST', headers: { Cookie: source.cookie, Origin: app, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', trackId: playlist.items[0].id }),
  });
  assert.equal(write.status, 405);
});

test('Jellyfin edits private audio playlists with account-bound unique and counted removal tokens', async t => {
  const owner = 'a'.repeat(32);
  const editor = 'c'.repeat(32);
  const editable = '1'.repeat(32);
  const readOnly = '2'.repeat(32);
  const created = '3'.repeat(32);
  const firstId = '4'.repeat(32);
  const secondId = '5'.repeat(32);
  const sharedEntry = '6'.repeat(32);
  const uniqueEntry = '7'.repeat(32);
  const separateEntry = '8'.repeat(32);
  const ambiguousEntry = '9'.repeat(32);
  const first = { Id: firstId, Type: 'Audio', Name: 'First' };
  const second = { Id: secondId, Type: 'Audio', Name: 'Second' };
  const row = (track, PlaylistItemId) => ({ ...track, PlaylistItemId });
  const firstList = [row(first, sharedEntry), row(first, sharedEntry), row(second, uniqueEntry),
    row(first, separateEntry), row(first, ambiguousEntry), row(second, ambiguousEntry)];
  const lists = new Map([[editable, firstList], [readOnly, [row(second, uniqueEntry)]]]);
  const writes = [];
  let wrongTrack = false;
  let permission = true;
  let version = '12.4.0';
  let audioCheck;
  const { target, app } = await fixture(t, async (req, res, url) => {
    if (url.pathname.startsWith('/alias/')) url.pathname = url.pathname.slice('/alias'.length);
    if (url.pathname === '/Users/AuthenticateByName') return reply(res, { AccessToken: 'owner-token', User: { Id: owner } });
    const auth = /Token="([^"]+)"$/.exec(req.headers.authorization)?.[1];
    if (url.pathname === '/Users/Me') {
      if (auth === 'admin-api-key') return res.writeHead(400).end();
      assert.equal(auth, 'editor-user-token');
      return reply(res, { Id: editor });
    }
    assert.ok(['admin-api-key', 'owner-token', 'editor-user-token'].includes(auth));
    const caller = auth === 'editor-user-token' ? editor : owner;
    if (url.pathname === '/System/Info/Public') return reply(res, { Version: version, Id: 'f'.repeat(32) });
    if (url.pathname === '/System/Configuration/MetadataOptions/Default') {
      assert.equal(auth, 'admin-api-key');
      return res.writeHead(403).end();
    }
    if (url.pathname === '/Items') {
      const items = url.searchParams.get('IncludeItemTypes') === 'Playlist'
        ? [...lists].map(([Id]) => ({ Id, Type: 'Playlist', MediaType: 'Audio', Name: Id })) : [first, second];
      return reply(res, { Items: items, TotalRecordCount: items.length });
    }
    if (url.pathname === '/Items/' + firstId) {
      assert.equal(req.method, 'GET');
      assert.equal(url.searchParams.get('UserId'), caller);
      if (audioCheck) {
        audioCheck.started();
        await audioCheck.wait;
      }
      return reply(res, wrongTrack ? { ...first, Type: 'Video' } : first);
    }
    if (url.pathname === '/Audio/' + firstId + '/stream') return rangedAudio(req, res);
    if (url.pathname === '/Playlists') {
      assert.equal(req.method, 'POST');
      assert.equal(url.search, '');
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      assert.deepEqual(input, { Name: '新歌单', UserId: owner, MediaType: 'Audio', IsPublic: false });
      writes.push(['create', created]);
      lists.set(created, []);
      return reply(res, { Id: created });
    }
    const [_, id, operation, user] = /^\/Playlists\/([a-f0-9]+)\/(Items|Users)(?:\/([a-f0-9]+))?$/.exec(url.pathname) || [];
    assert.ok(lists.has(id), url.pathname);
    if (operation === 'Users') {
      assert.equal(user, caller);
      return reply(res, { UserId: caller, CanEdit: id !== readOnly && permission });
    }
    const entries = lists.get(id);
    if (req.method === 'GET') {
      assert.equal(url.searchParams.get('UserId'), caller);
      return reply(res, { Items: entries, TotalRecordCount: entries.length, StartIndex: 0 });
    }
    if (req.method === 'POST') {
      assert.deepEqual(Object.fromEntries(url.searchParams), { ids: firstId, userId: caller });
      writes.push(['add', id]);
      entries.push(row(first, sharedEntry));
    } else {
      assert.equal(req.method, 'DELETE');
      const entry = url.searchParams.get('entryIds');
      assert.deepEqual(Object.fromEntries(url.searchParams), { entryIds: entry });
      writes.push(['remove', id, entry]);
      lists.set(id, entries.filter(item => item.PlaylistItemId !== entry));
    }
    return res.writeHead(204).end();
  });
  const config = { type: 'jellyfin', url: target, name: 'Jellyfin' };
  const source = await connect(app, { ...config, username, password }, undefined, { playlistWritable: true });
  const other = await connect(app, { ...config, url: target + '/alias', userId: editor, token: 'editor-user-token' }, undefined, { playlistWritable: true });
  const apiKey = await connect(app, { ...config, userId: owner, token: 'admin-api-key' });
  const [editableFolder, readOnlyFolder] = await list(app, source, 'playlists');
  assert.equal(editableFolder.playlistWritable, true);
  assert.equal(readOnlyFolder.playlistWritable, false);
  assert.equal((await list(app, apiKey, 'playlists'))[0].playlistWritable, false);
  const update = (account, path, input, origin = app) => fetch(app + '/api/sources/' + account.id + '/playlist?' + new URLSearchParams({ path }), {
    method: 'POST', headers: { Cookie: account.cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  async function detail(account, path = editableFolder.path) {
    const response = await fetch(app + '/api/sources/' + account.id + '/list?' + new URLSearchParams({ path }), { headers: { Cookie: account.cookie } });
    assert.equal(response.status, 200);
    return response.json();
  }
  const createdResponse = await update(source, 'playlists', { action: 'create', name: '新歌单' });
  assert.equal(createdResponse.status, 201);
  const made = (await createdResponse.json()).playlist;
  assert.equal(made.playlistWritable, true);
  assert.deepEqual((await detail(source, made.path)).items, []);
  await list(app, other, 'playlists');
  const otherEntries = await detail(other);
  const firstEntries = await detail(source);
  const [one, two, unique, separate, mixedA, mixedB] = firstEntries.items;
  assert.equal(firstEntries.playlistWritable, true);
  assert.equal(firstEntries.serverOrder, true);
  assert.match(firstEntries.playlistRevision, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(one.id, two.id);
  assert.equal(one.playlistEntry, undefined);
  assert.equal(two.playlistRemoveEntry, one.playlistRemoveEntry);
  assert.equal(one.playlistRemoveCount, 2);
  assert.notEqual(one.playlistRemoveEntry, otherEntries.items[0].playlistRemoveEntry);
  assert.notEqual(unique.playlistEntry, otherEntries.items[2].playlistEntry);
  assert.ok(separate.playlistEntry);
  assert.equal(mixedA.playlistEntry, undefined);
  assert.equal(mixedB.playlistRemoveEntry, undefined);
  const remove = entryId => ({ action: 'remove', entryId });
  const append = { action: 'add', trackId: one.id };
  assert.equal((await update(other, editableFolder.path, remove(one.playlistRemoveEntry))).status, 404);
  assert.equal((await update(source, editableFolder.path, append, 'https://outside.invalid')).status, 403);
  assert.equal((await update(source, readOnlyFolder.path, append)).status, 403);
  assert.equal((await update(apiKey, editableFolder.path, append)).status, 405);
  assert.equal((await update(source, editable, append)).status, 404);
  assert.equal((await update(source, editableFolder.path, { action: 'add', trackId: firstId })).status, 404);
  wrongTrack = true;
  assert.equal((await update(source, editableFolder.path, append)).status, 404);
  wrongTrack = false;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  audioCheck = { started: started.resolve, wait: release.promise };
  const addition = update(source, editableFolder.path, append);
  await started.promise;
  try {
    assert.equal((await update(other, editableFolder.path, remove(otherEntries.items[0].playlistRemoveEntry))).status, 409);
  } finally {
    release.resolve();
  }
  assert.equal((await addition).status, 200);
  audioCheck = undefined;
  assert.equal((await update(source, editableFolder.path, remove(one.playlistRemoveEntry))).status, 409);
  permission = false;
  assert.equal((await update(source, editableFolder.path, remove(unique.playlistEntry))).status, 403);
  permission = true;
  assert.equal((await update(source, editableFolder.path, remove(unique.playlistEntry))).status, 200);
  assert.equal((await update(source, editableFolder.path, remove(unique.playlistEntry))).status, 404);
  const group = (await detail(source)).items[0];
  assert.equal(group.playlistRemoveCount, 3);
  assert.notEqual(group.playlistRemoveEntry, one.playlistRemoveEntry);
  assert.equal((await update(source, editableFolder.path, remove(group.playlistRemoveEntry))).status, 200);
  const after = (await detail(source)).items;
  assert.deepEqual(after.map(item => item.title), ['First', 'First', 'Second']);
  await assertStream(app, source, after[0]);
  assert.deepEqual(writes, [['create', created], ['add', editable], ['remove', editable, uniqueEntry], ['remove', editable, sharedEntry]]);

  version = '10.8.13';
  const old = await connect(app, { ...config, username, password });
  assert.equal((await update(old, 'playlists', { action: 'create', name: '旧版' })).status, 405);
});

test('Jellyfin scopes verified server keys to an explicit user and reports uncertain native writes without resending', async t => {
  const id = char => char.repeat(32);
  const selected = id('1');
  const other = id('2');
  const invalid = id('3');
  const playlistId = id('4');
  const song = { Id: id('5'), Type: 'Audio', Name: 'Scoped song' };
  const entry = { ...song, PlaylistItemId: id('6') };
  const playlist = { Id: playlistId, Type: 'Playlist', Name: 'Scoped playlist', MediaType: 'Audio' };
  let elevation = true;
  let targetAvailable = true;
  let playlistVisible = true;
  let trackVisible = true;
  let currentPlaylistType = 'Audio';
  let ambiguous = '';
  const entries = [entry];
  const writes = [];
  let elevationChecks = 0;
  const elevatedEndpoint = '/System/Configuration/MetadataOptions/Default';
  const { target, app } = await fixture(t, async (req, res, url) => {
    const bearer = /Token="([^"]+)"$/.exec(req.headers.authorization)?.[1];
    assert.ok(['key', 'admin-user', 'unproven-key'].includes(bearer));
    if (url.pathname === '/Users/Me') {
      if (bearer === 'admin-user') return reply(res, { Id: other });
      return res.writeHead(400).end();
    }
    if (url.pathname === elevatedEndpoint) {
      assert.notEqual(bearer, 'admin-user', 'A mismatched user identity must never fall back to key mode.');
      elevationChecks++;
      return elevation && bearer === 'key' ? reply(res, {}) : res.writeHead(403).end();
    }
    if (url.pathname.startsWith('/Users/')) {
      assert.equal(bearer, 'key');
      assert.ok([selected, invalid].some(user => url.pathname === '/Users/' + user));
      return targetAvailable && url.pathname.endsWith(selected) ? reply(res, { Id: selected }) : res.writeHead(404).end();
    }
    if (url.pathname === '/System/Info/Public') return reply(res, { Version: '12.4.0' });
    if (url.pathname === '/Items') {
      const explicit = url.searchParams.get('Ids');
      if (explicit) {
        assert.equal(bearer, 'key');
        assert.equal(url.searchParams.get('UserId'), selected);
        assert.equal(url.searchParams.get('Recursive'), 'true');
        assert.equal(url.searchParams.get('EnableImages'), 'false');
        assert.equal(url.searchParams.get('IncludeItemTypes'), explicit === playlistId ? 'Playlist' : 'Audio');
        const item = explicit === playlistId ? playlistVisible && { ...playlist, MediaType: currentPlaylistType } : trackVisible && song;
        return reply(res, { Items: item ? [item] : [] });
      }
      const items = url.searchParams.get('IncludeItemTypes') === 'Playlist' ? [playlist] : [song];
      return reply(res, { Items: items, TotalRecordCount: items.length });
    }
    assert.equal(bearer, 'key');
    if (url.pathname === '/Playlists') {
      assert.equal(req.method, 'POST');
      let body = '';
      for await (const part of req) body += part;
      const input = JSON.parse(body);
      assert.deepEqual(input, { Name: 'Private list', UserId: selected, MediaType: 'Audio', IsPublic: false });
      writes.push('create');
      return reply(res, ambiguous === 'create' ? { Id: 'invalid-after-commit' } : { Id: id('7') });
    }
    assert.equal(url.pathname, '/Playlists/' + playlistId + '/Items');
    if (req.method === 'GET') {
      assert.equal(url.searchParams.get('UserId'), selected);
      return reply(res, { Items: entries, TotalRecordCount: entries.length, StartIndex: 0 });
    }
    if (req.method === 'POST') {
      assert.deepEqual(Object.fromEntries(url.searchParams), { ids: song.Id, userId: selected });
      if (ambiguous === 'native-forbidden') return res.writeHead(403).end();
      entries.push(entry);
      writes.push('add');
    } else {
      assert.equal(req.method, 'DELETE');
      assert.deepEqual(Object.fromEntries(url.searchParams), { entryIds: entry.PlaylistItemId });
      entries.length = 0;
      writes.push('remove');
    }
    if (ambiguous === 'add') return res.destroy();
    return res.writeHead(ambiguous === 'remove' ? 502 : 204).end();
  });
  const config = { type: 'jellyfin', name: 'Scoped Jellyfin', url: target, token: 'key' };
  const established = await connect(app, { ...config, userId: selected }, undefined, { playlistWritable: true, playlistAuthority: 'api-key' });
  const noId = await connect(app, config);
  const wrong = await connect(app, { ...config, userId: invalid });
  const unproven = await connect(app, { ...config, userId: selected, token: 'unproven-key' });
  const checks = elevationChecks;
  const mismatch = await connect(app, { ...config, userId: selected, token: 'admin-user' });
  assert.equal(elevationChecks, checks);
  const [track] = await list(app, established);
  const [folder] = await list(app, established, 'playlists');
  assert.equal(folder.playlistWritable, true);
  const update = (source, path, body) => fetch(app + '/api/sources/' + source.id + '/playlist?' + new URLSearchParams({ path }), {
    method: 'POST', headers: { Cookie: source.cookie, Origin: app, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const create = { action: 'create', name: 'Private list' };
  for (const unavailable of [noId, wrong, unproven, mismatch]) {
    assert.equal((await update(unavailable, 'playlists', create)).status, 405);
  }
  const append = { action: 'add', trackId: track.id };
  elevation = false;
  assert.equal((await update(established, 'playlists', create)).status, 403);
  elevation = true;
  targetAvailable = false;
  assert.equal((await update(established, folder.path, append)).status, 403);
  targetAvailable = true;
  playlistVisible = false;
  assert.equal((await update(established, folder.path, append)).status, 403);
  playlistVisible = true;
  currentPlaylistType = 'Video';
  assert.equal((await update(established, folder.path, append)).status, 403);
  currentPlaylistType = 'Audio';
  trackVisible = false;
  assert.equal((await update(established, folder.path, append)).status, 404);
  trackVisible = true;
  ambiguous = 'native-forbidden';
  const forbidden = await update(established, folder.path, append);
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, undefined);
  assert.deepEqual(writes, []);

  async function checkUnknown(response) {
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'playlist_commit_unknown');
  }
  ambiguous = 'create';
  await checkUnknown(await update(established, 'playlists', create));
  ambiguous = 'add';
  await checkUnknown(await update(established, folder.path, append));
  assert.equal(entries.length, 2);
  const [group] = await list(app, established, folder.path);
  assert.equal(group.playlistRemoveCount, 2);
  ambiguous = 'remove';
  await checkUnknown(await update(established, folder.path, { action: 'remove', entryId: group.playlistRemoveEntry }));
  assert.deepEqual(await list(app, established, folder.path), []);
  assert.deepEqual(writes, ['create', 'add', 'remove']);
});

test('Jellyfin login and Emby API token expose metadata and private audio streams', async t => {
  const { target, app } = await fixture(t, async (req, res, url) => {
    if (url.pathname === '/Users/AuthenticateByName') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { Username: username, Pw: password });
      assert.match(req.headers.authorization, /^MediaBrowser Client="Groovebox"/);
      assert.doesNotMatch(req.headers.authorization, /Token=/);
      return reply(res, { AccessToken: token, User: { Id: 'uf' } });
    }
    if (url.pathname.startsWith('/emby/')) {
      assert.equal(req.headers['x-emby-token'], token);
      assert.equal(req.headers.authorization, undefined);
    } else assert.match(req.headers.authorization, /Token="fixture-token"$/);
    if (url.pathname === '/emby/Items/audio-1/Lyrics') {
      return reply(res, { Lyrics: [{ Start: 10000000, Text: 'Emby lyrics' }] });
    }
    if (url.pathname === '/Audio/audio-1/Lyrics') {
      return reply(res, { Tracks: [
        { Type: 'Main', Lyrics: [{ Start: 10000000, Text: 'Hello', Syllables: [{ Start: 10000000, Text: 'Hel' }, { Start: 15000000, Text: 'lo' }] }] },
        { Type: 'Translation', Lyrics: [{ Start: 10000000, Text: '你好' }, { Start: 10000000, Text: '早安' }] },
        { type: 'Translation', lines: [{ start: 10000000, text: 'Bonjour\r\n早安' }, { start: 20000000, text: 'Different cue' }] },
      ] });
    }
    if (url.pathname.endsWith('/stream')) {
      assert.equal(url.searchParams.get('Static'), 'true');
      return rangedAudio(req, res);
    }
    if (url.pathname.endsWith('/Items/album-1/Images/Primary')) {
      assert.equal(url.searchParams.get('maxWidth'), '640');
      return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Uint8Array.of(255, 216, 255, 217));
    }
    assert.match(url.pathname, /^(?:\/emby\/Users\/ue)?\/Items$/);
    assert.equal(url.searchParams.get('UserId'), url.pathname.startsWith('/emby') ? 'ue' : 'uf');
    assert.ok(url.searchParams.get('Fields').split(',').includes('Genres'));
    if (url.searchParams.get('ParentId') === 'library') {
      return reply(res, { Items: [{ Id: 'album-1', Name: 'Nights', Type: 'MusicAlbum', ProductionYear: 2005, ImageTags: { Primary: 'art' } }], TotalRecordCount: 1 });
    }
    return url.searchParams.has('ParentId') ?
      reply(res, { Items: [{ Id: 'audio-1', Type: 'Audio', Name: 'Moon', Artists: ['A', 'B'], Album: 'Nights', AlbumArtist: 'Studio',
        AlbumId: 'album-1', ParentIndexNumber: 2, IndexNumber: 3,
        Genres: ['电子'], GenreItems: [{ Name: 'Ambient' }], ProductionYear: 2007,
        RunTimeTicks: 1200000000, MediaSources: [{ Id: 'one', Container: 'mp3', Size: 6 }] },
      { Id: 'audio-2', Type: 'Audio', Name: 'Sun', Album: 'Nights', AlbumId: 'album-1', ParentIndexNumber: 0, IndexNumber: -8 }], TotalRecordCount: 2 }) :
      reply(res, { Items: [{ Id: 'library', Name: 'Music', Type: 'CollectionFolder', CollectionType: 'music' },
        { Id: 'ignored', Name: 'Movies', Type: 'CollectionFolder', CollectionType: 'movies' }], TotalRecordCount: 2 });
  });
  const jellyfin = await connect(app, { type: 'jellyfin', name: 'Jellyfin', url: target, username, password });
  const emby = await connect(app, { type: 'emby', name: 'Emby', url: target, token, userId: 'ue' }, jellyfin.cookie);
  for (const source of [jellyfin, emby]) {
    const folders = await list(app, source);
    assert.deepEqual(folders.map(folder => folder.name), ['Music']);
    const [album] = await list(app, source, folders[0].path);
    assert.equal(album.folder, true);
    assert.equal(folders[0].browseKind, undefined);
    assert.equal(album.browseKind, 'album');
    assert.equal(album.name, 'Nights');
    assert.equal(album.releaseYear, 2005);
    const cover = await fetch(app + album.cover, { headers: { Cookie: source.cookie } });
    assert.equal(cover.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await cover.arrayBuffer())], [255, 216, 255, 217]);
    const [track, fallbackYearTrack] = await list(app, source, album.path);
    assert.equal(track.artist, 'A, B');
    assert.deepEqual(track.artistNames, ['A', 'B']);
    assert.equal(track.albumArtist, 'Studio');
    assert.equal(track.discNumber, 2);
    assert.equal(track.trackNumber, 3);
    assert.equal(track.albumKey, fallbackYearTrack.albumKey);
    assert.notEqual(track.albumKey, 'album-1');
    assert.equal(fallbackYearTrack.discNumber, undefined);
    assert.equal(fallbackYearTrack.trackNumber, undefined);
    assert.equal(Object.hasOwn(fallbackYearTrack, 'albumArtist'), false);
    assert.equal(track.releaseYear, 2007);
    assert.equal(fallbackYearTrack.releaseYear, 2005);
    assert.deepEqual(track.genres, ['电子', 'Ambient']);
    assert.equal(track.duration, 120);
    await assertStream(app, source, track);
    if (track.lyricsUrl) {
      const lyrics = await fetch(app + track.lyricsUrl, { headers: { Cookie: source.cookie } });
      assert.equal(lyrics.status, 200);
      assert.deepEqual((await lyrics.json()).lines, source === emby ? [{ text: 'Emby lyrics', time: 1 }] : [{
        text: 'Hello', time: 1, translation: '你好\n早安\nBonjour', words: [{ time: 1, text: 'Hel' }, { time: 1.5, text: 'lo' }],
      }]);
    }

  }
});

test('Plex keeps session tokens out of proxied URLs and refuses upstream download redirects outside its source', async t => {
  const { target, app } = await fixture(t, (req, res, url) => {
    assert.equal(req.headers['x-plex-token'], token);
    assert.equal(url.searchParams.has('X-Plex-Token'), false);
    if (url.pathname === '/library/parts/normal') return rangedAudio(req, res);
    if (url.pathname === '/library/parts/redirect') return res.writeHead(302, { Location: 'https://outside.invalid/audio' }).end();
    const sections = { Directory: [{ type: 'artist', key: '1', title: 'Music' }] };
    const artists = { Metadata: [{ type: 'artist', ratingKey: 2, title: 'Artist', key: '/library/metadata/2' }] };
    const albums = { Metadata: [{ type: 'album', ratingKey: 3, title: 'Album', key: '/library/metadata/3/children',
      originallyAvailableAt: '2008-04-17' }] };
    const tracks = { Metadata: ['normal', 'redirect'].map((name, index) => ({
      type: 'track', title: name, ratingKey: 100 + index, originalTitle: 'Performer', grandparentTitle: 'Artist', parentTitle: 'Album',
      Genre: [{ tag: 'Art Rock' }], year: index ? 0 : 2009,
      duration: 120000, Media: [{ container: 'mp3', Part: [{ key: '/library/parts/' + name + '?X-Plex-Token=' + token, size: 6 }] }],
    })) };
    const contents = { '/library/sections': sections, '/library/sections/1/all': artists,
      '/library/metadata/2/children': albums, '/library/metadata/3/children': tracks };
    assert.ok(Object.hasOwn(contents, url.pathname), url.pathname);
    return reply(res, { MediaContainer: contents[url.pathname] });
  });
  const source = await connect(app, { type: 'plex', name: 'Plex', url: target, token });
  const [library] = await list(app, source);
  const [artist] = await list(app, source, library.path);
  const [album] = await list(app, source, artist.path);
  const [normal, redirect] = await list(app, source, album.path);
  assert.equal(album.releaseYear, 2008);
  assert.equal(normal.releaseYear, 2009);
  assert.equal(normal.artist, 'Performer');
  assert.equal(normal.albumArtist, 'Artist');
  assert.equal(redirect.releaseYear, 2008);
  assert.deepEqual(normal.genres, ['Art Rock']);
  await assertStream(app, source, normal);
  const res = await fetch(app + redirect.streamUrl, { headers: { Cookie: source.cookie } });
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(await res.json()), /outside\.invalid|fixture-token/);
});

test('Kodi lists paginated albums and singles, proxies covers and ranges, and keeps credentials scoped', async t => {
  const song = {
    songid: 41, title: '夜色', artist: ['原声', '嘉宾'], album: '音乐会', albumartist: ['音乐会乐团'], genre: ['原声'], duration: 42,
    file: 'smb://music.local/共享/夜色 #1.mp3', thumbnail: 'image://music-art%2Fcover.jpg/', year: 1999,
  };
  const audioPath = '/kodi/vfs/' + encodeURIComponent(song.file);
  const coverPath = '/kodi/image/' + encodeURIComponent(song.thumbnail);
  const jpeg = Buffer.from([255, 216, 255, 217]);
  let coverMode = 'typed';
  const { target, app } = await fixture(t, async (req, res, url) => {
    const basic = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    if (req.headers.authorization !== basic) return res.writeHead(401).end();
    if (url.pathname === audioPath) return rangedAudio(req, res);
    if (url.pathname === coverPath) {
      const bytes = coverMode === 'invalid' ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') : jpeg;
      const type = coverMode === 'typed' ? 'image/jpeg' : coverMode === 'wrong-type' ? 'text/plain' : undefined;
      return res.writeHead(200, { 'Content-Length': bytes.length, ...(type && { 'Content-Type': type }) }).end(bytes);
    }
    assert.equal(url.pathname, '/kodi/jsonrpc');
    assert.equal(req.method, 'POST');
    let body = '';
    for await (const chunk of req) body += chunk;
    const { id, method, params } = JSON.parse(body);
    let result;
    if (method === 'AudioLibrary.GetAlbums') {
      const { start } = params.limits;
      assert.ok(params.properties.includes('year'));
      const albums = [{ albumid: 7, label: '音乐会', year: 1998 }, { albumid: 8, label: '旅行', year: null }];
      result = { albums: [albums[start]], limits: { start, end: start + 1, total: albums.length } };
    } else {
      assert.equal(method, 'AudioLibrary.GetSongs');
      if (!params.singlesonly) assert.deepEqual(params.filter, { albumid: 7 });
      assert.ok(params.properties.includes('file'));
      assert.ok(params.properties.includes('genre'));
      assert.ok(params.properties.includes('albumartist'));
      assert.ok(params.properties.includes('year'));
      const songs = params.singlesonly ? [] : [song];
      result = { songs, limits: { start: 0, end: songs.length, total: songs.length } };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  const config = { type: 'kodi', name: '客厅 Kodi', url: target + '/kodi', username, password };
  const bad = await fetch(app + '/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...config, password: 'wrong' }) });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  await bad.json();

  const source = await connect(app, config);
  const [singles, album, nextAlbum] = await list(app, source);
  assert.equal(singles.name, '单曲');
  assert.equal(album.name, '音乐会');
  assert.equal(album.releaseYear, 1998);
  assert.equal(nextAlbum.name, '旅行');
  assert.equal(Object.hasOwn(nextAlbum, 'releaseYear'), false);
  assert.deepEqual(await list(app, source, singles.path), []);
  const [track] = await list(app, source, album.path);
  assert.equal(track.title, '夜色');
  assert.equal(track.artist, '原声, 嘉宾');
  assert.deepEqual(track.artistNames, ['原声', '嘉宾']);
  assert.equal(track.albumArtist, '音乐会乐团');
  assert.equal(track.releaseYear, 1999);
  assert.deepEqual(track.genres, ['原声']);
  assert.equal(track.duration, 42);
  const anonymous = await fetch(app + track.streamUrl);
  assert.equal(anonymous.status, 404);
  await anonymous.json();
  await assertStream(app, source, track);
  const cover = await fetch(app + track.cover, { headers: { Cookie: source.cookie } });
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await cover.arrayBuffer()), jpeg);

  const headers = { Cookie: source.cookie };
  coverMode = 'untyped';
  const detected = await fetch(app + track.cover, { headers });
  assert.equal(detected.status, 200);
  assert.equal(detected.headers.get('content-type'), 'image/jpeg');
  assert.equal(detected.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await detected.arrayBuffer()), jpeg);
  const head = await fetch(app + track.cover, { headers, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/jpeg');
  assert.equal(head.headers.get('content-length'), String(jpeg.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  for (coverMode of ['invalid', 'wrong-type']) {
    const rejected = await fetch(app + track.cover, { headers });
    assert.equal(rejected.status, 502);
    assert.match(rejected.headers.get('content-type'), /^application\/json/);
    await rejected.json();
  }
});

test('Songloft logs in, refreshes expired credentials and proxies private tracks, cover and lyrics', async t => {
  const sourceId = '9223372036854775815';
  let refreshed = 0;
  const { target, app } = await fixture(t, async (req, res, url) => {
    const json = payload => res.writeHead(200, { 'Content-Type': 'application/json' }).end(payload);
    if (url.pathname === '/api/v1/auth/login' || url.pathname === '/api/v1/auth/refresh') {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, undefined);
      let body = '';
      for await (const chunk of req) body += chunk;
      if (url.pathname.endsWith('/login')) {
        assert.deepEqual(JSON.parse(body), { username, password });
        return json(JSON.stringify({ access_token: 'fixture-invalidated', refresh_token: 'fixture-refresh', expires_in: 600 }));
      }
      assert.deepEqual(JSON.parse(body), { refresh_token: 'fixture-refresh' });
      refreshed++;
      return json(JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-refresh-next', expires_in: 600 }));
    }
    if (req.headers.authorization === 'Bearer fixture-invalidated') return res.writeHead(401).end();
    assert.equal(req.headers.authorization, 'Bearer fixture-access');
    if (url.pathname === '/api/v1/songs') {
      assert.equal(url.searchParams.get('type'), null);
      assert.equal(url.searchParams.get('access_token'), null);
      if (url.searchParams.get('offset') === '0') return json('{"songs":[{"id":1,"type":"radio","title":"电台"}],"total":2}');
      assert.equal(url.searchParams.get('offset'), '1');
      return json('{"songs":[{"id":' + sourceId + ',"type":"local","title":"在海边","artist":"夜班","album":"旅行","duration":42,"format":"mp3","cover_url":"/ignored"}],"total":2}');
    }
    assert.equal(url.searchParams.get('access_token'), 'fixture-access');
    if (url.pathname === '/api/v1/songs/' + sourceId + '/play') {
      assert.equal(url.searchParams.get('normalize'), '0');
      return rangedAudio(req, res);
    }
    if (url.pathname === '/api/v1/songs/' + sourceId + '/cover') {
      return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.from([255, 216, 255, 217]));
    }
    if (url.pathname === '/api/v1/songs/' + sourceId + '/lyric') {
      return json(JSON.stringify({ data: { lyric: '[00:03.00]海边', lxlyric: '[00:03.00]<00:03.25>海<00:03.55>边' } }));
    }
    return res.writeHead(404).end();
  });
  const source = await connect(app, { type: 'songloft', name: 'Songloft 测试', url: target, username, password });
  const [track] = await list(app, source);
  assert.equal(track.title, '在海边');
  assert.equal(refreshed, 1);
  assert.doesNotMatch(JSON.stringify(track), /fixture-(?:access|refresh)|api\/v1/);
  await assertStream(app, source, track);
  const headers = { Cookie: source.cookie };
  const cover = await fetch(app + track.cover, { headers });
  assert.equal(cover.headers.get('content-type'), 'image/jpeg');
  await cover.arrayBuffer();
  const lyric = await fetch(app + track.lyricsUrl, { headers });
  assert.match(lyric.headers.get('content-type'), /^text\/plain/);
  assert.equal(await lyric.text(), '[00:03.00]<00:03.25>海<00:03.55>边');
});

test('submits only registered songs for an authorized same-origin playback completion', async t => {
  const submitted = [];
  let upstreamStatus = 'ok';
  const { target, app } = await fixture(t, (req, res, url) => {
    const response = data => reply(res, { 'subsonic-response': { status: 'ok', ...data } });
    if (url.pathname.endsWith('/getArtists.view')) return response({ artists: { index: [{ artist: [{ id: 'artist', name: 'Artist' }] }] } });
    if (url.pathname.endsWith('/getArtist.view')) return response({ artist: { album: [{ id: 'album', name: 'Album' }] } });
    if (url.pathname.endsWith('/getAlbum.view')) return response({ album: { name: 'Album', song: [{ id: 'provider-track', title: 'Track', suffix: 'mp3' }] } });
    assert.equal(url.pathname, '/rest/scrobble.view');
    assert.equal(req.method, 'GET');
    const params = url.searchParams;
    assert.equal(params.get('t'), createHash('md5').update(password + params.get('s')).digest('hex'));
    assert.equal(params.get('u'), username);
    assert.equal(params.get('submission'), 'true');
    assert.ok(Math.abs(Number(params.get('time')) - Date.now()) < 5000);
    submitted.push(params.get('id'));
    return response({ status: upstreamStatus, ...(upstreamStatus === 'failed' && { error: { code: 50 } }) });
  });
  const source = await connect(app, { type: 'navidrome', name: 'Navidrome', url: target, username, password });
  const [artist] = await list(app, source);
  const [album] = await list(app, source, artist.path);
  const [track] = await list(app, source, album.path);
  const endpoint = app + track.streamUrl.replace('/stream?', '/played?');
  const headers = { Cookie: source.cookie, Origin: app };
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: app } })).status, 404);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Cookie: source.cookie } })).status, 403);
  assert.equal((await fetch(endpoint, { headers })).status, 405);
  assert.equal((await fetch(endpoint + '-lyrics', { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(endpoint.replace(/id=.*/, 'id=provider-track'), { method: 'POST', headers })).status, 404);
  assert.deepEqual(submitted, []);
  const accepted = await fetch(endpoint, { method: 'POST', headers });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { reported: true });
  assert.deepEqual(submitted, ['provider-track']);
  upstreamStatus = 'failed';
  assert.equal((await fetch(endpoint, { method: 'POST', headers })).status, 401);
});

test('only forwards ordered playback events for known Emby tracks in the owning browser session', async t => {
  const forwarded = [];
  const { target, app } = await fixture(t, async (req, res, url) => {
    if (url.pathname.startsWith('/emby/Sessions/')) {
      assert.equal(req.method, 'POST');
      assert.match(req.headers.authorization, /^MediaBrowser Client="Groovebox"/);
      assert.equal(req.headers['x-emby-token'], token);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      forwarded.push([url.pathname, JSON.parse(Buffer.concat(chunks))]);
      return res.writeHead(204).end();
    }
    assert.equal(url.pathname, '/emby/Users/user-emby/Items');
    return reply(res, { Items: ['first', 'second'].map(Id => ({
      Id, Type: 'Audio', Name: Id, RunTimeTicks: 120000000,
      MediaSources: [{ Id: Id + '-source', Container: 'flac' }],
    })), TotalRecordCount: 2 });
  });
  const source = await connect(app, { type: 'emby', name: 'Emby', url: target, token, userId: 'user-emby' });
  const [first, second] = (await list(app, source)).map(track => app + track.streamUrl.replace('/stream?', '/playback?'));
  const playSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const config = { Cookie: source.cookie, Origin: app, 'Content-Type': 'application/json' };
  const post = (url, event, patch = {}, headers = config) => fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ event, playSessionId, positionSeconds: 0, paused: false, ...patch }),
  });

  assert.equal((await post(first, 'start', {}, { ...config, Origin: 'https://unexpected.example' })).status, 403);
  assert.equal((await post(first, 'start', {}, { ...config, Cookie: '' })).status, 404);
  assert.equal((await post(first.replace(/id=.*/, 'id=first'), 'start')).status, 404);
  assert.equal((await post(first, 'progress')).status, 409);
  assert.equal((await post(first, 'start', { positionSeconds: -1 })).status, 400);
  assert.deepEqual(forwarded, []);

  assert.deepEqual(await (await post(first, 'start')).json(), { reported: true });
  assert.equal((await post(second, 'progress')).status, 409);
  assert.equal((await post(first, 'progress', { reason: 'Pause', paused: true, positionSeconds: 3.25 })).status, 200);
  assert.equal((await post(first, 'stop', { positionSeconds: 13 })).status, 200);
  assert.equal((await post(first, 'progress')).status, 409);

  const session = { ItemId: 'first', MediaSourceId: 'first-source', PlaySessionId: playSessionId,
    PlayMethod: 'DirectPlay', CanSeek: true, QueueableMediaTypes: ['Audio'] };
  assert.deepEqual(forwarded, [
    ['/emby/Sessions/Playing', { ...session, PositionTicks: 0, IsPaused: false }],
    ['/emby/Sessions/Playing/Progress', { ...session, PositionTicks: 32500000, IsPaused: true, EventName: 'Pause' }],
    ['/emby/Sessions/Playing/Stopped', { ...session, PositionTicks: 120000000, IsPaused: false }],
  ]);
});
