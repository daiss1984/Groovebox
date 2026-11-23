export function validPlaylistOccurrence(value, trackId) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const [kind, id, slot, revision] = JSON.parse(value);
    if (typeof id !== 'string' || (trackId !== undefined && id !== trackId)) return false;
    if (kind === 'track') return true;
    if (kind === 'slot') return typeof slot === 'string' && Boolean(slot);
    return kind === 'ordered' && Number.isSafeInteger(slot) && slot >= 0 &&
      typeof revision === 'string' && /^[\w-]{24}$/.test(revision);
  } catch {
    return false;
  }
}

export function validPlaylistContext(value, trackId) {
  return typeof value?.playlist === 'string' && value.playlist.length <= 4096 &&
    /^(?:playlist|server-playlist)\/.+/.test(value.playlist) && validPlaylistOccurrence(value.occurrence, trackId);
}

export const trackOccurrence = trackId => JSON.stringify(['track', trackId]);

// Use raw, unsorted playlist entries so omitted songs may still occupy stable slots.
export function playlistOccurrences(entries, revision) {
  const trackCounts = new Map();
  const slotCounts = new Map();
  for (const { trackId, slotId } of entries) {
    trackCounts.set(trackId, (trackCounts.get(trackId) || 0) + 1);
    if (slotId) slotCounts.set(slotId, (slotCounts.get(slotId) || 0) + 1);
  }
  return entries.map(({ trackId, slotId }, index) => {
    if (slotId && slotCounts.get(slotId) === 1) return JSON.stringify(['slot', trackId, slotId]);
    if (trackCounts.get(trackId) === 1) return trackOccurrence(trackId);
    if (revision) return JSON.stringify(['ordered', trackId, index, revision]);
    return undefined;
  });
}

export function reconcilePlaylistSlots(previous, nextTrackIds, createSlotId) {
  const prefix = previous.length <= nextTrackIds.length &&
    previous.every(({ trackId }, index) => trackId === nextTrackIds[index]);
  const nextCounts = new Map();
  for (const id of nextTrackIds) nextCounts.set(id, (nextCounts.get(id) || 0) + 1);
  if (prefix && previous.length === nextTrackIds.length &&
      previous.every(slot => slot.slotId || nextCounts.get(slot.trackId) === 1)) return previous;
  return nextTrackIds.map((trackId, index) => {
    if (nextCounts.get(trackId) === 1) return { trackId };
    // An external replacement cannot identify a moved duplicate. Only a known slot
    // edit or a matching prefix (an append) proves which slot an old key belongs to.
    return { trackId, slotId: (prefix && previous[index]?.slotId) || createSlotId() };
  });
}

export function swapPlaylistSlots(entries, from, to) {
  [entries[from], entries[to]] = [entries[to], entries[from]];
}

export function playlistStartIndex(contexts, bookmarks) {
  const playlist = Array.isArray(contexts) ? contexts.find(Boolean)?.playlist : undefined;
  if (!playlist) return 0;
  const index = contexts.findIndex(context => context && context.occurrence === bookmarks.get(playlist));
  return Math.max(0, index);
}
