import { normalizeGenres } from './genres.js';
import { latestPlaylistDate, readPlaylistCreationDates } from './playlist-overview.js';

export function validCloudTrack(track) {
  if (!track || typeof track.id !== 'string' || typeof track.title !== 'string' || typeof track.src !== 'string') return false;
  const { src } = track;
  if (/^\/api\/onedrive\/stream\?id=[a-z0-9][a-z0-9_!.-]{0,255}$/i.test(src)) return true;
  return /^\/api\/(?:baidu|gdrive|onedrive|dropbox|box|pcloud|aliyundrive|drive123|drive115|guangya|sources)\/[a-z0-9/?=&_%.-]+$/i.test(src) &&
    new URL(src, 'https://groovebox.invalid').pathname.endsWith('/stream');
}

const list = value => Array.isArray(value) ? value : [];
const trackIds = value => list(value).filter(id => typeof id === 'string' && id);
const ids = value => [...new Set(trackIds(value))];

function snapshotDates(records, playlists) {
  const dates = readPlaylistCreationDates(records, playlists);
  return playlists.flatMap(({ id }) => dates.has(id) ? [[id, dates.get(id)]] : []);
}

export function playlistSnapshot(input) {
  const playlists = new Map();
  for (const item of list(input?.playlists)) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') continue;
    playlists.set(item.id, { id: item.id, name: item.name.slice(0, 80), tracks: trackIds(item.tracks) });
  }
  const favorites = ids(input?.favorites);
  const referenced = new Set([...favorites, ...[...playlists.values()].flatMap(item => item.tracks)]);
  const tracks = new Map();
  for (const track of list(input?.tracks)) {
    if (!validCloudTrack(track) || !referenced.has(track.id)) continue;
    const { genres, embeddedTags, ...fields } = track;
    const normalized = normalizeGenres(genres);
    const tags = embeddedTags && typeof embeddedTags === 'object' && !Array.isArray(embeddedTags) ? { ...embeddedTags } : undefined;
    if (tags && Object.hasOwn(tags, 'genres')) {
      const embeddedGenres = normalizeGenres(tags.genres);
      if (embeddedGenres.length) tags.genres = embeddedGenres;
      else delete tags.genres;
    }
    tracks.set(track.id, {
      ...fields,
      ...(normalized.length && { genres: normalized }),
      ...(tags && { embeddedTags: tags }),
    });
  }
  const entries = [...playlists.values()];
  const playlistCreationDates = snapshotDates(input?.playlistCreationDates, entries);
  const playlistModificationDates = snapshotDates(input?.playlistModificationDates, entries);
  return { version: 1, playlists: entries, favorites, tracks: [...tracks.values()],
    ...(playlistCreationDates.length && { playlistCreationDates }),
    ...(playlistModificationDates.length && { playlistModificationDates }) };
}

function mergeIds(base, local, remote) {
  const before = new Set(base);
  const left = new Set(local);
  const right = new Set(remote);
  return [...new Set([...remote, ...local])]
    .filter(id => !before.has(id) || (left.has(id) && right.has(id)));
}

function mergeTrackOrder(base, local, remote) {
  const merged = mergeIds(base, local, remote);
  const retained = new Set(merged);
  const original = new Set(base);
  const localOrder = local.filter(id => retained.has(id));
  const remoteOrder = remote.filter(id => retained.has(id));
  const changedOrder = order => {
    const included = new Set(order);
    const expected = [...base.filter(id => included.has(id)), ...order.filter(id => !original.has(id))];
    return order.some((id, index) => id !== expected[index]);
  };
  if (!changedOrder(localOrder) || changedOrder(remoteOrder)) return merged;
  const locallyOrdered = new Set(localOrder);
  let index = 0;
  return merged.map(id => locallyOrdered.has(id) ? localOrder[index++] : id);
}

function mergeTrackOccurrences(base, local, remote) {
  const tracks = new Map();
  const occurrences = ids => {
    const counts = new Map();
    return ids.map(id => {
      const ordinal = counts.get(id) || 0;
      counts.set(id, ordinal + 1);
      const key = JSON.stringify([id, ordinal]);
      tracks.set(key, id);
      return key;
    });
  };
  // WebDAV snapshots store track IDs. Equal ordinals identify indistinguishable repeats across devices.
  return mergeTrackOrder(occurrences(base), occurrences(local), occurrences(remote)).map(key => tracks.get(key));
}

export function mergePlaylists(base, local, remote) {
  const before = new Map(base.playlists.map(item => [item.id, item]));
  const left = new Map(local.playlists.map(item => [item.id, item]));
  const right = new Map(remote.playlists.map(item => [item.id, item]));
  const baseDates = readPlaylistCreationDates(base.playlistCreationDates, base.playlists);
  const localDates = readPlaylistCreationDates(local.playlistCreationDates, local.playlists);
  const remoteDates = readPlaylistCreationDates(remote.playlistCreationDates, remote.playlists);
  const modificationDates = [base, local, remote].map(snapshot => readPlaylistCreationDates(snapshot.playlistModificationDates, snapshot.playlists));
  const playlists = mergeTrackOrder([...before.keys()], [...left.keys()], [...right.keys()]).map(id => {
    const previous = before.get(id);
    const localList = left.get(id);
    const remoteList = right.get(id);
    return {
      id,
      name: localList && localList.name !== previous?.name ? localList.name : remoteList?.name ?? localList.name,
      tracks: mergeTrackOccurrences(previous?.tracks || [], localList?.tracks || [], remoteList?.tracks || []),
    };
  });
  const favorites = mergeIds(base.favorites, local.favorites, remote.favorites);
  const baseTracks = new Map(base.tracks.map(track => [track.id, track]));
  const tracks = new Map(remote.tracks.map(track => [track.id, track]));
  for (const track of local.tracks) {
    const other = tracks.get(track.id);
    const previous = baseTracks.get(track.id);
    if (!other || JSON.stringify(other) === JSON.stringify(previous)) tracks.set(track.id, track);
  }
  const playlistCreationDates = playlists.map(({ id }) => {
    const localDate = localDates.get(id);
    const remoteDate = remoteDates.get(id);
    const date = baseDates.get(id) ?? (localDate === undefined || remoteDate === undefined
      ? localDate ?? remoteDate
      : Math.min(localDate, remoteDate));
    return [id, date];
  });
  const playlistModificationDates = playlists.map(({ id }) => [id, latestPlaylistDate(...modificationDates.map(dates => dates.get(id)))]);
  return playlistSnapshot({ playlists, favorites, tracks: [...tracks.values()], playlistCreationDates, playlistModificationDates });
}

export async function reconcilePlaylists(endpoint, base, local, { beforeWrite } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(endpoint, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok && response.status !== 404) throw new Error(payload.error || '无法读取云端歌单。');
    const remote = playlistSnapshot(response.ok ? payload : {});
    const merged = mergePlaylists(base, local, remote);
    if (JSON.stringify(merged) === JSON.stringify(remote)) return merged;
    const etag = response.headers.get('etag');
    if (response.ok && !etag) throw new Error('WebDAV 未提供有效的版本标识，无法安全自动同步。');
    await beforeWrite?.();
    const request = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
      },
      body: JSON.stringify(merged),
    });
    if (request.ok) return merged;
    if (request.status !== 412) {
      const result = await request.json().catch(() => ({}));
      throw new Error(result.error || '无法上传云端歌单。');
    }
  }
  throw new Error('云端歌单正在被其他设备修改，稍后自动重试。');
}
