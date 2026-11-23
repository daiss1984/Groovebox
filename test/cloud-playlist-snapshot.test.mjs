import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPlaylistSnapshot, maxPlaylistSnapshotBytes, readPlaylistSnapshot,
} from '../public/cloud-playlist-snapshot.js';

const scope = { provider: 'baidu', account: 'a'.repeat(43) };
const operation = 'd369ff4c-ac04-42d6-8105-a1ab94b3e73a';
const first = '9e36b27e-45b4-4375-9911-c6f0587ad372';
const second = '19c0554c-af89-459a-afee-e909286ca2ca';
const encoder = new TextEncoder();
const data = () => ({
  tracks: [
    {
      id: 'baidu:9223372036854775807', provider: 'baidu', path: '/Music/sample.flac',
      title: '春风', artist: 'A/B', album: 'Live 2024',
      src: '/api/baidu/stream?id=9223372036854775807&access_token=bad',
      cover: 'https://provider.invalid/cover?signature=bad', lyrics: 'unrelated lyrics',
      embeddedTags: { authorization: 'Bearer secret-token', token: 'bad' },
    },
    { id: '/Users/alice/private/local.wav', provider: 'local', title: 'Local' },
    { id: 'baidu:123', provider: 'baidu', title: 'https://provider.invalid/private?signature=bad' },
    { id: 'never-listed', title: 'Unrequested' },
  ],
  playlists: [
    { id: first, name: '晚上', tracks: ['baidu:9223372036854775807', '/Users/alice/private/local.wav', 'baidu:9223372036854775807', 'baidu:123'] },
    { id: second, name: '空', tracks: [] },
  ],
  favorites: ['baidu:9223372036854775807', 'baidu:9223372036854775807', 'other-unavailable'],
});
const verifiedFiles = new Map([['baidu:9223372036854775807', '9223372036854775807']]);
const snapshot = () => readPlaylistSnapshot(createPlaylistSnapshot(data(), { scope, operation, verifiedFiles }), scope);
const encode = value => encoder.encode(JSON.stringify(value));

test('round trips playlist order, repeated occurrences, favorites, and unresolved entries', () => {
  const value = snapshot();
  assert.deepEqual(value.playlists, [
    { id: first, name: '晚上', tracks: [0, 1, 0, 2] },
    { id: second, name: '空', tracks: [] },
  ]);
  assert.deepEqual(value.favorites, [0, 3]);
  assert.deepEqual(value.tracks, [
    { file: '9223372036854775807', title: '春风', artist: 'A/B', album: 'Live 2024' },
    { title: 'Local' }, {}, {},
  ]);
  assert.equal(value.operation, operation);
  assert.deepEqual(value.scope, scope);
});

test('produces stable retry bytes without changing library state and strips raw inputs', () => {
  const input = data();
  const original = structuredClone(input);
  const bytes = createPlaylistSnapshot(input, { scope, operation, verifiedFiles });
  assert.deepEqual(bytes, createPlaylistSnapshot(input, { scope, operation, verifiedFiles }));
  assert.deepEqual(input, original);
  const text = new TextDecoder().decode(bytes);
  for (const privateData of ['/api/', 'access_token', 'https://', 'signature', 'Users', '/Music',
    'secret-token', 'lyrics', 'Unrequested', 'baidu:123', 'other-unavailable']) {
    assert.equal(text.includes(privateData), false);
  }
});

test('does not bind stale track IDs to the destination and rejects an unexpected restore account', () => {
  const bytes = createPlaylistSnapshot(data(), { scope, operation, verifiedFiles: new Map() });
  assert.equal(readPlaylistSnapshot(bytes, scope).tracks.some(track => track.file), false);
  assert.throws(() => readPlaylistSnapshot(bytes, { ...scope, account: 'b'.repeat(43) }), /different cloud account/);
  assert.throws(() => readPlaylistSnapshot(bytes, { ...scope, provider: 'gdrive' }), /different cloud account/);
  assert.throws(() => readPlaylistSnapshot(bytes, { ...scope, provider: 'unknown' }), /Invalid expected cloud account/);
});

