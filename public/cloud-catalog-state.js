import { isCloudCatalogSourceId } from './cloud-catalog.js';

export function catalogSourceId(track) {
  if (typeof track?.id !== 'string') return;
  const separator = track.id.indexOf(':');
  if (separator < 1) return;
  const id = track.id.slice(0, separator);
  if (isCloudCatalogSourceId(id)) return id;
}

export function catalogNeedsDatabase(tracks, snapshots) {
  return tracks.length >= 5000 || JSON.stringify([tracks, snapshots]).length >= 1_000_000;
}

export function catalogGroups(tracks) {
  const groups = new Map();
  for (const track of tracks) {
    const sourceId = catalogSourceId(track);
    if (!sourceId) continue;
    if (!groups.has(sourceId)) groups.set(sourceId, []);
    groups.get(sourceId).push(track);
  }
  return groups;
}

export function catalogMetadata(data) {
  return JSON.parse(JSON.stringify(data));
}

export function inlineCloudState(tracks, snapshots, records) {
  return {
    tracks: tracks.filter(track => !records.has(catalogSourceId(track))),
    scanSnapshots: Object.fromEntries(Object.entries(snapshots).filter(([id]) => !records.has(id))),
  };
}

export function mergeCloudState(tracks, snapshots, records) {
  const inline = inlineCloudState(tracks, snapshots, records);
  return {
    tracks: inline.tracks.concat([...records.values()].flatMap(record => catalogMetadata(record.tracks))),
    scanSnapshots: { ...inline.scanSnapshots, ...Object.fromEntries([...records].map(([id, record]) => [id, record.snapshots])) },
  };
}
