import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexedCloudFolders, indexedCloudRoots, scanCloudFolders } from '../public/cloud-scan.js';

const sourceId = 'music';
const folder = path => ({ folder: true, path });
const song = (id, title = id) => ({ id: sourceId + ':' + id, title });

test('refresh roots retain explicit partial scopes and include disconnected legacy index cycles', () => {
  const parent = { name: 'Parent', path: 'opaque-parent' };
  const selected = { name: 'Selected child', path: 'opaque-scope' };
  const roots = indexedCloudRoots([
    ['/', ['indexed-child'], []], ['indexed-child', [], [], 'Child of root'],
    [selected.path, ['below-scope'], [], selected.name, [{ name: 'Root', path: '/' }, parent]],
    ['below-scope', [], [], 'Child of selected scope'],
    ['cycle-one', ['cycle-two'], []], ['cycle-two', ['cycle-one'], []],
  ]);
  assert.deepEqual(roots, [
    { path: '/', trail: [] }, { path: selected.path, trail: [parent, selected] }, { path: 'cycle-one', trail: [] },
  ]);
});

function fixture(records, snapshots, extra = {}) {
  const calls = [];
  const progress = [];
  const run = (paths, mode = 'incremental') => scanCloudFolders({
    sourceId, paths, snapshots, mode, maxDepth: extra.maxDepth,
    async listFolder(path, { signal }) {
      assert.equal(signal, extra.signal);
      calls.push(path);
      assert.ok(Object.hasOwn(records, path), 'unexpected read: ' + path);
      if (records[path] instanceof Error) throw records[path];
      return records[path];
    },
    tracksFromItems: items => items.filter(item => !item.folder),
    onProgress: entry => {
      progress.push(entry);
      extra.onProgress?.(entry);
    },
    signal: extra.signal,
  });
  return { calls, progress, run };
}

test('only explicit paths start reads and overlapping opaque roots are listed once', async () => {
  const tracks = [song('one'), song('two')];
  const f = fixture({
    '/': [tracks[0], folder('opaque-child'), folder('opaque-child')],
    'opaque-child': [tracks[0], tracks[1], folder('/'), folder('opaque-child')],
  });
  assert.deepEqual(f.calls, []);
  const empty = await f.run([]);
  assert.deepEqual(empty, { snapshots: {}, tracks: [], removedIds: [], scanned: 0, skipped: 0 });
  assert.deepEqual(f.calls, []);

  const result = await f.run(['/', 'opaque-child', '/']);
  assert.deepEqual(f.calls, ['/', 'opaque-child']);
  assert.deepEqual(result, {
    snapshots: { music: [['/', ['opaque-child'], ['music:one']], ['opaque-child', [], ['music:one', 'music:two']]] },
    tracks, removedIds: [], scanned: 2, skipped: 0,
  });
  assert.deepEqual(f.progress, [
    { path: '/', scanned: 1, skipped: 0, found: 1, pending: 1 },
    { path: 'opaque-child', scanned: 2, skipped: 0, found: 2, pending: 0 },
  ]);
});

test('bounded scans read through four child levels relative to the scan root', async () => {
  const f = fixture({
    root: [folder('one')],
    one: [folder('two')],
    two: [folder('three')],
    three: [folder('four')],
    four: [folder('five'), song('within')],
  }, {}, { maxDepth: 4 });
  const result = await f.run(['root'], 'rescan');
  assert.deepEqual(f.calls, ['root', 'one', 'two', 'three', 'four']);
  assert.deepEqual(result.tracks, [song('within')]);
  assert.deepEqual(result.snapshots.music.at(-1), ['four', ['five'], ['music:within']]);
  assert.equal(f.progress.at(-1).pending, 0);
});

test('breadth-first traversal uses the shortest depth across overlapping opaque roots', async () => {
  const f = fixture({
    first: [folder('branch')],
    branch: [folder('second')],
    second: [folder('lower'), song('also')],
    lower: [folder('boundary')],
    boundary: [folder('out-of-scope'), song('at-boundary')],
  }, {}, { maxDepth: 2 });
  const result = await f.run(['first', 'second', 'second'], 'rescan');
  assert.deepEqual(f.calls, ['first', 'second', 'branch', 'lower', 'boundary']);
  assert.deepEqual(result.tracks, [song('also'), song('at-boundary')]);
  assert.equal(result.scanned, 5);
});

test('bounded rescan retains unvisited indexed descendants but removes a branch proven missing at its boundary', async () => {
  const previous = { music: [
    ['root', ['edge'], ['music:upper']],
    ['edge', ['alive', 'vanished'], ['music:absent-at-edge']],
    ['alive', ['deeper'], ['music:keep']],
    ['deeper', [], ['music:also-keep']],
    ['vanished', ['vanished-child'], ['music:remove', 'music:shared']],
    ['vanished-child', [], ['music:also-remove']],
    ['other-scope', [], ['music:shared']],
  ] };
  const before = structuredClone(previous);
  const f = fixture({ root: [folder('edge'), song('upper')], edge: [folder('alive'), song('updated')] },
    previous, { maxDepth: 1 });
  const result = await f.run(['root'], 'rescan');
  assert.deepEqual(f.calls, ['root', 'edge']);
  assert.deepEqual(new Set(result.removedIds), new Set(['music:absent-at-edge', 'music:remove', 'music:also-remove']));
  assert.deepEqual(result.snapshots.music, [
    before.music[0], ['edge', ['alive'], ['music:updated']], ...before.music.slice(2, 4), before.music[6],
  ]);
  assert.deepEqual(previous, before);
});

