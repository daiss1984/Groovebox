const nonemptyString = value => typeof value === 'string' && value.length > 0;
const validTrailEntry = entry => nonemptyString(entry?.path) && nonemptyString(entry?.name);

function readFolders(entries) {
  const folders = new Map();
  if (!Array.isArray(entries)) return folders;
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const [path, children, tracks, name, parents] = entry;
    if (!nonemptyString(path) || !Array.isArray(children) || !Array.isArray(tracks)) continue;
    if (!children.every(nonemptyString) || !tracks.every(nonemptyString)) continue;
    folders.set(path, { children, tracks, name: nonemptyString(name) ? name : undefined,
      parents: Array.isArray(parents) && parents.every(validTrailEntry) ? parents : undefined });
  }
  return folders;
}

const indexedFolders = new WeakMap();

export function indexedCloudFolders(entries) {
  if (!Array.isArray(entries)) return [];
  if (indexedFolders.has(entries)) return indexedFolders.get(entries);
  const folders = readFolders(entries);
  const parentPaths = new Map();
  for (const [path, { children }] of folders) {
    for (const child of children) if (!parentPaths.has(child)) parentPaths.set(child, path);
  }
  const result = [];
  for (const path of folders.keys()) {
    if (path === '/') continue;
    const trail = [];
    const seen = new Set(['/']);
    let cursor = path;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = folders.get(cursor);
      const name = folder?.name || (cursor.startsWith('/') ? cursor.split('/').filter(Boolean).at(-1) : undefined);
      if (!name) break;
      trail.unshift({ path: cursor, name });
      const parent = parentPaths.get(cursor);
      if (!parent && folder?.parents) trail.unshift(...folder.parents.filter(entry => !seen.has(entry.path)));
      cursor = parent;
    }
    if (trail.length) result.push({ ...trail.at(-1), trail });
  }
  indexedFolders.set(entries, result);
  return result;
}

export function indexedCloudRoots(entries) {
  const folders = readFolders(entries);
  const children = new Set([...folders.values()].flatMap(folder => folder.children));
  const roots = [...folders.keys()].filter(path => path === '/' || !children.has(path));
  const reached = reachableFolders(folders, roots);
  for (const path of folders.keys()) {
    if (reached.has(path)) continue;
    roots.push(path);
    for (const pending of reachableFolders(folders, [path])) reached.add(pending);
  }
  const trails = new Map(indexedCloudFolders(entries).map(folder => [folder.path, folder.trail]));
  return roots.map(path => ({ path, trail: trails.get(path) || [] }));
}

function reachableFolders(folders, roots) {
  const seen = new Set();
  const pending = [...roots];
  while (pending.length) {
    const path = pending.pop();
    const folder = folders.get(path);
    if (!folder || seen.has(path)) continue;
    seen.add(path);
    for (const child of folder.children) pending.push(child);
  }
  return seen;
}

function reconcileFolders(previous, folders, refreshed) {
  const priorScope = reachableFolders(previous, refreshed);
  const retained = reachableFolders(folders, [...folders.keys()].filter(path =>
    refreshed.has(path) || !priorScope.has(path)));
  const previousIds = new Set();
  for (const path of priorScope) {
    for (const id of previous.get(path).tracks) previousIds.add(id);
    if (!retained.has(path)) folders.delete(path);
  }
  // Another scanned root or alias may still contain an otherwise missing track.
  for (const { tracks } of folders.values()) {
    for (const id of tracks) previousIds.delete(id);
  }
  return [...previousIds];
}

/**
 * Scan explicit remote-folder paths and stage one complete update. Commit its
 * result to the caller's persistent library only after this promise resolves.
 * A failed or cancelled walk leaves the input snapshots untouched.
 */
export async function scanCloudFolders({
  sourceId, paths, snapshots = {}, mode = 'incremental', maxDepth = Infinity,
  listFolder, tracksFromItems, signal, onProgress, folderTrails = new Map(),
}) {
  if (!nonemptyString(sourceId) || !Array.isArray(paths) || !paths.every(nonemptyString)) {
    throw new TypeError('云端扫描需要有效的来源和目录。');
  }
  if (!['incremental', 'rescan'].includes(mode)) throw new TypeError('无效的云端扫描方式。');
  if (maxDepth !== Infinity && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
    throw new TypeError('无效的云端扫描深度。');
  }
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) snapshots = {};

  const previous = readFolders(Object.hasOwn(snapshots, sourceId) ? snapshots[sourceId] : undefined);
  const folders = new Map(previous);
  const refreshed = new Set();
  const tracks = new Map();
  const scheduled = new Set(paths);
  const pending = [...scheduled].map(path => ({ path, depth: 0 }));
  const names = new Map([...folderTrails].filter(([, trail]) => trail.length).map(([path, trail]) => [path, trail.at(-1).name]));
  let skipped = 0;

  for (let index = 0; index < pending.length; index++) {
    signal?.throwIfAborted();
    const { path, depth } = pending[index];
    if (mode === 'incremental' && previous.has(path)) {
      skipped++;
    } else {
      const items = await listFolder(path, { signal });
      signal?.throwIfAborted();
      if (!Array.isArray(items)) throw new TypeError('来源未返回完整的目录列表。');

      const childItems = items.filter(item => item?.folder);
      const childPaths = childItems.map(item => item.path);
      if (!childPaths.every(nonemptyString)) throw new TypeError('来源返回了无效的子目录。');
      const children = [...new Set(childPaths.filter(child => child !== path && child !== '/'))];
      for (const item of childItems) if (item.path !== path && item.path !== '/' && nonemptyString(item.name)) names.set(item.path, item.name);
      // Keep confirmed edges even when the depth limit prevents reading a child.
      // Reconciliation can then retain older contents reachable through that edge.
      if (depth < maxDepth) {
        for (const child of children) {
          if (scheduled.has(child)) continue;
          scheduled.add(child);
          pending.push({ path: child, depth: depth + 1 });
        }
      }

      const trackIds = new Set();
      for (const track of tracksFromItems(items, { path, name: names.get(path) ?? folders.get(path)?.name })) {
        if (!nonemptyString(track?.id)) continue;
        trackIds.add(track.id);
        if (!tracks.has(track.id)) tracks.set(track.id, track);
      }
      const prior = folders.get(path);
      const parents = folderTrails.get(path)?.slice(0, -1) ?? prior?.parents;
      folders.set(path, { children, tracks: [...trackIds], name: names.get(path) ?? prior?.name, parents });
      refreshed.add(path);
    }
    onProgress?.({ path, scanned: refreshed.size, skipped, found: tracks.size, pending: pending.length - index - 1 });
  }
  signal?.throwIfAborted();

  const removedIds = mode === 'rescan' ? reconcileFolders(previous, folders, refreshed) : [];
  const next = [...folders].map(([path, { children, tracks, name, parents }]) => {
    const label = names.get(path) ?? name;
    return [path, children, tracks, ...(label ? [label, ...(parents?.length ? [parents] : [])] : [])];
  });
  return {
    snapshots: refreshed.size ? { ...snapshots, [sourceId]: next } : snapshots,
    tracks: [...tracks.values()], removedIds, scanned: refreshed.size, skipped,
  };
}
