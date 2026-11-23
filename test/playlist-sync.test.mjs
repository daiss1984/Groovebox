import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mergePlaylists, playlistSnapshot, reconcilePlaylists, validCloudTrack } from '../public/playlist-sync.js';
import { normalizeGenres } from '../public/library.js';

test('preserves OneDrive tracks whose native item ID contains an exclamation mark', () => {
  const track = { id: 'onedrive:ABCD!2', title: 'OneDrive fixture', src: '/api/onedrive/stream?id=ABCD!2' };
  assert.equal(validCloudTrack(track), true);
  assert.equal(validCloudTrack({ ...track, src: '/api/onedrive/stream?id=ABCD%212' }), true);
  assert.equal(validCloudTrack({ ...track, src: '//different.invalid' + track.src }), false);
  assert.deepEqual(playlistSnapshot({ favorites: [track.id], tracks: [track] }).tracks, [track]);
});

test('adopts metadata changed on either device while keeping additions and removals', () => {
  const old = { id: 'demo', title: 'Old title', src: '/api/baidu/stream?id=1' };
  const newer = { ...old, title: 'New title' };
  const local = { id: 'other', title: 'Other track', src: '/api/box/stream?id=2' };
  const base = playlistSnapshot({
    playlists: [{ id: 'm', name: 'Before', tracks: [old.id, 'another-track'] }],
    tracks: [old],
  });
  const left = playlistSnapshot({
    playlists: [{ id: 'm', name: 'Renamed', tracks: [old.id, 'another-track', local.id] }],
    tracks: [old, local],
  });
  const right = playlistSnapshot({
    playlists: [{ id: 'm', name: 'Before', tracks: [old.id] }],
    tracks: [newer],
  });
  const merged = mergePlaylists(base, left, right);
  assert.deepEqual(merged.playlists, [{ id: 'm', name: 'Renamed', tracks: ['demo', 'other'] }]);
  assert.deepEqual(merged.tracks, [newer, local]);
  assert.deepEqual(mergePlaylists(merged, merged, merged), merged);
  assert.equal(mergePlaylists(base, right, base).tracks[0].title, 'New title');
});

test('normalizes genre labels without changing the first display name or genre punctuation', () => {
  assert.deepEqual(normalizeGenres('  Hip  Hop \t'), ['Hip Hop']);
  assert.deepEqual(normalizeGenres([' Jazz ', 'jazz', 'R&B/Soul', 'Cafe\u0301', 'CAFÉ', '古典 ', '', null, { name: 'invalid' }]),
    ['Jazz', 'R&B/Soul', 'Café', '古典']);
});

test('keeps normalized genre labels in cloud playlists and embedded tags', () => {
  const cloud = { id: 't', title: 'Test track', src: '/api/baidu/stream?id=1' };
  const base = playlistSnapshot({ playlists: [{ id: 'a', name: 'List', tracks: [cloud.id] }], tracks: [cloud] });
  const remote = playlistSnapshot({
    ...base, tracks: [{ ...cloud, genres: ['  Hip Hop ', 'HIP HOP', '爵士'], embeddedTags: { album: 'Listen', genres: [' hip hop '] } }],
  });
  assert.deepEqual(mergePlaylists(base, base, remote).tracks[0], {
    ...cloud, genres: ['Hip Hop', '爵士'], embeddedTags: { album: 'Listen', genres: ['hip hop'] },
  });
});

test('preserves an explicit playlist reorder through a three-way sync with non-order edits', () => {
  const snapshot = tracks => playlistSnapshot({ playlists: [{ id: 'list', name: 'Order', tracks }] });
  const base = snapshot(['a', 'b', 'c', 'd']);
  const local = snapshot(['a', 'e', 'd', 'c', 'b']);
  const remote = snapshot(['a', 'c', 'd', 'f']);
  const merged = mergePlaylists(base, local, remote);
  assert.deepEqual(merged.playlists[0].tracks, ['a', 'e', 'd', 'f', 'c']);
  assert.deepEqual(mergePlaylists(base, remote, local).playlists[0].tracks, ['a', 'e', 'd', 'c', 'f']);
  assert.deepEqual(mergePlaylists(merged, merged, merged), merged);
});

test('uses the remote sequence for concurrent reorders and preserves tracks new on either side', () => {
  const snapshot = tracks => playlistSnapshot({ playlists: [{ id: 'list', name: 'Order', tracks }] });
  const base = snapshot(['a', 'b', 'c']);
  const local = snapshot(['c', 'a', 'b', 'local']);
  const remote = snapshot(['b', 'c', 'a', 'remote']);
  assert.deepEqual(mergePlaylists(base, local, remote).playlists[0].tracks, ['b', 'c', 'a', 'remote', 'local']);
});