test('indexes legacy readable paths and remembers the ancestry of a standalone opaque scan', async () => {
  const snapshots = { music: [['/', ['/Old music'], []], ['/Old music', [], []], ['opaque-unlabeled', [], []]] };
  const parent = [{ name: 'Root', path: '/' }, { name: 'Collections', path: 'opaque-collections' }];
  const folder = { name: 'New music', path: 'opaque-music' };
  const child = { name: 'Live sessions', path: 'opaque-sessions', folder: true };
  const result = await scanCloudFolders({ sourceId, snapshots, paths: [folder.path], mode: 'rescan',
    listFolder: async path => path === folder.path ? [child] : [], tracksFromItems: () => [],
    folderTrails: new Map([[folder.path, [...parent, folder]]]),
  });
  const previous = { name: 'Old music', path: '/Old music' };
  assert.deepEqual(indexedCloudFolders(result.snapshots.music), [
    { ...previous, trail: [previous] },
    { ...folder, trail: [parent[1], folder] },
    { name: child.name, path: child.path, trail: [parent[1], folder, { name: child.name, path: child.path }] },
  ]);
});

test('an incremental pass reads only new paths and keeps previous folder membership', async () => {
  const snapshots = { music: [['old', [], ['music:existing']]], unrelated: [['a', [], ['other:keep']]] };
  const unchanged = fixture({}, snapshots);
  const skipped = await unchanged.run(['old', 'old']);
  assert.deepEqual(unchanged.calls, []);
  assert.equal(skipped.snapshots, snapshots);
  assert.equal(skipped.skipped, 1);

  const f = fixture({ new: [song('added'), folder('old')] }, snapshots);
  const result = await f.run(['new', 'old']);
  assert.deepEqual(f.calls, ['new']);
  assert.deepEqual(result.tracks, [song('added')]);
  assert.deepEqual(result.removedIds, []);
  assert.deepEqual(result.snapshots, {
    music: [...snapshots.music, ['new', ['old'], ['music:added']]],
    unrelated: snapshots.unrelated,
  });
  assert.deepEqual(snapshots.music, [['old', [], ['music:existing']]]);
});

test('a full rescan removes absent tracks and descendants only within its proven folder scope', async () => {
  const snapshots = {
    music: [
      ['root', ['branch', 'gone'], ['music:direct', 'music:retained']],
      ['branch', ['alias'], ['music:branch-deleted']],
      ['alias', [], ['music:shared']],
      ['gone', ['gone-child'], ['music:dead', 'music:retained']],
      ['gone-child', [], ['music:dead-child']],
      ['independent', ['alias'], ['music:outside', 'music:retained']],
    ],
    elsewhere: [['/', [], ['elsewhere:outside']]],
  };
  const nextDirect = song('direct', 'new label');
  const f = fixture({ root: [nextDirect, folder('branch')], branch: [song('new')] }, snapshots);
  const result = await f.run(['root', 'branch'], 'rescan');
  assert.deepEqual(f.calls, ['root', 'branch']);
  assert.deepEqual(result.tracks, [nextDirect, song('new')]);
  assert.deepEqual(new Set(result.removedIds), new Set(['music:branch-deleted', 'music:dead', 'music:dead-child']));
  assert.deepEqual(result.snapshots, {
    music: [
      ['root', ['branch'], ['music:direct']],
      ['branch', [], ['music:new']],
      ['alias', [], ['music:shared']],
      ['independent', ['alias'], ['music:outside', 'music:retained']],
    ],
    elsewhere: snapshots.elsewhere,
  });
});

test('relisting a newly discovered but formerly independent descendant updates its old scope', async () => {
  const previous = { music: [
    ['root', [], []],
    ['branch', ['lost'], ['music:old']],
    ['lost', [], ['music:also-old']],
  ] };
  const f = fixture({ root: [folder('branch')], branch: [song('fresh')] }, previous);
  const result = await f.run(['root'], 'rescan');
  assert.deepEqual(new Set(result.removedIds), new Set(['music:old', 'music:also-old']));
  assert.deepEqual(result.snapshots.music, [['root', ['branch'], []], ['branch', [], ['music:fresh']]]);
});

test('a failing child request or malformed incomplete list does not commit partial changes or deletions', async () => {
  const previous = { music: [['root', ['branch'], ['music:old']], ['branch', [], ['music:old-child']]] };
  const before = structuredClone(previous);
  const failure = new Error('folder could not be read');
  failure.status = 404;
  const f = fixture({ root: [song('new'), folder('branch')], branch: failure }, previous);
  await assert.rejects(f.run(['root'], 'rescan'), failure);
  assert.deepEqual(f.calls, ['root', 'branch']);
  assert.deepEqual(previous, before);

  const malformed = fixture({ root: [{ folder: true }] }, previous);
  await assert.rejects(malformed.run(['root'], 'rescan'), TypeError);
  assert.deepEqual(previous, before);
});

test('cancellation is propagated while listing and stops later work without mutating snapshots', async () => {
  const controller = new AbortController();
  const previous = { music: [['seed', [], ['music:retained']]] };
  const before = structuredClone(previous);
  const f = fixture({ root: [song('one'), folder('branch')] }, previous, {
    signal: controller.signal, onProgress: () => controller.abort(),
  });
  await assert.rejects(f.run(['root'], 'rescan'), { name: 'AbortError' });
  assert.deepEqual(f.calls, ['root']);
  assert.deepEqual(previous, before);

  const pending = new AbortController();
  await assert.rejects(scanCloudFolders({
    sourceId, paths: ['/'], snapshots: previous, signal: pending.signal,
    async listFolder(path, { signal }) {
      assert.equal(signal, pending.signal);
      pending.abort();
      return [song('discarded')];
    },
    tracksFromItems() {
      assert.fail('tracks must not be parsed after a cancelled listing');
    },
  }), { name: 'AbortError' });
  assert.deepEqual(previous, before);
});