test('keeps Google Drive file IDs opaque and scoped to their backup account', () => {
  const google = { ...scope, provider: 'gdrive' };
  const file = '1_qZ1K7D-Ee';
  const files = new Map([['baidu:9223372036854775807', file]]);
  const bytes = createPlaylistSnapshot(data(), { scope: google, operation, verifiedFiles: files });
  assert.equal(readPlaylistSnapshot(bytes, google).tracks[0].file, file);
  assert.throws(() => readPlaylistSnapshot(bytes, scope), /different cloud account/);
  assert.throws(() => readPlaylistSnapshot(bytes, { ...google, account: 'Z'.repeat(43) }), /different cloud account/);
  for (const invalid of ['bad/id', 'a.b', 'a?alt=media', 'a%2f', 'q'.repeat(257)]) {
    files.set('baidu:9223372036854775807', invalid);
    assert.throws(() => createPlaylistSnapshot(data(), { scope: google, operation, verifiedFiles: files }), /Invalid verified file ID/);
  }
});

test('accepts an exact Dropbox ID only in its Dropbox account scope', () => {
  const dropbox = { ...scope, provider: 'dropbox' };
  const files = new Map([['baidu:9223372036854775807', 'id:song-LmN_920']]);
  const bytes = createPlaylistSnapshot(data(), { scope: dropbox, operation, verifiedFiles: files });
  assert.equal(readPlaylistSnapshot(bytes, dropbox).tracks[0].file, 'id:song-LmN_920');
  assert.throws(() => readPlaylistSnapshot(bytes, { ...dropbox, provider: 'gdrive' }), /different cloud account/);
  for (const rejected of ['song-LmN_920', 'id:', 'id:%2fsong', 'id:a/b', 'id:' + 'Z'.repeat(257)]) {
    files.set('baidu:9223372036854775807', rejected);
    assert.throws(() => createPlaylistSnapshot(data(), { scope: dropbox, operation, verifiedFiles: files }), /Invalid verified file ID/);
  }
});

test('round trips opaque OneDrive file IDs only within the original account scope', () => {
  const onedrive = { ...scope, provider: 'onedrive' };
  const file = '3A5A9A!150-sample_1.0';
  const files = new Map([['baidu:9223372036854775807', file]]);
  const bytes = createPlaylistSnapshot(data(), { scope: onedrive, operation, verifiedFiles: files });
  const value = readPlaylistSnapshot(bytes, onedrive);
  assert.equal(value.tracks[0].file, file);
  assert.deepEqual(value.playlists[0].tracks, [0, 1, 0, 2]);
  assert.throws(() => readPlaylistSnapshot(bytes, { ...onedrive, account: 'b'.repeat(43) }), /different cloud account/);
  assert.throws(() => readPlaylistSnapshot(bytes, { ...onedrive, provider: 'gdrive' }), /different cloud account/);
  for (const rejected of ['!150', 'abc%21150', 'abc/150', 'abc?sig=token', 'abc#150', 'id:150', 'a'.repeat(257)]) {
    files.set('baidu:9223372036854775807', rejected);
    assert.throws(() => createPlaylistSnapshot(data(), { scope: onedrive, operation, verifiedFiles: files }), /Invalid verified file ID/);
  }
});

test('rejects unexpected fields, invalid refs, provider tokens and signed URLs at decode', () => {
  const attempts = [
    [value => { value.accessToken = 'secret'; }, /Invalid playlist snapshot/],
    [value => { value.tracks[0].src = '/api/baidu/stream?id=2&token=secret'; }, /Unknown snapshot track field/],
    [value => { value.tracks[0].file = 'https://example.invalid?sig=abc'; }, /Invalid or duplicate cloud file reference/],
    [value => { value.tracks[0].file = '9223372036854775808'; }, /Invalid or duplicate cloud file reference/],
    [value => { value.tracks[1].title = 'https://example.invalid?X-Amz-Signature=abc'; }, /Invalid snapshot track label/],
    [value => { value.tracks[1].title = 'https%3A%2F%2Fexample.invalid%2Fprivate'; }, /Invalid snapshot track label/],
    [value => { value.tracks[1].artist = 'Authorization: Bearer ABCDEFGHIJKLMNOP'; }, /Invalid snapshot track label/],
    [value => { value.tracks[1].album = 'access_token%3Dfoobar'; }, /Invalid snapshot track label/],
    [value => { value.playlists[0].name = 'Signature=testing'; }, /Invalid snapshot playlist/],
    [value => { value.playlists[1].id = first; }, /Invalid or duplicate playlist ID/],
    [value => { value.playlists[0].tracks[0] = -1; }, /Invalid snapshot track reference/],
    [value => { value.playlists[0].tracks[0] = 1.5; }, /Invalid snapshot track reference/],
    [value => { value.playlists[0].tracks.push(4); }, /Invalid snapshot track reference/],
    [value => { value.favorites.push(0); }, /Duplicate snapshot favorite/],
    [value => { value.tracks.push({}); }, /Unreferenced track in snapshot/],
    [value => { value.version = 4; }, /Invalid playlist snapshot/],
  ];
  for (const [edit, expected] of attempts) {
    const value = snapshot();
    edit(value);
    assert.throws(() => readPlaylistSnapshot(encode(value), scope), expected);
  }
  const compromised = new TextDecoder().decode(encode(snapshot())).replace('{"file"', '{"__proto__":{"secret":true},"file"');
  assert.throws(() => readPlaylistSnapshot(encoder.encode(compromised), scope), /Unknown snapshot track field/);
});

