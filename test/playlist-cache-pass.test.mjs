import test from 'node:test';
import assert from 'node:assert/strict';
import { playlistCachePassMarkerPrefix, readPlaylistCachePass, recordPlaylistCacheAttempt, resetPlaylistCacheAttempts } from '../public/playlist-cache-pass.js';

const prefix = playlistCachePassMarkerPrefix;
const oldKey = 'groovebox.playlist-cache-pass.v1';

class MemoryStorage {
  entries = new Map();
  beforeWrite;
  get length() { return this.entries.size; }
  key(index) { return [...this.entries.keys()][index] ?? null; }
  getItem(key) { return this.entries.get(key) ?? null; }
  setItem(key, value) {
    this.beforeWrite?.(key, value);
    this.entries.set(key, value);
  }
  removeItem(key) { this.entries.delete(key); }
}

test('same-generation interleaved writes preserve independent attempts', () => {
  const shared = new MemoryStorage();
  shared.beforeWrite = key => {
    if (key !== prefix + '3:album:alpha') return;
    shared.beforeWrite = undefined;
    recordPlaylistCacheAttempt(3, 'beta', shared);
  };
  recordPlaylistCacheAttempt(3, 'album:alpha', shared);
  assert.deepEqual(readPlaylistCachePass(3, shared), new Set(['album:alpha', 'beta']));
});

test('prunes only well-formed earlier generations without allowing late completion to touch newer attempts', () => {
  const shared = new MemoryStorage();
  shared.setItem(prefix + '001:unrelated', '1');
  shared.setItem(prefix + '1:', '1');
  recordPlaylistCacheAttempt(1, 'same', shared);
  recordPlaylistCacheAttempt(2, 'same', shared);
  recordPlaylistCacheAttempt(3, 'future', shared);
  assert.deepEqual(readPlaylistCachePass(2, shared), new Set(['same']));
  assert.equal(shared.getItem(prefix + '1:same'), null);
  recordPlaylistCacheAttempt(1, 'late', shared);
  resetPlaylistCacheAttempts(1, ['same'], shared);
  assert.deepEqual(readPlaylistCachePass(2, shared), new Set(['same']));
  assert.equal(shared.getItem(prefix + '1:late'), null);
  assert.equal(shared.getItem(prefix + '3:future'), '1');
  assert.equal(shared.getItem(prefix + '001:unrelated'), '1');
  assert.equal(shared.getItem(prefix + '1:'), '1');
});

test('an old migration cannot undo a concurrent reset and preserves unrelated attempts', () => {
  const shared = new MemoryStorage();
  shared.setItem(oldKey, JSON.stringify({ generation: 3, attempted: ['old', 'keep', 12, ''] }));
  shared.beforeWrite = key => {
    if (key !== prefix + 'legacy:3:old') return;
    shared.beforeWrite = undefined;
    resetPlaylistCacheAttempts(3, new Set(['old']), shared);
  };
  readPlaylistCachePass(3, shared);
  shared.setItem(oldKey, JSON.stringify({ generation: 4, attempted: ['old'] }));
  recordPlaylistCacheAttempt(4, 'keep', shared);
  resetPlaylistCacheAttempts(3, ['missing'], shared);
  assert.deepEqual(readPlaylistCachePass(3, shared), new Set(['keep']));
  assert.equal(shared.getItem(prefix + '4:keep'), '1');
  assert.deepEqual(JSON.parse(shared.getItem(oldKey)), { generation: 4, attempted: ['old'] });
  recordPlaylistCacheAttempt(3, 'old', shared);
  assert.deepEqual(readPlaylistCachePass(3, shared), new Set(['old', 'keep']));
});

test('blocked or full storage never throws or hides readable legacy attempts', () => {
  const denied = {
    get length() { throw new Error('Unavailable'); },
    setItem() { throw new Error('Unavailable'); },
  };
  assert.deepEqual(readPlaylistCachePass(1, denied), new Set());
  assert.doesNotThrow(() => recordPlaylistCacheAttempt(1, 'id', denied));
  assert.doesNotThrow(() => resetPlaylistCacheAttempts(1, ['id'], denied));
  const full = new MemoryStorage();
  full.setItem(oldKey, JSON.stringify({ generation: 1, attempted: ['a', 'b'] }));
  full.beforeWrite = () => { throw new Error('Quota exceeded'); };
  assert.deepEqual(readPlaylistCachePass(1, full), new Set(['a', 'b']));
  assert.deepEqual(readPlaylistCachePass(Number.MAX_SAFE_INTEGER + 1, full), new Set());
});