test('keeps repeated tracks and merges independent additions of repeated IDs without resetting modification dates', () => {
  const snapshot = (tracks, modified) => playlistSnapshot({ playlists: [{ id: 'list', name: 'Order', tracks }],
    playlistModificationDates: [['list', modified], ['unknown-list', 1234]] });
  const base = snapshot(['a', 'b'], 5);
  const local = snapshot(['a', 'a', 'b'], 20);
  const remote = snapshot(['a', 'b', 'b'], 30);
  const merged = mergePlaylists(base, local, remote);
  assert.deepEqual(merged.playlists[0].tracks, ['a', 'a', 'b', 'b']);
  assert.deepEqual(merged.playlistModificationDates, [['list', 30]]);
  assert.deepEqual(mergePlaylists(merged, merged, merged), merged);
  assert.deepEqual(mergePlaylists(merged, merged, snapshot(['a', 'b', 'a'], 31)).playlists[0].tracks, ['a', 'b', 'a']);
  assert.deepEqual(mergePlaylists(merged, snapshot(['a', 'b', 'a'], 31), merged).playlists[0].tracks, ['a', 'b', 'a']);
  assert.equal(Object.hasOwn(mergePlaylists(merged, playlistSnapshot({}), merged), 'playlistModificationDates'), false);
  assert.deepEqual(mergePlaylists(base, local, snapshot(['a', 'b'])).playlistModificationDates, [['list', 20]]);
});

test('carries the custom order of playlists across synchronization without losing remote additions', () => {
  const snapshot = names => playlistSnapshot({ playlists: names.map(id => ({ id, name: id, tracks: [] })) });
  const initial = snapshot(['first', 'second', 'third']);
  const local = snapshot(['third', 'first', 'second']);
  const remote = snapshot(['first', 'second', 'third', 'new']);
  assert.deepEqual(mergePlaylists(initial, local, remote).playlists.map(list => list.id), ['third', 'first', 'second', 'new']);
  assert.deepEqual(mergePlaylists(initial, remote, local).playlists.map(list => list.id), ['third', 'first', 'second', 'new']);
});

test('keeps v1 date metadata optional and retains only valid dates for included playlists', () => {
  const playlists = ['legacy', 'epoch', 'later', 'invalid'].map(id => ({ id, name: id, tracks: [] }));
  const legacy = { version: 1, playlists, favorites: [], tracks: [] };
  assert.deepEqual(playlistSnapshot(legacy), legacy);
  assert.deepEqual(playlistSnapshot({ ...legacy, playlistCreationDates: [
    ['later', 1_700_000_000_000], ['missing', 42], ['epoch', 0], ['epoch', 42],
    ['invalid', -1], ['invalid', '42'], ['invalid', 8_640_000_000_000_001],
  ] }), { ...legacy, playlistCreationDates: [['epoch', 0], ['later', 1_700_000_000_000]] });
});

test('shares creation dates, keeps synchronized dates stable and does not resurrect deleted playlists', () => {
  const snapshot = (names, playlistCreationDates) => playlistSnapshot({
    playlists: names.map(id => ({ id, name: id, tracks: [] })), playlistCreationDates,
  });
  const base = snapshot(['known', 'legacy', 'deleted'], [['known', 100], ['deleted', 1]]);
  const local = snapshot(['known', 'legacy', 'added', 'conflict'], [['legacy', 200], ['added', 300], ['conflict', 400]]);
  const remote = snapshot(['known', 'legacy', 'deleted', 'conflict'], [['known', 10], ['deleted', 1], ['conflict', 350]]);
  const expected = { known: 100, legacy: 200, added: 300, conflict: 350 };
  for (const left of [local, remote]) {
    const merged = mergePlaylists(base, left, left === local ? remote : local);
    assert.deepEqual(Object.fromEntries(merged.playlistCreationDates), expected);
    assert.equal(merged.playlists.some(list => list.id === 'deleted'), false);
    assert.deepEqual(mergePlaylists(merged, merged, merged), merged);
  }
});

test('retries a concurrent WebDAV write without dropping a reorder or an unavailable track reference', async t => {
  const snapshot = tracks => playlistSnapshot({ playlists: [{ id: 'list', name: 'Order', tracks }] });
  const base = snapshot(['a', 'unavailable', 'b', 'c']);
  const local = snapshot(['c', 'unavailable', 'a', 'b']);
  let remote = base;
  let attempts = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      return res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"' + (attempts + 1) + '"' })
        .end(JSON.stringify(remote));
    }
    assert.equal(req.method, 'PUT');
    assert.equal(req.headers['if-match'], '"' + (attempts + 1) + '"');
    let body = '';
    for await (const chunk of req) body += chunk;
    if (attempts++ === 0) {
      assert.deepEqual(JSON.parse(body), local);
      remote = snapshot(['a', 'unavailable', 'c', 'new-on-remote']);
      return res.writeHead(412).end();
    }
    remote = JSON.parse(body);
    res.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await reconcilePlaylists('http://127.0.0.1:' + server.address().port, base, local);
  assert.equal(attempts, 2);
  assert.deepEqual(result, snapshot(['c', 'unavailable', 'a', 'new-on-remote']));
  assert.deepEqual(remote, result);
});

test('awaits the asynchronous state fence before sending a remote playlist write', async t => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.method === 'PUT') writes++;
    response.writeHead(200, { 'Content-Type': 'application/json', ETag: '"original"' }).end(JSON.stringify({ version: 1, playlists: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const snapshot = playlistSnapshot({ playlists: [{ id: 'fixture', name: 'Fence fixture', tracks: [] }] });
  const syncing = reconcilePlaylists('http://127.0.0.1:' + server.address().port, playlistSnapshot({}), snapshot, {
    beforeWrite: async () => { entered.resolve(); await gate.promise; throw new Error('The state scope changed'); },
  });
  const outcome = assert.rejects(syncing, /state scope changed/);
  await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(writes, 0);
  gate.resolve();
  await outcome;
  assert.equal(writes, 0);
});