test('preserves known creation times in version 2 while retaining undated version 1 bytes', () => {
  const input = data();
  input.playlistCreationDates = [[first, 1234567890000], [second, -1]];
  const bytes = createPlaylistSnapshot(input, { scope, operation, verifiedFiles });
  const value = readPlaylistSnapshot(bytes, scope);
  assert.equal(value.version, 2);
  assert.equal(value.playlists[0].createdAt, 1234567890000);
  assert.equal(Object.hasOwn(value.playlists[1], 'createdAt'), false);
  input.playlistCreationDates = [[first, 1234567890000], [first, 42], ['', 100], ['missing', 200]];
  assert.equal(readPlaylistSnapshot(createPlaylistSnapshot(input, { scope, operation, verifiedFiles }), scope)
    .playlists[0].createdAt, 1234567890000);
  const emptyId = { ...input, playlists: [{ id: '', name: 'Legacy', tracks: [] }], favorites: [] };
  assert.equal(readPlaylistSnapshot(createPlaylistSnapshot(emptyId, { scope, operation, verifiedFiles }), scope).version, 1);
  for (const invalid of [-1, 1.2, '1234567890000', 8.64e15 + 1]) {
    const changed = structuredClone(value);
    changed.playlists[0].createdAt = invalid;
    assert.throws(() => readPlaylistSnapshot(encode(changed), scope), /Invalid playlist creation date/);
  }
  const older = structuredClone(value);
  older.version = 1;
  assert.throws(() => readPlaylistSnapshot(encode(older), scope), /Invalid snapshot playlist/);
  delete input.playlistCreationDates;
  assert.equal(readPlaylistSnapshot(createPlaylistSnapshot(input, { scope, operation, verifiedFiles }), scope).version, 1);
});

test('requires a valid Baidu file reference and version 4 operation UUID', () => {
  for (const file of ['0', '0007', '9223372036854775808', '/api/baidu/stream?id=27', 27]) {
    const verified = new Map([['baidu:9223372036854775807', file]]);
    assert.throws(() => createPlaylistSnapshot(data(), { scope, operation, verifiedFiles: verified }), /Invalid verified file ID/);
  }
  assert.throws(() => createPlaylistSnapshot(data(), {
    scope, operation: 'd369ff4c-ac04-12d6-8105-a1ab94b3e73a', verifiedFiles,
  }), /Invalid playlist snapshot/);
});

