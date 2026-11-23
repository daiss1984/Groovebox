export const playlistOverviewOrders = ['manual', 'name', 'name-desc', 'created-at', 'created-at-desc', 'modified-at-desc'];

export function normalizePlaylistOverviewOrder(value) {
  return playlistOverviewOrders.includes(value) ? value : 'manual';
}

export function normalizePlaylistCreatedAt(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : undefined;
}

export function readPlaylistCreationDates(records, playlists) {
  const ids = new Set(playlists.map(list => list?.id).filter(id => typeof id === 'string' && id));
  const dates = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!Array.isArray(record) || record.length !== 2) continue;
    const [id, value] = record;
    const date = normalizePlaylistCreatedAt(value);
    if (ids.has(id) && date !== undefined && !dates.has(id)) dates.set(id, date);
  }
  return dates;
}

export function playlistContents(playlists) {
  return new Map(playlists.filter(list => typeof list?.id === 'string' && list.id)
    .map(({ id, name, tracks }) => [id, { name, tracks: Array.isArray(tracks) ? [...tracks] : [] }]));
}

function sameMembership(left, right) {
  if (left.length !== right.length) return false;
  if (left.every((id, index) => id === right[index])) return true;
  const counts = new Map();
  for (const id of left) counts.set(id, (counts.get(id) || 0) + 1);
  for (const id of right) {
    const remaining = counts.get(id);
    if (!remaining) return false;
    counts.set(id, remaining - 1);
  }
  return true;
}

export function latestPlaylistDate(...values) {
  const known = values.map(normalizePlaylistCreatedAt).filter(value => value !== undefined);
  return known.length ? Math.max(...known) : undefined;
}

export function datesAfterPlaylistChanges(before, after, dates, now) {
  const createdAt = new Map();
  const modifiedAt = new Map();
  for (const [id, contents] of after) {
    const previous = before.get(id);
    const created = previous ? dates.createdAt.get(id) : now;
    let modified = dates.modifiedAt.get(id);
    if (!previous || previous.name !== contents.name || !sameMembership(previous.tracks, contents.tracks)) {
      modified = latestPlaylistDate(modified, now);
    }
    if (created !== undefined) createdAt.set(id, created);
    if (modified !== undefined) modifiedAt.set(id, modified);
  }
  return { createdAt, modifiedAt };
}

export function sortPlaylistOverview(playlists, requestedOrder, { compareNames, createdAt, modifiedAt }) {
  const order = normalizePlaylistOverviewOrder(requestedOrder);
  if (order === 'manual') return playlists;

  const direction = order.endsWith('-desc') ? -1 : 1;
  if (order.startsWith('name')) {
    return playlists.toSorted((left, right) => direction * compareNames(left.name, right.name));
  }
  const dates = order === 'modified-at-desc' ? modifiedAt : createdAt;
  return playlists.toSorted((left, right) => {
    const first = normalizePlaylistCreatedAt(dates?.get(left.id));
    const second = normalizePlaylistCreatedAt(dates?.get(right.id));
    if (first === undefined) return second === undefined ? 0 : 1;
    if (second === undefined) return -1;
    return direction * (first - second);
  });
}
