export function normalizeReleaseYear(value) {
  if (typeof value === 'string') {
    const match = /^(\d{4})(?:-\d{2}(?:-\d{2}(?:T\S+)?)?)?$/.exec(value.trim());
    value = match ? Number(match[1]) : undefined;
  }
  return Number.isInteger(value) && value >= 1000 && value <= 9999 ? value : undefined;
}

export function normalizeTrackModified(value) {
  return Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000 ? value : undefined;
}

const orderValues = {
  'release-year': track => normalizeReleaseYear(track.releaseYear),
  'added-at': track => ['local', 'webdav'].includes(track.provider) ? normalizeTrackModified(track.modified) : undefined,
  'modified-at': track => normalizeTrackModified(track.modified),
};

export const numericTrackOrders = ['release-year', 'added-at-desc', 'modified-at-desc', 'added-at', 'modified-at'];

export function sortNumericTracks(tracks, order) {
  const descending = order.endsWith('-desc');
  const numericValue = orderValues[descending ? order.slice(0, -5) : order];
  const direction = descending ? -1 : 1;
  return tracks.map(track => ({ track, value: numericValue(track) ?? 0 }))
    .sort((a, b) => direction * (a.value - b.value))
    .map(({ track }) => track);
}