test('version 3 preserves independently known modification dates and old immutable retry bytes', () => {
  const input = data();
  const undated = createPlaylistSnapshot(input, { scope, operation, verifiedFiles });
  input.playlistCreationDates = [[first, 1_700_000_000_000]];
  const creationOnly = createPlaylistSnapshot(input, { scope, operation, verifiedFiles });
  input.playlistModificationDates = [[first, 1_700_000_001_000], [first, 42], [second, 0], ['unknown', 10]];
  const dated = createPlaylistSnapshot(input, { scope, operation, verifiedFiles });
  const value = readPlaylistSnapshot(dated, scope);
  assert.equal(value.version, 3);
  assert.equal(value.playlists[0].createdAt, 1_700_000_000_000);
  assert.equal(value.playlists[0].modifiedAt, 1_700_000_001_000);
  assert.equal(value.playlists[1].modifiedAt, 0);
  assert.equal(Object.hasOwn(value.playlists[1], 'createdAt'), false);
  assert.deepEqual(createPlaylistSnapshot(input, { scope, operation, verifiedFiles }), dated);
  assert.deepEqual(readPlaylistSnapshot(undated, scope).version, 1);
  assert.deepEqual(readPlaylistSnapshot(creationOnly, scope).version, 2);
  for (const invalid of [-1, 0.5, '1700000001000', null, 8_640_000_000_000_001]) {
    const changed = structuredClone(value);
    changed.playlists[0].modifiedAt = invalid;
    assert.throws(() => readPlaylistSnapshot(encode(changed), scope), /Invalid playlist modification date/);
  }
  for (const version of [1, 2]) {
    const changed = structuredClone(value);
    changed.version = version;
    assert.throws(() => readPlaylistSnapshot(encode(changed), scope), /Invalid snapshot playlist/);
  }
  input.playlistModificationDates = [['missing', 100], [first, -1], ['', 0]];
  assert.deepEqual(createPlaylistSnapshot(input, { scope, operation, verifiedFiles }), creationOnly);
  delete input.playlistCreationDates;
  assert.deepEqual(createPlaylistSnapshot(input, { scope, operation, verifiedFiles }), undated);
});

test('all cloud account adapters share v3 date validation without widening file identities', () => {
  for (const provider of ['baidu', 'gdrive', 'dropbox', 'onedrive']) {
    const destination = { ...scope, provider };
    const input = { tracks: [{ id: 'local-slot', title: 'Portable Track' }], playlists: [{ id: first, name: 'Portable', tracks: ['local-slot', 'local-slot'] }],
      favorites: [], playlistModificationDates: [[first, 8_640_000_000_000_000]] };
    const files = new Map([['local-slot', provider === 'dropbox' ? 'id:fixture' : provider === 'onedrive' ? 'A!152' : '152']]);
    const bytes = createPlaylistSnapshot(input, { scope: destination, operation, verifiedFiles: files });
    const value = readPlaylistSnapshot(bytes, destination);
    assert.equal(value.version, 3);
    assert.deepEqual(value.playlists[0].tracks, [0, 0]);
    assert.equal(value.playlists[0].modifiedAt, 8_640_000_000_000_000);
    assert.equal(Object.hasOwn(value.playlists[0], 'createdAt'), false);
    assert.throws(() => readPlaylistSnapshot(bytes, { ...destination, account: 'b'.repeat(43) }), /different cloud account/);
  }
});

test('bounds read and write size, and rejects truncated JSON and malformed UTF-8', () => {
  assert.throws(() => readPlaylistSnapshot(new Uint8Array(maxPlaylistSnapshotBytes + 1), scope), /size limit/);
  assert.throws(() => readPlaylistSnapshot(new Uint8Array([123, 128]), scope), /Invalid UTF-8/);
  assert.throws(() => readPlaylistSnapshot(encoder.encode('{"format":'), scope), /Invalid UTF-8/);
  const input = data();
  input.playlists[0].tracks = Array(500_000).fill('baidu:9223372036854775807');
  assert.throws(() => createPlaylistSnapshot(input, { operation, scope, verifiedFiles }), /size limit/);
});

test('rejects duplicate JSON keys even when their final values appear valid', () => {
  const text = JSON.stringify(snapshot());
  const shadowed = text.replace('"title":"春风"', '"title":"https://example.invalid?sig=credential","title":"春风"');
  assert.throws(() => readPlaylistSnapshot(encoder.encode(shadowed), scope), /Noncanonical playlist snapshot JSON/);
});

test('preserves alias occurrences that resolve to the same verified file and accepts legacy playlist IDs', () => {
  const input = data();
  input.playlists[1].id = 'legacy-id';
  input.playlists[0].tracks.push('second-local-alias');
  const verified = new Map(verifiedFiles);
  verified.set('second-local-alias', '9223372036854775807');
  const value = readPlaylistSnapshot(createPlaylistSnapshot(input, { scope, operation, verifiedFiles: verified }), scope);
  assert.deepEqual(value.playlists[0].tracks, [0, 1, 0, 2, 0]);
  assert.deepEqual(value.playlists[1], { name: '空', tracks: [] });
});
