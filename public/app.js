import { createPlayer } from './player.js';
import { applyCastSleepDeadline } from './cast-sleep.js';
import { coverColor, playButtonColors } from './play-button-color.js';
import { createTrackPreloader } from './track-preload.js';
import { normalizeStreamBitrates, preferredStreamBitrate, streamBitrates, supportsStreamBitrate } from './stream-bitrate.js';
import { describePlaybackEncoding } from './audio-encoding.js';
import { createPlaybackCheckins } from './playback-checkins.js';
import { createListenBrainzPlayback } from './listenbrainz-playback.js';
import { demoTracks } from './demo.js';
import { indexedCloudFolders, indexedCloudRoots, scanCloudFolders } from './cloud-scan.js';
import { CloudCatalogError, readCloudCatalogs, commitCloudCatalog, replaceCloudCatalogs, subscribeCloudCatalogs,
  updateCloudCatalogTracks, readCloudCatalogState, readCloudCatalogControl, legacyCloudCatalogScope,
  prepareCloudCatalogRestore, finalizeCloudCatalogRestore, cancelCloudCatalogRestore } from './cloud-catalog.js';
import { recoverCloudCatalogState, readScopedAppState, parseScopedAppState, withCatalogRestoreLock } from './catalog-recovery.js';
import { catalogSourceId, catalogNeedsDatabase, catalogGroups, catalogMetadata, inlineCloudState, mergeCloudState } from './cloud-catalog-state.js';
import { compileFilenamePattern, defaultFilenamePattern } from './source-filename.js';
import { createPlaylistSnapshot, maxPlaylistSnapshotBytes, readPlaylistSnapshot, validPlaylistSnapshotFile } from './cloud-playlist-snapshot.js';
import { mergePlaylists, playlistSnapshot, reconcilePlaylists, validCloudTrack } from './playlist-sync.js';
import { playlistOccurrences, playlistStartIndex, reconcilePlaylistSlots, swapPlaylistSlots,
  trackOccurrence, validPlaylistContext } from './playlist-resume.js';
import { datesAfterPlaylistChanges, latestPlaylistDate, normalizePlaylistCreatedAt, normalizePlaylistOverviewOrder,
  playlistContents, playlistOverviewOrders, readPlaylistCreationDates, sortPlaylistOverview } from './playlist-overview.js';
import { safeDownloadName } from './playlist-download.js';
import { hydrateOffline, hasOffline, loadOfflineUrl, readOfflineBlob, cacheAudio, fetchAudioBlob, removeOffline,
  authenticatedFolderCover, offlineFolderCover, saveOfflineTrack, playlistAudioLimit, UncacheableAudioError,
  readOfflineCachePolicy, configureOfflineCache, clearAutomaticAudioCache, resumeAutomaticAudioCache,
  pinOfflineTrack, offlineTrackMode, subscribeOfflineCache } from './offline.js';
import { readImageCachePolicy, configureImageCache, clearImageCache, resumeImageCache } from './image-cache-client.js';
import { readPlaylistCachePass, recordPlaylistCacheAttempt, resetPlaylistCacheAttempts,
  playlistCachePassMarkerPrefix } from './playlist-cache-pass.js';
import { readState, writeState, bindStateScope, readStateTextAtScope, writeStateTextAtScope,
  importLocalFiles, hydrateLocals, hydrateLocalArtistImages, readMissingLocalAlbumTags, readLocalReplayGain, readLocalAudioEncoding, readAudioEncoding, removeLocal,
  parseLyrics, isAudioName, mayHaveR128Gain, normalizeAlbumArtist, normalizeGenres, normalizeReleaseYear,
  readServerPlaylistMirrors, addServerPlaylistMirror, putServerPlaylistMirror, updateServerPlaylistMirror, deleteServerPlaylistMirror } from './library.js';
import { createArtistClassifier, createGenreClassifier, normalizeArtistRules, normalizeArtists, normalizeGenreRules } from './genres.js';
import { createPlaybackHistoryRecorder, historyLimit, mergePlaybackHistory, playbackStatistics } from './playback-history.js';
import { t, getLanguage, languageNames, normalizeLanguage, initializeShellLanguage, displayError, InterfaceError } from './locale.js';
import { lyricsFromYaml } from './lyricsfile.js';
import { opusDecoderCapability, verifiedOpusOutputGain } from './opus-output-gain.js';
import { normalizeTrackModified, numericTrackOrders, sortNumericTracks } from './track-sort.js';
import { lyricWordFrame, normalizeWordRenderMode } from './lyric-word-render.js';
import { normalizeEqualizerSettings as equalizerSettings, activeEqBands, equalizerPresets,
  equalizerProfileName, maxEqualizerProfiles } from './equalizer-settings.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[char]);
const icon = (name) => '<svg aria-hidden="true"><use href="/icons.svg#' + name + '"></use></svg>';
const safeImage = (value) => typeof value === 'string' && /^(?:\/(?!\/)|blob:|data:image\/(?:png|jpeg|webp|gif|avif);)/i.test(value);
const cover = (track, extra = '') => {
  const url = trackArtwork(track);
  return '<span class="cover ' + extra + '">' +
    (url ? trackCoverImage(track, url) : icon('music-2')) + '</span>';
};
function trackCoverImage(track, url) {
  return '<img src="' + esc(url) + '" data-track-cover="' + esc(track.id) + '" alt="" decoding="async">';
}
const formatTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds);
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
};
const btn = (label, glyph, action, attrs = '', primary = false) =>
  '<button type="button" class="btn' + (primary ? ' primary' : '') + '" data-action="' + action + '" ' + attrs + '>' +
  (glyph ? icon(glyph) : '') + esc(label) + '</button>';
const tool = (label, glyph, action, attrs = '', active = false) =>
  '<button type="button" class="icon-btn' + (active ? ' active' : '') + '" data-action="' + action +
  '" aria-label="' + esc(label) + '" title="' + esc(label) + '" ' + attrs + '>' + icon(glyph) + '</button>';
const key = (id) => 'data-id="' + esc(id) + '"';
const content = $('#content');
const now = $('#now');
const search = $('#search');
const dialog = $('#dialog');
let dialogRevision = 0;
const audio = $('#audio');
const setInterfaceLanguage = initializeShellLanguage(document);
let loaded = {};
let cloudCatalogScope = legacyCloudCatalogScope;
let cloudCatalogScopeStale = false;
let stateScopeReadError;
let incompleteCatalogRestore;
const cloudCatalogs = new Map();
const durableCloudTracks = new Map();
const cloudCatalogEdits = new Set();
const staleCloudCatalogs = new Set();
let cloudCatalogReadError;
let cloudCatalogStartupError;
let cloudCatalogWork = Promise.resolve();
let cloudCatalogFlush;
let restoringCatalog = false;
try {
  let boot;
  try { boot = await recoverCloudCatalogState(); }
  catch (error) {
    cloudCatalogReadError = cloudCatalogStartupError = error;
    boot = await readCloudCatalogState();
    incompleteCatalogRestore = boot.pending;
  }
  cloudCatalogScope = boot.scope;
  bindStateScope(boot.scope);
  try { loaded = boot.scope === legacyCloudCatalogScope ? readState() : readScopedAppState(boot.scope); }
  catch (error) { stateScopeReadError = error; throw error; }
  for (const record of boot.records) registerCloudCatalog(record);
} catch (error) {
  cloudCatalogReadError = cloudCatalogStartupError = error;
  try {
    const control = await readCloudCatalogControl();
    cloudCatalogScope = control.scope;
    bindStateScope(control.scope);
    loaded = control.scope === legacyCloudCatalogScope ? readState() : readScopedAppState(control.scope);
    stateScopeReadError = undefined;
  } catch (scopeError) { stateScopeReadError = scopeError; }
}
const initialInlineTracks = Array.isArray(loaded.tracks) ? loaded.tracks : [];
const initialInlineSnapshots = loaded.scanSnapshots && typeof loaded.scanSnapshots === 'object' && !Array.isArray(loaded.scanSnapshots)
  ? loaded.scanSnapshots : {};
if (!cloudCatalogReadError) {
  const inline = inlineCloudState(initialInlineTracks, initialInlineSnapshots, cloudCatalogs);
  if (catalogNeedsDatabase(inline.tracks, inline.scanSnapshots)) {
    const incoming = [...catalogGroups(inline.tracks)].map(([sourceId, tracks]) =>
      ({ sourceId, tracks, snapshots: inline.scanSnapshots[sourceId] ?? [] }));
    if (incoming.length) {
      try {
        const expectedRevisions = new Map(incoming.map(record => [record.sourceId, null]));
        for (const record of await replaceCloudCatalogs(catalogMetadata(incoming), { expectedRevisions, expectedScope: cloudCatalogScope })) registerCloudCatalog(record);
      } catch (error) { cloudCatalogStartupError = error; }
    }
  }
}
if (!stateScopeReadError && cloudCatalogs.size) {
    const merged = mergeCloudState(initialInlineTracks, initialInlineSnapshots, cloudCatalogs);
    const trackRows = new Map(merged.tracks.map(track => [track.id, track]));
    for (const edit of Array.isArray(loaded.cloudCatalogEdits) ? loaded.cloudCatalogEdits : []) {
      if (!edit || !Array.isArray(edit.tracks) || cloudCatalogs.get(edit.sourceId)?.revision !== edit.revision) continue;
      for (const track of edit.tracks) {
        if (catalogSourceId(track) !== edit.sourceId || !validCloudTrack(track)) continue;
        trackRows.set(track.id, track);
        cloudCatalogEdits.add(track.id);
      }
    }
    Object.assign(loaded, merged, { tracks: [...trackRows.values()] });
}
const cloudProviderIds = ['baidu', 'gdrive', 'onedrive', 'dropbox', 'box', 'pcloud', 'aliyundrive', 'drive123', 'drive115', 'guangya'];
const cloudScanDepth = 4;
const directRecentLimit = 200;
const folderBookmarkLimit = 200;
const folderBookmarks = new Map((Array.isArray(loaded.folderBookmarks) ? loaded.folderBookmarks : []).slice(-folderBookmarkLimit)
  .filter(entry => Array.isArray(entry) && validFolderPlaybackKey(entry[0]) && typeof entry[1]?.trackId === 'string' &&
    Number.isFinite(entry[1].position) && entry[1].position >= 0));
const trackProgressLimit = 1000;
const trackProgress = new Map((Array.isArray(loaded.trackProgress) ? loaded.trackProgress : []).slice(-trackProgressLimit)
  .filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && Number.isInteger(entry[1]) && entry[1] >= 0 && entry[1] <= 100));
let folderPlayback;
const artworkPath = /^\/api\/artwork\/cover\?id=[a-f0-9-]{36}$/;
const portraitPath = /^\/api\/artwork\/artist-cover\?id=[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const onlineCovers = new Map((Array.isArray(loaded.onlineCovers) ? loaded.onlineCovers : []).filter(entry =>
  Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && artworkPath.test(entry[1])).slice(-300));
const artistPortraits = new Map((Array.isArray(loaded.artistPortraits) ? loaded.artistPortraits : []).filter(entry =>
  Array.isArray(entry) && typeof entry[0] === 'string' && validPortrait(entry[1])).slice(-150));
const portraitRequests = new Map();
const portraitRetryAt = new Map();
const artworkRequests = new Map();
const artworkRetryAt = new Map();
const failedCovers = new Set();
const metadataArtworkPath = '/api/metadata/artwork/';
const customCoverPath = /^\/api\/metadata\/artwork\/image\?id=[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const customCoverStorage = 'groovebox.custom-artwork.v1';
const customCoverRecords = readCustomCoverRecords();
const customCoverJobs = new Map();
const customCoverRetryAt = new Map();
const customCoverRecoveryAt = new Map();
const offlineCustomFailures = new Set();
let customCoverStatus;
let customCoverStatusJob;
let customCoverStatusController;
let customCoverStatusSequence = 0;
let customCoverStatusErrorAt = 0;
let customCoverStatusCheckedAt = 0;
let customCoverObserver;
const customCoverChanges = typeof BroadcastChannel === 'function' ? new BroadcastChannel('groovebox.metadata-artwork') : undefined;
customCoverChanges?.addEventListener('message', () => { void refreshCustomCoverStatus(true).catch(() => {}); });
const lyricWeights = {
  default: ['默认字重', 'Default weight'], regular: ['常规', 'Regular weight'],
  medium: ['中等', 'Medium weight'], bold: ['粗体', 'Bold weight'],
};
const normalizeLyricWeight = value => typeof value === 'string' && Object.hasOwn(lyricWeights, value) ? value : 'default';
const defaults = {
  theme: 'copper', volume: .8, shuffle: false, repeat: 'off', speed: 1, eq: [...equalizerPresets.flat], eqEnabled: false, eqPreset: 'flat',
  demos: true, showLocalSource: true, compactPlayer: false, multilineTrackTitles: false, blurLyrics: false, playButtonStyle: 'circle', openPlaybackOnTrack: false,
  openPlaybackOnCurrentTrack: false, restorePlaybackProgress: true, pauseInBackground: false, showAlbumTrackProgress: false,
  rememberPlaylistPosition: false, queueAllDirectTracks: true,
  playlistOverviewOrder: 'created-at-desc',
  onlineCover: true, artistImageEngine: true, artistAlbumCoverFallback: true,
  lyricOffsetMs: 0, lyricWeight: 'default', fullscreenLyricsCentered: false, lyricWordMode: 'opacity-gradient',
  backgroundBlur: 0, backgroundOpacity: 35, language: 'zh-CN', playButtonCoverColor: false, keepTopbarVisible: true,
  sleepTimerMinutes: 30,
};
const maxSleepTimerMinutes = 720;
let sleepTimer;
let sleepTimerTick;
function validSleepTimerMinutes(minutes) {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= maxSleepTimerMinutes;
}
const playButtonStyles = { circle: '圆形', rounded: '圆角方形', outline: '圆形描边' };
const sortLabels = {
  default: ['默认顺序', 'Default Order'],
  title: ['歌曲名', 'Track Title'],
  'title-desc': ['歌曲名（倒序）', 'Track Title (Z–A)'],
  'file-name': ['文件名', 'File Name'],
  'file-name-desc': ['文件名（倒序）', 'File Name (Z–A)'],
  artist: ['艺人', 'Artist'],
  album: ['专辑', 'Album'],
  duration: ['时长', 'Duration'],
  name: ['名称', 'Name'],
  'name-desc': ['名称（倒序）', 'Name (Z–A)'],
  'track-count': ['歌曲数量（从多到少）', 'Most Tracks'],
  'album-artist': ['专辑艺人', 'Album Artist'],
  'release-year': ['年份（从早到晚）', 'Year (Oldest First)'],
  'release-year-desc': ['年份（从晚到早）', 'Year (Newest First)'],
  'added-at-desc': ['添加时间（最新优先）', 'Date added(Desc)'],
  'modified-at-desc': ['修改时间（最新优先）', 'Date modified(Desc)'],
  'added-at': ['添加时间（最早优先）', 'Date added(Asc)'],
  'modified-at': ['修改时间（最早优先）', 'Date modified(Asc)'],
};
const trackOrders = ['default', 'title', 'title-desc', 'artist', 'album', 'duration', ...numericTrackOrders];
const fileNameOrders = ['file-name', 'file-name-desc'];
const groupOrders = ['default', 'name', 'name-desc', 'track-count'];
const albumYearOrders = ['release-year', 'release-year-desc'];
const albumNameOrder = new Intl.Collator('zh-Hans-u-co-pinyin').compare;
const fileNameOrder = new Intl.Collator('zh-Hans-u-co-pinyin', { numeric: true }).compare;
const albumGridChoices = ['auto', '1', '2', '3', '4'];
const sortSections = {
  songs: trackOrders, playlist: trackOrders, artist: trackOrders, album: trackOrders, genre: trackOrders,
  offline: trackOrders, source: [...trackOrders, ...fileNameOrders], 'local-folder': ['default', ...fileNameOrders, ...numericTrackOrders],
  artists: groupOrders, albums: [...groupOrders, 'album-artist', ...albumYearOrders], genres: groupOrders,
};
const state = {
  tracks: Array.isArray(loaded.tracks) ? loaded.tracks : [],
  removedLibraryTracks: libraryTrackIdSet(loaded.removedLibraryTracks),
  scanSnapshots: loaded.scanSnapshots && typeof loaded.scanSnapshots === 'object' && !Array.isArray(loaded.scanSnapshots)
    ? loaded.scanSnapshots : {},
  cloudScanScopes: normalizeCloudScanScopes(loaded.cloudScanScopes),
  favorites: Array.isArray(loaded.favorites) ? loaded.favorites : [],
  playlists: Array.isArray(loaded.playlists) ? loaded.playlists : [],
  cachedPlaylistIds: Array.isArray(loaded.cachedPlaylistIds) ? loaded.cachedPlaylistIds.filter(id => typeof id === 'string') : [],
  cacheExclusions: Array.isArray(loaded.cacheExclusions) ? loaded.cacheExclusions.filter(id => typeof id === 'string') : [],
  history: mergePlaybackHistory(loaded.history),
  directRecent: normalizeDirectRecent(loaded.directRecent),
  settings: {
    ...defaults, ...loaded.settings,
    replayGainMode: loaded.settings?.replayGainMode === 'album' ? 'album' : 'track',
    hiddenLibrarySources: normalizeHiddenLibrarySources(loaded.settings?.hiddenLibrarySources),
    directCloudSources: normalizeDirectCloudSources(loaded.settings?.directCloudSources),
    sourceFilenameRules: normalizeSourceFilenameRules(loaded.settings?.sourceFilenameRules),
    sort: Object.keys(loaded).length ? normalizeSort('songs', loaded.settings?.sort) : 'title',
    listSorts: normalizeListSorts(loaded.settings?.listSorts),
    playlistOverviewOrder: Object.hasOwn(loaded, 'playlists') || Object.hasOwn(loaded.settings ?? {}, 'playlistOverviewOrder')
      ? normalizePlaylistOverviewOrder(loaded.settings?.playlistOverviewOrder) : defaults.playlistOverviewOrder,
    language: normalizeLanguage(loaded.settings?.language),
    genreRules: normalizeGenreRules(loaded.settings?.genreRules),
    artistRules: normalizeArtistRules(loaded.settings?.artistRules),
    albumArtistFallback: loaded.settings?.albumArtistFallback === true,
    ...artworkSettings(loaded.settings),
    streamBitrates: normalizeStreamBitrates(loaded.settings?.streamBitrates),
    restorePlaybackProgress: loaded.settings?.restorePlaybackProgress !== false,
    rememberPlaylistPosition: loaded.settings?.rememberPlaylistPosition === true,
    queueAllDirectTracks: loaded.settings?.queueAllDirectTracks !== false,
    lyricOffsetMs: normalizeLyricOffset(loaded.settings?.lyricOffsetMs),
    lyricWeight: normalizeLyricWeight(loaded.settings?.lyricWeight),
    lyricWordMode: normalizeWordRenderMode(loaded.settings?.lyricWordMode),
    fullscreenLyricsCentered: loaded.settings?.fullscreenLyricsCentered === true,
    pauseInBackground: loaded.settings?.pauseInBackground === true,
    showAlbumTrackProgress: loaded.settings?.showAlbumTrackProgress === true,
    blockedArtworkArtists: normalizeArtworkArtists(loaded.settings?.blockedArtworkArtists),
    albumGridColumns: normalizeAlbumGridColumns(loaded.settings?.albumGridColumns),
    sleepTimerMinutes: validSleepTimerMinutes(loaded.settings?.sleepTimerMinutes) ? loaded.settings.sleepTimerMinutes : defaults.sleepTimerMinutes,
    sleepTimerFinishTrack: loaded.settings?.sleepTimerFinishTrack === true,
    ...equalizerSettings(loaded.settings),
    playButtonStyle: Object.hasOwn(playButtonStyles, loaded.settings?.playButtonStyle)
      ? loaded.settings.playButtonStyle : defaults.playButtonStyle,
  },
};
let playlistCreationDates = readPlaylistCreationDates(loaded.playlistCreationDates, state.playlists);
let playlistModificationDates = readPlaylistCreationDates(loaded.playlistModificationDates, state.playlists);
let savedPlaylistContents = playlistContents(state.playlists);
let classifyGenres = createGenreClassifier(state.settings.genreRules);
let classifyArtists = createArtistClassifier(state.settings.artistRules);
setInterfaceLanguage(state.settings.language);
let playlistSync = typeof loaded.playlistSync?.id === 'string' ? {
  id: loaded.playlistSync.id, base: playlistSnapshot(loaded.playlistSync.base),
} : undefined;
let syncTimer, syncJob;
let syncRequested = false;
let pendingWebDavRestores = 0;
let syncLabel = '';
let syncFingerprint = '';
let locals = [];
let localArtistImages = new Map();
const remoteArtistImages = new Map();
const folderPortraitProviders = new Set(['webdav', 'smb']);
const remoteArtistImageQueue = [];
let remoteArtistImageRequests = 0;
let remoteArtistRetryTimer;
let indexedLocals;
let localFolders;
let localAlbumTagsJob;
const offlineOperations = new Map();
const removingTracks = new Set();
const playlistCacheFailures = new Map();
let playlistCacheTimer;
let pendingPlaylistCache;
let playlistPrecache;
let audioCachePolicy;
let automaticCachePass;
const automaticCachePassKey = 'groovebox.playlist-cache-pass.v1';
let playlistDownload;
let preparedPlaylistDownload;
const compatibleMedia = new Map();
const converting = new Map();
const tagReads = new Map();
const viewedTags = new Set();
let bulkTagJob;
let rows = [];
let renderedTrackRoute;
let playRows = [];
let playPlaylistContexts;
const playlistResumeBookmarks = new Map((Array.isArray(loaded.playlistResumeBookmarks) ? loaded.playlistResumeBookmarks : [])
  .filter(entry => Array.isArray(entry) && validPlaylistContext({ playlist: entry[0], occurrence: entry[1] })));
const localPlaylistSlots = readLocalPlaylistSlots(loaded.localPlaylistSlots);
let selectionMode = false;
let trackPress;
let suppressedPointerClickWithin;
let selectionAnchor = -1;
const selectedTrackIds = new Set();
let playlistOrdering = false;
let playlistQuery = '';
let tab = 'queue';
let immersive = false;
let immersiveScroll;
let immersiveTrigger;
let immersivePointer;
let lyricPanelPointer;
let immersiveLyrics;
let panelOpen = innerWidth > 1000;
let panelEncodingRequest;
let ready = false;
let lastNow = '';
let visibleQueueOccurrence;
let toastTimer;
let pendingSave;
let muteVolume = .8;
let route = 'home';
let searchReturn = 'home';
let query = '';
let trackToLocate;
const downloadFilters = { query: '', category: 'all', artist: '', album: '', genre: '' };
const cloudStatus = Object.fromEntries(cloudProviderIds.map(id => [id, { configured: false, connected: false }]));
let baidu = cloudStatus.baidu;
let sources = [];
let sourcesLoaded = false;
let sourceRegistryError;
const navidromeHomeAlbums = new Map();
let cloud = null;
let cloudRequest = 0;
const serverPlaylistMirrors = new Map();
const activeMirrorOperations = new Set();
let navidromePlaylistSyncSource;
let loadingServerPlaylistMirrors = true;
let scanJob;
let eqNodes, context, audioSource, mediaId;
let screenLock;
let requestingScreenLock = false;
let listenBrainzAccount = null;
let localCast;
let castingBusy = false;
let checkingCastPosition = false;
let castControlQueue = Promise.resolve();
let pendingCastCommands = 0;
const colorPreference = matchMedia('(prefers-color-scheme: light)');
const themes = {
  copper: ['铜橘', '#fa9b72', '#1b1411', '#111113', '#171719', '#202023', '#29292d'],
  lavender: ['雾紫', '#c2a7ff', '#191229', '#14121b', '#1c1926', '#282235', '#352e45'],
  jade: ['青玉', '#98d3bc', '#10211b', '#0e1513', '#141f1c', '#1d2b26', '#293c35'],
  ocean: ['海蓝', '#8ac8ff', '#102032', '#0f141c', '#161d28', '#202936', '#2b3646'],
  light: ['纸白', '#9b3d16', '#ffffff', '#faf7f3', '#f3eee8', '#eae1d8', '#d7c9bf'],
  system: ['跟随系统', '#a99284'],
};
const providerNames = { baidu: '百度网盘', gdrive: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox', box: 'Box', pcloud: 'pCloud', aliyundrive: '阿里云盘', drive123: '123 云盘', drive115: '115 网盘', guangya: '光鸭云盘', webdav: 'WebDAV', plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby', subsonic: 'Subsonic', opensubsonic: 'OpenSubsonic', navidrome: 'Navidrome', kodi: 'Kodi', smb: 'SMB 2 / 3', songloft: 'Songloft', fnmusic: '飞牛音乐（音桥）' };
const englishProviderNames = { baidu: 'Baidu Netdisk', aliyundrive: 'Aliyun Drive', drive123: '123 Cloud Drive',
  drive115: '115 Netdisk', guangya: 'Guangya Cloud Drive', fnmusic: 'Feiniu Music (Yinqiao)' };
const providerLabel = id => t(providerNames[id] || id, englishProviderNames[id] || providerNames[id] || id);
const cloudSources = () => [...cloudProviderIds.map(id => ({ id, name: providerNames[id], type: id })), ...sources];

function trackFieldLabel(track, field) {
  const value = track?.[field];
  if (field === 'artist') return value && !track.artistIsFallback ? value : t('未知艺人', 'Unknown artist');
  if (!value) return t('未知专辑', 'Unknown album');
  if (track.albumIsFallback && track.provider === 'local') return t(value, 'Local Music');
  if (track.albumIsFallback && cloudProviderIds.includes(track.provider)) return providerLabel(track.provider);
  return value;
}

function groupLabel(field, value, tracks) {
  if (field === 'genre') {
    if (value === 'missing') return t('未分类', 'Uncategorized');
    return genresForTrack(tracks[0]).find(name => genreKey(name) === value) || value.slice(2);
  }
  if (field === 'album') value = tracks[0]?.album || albumNameFromKey(value);
  return tracks.length && tracks.every(track => !track[field] || track[field + 'IsFallback']) ?
    trackFieldLabel(tracks[0], field) : value;
}

function normalizeHiddenLibrarySources(value) {
  const sources = new Map();
  for (const entry of Array.isArray(value) ? value : []) {
    const { id, name } = entry || {};
    if (typeof id === 'string' && /^[a-z0-9-]{1,64}$/i.test(id)) {
      sources.set(id, typeof name === 'string' ? name.slice(0, 120) : id);
    }
  }
  return sources;
}
function normalizeDirectCloudSources(value) {
  return new Set(Array.isArray(value) ? cloudProviderIds.filter(id => value.includes(id)) : []);
}
function normalizeSourceFilenameRules(entries) {
  const rules = new Map();
  for (const { id, mode, pattern } of Array.isArray(entries) ? entries.filter(entry => entry && typeof entry === 'object') : []) {
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(id) || !['tags', 'filename'].includes(mode) ||
      typeof pattern !== 'string' || pattern.length > 80) continue;
    try { compileFilenamePattern(pattern); }
    catch { continue; }
    rules.set(id, { mode, pattern });
  }
  return rules;
}
function normalizeDirectRecent(value) {
  const seen = new Set();
  return mergePlaybackHistory(value).filter(({ id }) => {
    if (!cloudProviderIds.includes(id.split(':', 1)[0]) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, directRecentLimit);
}
function isDirectCloudSource(id) {
  return state.settings.directCloudSources.has(id);
}
function sourceVisibleInCatalog(id) {
  return !isDirectCloudSource(id) && !state.settings.hiddenLibrarySources.has(id);
}
function librarySourceId(track) {
  if (track.provider === 'local' || cloudProviderIds.includes(track.provider)) return track.provider;
  return typeof track.src === 'string' ? /^\/api\/sources\/([a-z0-9-]+)\/stream(?:\?|$)/i.exec(track.src)?.[1] : undefined;
}
function libraryTrackIdSet(value) {
  return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : []);
}
function visibleInLibrary(track) {
  return !state.removedLibraryTracks.has(track.id) && track.directOnly !== true && sourceVisibleInCatalog(librarySourceId(track));
}
function allTracks() {
  return [...new Map([...state.tracks, ...(state.settings.demos ? demoTracks : []), ...locals].map(track => [track.id, track])).values()];
}
function library() {
  return allTracks().filter(visibleInLibrary);
}
function find(id) {
  return allTracks().find(track => track.id === id) || rows.find(track => track.id === id) ||
    player.getState().queue.find(track => track.id === id);
}
function savedTrack(track) {
  return { ...track, src: track.src?.startsWith('blob:') ? undefined : track.src,
    cover: track.cover?.startsWith('blob:') ? undefined : track.cover };
}
function registerCloudCatalog(record) {
  for (const track of cloudCatalogs.get(record.sourceId)?.tracks || []) durableCloudTracks.delete(track.id);
  cloudCatalogs.set(record.sourceId, record);
  for (const track of record.tracks) durableCloudTracks.set(track.id, track);
}
function replaceRegisteredCatalogs(records) {
  cloudCatalogs.clear();
  durableCloudTracks.clear();
  for (const record of records) registerCloudCatalog(record);
}
function catalogErrorMessage(error) {
  if (error?.code === 'cloud-catalog-conflict') return t('另一标签页更新了云端曲库，请刷新页面后重试。',
    'Another tab updated the cloud library. Reload this page and try again.');
  if (error?.code === 'cloud-catalog-blocked') return t('云端曲库存储被其他标签页占用，请关闭旧标签页后刷新。',
    'Another tab is blocking cloud library storage. Close older tabs and reload.');
  return t('无法保存或读取云端曲库，请检查浏览器存储后重试。',
    'Could not save or read the cloud library. Check browser storage and try again.');
}
function assertCatalogWritable(sourceId) {
  if (cloudCatalogReadError) throw cloudCatalogReadError;
  if (cloudCatalogScopeStale) throw new CloudCatalogError('cloud-catalog-conflict', 'The settings scope changed in another tab');
  if (sourceId ? staleCloudCatalogs.has(sourceId) : staleCloudCatalogs.size) {
    throw new CloudCatalogError('cloud-catalog-conflict', 'Cloud catalog changed in another tab');
  }
}
function runCloudCatalogWork(task) {
  const job = cloudCatalogWork.then(task);
  cloudCatalogWork = job.catch(() => {});
  return job;
}
function pendingCloudCatalogEdits() {
  if (!cloudCatalogEdits.size) return [];
  const edits = state.tracks.filter(track => cloudCatalogEdits.has(track.id) &&
    JSON.stringify(savedTrack(track)) !== JSON.stringify(durableCloudTracks.get(track.id)));
  return [...catalogGroups(edits)].flatMap(([sourceId, tracks]) => {
    const revision = cloudCatalogs.get(sourceId)?.revision;
    return revision ? [{ sourceId, revision, tracks: tracks.map(savedTrack) }] : [];
  });
}
function flushCloudCatalogEdits() {
  if (cloudCatalogFlush || !cloudCatalogEdits.size || restoringCatalog) return cloudCatalogFlush;
  const job = runCloudCatalogWork(async () => {
    let changed = false;
    for (const { sourceId, revision, tracks } of pendingCloudCatalogEdits()) {
      assertCatalogWritable(sourceId);
      try {
        registerCloudCatalog(await updateCloudCatalogTracks(sourceId, { upsert: catalogMetadata(tracks) }, {
          expectedRevision: revision, expectedScope: cloudCatalogScope,
        }));
      } catch (error) {
        if (error?.code === 'cloud-catalog-conflict') staleCloudCatalogs.add(sourceId);
        throw error;
      }
      changed = true;
    }
    const remaining = new Set(pendingCloudCatalogEdits().flatMap(edit => edit.tracks.map(track => track.id)));
    for (const id of cloudCatalogEdits) if (!remaining.has(id)) cloudCatalogEdits.delete(id);
    return changed;
  });
  cloudCatalogFlush = job;
  void job.then(changed => {
    cloudCatalogFlush = undefined;
    if (changed) save();
  }, error => {
    cloudCatalogFlush = undefined;
    announce(catalogErrorMessage(error));
  });
  return job;
}
let playlistStorageStale = false;
let persistedPlaylistState = playlistStorageFingerprint(loaded);
function serializableAppState(value, { records = cloudCatalogs, dates, catalogEdits } = {}) {
  const current = player.getState();
  const queue = current.queue.map(track => track.id);
  return { ...value, ...inlineCloudState(value.tracks, value.scanSnapshots, records),
    ...(catalogEdits?.length && { cloudCatalogEdits: catalogEdits }),
    removedLibraryTracks: [...value.removedLibraryTracks], settings: serializedSettings(value.settings),
    playlistSync, onlineCovers: [...onlineCovers], artistPortraits: [...artistPortraits],
    onlineLyrics: savedOnlineLyrics(), onlineLyricsEpoch: lyricCacheEpoch,
    serverLyricChoices: [...serverLyricChoices],
    queue, index: current.index, position: current.currentTime, trackProgress: [...trackProgress],
    playlistResumeBookmarks: [...playlistResumeBookmarks], localPlaylistSlots: savedLocalPlaylistSlots(value.playlists),
    playlistQueue: savedPlaylistQueue(queue), ...serializePlaylistDates(dates, value.playlists),
    folderBookmarks: [...folderBookmarks], folderQueue: folderPlayback && queue.length ? {
      key: folderPlayback.key, outside: queue.filter(id => !folderPlayback.members.has(id)),
    } : undefined, shuffleSession: player.shuffleSnapshot() };
}
function markAppStatePersisted(value, dates) {
  playlistCreationDates = dates.createdAt;
  playlistModificationDates = dates.modifiedAt;
  savedPlaylistContents = playlistContents(value.playlists);
  persistedPlaylistState = playlistStorageFingerprint({ ...value, ...serializePlaylistDates(dates, value.playlists) });
}
function save({ strict = false, playlistDates, catalogRestore = false } = {}) {
  if (stateScopeReadError || incompleteCatalogRestore) return strict ? false : undefined;
  if (restoringCatalog && !catalogRestore) return strict ? false : undefined;
  if (syncJob || pendingWebDavRestores) checkPlaylistStorage();
  if (playlistStorageStale) return strict ? false : undefined;
  const contents = playlistContents(state.playlists);
  const dates = playlistDates ?? datesAfterPlaylistChanges(savedPlaylistContents, contents, {
    createdAt: playlistCreationDates, modifiedAt: playlistModificationDates,
  }, Date.now());
  const catalogEdits = cloudCatalogReadError ? loaded.cloudCatalogEdits : pendingCloudCatalogEdits();
  try {
    if (!writeState(serializableAppState(state, { dates, catalogEdits }))) {
      throw new Error('Storage unavailable');
    }
  } catch {
    if (strict) return false;
    announce(t('浏览器存储空间不足，部分更改可能无法保存。', 'Browser storage is full. Some changes may not be saved.'));
    return;
  }
  markAppStatePersisted(state, dates);
  if (playlistSync && !cloudCatalogScopeStale && !cloudCatalogReadError) {
    const fingerprint = JSON.stringify(currentPlaylistSnapshot());
    if (fingerprint !== syncFingerprint) {
      syncFingerprint = fingerprint;
      schedulePlaylistSync();
    }
  }
  schedulePlaylistCache();
  if (!cloudCatalogScopeStale && !cloudCatalogReadError && (!bulkTagJob || cloudCatalogEdits.size >= 16)) void flushCloudCatalogEdits();
  if (strict) return true;
}
function announce(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}
const trackCount = count => t('{count} 首歌曲', count === 1 ? '{count} track' : '{count} tracks', { count });
function fav(id) { return state.favorites.includes(id); }
function favorite(track) {
  if (!track) return;
  remember(track);
  state.favorites = fav(track.id) ? state.favorites.filter(id => id !== track.id) : [...state.favorites, track.id];
  save();
  refreshCurrent();
}
function remember(track) {
  if (track.provider === 'local' || track.provider === 'demo') return;
  const index = state.tracks.findIndex(item => item.id === track.id);
  const saved = savedTrack(track);
  if (index < 0) {
    if (isDirectCloudSource(librarySourceId(track))) saved.directOnly = true;
    state.tracks.push(saved);
  } else {
    if (state.tracks[index].directOnly === true) saved.directOnly = true;
    else delete saved.directOnly;
    state.tracks[index] = saved;
  }
  if (cloudCatalogs.has(catalogSourceId(saved)) && JSON.stringify(saved) !== JSON.stringify(durableCloudTracks.get(saved.id))) {
    cloudCatalogEdits.add(saved.id);
  }
}
function trackRows(tracks, { emptyMessage = t('这里还没有歌曲', 'No tracks yet'), playList = tracks,
  reordering = false, serverPlaylistEdit, playIndices = [], discGroups = false, playlistContexts, directCollection = false } = {}) {
  rows = tracks;
  playRows = playList;
  playPlaylistContexts = Array.isArray(playlistContexts) ? playlistContexts : undefined;
  if (!tracks.length) return empty('music-2', emptyMessage);
  const picking = selectionMode && routeSupportsSelection();
  const longPress = /^(?:album|artist|playlist|genre)\//.test(route);
  const showProgress = route.startsWith('album/') && state.settings.showAlbumTrackProgress;
  return (picking ? selectionToolbar() : '') + '<div class="table-wrap"><table class="track-table' +
    (longPress ? ' track-table-long-press' : '') + '"><thead><tr><th scope="col">' +
    (picking ? '<input type="checkbox" id="select-all-tracks" aria-label="' + t('选择全部歌曲', 'Select all tracks') + '">' : '#') +
    '</th><th scope="col">' + t('歌曲', 'Track') + '</th><th scope="col">' + t('专辑', 'Album') + '</th><th scope="col">' +
    icon('clock-3') + '<span hidden>' + t('时长', 'Duration') + '</span></th><th scope="col"><span hidden>' +
    t('操作', 'Actions') + '</span></th></tr></thead><tbody>' +
    tracks.map((track, index) => {
      const discNumber = discGroups ? albumSequenceNumber(track.discNumber) : undefined;
      const newDisc = discGroups && (index === 0 || albumSequenceNumber(tracks[index - 1].discNumber) !== discNumber);
      const listIndex = playIndices[index] ?? index;
      const occurrence = playPlaylistContexts?.[listIndex]?.occurrence;
      const playlistItem = serverPlaylistEdit?.entries[listIndex];
      const entry = playlistItem?.playlistEntry;
      const provider = serverPlaylistEdit?.provider;
      return (newDisc
        ? '<tr class="disc-heading"><th colspan="5">' + (discNumber ? t('第 {disc} 碟', 'Disc {disc}', { disc: discNumber }) :
          t('未标注碟号', 'Disc number unavailable')) + '</th></tr>' : '') +
      '<tr data-track="' + esc(track.id) + '"' +
      (occurrence ? ' data-playlist-occurrence="' + esc(occurrence) + '"' : '') + '><td>' +
      (picking ? '<input type="checkbox" data-select-track="' +
        index + '" aria-label="' + t('选择 ', 'Select ') + esc(track.title) + '"' + (selectedTrackIds.has(track.id) ? ' checked' : '') + '>' :
        discGroups ? albumSequenceNumber(track.trackNumber) ?? '—' : index + 1) +
      '</td><td><button class="track-main" data-action="' + (picking ? 'select-row' : 'play-row') + '" data-index="' + index + '"' +
      (!picking && directCollection ? ' data-direct-collection' : '') +
      (!picking && playIndices.length ? ' data-play-index="' + playIndices[index] + '"' : '') + '>' +
      cover(track) + '<span class="track-details"><span class="track-name">' + esc(track.title) +
      '</span><span class="track-artist">' + esc(trackFieldLabel(track, 'artist')) + '</span></span></button></td><td>' +
      esc(track.album ? trackFieldLabel(track, 'album') : '—') + '</td><td>' + formatTime(track.duration) +
      (showProgress ? albumTrackProgress(track) : '') + '</td><td><div class="row-actions">' +
      (reordering ? playlistRowOrder(track, index, tracks.length) :
        tool(fav(track.id) ? t('取消收藏', 'Remove from favorites') : t('收藏', 'Favorite'), 'heart', 'favorite', key(track.id), fav(track.id)) +
        (entry ? tool(t('从 {name} 歌单移除', 'Remove from {name} Playlist', { name: providerLabel(provider) }), 'list-minus',
          'remove-' + provider + '-playlist-entry', key(entry)) : provider === 'jellyfin' && jellyfinRemovalCount(playlistItem)
          ? tool(jellyfinGroupRemovalLabel(playlistItem.playlistRemoveCount),
            'list-minus', 'remove-jellyfin-playlist-entries', key(playlistItem.playlistRemoveEntry)) : '') +
        (route === 'offline' ? tool(t('删除下载', 'Remove download'), 'trash-2', 'remove-download', key(track.id)) : '') +
        tool(t('歌曲选项', 'Track Options'), 'ellipsis', 'track-menu', key(track.id))) + '</div></td></tr>';
    }).join('') +
    '</tbody></table></div>';
}
function albumTrackProgress(track) {
  const value = trackProgress.get(track.id);
  return '<progress class="album-track-progress" max="100" value="' + (value ?? 0) + '" aria-label="' +
    esc(t('「{title}」的播放进度', 'Playback progress for {title}', { title: track.title })) + '"' + (value === undefined ? ' hidden' : '') + '></progress>';
}
function playlistRowOrder(track, index, total) {
  const attrs = 'data-index="' + index + '"';
  return tool(t('上移 {title}', 'Move up {title}', { title: track.title }), 'chevron-up', 'playlist-track-up', attrs + (index === 0 ? ' disabled' : '')) +
    tool(t('下移 {title}', 'Move down {title}', { title: track.title }), 'chevron-down', 'playlist-track-down', attrs + (index === total - 1 ? ' disabled' : ''));
}
function routeSupportsSelection() {
  return !['home', 'sources', 'settings', 'albums', 'artists', 'genres'].includes(route);
}
function canReorderPlaylistSelection() {
  return route.startsWith('playlist/') && listSort(route) === 'default' && !playlistQuery.trim() && rows.length > 1;
}
function selectionToolbar() {
  return '<div class="selection-tools actions"><span data-selection-count role="status"></span>' +
    btn(t('播放所选', 'Play Selection'), 'play', 'play-selection', 'data-needs-selection') +
    btn(t('加入队列', 'Add to Queue'), 'list-end', 'queue-selection', 'data-needs-selection') +
    btn(t('添加到歌单', 'Add to Playlist'), 'list-plus', 'playlist-selection', 'data-needs-selection') +
    (canReorderPlaylistSelection() ?
      btn(t('上移所选', 'Move Selection Up'), 'chevron-up', 'playlist-selection-up', 'data-selection-step="-1" disabled') +
      btn(t('下移所选', 'Move Selection Down'), 'chevron-down', 'playlist-selection-down', 'data-selection-step="1" disabled') : '') +
    (route.startsWith('playlist/') ? btn(t('移除所选', 'Remove Selection'), 'list-minus', 'remove-selection', 'data-needs-selection') : '') +
    (route === 'songs' ? btn(t('从曲库移除所选', 'Remove Selected from Library'), 'trash-2', 'remove-library-selection',
      'data-needs-library-selection disabled') : '') +
    (route === 'offline' ? btn(t('删除所选下载', 'Remove Selected Downloads'), 'trash-2', 'remove-selected-downloads', 'data-needs-selection') : '') + '</div>';
}
function selectedTracks() {
  return rows.filter(track => selectedTrackIds.has(track.id));
}
function selectedLibraryTracks() {
  return selectedTracks().filter(track => track.provider !== 'demo');
}
function updateSelectionControls() {
  const selectAll = $('#select-all-tracks');
  if (!selectAll) return;
  const count = selectedTracks().length;
  $('[data-selection-count]').textContent = t('已选 {count} 首', '{count} selected', { count });
  selectAll.checked = count === rows.length && count > 0;
  selectAll.indeterminate = count > 0 && count < rows.length;
  for (const checkbox of $$('[data-select-track]')) checkbox.checked = selectedTrackIds.has(rows[Number(checkbox.dataset.selectTrack)]?.id);
  for (const control of $$('[data-needs-selection]')) control.disabled = !count;
  const removeSelection = $('[data-needs-library-selection]', content);
  if (removeSelection) removeSelection.disabled = !selectedLibraryTracks().length;
  for (const control of $$('[data-selection-step]')) {
    const step = Number(control.dataset.selectionStep);
    control.disabled = !rows.some((track, index) => selectedTrackIds.has(track.id) && rows[index + step] &&
      !selectedTrackIds.has(rows[index + step].id));
  }
}
function selectTrack(index, checked, extend) {
  if (!rows[index]) return;
  const anchor = extend && rows[selectionAnchor] ? selectionAnchor : index;
  for (const track of rows.slice(Math.min(index, anchor), Math.max(index, anchor) + 1)) {
    if (checked) selectedTrackIds.add(track.id);
    else selectedTrackIds.delete(track.id);
  }
  selectionAnchor = index;
  updateSelectionControls();
}
function resetSelection() {
  selectionMode = false;
  selectionAnchor = -1;
  selectedTrackIds.clear();
}
content.addEventListener('keydown', event => {
  const checkbox = event.target;
  if (!event.shiftKey || event.code !== 'Space' || checkbox.dataset?.selectTrack === undefined) return;
  event.preventDefault();
  if (!event.repeat) selectTrack(Number(checkbox.dataset.selectTrack), !checkbox.checked, true);
});
function cards(groups, action, columns = 'auto') {
  const layout = columns === 'auto' ? '' : ' data-album-columns style="--album-columns:' + columns + '"';
  return '<div class="card-grid"' + layout + '>' + groups.map(({ id, title, caption, track, portrait }) => {
    const url = portrait?.cover || trackArtwork(track);
    const button = '<button class="card" data-action="' + action + '" ' + key(id) + '>' +
      '<span class="card-art cover' + (portrait ? ' portrait-art' : '') + '">' +
      (url ? (portrait ? '<img alt="" data-artist-portrait src="' + esc(url) + '">' :
        trackCoverImage(track, url)) : icon('disc-3')) +
      '<span class="card-play">' + icon('play') + '</span></span><strong>' + esc(title) +
      '</strong><small>' + esc(caption) + '</small></button>';
    if (portrait?.attribution || portrait?.adapter === 'hisatri') {
      return '<article class="artist-artwork-card">' + button + '<div class="artwork-credit">' +
        (portrait.attribution ? portraitCredit(portrait) : esc(configuredCoverCredit())) + '</div></article>';
    }
    return button;
  }).join('') + '</div>';
}
function normalizeAlbumGridColumns(input) {
  const columns = value => albumGridChoices.includes(value) ? value : 'auto';
  return { catalog: columns(input?.catalog), artist: columns(input?.artist) };
}
function albumGridControl(section) {
  const label = section === 'catalog' ? t('专辑网格列数', 'Album grid columns') : t('艺人专辑网格列数', 'Artist album grid columns');
  const selected = state.settings.albumGridColumns[section];
  return '<label class="album-grid-control">' + label + '<select data-album-grid="' + section + '">' +
    albumGridChoices.map(value => '<option value="' + value + '"' + (selected === value ? ' selected' : '') + '>' +
      (value === 'auto' ? t('自动', 'Automatic') : value) + '</option>').join('') + '</select></label>';
}
function artistAlbumMarkup(tracks, artist) {
  const keys = new Set(tracks.filter(featuredAlbum).map(albumKey));
  const identity = artistIdentity(artist);
  const entries = [...groupTracks('album')].filter(([id, songs]) => keys.has(id) ||
    songs.some(song => explicitAlbumArtists(song).some(name => artistIdentity(name) === identity)));
  if (!entries.length) return '';
  const albums = sortGroupEntries(entries, 'name', undefined, 'album').map(([id, songs]) => ({
    id, title: groupLabel('album', id, songs), caption: [trackCount(songs.length), albumArtistForTrack(songs[0])].filter(Boolean).join(' · '),
    track: albumArtworkTrack(songs) || songs.find(trackArtwork) || songs[0],
  }));
  return '<section class="section" aria-labelledby="artist-albums-heading"><div class="section-head"><h2 id="artist-albums-heading">' +
    t('专辑', 'Albums') + '</h2>' + albumGridControl('artist') + '</div>' +
    cards(albums, 'artist-album', state.settings.albumGridColumns.artist) + '</section>';
}
function empty(glyph, text, actions = '') {
  return '<div class="empty">' + icon(glyph) + '<strong>' + esc(text) + '</strong>' + actions + '</div>';
}
function head(title, description = '', actions = '', descriptionLinks = '') {
  return '<header class="page-head"><h1>' + esc(title) + '</h1>' +
    (description || descriptionLinks ? '<p>' + [esc(description), descriptionLinks].filter(Boolean).join(' · ') + '</p>' : '') +
    (actions ? '<div class="actions">' + actions + '</div>' : '') + '</header>';
}
function statTracks() {
  const seen = new Set();
  const direct = state.directRecent.filter(({ id }) => !state.settings.hiddenLibrarySources.has(id.split(':', 1)[0]));
  const recent = direct.length ? [...direct, ...state.history].sort((a, b) => b.at - a.at) : state.history;
  return recent.map(item => find(item.id)).filter(track => {
    if (!track || seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
}
const genreKey = name => 'g:' + name.toLowerCase();
function genresForTrack(track) {
  return classifyGenres(track?.genres);
}

function genreKeys(track) {
  const names = genresForTrack(track);
  return names.length ? names.map(genreKey) : ['missing'];
}
function artistsForTrack(track) {
  const artist = track?.artist;
  if (typeof artist !== 'string' || !artist) return [];
  if (track.artistIsFallback) return [artist];
  const { separators, exceptions } = state.settings.artistRules;
  const names = normalizeArtists(track.artistNames);
  if (!names.length) return separators.length ? classifyArtists(artist) : [artist];
  const display = normalizeArtists(artist)[0];
  if (exceptions.some(name => name.toLowerCase() === display?.toLowerCase())) return [artist];
  if (separators.length) {
    const custom = classifyArtists(artist);
    if (custom.length !== 1 || custom[0] !== display) return custom;
  }
  return names;
}
function artistKeys(track) {
  const artists = artistsForTrack(track);
  return artists.length ? artists : ['未知艺人'];
}
const albumCreditPrefix = 'album-credit:';
function artistIdentity(name) {
  return name.normalize('NFC').toLowerCase();
}
function explicitAlbumArtists(track) {
  if (!track.album || track.albumIsFallback) return [];
  return classifyArtists(normalizeAlbumArtist(track.albumArtist));
}
function albumArtistLinks(tracks) {
  return normalizeArtists(tracks.flatMap(explicitAlbumArtists)).map(artist =>
    '<a class="album-artist-link" data-album-artist="' + esc(artist) + '" href="#' +
    esc(encodeURIComponent('artist/' + artist)) + '">' + esc(artist) + '</a>').join(' · ');
}
function albumArtistForTrack(track) {
  if (!track?.album || track.albumIsFallback) return;
  const explicit = normalizeAlbumArtist(track.albumArtist);
  if (explicit) return explicit;
  if (state.settings.albumArtistFallback && !track.artistIsFallback && track.artist !== '未知艺人') {
    return normalizeAlbumArtist(track.artist);
  }
}
function albumKey(track) {
  const title = typeof track.album === 'string' && track.album ? track.album : '未知专辑';
  const artist = albumArtistForTrack(track);
  return artist || title.startsWith(albumCreditPrefix)
    ? albumCreditPrefix + JSON.stringify([title, artist?.normalize('NFC').toLowerCase() || '']) : title;
}
function albumNameFromKey(key) {
  if (key.startsWith(albumCreditPrefix)) {
    try {
      const pair = JSON.parse(key.slice(albumCreditPrefix.length));
      if (Array.isArray(pair) && typeof pair[0] === 'string') return pair[0];
    } catch { /* Older album titles may contain the separator. */ }
  }
  return key;
}
function groupTracks(by, tracks = library()) {
  const groups = new Map();
  for (const track of tracks) {
    const keys = by === 'genre' ? genreKeys(track) : by === 'artist' ? artistKeys(track) : [albumKey(track)];
    for (const key of keys) {
      const list = groups.get(key) || [];
      list.push(track);
      groups.set(key, list);
    }
  }
  return groups;
}
function playbackStats() {
  const { playsToday, playsThisWeek, tracksPlayed } = playbackStatistics(state.history);
  return '<section class="section" aria-labelledby="playback-statistics-heading"><div class="section-head">' +
    '<h2 id="playback-statistics-heading">' + t('播放统计', 'Playback Statistics') +
    '</h2><button data-nav="timeline">' + t('播放时光机', 'Playback Timeline') + '</button></div>' +
    '<dl class="playback-stats">' + [[playsToday, t('今日播放次数', 'Plays today')],
      [playsThisWeek, t('近 7 天播放次数', 'Plays in the last 7 days')], [tracksPlayed, t('历史已播放歌曲', 'Unique tracks played')]]
      .map(([value, label]) => '<div><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>').join('') + '</dl></section>';
}
function playbackTimeline() {
  const count = state.history.length;
  const heading = head(t('播放时光机', 'Playback Timeline'),
    t('{count} 条播放记录', count === 1 ? '{count} play' : '{count} plays', { count }),
    btn(t('最近播放', 'Recently Played'), 'history', 'recent-plays') +
    (count ? btn(t('导出播放记录', 'Export Playback History'), 'download', 'export-history') : '') +
    btn(t('导入播放记录', 'Import Playback History'), 'upload', 'import-history'));
  if (!count) return heading + empty('history', t('播放歌曲后，记录会显示在这里', 'Playback history will appear here'));

  const tracks = new Map(allTracks().map(track => [track.id, track]));
  const dayFormat = new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'full' });
  const timeFormat = new Intl.DateTimeFormat(getLanguage(), { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  const days = new Map();
  for (const { id, at } of state.history) {
    const day = dayFormat.format(at);
    if (!days.has(day)) days.set(day, []);
    const track = tracks.get(id);
    const label = track ? '<button class="track-main" data-action="play-history" ' + key(id) + '>' +
      cover(track) + '<span class="track-details"><span class="track-name">' + esc(track.title) +
      '</span><span class="track-artist">' + esc(trackFieldLabel(track, 'artist')) + '</span></span></button>' :
      '<span class="hint">' + t('曲目不可用', 'Track unavailable') + '</span>';
    days.get(day).push('<li><time datetime="' + new Date(at).toISOString() + '">' + timeFormat.format(at) + '</time>' + label + '</li>');
  }
  return heading + [...days].map(([day, entries]) => '<section class="section"><div class="section-head"><h2>' +
    esc(day) + '</h2><span class="hint">' + t('{count} 次播放', entries.length === 1 ? '{count} play' : '{count} plays', { count: entries.length }) +
    '</span></div><ol class="playback-timeline">' +
    entries.join('') + '</ol></section>').join('');
}
function featuredAlbum(track) {
  return albumForLookup(track) ? track.album : '';
}
function recommendedMusic(tracks) {
  const saved = tracks.filter(track => track.provider !== 'demo');
  const choice = saved.length ? saved : tracks;
  const favorites = new Set(state.favorites);
  const byTrack = new Map();
  const groups = new Map();
  for (const track of choice) {
    const album = featuredAlbum(track);
    const id = (album ? 'album:' + albumKey(track) : 'track:' + track.id);
    let group = groups.get(id);
    if (!group) {
      group = { album, track, plays: 0, lastPlayed: 0, favorites: 0 };
      groups.set(id, group);
    } else if (!trackArtwork(group.track) && trackArtwork(track)) group.track = track;
    if (favorites.has(track.id)) group.favorites++;
    byTrack.set(track.id, group);
  }
  for (const { id, at } of state.history) {
    const group = byTrack.get(id);
    if (!group) continue;
    group.plays++;
    group.lastPlayed = Math.max(group.lastPlayed, at);
  }
  const featured = [...groups.values()].sort((a, b) =>
    b.plays - a.plays || b.lastPlayed - a.lastPlayed || b.favorites - a.favorites).slice(0, 4);
  return { choice, featured };
}
function directNavidromeSources() {
  return sources.filter(source => source.type === 'navidrome' && !state.settings.hiddenLibrarySources.has(source.id) &&
    !state.scanSnapshots[source.id]?.length).slice(0, 4);
}
function directAlbumRecommendations() {
  const recommendations = directNavidromeSources().flatMap(source => {
    let entry = navidromeHomeAlbums.get(source.id);
    if (!entry) {
      entry = { albums: [] };
      navidromeHomeAlbums.set(source.id, entry);
      void api(sourceEndpoint(source.id, 'list') + '?path=home-recommendations').then(({ items }) => {
        if (navidromeHomeAlbums.get(source.id) !== entry || !Array.isArray(items)) return;
        entry.albums = items.filter(item => item?.folder && typeof item.name === 'string' && typeof item.path === 'string');
        if (route === 'home' && entry.albums.length) render();
      }).catch(() => {});
    }
    return entry.albums.map(album => ({ id: source.id + ':' + album.path, title: album.name, caption: album.artist || source.name,
      track: { cover: album.cover } }));
  }).slice(0, 4);
  return recommendations.length ? '<section class="section" aria-labelledby="direct-recommendations-heading"><div class="section-head">' +
    '<h2 id="direct-recommendations-heading">' + t('服务器推荐专辑', 'Recommended Server Albums') + '</h2></div>' +
    cards(recommendations, 'direct-source-album') + '</section>' : '';
}
function home() {
  const tracks = library();
  const recent = statTracks().filter(track => !state.removedLibraryTracks.has(track.id) &&
    !state.settings.hiddenLibrarySources.has(librarySourceId(track)));
  const { choice, featured } = recommendedMusic(tracks);
  const onlyAlbums = featured.every(entry => entry.album);
  const featuredGroups = featured.map(({ album, track }) => ({ id: track.id, title: album || track.title,
    caption: (album && albumArtistForTrack(track)) || trackFieldLabel(track, 'artist'), track }));
  return '<section class="hero"><div class="eyebrow">' + icon('disc-3') +
    ' GROOVEBOX</div><h1>' + t('你的云端唱片室', 'Your Cloud Music Library') + '</h1><p>' +
    t('连接网盘，随时播放你的音乐收藏。', 'Connect a cloud drive to play your music collection anywhere.') + '</p><div class="actions">' +
    (tracks.length ? btn(t('立即播放', 'Play Now'), 'play', 'play-library', '', true) :
      btn(t('连接网盘', 'Connect Cloud Drive'), 'cloud', 'open-sources', '', true)) +
    btn(t('导入音乐', 'Import Music'), 'folder-up', 'import-files') + '</div></section>' +
    (featured.length ? '<section class="section" aria-labelledby="featured-heading"><div class="section-head"><h2 id="featured-heading">' +
      (onlyAlbums ? t('精选专辑', 'Featured Albums') : t('推荐音乐', 'Recommended Music')) +
      '</h2><button data-nav="' + (onlyAlbums ? 'albums' : 'songs') + '">' + t('查看全部', 'View All') + '</button></div>' +
      cards(featuredGroups, 'featured') + '</section>' : '') +
    directAlbumRecommendations() +
    '<section class="section"><div class="section-head"><h2>' + (recent.length ? t('最近播放', 'Recently Played') : t('推荐歌曲', 'Suggested Tracks')) +
    '</h2><button data-nav="' + (recent.length ? 'history' : 'songs') + '">' + t('查看全部', 'View All') + '</button></div>' +
    trackRows(recent.length ? recent.slice(0, 5) : choice.slice(0, 6), { playList: recent.length ? recent : choice }) + '</section>' + playbackStats();
}
function matches(track, text) {
  return [track.title, track.artist, track.album, track.albumArtist, track.path, trackFieldLabel(track, 'artist'), trackFieldLabel(track, 'album'),
    ...artistsForTrack(track), ...genresForTrack(track)]
    .some(field => String(field || '').normalize('NFC').toLocaleLowerCase().includes(text));
}
function playlistSearch() {
  const label = t('搜索此歌单', 'Search this playlist');
  return '<div class="download-filters"><label>' + label + '<input id="playlist-search" type="search" aria-label="' +
    label + '" value="' + esc(playlistQuery) + '"></label></div>';
}
function playlistContexts(playlist, entries, revision) {
  if (!state.settings.rememberPlaylistPosition) return;
  const orderedRevision = typeof revision === 'string' && /^[\w-]{24}$/.test(revision) ? revision : undefined;
  return playlistOccurrences(entries, orderedRevision).map(occurrence => occurrence && { playlist, occurrence });
}
function newLocalPlaylistSlot() {
  return crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(36)).join('-');
}
function readLocalPlaylistSlots(value) {
  const stored = new Map((Array.isArray(value) ? value : []).filter(entry => Array.isArray(entry) &&
    typeof entry[0] === 'string' && Array.isArray(entry[1])));
  const output = new Map();
  for (const { id, tracks } of state.playlists) {
    const slots = stored.get(id);
    if (!slots?.length || !Array.isArray(tracks)) continue;
    const unpacked = tracks.map(trackId => ({ trackId }));
    for (const entry of slots) {
      if (!Array.isArray(entry)) continue;
      const [index, trackId, slotId] = entry;
      if (Number.isSafeInteger(index) && index >= 0 && typeof trackId === 'string' && unpacked[index]?.trackId === trackId &&
          typeof slotId === 'string' && /^[\w-]{1,64}$/.test(slotId)) unpacked[index].slotId = slotId;
    }
    output.set(id, unpacked);
  }
  return output;
}
function savedLocalPlaylistSlots(playlists = state.playlists) {
  return playlists.flatMap(({ id, tracks }) => {
    const slots = localPlaylistSlots.get(id);
    if (!slots || slots.length > tracks.length || slots.some((slot, index) => slot.trackId !== tracks[index])) return [];
    const duplicates = slots.flatMap(({ trackId, slotId }, index) => slotId ? [[index, trackId, slotId]] : []);
    return duplicates.length ? [[id, duplicates]] : [];
  });
}
function slotsForLocalPlaylist(playlist) {
  const previous = localPlaylistSlots.get(playlist.id) || [];
  const slots = reconcilePlaylistSlots(previous, playlist.tracks, newLocalPlaylistSlot);
  if (slots.some(slot => slot.slotId)) localPlaylistSlots.set(playlist.id, slots);
  else localPlaylistSlots.delete(playlist.id);
  return slots;
}
function savedPlaylistQueue(queue) {
  const contexts = player.playlistQueueSnapshot();
  if (!contexts) return;
  return { playlist: contexts.find(Boolean).playlist, occurrences: contexts.map((context, index) => {
    if (!context) return null;
    return context.occurrence === trackOccurrence(queue[index]) ? true : context.occurrence;
  }) };
}
function localPlaylistContexts(playlist, tracks) {
  if (!state.settings.rememberPlaylistPosition) return;
  const slots = slotsForLocalPlaylist(playlist);
  const contexts = playlistContexts('playlist/' + playlist.id, slots);
  const byTrack = new Map();
  for (const [index, slot] of slots.entries()) {
    if (!byTrack.has(slot.trackId)) byTrack.set(slot.trackId, []);
    byTrack.get(slot.trackId).push(contexts[index]);
  }
  const counts = new Map();
  return tracks.map(track => {
    const offset = counts.get(track.id) || 0;
    counts.set(track.id, offset + 1);
    return byTrack.get(track.id)?.[offset];
  });
}
function filterLocalPlaylistTracks(playlist, retain) {
  const slots = localPlaylistSlots.has(playlist.id) ? slotsForLocalPlaylist(playlist) : undefined;
  playlist.tracks = playlist.tracks.filter(retain);
  if (slots) localPlaylistSlots.set(playlist.id, slots.filter(slot => retain(slot.trackId)));
}
function playlistTrackRows(tracks, options = {}) {
  const text = playlistQuery.trim().normalize('NFC').toLocaleLowerCase();
  if (!text) return trackRows(tracks, options);
  const playIndices = [];
  const filtered = tracks.filter((track, index) => {
    if (!matches(track, text)) return false;
    playIndices.push(index);
    return true;
  });
  return trackRows(filtered, { ...options, playList: tracks, playIndices,
    emptyMessage: t('此歌单没有匹配的歌曲', 'No matching tracks in this playlist') });
}
function playlistLocationMarkup() {
  return btn(t('定位当前歌曲', 'Locate Current Track'), 'locate-fixed', 'locate-playing', 'data-playlist-locate disabled');
}
function scrollWorkspaceToTop() {
  $('.workspace').scrollTop = 0;
}
function folderViewIsOpen() {
  if (route.startsWith('local-folder/')) return importedLocalFolders().has(route.slice('local-folder/'.length));
  return cloud && route === 'source/' + cloud.id && !cloud.loading && !cloud.error &&
    cloud.trail[1]?.path !== 'playlists' && !cloud.serverOrder;
}
function catalogViewIsOpen() {
  return ['songs', 'albums', 'artists', 'genres', 'favorites'].includes(route) ||
    /^(album|artist|genre|playlist|server-playlist)\//.test(route);
}
function importedLocalFolders() {
  if (indexedLocals === locals) return localFolders;
  indexedLocals = locals;
  localFolders = new Map();
  for (const track of locals) {
    const parts = track.path?.split('/').slice(0, -1);
    if (!parts?.length) continue;
    let parent;
    for (const name of parts) {
      const path = parent ? parent.path + '/' + name : name;
      let folder = localFolders.get(path);
      if (!folder) {
        folder = { path, name, parent, children: [], tracks: [] };
        localFolders.set(path, folder);
        parent?.children.push(folder);
      }
      parent = folder;
    }
    parent.tracks.push(track);
  }
  return localFolders;
}
function localFolderParents(folder) {
  const parents = [];
  for (let parent = folder?.parent; parent; parent = parent.parent) parents.unshift(parent);
  return parents;
}
function folderButtons(entries) {
  return '<div class="folder-list">' + entries.map(({ path, name, description, source }) =>
    '<button class="folder-row" ' + (source ? 'data-action="open-indexed-folder" data-source="' + esc(source) + '" ' + key(path) :
      'data-nav="' + esc('local-folder/' + path) + '"') + '>' + icon('folder') + '<span><strong>' + esc(name) +
      '</strong>' + (description ? '<small>' + esc(description) + '</small>' : '') + '</span>' + icon('chevron-right') + '</button>').join('') + '</div>';
}
function searchFolderResults() {
  if (!query) return [];
  const normalized = text => text.normalize('NFC').toLocaleLowerCase();
  const text = normalized(query);
  const match = (name, path) => normalized(name).includes(text) || normalized(path).includes(text);
  const results = [];
  if (!state.settings.hiddenLibrarySources.has('local')) {
    for (const folder of importedLocalFolders().values()) {
      if (!match(folder.name, folder.path)) continue;
      const description = [t('本地导入', 'Local Imports'), ...localFolderParents(folder).map(parent => parent.name)].join(' / ');
      results.push({ ...folder, description });
    }
  }
  for (const source of cloudSources()) {
    if (!sourceVisibleInCatalog(source.id)) continue;
    if (cloudProviderIds.includes(source.id) && !cloudStatus[source.id].connected) continue;
    const label = cloudProviderIds.includes(source.id) ? providerLabel(source.id) : source.name;
    for (const folder of indexedCloudFolders(state.scanSnapshots[source.id])) {
      if (!match(folder.name, folder.trail.map(entry => entry.name).join('/'))) continue;
      results.push({ path: folder.path, name: folder.name, source: source.id,
        description: [label, ...folder.trail.slice(0, -1).map(parent => parent.name)].join(' / ') });
    }
  }
  return results.sort((first, second) => textOrder(first.name, second.name) || textOrder(first.description, second.description));
}
function searchGenreMarkup() {
  if (!query) return '';
  const text = query.normalize('NFC').toLocaleLowerCase();
  const matches = [...groupTracks('genre')].map(([id, tracks]) => ({
    id, title: groupLabel('genre', id, tracks), count: tracks.length,
  })).filter(({ title }) => title.normalize('NFC').toLocaleLowerCase().includes(text));
  if (!matches.length) return '';
  const buttons = matches.sort((first, second) => textOrder(first.title, second.title)).map(({ id, title, count }) =>
    btn(title + ' · ' + trackCount(count), 'list-music', 'search-genre', key(id))).join('');
  return '<section class="section search-genre-results" aria-labelledby="genre-search-heading"><div class="section-head">' +
    '<h2 id="genre-search-heading">' + t('风格', 'Genres') + '</h2></div><div class="actions">' + buttons + '</div></section>';
}
function downloadedControls() {
  const tracks = allTracks().filter(audioOnDevice);
  const options = (field, label) => {
    const groups = groupTracks(field, field === 'genre' ? tracks : tracks.filter(track => typeof track[field] === 'string' && track[field]));
    const labelForGroup = (value, entries) => [groupLabel(field, value, entries), field === 'album' && albumArtistForTrack(entries[0])]
      .filter(Boolean).join(' · ');
    return '<label>' + label + '<select data-download-filter="' + field + '" aria-label="' + label + '">' +
      '<option value="">' + t('全部', 'All') + '</option>' + [...groups].sort(([a, first], [b, second]) =>
        textOrder(labelForGroup(a, first), labelForGroup(b, second)))
        .map(([value, entries]) => '<option value="' + esc(value) + '"' + (downloadFilters[field] === value ? ' selected' : '') + '>' +
          esc(labelForGroup(value, entries)) + '</option>').join('') + '</select></label>';
  };
  const types = { all: t('全部', 'All'), local: t('本地导入', 'Local Imports'), cached: t('离线缓存', 'Offline Copies') };
  const category = t('分类', 'Category');
  return '<div class="download-filters"><label>' + t('搜索', 'Search') + '<input id="download-search" type="search" aria-label="' +
    t('搜索已下载音乐', 'Search downloaded music') + '" placeholder="' + t('搜索歌曲、艺人或专辑', 'Search tracks, artists, or albums') + '" value="' +
    esc(downloadFilters.query) + '"></label><label>' + category + '<select data-download-filter="category" aria-label="' + category + '">' +
    Object.entries(types).map(([value, label]) => '<option value="' + value + '"' + (downloadFilters.category === value ? ' selected' : '') + '>' + label + '</option>').join('') +
    '</select></label>' + options('artist', t('艺人', 'Artist')) + options('album', t('专辑', 'Album')) +
    options('genre', t('流派', 'Genre')) + '</div>';
}
function albumForLookup(track) {
  if (typeof track?.album !== 'string') return '';
  const album = track.album.trim();
  if (!album || track.albumIsFallback || ['未知专辑', '本地音乐', '单曲'].includes(album)) return '';
  if (track.albumIsFallback === undefined && !track.embeddedTags?.album && !['local', 'demo'].includes(track.provider)) {
    const source = cloudSources().find(value => track.id?.startsWith(value.id + ':'));
    if (!source || album === source.name) return '';
  }
  return album;
}
const albumCreditForLookup = track => normalizeAlbumArtist(track?.albumArtist) || track?.artist;
function artworkSettings(settings) {
  const legacyAuto = typeof settings?.onlineCover === 'boolean' ? settings.onlineCover : undefined;
  return {
    onlineCover: legacyAuto ?? defaults.onlineCover,
    artistImageEngine: typeof settings?.artistImageEngine === 'boolean' ? settings.artistImageEngine : legacyAuto ?? defaults.artistImageEngine,
    artistAlbumCoverFallback: typeof settings?.artistAlbumCoverFallback === 'boolean' ? settings.artistAlbumCoverFallback : defaults.artistAlbumCoverFallback,
  };
}

function stopAutomaticArtwork(requests) {
  for (const [id, request] of requests) {
    if (request.manual) continue;
    request.controller.abort();
    requests.delete(id);
  }
}

function readCustomCoverRecords() {
  try {
    const items = JSON.parse(localStorage.getItem(customCoverStorage));
    if (!Array.isArray(items)) return new Map();
    return new Map(items.slice(-200).filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' &&
      entry[0].length <= 900 && ['album', 'artist'].includes(entry[1]?.scope) &&
      typeof entry[1].revision === 'string' && customCoverPath.test(entry[1].cover)));
  } catch { return new Map(); }
}

function saveCustomCoverRecords() {
  try { localStorage.setItem(customCoverStorage, JSON.stringify([...customCoverRecords])); }
  catch { /* Online cover art can still be used for this session. */ }
}

const customArtworkText = value => typeof value === 'string' && value.length <= 200 &&
  !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : '';
const customArtworkIdentity = value => value.normalize('NFC').toLowerCase();
function customArtistKey(artist) {
  const name = customArtworkText(artist);
  return name && name !== '未知艺人' ? JSON.stringify(['artist', customArtworkIdentity(name)]) : '';
}

function customAlbumMetadata(track) {
  const album = customArtworkText(albumForLookup(track));
  const artist = customArtworkText(normalizeAlbumArtist(track?.albumArtist) || (!track?.artistIsFallback && track?.artist));
  return { album, artist: artist === '未知艺人' ? '' : artist };
}

function customAlbumKey(track) {
  const { artist, album } = customAlbumMetadata(track);
  return album ? JSON.stringify(['album', customArtworkIdentity(album), customArtworkIdentity(artist)]) : '';
}

function selectedCustomCover(scope, key) {
  const record = customCoverRecords.get(key);
  return customCoverStatus?.[scope] && record?.revision === customCoverStatus.revision &&
    record.scope === scope && !failedCovers.has(record.cover) ? record.cover : '';
}

function offlineCustomCover(scope, key, allowFailed = false) {
  if (!customCoverStatusErrorAt && navigator.onLine) return;
  const record = customCoverRecords.get(key);
  if (record?.scope === scope && (allowFailed || !failedCovers.has(record.cover)) &&
      (!customCoverStatus || customCoverStatus[scope] && record.revision === customCoverStatus.revision)) return record;
}

function customAlbumArtwork(track) {
  return selectedCustomCover('album', customAlbumKey(track));
}

function customAlbumArtworkIdentity(track) {
  const key = customAlbumKey(track);
  return selectedCustomCover('album', key) ? 'custom-artwork:' + customCoverStatus.revision + ':' + key : '';
}

function stopCustomArtwork(predicate = () => true) {
  for (const [id, job] of customCoverJobs) {
    if (!predicate(job)) continue;
    job.controller.abort();
    customCoverJobs.delete(id);
  }
}

function applyCustomCoverStatus(payload) {
  const value = payload?.artwork;
  if (!value || !['none', 'hisatri'].includes(value.adapter) ||
      typeof value.revision !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(value.revision) ||
      typeof value.album !== 'boolean' || typeof value.artist !== 'boolean' ||
      (value.adapter === 'none' && (value.album || value.artist))) {
    throw new InterfaceError('无法读取封面接口设置。', 'Could not read the cover API settings.');
  }
  const next = { adapter: value.adapter, revision: value.revision, album: value.album, artist: value.artist };
  const wasConfigured = Boolean(customCoverStatus);
  const changed = !customCoverStatus || Object.keys(next).some(key => next[key] !== customCoverStatus[key]);
  const recovered = Boolean(customCoverStatusErrorAt || offlineCustomFailures.size);
  for (const url of offlineCustomFailures) failedCovers.delete(url);
  offlineCustomFailures.clear();
  customCoverStatus = next;
  customCoverStatusCheckedAt = Date.now();
  customCoverStatusErrorAt = 0;
  if (changed) {
    stopCustomArtwork();
    customCoverRetryAt.clear();
    customCoverRecoveryAt.clear();
    let removed = false;
    for (const [key, record] of customCoverRecords) {
      if (record.revision === next.revision && next[record.scope]) continue;
      customCoverRecords.delete(key);
      removed = true;
    }
    if (removed) saveCustomCoverRecords();
  }
  if (ready && (recovered || changed && (wasConfigured || next.album || next.artist))) {
    mediaId = undefined;
    refreshCurrent();
    refreshCurrentArtwork();
  }
  return next;
}

function refreshCustomCoverStatus(force = false, join = false) {
  if (customCoverStatusJob && (!force || join)) return customCoverStatusJob;
  if (!force && customCoverStatusErrorAt && Date.now() - customCoverStatusErrorAt < 15000) return Promise.resolve(undefined);
  if (!force && customCoverStatus && Date.now() - customCoverStatusCheckedAt < 15000) return Promise.resolve(customCoverStatus);
  if (force) customCoverStatusController?.abort();
  const sequence = ++customCoverStatusSequence;
  const controller = customCoverStatusController = new AbortController();
  const job = api(metadataArtworkPath + 'status', { cache: 'no-store',
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) }).then(payload => {
    if (sequence !== customCoverStatusSequence) return customCoverStatusJob === job ? customCoverStatus : customCoverStatusJob || customCoverStatus;
    return applyCustomCoverStatus(payload);
  }).catch(() => {
    if (sequence !== customCoverStatusSequence) return customCoverStatusJob === job ? customCoverStatus : customCoverStatusJob || customCoverStatus;
    customCoverStatusErrorAt = Date.now();
    if (ready) { mediaId = undefined; refreshCurrent(); }
    return undefined;
  }).finally(() => {
    if (customCoverStatusJob === job) {
      customCoverStatusJob = undefined;
      customCoverStatusController = undefined;
    }
  });
  customCoverStatusJob = job;
  return job;
}

function refreshCurrentArtwork(failed, includePlaying = true) {
  if (route.startsWith('artist/')) void matchArtistPortrait(false, failed);
  if (route.startsWith('album/')) void matchAlbumArtwork(false, failed);
  const { track, playing } = player.getState();
  if (includePlaying && track && (playing || failed)) void matchOnlineCover(track, false, { playing: true, failed });
}

function currentPlayerArtworkTrack(track) {
  return Boolean(track?.id && player.getState().track?.id === track.id);
}

async function queryCustomArtwork(scope, key, metadata, { manual = false, valid, playing = false } = {}) {
  let status = await refreshCustomCoverStatus();
  if (!status || !valid()) return 'stopped';
  if (!status[scope]) {
    status = await refreshCustomCoverStatus(true, true);
    if (!status || !valid()) return 'stopped';
    if (!status[scope]) return 'disabled';
  }
  if (!key) return 'stopped';
  if (selectedCustomCover(scope, key)) return 'covered';
  if (customCoverJobs.has(key) || (!manual && ((customCoverRetryAt.get(key) || 0) > Date.now() || customCoverJobs.size >= 3))) return 'stopped';
  const controller = new AbortController();
  const job = { controller, valid, scope, route, playing };
  customCoverJobs.set(key, job);
  try {
    const response = await fetch(metadataArtworkPath + 'cover', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Metadata-Revision': status.revision },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      body: JSON.stringify({ scope, ...metadata }) });
    const result = await response.json();
    if (!valid() || controller.signal.aborted || customCoverJobs.get(key) !== job ||
        customCoverStatus?.revision !== status.revision || !customCoverStatus[scope]) return 'stopped';
    if (!response.ok) throw Object.assign(new Error('Cover lookup failed'),
      { status: response.status, code: result?.code, retryAfter: response.headers.get('retry-after') });
    if (result?.adapter !== 'hisatri' || result.scope !== scope || result.revision !== status.revision ||
        typeof result.cover !== 'string' || !customCoverPath.test(result.cover) || failedCovers.has(result.cover)) {
      throw new Error('Invalid cover response');
    }
    customCoverRecords.delete(key);
    customCoverRecords.set(key, { scope, revision: status.revision, cover: result.cover });
    if (customCoverRecords.size > 200) customCoverRecords.delete(customCoverRecords.keys().next().value);
    customCoverRetryAt.delete(key);
    saveCustomCoverRecords();
    mediaId = undefined;
    refreshCurrent();
    if (manual) announce(t('已显示自定义封面。', 'Custom artwork added.'));
    return 'covered';
  } catch (error) {
    if (!valid() || controller.signal.aborted) return 'stopped';
    if (error.code === 'metadata_config_changed') {
      void refreshCustomCoverStatus(true, true);
      return 'stopped';
    }
    const miss = error.code === 'metadata_not_found';
    const delay = miss ? 600 : error.status === 429 ? Math.min(600, Math.max(1, Number(error.retryAfter) || 60)) : 60;
    customCoverRetryAt.delete(key);
    customCoverRetryAt.set(key, Date.now() + delay * 1000);
    if (customCoverRetryAt.size > 200) customCoverRetryAt.delete(customCoverRetryAt.keys().next().value);
    if (manual) announce(miss ? t('自定义封面接口没有匹配图片。', 'The custom cover API found no matching artwork.') :
      t('无法读取自定义封面。', 'Could not load artwork from the custom cover API.'));
    return 'stopped';
  } finally {
    if (customCoverJobs.get(key) === job) customCoverJobs.delete(key);
    if (route === job.route && (route === 'albums' || route === 'artists')) render();
  }
}

function normalizeArtworkArtists(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(name => typeof name === 'string' && name.trim() && name.length <= 200)
    .map(artistIdentity))].slice(-500);
}
function automaticArtworkBlocked(artistName) {
  return typeof artistName === 'string' && state.settings.blockedArtworkArtists.includes(artistIdentity(artistName));
}
function automaticAlbumArtworkBlocked(track) {
  const artist = albumCreditForLookup(track);
  return automaticArtworkBlocked(artist) ||
    (typeof artist === 'string' && classifyArtists(artist).some(automaticArtworkBlocked));
}
function artworkKey(track, name = albumCreditForLookup(track)) {
  if (typeof name !== 'string') return '';
  const artist = name.trim();
  const album = albumForLookup(track);
  if (!artist || !album || artist === '未知艺人') return '';
  return JSON.stringify([artist.normalize('NFC').toLocaleLowerCase(), album.normalize('NFC').toLocaleLowerCase()]);
}
function originalArtwork(track) {
  return safeImage(track?.cover) && !failedCovers.has(track.cover) ? track.cover : '';
}
let offlineArtworkRender;
function refreshOfflineArtwork() {
  if (offlineArtworkRender !== undefined) return;
  offlineArtworkRender = requestAnimationFrame(() => {
    offlineArtworkRender = undefined;
    mediaId = undefined;
    refreshCurrent();
  });
}
function folderArtwork(track) {
  const source = authenticatedFolderCover(track);
  if (!source) return '';
  const cached = offlineFolderCover(track.id, source, refreshOfflineArtwork);
  if (cached === null) return '';
  if (cached && !failedCovers.has(cached)) return cached;
  return failedCovers.has(source) ? '' : source;
}
const playCoverSamples = new WeakMap();
function samplePlayCover(image) {
  const cached = playCoverSamples.get(image);
  if (cached !== undefined) return cached;
  let sample;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 24;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    sample = coverColor(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch { /* Artwork that cannot be sampled uses the selected theme. */ }
  playCoverSamples.set(image, sample || null);
  return sample;
}
function updatePlayButtonCoverColor() {
  const image = $('#player-art img');
  const style = $('#player-toggle').style;
  const sample = state.settings.playButtonCoverColor === true && image?.complete && image.naturalWidth && samplePlayCover(image);
  if (!sample) {
    style.removeProperty('--play-cover-color');
    style.removeProperty('--play-cover-ink');
    return;
  }
  const panel = document.documentElement.style.getPropertyValue('--panel');
  const { background, text } = playButtonColors(sample, panel);
  style.setProperty('--play-cover-color', background);
  style.setProperty('--play-cover-ink', text);
}
$('#player-art').addEventListener('load', updatePlayButtonCoverColor, true);
function trackArtwork(track) {
  const builtIn = originalArtwork(track) || folderArtwork(track);
  if (builtIn) return builtIn;
  const custom = customAlbumArtwork(track);
  const offline = customCoverStatusErrorAt || !navigator.onLine;
  const key = customAlbumKey(track);
  const lastKnown = offlineCustomCover('album', key, true);
  const source = custom || lastKnown?.cover;
  if (source) {
    const identity = custom ? customAlbumArtworkIdentity(track) : 'custom-artwork:' + lastKnown.revision + ':' + key;
    const cached = offlineFolderCover(track.id, identity, refreshOfflineArtwork);
    if (cached === null) return '';
    if (cached) return cached;
    if (!failedCovers.has(source) && (!offline || navigator.serviceWorker?.controller)) return source;
  }
  const online = onlineCovers.get(artworkKey(track));
  return online && !failedCovers.has(online) ? online : '';
}
function albumArtworkTrack(tracks) {
  const original = tracks.find(originalArtwork);
  if (original) return original;
  const folder = tracks.find(folderArtwork);
  if (folder) return folder;
  const first = tracks[0];
  const id = artworkKey(first);
  if (id && tracks.every(track => artworkKey(track) === id)) return first;
  const custom = customCoverStatus?.album && customAlbumKey(first);
  if (custom && tracks.every(track => customAlbumKey(track) === custom)) return first;
}
function matchAlbumArtwork(manual = false, failed) {
  if (route.startsWith('album/')) return matchOnlineCover(albumArtworkTrack(getRouteTracks()), manual, { failed });
}

function hasPrivateAlbumArtwork(track) {
  const source = authenticatedFolderCover(track);
  return originalArtwork(track) || folderArtwork(track) || (source && !failedCovers.has(source));
}

function artworkCanBeLookedUp(track) {
  if (!track || hasPrivateAlbumArtwork(track)) return false;
  return customCoverStatus?.album ? customAlbumKey(track) && !customAlbumArtwork(track) : artworkKey(track) && !trackArtwork(track);
}
document.addEventListener('error', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.isConnected || !image.matches('[data-track-cover], [data-artist-portrait]')) return;
  const url = image.getAttribute('src');
  if (failedCovers.has(url)) return;
  failedCovers.add(url);
  if (failedCovers.size > 500) failedCovers.delete(failedCovers.values().next().value);
  if (customCoverPath.test(url)) {
    void recoverCustomArtwork(url);
    return;
  }
  const current = player.getState().track;
  mediaId = undefined;
  refreshCurrent();
  if (image.hasAttribute('data-artist-portrait')) void matchArtistPortrait();
  if (!artworkPath.test(url)) {
    if (current?.cover === url || current?.folderCover === url) void matchOnlineCover(current, false, { playing: true });
    void matchAlbumArtwork();
  }
}, true);

async function recoverCustomArtwork(url) {
  if (!navigator.onLine || (!customCoverStatus && customCoverStatusErrorAt)) {
    offlineCustomFailures.add(url);
    if (offlineCustomFailures.size > 200) offlineCustomFailures.delete(offlineCustomFailures.values().next().value);
    mediaId = undefined;
    refreshCurrent();
    return;
  }
  const entry = [...customCoverRecords].find(([, record]) => record.cover === url && record.revision === customCoverStatus?.revision);
  if (!entry) return;
  const [key, record] = entry;
  const retry = (customCoverRecoveryAt.get(key) || 0) <= Date.now();
  if (retry) {
    customCoverRecoveryAt.set(key, Date.now() + 60000);
    const status = await refreshCustomCoverStatus(true, true);
    if (status?.revision !== record.revision || !status[record.scope] || customCoverRecords.get(key) !== record) return;
  }
  customCoverRecords.delete(key);
  saveCustomCoverRecords();
  if (!retry) customCoverRetryAt.set(key, Date.now() + 60000);
  else failedCovers.delete(url);
  mediaId = undefined;
  if (!retry) { refreshCurrent(); return; }
  refreshCurrent();
  refreshCurrentArtwork(url);
}

function validPortrait(entry) {
  if (typeof entry?.cover !== 'string' || !portraitPath.test(entry.cover)) return false;
  const credit = entry.attribution;
  if (typeof credit?.name !== 'string' || !credit.name.trim() || credit.name.length > 600 ||
      typeof credit.license !== 'string' || !credit.license.trim() || credit.license.length > 120 ||
      (credit.author !== undefined && (typeof credit.author !== 'string' || credit.author.length > 600))) return false;
  try {
    const source = new URL(credit.url);
    const license = new URL(credit.licenseUrl);
    return source.origin === 'https://commons.wikimedia.org' && source.pathname.startsWith('/wiki/File:') &&
      !source.username && !source.password && !source.search && !source.hash &&
      license.origin === 'https://creativecommons.org' && !license.username && !license.password && !license.search && !license.hash &&
      /^\/(?:licenses\/(?:by|by-sa)|publicdomain\/(?:zero|mark))\/[1-4]\.(?:0|5)\/$/.test(license.pathname);
  } catch { return false; }
}

function portraitCredit({ attribution }) {
  const { name, url, license, licenseUrl, author } = attribution;
  return '<a class="simple-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(name) + '</a>' +
    (author ? ' · ' + esc(author) : '') + ' · <a class="simple-link" href="' + esc(licenseUrl) +
    '" target="_blank" rel="noopener noreferrer">' + esc(license) + '</a>';
}

function artistPortraitTracks(tracks, artist) {
  if (tracks.length) return tracks;
  const identity = artistIdentity(artist.trim());
  return library().filter(track => explicitAlbumArtists(track).some(name => artistIdentity(name) === identity));
}

function invalidateRemoteArtistImages(id) {
  const previous = remoteArtistImages.get(id);
  previous?.controller.abort();
  for (const portrait of previous?.portraits.values() || []) failedCovers.delete(portrait.cover);
  remoteArtistImages.delete(id);
}

async function refreshRemoteArtistIndex(id) {
  await api(sourceEndpoint(id, 'artist-portraits'), { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {});
  invalidateRemoteArtistImages(id);
}

function queueRemoteArtistImages(read) {
  return new Promise(resolve => {
    remoteArtistImageQueue.push({ read, resolve });
    drainRemoteArtistImages();
  });
}

function drainRemoteArtistImages() {
  while (remoteArtistImageRequests < 3 && remoteArtistImageQueue.length) {
    const job = remoteArtistImageQueue.shift();
    remoteArtistImageRequests++;
    void Promise.resolve().then(job.read).finally(() => {
      remoteArtistImageRequests--;
      job.resolve();
      drainRemoteArtistImages();
    });
  }
}

function scheduleRemoteArtistRetry() {
  clearTimeout(remoteArtistRetryTimer);
  if (document.hidden || (route !== 'artists' && !route.startsWith('artist/'))) return;
  const next = Math.min(...[...remoteArtistImages.values()]
    .filter(entry => !entry.loaded && entry.retryAt > Date.now()).map(entry => entry.retryAt));
  if (!Number.isFinite(next)) return;
  remoteArtistRetryTimer = setTimeout(() => {
    if (document.hidden || (route !== 'artists' && !route.startsWith('artist/'))) return;
    render();
    void matchArtistPortrait();
  }, Math.max(0, next - Date.now()));
}

function retryRemoteArtistImages() {
  for (const entry of remoteArtistImages.values()) {
    if (!entry.loaded) {
      entry.retryAt = 0;
      if (entry.request) entry.retryRequested = true;
    }
    for (const portrait of entry.portraits.values()) failedCovers.delete(portrait.cover);
  }
  if (!sourcesLoaded) {
    void refreshSources();
    return;
  }
  if (!document.hidden && (route === 'artists' || route.startsWith('artist/'))) {
    render();
    void matchArtistPortrait();
  }
}

function loadRemoteArtistImages(tracks) {
  const ids = new Set(tracks.filter(track => folderPortraitProviders.has(track.provider)).map(librarySourceId));
  const requests = [];
  for (const source of sources.filter(source => folderPortraitProviders.has(source.type) && ids.has(source.id))) {
    const id = source.id;
    let entry = remoteArtistImages.get(id);
    if (!entry) {
      entry = { portraits: new Map(), controller: new AbortController() };
      remoteArtistImages.set(id, entry);
    }
    if (!entry.loaded && !entry.request && !(entry.retryAt > Date.now())) {
      const path = sourceEndpoint(id, 'cover') + '?id=';
      entry.request = queueRemoteArtistImages(async () => {
        if (remoteArtistImages.get(id) !== entry || entry.controller.signal.aborted || document.hidden ||
            (route !== 'artists' && !route.startsWith('artist/'))) {
          entry.request = undefined;
          return;
        }
        try {
          const { portraits } = await api(sourceEndpoint(id, 'artist-portraits'), {
            signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(15000)]),
          });
          if (remoteArtistImages.get(id) !== entry) return;
          if (!Array.isArray(portraits)) throw new TypeError('Invalid artist photo index');
          for (const { artist, cover } of portraits.filter(item => item && typeof item === 'object')) {
            if (typeof artist !== 'string' || !artist.trim() || typeof cover !== 'string' || !cover.startsWith(path) ||
                !/^[\w-]{24}$/.test(cover.slice(path.length))) continue;
            entry.portraits.set(artistIdentity(artist.trim()), { cover });
          }
          entry.loaded = true;
        } catch {
          entry.retryAt = entry.retryRequested ? 0 : Date.now() + 30000;
        } finally {
          entry.retryRequested = false;
          entry.request = undefined;
          if (remoteArtistImages.get(id) !== entry) return;
          scheduleRemoteArtistRetry();
          if (route === 'artists' || route.startsWith('artist/')) render();
          if (entry.loaded) void matchArtistPortrait();
        }
      });
    }
    requests.push(entry.request);
  }
  return Promise.all(requests);
}

function privatePortraitForTracks(tracks, artist) {
  const local = new Map();
  const name = artistIdentity(artist.trim());
  for (const track of tracks) {
    if (track.provider !== 'local' || typeof track.path !== 'string' || !track.path.includes('/')) continue;
    const root = track.path.split('/', 1)[0].normalize('NFC');
    const portrait = localArtistImages.get(JSON.stringify([root, name]));
    if (portrait && !failedCovers.has(portrait.cover)) local.set(portrait.cover, portrait);
  }
  if (local.size === 1) return local.values().next().value;
  const remote = new Map();
  const ids = new Set(tracks.filter(track => folderPortraitProviders.has(track.provider)).map(librarySourceId));
  const remoteReady = !sources.some(source => folderPortraitProviders.has(source.type) && ids.has(source.id) && !remoteArtistImages.get(source.id)?.loaded);
  for (const id of ids) {
    const portrait = remoteArtistImages.get(id)?.portraits.get(name);
    if (portrait && !failedCovers.has(portrait.cover)) remote.set(portrait.cover, portrait);
  }
  if (remoteReady && remote.size === 1) return remote.values().next().value;
}

function unresolvedPrivatePortrait(tracks) {
  return tracks.some(track => folderPortraitProviders.has(track.provider) && (!sourcesLoaded ||
    sources.some(source => source.id === librarySourceId(track)) && !remoteArtistImages.get(librarySourceId(track))?.loaded));
}

function portraitForTracks(tracks, artist) {
  const scoped = privatePortraitForTracks(tracks, artist);
  if (scoped) return scoped;
  const key = customArtistKey(artist);
  const custom = !unresolvedPrivatePortrait(tracks) && (selectedCustomCover('artist', key) ||
    (navigator.serviceWorker?.controller && offlineCustomCover('artist', key)?.cover));
  if (custom) return { cover: custom, adapter: 'hisatri' };
  const matches = new Map();
  for (const track of tracks) {
    const portrait = artistPortraits.get(artworkKey(track, artist));
    if (portrait && !failedCovers.has(portrait.cover)) matches.set(portrait.cover, portrait);
  }
  return matches.size === 1 ? matches.values().next().value : undefined;
}

const configuredCoverCredit = () => t('封面来源：已配置的 HisAtri', 'Configured cover source: HisAtri');

function artistAlbumCoverTrack(tracks) {
  if (!state.settings.artistImageEngine && state.settings.artistAlbumCoverFallback) {
    return tracks.find(track => featuredAlbum(track) && trackArtwork(track));
  }
}

function artistPortraitMarkup(portrait, albumTrack) {
  if (!portrait) return albumTrack ? '<figure class="artist-portrait">' + cover(albumTrack, 'portrait-art') + '</figure>' : '';
  return '<figure class="artist-portrait">' +
    '<span class="cover portrait-art"><img src="' + esc(portrait.cover) + '" alt="" decoding="async" data-artist-portrait></span>' +
    (portrait.attribution || portrait.adapter === 'hisatri' ? '<figcaption class="artwork-credit">' +
      (portrait.attribution ? portraitCredit(portrait) : esc(configuredCoverCredit())) + '</figcaption>' : '') + '</figure>';
}

function portraitCandidate(tracks, artist) {
  return tracks.find(track => {
    const id = artworkKey(track, artist);
    const portrait = artistPortraits.get(id);
    return id && (!portrait || failedCovers.has(portrait.cover));
  });
}

async function matchArtistPortrait(manual = false, failed) {
  if (!route.startsWith('artist/')) return;
  const originalRoute = route;
  const artist = route.slice('artist/'.length);
  if (!manual && automaticArtworkBlocked(artist)) return;
  const candidates = artistPortraitTracks(getRouteTracks(), artist);
  if (!sourcesLoaded && candidates.some(track => folderPortraitProviders.has(track.provider))) return;
  await loadRemoteArtistImages(candidates);
  if (route !== originalRoute) return;
  const tracks = artistPortraitTracks(getRouteTracks(), artist);
  if (unresolvedPrivatePortrait(tracks) || privatePortraitForTracks(tracks, artist)) return;
  const valid = () => {
    if (route !== originalRoute || (!manual && automaticArtworkBlocked(artist))) return false;
    const current = artistPortraitTracks(getRouteTracks(), artist);
    return current.length && !unresolvedPrivatePortrait(current) && !privatePortraitForTracks(current, artist);
  };
  const custom = await queryCustomArtwork('artist', customArtistKey(artist), { artist: customArtworkText(artist) }, { manual, valid, failed });
  if (custom !== 'disabled' || !valid()) return;
  if (portraitForTracks(tracks, artist) || (!manual && !state.settings.artistImageEngine)) return;
  const track = portraitCandidate(tracks, artist);
  if (!track) return;
  const id = artworkKey(track, artist);
  if (portraitRequests.has(id) || (!manual && (portraitRetryAt.get(id) || 0) > Date.now())) return;
  const controller = new AbortController();
  const request = { controller, manual };
  portraitRequests.set(id, request);
  if (manual) announce(t('正在查找艺人照片…', 'Looking for an artist photo…'));
  try {
    const query = new URLSearchParams({ artist: artist.trim(), album: albumForLookup(track) });
    const response = await fetch('/api/artwork/artist?' + query,
      { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(22000)]) });
    if (controller.signal.aborted) return;
    if (response.status === 404) {
      portraitRetryAt.set(id, Date.now() + 900000);
      if (manual) announce(t('未找到可核实来源的艺人照片。', 'No artist photo with a verified source was found.'));
      return;
    }
    if (response.status === 429) {
      const delay = Math.max(1, Math.min(600, Number(response.headers.get('retry-after')) || 60));
      portraitRetryAt.set(id, Date.now() + delay * 1000);
      if (manual) announce(t('艺人照片服务暂时繁忙，请稍后再试。', 'The artist photo service is busy. Try again shortly.'));
      return;
    }
    if (!response.ok) throw new Error('Artist photo lookup failed.');
    const result = await response.json();
    if (!validPortrait(result)) throw new Error('Invalid artist artwork response.');
    if (controller.signal.aborted ||
        (!manual && (!state.settings.artistImageEngine || automaticArtworkBlocked(artist)))) return;
    if (manual) failedCovers.delete(result.cover);
    artistPortraits.set(id, result);
    if (artistPortraits.size > 150) artistPortraits.delete(artistPortraits.keys().next().value);
    portraitRetryAt.delete(id);
    save();
    if (route === 'artists' || route.startsWith('artist/')) render();
    if (manual) announce(t('已添加艺人照片。', 'Artist photo added.'));
  } catch {
    if (controller.signal.aborted) return;
    portraitRetryAt.set(id, Date.now() + 60000);
    if (manual) announce(t('无法读取艺人照片。', 'Could not load an artist photo.'));
  } finally {
    if (portraitRequests.get(id) === request) portraitRequests.delete(id);
  }
}
async function matchOnlineCover(track, manual = false, { playing = false, failed } = {}) {
  if (!track || hasPrivateAlbumArtwork(track) || (!manual && automaticAlbumArtworkBlocked(track))) return;
  const originalRoute = route;
  const originalSource = track.src;
  const customKey = customAlbumKey(track);
  const valid = () => route === originalRoute && (!playing || currentPlayerArtworkTrack(track) && player.getState().track.src === originalSource) &&
    customAlbumKey(track) === customKey && !hasPrivateAlbumArtwork(track) &&
    (manual || !automaticAlbumArtworkBlocked(track));
  const custom = await queryCustomArtwork('album', customKey, customAlbumMetadata(track), { manual, valid, playing, failed });
  if (custom !== 'disabled' || !valid()) return;
  const id = artworkKey(track);
  if (!id || trackArtwork(track) || artworkRequests.has(id) ||
      (!manual && (!state.settings.onlineCover || automaticAlbumArtworkBlocked(track) || (artworkRetryAt.get(id) || 0) > Date.now()))) return;
  const controller = new AbortController();
  const request = { controller, manual };
  artworkRequests.set(id, request);
  if (manual) announce(t('正在查找专辑封面…', 'Looking for an album cover…'));
  try {
    const params = new URLSearchParams({ artist: albumCreditForLookup(track).trim(), album: albumForLookup(track) });
    const response = await fetch('/api/artwork/album?' + params, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    if (controller.signal.aborted) return;
    if (response.status === 404) {
      artworkRetryAt.set(id, Date.now() + 600000);
      if (manual) announce(t('未找到与专辑及艺人匹配的在线封面。', 'No online cover matched this artist and album.'));
      return;
    }
    if (response.status === 429) {
      const delay = Math.max(1, Math.min(600, Number(response.headers.get('retry-after')) || 60));
      artworkRetryAt.set(id, Date.now() + delay * 1000);
      if (manual) announce(t('在线封面服务暂时繁忙，请稍后再试。', 'The cover service is busy. Try again shortly.'));
      return;
    }
    const data = await response.json();
    if (!response.ok || typeof data.cover !== 'string' || !artworkPath.test(data.cover)) {
      throw new InterfaceError('在线封面服务暂时不可用。', 'The cover service is currently unavailable.');
    }
    if (controller.signal.aborted || (!manual && (!state.settings.onlineCover || automaticAlbumArtworkBlocked(track)))) return;
    if (manual) failedCovers.delete(data.cover);
    onlineCovers.set(id, data.cover);
    if (onlineCovers.size > 300) onlineCovers.delete(onlineCovers.keys().next().value);
    mediaId = undefined;
    save();
    refreshCurrent();
    if (manual) announce(t('已显示在线封面。', 'Online cover added.'));
  } catch (error) {
    if (controller.signal.aborted) return;
    artworkRetryAt.set(id, Date.now() + 60000);
    if (manual) announce(displayError(error, t('无法读取在线封面。', 'Could not load an online cover.')));
  } finally {
    if (artworkRequests.get(id) === request) artworkRequests.delete(id);
  }
}

function observeCustomArtworkGrid(scope, entries) {
  if (!customCoverStatus?.[scope]) return;
  const originalRoute = route;
  const groups = new Map(entries);
  customCoverObserver = new IntersectionObserver(changes => {
    if (route !== originalRoute) return;
    for (const { isIntersecting, target } of changes) {
      if (!isIntersecting || !target.isConnected) continue;
      const name = target.dataset.id;
      const tracks = groups.get(name);
      if (!tracks?.length) continue;
      if (scope === 'album') {
        const track = albumArtworkTrack(tracks);
        if (track && !hasPrivateAlbumArtwork(track) && !automaticAlbumArtworkBlocked(track)) {
          const key = customAlbumKey(track);
          const valid = () => route === originalRoute && customAlbumKey(track) === key &&
            !hasPrivateAlbumArtwork(track) && !automaticAlbumArtworkBlocked(track);
          void queryCustomArtwork(scope, key, customAlbumMetadata(track), { valid });
        }
      } else if (!automaticArtworkBlocked(name) && !unresolvedPrivatePortrait(tracks) && !privatePortraitForTracks(tracks, name)) {
        const valid = () => route === originalRoute && !automaticArtworkBlocked(name) &&
          !unresolvedPrivatePortrait(tracks) && !privatePortraitForTracks(tracks, name);
        void queryCustomArtwork(scope, customArtistKey(name), { artist: customArtworkText(name) }, { valid });
      }
    }
  });
  for (const card of $$('button.card[data-action="group"]', content)) customCoverObserver.observe(card);
}

async function metadataArtworkSettings() {
  const title = t('配置封面 API', 'Configure Cover API');
  openDialog(title, '<p class="dialog-message" role="status">' + t('正在读取…', 'Loading…') + '</p>');
  const pending = dialog.firstElementChild;
  try {
    const { artwork, configurationError } = await api(metadataArtworkPath + 'config', { cache: 'no-store' });
    if (!dialog.open || dialog.firstElementChild !== pending) return;
    const enabled = artwork.adapter === 'hisatri';
    openDialog(title, '<form class="dialog-inner" style="padding:0" data-form="metadata-artwork-api">' +
      (configurationError ? '<p class="dialog-message">' + t('已保存的封面接口配置无法读取，重新保存可修复。',
        'Saved cover API settings could not be read. Save the settings again to repair them.') + '</p>' : '') +
      '<p class="dialog-message">' + t('本地和私有来源图片优先。自定义接口可独立查找专辑封面和艺人照片。',
        'Local and private source artwork takes priority. The custom API can look up album covers and artist photos independently.') + '</p>' +
      '<label class="dialog-field">' + t('封面接口', 'Cover adapter') + '<select id="metadata-artwork-adapter" name="adapter">' +
      '<option value="none">' + t('无', 'None') + '</option><option value="hisatri"' + (enabled ? ' selected' : '') +
      '>HisAtri</option></select></label><fieldset style="border:0;padding:0;margin:0;min-width:0" data-custom-cover-fields' + (enabled ? '' : ' disabled') + '>' +
      '<label class="dialog-field">' + t('接口地址', 'API endpoint') +
      '<input name="url" type="url" maxlength="2000" required value="' + esc(artwork.url) + '"></label>' +
      '<label><input type="checkbox" name="album"' + (!enabled || artwork.album ? ' checked' : '') + '>' +
      t('使用自定义专辑封面', 'Use custom album covers') + '</label>' +
      '<label><input type="checkbox" name="artist"' + (!enabled || artwork.artist ? ' checked' : '') + '>' +
      t('使用自定义艺人照片', 'Use custom artist photos') + '</label>' +
      '<label class="dialog-field">' + t('请求头操作', 'Request header action') + '<select name="headersAction">' +
      '<option value="keep">' + t('保留已保存的请求头', 'Keep saved headers') + '</option><option value="replace">' +
      t('替换请求头', 'Replace headers') + '</option><option value="remove">' + t('移除请求头', 'Remove headers') + '</option></select></label>' +
      '<label class="dialog-field">' + t('请求头', 'Request headers') +
      '<textarea name="headers" rows="3" maxlength="4096" autocomplete="off" spellcheck="false" disabled' +
      ' placeholder="Authorization=Bearer …&amp;X-Api-Key=…"></textarea></label><p class="dialog-message">' +
      t('请求头仅加密保存在本机服务端，不加入浏览器备份。更换接口域名会清除旧请求头。',
        'Headers are encrypted on this server and excluded from browser backups. Changing the endpoint origin clears old headers.') + ' ' +
      (artwork.hasHeaders ? t('已保存请求头。', 'Headers are saved.') : t('未保存请求头。', 'No headers saved.')) +
      '</p></fieldset><p class="dialog-message" role="status"></p><button type="submit" class="btn primary">' +
      t('保存接口设置', 'Save API settings') + '</button></form>');
  } catch (error) {
    if (dialog.open && dialog.firstElementChild === pending) $('[role=status]', dialog).textContent = displayError(error,
      t('请在运行播放器的电脑上配置封面接口。', 'Configure the cover API on the computer running this player.'));
  }
}

async function saveMetadataArtworkSettings(form, data) {
  const submit = $('button[type=submit]', form);
  submit.disabled = true;
  try {
    const enabled = data.adapter === 'hisatri';
    const status = await api(metadataArtworkPath + 'config', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artwork: { adapter: data.adapter, url: data.url, album: enabled && Boolean(data.album),
        artist: enabled && Boolean(data.artist), headersAction: data.headersAction || 'keep',
        ...(data.headersAction === 'replace' && { headers: data.headers }) } }) });
    form.elements.headers.value = '';
    customCoverStatusSequence++;
    customCoverStatusController?.abort();
    applyCustomCoverStatus(status);
    customCoverChanges?.postMessage({ changed: true });
    if (dialog.contains(form)) dialog.close();
    announce(t('封面接口设置已保存。', 'Cover API settings saved.'));
  } catch (error) {
    if (form.isConnected) $('[role=status]', form).textContent = displayError(error,
      t('无法保存封面接口设置。', 'Could not save the cover API settings.'));
  } finally { submit.disabled = false; }
}
function getRouteTracks() {
  if (route === 'favorites') return state.favorites.map(find).filter(Boolean);
  if (route === 'offline') {
    const downloaded = allTracks().filter(audioOnDevice);
    if (downloadFilters.album && !downloaded.some(track => albumKey(track) === downloadFilters.album)) downloadFilters.album = '';
    if (downloadFilters.artist && !downloaded.some(track => artistKeys(track).includes(downloadFilters.artist))) downloadFilters.artist = '';
    if (downloadFilters.genre && !downloaded.some(track => genreKeys(track).includes(downloadFilters.genre))) downloadFilters.genre = '';
    const text = downloadFilters.query.trim().normalize('NFC').toLocaleLowerCase();
    return downloaded.filter(track =>
      (downloadFilters.category === 'all' || (downloadFilters.category === 'local') === (track.provider === 'local')) &&
      (!downloadFilters.album || albumKey(track) === downloadFilters.album) && (!downloadFilters.artist || artistKeys(track).includes(downloadFilters.artist)) &&
      (!downloadFilters.genre || genreKeys(track).includes(downloadFilters.genre)) && matches(track, text));
  }
  if (route === 'history') return statTracks();
  if (route === 'frequent') {
    const counts = new Map();
    for (const { id } of state.history) counts.set(id, (counts.get(id) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => find(id)).filter(Boolean);
  }
  if (route === 'search') return library().filter(track => matches(track, query.normalize('NFC').toLocaleLowerCase()));
  if (route.startsWith('local-folder/')) return importedLocalFolders().get(route.slice('local-folder/'.length))?.tracks || [];
  if (route.startsWith('playlist/')) return (state.playlists.find(list => list.id === route.slice(9))?.tracks || []).map(find).filter(Boolean);
  if (/^(album|artist|genre)\//.test(route)) {
    const [type, ...slug] = route.split('/');
    const value = slug.join('/');
    const groups = groupTracks(type);
    if (type === 'artist' && !groups.has(value)) {
      const identity = artistIdentity(value);
      return [...groups].find(([name]) => artistIdentity(name) === identity)?.[1] || [];
    }
    return groups.get(value) ||
      (type === 'album' && !value.startsWith(albumCreditPrefix) ? library().filter(track => track.album === value) : []);
  }
  return library();
}
function normalizeSort(section, value) {
  return Object.hasOwn(sortSections, section) && sortSections[section].includes(value) ? value : 'default';
}
function normalizeListSorts(input) {
  return Object.fromEntries(Object.keys(sortSections).filter(section => section !== 'songs' && input?.[section] !== undefined)
    .map(section => [section, normalizeSort(section, input[section])]));
}
function listSort(listRoute) {
  const section = listRoute.split('/', 1)[0];
  return normalizeSort(section, section === 'songs' ? state.settings.sort : state.settings.listSorts[section]);
}
function listSortControl(listRoute) {
  const section = listRoute.split('/', 1)[0];
  if (!Object.hasOwn(sortSections, section)) return '';
  const selected = listSort(listRoute);
  return '<select id="sort" aria-label="' + t('排序', 'Sort') + '">' + sortSections[section].map(value =>
    '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + t(...sortLabels[value]) + '</option>').join('') + '</select>';
}
function textOrder(first, second) {
  return String(first ?? '').localeCompare(String(second ?? ''), getLanguage());
}
function trackFileName(track) {
  if (isAudioName(track.fileName)) return track.fileName;
  const basename = typeof track.path === 'string' ? track.path.split(/[/\\]/).at(-1) : '';
  return isAudioName(basename) ? basename : track.title;
}
function compareFolderNames(a, b, order) {
  if (order === 'file-name') return fileNameOrder(a.name, b.name);
  if (order === 'file-name-desc') return fileNameOrder(b.name, a.name);
  return order === 'title-desc' ? textOrder(b.name, a.name) : textOrder(a.name, b.name);
}
function sortTrackEntries(tracks, order) {
  if (order === 'default') return tracks;
  if (numericTrackOrders.includes(order)) return sortNumericTracks(tracks, order);
  if (order === 'duration') return [...tracks].sort((a, b) => {
    const first = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : Infinity;
    const second = Number.isFinite(b.duration) && b.duration > 0 ? b.duration : Infinity;
    return first === second ? 0 : first - second;
  });
  if (fileNameOrders.includes(order)) {
    const direction = order === 'file-name-desc' ? -1 : 1;
    const names = new Map(tracks.map(track => [track, trackFileName(track)]));
    return [...tracks].sort((a, b) => direction * fileNameOrder(names.get(a), names.get(b)));
  }
  if (order === 'title-desc') return [...tracks].sort((a, b) => textOrder(b.title, a.title));
  return [...tracks].sort((a, b) => textOrder(a[order], b[order]));
}
function albumHasMultipleDiscs(tracks) {
  const first = tracks[0];
  const sourceId = first && librarySourceId(first);
  return Boolean(sourceId && first.albumKey && tracks.every(track => track.albumKey === first.albumKey && librarySourceId(track) === sourceId) &&
    new Set(tracks.map(track => albumSequenceNumber(track.discNumber)).filter(Boolean)).size > 1);
}
function sortAlbumDiscs(tracks) {
  const index = value => albumSequenceNumber(value) ?? Number.MAX_SAFE_INTEGER;
  return [...tracks].sort((a, b) => index(a.discNumber) - index(b.discNumber) || index(a.trackNumber) - index(b.trackNumber));
}
function albumYear(tracks) {
  return tracks.reduce((earliest, track) => {
    const year = normalizeReleaseYear(track.releaseYear);
    return year !== undefined && (earliest === undefined || year < earliest) ? year : earliest;
  }, undefined);
}
function isAlbumView() {
  return route === 'albums' || route.startsWith('album/') || route.startsWith('artist/') || route === 'offline';
}
function usesLocalAlbumTags() {
  return isAlbumView() || (!route.startsWith('source/') && listSort(route) === 'release-year');
}
function loadMissingAlbumTags() {
  if (localAlbumTagsJob || !locals.some(track => track.releaseYear === undefined || track.albumArtist === undefined)) return;
  localAlbumTagsJob = readMissingLocalAlbumTags().then(tags => {
    for (const track of locals) {
      const updated = tags.get(track.id);
      if (!updated) continue;
      if (track.releaseYear === undefined) track.releaseYear = updated.releaseYear;
      if (track.albumArtist === undefined) track.albumArtist = updated.albumArtist;
    }
    if (usesLocalAlbumTags()) {
      const restoreFocus = document.activeElement?.id === 'sort';
      render();
      if (restoreFocus) $('#sort')?.focus({ preventScroll: true });
    }
  }).catch(() => { /* Another year or album view can retry unavailable local tags. */ })
    .finally(() => { localAlbumTagsJob = undefined; });
}
function sortGroupEntries(entries, order, years, by) {
  if (order === 'default') return entries;
  if (order === 'track-count') return entries.sort((a, b) => b[1].length - a[1].length);
  const compareNames = ([first, firstTracks], [second, secondTracks]) => by === 'album'
    ? albumNameOrder(groupLabel(by, first, firstTracks), groupLabel(by, second, secondTracks)) || albumNameOrder(first, second)
    : textOrder(first, second);
  if (order === 'album-artist') {
    const credits = new Map(entries.map(([id, tracks]) => [id, albumArtistForTrack(tracks[0])]));
    return entries.sort((first, second) => {
      const a = credits.get(first[0]);
      const b = credits.get(second[0]);
      if (!a && b) return 1;
      if (a && !b) return -1;
      return (a && b ? albumNameOrder(a, b) : 0) || compareNames(first, second);
    });
  }
  if (years) return entries.sort((first, second) => {
    const a = years.get(first[0]);
    const b = years.get(second[0]);
    if (a === b) return compareNames(first, second);
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    return order === 'release-year-desc' ? b - a : a - b;
  });
  return entries.sort((first, second) => order === 'name-desc' ? compareNames(second, first) : compareNames(first, second));
}
function render() {
  customCoverObserver?.disconnect();
  customCoverObserver = undefined;
  const focused = document.activeElement;
  const focusedRow = !dialog.open && renderedTrackRoute === route && content.contains(focused)
    ? focused.closest('tr[data-track]') : undefined;
  const focusedTrackControl = focusedRow && focused.matches('[data-action], [data-select-track]') ? {
    id: focusedRow.dataset.track, occurrence: focusedRow.dataset.playlistOccurrence,
    ordinal: $$('tr[data-track]', content).filter(row => row.dataset.track === focusedRow.dataset.track).indexOf(focusedRow),
    action: focused.dataset.action, checkbox: focused.matches('[data-select-track]'),
  } : undefined;
  const focusedSearch = ['download-search', 'playlist-search'].includes(focused?.id) ? focused : null;
  const focusedAlbumArtist = focused?.dataset.albumArtist;
  const focusedGroupCard = ['albums', 'artists'].includes(route) && focused?.matches('#content button[data-action="group"]')
    ? focused.dataset.id : undefined;
  const focusedSourceControl = route === 'sources' && !dialog.open && focused?.matches('#content .source-grid button[data-action], #content [data-action="retry-source-registry"]')
    ? focused.dataset : undefined;
  if (usesLocalAlbumTags()) loadMissingAlbumTags();
  $('#scroll-top').hidden = !folderViewIsOpen() && !catalogViewIsOpen();
  rows = [];
  playRows = [];
  playPlaylistContexts = undefined;
  const playlistOrderControl = $('#playlist-order-control');
  const orderLabel = t('调整歌单顺序', 'Reorder Playlists');
  if (state.playlists.length < 2) playlistOrderControl.replaceChildren();
  else if (playlistOrderControl.firstElementChild?.getAttribute('aria-label') !== orderLabel) {
    playlistOrderControl.innerHTML = tool(orderLabel, 'list-ordered', 'reorder-playlists', 'aria-haspopup="dialog"');
  }
  $('#playlist-nav').innerHTML = overviewPlaylists().map(list =>
    '<button data-nav="' + esc('playlist/' + list.id) + '">' + icon('list-music') + esc(list.name) + '</button>').join('') +
    [...serverPlaylistMirrors.values()].map(mirror => {
      const label = t('服务器歌单镜像', 'Server Playlist Mirror');
      return '<button data-nav="' + esc('server-playlist/' + mirror.id) + '" aria-label="' + esc(mirror.name + ' · ' + label) + '" title="' +
        esc(label + ' · ' + mirror.sourceName) + '">' + icon('cloud-download') + esc(mirror.name) + '</button>';
    }).join('');
  for (const nav of $$('[data-nav]', $('.sidebar'))) {
    const active = nav.dataset.nav === route || (route.startsWith('source/') && nav.dataset.nav === 'sources') ||
      (route.startsWith('album/') && nav.dataset.nav === 'albums') || (route.startsWith('artist/') && nav.dataset.nav === 'artists') ||
      (route.startsWith('genre/') && nav.dataset.nav === 'genres');
    if (active) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  $('#source-indicator').classList.toggle('is-connected', cloudProviderIds.some(id => cloudStatus[id].connected) || sources.length > 0);
  if (route === 'home') content.innerHTML = home();
  else if (route === 'timeline') content.innerHTML = playbackTimeline();
  else if (route === 'sources') content.innerHTML = renderSources();
  else if (route.startsWith('source/')) content.innerHTML = renderCloud();
  else if (route.startsWith('server-playlist/')) content.innerHTML = renderServerPlaylistMirror(serverPlaylistMirrors.get(route.slice('server-playlist/'.length)));
  else if (route === 'settings') content.innerHTML = renderSettings();
  else if (['albums', 'artists', 'genres'].includes(route)) {
    const by = route.slice(0, -1);
    const order = listSort(route);
    const entries = [...groupTracks(by)];
    if (by === 'artist') void loadRemoteArtistImages(entries.flatMap(([, tracks]) => tracks));
    const showYear = albumYearOrders.includes(order);
    const years = showYear ? new Map(entries.map(([title, tracks]) => [title, albumYear(tracks)])) : undefined;
    const groups = sortGroupEntries(entries, order, years, by).map(([title, tracks]) => {
      const portrait = by === 'artist' ? portraitForTracks(tracks, title) : undefined;
      return {
        id: title, title: groupLabel(by, title, tracks), caption: [trackCount(tracks.length), years?.get(title),
          by === 'album' && albumArtistForTrack(tracks[0])].filter(Boolean).join(' · '),
        track: by === 'artist' ? !portrait && artistAlbumCoverTrack(tracks) :
          (by === 'album' ? albumArtworkTrack(tracks) : undefined) || tracks.find(trackArtwork) || tracks[0],
        portrait,
      };
    });
    const heading = { album: t('专辑', 'Albums'), artist: t('艺人', 'Artists'), genre: t('分类', 'Genres') };
    let actions = listSortControl(route);
    if (by === 'album' && groups.length) actions =
      btn(t('随机播放一张专辑', 'Play a Random Album'), 'shuffle', 'play-random-album') + actions + albumGridControl('catalog');
    content.innerHTML = head(heading[by],
      t('{count} 项', groups.length === 1 ? '{count} item' : '{count} items', { count: groups.length }),
      actions) +
      (groups.length ? cards(groups, 'group', by === 'album' ? state.settings.albumGridColumns.catalog : 'auto') :
        empty('disc-3', t('导入音乐后即可浏览', 'Import music to browse your library')));
    if (by === 'album' || by === 'artist') observeCustomArtworkGrid(by, entries);
  } else {
    const playlist = route.startsWith('playlist/') ? state.playlists.find(item => item.id === route.slice(9)) : undefined;
    const labels = { songs: t('全部歌曲', 'All Tracks'), favorites: t('我喜欢的', 'Favorites'), history: t('最近播放', 'Recently Played'),
      frequent: t('常听歌曲', 'Most Played'), search: t('搜索结果', 'Search Results'), offline: t('已下载音乐', 'Downloaded Music') };
    const tracks = getRouteTracks();
    const canReorder = Boolean(playlist && !playlistQuery.trim() && tracks.length > 1 && listSort(route) === 'default');
    const reordering = canReorder && playlistOrdering;
    const [section, ...slug] = route.split('/');
    const name = slug.join('/');
    const localFolder = section === 'local-folder' ? importedLocalFolders().get(name) : undefined;
    const folderMatches = route === 'search' ? searchFolderResults() : [];
    const title = playlist?.name || labels[route] || localFolder?.name ||
      (['artist', 'album', 'genre'].includes(section) ? groupLabel(section, name, tracks) : name) || labels.songs;
    let actions = tracks.length ? btn(t('全部播放', 'Play All'), 'play', 'play-view', '', true) : '';
    if (section === 'artist' && tracks.length) {
      actions += btn(t('随机播放该艺人', 'Shuffle This Artist'), 'shuffle', 'shuffle-artist');
    }
    if (localFolder && tracks.length) actions += folderResumeAction();
    if (route === 'songs') actions += btn(t('导入音乐', 'Import Music'), 'folder-up', 'import-files') + libraryRefreshAction();
    actions += listSortControl(route);
    actions += bulkTagAction(tracks);
    if (route === 'history') actions += btn(t('常听歌曲', 'Most Played'), 'chart-no-axes-column', 'frequent') +
      btn(t('播放时光机', 'Playback Timeline'), 'history', 'timeline') +
      (state.history.length || state.directRecent.length ? btn(t('清除历史', 'Clear History'), 'trash-2', 'clear-history') : '');
    if (tracks.length && routeSupportsSelection()) actions += btn(selectionMode ? t('结束多选', 'Done Selecting') : t('多选', 'Select Tracks'), 'list-checks', 'selection-mode');
    if (canReorder) actions += btn(reordering ? t('完成排序', 'Finish Ordering') : t('手动排序', 'Reorder Tracks'),
      reordering ? 'check' : 'list-ordered', 'playlist-order', 'aria-pressed="' + reordering + '"');
    if (playlist) actions += playlistLocationMarkup() + playlistDownloadActions(playlist) + btn(t('重命名', 'Rename'), 'pencil', 'rename-playlist') +
      btn(t('删除歌单', 'Delete Playlist'), 'trash-2', 'delete-playlist');
    if (route === 'offline') actions += btn(t('打开本地音乐', 'Open Local Music'), 'folder-up', 'import-files') +
      btn(t('扫描本地文件夹', 'Scan Local Folder'), 'folder-tree', 'import-folder');
    const artistAlbums = section === 'artist' ? artistAlbumMarkup(tracks, name) : '';
    const portraitTracks = section === 'artist' ? artistPortraitTracks(tracks, name) : [];
    if (section === 'artist') void loadRemoteArtistImages(portraitTracks);
    const artistPortrait = section === 'artist' ? portraitForTracks(portraitTracks, name) : undefined;
    const artistArtwork = section === 'artist' ? artistPortraitMarkup(artistPortrait,
      !artistPortrait && artistAlbumCoverTrack(portraitTracks)) : '';
    if (section === 'artist' && portraitTracks.length && (customCoverStatus?.artist ?
      customArtistKey(name) && !selectedCustomCover('artist', customArtistKey(name)) &&
        !privatePortraitForTracks(portraitTracks, name) && !unresolvedPrivatePortrait(portraitTracks) :
      !artistPortrait && portraitCandidate(portraitTracks, name))) {
      actions += btn(t('查找艺人照片', 'Find Artist Photo'), 'image', 'match-artist-portrait');
    }
    if (section === 'artist' && (tracks.length || artistAlbums)) {
      actions += btn(t('停用自动匹配图片', 'Disable Automatic Artwork'), 'image-off', 'toggle-artist-artwork',
        'aria-pressed="' + automaticArtworkBlocked(name) + '"');
    }
    const albumTrack = section === 'album' ? albumArtworkTrack(tracks) : undefined;
    const albumArtwork = albumTrack && trackArtwork(albumTrack) ? cover(albumTrack, 'album-detail-cover') : '';
    if (artworkCanBeLookedUp(albumTrack)) actions += btn(t('查找在线封面', 'Find Cover Online'), 'image', 'match-album-cover');
    const order = listSort(route);
    const discGroups = section === 'album' && order === 'default' && albumHasMultipleDiscs(tracks);
    const arranged = discGroups ? sortAlbumDiscs(tracks) : sortTrackEntries(tracks, order);
    const emptyMessage = ({ search: t('没有找到匹配的音乐', 'No matching music'),
      offline: t('缓存或下载完成的歌曲会显示在这里。', 'Music saved for offline playback will appear here.') })[route] || t('这里还没有歌曲', 'No tracks yet');
    const folderMarkup = folderMatches.length ? '<section class="section" aria-labelledby="folder-search-heading"><div class="section-head">' +
      '<h2 id="folder-search-heading">' + t('文件夹', 'Folders') + '</h2></div>' + folderButtons(folderMatches) + '</section>' :
      localFolder?.children.length ? folderButtons([...localFolder.children].sort((a, b) => compareFolderNames(a, b, order))) : '';
    const genreMarkup = route === 'search' ? searchGenreMarkup() : '';
    if (localFolder?.parent) actions += '<div class="breadcrumbs">' + localFolderParents(localFolder).map(parent =>
      '<button type="button" class="btn" data-nav="' + esc('local-folder/' + parent.path) + '">' + esc(parent.name) + '</button>')
      .join(icon('chevron-right')) + '</div>';
    const credits = section === 'album' ? [...new Set(tracks.map(albumArtistForTrack).filter(Boolean))] : undefined;
    const albumCredit = credits?.length === 1 ? credits[0] : credits?.length === 0 && tracks.some(track => track.album && !track.albumIsFallback)
      ? t('未知专辑艺人', 'Unknown album artist') : '';
    const creditLinks = section === 'album' ? albumArtistLinks(tracks) : '';
    const countLabel = tracks.length || !artistAlbums ? trackCount(tracks.length) : '';
    content.innerHTML = head(title, [countLabel, !creditLinks && albumCredit].filter(Boolean).join(' · '), actions, creditLinks) +
      bulkTagStatusMarkup() + artistArtwork + albumArtwork + (route === 'offline' ? downloadedControls() : '') +
      (route === 'songs' && scanJob?.library ? scanStatusMarkup() : '') +
      (playlist ? playlistDownloadStatus(playlist) + playlistSearch() : '') + folderMarkup + genreMarkup +
      (arranged.length || !(folderMarkup || genreMarkup || artistAlbums) ?
        (playlist ? playlistTrackRows : trackRows)(arranged, { emptyMessage, reordering, discGroups,
          playlistContexts: playlist && localPlaylistContexts(playlist, arranged) }) : '') + artistAlbums;
  }
  if (incompleteCatalogRestore || stateScopeReadError || cloudCatalogScopeStale) {
    const message = incompleteCatalogRestore
      ? t('上次恢复尚未完成，当前原有数据保留。请重试，或放弃这次恢复。',
        'The last restore is incomplete. Your previous data is kept. Retry or discard this restore.')
      : stateScopeReadError ? t('无法读取已保存的设置，修改不会保存。请保留浏览器数据并重试。',
        'Saved settings could not be read. Changes will not be saved. Keep your browser data and retry.')
      : t('另一标签页恢复了新版本，请刷新后继续编辑。', 'Another tab restored a new version. Reload before editing.');
    content.insertAdjacentHTML('afterbegin', '<aside class="setting-card catalog-recovery-notice" data-catalog-recovery-notice role="status"><p>' + esc(message) +
      '</p><div class="actions">' + btn(t('重新加载', 'Reload'), 'refresh-cw', 'retry-catalog-recovery') +
      (incompleteCatalogRestore ? btn(t('放弃未完成恢复', 'Discard Incomplete Restore'), 'undo-2', 'discard-catalog-recovery') : '') + '</div></aside>');
  }
  syncRows(player.getState());
  updateSelectionControls();
  if (focusedSearch) {
    const next = document.getElementById(focusedSearch.id);
    next?.focus({ preventScroll: true });
    next?.setSelectionRange(focusedSearch.selectionStart, focusedSearch.selectionEnd);
  }
  if (focusedAlbumArtist) {
    $$('[data-album-artist]', content).find(link => link.dataset.albumArtist === focusedAlbumArtist)?.focus({ preventScroll: true });
  }
  if (focusedGroupCard) {
    $$('button[data-action="group"]', content).find(button => button.dataset.id === focusedGroupCard)?.focus({ preventScroll: true });
  }
  if (focusedSourceControl && !dialog.open && document.activeElement === document.body) {
    $$('.source-grid button[data-action]:enabled, [data-action="retry-source-registry"]:enabled', content).find(button =>
      button.dataset.action === focusedSourceControl.action && button.dataset.id === focusedSourceControl.id)
      ?.focus({ preventScroll: true });
  }
  if (focusedTrackControl && !dialog.open && document.activeElement === document.body) {
    const candidates = $$('tr[data-track]', content).filter(row => row.dataset.track === focusedTrackControl.id);
    const row = focusedTrackControl.occurrence
      ? candidates.find(row => row.dataset.playlistOccurrence === focusedTrackControl.occurrence)
      : candidates[focusedTrackControl.ordinal];
    const control = row && $$('[data-action], [data-select-track]', row).find(control => !control.disabled &&
      (focusedTrackControl.checkbox ? control.matches('[data-select-track]') : control.dataset.action === focusedTrackControl.action));
    control?.focus({ preventScroll: true });
  }
  renderedTrackRoute = route;
}
function go(value) {
  if (value === 'home') location.hash = 'home';
  else location.hash = encodeURIComponent(value);
  if (value === route) {
    render();
    scrollWorkspaceToTop();
  }
}
function readRoute() {
  let hash = 'home';
  try { hash = decodeURIComponent(location.hash.slice(1) || 'home'); } catch { /* invalid hash */ }
  const valid = ['home','songs','albums','artists','genres','favorites','history','timeline','frequent','offline','settings','sources','search'].includes(hash) ||
    /^(album|artist|genre|playlist|source|local-folder|server-playlist)\/.+/.test(hash);
  const nextRoute = valid ? hash : 'home';
  if (route !== nextRoute) {
    stopCustomArtwork();
    playlistOrdering = false;
    playlistQuery = '';
    resetSelection();
  }
  route = nextRoute;
  if (route !== 'search') {
    query = '';
    search.value = '';
  }
  document.body.classList.remove('menu-open');
  if (route.startsWith('source/') && (!cloud || cloud.id !== route.slice(7))) void openCloud(route.slice(7), false);
  if (ready) {
    refreshCurrentArtwork(undefined, false);
  }
  render();
  $('.workspace').scrollTop = 0;
  if (trackToLocate && route === 'songs') scrollToTrack(trackToLocate);
  trackToLocate = undefined;
}
function refreshCurrent() {
  render();
  lastNow = '';
  syncPlayer(player.getState());
}

async function assertActiveStateScope(expected = cloudCatalogScope) {
  if (stateScopeReadError) throw stateScopeReadError;
  if (expected !== cloudCatalogScope || cloudCatalogScopeStale) {
    throw new CloudCatalogError('cloud-catalog-conflict', 'The settings scope changed');
  }
  const control = await readCloudCatalogControl();
  if (stateScopeReadError) throw stateScopeReadError;
  if (expected !== cloudCatalogScope || cloudCatalogScopeStale) {
    throw new CloudCatalogError('cloud-catalog-conflict', 'The settings scope changed while checking');
  }
  if (control.scope !== expected) {
    cloudCatalogScopeStale = true;
    throw new CloudCatalogError('cloud-catalog-conflict', 'The settings scope changed in another tab');
  }
  if (control.pending) throw new CloudCatalogError('cloud-catalog-restore-pending', 'A library restore is in progress');
}
async function api(url, options) {
  const scope = cloudCatalogScope;
  const readOnly = ['GET', 'HEAD'].includes(String(options?.method || 'GET').toUpperCase());
  if (!readOnly) await assertActiveStateScope(scope);
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (readOnly && scope !== cloudCatalogScope) throw new CloudCatalogError('cloud-catalog-conflict', 'The settings scope changed while loading');
  if (!response.ok) {
    const error = body.error ? new Error(body.error) :
      new InterfaceError('连接失败 ({status})', 'Connection failed ({status})', { status: response.status });
    throw Object.assign(error, { status: response.status, code: body.code });
  }
  return body;
}
function setListenBrainzAccount(account) {
  listenBrainzAccount = typeof account === 'string' && account ? account : null;
  listenBrainzPlayback.setEnabled(Boolean(listenBrainzAccount));
  if (route === 'settings') render();
}
function connectListenBrainz() {
  openDialog(t('连接 ListenBrainz', 'Connect ListenBrainz'), '<form data-form="listenbrainz-connect"><p>' +
    t('令牌可在 ListenBrainz 设置中获取。连接后从下一首开始同步收听记录。', 'Get your token in ListenBrainz settings. Reporting starts with the next track.') +
    ' <a href="https://listenbrainz.org/settings/" target="_blank" rel="noopener noreferrer">ListenBrainz</a></p>' +
    '<label class="dialog-field">' + t('ListenBrainz 用户令牌', 'ListenBrainz user token') +
    '<input name="token" type="password" autocomplete="off" required autofocus maxlength="128"></label>' +
    '<p class="dialog-message" role="status"></p><button class="btn primary" type="submit">' + t('连接', 'Connect') + '</button></form>');
}
async function saveListenBrainzConnection(form, credentials) {
  const submit = $('button[type=submit]', form);
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    const { account } = await api('/api/listenbrainz/connect', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: credentials.token }), });
    form.reset();
    if (dialog.open && dialog.contains(form)) dialog.close();
    setListenBrainzAccount(account);
    announce(t('已连接 ListenBrainz。', 'Connected to ListenBrainz.'));
  } catch (error) {
    $('[role=status]', form).textContent = displayError(error, t('无法连接 ListenBrainz。', 'Could not connect to ListenBrainz.'));
  } finally { submit.disabled = false; }
}
async function disconnectListenBrainz(button) {
  if (button.disabled) return;
  button.disabled = true;
  listenBrainzPlayback.setEnabled(false);
  try {
    await api('/api/listenbrainz/disconnect', { method: 'DELETE' });
    setListenBrainzAccount(null);
    announce(t('已断开 ListenBrainz。', 'Disconnected from ListenBrainz.'));
  } catch (error) {
    announce(displayError(error, t('无法断开 ListenBrainz。', 'Could not disconnect from ListenBrainz.')));
  } finally { button.disabled = false; }
}
async function refreshSources() {
  const results = await Promise.allSettled([...cloudProviderIds.map(id => api(sourceEndpoint(id, 'status'))), api('/api/sources')]);
  cloudProviderIds.forEach((id, index) => {
    if (results[index].status === 'fulfilled') cloudStatus[id] = results[index].value;
  });
  baidu = cloudStatus.baidu;
  const serverSources = results.at(-1);
  if (serverSources.status === 'fulfilled' && Array.isArray(serverSources.value.sources)) {
    sources = serverSources.value.sources;
    sourcesLoaded = true;
    sourceRegistryError = undefined;
  } else {
    sourceRegistryError = serverSources.status === 'rejected' ? serverSources.reason : new Error('Invalid source registry');
    if (sourceRegistryError?.code === 'source_session_unreadable') {
      sources = [];
      sourcesLoaded = false;
    }
  }
  for (const id of navidromeHomeAlbums.keys()) if (!sources.some(source => source.id === id)) navidromeHomeAlbums.delete(id);
  for (const id of remoteArtistImages.keys()) if (!sources.some(source => source.id === id)) invalidateRemoteArtistImages(id);
  if (route.startsWith('source/') && cloud?.error) void openCloud(route.slice(7), false);
  render();
  if (ready) void matchArtistPortrait();
  schedulePlaylistSync(0);
}
function sourceCard(name, title, text, glyph, action, attrs = '') {
  return '<button class="source-card" data-action="' + action + '" ' + attrs + '>' + icon(glyph) +
    '<strong>' + esc(name) + '</strong><small class="small-stat">' + esc(title) + '</small><p>' + esc(text) + '</p></button>';
}
function directModeButton(id) {
  if (!cloudProviderIds.includes(id) || !cloudStatus[id].connected) return '';
  const direct = isDirectCloudSource(id);
  return btn(t('直连模式', 'Direct Mode'), direct ? 'check' : 'folder-open', 'toggle-direct-mode',
    key(id) + ' aria-pressed="' + direct + '"' + (scanJob?.sourceId === id ? ' disabled' : ''));
}
function filenameRuleSupported(id) {
  return cloudProviderIds.includes(id) || sources.some(source => source.id === id && ['webdav', 'smb'].includes(source.type));
}
function sourceFilenameButton(id) {
  return filenameRuleSupported(id) ? btn(t('文件名解析', 'Filename Parsing'), 'file-music', 'source-filename-rule',
    key(id) + (scanJob ? ' disabled' : '')) : '';
}
function sourceFilenameDialog(id) {
  if (!filenameRuleSupported(id) || scanJob) return;
  const { mode, pattern } = state.settings.sourceFilenameRules.get(id) || { mode: 'tags', pattern: defaultFilenamePattern };
  const modeOption = (value, label) => '<option value="' + value + '"' + (mode === value ? ' selected' : '') + '>' + label + '</option>';
  openDialog(t('文件名解析', 'Filename Parsing'),
    '<form class="dialog-inner" data-form="source-filename-rule" ' + key(id) + ' style="padding:0">' +
    '<label class="dialog-field">' + t('歌曲信息来源', 'Track Metadata Source') + '<select name="mode">' +
    modeOption('tags', t('优先使用内嵌标签', 'Prefer Embedded Tags')) +
    modeOption('filename', t('使用文件名', 'Use Filename')) + '</select></label>' +
    '<label class="dialog-field">' + t('文件名规则', 'Filename Pattern') +
    '<input name="pattern" maxlength="80" value="' + esc(pattern) + '" aria-describedby="source-filename-help"></label>' +
    '<p class="dialog-message" id="source-filename-help">' +
    t('name 表示完整歌名。也可使用 name-artist、name_artist、track-name-artist 或 track-name。专辑目录可命名为「专辑-艺人」。',
      'Use name for the full title, or a pattern such as name-artist, name_artist, track-name-artist, or track-name. Album folders can use Album-Artist.') + '</p>' +
    '<p class="dialog-message" role="status">' + t('保存后生效于目录浏览。重新扫描可更新曲库。',
      'The rule applies in the folder browser after saving. Rescan to update your library.') + '</p>' +
    '<button class="btn primary" type="submit">' + t('保存', 'Save') + '</button></form>');
}
function saveSourceFilenameRule(form, data) {
  const id = form.dataset.id;
  if (!filenameRuleSupported(id) || scanJob) { dialog.close(); return; }
  const entry = { id, mode: data.mode, pattern: data.pattern?.trim() || defaultFilenamePattern };
  const rule = normalizeSourceFilenameRules([entry]).get(id);
  if (!rule) {
    $('[role=status]', form).textContent = t('规则必须有且仅有一个 name。可加 artist 和 track，并在字段之间加入分隔符。',
      'Include name once. Add artist or track as needed, using a separator between fields.');
    return;
  }
  state.settings.sourceFilenameRules.set(id, rule);
  dialog.close();
  save();
  render();
  $$('[data-action="source-filename-rule"]', content).find(button => button.dataset.id === id)?.focus({ preventScroll: true });
  announce(t('文件名规则已保存。', 'Filename pattern saved.'));
}
function sourceFilenameParser(id) {
  const rule = state.settings.sourceFilenameRules.get(id);
  return rule?.mode === 'filename' && filenameRuleSupported(id) ? compileFilenamePattern(rule.pattern) : null;
}
function sourceLibraryCard(id, name, card) {
  const hidden = state.settings.hiddenLibrarySources.has(id);
  const label = hidden ? t('在曲库显示', 'Show in Library') : t('从曲库隐藏', 'Hide from Library');
  return '<article class="source-card-group" aria-label="' + esc(name) + '">' + card +
    btn(label, hidden ? 'eye' : 'eye-off', 'toggle-library-source', key(id) + ' data-source-name="' + esc(name) + '"') +
    directModeButton(id) + sourceFilenameButton(id) + cloudPlaylistBackupButton(id) + '</article>';
}
function renderSources() {
  const connection = connected => connected ? t('已连接', 'Connected') : t('未连接', 'Not connected');
  const savedSources = new Set(state.tracks.map(librarySourceId));
  const hasIndex = id => savedSources.has(id) || Object.hasOwn(state.scanSnapshots, id);
  const driveCard = (id, text, glyph, action) => {
    const name = providerLabel(id);
    const card = sourceCard(name, connection(cloudStatus[id].connected), text, glyph, action, key(id));
    return cloudStatus[id].connected || hasIndex(id) || state.settings.hiddenLibrarySources.has(id) ? sourceLibraryCard(id, name, card) : card;
  };
  const localName = t('本地文件', 'Local Files');
  const localCard = sourceCard(localName, t('{count} 首已导入', '{count} imported', { count: locals.length }),
    t('从设备选择音频和同名歌词。', 'Choose audio files and matching lyrics from this device.'), 'folder-open', 'import-files');
  const showLocalEntry = state.settings.showLocalSource !== false;
  const connectedSources = new Set(sources.map(source => source.id));
  const disconnectedHiddenCards = [...state.settings.hiddenLibrarySources].filter(([id]) =>
    id === 'local' ? !showLocalEntry : hasIndex(id) && !cloudProviderIds.includes(id) && !connectedSources.has(id))
    .map(([id, savedName]) => {
      const name = id === 'local' ? localName : savedName;
      return sourceLibraryCard(id, name, '<div class="source-card"><strong>' + esc(name) + '</strong><small class="small-stat">' +
        esc(t('曲目已从曲库隐藏', 'Tracks are hidden from the library')) + '</small></div>');
    });
  const registryMessage = sourceRegistryError?.code === 'source_session_unreadable'
    ? t('已保存的媒体连接无法读取，请重新添加媒体来源。', 'Saved media connections could not be read. Add your media sources again.')
    : t('暂时无法读取媒体连接，请重试。', 'Media connections are temporarily unavailable. Try again.');
  const registryStatus = sourceRegistryError ? '<div class="dialog-message" role="status" data-source-registry-error>' + esc(registryMessage) +
    '<div class="actions">' + btn(t('重试媒体连接', 'Retry media connections'), 'refresh-cw', 'retry-source-registry') + '</div></div>' : '';
  return head(t('音乐来源', 'Music Sources'), t('播放网盘、媒体服务器和这台设备上的歌曲。', 'Play songs from cloud drives, media servers, and this device.')) + registryStatus +
    '<div class="source-grid">' +
    driveCard('baidu', t('浏览文件夹，直接播放网盘中的音频。', 'Browse folders and play audio from your drive.'), 'cloud', 'baidu-source') +
    cloudProviderIds.filter(id => id !== 'baidu').map(id => driveCard(id,
      t('播放云端文件夹中的音频。', 'Play audio from cloud folders.'), 'cloud-download', 'oauth-source')).join('') +
    (showLocalEntry ?
      (locals.length || state.settings.hiddenLibrarySources.has('local') ? sourceLibraryCard('local', localName, localCard) : localCard) +
      sourceCard(t('本地文件夹', 'Local Folder'), t('选择目录', 'Choose a folder'),
        t('一次导入所选目录及其子目录。', 'Import the chosen folder and its subfolders.'), 'folder-tree', 'import-folder') : '') +
    sources.map(source => sourceLibraryCard(source.id, source.name, sourceCard(source.name, providerLabel(source.type),
      t('浏览目录与歌曲。', 'Browse folders and songs.'), 'server', 'open-cloud', key(source.id)))).join('') +
    disconnectedHiddenCards.join('') +
    sourceCard(t('添加媒体服务器', 'Add Media Server'), 'SMB · WebDAV · Kodi · Plex · Jellyfin · Emby · Subsonic',
      t('连接你的自建媒体库。', 'Connect to a self-hosted music library.'), 'plus', 'add-source') + '</div>';
}
const sourceEndpoint = (id, action) => cloudProviderIds.includes(id) ? '/api/' + id + '/' + action : '/api/sources/' + encodeURIComponent(id) + '/' + action;
const playlistSourceTypes = new Set(['subsonic', 'opensubsonic', 'navidrome', 'emby', 'jellyfin']);
const playlistWriterTypes = new Set(['emby', 'jellyfin']);
const serverPlaylistsLabel = () => t('服务器歌单', 'Server Playlists');
const serverPlaylistMirrorId = (sourceId, path) => sourceId + ':' + path;
const mirrorOperationBusy = id => activeMirrorOperations.has(id) || (navidromePlaylistSyncSource && id.startsWith(navidromePlaylistSyncSource + ':'));
const albumSequenceNumber = number => Number.isSafeInteger(number) && number > 0 ? number : undefined;
function toCloudTrack(item, source, lyrics, tags, parsed) {
  const name = item.name.replace(/\.[^.]+$/, '');
  const parts = /^(.*?)\s+[-–—]\s+(.+)$/.exec(name);
  const src = typeof item.streamUrl === 'string' && item.streamUrl.startsWith('/api/') ? item.streamUrl : undefined;
  const artistNames = normalizeArtists(item.artistNames);
  const fileName = item.fileName || item.name;
  return {
    id: source.id + ':' + item.id, provider: source.type, path: item.path, src, cover: item.cover, folderCover: item.folderCover,
    ...(isAudioName(fileName) && { fileName }),
    playlistLocation: item.playlistLocation,
    albumKey: item.albumKey, discNumber: albumSequenceNumber(item.discNumber), trackNumber: albumSequenceNumber(item.trackNumber),
    title: item.title || parts?.[2] || name, artist: item.artist || artistNames.join(', ') || parts?.[1] || '未知艺人',
    artistIsFallback: !item.artist && !artistNames.length && !parts?.[1] && !tags?.artist,
    ...(artistNames.length && { artistNames }),
    album: item.album || source.name, albumIsFallback: !item.album && !tags?.album, duration: item.duration ? Number(item.duration) : undefined,
    ...tags, genres: normalizeGenres([...normalizeGenres(item.genres), ...normalizeGenres(tags?.genres)]),
    releaseYear: normalizeReleaseYear(tags?.releaseYear ?? item.releaseYear ?? item.year),
    modified: normalizeTrackModified(item.modified),
    albumArtist: normalizeAlbumArtist(tags?.albumArtist) ?? normalizeAlbumArtist(item.albumArtist),
    ...(parsed && { parsedFromFilename: true, title: parsed.title, artist: parsed.artist || '未知艺人', artistIsFallback: !parsed.artist,
      artistNames: undefined, album: parsed.album || source.name, albumIsFallback: !parsed.album,
      albumArtist: normalizeAlbumArtist(parsed.albumArtist), trackNumber: parsed.trackNumber }),
    backupAccount: source.id === source.type && cloudBackupProviders.has(source.type) &&
      typeof item.backupAccount === 'string' && cloudBackupAccount.test(item.backupAccount) ? item.backupAccount : undefined,
    embeddedTags: tags, lyrics: item.lyricsUrl || lyrics || tags?.lyrics,
  };
}
function cloudTracks(items, source, folderName, parseFilename = sourceFilenameParser(source.id)) {
  const cached = new Map(state.tracks.map(track => [track.id, track]));
  const stem = name => name.replace(/\.[^.]+$/, '').normalize('NFC').toLowerCase();
  const rawName = item => item.fileName || item.name;
  const sidecars = new Map();
  if (cloudProviderIds.includes(source.type) || ['webdav','smb'].includes(source.type)) {
    for (const item of items) {
      const filename = rawName(item);
      if (item.folder || !item.streamUrl || !/\.(?:lrc|vtt)$/i.test(filename)) continue;
      const key = stem(filename);
      if (!sidecars.has(key) || /\.lrc$/i.test(filename)) sidecars.set(key, item.streamUrl);
    }
  }
  return items.filter(cloudTrackItem).map(item => {
    const filename = rawName(item);
    const physicalParent = source.type === 'webdav' && typeof item.path === 'string' && item.path.startsWith('/')
      ? item.path.split('/').at(-2) : undefined;
    const previous = cached.get(source.id + ':' + item.id);
    const track = toCloudTrack(item, source, sidecars.get(stem(filename)), previous?.embeddedTags,
      parseFilename && isAudioName(filename) ? parseFilename(filename, physicalParent || folderName) : undefined);
    track.encoding = previous?.src === track.src && previous?.backupAccount === track.backupAccount ? previous?.encoding : undefined;
    return track;
  });
}
function cloudTrackItem(item) {
  return !item.folder && (isAudioName(item.fileName || item.name) || item.title) && item.streamUrl;
}
function serverPlaylistContexts(id, tracks, entries, revision) {
  if (!state.settings.rememberPlaylistPosition) return;
  return playlistContexts('server-playlist/' + id,
    tracks.map((track, index) => ({ trackId: track.id, slotId: entries?.[index] })), revision);
}
let cloudAbort;
async function readCloudFolder(id, path, signal, trail) {
  const listFolder = value => api(sourceEndpoint(id, 'list') + '?' + new URLSearchParams({ path: value }), { signal });
  try {
    return await listFolder(path);
  } catch (error) {
    if (cloudProviderIds.includes(id) || error.status !== 404 || !trail || trail.length < 2) throw error;
    for (let index = 0; index < trail.length - 1; index++) {
      const { items } = await listFolder(trail[index].path);
      if (!Array.isArray(items) || !items.some(item => item.folder && item.path === trail[index + 1].path)) throw error;
    }
    return listFolder(path);
  }
}
async function openCloud(id, navigate = true, trail = [{ name: '根目录', path: '/' }], { restoreIndexed = false } = {}) {
  if (id !== cloud?.id || trail.at(-1).path !== cloud?.trail.at(-1).path) {
    resetSelection();
    playlistQuery = '';
  }
  const stamp = ++cloudRequest;
  cloudAbort?.abort();
  cloudAbort = new AbortController();
  const { signal } = cloudAbort;
  const target = trail.at(-1).path;
  cloud = { id, trail, items: [], loading: true };
  if (navigate) go('source/' + id);
  if (route === 'source/' + id) render();
  try {
    const response = await readCloudFolder(id, target, signal, restoreIndexed ? trail : undefined);
    if (stamp !== cloudRequest) return;
    cloud.items = response.items || [];
    cloud.serverOrder = response.serverOrder === true;
    cloud.playlistRevision = response.playlistRevision;
    cloud.playlistWritable = response.playlistWritable === true;
  } catch (error) {
    if (stamp !== cloudRequest) return;
    cloud.error = error;
  } finally {
    if (stamp === cloudRequest) {
      cloud.loading = false;
      if (route === 'source/' + id) render();
    }
  }
}
function renderCloud() {
  const source = cloudSources().find(entry => entry.id === route.slice(7));
  const view = cloud;
  if (!source || !view) return head(t('音乐来源', 'Music Sources')) + empty('cloud-off', t('找不到此音乐来源', 'Music source not found'),
    btn(t('返回音乐来源', 'Back to Music Sources'), 'cloud', 'open-sources'));
  const playlistView = view.trail[1]?.path === 'playlists' || view.serverOrder;
  const folderLabel = ({ name, path }) => path === 'playlists' ? serverPlaylistsLabel() : name;
  const name = playlistView ? folderLabel(view.trail.at(-1)) : cloudProviderIds.includes(source.id) ? providerLabel(source.id) : source.name;
  const crumbs = '<div class="breadcrumbs">' + view.trail.map((entry, index) =>
    btn(index === 0 ? t('根目录', 'Root') : folderLabel(entry), index === 0 ? 'folder-open' : null, 'crumb', 'data-index="' + index + '"')).join(icon('chevron-right')) + '</div>';
  if (view.loading) return head(name, t('正在读取目录…', 'Loading folder…'), crumbs);
  if (view.error) return head(name, displayError(view.error, t('无法读取此目录。', 'Could not load this folder.')), crumbs) +
    btn(t('重试', 'Retry'), 'refresh-cw', 'reload-cloud') + ' ' + btn(t('返回', 'Back'), 'cloud', 'open-sources');
  const order = playlistView || view.serverOrder ? 'default' : listSort(route);
  const folders = view.items.filter(item => item.folder);
  if (order === 'title' || order === 'title-desc' || fileNameOrders.includes(order)) folders.sort((a, b) => compareFolderNames(a, b, order));
  const currentFolder = view.trail.at(-1);
  const directCollection = view.serverOrder || ['album', 'artist'].includes(currentFolder.browseKind);
  const entries = cloudTracks(view.items, source, currentFolder.path === '/' ? undefined : currentFolder.name);
  const discGroups = !playlistView && order === 'default' && folders.every(folder => folder.albumDiscFolder === true) && albumHasMultipleDiscs(entries);
  const tracks = discGroups ? sortAlbumDiscs(entries) : sortTrackEntries(entries, order);
  const playlistItems = view.serverOrder ? view.items.filter(cloudTrackItem) : [];
  const serverPlaylistEdit = canEditServerPlaylist(source, view) ? { provider: source.type, entries: playlistItems } : undefined;
  const mirrorId = serverPlaylistMirrorId(source.id, view.trail.at(-1).path);
  const mirrorAction = view.serverOrder ? serverPlaylistMirrors.has(mirrorId)
    ? btn(t('打开本地镜像', 'Open Local Mirror'), 'cloud-download', 'open-playlist-mirror', key(mirrorId))
    : btn(t('保存为本地镜像', 'Save Local Mirror'), 'cloud-download', 'save-playlist-mirror',
      loadingServerPlaylistMirrors || mirrorOperationBusy(mirrorId) ? 'disabled' : '') : '';
  const scanRoot = currentScanRoot(view);
  const scanned = state.scanSnapshots[source.id]?.some?.(folder => folder[0] === scanRoot.path);
  const scanning = scanJob?.sourceId === source.id;
  const canScan = !playlistView && !isDirectCloudSource(source.id);
  const scanActions = !canScan ? '' : scanning ? btn(t('取消扫描', 'Cancel Scan'), 'x', 'cancel-scan') :
    btn(scanned ? t('重新扫描目录', 'Rescan Folder') : t('扫描并加入曲库', 'Scan and Add to Library'), 'scan-line', 'scan-cloud', '', true) +
    (scanFolderChoices(view).length ? btn(t('选择要收录的目录', 'Choose Folders to Include'), 'folder-tree', 'choose-scan-folders', scanJob ? 'disabled' : '') : '') +
    (scanned ? btn(t('只扫描新目录', 'Scan New Folders Only'), 'folder-tree', 'scan-new-cloud') : '') +
    cloudScanStartAction(view);
  return head(name, t('{count} 个文件夹', folders.length === 1 ? '{count} folder' : '{count} folders', { count: folders.length }) +
    ' · ' + trackCount(tracks.length), crumbs + (view.serverOrder ? playlistLocationMarkup() : '') +
    (playlistView ? '' : listSortControl(route)) + scanActions + directModeButton(source.id) + sourceFilenameButton(source.id) +
    bulkTagAction(tracks) + mirrorAction +
    (tracks.length ? btn(playlistView ? t('播放歌单', 'Play Playlist') : t('播放此目录', 'Play Folder'), 'play', 'play-view') +
      (playlistView ? '' : folderResumeAction()) +
      btn(selectionMode ? t('结束多选', 'End Selection') : t('多选', 'Select Multiple'), 'list-checks', 'selection-mode') : '') +
    (!playlistView && playlistSourceTypes.has(source.type) ? btn(serverPlaylistsLabel(), 'list-music', 'server-playlists') : '') +
    (source.type === 'navidrome' && view.trail.at(-1).path === 'playlists' ? btn(navidromePlaylistSyncSource === source.id
      ? t('正在同步服务器歌单…', 'Syncing Server Playlists…') : t('同步全部服务器歌单', 'Sync All Server Playlists'), 'cloud-download',
      'sync-navidrome-playlists', loadingServerPlaylistMirrors || navidromePlaylistSyncSource ||
      [...activeMirrorOperations].some(id => id.startsWith(source.id + ':')) ? 'disabled' : '') : '') +
    (canCreateServerPlaylist(source, view)
      ? btn(t('新建 {name} 歌单', 'New {name} Playlist', { name: providerLabel(source.type) }),
        'list-plus', 'new-' + source.type + '-playlist', '', true) : '') +
    (source.type === 'webdav' ? btn(t('云端歌单', 'Cloud Playlists'), 'cloud-upload', 'cloud-playlists', key(source.id)) : '') +
    cloudPlaylistBackupButton(source.id) +
    btn(t('刷新目录', 'Refresh Folder'), 'refresh-cw', 'reload-cloud') +
    (source.id === 'baidu' ? btn(t('应用配置', 'App Configuration'), 'settings-2', 'baidu-configure') : '') +
    (cloudProviderIds.includes(source.id) ? btn(t('断开连接', 'Disconnect'), 'unlink', 'disconnect-oauth', key(source.id)) :
      btn(t('移除来源', 'Remove Source'), 'unlink', 'disconnect-source'))) +
    (playlistView ? jellyfinPlaylistAuthorityNotice(source) : '') + bulkTagStatusMarkup() +
    (scanning ? scanStatusMarkup() : '') +
    (canScan && cloudProviderIds.includes(view.id) ? cloudScanScopeMarkup(scanRoot) : '') +
    '<div class="folder-list">' + folders.map(item => '<button class="folder-row" data-action="open-folder" ' + key(item.id) + '>' +
      (typeof item.cover === 'string' && /^\/api\/sources\/[\w-]+\/cover\?id=[\w-]+$/.test(item.cover) ?
        '<img class="folder-cover" src="' + esc(item.cover) + '" alt="" loading="lazy" decoding="async">' : icon('folder')) +
      '<span>' + esc(item.name) + '</span>' + icon('chevron-right') + '</button>').join('') + '</div>' +
    (view.serverOrder ? playlistSearch() : '') +
    (view.serverOrder ? playlistTrackRows : trackRows)(tracks, { serverPlaylistEdit, discGroups, directCollection,
      playlistContexts: view.serverOrder && serverPlaylistContexts(mirrorId, tracks, playlistItems.map(item => item.playlistEntry), view.playlistRevision),
      emptyMessage: playlistView
      ? view.serverOrder ? t('此歌单没有歌曲', 'This playlist has no tracks') : t('服务器没有可访问的歌单', 'The server has no accessible playlists')
      : t('当前目录没有音频文件', 'This folder has no audio files') });
}
function renderServerPlaylistMirror(mirror) {
  const label = t('服务器歌单镜像', 'Server Playlist Mirror');
  if (!mirror) return loadingServerPlaylistMirrors ? head(label, t('正在读取本地镜像…', 'Loading local mirror…')) :
    head(label) + empty('cloud-off', t('找不到该本地镜像', 'Local mirror not found'));
  const connected = sources.some(source => source.id === mirror.sourceId);
  const busy = mirrorOperationBusy(mirror.id);
  const actions = (mirror.tracks.length ? btn(t('播放歌单', 'Play Playlist'), 'play', 'play-view', '', true) + playlistLocationMarkup() : '') +
    (connected ? btn(t('从服务器刷新镜像', 'Refresh Mirror from Server'), 'refresh-cw', 'refresh-playlist-mirror', key(mirror.id) + (busy ? ' disabled' : '')) :
      btn(t('前往音乐来源', 'Go to Music Sources'), 'server', 'open-sources')) +
    btn(t('移除本地镜像', 'Remove Local Mirror'), 'trash-2', 'remove-playlist-mirror', key(mirror.id) + (busy ? ' disabled' : ''));
  return head(mirror.name, label + ' · ' + mirror.sourceName + ' · ' + trackCount(mirror.tracks.length), actions) +
    (connected ? '' : '<p class="hint">' + esc(t('重新连接媒体服务器即可刷新镜像和播放未下载的歌曲。',
      'Reconnect the media server to refresh the mirror and play tracks you have yet to download.')) + '</p>') +
    playlistSearch() + playlistTrackRows(mirror.tracks, { emptyMessage: t('此歌单没有歌曲', 'This playlist has no tracks'),
      playlistContexts: serverPlaylistContexts(mirror.id, mirror.tracks, mirror.playlistEntries, mirror.playlistRevision) });
}
async function changeServerPlaylistMirror(id, operation, errorMessage) {
  if (mirrorOperationBusy(id)) return;
  activeMirrorOperations.add(id);
  render();
  try {
    return await operation();
  } catch (error) {
    announce(displayError(error, errorMessage));
  } finally {
    activeMirrorOperations.delete(id);
    render();
  }
}
async function saveServerPlaylistMirror() {
  const view = cloud;
  const source = sources.find(entry => entry.id === view?.id);
  if (!view?.serverOrder || view.loading || !source || !playlistSourceTypes.has(source.type)) return;
  const { name, path } = view.trail.at(-1);
  const id = serverPlaylistMirrorId(source.id, path);
  if (loadingServerPlaylistMirrors || serverPlaylistMirrors.has(id)) return;
  const mirror = { id, path, name, sourceId: source.id, sourceName: source.name, tracks: cloudTracks(view.items, source).map(savedTrack),
    playlistRevision: view.playlistRevision, playlistEntries: view.items.filter(cloudTrackItem).map(item => item.playlistEntry) };
  const saved = await changeServerPlaylistMirror(id, async () => {
    await addServerPlaylistMirror(mirror);
    serverPlaylistMirrors.set(id, mirror);
    return true;
  }, t('无法保存本地镜像。', 'Could not save the local mirror.'));
  if (saved && cloud === view && route === 'source/' + source.id) go('server-playlist/' + id);
}
async function readServerPlaylistMirror(source, playlist, options) {
  const path = playlist.path;
  const response = await api(sourceEndpoint(source.id, 'list') + '?' + new URLSearchParams({ path }), options);
  if (!response.serverOrder || !Array.isArray(response.items)) {
    throw new InterfaceError('服务器歌单不可用，已保留本地镜像。', 'The server playlist is unavailable. The local mirror was kept.');
  }
  return { id: serverPlaylistMirrorId(source.id, path), name: playlist.name, path, sourceId: source.id, sourceName: source.name,
    tracks: cloudTracks(response.items, source).map(savedTrack), playlistRevision: response.playlistRevision,
    playlistEntries: response.items.filter(cloudTrackItem).map(item => item.playlistEntry) };
}
async function syncNavidromePlaylists() {
  const view = cloud;
  const source = sources.find(item => item.id === view?.id && item.type === 'navidrome');
  if (!source || view.loading || view.error || view.trail.at(-1).path !== 'playlists' || loadingServerPlaylistMirrors ||
    navidromePlaylistSyncSource || [...activeMirrorOperations].some(id => id.startsWith(source.id + ':'))) return;
  navidromePlaylistSyncSource = source.id;
  render();
  try {
    const { items } = await api(sourceEndpoint(source.id, 'list') + '?path=playlists', { signal: AbortSignal.timeout(15000) });
    if (!Array.isArray(items)) throw new InterfaceError('无法读取服务器歌单。', 'Could not load server playlists.');
    if (cloud === view) view.items = items;
    const playlists = items.filter(item => item?.folder && typeof item.path === 'string' && item.path);
    let synced = 0;
    for (const playlist of playlists) {
      if (!sources.some(item => item.id === source.id)) break;
      try {
        const mirror = await readServerPlaylistMirror(source, playlist, { signal: AbortSignal.timeout(15000) });
        await putServerPlaylistMirror(mirror);
        serverPlaylistMirrors.set(mirror.id, mirror);
        if (route === 'server-playlist/' + mirror.id) resetSelection();
        synced++;
      } catch { /* A failed read leaves that playlist's last local mirror available. */ }
    }
    const missing = playlists.length - synced;
    announce(missing ? t('已同步 {synced} 个歌单，{missing} 个未能同步。', 'Synced {synced} playlists. {missing} could not be synced.', { synced, missing }) :
      t('已同步 {synced} 个服务器歌单。', 'Synced {synced} server playlists.', { synced }));
  } catch (error) {
    announce(displayError(error, t('无法同步服务器歌单。', 'Could not sync server playlists.')));
  } finally {
    navidromePlaylistSyncSource = undefined;
    render();
  }
}
async function refreshServerPlaylistMirror(id) {
  const mirror = serverPlaylistMirrors.get(id);
  const source = sources.find(entry => entry.id === mirror?.sourceId);
  if (!mirror || !source) return;
  await changeServerPlaylistMirror(id, async () => {
    const endpoint = sourceEndpoint(source.id, 'list');
    const { items: playlists } = await api(endpoint + '?path=playlists');
    const playlist = playlists?.find(item => item.folder && item.path === mirror.path);
    const unavailable = t('找不到服务器歌单，已保留本地镜像。', 'The server playlist is unavailable. The local mirror was kept.');
    if (!playlist) throw new Error(unavailable);
    const updated = await readServerPlaylistMirror(source, playlist);
    if (!await updateServerPlaylistMirror(updated)) {
      serverPlaylistMirrors.delete(id);
      throw new InterfaceError('此设备上的镜像已移除。', 'The mirror was removed from this device.');
    }
    serverPlaylistMirrors.set(id, updated);
    if (route === 'server-playlist/' + id) resetSelection();
    announce(t('已从服务器刷新镜像。', 'Mirror refreshed from the server.'));
  }, t('无法从服务器刷新镜像。', 'Could not refresh the mirror from the server.'));
}
function normalizeCloudScanScopes(value) {
  const result = {};
  const validTrail = trail => Array.isArray(trail) && trail[0]?.path === '/' && trail.every(entry =>
    typeof entry?.path === 'string' && entry.path && typeof entry.name === 'string' && entry.name) &&
    new Set(trail.map(entry => entry.path)).size === trail.length;
  for (const id of cloudProviderIds) {
    const scope = value?.[id];
    if (!scope || typeof scope !== 'object') continue;
    const start = validTrail(scope.start) && scope.start.length > 1 ? scope.start : undefined;
    const included = Array.isArray(scope.included) ? scope.included.filter(trail => validTrail(trail) && trail.length > 1) : [];
    if (start || included.length) result[id] = { start, included };
  }
  return result;
}
function currentScanRoot(view) {
  const current = view.trail.at(-1);
  const trail = current.path === '/' ? state.cloudScanScopes[view.id]?.start ?? view.trail : view.trail;
  return { path: trail.at(-1).path, trail };
}
function cloudScanStartAction(view) {
  if (!cloudProviderIds.includes(view.id)) return '';
  const path = view.trail.at(-1).path;
  const configuredPath = state.cloudScanScopes[view.id]?.start?.at(-1).path ?? '/';
  if (path === configuredPath) return '';
  return btn(path === '/' ? t('恢复从根目录扫描', 'Reset Scan Start to Root') :
    t('设为扫描起始目录', 'Set as Scan Starting Folder'), 'folder-tree', 'set-scan-start', scanJob ? 'disabled' : '');
}
function cloudScanScopeMarkup(root) {
  const path = root.path === '/' ? t('根目录', 'Root') : '/' + root.trail.slice(1).map(entry => entry.name).join('/');
  return '<p class="hint" data-cloud-scan-scope>' + esc(t('从 {path} 扫描并向下读取四层。', 'Scan starts at {path} and reads four levels below it.', { path })) + '</p>';
}
function setCloudScanStart() {
  const view = cloud;
  if (!view || route !== 'source/' + view.id || !cloudProviderIds.includes(view.id) ||
      view.loading || view.error || scanJob || isDirectCloudSource(view.id)) return;
  const scope = state.cloudScanScopes[view.id] ??= { included: [] };
  scope.start = view.trail.length > 1 ? view.trail : undefined;
  if (!scope.start && !scope.included.length) delete state.cloudScanScopes[view.id];
  save();
  render();
  $('[data-action="scan-cloud"]', content)?.focus({ preventScroll: true });
  announce(t('扫描起始目录已保存。', 'Scan starting folder saved.'));
}
function rememberCloudScanRoots(id, roots) {
  const extra = roots.filter(({ trail }) => trail.length > 1);
  if (!extra.length) return;
  const scope = state.cloudScanScopes[id] ??= { included: [] };
  const included = new Map(scope.included.map(trail => [trail.at(-1).path, trail]));
  for (const { path, trail } of extra) included.set(path, trail);
  scope.included = [...included.values()];
}
function refreshRootsForSource(id) {
  const scope = state.cloudScanScopes[id];
  const start = scope?.start?.at(-1).path;
  // Older metadata can lack names for an opaque indexed root. Keep its stored path for reads.
  const roots = start ? [{ path: start, trail: scope.start }] : indexedCloudRoots(state.scanSnapshots[id])
    .map(({ path, trail }) => ({ path, trail: [{ path: '/', name: '根目录' }, ...trail] }));
  const unique = new Map(roots.map(root => [root.path, root]));
  for (const trail of scope?.included ?? []) {
    if (start && !trail.some(entry => entry.path === start)) continue;
    const path = trail.at(-1).path;
    if (!unique.has(path)) unique.set(path, { path, trail });
  }
  return [...unique.values()];
}
function scanFolderChoices(view) {
  if (!view || view.loading || view.error || view.serverOrder || view.trail[1]?.path === 'playlists' || isDirectCloudSource(view.id)) return [];
  const snapshot = state.scanSnapshots[view.id];
  const known = new Set(Array.isArray(snapshot) ? snapshot.map(folder => folder?.[0]) : []);
  const current = view.trail.at(-1).path;
  return view.items.filter(item => item.folder && item.path !== current && item.path !== '/' && item.path !== 'playlists')
    .map(item => ({ path: item.path, name: item.name, included: known.has(item.path) }));
}
function chooseScanFolders() {
  if (scanJob) return;
  const view = cloud;
  const choices = scanFolderChoices(view);
  if (!choices.length) return;
  openDialog(t('选择要收录的目录', 'Choose Folders to Include'), '<form data-form="include-scan-folders" ' + key(view.id) +
    ' data-path="' + esc(view.trail.at(-1).path) + '"><p class="dialog-message" role="status">' +
    t('勾选要新加入曲库的子目录。', 'Select the subfolders to add to your library.') + '</p><div class="dialog-options">' +
    choices.map(({ path, name, included }) => '<label><input type="checkbox" name="folder" value="' + esc(path) + '"' +
      (included ? ' checked disabled' : '') + '> ' + esc(name) + (included ? ' · ' + t('已收录', 'Included') : '') + '</label>').join('') +
    '</div><button type="submit" class="btn primary"' + (choices.every(choice => choice.included) ? ' disabled' : '') + '>' +
    t('收录所选目录', 'Include Selected Folders') + '</button></form>');
}
function includeScanFolders(form) {
  const view = cloud;
  if (view?.id !== form.dataset.id || view?.trail.at(-1).path !== form.dataset.path || scanJob) {
    dialog.close();
    return;
  }
  const selected = new Set(new FormData(form).getAll('folder'));
  const roots = scanFolderChoices(view).filter(choice => selected.has(choice.path) && !choice.included)
    .map(({ path, name }) => ({ path, trail: [...view.trail, { path, name }] }));
  if (!roots.length) {
    $('[role=status]', form).textContent = t('请至少选择一个新目录。', 'Select at least one new folder.');
    return;
  }
  dialog.close();
  void scanCloud('incremental', roots);
}
async function scanCloud(mode = 'rescan', chosenRoots) {
  const view = cloud;
  const source = cloudSources().find(entry => entry.id === view?.id);
  if (!source || view.loading || isDirectCloudSource(source.id)) return;
  if (scanJob) return announce(t('已有一个目录正在扫描。', 'A folder scan is already running.'));
  const roots = chosenRoots ?? [currentScanRoot(view)];
  const job = { sourceId: source.id, controller: new AbortController(), label: t('正在读取音乐目录…', 'Reading music folders…') };
  scanJob = job;
  render();
  try {
    const remembered = cloudProviderIds.includes(source.id) && (Boolean(chosenRoots) ||
      mode === 'rescan' && view.trail.length > 1);
    const result = await scanCloudSource(source, roots, job,
      { mode, view, discoverChildren: mode === 'incremental' && !chosenRoots, rememberRoots: remembered });
    if (!result) return announce(t('没有新的子目录需要扫描。', 'There are no new subfolders to scan.'));
    const found = result.tracks.length;
    const removed = result.removedIds.length;
    announce(t('扫描完成，共找到 {count} 首歌曲{detail}', 'Scan complete. Found {count} {unit}.{detail}', {
      count: found, unit: found === 1 ? 'song' : 'songs',
      detail: removed ? t('，发现 {count} 首曲目已从来源移除', ' The source removed {count} {unit}.',
        { count: removed, unit: removed === 1 ? 'track' : 'tracks' }) : '',
    }));
  } catch (error) {
    announce(job.controller.signal.aborted ? t('已取消扫描。', 'Scan canceled.') :
      t('扫描中断。', 'Scan interrupted. ') + (error instanceof CloudCatalogError ? catalogErrorMessage(error) :
        displayError(error, t('无法读取音乐来源。', 'Could not read the music source.'))));
  } finally {
    scanJob = undefined;
    render();
  }
}
function scanStatusMarkup() {
  return '<p class="hint" role="status" data-scan-status>' + esc(scanJob.label) + '</p>';
}
function setScanStatus(job, label) {
  job.label = label;
  const status = $('[data-scan-status]', content);
  if (status) status.textContent = label;
}
async function scanCloudSource(source, roots, job, { mode = 'rescan', view, discoverChildren = false, rememberRoots = false } = {}) {
  const signal = job.controller.signal;
  const parseFilename = sourceFilenameParser(source.id);
  const viewPath = view?.trail.at(-1).path;
  const sourceName = cloudProviderIds.includes(source.id) ? providerLabel(source.id) : source.name;
  const folderTrails = new Map(roots.map(({ path, trail }) => [path, trail]));
  const listFolder = async (path, { signal }) => {
    const { items } = await readCloudFolder(source.id, path, signal, folderTrails.get(path));
    if (Array.isArray(items) && path === viewPath && view === cloud) view.items = items;
    return items;
  };
  let paths = roots.map(entry => entry.path);
  let discoveredChildren = mode === 'incremental' ? paths : undefined;
  let linkedParent = viewPath;
  if (discoverChildren) {
    const anchor = roots[0];
    linkedParent = anchor.path;
    const items = await listFolder(anchor.path, { signal });
    const known = new Set((state.scanSnapshots[source.id] || []).map(folder => folder[0]));
    const folders = items.filter(item => item.folder && item.path !== anchor.path && item.path !== '/');
    discoveredChildren = folders.map(item => item.path);
    for (const { path, name } of folders) folderTrails.set(path, [...anchor.trail, { path, name }]);
    paths = discoveredChildren.filter(path => !known.has(path));
    if (!paths.length) return;
  }
  const result = await scanCloudFolders({
    sourceId: source.id, paths, snapshots: state.scanSnapshots, mode, listFolder, signal, folderTrails,
    maxDepth: cloudProviderIds.includes(source.id) ? cloudScanDepth - Number(discoverChildren) : Infinity,
    tracksFromItems: (items, { path, name }) => cloudTracks(items, source, path === '/' ? undefined : name, parseFilename),
    onProgress({ scanned, found }) {
      const progress = t('已扫描 {scanned} 个目录，找到 {found} 首歌曲。',
        'Scanned {scanned} {unit} and found {tracks}.',
        { scanned, unit: scanned === 1 ? 'folder' : 'folders', found, tracks: trackCount(found) });
      setScanStatus(job, job.library ? sourceName + ' · ' + progress : progress);
    },
  });
  const scanned = result.snapshots[source.id];
  const snapshot = discoveredChildren ? scanned.map(([path, children, ...metadata]) =>
    [path, path === linkedParent ? [...new Set([...children, ...discoveredChildren])] : children, ...metadata]) : scanned;
  await runCloudCatalogWork(async () => {
    signal.throwIfAborted();
    if (staleCloudCatalogs.has(source.id) || restoringCatalog) {
      throw new CloudCatalogError('cloud-catalog-conflict', 'Cloud catalog changed before scan completed');
    }
    const libraryTracks = new Map(state.tracks.map(track => [track.id, track]));
    for (const id of result.removedIds) if (!hasOffline(id) && !state.removedLibraryTracks.has(id)) libraryTracks.delete(id);
    for (const track of result.tracks) {
      if (!state.removedLibraryTracks.has(track.id)) libraryTracks.set(track.id, savedTrack(track));
    }
    const tracks = [...libraryTracks.values()];
    const snapshots = { ...state.scanSnapshots, [source.id]: snapshot };
    const inline = inlineCloudState(tracks, snapshots, cloudCatalogs);
    const existing = cloudCatalogs.get(source.id);
    const external = existing || catalogNeedsDatabase(inline.tracks, inline.scanSnapshots);
    if (external) {
      assertCatalogWritable(source.id);
      const record = await commitCloudCatalog(source.id, catalogMetadata({
        tracks: tracks.filter(track => catalogSourceId(track) === source.id), snapshots: snapshot,
      }), { expectedRevision: existing?.revision ?? null, expectedScope: cloudCatalogScope, signal });
      registerCloudCatalog(record);
      // Keep edits to unrelated sources that were made while IndexedDB committed this source.
      const targetTracks = new Map(catalogMetadata(record.tracks).map(track => [track.id, track]));
      for (const track of state.tracks) {
        if (catalogSourceId(track) === source.id && cloudCatalogEdits.has(track.id)) targetTracks.set(track.id, track);
      }
      state.tracks = [...state.tracks.filter(track => catalogSourceId(track) !== source.id), ...targetTracks.values()];
      state.scanSnapshots = { ...state.scanSnapshots, [source.id]: record.snapshots };
      if (rememberRoots) rememberCloudScanRoots(source.id, roots);
      save();
    } else {
      const before = { tracks: state.tracks, scanSnapshots: state.scanSnapshots, cloudScanScopes: state.cloudScanScopes };
      state.tracks = tracks;
      state.scanSnapshots = snapshots;
      if (rememberRoots) {
        state.cloudScanScopes = catalogMetadata(state.cloudScanScopes);
        rememberCloudScanRoots(source.id, roots);
      }
      if (!save({ strict: true })) {
        Object.assign(state, before);
        throw new CloudCatalogError('cloud-catalog-storage', 'Could not save the cloud library');
      }
    }
  });
  if (folderPortraitProviders.has(source.type)) await refreshRemoteArtistIndex(source.id);
  if (['webdav', 'baidu', 'smb'].includes(source.type)) {
    const covers = new Map(result.tracks.map(track => [track.id, track.folderCover]));
    const playback = player.getState();
    let updated = false;
    for (const track of playback.queue) {
      if (!covers.has(track.id) || track.folderCover === covers.get(track.id)) continue;
      track.folderCover = covers.get(track.id);
      if (track.id === playback.track?.id) updated = true;
    }
    if (updated) {
      mediaId = undefined;
      syncPlayer(playback);
    }
  }
  return result;
}
function refreshableLibrarySources() {
  return cloudSources().filter(source => sourceVisibleInCatalog(source.id) &&
    state.scanSnapshots[source.id]?.length && (!cloudProviderIds.includes(source.id) || cloudStatus[source.id].connected));
}
function libraryRefreshAction() {
  if (scanJob?.library) return btn(t('取消刷新曲库', 'Cancel Library Refresh'), 'x', 'cancel-scan');
  return refreshableLibrarySources().length ? btn(t('刷新曲库', 'Refresh Library'), 'refresh-cw', 'refresh-library', scanJob ? 'disabled' : '') : '';
}
async function refreshLibrary() {
  if (scanJob) return;
  const indexed = refreshableLibrarySources();
  if (!indexed.length) return;
  const job = { library: true, controller: new AbortController(), label: t('正在刷新曲库…', 'Refreshing library…') };
  scanJob = job;
  render();
  let completed = 0;
  const failed = [];
  try {
    for (const source of indexed) {
      if (job.controller.signal.aborted) break;
      if (!sourceVisibleInCatalog(source.id)) continue;
      const roots = refreshRootsForSource(source.id);
      if (!roots.length) continue;
      job.sourceId = source.id;
      const name = cloudProviderIds.includes(source.id) ? providerLabel(source.id) : source.name;
      setScanStatus(job, t('正在刷新 {name}…', 'Refreshing {name}…', { name }));
      try {
        await scanCloudSource(source, roots, job);
        completed += 1;
      } catch {
        if (job.controller.signal.aborted) break;
        failed.push(name);
      }
      render();
    }
    if (job.controller.signal.aborted) announce(t('已取消曲库刷新。', 'Library refresh canceled.'));
    else if (failed.length) announce(t('已刷新 {count} 个来源。以下来源保留现有索引：{failed}',
      'Refreshed {count} {unit}. Kept the existing index for {failed}.',
      { count: completed, unit: completed === 1 ? 'source' : 'sources', failed: failed.join(getLanguage() === 'zh-CN' ? '、' : ', ') }));
    else announce(t('曲库已刷新（{count} 个来源）。',
      'Library refreshed ({count} {unit}).',
      { count: completed, unit: completed === 1 ? 'source' : 'sources' }));
  } finally {
    scanJob = undefined;
    render();
  }
}
async function resetSourceScan(id) {
  if (scanJob?.sourceId === id) scanJob.controller.abort();
  await runCloudCatalogWork(async () => {
    const existing = cloudCatalogs.get(id);
    if (existing) {
      assertCatalogWritable(id);
      registerCloudCatalog(await commitCloudCatalog(id, { tracks: existing.tracks, snapshots: [] }, {
        expectedRevision: existing.revision, expectedScope: cloudCatalogScope,
      }));
    }
    delete state.scanSnapshots[id];
    delete state.cloudScanScopes[id];
    save();
  });
}
async function baiduSource(showConnection = false, result) {
  try { baidu = await api('/api/baidu/status'); }
  catch (error) { return announce(displayError(error, t('无法读取百度网盘的连接状态。', 'Could not check the Baidu Netdisk connection.'))); }
  if (baidu.connected && !showConnection) return openCloud('baidu');
  const { redirectUri, codeAvailable, deviceAvailable } = baidu;
  const callback = safeBaiduCallback(redirectUri);
  const callbackOnThisOrigin = callback?.origin === location.origin;
  const actions = '<div class="actions">' +
    (baidu.configured && deviceAvailable ? btn(t('使用百度设备授权', 'Use Baidu Device Authorization'), 'cloud', 'baidu-device', '', !callbackOnThisOrigin) : '') +
    (baidu.configured && codeAvailable ? btn(t('使用百度授权码', 'Use a Baidu Authorization Code'), 'cloud', 'baidu-code', '', !callbackOnThisOrigin && !deviceAvailable) : '') +
    (baidu.configured && callbackOnThisOrigin ? btn(t('前往百度授权', 'Authorize with Baidu'), 'cloud', 'baidu-authorize', '', true) : '') +
    (baidu.configured && callback && !callbackOnThisOrigin ? '<a class="btn" href="' + esc(new URL('/#sources', callback).href) + '">' +
      t('从回调地址的域名打开播放器', 'Open the player at the callback origin') + '</a>' : '') +
    btn(baidu.configured ? t('更改应用配置', 'Change App Configuration') : t('在网页配置百度应用', 'Configure Baidu App'),
      'settings-2', 'baidu-configure', '', !baidu.configured) + '</div>';
  const callbackNotice = result === 'redirect-mismatch' ? '<p class="dialog-message" role="alert">' +
    t('百度拒绝了回调地址（redirect_uri_mismatch）。请在应用的安全设置中核对已登记的完整回调地址。修改可能需要一小时生效。',
      'Baidu rejected the callback URL (redirect_uri_mismatch). Check the full URL in the app’s security settings. Changes may take an hour to apply.') + '</p>' : '';
  openDialog(t('连接百度网盘', 'Connect Baidu Netdisk'), callbackNotice + '<p class="dialog-message">' + (baidu.configured ?
    (codeAvailable || callback ? t('前往百度登录并授权 Groovebox 读取你的网盘音频。', 'Sign in with Baidu and allow Groovebox to read your audio files.') :
      t('请从运行 Groovebox 的电脑打开播放器使用授权码，或由管理员配置公开 HTTPS 回调地址。',
        'Open the player on the computer running Groovebox to use an authorization code, or ask your administrator to configure a public HTTPS callback URL.')) :
    t('首次连接需要百度开放平台应用。你可以在此页填写应用凭据（BAIDU_CLIENT_ID 和 BAIDU_CLIENT_SECRET）。',
      'To connect, enter the credentials for a Baidu Open Platform app (BAIDU_CLIENT_ID and BAIDU_CLIENT_SECRET).')) +
    '</p>' + (callback ? '<p class="dialog-message">' +
      t('请在百度开放平台的安全设置中登记当前回调地址 <code>', 'In the Baidu Open Platform security settings, register <code>') +
      esc(redirectUri) + t('</code>，并从同一个主机和端口打开播放器。</p>', '</code> as the callback URL. Then open the player from the same host and port.</p>') : '') +
    (deviceAvailable && !callbackOnThisOrigin ? '<p class="dialog-message">' + t('在本机建议使用设备授权，无需登记本机回调地址。',
      'Use device authorization on this computer. It does not require a local callback URL.') + '</p>' : '') + actions +
    '<a class="simple-link" target="_blank" rel="noreferrer" href="https://pan.baidu.com/union/document/">' +
      t('百度网盘开放平台', 'Baidu Netdisk Open Platform') + '</a>');
}
function safeBaiduCallback(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.pathname === '/api/baidu/callback' &&
        !url.username && !url.password && !url.search && !url.hash) return url;
  } catch { /* The loopback authorization methods remain available without a public callback. */ }
}
async function baiduSettings() {
  try {
    const { editable } = await api('/api/baidu/config');
    if (!editable) return announce(t('此实例的百度应用凭据由服务端环境变量管理。', 'Server environment variables manage the Baidu app credentials.'));
    openDialog(t('配置百度网盘应用', 'Configure Baidu Netdisk App'), '<form class="dialog-inner" data-form="baidu-config" style="padding:0">' +
      '<p class="dialog-message">' + t('填写百度网盘开放平台的应用凭据。保存后即可使用本机设备授权或授权码。',
        'Enter your Baidu Netdisk Open Platform app credentials. After saving, you can use device authorization or an authorization code here.') + '</p>' +
      '<label class="dialog-field">' + t('应用 ID（App Key）', 'App ID (App Key)') + '<input name="clientId" required maxlength="300" autocomplete="off"></label>' +
      '<label class="dialog-field">' + t('应用密钥（Secret Key）', 'App Secret (Secret Key)') + '<input name="clientSecret" required maxlength="300" type="password" autocomplete="new-password"></label>' +
      '<p class="dialog-message" data-baidu-config-status role="status"></p>' +
      '<button class="btn primary" type="submit">' + t('保存配置', 'Save Configuration') + '</button></form>');
  } catch (error) { announce(displayError(error, t('无法读取百度应用配置。', 'Could not load the Baidu app configuration.'))); }
}
async function saveBaiduSettings(form, data) {
  const submit = $('button[type=submit]', form);
  const status = $('[data-baidu-config-status]', form);
  submit.disabled = true;
  status.textContent = t('正在保存配置…', 'Saving configuration…');
  try {
    const { changed } = await api('/api/baidu/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (changed) await resetSourceScan('baidu');
    form.reset();
    void refreshSources();
    announce(t('百度应用配置已保存，现在可以授权。', 'The Baidu app configuration is saved. You can now authorize access.'));
    if (dialog.open && dialog.contains(form)) await baiduSource(true);
  } catch (error) {
    status.textContent = displayError(error, t('无法保存百度应用配置。', 'Could not save the Baidu app configuration.'));
    submit.disabled = false;
  }
}
async function baiduCodeDialog() {
  openDialog(t('百度授权码登录', 'Baidu Authorization Code'), '<form class="dialog-inner" data-form="baidu-code" style="padding:0">' +
    '<p class="dialog-message">' + t('在百度页面登录并同意授权，复制页面给出的授权码，再填到这里。',
      'Sign in and authorize access on the Baidu page. Copy the authorization code it displays and paste it here.') + '</p>' +
    '<div data-baidu-code-link></div>' +
    '<label class="dialog-field">' + t('百度授权码', 'Baidu authorization code') + '<input name="code" required maxlength="4096" type="password" autocomplete="off" disabled></label>' +
    '<p class="dialog-message" role="status">' + t('正在获取百度授权页面…', 'Getting the Baidu authorization page…') + '</p>' +
    '<div class="actions"><button class="btn primary" type="submit" disabled>' + t('连接百度网盘', 'Connect Baidu Netdisk') + '</button>' +
    '<button class="btn" type="button" data-action="baidu-code" hidden>' + t('重新获取授权页面', 'Get a New Authorization Page') + '</button></div></form>');
  const form = $('[data-form="baidu-code"]', dialog);
  try {
    const { authorizeUrl, state } = await api('/api/baidu/code/start', { method: 'POST' });
    const url = new URL(authorizeUrl);
    if (url.origin !== 'https://openapi.baidu.com' || url.pathname !== '/oauth/2.0/authorize' ||
        url.searchParams.get('redirect_uri') !== 'oob' || typeof state !== 'string' || !state) {
      throw new InterfaceError('无法打开百度授权页面。', 'Could not open the Baidu authorization page.');
    }
    const link = document.createElement('a');
    link.className = 'simple-link';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.href = url.href;
    link.textContent = t('打开百度授权页面', 'Open Baidu Authorization Page');
    $('[data-baidu-code-link]', form).replaceChildren(link);
    form.dataset.state = state;
    form.elements.code.disabled = false;
    $('button[type=submit]', form).disabled = false;
    $('[role=status]', form).textContent = '';
  } catch (error) { baiduCodeError(form, error); }
}
function baiduCodeError(form, error) {
  $('[role=status]', form).textContent = displayError(error, t('百度授权失败，请重试。', 'Baidu authorization failed. Try again.'));
  $('[data-action=baidu-code]', form).hidden = false;
}
async function baiduDeviceDialog() {
  openDialog(t('百度设备授权', 'Baidu Device Authorization'), '<div data-baidu-device>' +
    '<p class="dialog-message">' + t('在百度页面登录并输入设备码。授权后，播放器会自动连接。',
      'Sign in on the Baidu page and enter the device code. The player connects automatically once you authorize access.') + '</p>' +
    '<p class="dialog-message" data-baidu-device-details hidden>' + t('设备码', 'Device code') + ' <code></code></p>' +
    '<p class="dialog-message" role="status">' + t('正在获取设备码…', 'Getting a device code…') + '</p>' +
    '<div class="actions">' + btn(t('重新获取设备码', 'Get a New Device Code'), 'refresh-cw', 'baidu-device', 'hidden') + '</div></div>');
  const panel = $('[data-baidu-device]', dialog);
  const status = $('[role=status]', panel);
  const isOpen = () => dialog.open && dialog.contains(panel);
  let link;
  try {
    const { state, userCode, verificationUrl, expiresIn, interval } = await api('/api/baidu/device/start', { method: 'POST' });
    if (!isOpen()) return;
    const url = new URL(verificationUrl);
    if (url.href !== 'https://openapi.baidu.com/device' || !/^[A-Za-z0-9-]{4,32}$/.test(userCode) ||
        !/^[A-Za-z0-9_-]{43}$/.test(state) || !Number.isFinite(expiresIn) || !Number.isFinite(interval)) {
      throw new InterfaceError('百度返回了无法使用的设备授权页面。', 'Baidu returned an invalid device authorization page.');
    }
    const details = $('[data-baidu-device-details]', panel);
    $('code', details).textContent = userCode;
    details.hidden = false;
    link = document.createElement('a');
    link.className = 'btn primary';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.href = url.href;
    link.textContent = t('打开百度设备授权页面', 'Open Baidu Device Authorization Page');
    $('.actions', panel).prepend(link);
    status.textContent = t('正在等待百度确认授权…', 'Waiting for authorization from Baidu…');
    const expiresAt = Date.now() + expiresIn * 1000;
    let retryAfter = interval;
    while (isOpen() && Date.now() < expiresAt) {
      await new Promise(resolve => setTimeout(resolve, Math.max(5, retryAfter) * 1000));
      if (!isOpen()) return;
      if (Date.now() >= expiresAt) break;
      const result = await api('/api/baidu/device/poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }),
      });
      if (result.status === 'authorized') return finishBaiduAuthorization(panel);
      retryAfter = Number.isFinite(result.retryAfter) ? result.retryAfter : interval;
    }
    if (isOpen()) throw new InterfaceError('设备码已过期，请重新获取。', 'The device code expired. Get a new code.');
  } catch (error) {
    if (!isOpen()) return;
    status.textContent = displayError(error, t('百度设备授权失败，请重试。', 'Baidu device authorization failed. Try again.'));
    link?.remove();
    $('[data-baidu-device-details]', panel).hidden = true;
    $('[data-action=baidu-device]', panel).hidden = false;
  }
}
async function finishBaiduAuthorization(panel) {
  const stillOpen = dialog.open && dialog.contains(panel);
  if (stillOpen) dialog.close();
  await refreshSources();
  if (stillOpen && !dialog.open) await openCloud('baidu');
}
async function completeBaiduCode(form, data) {
  const state = form.dataset.state;
  const code = data.code.trim();
  if (!state || !code) return;
  form.elements.code.value = '';
  form.elements.code.disabled = true;
  $('button[type=submit]', form).disabled = true;
  $('[data-baidu-code-link]', form).replaceChildren();
  $('[role=status]', form).textContent = t('正在连接百度网盘…', 'Connecting to Baidu Netdisk…');
  try {
    await api('/api/baidu/code/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, code }),
    });
    await finishBaiduAuthorization(form);
  } catch (error) { baiduCodeError(form, error); }
}
async function oauthSource(id) {
  if (!cloudProviderIds.includes(id)) return;
  try { cloudStatus[id] = await api(sourceEndpoint(id, 'status')); }
  catch (error) { return announce(displayError(error, t('无法读取网盘连接状态。', 'Could not check the cloud drive connection.'))); }
  if (cloudStatus[id].connected) return openCloud(id);
  const name = providerLabel(id);
  const prefix = id.toUpperCase();
  const issuer = ({ gdrive: 'Google', onedrive: 'Microsoft' })[id] || name;
  const developerPage = ({ gdrive: 'https://console.cloud.google.com/apis/credentials', onedrive: 'https://entra.microsoft.com/', dropbox: 'https://www.dropbox.com/developers/apps', box: 'https://app.box.com/developers/console', pcloud: 'https://docs.pcloud.com/', aliyundrive: 'https://www.alipan.com/developer', drive123: 'https://123yunpan.yuque.com/org-wiki-123yunpan-muaork/cr6ced/kf05anzt1r0qnudd', drive115: 'https://www.yuque.com/115yun/open', guangya: 'https://github.com/guangyapan/agent-skills' })[id];
  const secret = id === 'guangya' ? '' : prefix + '_CLIENT_SECRET';
  openDialog(t('连接 {name}', 'Connect {name}', { name }), cloudStatus[id].configured ?
    '<p class="dialog-message">' + t('前往 {issuer} 登录并授权读取云端音频。', 'Sign in with {issuer} and authorize access to your cloud audio.', { issuer }) +
    (id === 'drive123' ? t(' 123 云盘的固定授权包含文件写入权限；播放器仅调用读取接口。',
      ' The standard 123 Cloud Drive grant includes permission to write files. The player only reads files.') : '') +
    '</p><div class="actions">' +
    btn(t('前往 {issuer} 授权', 'Authorize with {issuer}', { issuer }), 'cloud', 'oauth-authorize', key(id), true) + '</div>' :
    '<p class="dialog-message">' + t('服务端尚未配置 {issuer} OAuth 应用。请在 .env 中设置 {prefix}_CLIENT_ID、{secret}{prefix}_REDIRECT_URI，然后重启。',
      'The server has no {issuer} OAuth app configured. Set {prefix}_CLIENT_ID{secret} and {prefix}_REDIRECT_URI in .env, then restart the server.',
      { issuer, prefix, secret: secret ? t('{key}、', ', {key},', { key: secret }) : '' }) + '</p>' +
    '<a href="' + developerPage + '" rel="noreferrer" target="_blank" class="simple-link">' + t('查看开发者凭据', 'View Developer Credentials') + '</a>');
}
function addSource() {
  const choices = Object.keys(providerNames).filter(type => !cloudProviderIds.includes(type)).map(type =>
    '<option value="' + type + '">' + esc(providerLabel(type)) + '</option>').join('');
  openDialog(t('添加媒体服务器', 'Add Media Server'), '<form class="dialog-inner" data-form="source" style="padding:0">' +
    '<label class="dialog-field">' + t('协议', 'Protocol') + '<select name="type" required>' + choices + '</select></label>' +
    '<p class="dialog-message" data-source-hint></p>' +
    '<label class="dialog-field">' + t('名称', 'Name') + '<input name="name" maxlength="80" placeholder="' + t('例如 家庭音乐库', 'e.g. Home Music Library') + '"></label>' +
    '<label class="dialog-field">' + t('服务地址', 'Server URL') + '<input required name="url" type="url" placeholder="' +
      t('https://nas.example.com/music 或 smb://nas/Music', 'https://nas.example.com/music or smb://nas/Music') + '"></label>' +
    '<label class="dialog-field">' + t('用户名', 'Username') + '<input name="username" autocomplete="username"></label>' +
    '<label class="dialog-field">' + t('密码', 'Password') + '<input name="password" type="password" autocomplete="current-password"></label>' +
    '<label class="dialog-field">' + t('访问令牌', 'Access Token') + '<input name="token" type="password" autocomplete="off"></label>' +
    '<label class="dialog-field">' + t('用户 ID', 'User ID') + '<input name="userId" placeholder="' +
      t('Jellyfin / Emby 令牌可选', 'Optional for Jellyfin or Emby tokens') + '"></label>' +
    '<div class="dialog-message" role="status"></div><div class="actions"><button class="btn primary" type="submit">' + t('连接', 'Connect') +
    '</button>' + btn(t('使用 Plex 账号登录', 'Sign in with Plex'), 'log-in', 'plex-sign-in', 'hidden') + '</div></form>');
}
const plexAuthorizationApi = '/api/sources/plex-auth/';
async function startPlexSignIn(button) {
  const form = button.form;
  if (!form || form.elements.type.value !== 'plex' || button.disabled) return;
  const status = $('[role=status]', form);
  const data = { name: form.elements.name.value, url: form.elements.url.value };
  if (data.url && !form.elements.url.reportValidity()) return;
  button.disabled = true;
  status.textContent = t('正在打开 Plex 登录…', 'Opening Plex sign-in…');
  try {
    const { authUrl } = await api(plexAuthorizationApi + 'start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    const target = new URL(authUrl);
    if (target.origin !== 'https://app.plex.tv' || target.pathname !== '/auth' || target.username || target.password ||
        target.search || !target.hash.startsWith('#?')) throw new InterfaceError('Plex 登录地址无效。', 'Invalid Plex sign-in address.');
    if (dialog.open && dialog.contains(form)) location.assign(target.href);
  } catch (error) {
    status.textContent = displayError(error, t('无法打开 Plex 登录。', 'Could not open Plex sign-in.'));
  } finally { button.disabled = false; }
}
async function choosePlexServer() {
  openDialog(t('选择 Plex 服务器', 'Choose a Plex Server'), '<div data-plex-server-picker><p class="dialog-message" role="status">' +
    t('正在读取 Plex 服务器…', 'Loading Plex servers…') + '</p><div class="dialog-options" data-plex-options></div>' +
    btn(t('重新登录 Plex', 'Sign In to Plex Again'), 'refresh-cw', 'plex-sign-in-again') + '</div>');
  const panel = $('[data-plex-server-picker]', dialog);
  const status = $('[role=status]', panel);
  try {
    const { choices } = await api(plexAuthorizationApi + 'choices', { method: 'POST' });
    if (!dialog.open || !dialog.contains(panel)) return;
    $('[data-plex-options]', panel).innerHTML = choices.map(choice =>
      btn([choice.name, choice.url].filter(Boolean).join(' · '), 'server', 'connect-plex-server', key(choice.id), choice.preferred)).join('');
    status.textContent = choices.length ? '' : t('此账号没有可连接的 Plex 服务器。', 'This account has no available Plex servers.');
  } catch (error) { status.textContent = displayError(error, t('无法读取 Plex 服务器。', 'Could not load Plex servers.')); }
}
async function connectPlexServer(button) {
  const panel = button.closest('[data-plex-server-picker]');
  if (!panel || panel.dataset.connecting) return;
  const status = $('[role=status]', panel);
  panel.dataset.connecting = 'true';
  button.disabled = true;
  status.textContent = t('正在连接 Plex 服务器…', 'Connecting to Plex server…');
  try {
    const { source } = await api(plexAuthorizationApi + 'connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: button.dataset.id }),
    });
    sources = [...sources.filter(item => item.id !== source.id), source];
    schedulePlaylistSync(0);
    if (dialog.open && dialog.contains(panel)) dialog.close();
    await openCloud(source.id);
  } catch (error) {
    status.textContent = displayError(error, t('无法连接 Plex 服务器。', 'Could not connect to Plex server.'));
  } finally { delete panel.dataset.connecting; button.disabled = false; }
}
function openDialog(title, body) {
  dialogRevision++;
  dialog.innerHTML = '<div class="dialog-inner"><div class="dialog-head"><h2>' + esc(title) + '</h2>' +
    tool(t('关闭', 'Close'), 'x', 'close-dialog') + '</div>' + body + '</div>';
  if (!dialog.open) dialog.showModal();
}
function playlistDialog(existing) {
  openDialog(existing ? t('重命名歌单', 'Rename Playlist') : t('新建歌单', 'New Playlist'),
    '<form class="dialog-inner" data-form="playlist" style="padding:0" data-id="' + esc(existing?.id) + '">' +
    '<label class="dialog-field">' + t('歌单名称', 'Playlist name') + '<input name="name" required autofocus maxlength="80" value="' + esc(existing?.name) +
    '" placeholder="' + t('输入歌单名称', 'Enter a playlist name') + '"></label><button type="submit" class="btn primary">' +
    (existing ? t('保存', 'Save') : t('创建', 'Create')) + '</button></form>');
}
const playlistOverviewLabels = {
  manual: ['手动顺序', 'Manual Order'],
  name: ['名称（升序）', 'Name (A–Z)'],
  'name-desc': ['名称（降序）', 'Name (Z–A)'],
  'created-at': ['创建时间（最早优先）', 'Creation Date (Oldest First)'],
  'created-at-desc': ['创建时间（最新优先）', 'Creation Date (Newest First)'],
  'modified-at-desc': ['修改时间（最新优先）', 'Modification Date (Newest First)'],
};
function overviewPlaylists() {
  return sortPlaylistOverview(state.playlists, state.settings.playlistOverviewOrder, {
    compareNames: textOrder, createdAt: playlistCreationDates, modifiedAt: playlistModificationDates,
  });
}
function createLocalPlaylist(name, tracks) {
  const list = { id: crypto.randomUUID(), name, tracks };
  state.playlists.unshift(list);
  return list;
}
function savedPlaylistDates(playlists, dates) {
  return playlists.flatMap(list => dates.has(list?.id) ? [[list.id, dates.get(list.id)]] : []);
}
function serializePlaylistDates({ createdAt = playlistCreationDates, modifiedAt = playlistModificationDates } = {}, playlists = state.playlists) {
  return {
    playlistCreationDates: savedPlaylistDates(playlists, createdAt),
    playlistModificationDates: savedPlaylistDates(playlists, modifiedAt),
  };
}
function importedPlaylistDates({ playlistCreationDates, playlistModificationDates }, playlists) {
  return {
    createdAt: readPlaylistCreationDates(playlistCreationDates, playlists),
    modifiedAt: readPlaylistCreationDates(playlistModificationDates, playlists),
  };
}
function playlistStorageFingerprint(value) {
  const playlists = Array.isArray(value.playlists) ? value.playlists : [];
  const favorites = Array.isArray(value.favorites) ? value.favorites : [];
  const dates = serializePlaylistDates(importedPlaylistDates(value, playlists), playlists);
  return JSON.stringify([playlists, favorites, dates]);
}
function checkPlaylistStorage() {
  if (cloudCatalogScopeStale || stateScopeReadError) return false;
  try {
    if (!playlistStorageStale) playlistStorageStale = playlistStorageFingerprint(readState()) !== persistedPlaylistState;
  } catch (error) { stateScopeReadError = error; return false; }
  return !playlistStorageStale;
}
function requireCurrentPlaylistStorage() {
  if (!checkPlaylistStorage()) throw new InterfaceError('本机歌单或收藏已变化，请刷新页面后恢复。',
    'Local playlists or favorites changed. Reload the page before restoring.');
}
function currentPlaylistSnapshot(dates) {
  return playlistSnapshot({ ...state, ...serializePlaylistDates(dates) });
}
function reorderPlaylistsDialog(focus) {
  const order = state.settings.playlistOverviewOrder;
  const options = playlistOverviewOrders.map(value => '<option value="' + value + '"' + (value === order ? ' selected' : '') + '>' +
    t(...playlistOverviewLabels[value]) + '</option>').join('');
  const sort = '<label class="dialog-field">' + t('歌单排序', 'Playlist Sort') +
    '<select id="playlist-overview-sort">' + options + '</select></label>' +
    (order === 'manual' ? '' : '<p class="dialog-message">' +
      t('选择「手动顺序」可移动歌单。', 'Choose Manual Order to move playlists.') + '</p>');
  openDialog(t('调整歌单顺序', 'Reorder Playlists'), sort + '<ol class="playlist-order-list">' + overviewPlaylists().map((list, index) => {
    const attrs = key(list.id);
    const manualControls = order === 'manual' ? '<div>' +
      tool(t('上移 {name}', 'Move {name} up', { name: list.name }), 'chevron-up', 'playlist-up', attrs + (index === 0 ? ' disabled' : '')) +
      tool(t('下移 {name}', 'Move {name} down', { name: list.name }), 'chevron-down', 'playlist-down',
        attrs + (index + 1 === state.playlists.length ? ' disabled' : '')) + '</div>' : '';
    return '<li><span>' + esc(list.name) + '</span>' + manualControls + '</li>';
  }).join('') + '</ol>');
  if (focus === 'sort') $('#playlist-overview-sort', dialog)?.focus();
  else if (focus) {
    const controls = $$('button[data-id]:enabled', dialog).filter(button => button.dataset.id === focus.id);
    (controls.find(button => button.dataset.action === focus.action) || controls[0])?.focus();
  }
}
function movePlaylist(target, step) {
  if (state.settings.playlistOverviewOrder !== 'manual') return;
  const index = state.playlists.findIndex(list => list.id === target.dataset.id);
  const next = index + step;
  if (index < 0 || next < 0 || next >= state.playlists.length) return;
  [state.playlists[index], state.playlists[next]] = [state.playlists[next], state.playlists[index]];
  save();
  render();
  reorderPlaylistsDialog({ id: target.dataset.id, action: target.dataset.action });
}
function visiblePlaylistPositions(playlist) {
  // Tracks imported on another device can still occupy positions in a synced playlist.
  const visibleIds = new Set(rows.map(track => track.id));
  return playlist.tracks.flatMap((id, position) => visibleIds.has(id) ? [position] : []);
}
function movePlaylistTrack(index, step) {
  if (!playlistOrdering || !canReorderPlaylistSelection()) return;
  const playlist = state.playlists.find(item => item.id === route.slice(9));
  if (!playlist) return;
  const positions = visiblePlaylistPositions(playlist);
  const nextIndex = index + step;
  if (positions[index] === undefined || positions[nextIndex] === undefined) return;
  const from = positions[index];
  const to = positions[nextIndex];
  if (localPlaylistSlots.has(playlist.id)) swapPlaylistSlots(slotsForLocalPlaylist(playlist), from, to);
  [playlist.tracks[from], playlist.tracks[to]] = [playlist.tracks[to], playlist.tracks[from]];
  save();
  render();
  const row = $$('tbody tr', content)[nextIndex];
  if (!row) return;
  const direction = step < 0 ? 'up' : 'down';
  ($('[data-action=playlist-track-' + direction + ']:enabled', row) || $('.row-actions button:enabled', row))?.focus();
}
function movePlaylistSelection(step) {
  if (!selectionMode || !canReorderPlaylistSelection()) return;
  const playlist = state.playlists.find(item => item.id === route.slice(9));
  if (!playlist) return;
  const positions = visiblePlaylistPositions(playlist);
  const anchor = rows[selectionAnchor]?.id;
  let moved = false;
  // Visit from the destination edge so adjacent selected tracks retain their order.
  for (let index = step < 0 ? 1 : positions.length - 2; index >= 0 && index < positions.length; index -= step) {
    const position = positions[index];
    const destination = positions[index + step];
    if (!selectedTrackIds.has(playlist.tracks[position]) || selectedTrackIds.has(playlist.tracks[destination])) continue;
    if (localPlaylistSlots.has(playlist.id)) swapPlaylistSlots(slotsForLocalPlaylist(playlist), position, destination);
    [playlist.tracks[position], playlist.tracks[destination]] = [playlist.tracks[destination], playlist.tracks[position]];
    moved = true;
  }
  if (!moved) return;
  save();
  render();
  selectionAnchor = rows.findIndex(track => track.id === anchor);
  ($('[data-selection-step="' + step + '"]:enabled', content) || $('[data-selection-step]:enabled', content))?.focus({ preventScroll: true });
}
function compatibleTrackIsCurrent(track) {
  return player.getState().track?.id === track?.id && audio.src === compatibleMedia.get(track?.id)?.url;
}
function originalAudioMenuItem(track) {
  return compatibleTrackIsCurrent(track)
    ? menuItem(t('切回原始音源', 'Return to Original Audio'), 'audio-lines', 'original-audio', track.id)
    : '';
}
function trackMenu(track) {
  if (!track) return;
  const serverPlaylist = editableServerTrack(track);
  const removed = state.removedLibraryTracks.has(track.id);
  const libraryAction = removed
    ? (sourceVisibleInCatalog(librarySourceId(track))
      ? menuItem(t('加回曲库', 'Add Back to Library'), 'list-plus', 'restore-library-track', track.id) : '')
    : (track.provider !== 'demo' ? menuItem(t('从曲库移除', 'Remove from Library'), 'trash-2', 'remove-track', track.id) : '');
  openDialog(track.title, '<div class="dialog-options">' +
    menuItem(t('下一首播放', 'Play Next'), 'list-start', 'enqueue-next', track.id) +
    menuItem(t('添加到播放队列', 'Add to Queue'), 'list-end', 'enqueue', track.id) +
    menuItem(t('添加到歌单', 'Add to Playlist'), 'list-plus', 'pick-playlist', track.id) +
    (serverPlaylist ? menuItem(t('添加到 {name} 歌单', 'Add to {name} Playlist', { name: providerLabel(track.provider) }),
      'list-music', 'pick-' + track.provider + '-playlist', track.id) : '') +
    menuItem(fav(track.id) ? t('取消收藏', 'Remove from Favorites') : t('收藏歌曲', 'Add to Favorites'), 'heart', 'favorite-menu', track.id) +
    libraryAction +
    (track.provider !== 'demo' ? originalAudioMenuItem(track) ||
      menuItem(t('兼容播放', 'Play Compatible Version'), 'audio-lines', 'compatible-play', track.id) : '') +
    (artworkCanBeLookedUp(track) ? menuItem(t('查找在线封面', 'Find Cover Online'), 'image', 'match-online-cover', track.id) : '') +
    (validCloudTrack(track) ? menuItem(t('读取音频标签', 'Read Audio Tags'), 'tag', 'read-tags', track.id) : '') +
    (canSaveOriginalAudio(track) ? menuItem(t('保存原始音频到本机', 'Save Original Audio to Device'), 'download', 'save-original-audio', track.id) : '') +
    (route.startsWith('playlist/') ? menuItem(t('从歌单移除', 'Remove from Playlist'), 'list-minus', 'remove-from-playlist', track.id) : '') +
    (track.provider !== 'demo' && track.provider !== 'local' ? (hasOffline(track.id) ?
      (offlineTrackMode(track.id) === 'automatic' ? menuItem(t('固定离线副本', 'Keep Offline Copy'), 'pin', 'pin-offline', track.id) : '') +
      menuItem(t('删除离线副本', 'Remove Offline Copy'), 'cloud-off', 'drop-offline', track.id) :
      menuItem(t('离线保存', 'Save for Offline Playback'), 'download', 'cache-offline', track.id)) : '') + '</div>');
}
function menuItem(label, glyph, action, id) {
  return '<button type="button" data-action="' + action + '" ' + key(id) + '>' + icon(glyph) + esc(label) + '</button>';
}
function playlistPicker(trackId = '', multiple = false) {
  const lists = sortPlaylistOverview(state.playlists, 'created-at-desc', { createdAt: playlistCreationDates });
  const options = lists.map(list => multiple
    ? '<label class="playlist-choice"><input type="checkbox" name="playlist" value="' + esc(list.id) + '">' + esc(list.name) + '</label>'
    : menuItem(list.name, 'list-music', 'add-to-playlist', list.id)).join('');
  const mode = lists.length > 1 ? '<div class="actions">' +
    btn(multiple ? t('结束多选', 'Done Selecting') : t('多选歌单', 'Select Playlists'),
      'list-checks', 'playlist-picker-mode', 'aria-pressed="' + multiple + '"') +
    (multiple ? '<span role="status" data-playlist-choice-count></span>' : '') + '</div>' : '';
  openDialog(t('添加到歌单', 'Add to Playlist'),
    '<form class="playlist-picker" data-form="pick-local-playlists" data-track-id="' + esc(trackId) + '">' + mode +
    '<div class="dialog-options">' + (options || '<p class="dialog-message">' +
      t('先创建一个歌单。', 'Create a playlist first.') + '</p>') +
    (multiple ? '' : menuItem(t('新建歌单', 'New Playlist'), 'plus', 'new-playlist-from-picker', '')) + '</div>' +
    (multiple ? '<button type="submit" class="btn primary" disabled>' + t('添加到所选歌单', 'Add to Selected Playlists') + '</button>' : '') + '</form>');
  const form = $('[data-form="pick-local-playlists"]', dialog);
  if (multiple) updatePlaylistChoiceCount(form);
  $('[data-action="playlist-picker-mode"]', form)?.focus();
}
function updatePlaylistChoiceCount(form) {
  const count = $$('input[name=playlist]:checked', form).length;
  $('[data-playlist-choice-count]', form).textContent = t('已选 {playlists} 个歌单', '{playlists} selected', { playlists: count });
  $('button[type=submit]', form).disabled = count === 0;
}
function addToLocalPlaylists(form, ids) {
  const chosen = new Set(ids);
  const lists = state.playlists.filter(list => chosen.has(list.id));
  const track = form.dataset.trackId && find(form.dataset.trackId);
  const tracks = form.dataset.trackId ? (track ? [track] : []) : selectedTracks();
  if (!lists.length || !tracks.length) return;
  tracks.forEach(remember);
  const trackIds = [...new Set(tracks.map(item => item.id))];
  for (const list of lists) {
    const existing = new Set(list.tracks);
    list.tracks = [...list.tracks, ...trackIds.filter(id => !existing.has(id))];
  }
  dialog.close(); save(); refreshCurrent();
  const name = lists[0].name;
  announce(lists.length === 1 ? t('已添加到「{name}」', 'Added to “{name}”', { name }) :
    t('已添加到 {count} 个歌单', 'Added to {count} playlists', { count: lists.length }));
}
const serverPlaylistDialogScopes = new WeakMap();
const activeServerPlaylistWrites = new Set();
function canCreateServerPlaylist(source, view) {
  return view?.trail.at(-1).path === 'playlists' &&
    (source?.type === 'emby' || (source?.type === 'jellyfin' && source.playlistWritable === true));
}
function canEditServerPlaylist(source, view) {
  return view?.serverOrder && (source?.type === 'emby' || (source?.type === 'jellyfin' && view.playlistWritable === true));
}
function jellyfinPlaylistAuthorityNotice(source) {
  return source.type === 'jellyfin' && source.playlistAuthority === 'api-key' ? '<p class="hint">' +
    esc(t('添加歌曲需要指定用户有歌单编辑权限。移除歌曲使用管理员 API 密钥。',
      'Adding tracks requires the selected user’s playlist edit permission. Removing tracks uses the administrator API key.')) + '</p>' : '';
}
function jellyfinRemovalCount(item) {
  return typeof item?.playlistRemoveEntry === 'string' && item.playlistRemoveEntry &&
    Number.isSafeInteger(item.playlistRemoveCount) && item.playlistRemoveCount > 1 ? item.playlistRemoveCount : undefined;
}
const jellyfinGroupRemovalLabel = count => t('移除此歌曲的所有条目（当前 {count} 项）', 'Remove All Occurrences (currently {count})', { count });
function editableServerTrack(track) {
  if (!playlistWriterTypes.has(track?.provider)) return;
  const match = /^\/api\/sources\/([0-9a-f-]{36})\/stream\?id=([\w-]+)$/.exec(track.src);
  const source = match && sources.find(source => source.id === match[1] && source.type === track.provider);
  if (source?.type === 'emby' || source?.playlistWritable === true) return { source, trackId: match[2] };
}
function scopeServerPlaylistDialog(node, context) {
  serverPlaylistDialogScopes.set(node, { ...context, route, view: route.startsWith('source/') ? cloud : undefined });
}
function currentServerPlaylistDialog(node, provider) {
  const context = serverPlaylistDialogScopes.get(node);
  if (context?.source.type !== provider || !dialog.open || !dialog.contains(node)) return;
  if (route !== context.route || (context.view && context.view !== cloud) || !sources.includes(context.source)) {
    dialog.close();
    return;
  }
  return context;
}
async function pickServerPlaylist(track, provider) {
  const reference = editableServerTrack(track);
  if (reference?.source.type !== provider) return;
  openDialog(t('添加到 {name} 歌单', 'Add to {name} Playlist', { name: providerLabel(provider) }),
    jellyfinPlaylistAuthorityNotice(reference.source) + '<div class="dialog-options" data-server-playlist-choices role="status">' +
    esc(t('正在读取服务器歌单…', 'Loading server playlists…')) + '</div>');
  const choices = $('[data-server-playlist-choices]', dialog);
  scopeServerPlaylistDialog(choices, reference);
  try {
    const { items } = await api(sourceEndpoint(reference.source.id, 'list') + '?path=playlists');
    const context = currentServerPlaylistDialog(choices, provider);
    if (!context) return;
    const allowed = (items || []).filter(item => item.folder && typeof item.path === 'string' &&
      (provider === 'emby' || item.playlistWritable === true));
    context.playlists = new Map(allowed.map(item => [item.path, item]));
    choices.innerHTML = allowed.map(item => btn(item.name, 'list-music', 'add-' + provider + '-playlist-entry', key(item.path))).join('') ||
      '<p class="dialog-message">' + esc(provider === 'emby' ? t('服务器没有可访问的歌单', 'The server has no accessible playlists') :
        t('服务器没有可编辑的歌单', 'The server has no editable playlists')) + '</p>';
  } catch (error) {
    if (currentServerPlaylistDialog(choices, provider)) {
      choices.textContent = displayError(error, t('无法读取服务器歌单。', 'Could not load server playlists.'));
    }
  }
}
function writeServerPlaylist(sourceId, path, payload) {
  return api(sourceEndpoint(sourceId, 'playlist') + '?' + new URLSearchParams({ path }), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
}
function serverPlaylistOutcomeUnknown(provider, error) {
  return provider === 'jellyfin' && (!error.status || error.code === 'playlist_commit_unknown');
}
function announceUnknownServerPlaylistOutcome() {
  announce(t('Jellyfin 未确认此次歌单操作的结果。请查看服务器歌单后再试。',
    'Jellyfin did not confirm the result. Check the server playlist before trying again.'));
}
function serverPlaylistActions(provider) {
  return {
    ['pick-' + provider + '-playlist']: target => void pickServerPlaylist(find(target.dataset.id), provider),
    ['new-' + provider + '-playlist']: () => newServerPlaylist(provider),
    ['add-' + provider + '-playlist-entry']: target => void updateServerPlaylist(target, provider, 'add'),
    ['remove-' + provider + '-playlist-entry']: target => void updateServerPlaylist(target, provider, 'remove'),
  };
}
function confirmJellyfinGroupRemoval(button) {
  const view = cloud;
  const source = sources.find(item => item.id === view?.id && item.type === 'jellyfin');
  if (!source || route !== 'source/' + source.id || !canEditServerPlaylist(source, view) || !content.contains(button)) return;
  const entryId = button.dataset.id;
  const item = view.items.find(item => item.playlistRemoveEntry === entryId && jellyfinRemovalCount(item));
  if (!item) return;
  const count = item.playlistRemoveCount;
  const action = 'confirm-remove-jellyfin-playlist-entries';
  confirmAction(jellyfinGroupRemovalLabel(count),
    t('从此 Jellyfin 歌单移除「{title}」的所有条目？当前有 {count} 项。',
      'Remove all occurrences of “{title}” from this Jellyfin playlist? There are currently {count}.',
      { count, title: item.title || item.name }), action);
  scopeServerPlaylistDialog($('[data-action="' + action + '"]', dialog), { source, entryId, count });
}
async function updateServerPlaylist(button, provider, action) {
  const view = cloud;
  const add = action === 'add';
  const group = action === 'remove-group';
  const picker = add ? button.closest('[data-server-playlist-choices]') : group ? button : undefined;
  const context = picker && currentServerPlaylistDialog(picker, provider);
  const source = add || group ? context?.source : sources.find(item => item.id === view?.id && item.type === provider);
  if (!source || button.disabled) return;
  const id = group ? context.entryId : button.dataset.id;
  const destination = add ? context.playlists?.get(id) : undefined;
  if (add) {
    if (!destination) return;
  } else if (route !== 'source/' + source.id || !canEditServerPlaylist(source, view) ||
      (!group && !content.contains(button)) || !view.items.some(item => cloudTrackItem(item) && (group
        ? item.playlistRemoveEntry === id && jellyfinRemovalCount(item) === context.count : item.playlistEntry === id))) return;
  const path = add ? id : view.trail.at(-1).path;
  const mutation = serverPlaylistMirrorId(source.id, path);
  if (activeServerPlaylistWrites.has(mutation)) return;
  activeServerPlaylistWrites.add(mutation);
  button.disabled = true;
  const name = providerLabel(provider);
  const refreshPlaylist = async () => {
    if (cloud?.id === source.id && cloud.trail.at(-1).path === path && route === 'source/' + source.id) {
      await openCloud(source.id, false, cloud.trail);
    }
  };
  try {
    const payload = add ? { action: 'add', trackId: context.trackId } : { action: 'remove', entryId: id };
    const { updated } = await writeServerPlaylist(source.id, path, payload);
    if (updated !== true) throw new Error();
    if (picker && currentServerPlaylistDialog(picker, provider)) dialog.close();
    if (!sources.includes(source)) return;
    await refreshPlaylist();
    announce(add ? t('已添加到 {name} 歌单。', 'Added to the {name} playlist.', { name }) : group
      ? t('已从 Jellyfin 歌单移除此歌曲的全部条目。', 'Removed all occurrences of this track from the Jellyfin playlist.')
      : t('已从 {name} 歌单移除。', 'Removed from the {name} playlist.', { name }));
  } catch (error) {
    if (!sources.includes(source)) return;
    if (serverPlaylistOutcomeUnknown(provider, error)) {
      const stillOpen = picker && currentServerPlaylistDialog(picker, provider);
      if (stillOpen) dialog.close();
      if (add && stillOpen) {
        await openCloud(source.id, true, [{ name: '根目录', path: '/' }, { path: 'playlists' }, destination]);
      } else await refreshPlaylist();
      return announceUnknownServerPlaylistOutcome();
    }
    if (provider === 'jellyfin' && [403, 404, 409].includes(error.status)) {
      if (picker && currentServerPlaylistDialog(picker, provider)) dialog.close();
      await refreshPlaylist();
    }
    announce(displayError(error, t('无法更新 {name} 歌单。', 'Could not update the {name} playlist.', { name })));
  } finally {
    activeServerPlaylistWrites.delete(mutation);
    button.disabled = false;
  }
}
function newServerPlaylist(provider) {
  const source = sources.find(item => item.id === cloud?.id && item.type === provider);
  if (!source || route !== 'source/' + source.id || !canCreateServerPlaylist(source, cloud)) return;
  openDialog(t('新建 {name} 歌单', 'New {name} Playlist', { name: providerLabel(provider) }),
    '<form data-form="' + provider + '-create-playlist"><label class="dialog-field">' + t('歌单名称', 'Playlist name') +
    '<input name="name" required autofocus maxlength="80"></label><p class="dialog-message" role="status"></p>' +
    '<button class="btn primary" type="submit">' + t('创建歌单', 'Create Playlist') + '</button></form>');
  scopeServerPlaylistDialog($('form', dialog), { source });
}
async function createServerPlaylist(form, data, provider) {
  const context = currentServerPlaylistDialog(form, provider);
  if (!context || !canCreateServerPlaylist(context.source, context.view)) return;
  const { source, view } = context;
  const submit = $('button[type=submit]', form);
  const status = $('[role=status]', form);
  const mutation = serverPlaylistMirrorId(source.id, 'playlists');
  if (submit.disabled || activeServerPlaylistWrites.has(mutation)) return;
  activeServerPlaylistWrites.add(mutation);
  submit.disabled = true;
  status.textContent = t('正在创建歌单…', 'Creating playlist…');
  const name = providerLabel(provider);
  try {
    const { playlist } = await writeServerPlaylist(source.id, 'playlists', { action: 'create', name: data.name });
    if (playlist?.folder !== true || typeof playlist.path !== 'string' || !/^[\w-]+$/.test(playlist.path) ||
        typeof playlist.name !== 'string' || !playlist.name.trim()) throw new Error();
    if (currentServerPlaylistDialog(form, provider)) {
      dialog.close();
      await openCloud(source.id, false, [...view.trail, playlist]);
    }
    if (sources.includes(source)) announce(t('已创建 {name} 歌单。', 'Created {name} playlist.', { name }));
  } catch (error) {
    if (serverPlaylistOutcomeUnknown(provider, error) && sources.includes(source)) {
      if (currentServerPlaylistDialog(form, provider)) dialog.close();
      if (cloud?.id === source.id && cloud.trail.at(-1).path === 'playlists' && route === 'source/' + source.id) {
        await openCloud(source.id, false, cloud.trail);
      }
      return announceUnknownServerPlaylistOutcome();
    }
    if (currentServerPlaylistDialog(form, provider)) {
      status.textContent = displayError(error, t('无法创建 {name} 歌单。', 'Could not create the {name} playlist.', { name }));
    }
  } finally {
    activeServerPlaylistWrites.delete(mutation);
    submit.disabled = false;
  }
}
function confirmAction(title, message, action, id = '', controls = '') {
  openDialog(title, '<p class="dialog-message">' + esc(message) + '</p>' + controls + '<div class="actions">' +
    btn(t('取消', 'Cancel'), null, 'close-dialog') + btn(t('确认', 'Confirm'), 'check', action, key(id), true) + '</div>');
}
function confirmLibraryRemoval(tracks, multiple = false) {
  if (!tracks.length) return;
  if (!ready) return announce(t('正在读取本地音乐，请稍后重试。', 'Local music is still loading. Try again shortly.'));
  const controls = tracks.some(audioOnDevice)
    ? '<label class="playlist-choice"><input type="checkbox" id="remove-library-copy">' +
      t('同时移除播放器里的本地副本', 'Also remove local copies from Groovebox') + '</label>'
    : '';
  const count = tracks.length;
  confirmAction(t('移除歌曲', 'Remove Tracks'),
    t('确定从曲库、收藏和歌单中移除 {count} 首歌曲？设备和网盘上的原文件会保留。',
      'Remove {tracks} from the library, favorites, and playlists? Original files on your device and cloud drive stay in place.',
      { count, tracks: trackCount(count) }),
    multiple ? 'confirm-remove-library-selection' : 'confirm-remove-track', multiple ? '' : tracks[0].id, controls);
}
async function confirmAndRemoveLibraryTracks(tracks) {
  const removeAudio = $('#remove-library-copy', dialog)?.checked === true;
  dialog.close();
  let removed = 0;
  for (const track of tracks) {
    try { if (await forgetTrack(track.id, removeAudio)) removed++; } catch { /* Report the failed count below. */ }
  }
  const failed = tracks.length - removed;
  announce(t('已移除 {count} 首歌曲。', 'Removed {tracks}.', { count: removed, tracks: trackCount(removed) }) +
    (failed ? t('有 {count} 首移除失败。', ' Could not remove {tracks}.', { count: failed, tracks: trackCount(failed) }) : ''));
  if (removed) save();
  refreshCurrent();
}
function originalSound() {
  return Number(state.settings.speed) === 1 && !state.settings.replayGain &&
    (!state.settings.eqEnabled || !state.settings.eq.some(Boolean));
}
function selectedEqualizerPreset() {
  if (state.settings.eqProfile || state.settings.eqPreset === '') return '';
  return Object.keys(equalizerPresets).find(id => equalizerPresets[id].length === state.settings.eq.length &&
    equalizerPresets[id].every((value, index) => value === state.settings.eq[index])) || '';
}
function renderSettings() {
  const themeNames = { copper: 'Copper', lavender: 'Lavender', jade: 'Jade', ocean: 'Ocean blue', light: 'Light', system: 'System' };
  const playStyles = { circle: 'Circle', rounded: 'Rounded square', outline: 'Outlined circle' };
  const themeOptions = Object.entries(themes).map(([id, [name, color]]) =>
    '<button class="btn' + (state.settings.theme === id ? ' active' : '') + '" data-action="theme" ' + key(id) +
    '><span class="swatch" style="--swatch:' + color + '"></span>' + esc(t(name, themeNames[id])) + '</button>').join('');
  const languageOptions = Object.entries(languageNames).map(([id, name]) =>
    '<option value="' + id + '" lang="' + id + '"' + (state.settings.language === id ? ' selected' : '') + '>' + name + '</option>').join('');
  const buttonOptions = Object.entries(playButtonStyles).map(([id, name]) =>
    '<option value="' + id + '"' + (state.settings.playButtonStyle === id ? ' selected' : '') + '>' + t(name, playStyles[id]) + '</option>').join('');
  const speeds = [.5,.75,1,1.25,1.5,2].map(speed => '<option value="' + speed + '"' +
    (state.settings.speed === speed ? ' selected' : '') + '>' + speed + '×</option>').join('');
  const bitrateOptions = profile => streamBitrates.map(rate => '<option value="' + rate + '"' +
    (state.settings.streamBitrates[profile] === rate ? ' selected' : '') + '>' +
    (rate ? rate + ' kbps' : t('原始音源', 'Original audio')) + '</option>').join('');
  const networkOptions = [['auto', t('自动', 'Automatic')], ['wifi', 'Wi-Fi'], ['cellular', t('移动数据', 'Mobile data')]]
    .map(([value, label]) => '<option value="' + value + '"' +
      (state.settings.streamBitrates.network === value ? ' selected' : '') + '>' + label + '</option>').join('');
  const bands = activeEqBands(state.settings.eq).map((frequency, index) => {
    const value = state.settings.eq[index] || 0;
    return '<label>' + frequency + ' Hz <input type="range" min="-12" max="12" step="1" value="' + value + '" data-eq="' + index +
      '"><output>' + value + ' dB</output></label>';
  }).join('');
  const profileOptions = state.settings.eqProfiles.map(profile => {
    const id = profile.name.toLowerCase();
    return '<option value="' + esc(id) + '"' + (id === state.settings.eqProfile ? ' selected' : '') + '>' + esc(profile.name) + '</option>';
  }).join('');
  const appearance = `
    <section class="setting-card">
      <h2>${t('外观', 'Appearance')}</h2>
      <label>${t('界面语言', 'Interface language')} <select id="interface-language">${languageOptions}</select></label>
      <label><input type="checkbox" id="keep-topbar-visible"${state.settings.keepTopbarVisible !== false ? ' checked' : ''}>${t('滚动时固定顶部工具栏', 'Keep the top toolbar visible while scrolling')}</label>
      <div class="theme-choices">${themeOptions}</div>
      <div class="actions">
        ${btn(t('上传背景', 'Upload background'), 'image-plus', 'background-upload')}
        ${state.settings.background ? btn(t('还原背景', 'Reset background'), 'image-off', 'background-clear') : ''}
      </div>
      ${state.settings.background ? `
        <div class="background-adjust">
          <label>${t('背景模糊', 'Background blur')}
            <input id="background-blur" type="range" min="0" max="30" aria-label="${t('背景模糊', 'Background blur')}" value="${esc(state.settings.backgroundBlur)}">
            <output>${esc(state.settings.backgroundBlur)} px</output>
          </label>
          <label>${t('图片不透明度', 'Image opacity')}
            <input id="background-opacity" type="range" min="0" max="100" aria-label="${t('图片不透明度', 'Image opacity')}" value="${esc(state.settings.backgroundOpacity)}">
            <output>${esc(state.settings.backgroundOpacity)}%</output>
          </label>
        </div>` : ''}
      <label><input type="checkbox" id="compact-player"${state.settings.compactPlayer === true ? ' checked' : ''}>${t('使用迷你播放器', 'Use compact player')}</label>
      <label><input type="checkbox" id="multiline-track-titles"${state.settings.multilineTrackTitles === true ? ' checked' : ''}>${t('多行显示歌曲标题', 'Wrap long track titles')}</label>
      <label><input type="checkbox" id="lyric-blur"${state.settings.blurLyrics === true ? ' checked' : ''}>${t('模糊未播放歌词', 'Blur inactive lyrics')}</label>
      <label>${t('歌词字体粗细', 'Lyric font weight')} <select id="lyric-weight">${Object.entries(lyricWeights).map(([value, names]) =>
        '<option value="' + value + '"' + (state.settings.lyricWeight === value ? ' selected' : '') + '>' + t(...names) + '</option>').join('')}</select></label>
      <label>${t('播放按钮样式', 'Play button style')} <select id="play-button-style">${buttonOptions}</select></label>
      <label><input type="checkbox" id="play-button-cover-color"${state.settings.playButtonCoverColor === true ? ' checked' : ''}>${t('播放键颜色跟随封面', 'Match play button to cover')}</label>
    </section>`;
  const audioSettings = `
    <section class="setting-card">
      <h2>${t('音频', 'Audio')}</h2>
      <div class="actions">${btn(t('原声', 'Original sound'), null, 'original-sound', 'aria-pressed="' + originalSound() + '"', originalSound())}</div>
      <p>${t('原声使用 1× 播放速度、平直均衡和关闭 ReplayGain。开启音效时自动预留音量余量，降低削波风险。',
        'Original sound uses 1× speed, a flat equalizer and no ReplayGain. Audio effects leave headroom to reduce clipping.')}</p>
      <label>${t('播放速度', 'Playback speed')} <select id="speed">${speeds}</select></label>
      <h3>${t('媒体服务器码率', 'Media server bitrate')}</h3>
      <p>${t('应用于 Navidrome 和 Subsonic 的下一次串流。浏览器无法识别网络类型时，自动模式使用原始音源。',
        'Applies to the next Navidrome or Subsonic stream. Automatic mode uses original audio when the browser cannot identify the network type.')}</p>
      <label>${t('码率使用的网络类型', 'Bitrate network profile')} <select data-stream-bitrate="network">${networkOptions}</select></label>
      <label>${t('Wi-Fi 码率', 'Wi-Fi bitrate')} <select data-stream-bitrate="wifi">${bitrateOptions('wifi')}</select></label>
      <label>${t('移动数据码率', 'Mobile data bitrate')} <select data-stream-bitrate="cellular">${bitrateOptions('cellular')}</select></label>
      <label><input type="checkbox" id="open-playback-on-track"${state.settings.openPlaybackOnTrack === true ? ' checked' : ''}>${t('点击歌曲时打开播放详情', 'Open playback details when selecting a track')}</label>
      <label><input type="checkbox" id="open-playback-on-current-track"${state.settings.openPlaybackOnCurrentTrack === true ? ' checked' : ''}>${t('再次点击正在播放的歌曲时打开播放详情', 'Open playback details when reselecting the playing track')}</label>
      <label><input type="checkbox" id="restore-playback-progress"${state.settings.restorePlaybackProgress ? ' checked' : ''}>${t('打开播放器时恢复上次播放进度', 'Restore playback position when opening the player')}</label>
      <label><input type="checkbox" id="remember-playlist-position"${state.settings.rememberPlaylistPosition ? ' checked' : ''}>${t('记住每个歌单上次播放的歌曲', 'Remember the last track played in each playlist')}</label>
      <label><input type="checkbox" id="queue-all-direct-tracks"${state.settings.queueAllDirectTracks ? ' checked' : ''}>${t('直连歌单、专辑和艺人列表中点歌时将整组加入队列', 'Queue all tracks when selecting a song in a direct playlist, album, or artist list')}</label>
      <label><input type="checkbox" id="pause-in-background"${state.settings.pauseInBackground ? ' checked' : ''}>${t('切到后台时暂停播放', 'Pause when the player goes to the background')}</label>
      <label><input type="checkbox" id="show-album-track-progress"${state.settings.showAlbumTrackProgress ? ' checked' : ''}>${t('在专辑详情显示歌曲播放进度', 'Show track playback progress in albums')}</label>
      <label><input type="checkbox" id="replay-gain"${state.settings.replayGain ? ' checked' : ''}>${t('启用 ReplayGain', 'Enable ReplayGain')}</label>
      <label>${t('ReplayGain 模式', 'ReplayGain mode')} <select id="replay-gain-mode">
        <option value="track"${state.settings.replayGainMode === 'track' ? ' selected' : ''}>${t('曲目', 'Track')}</option>
        <option value="album"${state.settings.replayGainMode === 'album' ? ' selected' : ''}>${t('专辑', 'Album')}</option>
      </select></label>
      <label><input type="checkbox" id="fullscreen-lyrics-centered"${state.settings.fullscreenLyricsCentered ? ' checked' : ''}>${t('全屏歌词文字居中', 'Center fullscreen lyric text')}</label>
      <label>${t('逐字歌词效果', 'Word-by-word lyric effect')} <select id="lyric-word-mode">${[
        ['off', t('关闭', 'Off')], ['opacity-gradient', t('透明度渐变', 'Opacity gradient')],
        ['slide-uniform', t('匀速滑动', 'Slide uniform')], ['slide-accurate', t('准确滑动', 'Slide accurate')],
      ].map(([value, label]) => '<option value="' + value + '"' + (state.settings.lyricWordMode === value ? ' selected' : '') + '>' + esc(label) + '</option>').join('')}</select></label>
      <label><input type="checkbox" id="auto-match-lyrics"${state.settings.autoMatchLyrics === true ? ' checked' : ''}>${t('缺少歌词时自动在线匹配', 'Find missing lyrics automatically')}</label>
      <div class="actions">${btn(t('配置歌词 API', 'Configure Lyric API'), 'server', 'metadata-api-settings')}</div>
      <p>${t('开启后，播放器会向 LRCLIB 查询缺少歌词的曲目，发送歌曲名、艺人、专辑和时长。',
        'When enabled, the player sends the song title, artist, album and duration to LRCLIB to look up missing lyrics.')}</p>
      <div class="actions">${lyricOffsetButton()}${btn(t('清理歌词缓存', 'Clear Lyrics Cache'), 'trash-2', 'clear-lyrics-cache')}</div>
      <label><input type="checkbox" id="auto-read-tags"${state.settings.autoReadTags ? ' checked' : ''}>${t('播放时读取云端音频标签', 'Read cloud audio tags on playback')}</label>
      <label><input type="checkbox" id="keep-awake"${state.settings.keepAwake ? ' checked' : ''}${navigator.wakeLock ? '' : ' disabled'}>${t('播放时保持屏幕常亮', 'Keep screen awake during playback')}</label>
      <label><input type="checkbox" id="report-server-playback"${state.settings.reportServerPlayback === true ? ' checked' : ''}>${t('向媒体服务器报告播放完成', 'Report finished tracks to media servers')}</label>
      <p>${t('向 Navidrome、OpenSubsonic 或 Subsonic 回传自然播放结束的歌曲。服务器可按自己的设置同步到 Last.fm。',
        'Submit tracks that finish playing to Navidrome, OpenSubsonic, or Subsonic. The server may sync these plays to Last.fm if configured.')}</p>
      <label><input type="checkbox" id="report-emby-playback"${state.settings.reportEmbyPlayback === true ? ' checked' : ''}>${t('向 Emby 报告播放状态', 'Report playback state to Emby')}</label>
      <p>${t('向已连接的 Emby 回传播放开始、暂停、进度与停止。',
        'Send playback starts, pauses, progress, and stops to the connected Emby server.')}</p>
      <h3>ListenBrainz</h3>
      <p>${t('连接后，播放达到歌曲一半或 4 分钟时，会将歌名、艺人、专辑和收听时间发送到 ListenBrainz，以较早达到的条件为准。',
        'When connected, report the song, artist, album, and listening time after half the song or four minutes, whichever comes first.')}</p>
      <div class="actions">${listenBrainzAccount ? '<span>' + esc(t('已连接 {account}', 'Connected as {account}', { account: listenBrainzAccount })) +
        '</span>' + btn(t('断开 ListenBrainz', 'Disconnect ListenBrainz'), 'unlink', 'listenbrainz-disconnect') :
        btn(t('连接 ListenBrainz', 'Connect ListenBrainz'), 'link', 'listenbrainz-connect')}</div>
      <p id="wake-lock-status" role="status">${esc(screenLockStatus())}</p>
      <h3>${state.settings.eq.length === 5 ? t('五段均衡器', 'Five-band equalizer') : t('十段均衡器', 'Ten-band equalizer')}</h3>
      <label><input id="eq-enabled" type="checkbox"${state.settings.eqEnabled ? ' checked' : ''}>${t('启用均衡器', 'Enable equalizer')}</label>
      <p>${t('选择预设或松开滑块后应用。开启均衡器后才会改变声音。', 'Apply a preset or release a slider to save changes. Enable the equalizer to change the sound.')}</p>
      <label>${t('内置均衡器预设', 'Built-in equalizer preset')} <select id="eq-preset">
        <option value="" disabled${!selectedEqualizerPreset() ? ' selected' : ''}>${t('自定义', 'Custom')}</option>
        ${[['flat',t('平直','Flat')],['vocal',t('人声','Vocal')],['jazz',t('爵士','Jazz')],['rock',t('摇滚','Rock')],
          ['dance',t('舞曲','Dance')],['classical',t('古典','Classical')],['hip-hop',t('嘻哈','Hip-Hop')],['late-night',t('深夜','Late Night')]]
          .map(([value,label]) => '<option value="' + value + '"' + (selectedEqualizerPreset() === value ? ' selected' : '') + '>' + esc(label) + '</option>').join('')}
      </select></label>
      <label>${t('均衡器配置', 'Equalizer profile')} <select id="eq-profile">
        <option value="" disabled${state.settings.eqProfile ? '' : ' selected'}>${t('自定义', 'Custom')}</option>${profileOptions}
      </select></label>
      <div class="equalizer">${bands}</div>
      <div class="actions">
        ${btn(t('保存均衡器配置', 'Save equalizer profile'), null, 'eq-save')}
        ${btn(t('删除均衡器配置', 'Delete equalizer profile'), null, 'eq-delete', state.settings.eqProfile ? '' : 'disabled')}
        ${btn(t('重置均衡器', 'Reset equalizer'), 'rotate-ccw', 'eq-reset')}
      </div>
    </section>`;
  const librarySettings = `
    <section class="setting-card">
      <h2>${t('曲库', 'Library')}</h2>
      <label><input type="checkbox" id="demo-enabled"${state.settings.demos ? ' checked' : ''}>${t('显示原创演示歌曲', 'Show demo songs')}</label>
      <label><input type="checkbox" id="show-local-source"${state.settings.showLocalSource !== false ? ' checked' : ''}>${t('显示本地音乐来源', 'Show local music sources')}</label>
      <label><input type="checkbox" id="album-artist-fallback"${state.settings.albumArtistFallback ? ' checked' : ''}>${t('专辑缺少艺人标签时使用歌曲艺人', 'Use track artist when the album artist tag is missing')}</label>
      <p>${t('关闭时，同名且没有专辑艺人标签的曲目归入同一张专辑。', 'With this off, tracks with the same album title and no album artist tag stay together.')}</p>
      <label><input type="checkbox" id="online-cover"${state.settings.onlineCover ? ' checked' : ''}>${t('自动查找缺失的在线封面', 'Find missing cover art automatically')}</label>
      <p>${t('使用歌曲的艺人和专辑信息查找缺失的封面。', 'Use track artist and album information to find missing covers.')}</p>
      <label><input type="checkbox" id="artist-image-engine"${state.settings.artistImageEngine ? ' checked' : ''}>${t('自动查找艺人照片', 'Find artist photos automatically')}</label>
      <p>${t('打开艺人详情时，查找缺失的在线艺人照片。', 'Look up missing online artist photos when opening an artist page.')}</p>
      <label><input type="checkbox" id="artist-album-cover-fallback"${state.settings.artistAlbumCoverFallback ? ' checked' : ''}>${t('缺少艺人照片时使用专辑封面', 'Use an album cover when the artist photo is missing')}</label>
      <p>${t('关闭艺人照片自动查找时，可以使用艺人已有的专辑封面。', 'Use an available album cover when automatic artist photo lookup is off.')}</p>
      <div class="actions">${btn(t('配置封面 API', 'Configure Cover API'), 'server', 'metadata-artwork-settings')}</div>
      <form class="classification-rules" data-form="artist-rules">
        <label>${t('艺人分隔符', 'Artist separators')}
          <textarea name="separators" rows="2" maxlength="800" aria-describedby="artist-separators-help">${esc(state.settings.artistRules.separators.join('\n'))}</textarea>
        </label>
        <p id="artist-separators-help">${t('每行填写一个分隔符，例如 ／。没有匹配的规则时，优先使用服务器提供的独立艺人名。',
          'Enter one literal separator per line, such as ／. Where no rule matches, use individual artist names supplied by the server.')}</p>
        <label>${t('不拆分的艺人', 'Artists to keep intact')}
          <textarea name="exceptions" rows="2" maxlength="2500" aria-describedby="artist-exceptions-help">${esc(state.settings.artistRules.exceptions.join('\n'))}</textarea>
        </label>
        <p id="artist-exceptions-help">${t('每行填写一个完整艺人名，例如 AC/DC。', 'Enter one full artist name per line, such as AC/DC.')}</p>
        <div class="actions"><button type="submit" class="btn">${t('保存艺人规则', 'Save artist rules')}</button></div>
      </form>
      <form class="classification-rules" data-form="genre-rules">
        <label>${t('流派分隔符', 'Genre separators')}
          <textarea name="separators" rows="2" maxlength="800" aria-describedby="genre-separators-help">${esc(state.settings.genreRules.separators.join('\n'))}</textarea>
        </label>
        <p id="genre-separators-help">${t('每行填写一个分隔符，例如 ／。留空会完整显示每个流派标签。',
          'Enter one literal separator per line, such as ／. Leave blank to keep every genre label intact.')}</p>
        <label>${t('不拆分的流派', 'Genres to keep intact')}
          <textarea name="exceptions" rows="2" maxlength="2500" aria-describedby="genre-exceptions-help">${esc(state.settings.genreRules.exceptions.join('\n'))}</textarea>
        </label>
        <p id="genre-exceptions-help">${t('每行填写一个完整流派名，例如 R&B／ソウル。规则只影响分类和搜索显示。',
          'Enter one full genre label per line, such as R&B／ソウル. Rules affect categorization and search.')}</p>
        <div class="actions"><button type="submit" class="btn">${t('保存分类规则', 'Save genre rules')}</button></div>
      </form>
      <p>${t('备份包含歌单、收藏、播放历史和设置。本地歌曲文件保存在当前浏览器中。',
        'Backups include playlists, favorites, playback history and settings. Local audio files are stored in this browser.')}</p>
      <div class="actions">
        ${btn(t('导出备份', 'Export backup'), 'download', 'export')}
        ${btn(t('恢复备份', 'Restore backup'), 'upload', 'restore')}
      </div>
    </section>`;
  return head(t('设置', 'Settings'), t('外观、音频和曲库管理。', 'Manage your appearance, audio and library.')) +
    '<div class="settings">' + appearance + audioSettings +
    '<section class="setting-card"><h2>' + t('缓存', 'Cache') + '</h2><p>' +
    t('管理歌曲、图片和歌词缓存。固定的离线副本与导入的本地音乐会保留。',
      'Manage song, image and lyric caches. Pinned offline copies and imported local music are kept.') +
    '</p>' + btn(t('缓存管理', 'Cache Manager'), 'hard-drive', 'cache-manager') + '</section>' + librarySettings + '</div>';
}
function applySettings() {
  const choice = state.settings.theme === 'system' ? (colorPreference.matches ? 'light' : 'copper') : state.settings.theme;
  const theme = Object.hasOwn(themes, choice) ? themes[choice] : themes.copper;
  document.documentElement.dataset.appearance = choice === 'light' ? 'light' : 'dark';
  document.documentElement.toggleAttribute('data-compact-player', state.settings.compactPlayer === true);
  document.documentElement.toggleAttribute('data-multiline-track-titles', state.settings.multilineTrackTitles === true);
  document.documentElement.toggleAttribute('data-scroll-topbar', state.settings.keepTopbarVisible === false);
  document.documentElement.toggleAttribute('data-lyric-blur', state.settings.blurLyrics === true);
  document.documentElement.dataset.lyricWeight = state.settings.lyricWeight;
  document.documentElement.dataset.lyricWordMode = state.settings.lyricWordMode;
  applyFullscreenLyricsAlignment();
  document.documentElement.dataset.playButtonStyle = state.settings.playButtonStyle;
  ['--accent','--accent-text','--bg','--panel','--panel2','--line'].forEach((variable, index) =>
    document.documentElement.style.setProperty(variable, theme[index + 1]));
  updatePlayButtonCoverColor();
  applyBackground();
  audio.playbackRate = Number(state.settings.speed) || 1;
  applyEqualizer();
  void updateScreenLock();
}
function applyBackground() {
  const workspace = $('.workspace');
  const background = state.settings.background;
  const valid = safeImage(background);
  workspace.toggleAttribute('data-custom-background', valid);
  workspace.style.setProperty('--user-background', valid ? 'url("' + background.replace(/["\\()]/g, '') + '")' : 'none');
  workspace.style.setProperty('--background-blur', state.settings.backgroundBlur + 'px');
  workspace.style.setProperty('--background-opacity', state.settings.backgroundOpacity / 100);
}
function screenLockStatus() {
  if (!navigator.wakeLock) return t('当前浏览器不支持屏幕常亮。', 'This browser cannot keep the screen awake.');
  if (screenLock && !screenLock.released) return t('屏幕常亮已启用。', 'Screen wake lock is active.');
  return state.settings.keepAwake ? t('播放时且页面可见时生效。', 'Applies while playing and this page is visible.') : '';
}
function refreshScreenLockStatus() {
  const status = $('#wake-lock-status');
  if (status) status.textContent = screenLockStatus();
}
function shouldKeepAwake() {
  return state.settings.keepAwake && !document.hidden && !audio.paused && !audio.ended;
}
async function updateScreenLock() {
  if (!shouldKeepAwake()) {
    const lock = screenLock;
    screenLock = undefined;
    if (lock && !lock.released) await lock.release().catch(() => {});
  } else if (navigator.wakeLock && !requestingScreenLock && (!screenLock || screenLock.released)) {
    requestingScreenLock = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      screenLock = lock;
      lock.addEventListener('release', refreshScreenLockStatus, { once: true });
      if (!shouldKeepAwake()) await lock.release();
    } catch { /* A later playback or visibility change can retry. */ }
    finally { requestingScreenLock = false; }
  }
  refreshScreenLockStatus();
}
function maximumEqualizerBoost(filters, sampleRate, gains) {
  const upperBound = gains.reduce((sum, gain) => sum + Math.max(0, gain), 0);
  if (!upperBound || filters.some(filter => typeof filter.getFrequencyResponse !== 'function')) return upperBound;
  const frequencies = new Float32Array(1025);
  const nyquist = sampleRate / 2;
  for (let i = 1; i < frequencies.length; i++) frequencies[i] = 10 * (nyquist / 10) ** ((i - 1) / 1023);
  const magnitude = new Float32Array(frequencies.length);
  const phase = new Float32Array(frequencies.length);
  const combined = new Float64Array(frequencies.length).fill(1);
  try {
    for (const [index, filter] of filters.entries()) {
      if (!gains[index]) continue;
      filter.getFrequencyResponse(frequencies, magnitude, phase);
      for (let i = 0; i < combined.length; i++) combined[i] *= magnitude[i];
    }
  } catch {
    return upperBound;
  }
  const maximum = Math.max(1, ...combined);
  return Number.isFinite(maximum) ? Math.min(upperBound, 20 * Math.log10(maximum)) : upperBound;
}
const pendingTrackGain = new Set();
let opusSourceCheck;
let resumingOpusContext = false;
function originalOpusBlob(track) {
  const source = audio.currentSrc;
  if (track && mayHaveR128Gain(track.fileName || track.path) && audio.src === source && source.startsWith('blob:') &&
      !compatibleTrackIsCurrent(track) && !casting() && audio.remote?.state !== 'connecting') return source;
}
function updateOpusOutputGain() {
  const source = originalOpusBlob(player.getState().track);
  const knownGain = source === opusSourceCheck?.source ? opusSourceCheck?.gain || 0 : 0;
  if ((knownGain || eqNodes?.opusDb) && knownGain !== eqNodes?.opusDb) applyEqualizer();
  if (!source || opusSourceCheck?.source === source) return;
  const check = { source, gain: 0 };
  opusSourceCheck = check;
  void (async () => {
    if (await opusDecoderCapability() !== 'ignored' || opusSourceCheck !== check) return;
    const response = await fetch(source, { signal: AbortSignal.timeout(5000) });
    if (!response.ok || opusSourceCheck !== check) return;
    check.gain = await verifiedOpusOutputGain(await response.blob());
    if (check.gain && opusSourceCheck === check && source === originalOpusBlob(player.getState().track)) applyEqualizer();
  })().catch(() => {});
}
function connectAudioGraph(effects, opusDb) {
  const useHeader = Boolean(opusDb);
  if (useHeader) {
    eqNodes.opusGain ??= context.createGain();
    if (opusDb !== eqNodes.opusDb) {
      const gain = 10 ** (opusDb / 20);
      const parameter = eqNodes.opusGain.gain;
      parameter.cancelScheduledValues(context.currentTime);
      if (eqNodes.opusDb) parameter.setTargetAtTime(gain, context.currentTime, .008);
      else parameter.value = gain;
    }
  }
  if (effects !== eqNodes.active || useHeader !== Boolean(eqNodes.opusDb)) {
    if (effects !== eqNodes.active) {
      const output = eqNodes.filters.at(-1);
      if (effects) output.connect(context.destination);
      else output.disconnect(context.destination);
    }
    audioSource.disconnect();
    if (eqNodes.opusDb) eqNodes.opusGain.disconnect();
    const destination = effects ? eqNodes.gain : context.destination;
    if (useHeader) audioSource.connect(eqNodes.opusGain).connect(destination);
    else audioSource.connect(destination);
    eqNodes.active = effects;
  }
  eqNodes.opusDb = opusDb;
}
function loadLocalTrackGain(track, needsGain) {
  if (track?.provider !== 'local' || !needsGain || pendingTrackGain.has(track.id)) return;
  const id = track.id;
  pendingTrackGain.add(id);
  void readLocalReplayGain(id).then(tags => {
    if (!tags) return;
    const current = locals.find(item => item.id === id);
    if (current && current.src === track.src && !removingTracks.has(id)) {
      Object.assign(current, tags);
      for (const item of player.getState().queue) if (item.id === id && item.src === track.src) Object.assign(item, tags);
      if (player.getState().track?.id === id) applyEqualizer();
    }
  }).catch(() => {}).finally(() => { pendingTrackGain.delete(id); });
}
function makeEqualizerFilters(frequencies) {
  return frequencies.map((frequency, index) => {
    const filter = context.createBiquadFilter();
    filter.type = index === 0 ? 'lowshelf' : index === frequencies.length - 1 ? 'highshelf' : 'peaking';
    filter.frequency.value = frequency;
    filter.Q.value = 1;
    return filter;
  });
}
function rebuildEqualizerFilters(frequencies) {
  const key = frequencies.join(',');
  if (eqNodes.bandKey === key) return;
  eqNodes.gain.disconnect();
  for (const filter of eqNodes.filters) filter.disconnect();
  const filters = makeEqualizerFilters(frequencies);
  [eqNodes.gain, ...filters].reduce((last, node) => { last.connect(node); return node; });
  if (eqNodes.active) filters.at(-1).connect(context.destination);
  eqNodes.filters = filters;
  eqNodes.bandKey = key;
}
function applyEqualizer() {
  const originalButton = $('[data-action="original-sound"]');
  if (originalButton) {
    const active = originalSound();
    originalButton.setAttribute('aria-pressed', String(active));
    originalButton.classList.toggle('primary', active);
  }
  const gains = state.settings.eqEnabled ? state.settings.eq : state.settings.eq.map(() => 0);
  const frequencies = activeEqBands(state.settings.eq);
  const hasEqualizer = gains.some(Boolean);
  const track = player.getState().track;
  const albumMode = state.settings.replayGain && state.settings.replayGainMode === 'album';
  const needsGain = track && state.settings.replayGain && (
    (albumMode && !track.replayGainAlbumRead) || (!track.r128GainRead && mayHaveR128Gain(track.fileName || track.path)));
  loadLocalTrackGain(track, needsGain);
  if (needsGain && !audio.paused && state.settings.autoReadTags && track?.embeddedTags &&
      !(track.embeddedTags.replayGainAlbumRead && track.embeddedTags.r128GainRead) &&
      validCloudTrack(track) && !hasOffline(track.id) && !viewedTags.has(track.id)) void readEmbeddedTags(track);
  const r128Gain = albumMode && Number.isFinite(track?.r128AlbumGain) ? track.r128AlbumGain : track?.r128TrackGain;
  const useR128 = state.settings.replayGain && Number.isFinite(r128Gain);
  const useAlbum = albumMode && Number.isFinite(track?.replayGainAlbum);
  const rawGain = useR128 ? r128Gain : useAlbum ? track.replayGainAlbum : track?.replayGain;
  const rawPeak = useR128 ? undefined : useAlbum ? (track.replayGainAlbumPeak ?? track.replayGainPeak) : track?.replayGainPeak;
  const normalize = state.settings.replayGain && Number.isFinite(rawGain);
  const requested = normalize ? Math.max(-24, Math.min(12, rawGain)) : 0;
  const opusDb = opusSourceCheck?.source === originalOpusBlob(track) ? opusSourceCheck?.gain || 0 : 0;
  const taggedPeak = (normalize || hasEqualizer) && Number.isFinite(rawPeak) && rawPeak > 0 && rawPeak <= 10 ? rawPeak : 1;
  const peak = opusDb > 0 ? Math.max(1, taggedPeak) : taggedPeak;
  const active = hasEqualizer || requested !== 0 || peak > 1;
  if (!eqNodes && !active && !opusDb) return;
  try {
    if (!eqNodes) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      context ??= new AudioContext();
      if (!active && context.state !== 'running') {
        // Keep native playback connected until the optional context has actually unlocked.
        if (!audio.paused && !resumingOpusContext) {
          resumingOpusContext = true;
          void context.resume().then(() => {
            resumingOpusContext = false;
            if (context.state === 'running') applyEqualizer();
          }).catch(() => { resumingOpusContext = false; });
        }
        return;
      }
      const gain = context.createGain();
      const filters = makeEqualizerFilters(frequencies);
      [gain, ...filters].reduce((last, node) => { last.connect(node); return node; });
      audioSource = context.createMediaElementSource(audio);
      audioSource.connect(context.destination);
      eqNodes = { gain, filters, bandKey: frequencies.join(','), active: false, opusDb: 0 };
    }
    rebuildEqualizerFilters(frequencies);
    if (active) {
      eqNodes.filters.forEach((filter, index) => { filter.gain.value = gains[index]; });
      const responseBoost = maximumEqualizerBoost(eqNodes.filters, context.sampleRate, gains);
      const margin = hasEqualizer || requested > 0 || peak > 1 ? 1 : 0;
      const gain = Math.min(requested, -20 * Math.log10(peak) - responseBoost - margin);
      eqNodes.gain.gain.value = 10 ** (gain / 20);
    }
    connectAudioGraph(active, opusDb);
    if (!audio.paused && context.state === 'suspended') void context.resume().catch(() => {});
  } catch { /* Web Audio may be unavailable */ }
}

const lyricCache = new Map();
const loadingLyrics = new Map();
const serverLyricPickerVersions = new WeakMap();
const validServerLyricVersion = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const serverLyricChoiceLimit = 150;
const serverLyricChoices = new Map((Array.isArray(loaded.serverLyricChoices) ? loaded.serverLyricChoices : [])
  .slice(-serverLyricChoiceLimit).filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' &&
    entry[0].length <= 4096 && validServerLyricVersion(entry[1])));
const lyricCacheEpochKey = 'groovebox.lyrics-cache-epoch.v1';
function readLyricCacheEpoch() {
  try { return localStorage.getItem(lyricCacheEpochKey) || 'legacy'; } catch { return 'legacy'; }
}
let lyricCacheEpoch = readLyricCacheEpoch();
const matchedLyrics = new Map((loaded.onlineLyricsEpoch || 'legacy') === lyricCacheEpoch && Array.isArray(loaded.onlineLyrics) ? loaded.onlineLyrics.filter(entry =>
  Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1]) && entry[1].length)
  .filter(entry => entry[3] === undefined || validMetadataLyricSource(entry[3]))
  .map(([id, lines, preferred, source]) => [id, { lines, preferred: preferred === true, ...(source && { source }) }]) : []);
const automaticLyrics = new Map();
let metadataLyricsStatus;
let metadataStatusJob;
let metadataStatusCheckedAt = 0;
let metadataStatusGeneration = 0;
let metadataStatusError;
let metadataStatusSequence = 0;
let metadataStatusController;
const metadataChanges = typeof BroadcastChannel === 'function' ? new BroadcastChannel('groovebox.metadata-api') : undefined;
metadataChanges?.addEventListener('message', () => { void refreshMetadataLyricsStatus(true).catch(() => {}); });
let manualLyricMatches = new WeakMap();
const manualLyricSources = new WeakMap();
const manualLyricTracks = new WeakMap();
let lyricsRetryAt = 0;
let lyricQuerySpacingAt = 0;
const customLyricRetryAt = new Map();
let automaticLyricJob;
let manualLyricJob;
let retainedLyricDisplay;
function savedOnlineLyrics() {
  synchronizeLyricCacheEpoch();
  const entries = [];
  let remaining = 200000;
  for (const [id, { lines, preferred, source }] of [...matchedLyrics].reverse()) {
    const entry = source ? [id, lines, preferred === true, source] : preferred ? [id, lines, true] : [id, lines];
    const size = JSON.stringify(entry).length;
    if (size > remaining) continue;
    remaining -= size;
    entries.push(entry);
  }
  return entries.reverse();
}
function rememberOnlineLyrics(id, lines, preferred = false, source, epoch = lyricCacheEpoch) {
  synchronizeLyricCacheEpoch();
  if (epoch !== lyricCacheEpoch) return;
  matchedLyrics.delete(id);
  matchedLyrics.set(id, { lines, preferred, ...(source && { source }) });
  if (matchedLyrics.size > 150) matchedLyrics.delete(matchedLyrics.keys().next().value);
  save();
}
function suppliedLyricsOf(track) {
  if (Array.isArray(track?.lyrics) && track.lyrics.length) return track.lyrics;
  const supplied = lyricCache.get(track?.lyrics);
  const choice = supplied?.versions?.find(version => version.id === serverLyricChoices.get(track.id));
  return choice?.lines || supplied?.lines ||
    (retainedLyricDisplay?.track === track ? retainedLyricDisplay?.supplied : undefined) || [];
}
function serverLyricVersions(track) {
  return lyricCache.get(track?.lyrics)?.versions || [];
}
function matchedLyricsOf(track) {
  const result = matchedLyrics.get(track?.id) ||
    (retainedLyricDisplay?.track === track ? retainedLyricDisplay?.matched : undefined);
  if (result?.source && metadataLyricsStatus &&
      (result.source.adapter !== metadataLyricsStatus.adapter || result.source.revision !== metadataLyricsStatus.revision)) return;
  if (result && !result.source && !result.preferred && metadataLyricsStatus?.adapter !== 'none' &&
      metadataLyricsStatus !== undefined) return;
  return result;
}

function validMetadataLyricSource(source) {
  return source && ['lrclib', 'hisatri'].includes(source.adapter) &&
    typeof source.revision === 'string' && /^[a-z0-9-]{1,64}$/i.test(source.revision);
}
function adoptMetadataLyricsStatus(payload) {
  const status = payload?.lyrics;
  if (!status || !['none', 'lrclib', 'hisatri'].includes(status.adapter) ||
      typeof status.revision !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(status.revision)) {
    throw new InterfaceError('无法读取歌词接口设置。', 'Could not read the lyric API settings.');
  }
  const changed = metadataLyricsStatus?.adapter !== status.adapter || metadataLyricsStatus?.revision !== status.revision;
  metadataLyricsStatus = { adapter: status.adapter, revision: status.revision };
  metadataStatusError = undefined;
  metadataStatusCheckedAt = Date.now();
  if (changed) {
    metadataStatusGeneration++;
    for (const [id, record] of matchedLyrics) {
      if (record.source && (record.source.adapter !== status.adapter || record.source.revision !== status.revision)) matchedLyrics.delete(id);
    }
    automaticLyricJob?.controller.abort();
    if (manualLyricJob && !manualLyricJob.public) {
      manualLyricJob.controller.abort();
      const status = $('[data-lyric-status]', manualLyricJob.form);
      if (status?.isConnected) status.textContent = t('歌词接口设置已变化，请关闭后重新打开查询。',
        'Lyric API settings changed. Close and reopen the search.');
    }
    automaticLyrics.clear();
    customLyricRetryAt.clear();
    lyricQuerySpacingAt = 0;
    refreshLyrics();
  }
  return metadataLyricsStatus;
}
function refreshMetadataLyricsStatus(force = false) {
  if (metadataStatusJob && !force) return metadataStatusJob;
  if (force) metadataStatusController?.abort();
  if (!force && metadataStatusError && Date.now() - metadataStatusCheckedAt < 15000) return Promise.reject(metadataStatusError);
  if (!force && metadataLyricsStatus && Date.now() - metadataStatusCheckedAt < 15000) return Promise.resolve(metadataLyricsStatus);
  const generation = metadataStatusGeneration;
  const sequence = ++metadataStatusSequence;
  const controller = metadataStatusController = new AbortController();
  const job = fetch('/api/metadata/status', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
    .then(async response => {
      if (!response.ok) throw new InterfaceError('无法读取歌词接口设置。', 'Could not read the lyric API settings.');
      const payload = await response.json();
      if (sequence !== metadataStatusSequence) throw new DOMException('Superseded metadata settings request', 'AbortError');
      return generation !== metadataStatusGeneration && metadataLyricsStatus ? metadataLyricsStatus : adoptMetadataLyricsStatus(payload);
    }).then(status => { metadataStatusError = undefined; return status; }).catch(error => {
      if (generation !== metadataStatusGeneration && metadataLyricsStatus) return metadataLyricsStatus;
      if (sequence === metadataStatusSequence) {
        metadataStatusError = error;
        metadataStatusCheckedAt = Date.now();
      }
      if (sequence !== metadataStatusSequence) {
        if (metadataStatusJob && metadataStatusJob !== job) return metadataStatusJob;
        if (metadataStatusError) throw metadataStatusError;
        if (metadataLyricsStatus) return metadataLyricsStatus;
      }
      throw error;
    }).finally(() => {
      if (metadataStatusJob === job) { metadataStatusJob = undefined; metadataStatusController = undefined; }
    });
  metadataStatusJob = job;
  return job;
}

async function metadataApiSettings() {
  openDialog(t('配置歌词 API', 'Configure Lyric API'), '<p class="dialog-message" role="status">' + t('正在读取…', 'Loading…') + '</p>');
  const pending = dialog.firstElementChild;
  try {
    const config = await api('/api/metadata/config');
    if (!dialog.open || dialog.firstElementChild !== pending) return;
    const value = config.lyrics;
    openDialog(t('配置歌词 API', 'Configure Lyric API'), '<form class="dialog-inner" style="padding:0" data-form="metadata-api">' +
      (config.configurationError ? '<p class="dialog-message">' + t('已保存的接口配置无法读取，自动查询已停止。重新保存会替换损坏的配置。',
        'Saved API settings could not be read. Automatic lookup is stopped. Saving will replace the damaged settings.') + '</p>' : '') +
      '<p class="dialog-message">' + t('自动查找需开启「缺少歌词时自动在线匹配」。原有歌词优先；自定义接口未找到时可手动浏览 LRCLIB 版本。',
        'Enable automatic lyric matching for automatic lookup. Original lyrics take priority. Browse LRCLIB versions manually if the custom API has no match.') + '</p>' +
      '<label class="dialog-field">' + t('歌词接口', 'Lyric adapter') + '<select id="metadata-lyrics-adapter" name="adapter">' +
      [['none', t('无', 'None')], ['lrclib', 'LRCLIB'], ['hisatri', 'HisAtri']].map(([id, label]) =>
        '<option value="' + id + '"' + (value.adapter === id ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>' +
      '<label class="dialog-field">' + t('接口地址', 'API endpoint') + '<input id="metadata-lyrics-url" name="url" type="url" maxlength="2048" value="' + esc(value.url) + '"></label>' +
      '<label class="dialog-field">' + t('请求头操作', 'Request header action') + '<select id="metadata-headers-action" name="headersAction">' +
      '<option value="keep">' + t('保留已保存的请求头', 'Keep saved headers') + '</option><option value="replace">' + t('替换请求头', 'Replace headers') +
      '</option><option value="remove">' + t('移除请求头', 'Remove headers') + '</option></select></label>' +
      '<label class="dialog-field">' + t('请求头', 'Request headers') + '<textarea id="metadata-headers" name="headers" rows="3" maxlength="8192" autocomplete="off" spellcheck="false" placeholder="Authorization=Bearer …&amp;X-Api-Key=…"></textarea></label>' +
      '<p class="dialog-message">' + t('请求头仅加密保存在本机服务端，不加入浏览器备份。更换接口域名会清除旧请求头。',
        'Headers are encrypted on this server and excluded from browser backups. Changing the endpoint origin clears old headers.') + ' ' +
      (value.hasHeaders ? t('已保存请求头。', 'Headers are saved.') : t('未保存请求头。', 'No headers saved.')) + '</p>' +
      '<p class="dialog-message" role="status"></p><button type="submit" class="btn primary">' + t('保存接口设置', 'Save API settings') + '</button></form>');
  } catch (error) {
    if (dialog.open && dialog.firstElementChild === pending) $('[role=status]', dialog).textContent = displayError(error,
      t('请在运行播放器的电脑上配置歌词接口。', 'Configure the lyric API on the computer running this player.'));
  }
}
async function saveMetadataApiSettings(form, data) {
  const button = $('button[type=submit]', form);
  button.disabled = true;
  try {
    const status = await api('/api/metadata/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lyrics: { adapter: data.adapter, url: data.url, headersAction: data.headersAction,
        ...(data.headersAction === 'replace' && { headers: data.headers }) } }) });
    form.elements.headers.value = '';
    adoptMetadataLyricsStatus(status);
    metadataChanges?.postMessage({ changed: true });
    save();
    if (dialog.contains(form)) dialog.close();
    announce(t('歌词接口设置已保存。', 'Lyric API settings saved.'));
  } catch (error) {
    if (form.isConnected) $('[role=status]', form).textContent = displayError(error,
      t('无法保存歌词接口设置。', 'Could not save the lyric API settings.'));
  } finally { button.disabled = false; }
}
function lyricsOf(track) {
  const matched = matchedLyricsOf(track);
  const supplied = suppliedLyricsOf(track);
  return matched?.preferred ? matched.lines : supplied.length ? supplied : matched?.lines || [];
}
function normalizeLyricOffset(value) {
  return Number.isSafeInteger(value) ? value : defaults.lyricOffsetMs;
}
function lyricOffsetSeconds() {
  return state.settings.lyricOffsetMs / 1000;
}
function lyricOffsetButton() {
  return btn(t('歌词时间偏移', 'Lyric Timing Offset'), 'timer', 'lyric-offset');
}
function lyricOffsetDialog() {
  openDialog(t('歌词时间偏移', 'Lyric Timing Offset'), '<form class="dialog-inner" data-form="lyric-offset" style="padding:0">' +
    '<label class="dialog-field">' + t('歌词偏移毫秒数', 'Offset in milliseconds') +
    '<input type="number" name="offset" step="1" required value="' + state.settings.lyricOffsetMs + '"></label>' +
    '<p class="dialog-message">' + t('负值让歌词提前，正值让歌词延后。此设置应用于所有歌曲。',
      'Negative values show lyrics earlier. Positive values show them later. Applies to all tracks.') + '</p>' +
    '<div class="actions">' +
    btn(t('提前 100 毫秒', 'Earlier by 100 ms'), null, 'step-lyric-offset', 'data-delta="-100"') +
    btn(t('延后 100 毫秒', 'Later by 100 ms'), null, 'step-lyric-offset', 'data-delta="100"') +
    btn(t('归零', 'Reset'), null, 'step-lyric-offset', 'data-delta="0"') +
    '<button class="btn primary" type="submit">' + t('保存', 'Save') + '</button></div>' +
    '<p class="dialog-message" role="status"></p></form>');
}
function stepLyricOffset(target) {
  const input = target.closest('form[data-form="lyric-offset"]')?.elements.offset;
  if (!input) return;
  const delta = Number(target.dataset.delta);
  const next = delta ? normalizeLyricOffset(input.valueAsNumber) + delta : 0;
  if (Number.isSafeInteger(next)) input.value = next;
}
function saveLyricOffset(form) {
  const offset = form.elements.offset.valueAsNumber;
  if (!Number.isSafeInteger(offset)) {
    $('[role=status]', form).textContent = t('请输入整数毫秒值。', 'Enter a whole number of milliseconds.');
    return;
  }
  state.settings.lyricOffsetMs = offset;
  dialog.close();
  save();
  syncPlayer(player.getState());
}
function toggleLyricSource() {
  const track = player.getState().track;
  const matched = matchedLyricsOf(track);
  if (!matched || !suppliedLyricsOf(track).length) return;
  if (matchedLyrics.has(track.id)) rememberOnlineLyrics(track.id, matched.lines, !matched.preferred, matched.source);
  else matched.preferred = !matched.preferred;
  refreshLyrics();
}
function clearLyricsCache(options) {
  const track = player.getState().track;
  const matched = matchedLyricsOf(track);
  const retained = track ? { track, supplied: suppliedLyricsOf(track), matched: matched && { ...matched } } : undefined;
  const previous = [...matchedLyrics];
  const previousEpoch = lyricCacheEpoch;
  try {
    lyricCacheEpoch = crypto.randomUUID();
    localStorage.setItem(lyricCacheEpochKey, lyricCacheEpoch);
  } catch {
    lyricCacheEpoch = previousEpoch;
    announce(t('无法保存歌词缓存的清理结果。', 'Could not save the lyrics cache changes.'));
    return false;
  }
  matchedLyrics.clear();
  if (!save({ strict: true })) {
    if (readLyricCacheEpoch() === lyricCacheEpoch) {
      for (const [id, result] of previous) matchedLyrics.set(id, result);
      lyricCacheEpoch = previousEpoch;
      try { localStorage.setItem(lyricCacheEpochKey, previousEpoch); } catch {}
    } else synchronizeLyricCacheEpoch();
    announce(t('无法保存歌词缓存的清理结果。', 'Could not save the lyrics cache changes.'));
    return false;
  }
  retainedLyricDisplay = retained;
  const running = [automaticLyricJob?.controller, manualLyricJob?.controller, ...loadingLyrics.values()];
  automaticLyricJob = undefined;
  manualLyricJob = undefined;
  loadingLyrics.clear();
  manualLyricMatches = new WeakMap();
  for (const request of running) request?.abort();
  lyricCache.clear();
  automaticLyrics.clear();
  if (options?.keepDialog !== true) dialog.close();
  refreshLyrics();
  announce(t('已清理歌词缓存。', 'Lyrics cache cleared.'));
  return true;
}
function synchronizeLyricCacheEpoch() {
  const epoch = readLyricCacheEpoch();
  if (epoch === lyricCacheEpoch) return;
  const track = player.getState().track;
  const matched = matchedLyrics.get(track?.id);
  retainedLyricDisplay = track ? { track, supplied: suppliedLyricsOf(track), matched: matched && { ...matched } } : undefined;
  lyricCacheEpoch = epoch;
  matchedLyrics.clear();
  for (const controller of [automaticLyricJob?.controller, manualLyricJob?.controller, ...loadingLyrics.values()]) controller?.abort();
  automaticLyricJob = undefined;
  manualLyricJob = undefined;
  loadingLyrics.clear();
  manualLyricMatches = new WeakMap();
  lyricCache.clear();
  automaticLyrics.clear();
  if (dialog.open && $('[data-form="lyric-match"]', dialog)) dialog.close();
}
function refreshLyrics() {
  lastNow = '';
  syncPlayer(player.getState());
}
function fetchLyrics(track, duration, playing) {
  if (manualLyricJob && manualLyricJob.track !== track) manualLyricJob.controller.abort();
  if (automaticLyricJob && (automaticLyricJob.id !== track?.id || state.settings.autoMatchLyrics !== true)) {
    automaticLyricJob.controller.abort();
  }
  if (!track || (Array.isArray(track.lyrics) && track.lyrics.length)) return;
  const src = track.lyrics;
  if (typeof src === 'string' && src.startsWith('/api/') && !lyricCache.has(src) && !suppliedLyricsOf(track).length) {
    if (loadingLyrics.has(src)) return;
    const controller = new AbortController();
    loadingLyrics.set(src, controller);
    void fetchSuppliedLyrics(src, controller.signal).catch(() => ({ lines: [] })).then(supplied => {
      if (loadingLyrics.get(src) !== controller) return;
      loadingLyrics.delete(src);
      if (!controller.signal.aborted) lyricCache.set(src, supplied);
      refreshLyrics();
    });
    return;
  }
  if (!playing || retainedLyricDisplay?.track === track || lyricsOf(track).length || track.artistIsFallback ||
      state.settings.autoMatchLyrics !== true || automaticLyricJob || manualLyricJob ||
      Date.now() < (automaticLyrics.get(track.id) || 0) || Date.now() < lyricBackoff() || Date.now() < lyricQuerySpacingAt) return;
  const title = lookupText(track.title);
  const artist = lookupText(track.artist);
  if (!title || !artist || artist === '未知艺人') return;
  if (!metadataLyricsStatus) {
    void refreshMetadataLyricsStatus().then(refreshLyrics).catch(() => {});
    return;
  }
  const controller = new AbortController();
  const job = automaticLyricJob = { id: track.id, controller, epoch: lyricCacheEpoch };
  lookupLyrics({ title, artist, album: lookupText(albumForLookup(track)), duration }, controller.signal)
    .then(({ lines, source }) => {
      if (automaticLyricJob === job && !controller.signal.aborted) rememberOnlineLyrics(track.id, lines, false, source, job.epoch);
    }).catch(error => {
      if (automaticLyricJob !== job || controller.signal.aborted) return;
      if (error?.code === 'busy') return;
      automaticLyrics.delete(track.id);
      automaticLyrics.set(track.id, Date.now() + (error?.code === 'unmatched' ? 15 * 60_000 : 15_000));
      if (automaticLyrics.size > 150) automaticLyrics.delete(automaticLyrics.keys().next().value);
    }).finally(() => {
      if (automaticLyricJob !== job) return;
      lyricQuerySpacingAt = Math.max(lyricQuerySpacingAt, Date.now() + 300);
      automaticLyricJob = undefined;
      refreshLyrics();
    });
}
async function fetchSuppliedLyrics(src, signal) {
  const response = await fetch(src, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  if (!response.ok) return { lines: [] };
  if (response.headers.get('Content-Type')?.startsWith('application/json')) {
    const { lines: supplied, defaultVersion, variants } = await response.json();
    const lines = suppliedLyricLines(supplied);
    const versions = [];
    if (validServerLyricVersion(defaultVersion?.id) && lines.length && Array.isArray(variants)) {
      versions.push({ ...defaultVersion, lines });
      const seen = new Set([defaultVersion.id]);
      for (const variant of variants) {
        if (!validServerLyricVersion(variant?.id) || seen.has(variant.id)) continue;
        const versionLines = suppliedLyricLines(variant.lines);
        if (!versionLines.length) continue;
        seen.add(variant.id);
        versions.push({ ...variant, lines: versionLines });
      }
    }
    return { lines, ...(versions.length > 1 && { versions }) };
  }
  const text = (await response.text()).trim();
  if (!text || text.length > 1000000) return { lines: [] };
  const timed = parseLyrics(text);
  if (timed.length) return { lines: timed };
  const plain = text.split(/\r?\n/).filter(line => !/^\[(?:[^:\]]+):[^\]]*\]$|^WEBVTT(?:\s|$)/i.test(line.trim())).join('\n').trim();
  return { lines: plain ? [{ time: null, text: plain }] : [] };
}
function suppliedLyricLines(lines) {
  return Array.isArray(lines) ? lines.filter(line => typeof line?.text === 'string' && line.text.trim()) : [];
}
function serverLyricLanguage(language, names) {
  if (typeof language === 'string' && /^(?!und$|xxx$)[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(language)) {
    try {
      const label = names.of(language);
      if (label) return label;
    } catch { /* Invalid tags are treated as unspecified. */ }
  }
  return t('未标明语言', 'Language unspecified');
}
function showServerLyricVersions() {
  const { track } = player.getState();
  const versions = serverLyricVersions(track);
  if (versions.length < 2) return;
  const names = new Intl.DisplayNames(getLanguage(), { type: 'language', fallback: 'none' });
  const labels = versions.map(version => {
    const title = lookupText(version.title);
    return [serverLyricLanguage(version.language, names), version.timed === true
      ? t('同步歌词', 'Synchronized lyrics') : t('纯文本歌词', 'Plain lyrics'),
    title && title !== track.title && title].filter(Boolean).join(' · ');
  });
  const selected = serverLyricChoices.get(track.id);
  const current = versions.find(version => version.id === selected) || versions[0];
  openDialog(t('服务器歌词版本', 'Server Lyric Versions'), '<div class="dialog-options" data-lyric-server-track="' +
    esc(track.id) + '">' + versions.map((version, index) => {
      const label = labels[index];
      const tied = labels.filter(value => value === label).length > 1;
      const name = tied ? label + ' · ' + t('版本 {number}', 'Version {number}', { number: index + 1 }) : label;
      return btn(name, 'list-music', 'choose-server-lyric-version',
        key(version.id) + ' aria-pressed="' + (current.id === version.id) + '"');
    }).join('') + '</div>');
  serverLyricPickerVersions.set($('[data-lyric-server-track]', dialog), versions);
}
function chooseServerLyricVersion(target) {
  const { track } = player.getState();
  const picker = target.closest('[data-lyric-server-track]');
  const versions = serverLyricVersions(track);
  if (!picker || picker.dataset.lyricServerTrack !== track?.id || serverLyricPickerVersions.get(picker) !== versions) return dialog.close();
  const version = versions.find(item => item.id === target.dataset.id);
  if (!version) return dialog.close();
  serverLyricChoices.delete(track.id);
  serverLyricChoices.set(track.id, version.id);
  if (serverLyricChoices.size > serverLyricChoiceLimit) serverLyricChoices.delete(serverLyricChoices.keys().next().value);
  dialog.close();
  clearLyricBrowse();
  if (matchedLyricsOf(track)?.preferred) toggleLyricSource();
  else { save(); refreshLyrics(); }
  const region = immersive ? $('.immersive') : now;
  $('[data-action="server-lyric-versions"]', region)?.focus({ preventScroll: true });
}
function lyricMarkup(track) {
  const lyrics = lyricsOf(track);
  const custom = metadataLyricsStatus && metadataLyricsStatus.adapter !== 'none';
  const publicVersions = btn(t('浏览其他歌词版本', 'Browse Other Versions'), 'search', 'browse-lyric-versions');
  if (!lyrics.length) return '<div class="lyrics"><p class="hint">' + t('暂无歌词', 'No lyrics available') + '</p><div class="actions">' +
    btn(t('导入同名歌词', 'Import matching lyrics'), 'upload', 'import-files') +
    (track ? btn(t('在线匹配', 'Find lyrics online'), 'search', 'match-lyrics') + (custom ? publicVersions : '') : '') +
    '</div></div>';
  const matched = matchedLyricsOf(track);
  const online = matched?.lines === lyrics;
  const matchButton = matched ? (matched.source ? btn(t('重新匹配歌词', 'Match lyrics again'), 'search', 'match-lyrics') : '') +
    publicVersions : btn(t('在线匹配', 'Find lyrics online'), 'search', 'match-lyrics') + (custom ? publicVersions : '');
  const changeSource = matched && suppliedLyricsOf(track).length ? btn(online
    ? t('使用原歌词', 'Use original lyrics') : t('使用已匹配歌词', 'Use matched lyrics'), 'list-music', 'toggle-lyric-source') : '';
  const versions = serverLyricVersions(track).length > 1
    ? btn(t('服务器歌词版本', 'Server Lyric Versions'), 'list-music', 'server-lyric-versions') : '';
  const offsetControl = lyrics.some(line => Number.isFinite(line.time)) ? '<div class="actions">' + lyricOffsetButton() + '</div>' : '';
  const attribution = online && matched?.source ? '<p class="hint" data-custom-lyric-source>' +
    t('歌词来源：自定义 {name} 接口', 'Lyrics from configured {name} API', { name: matched.source.adapter === 'hisatri' ? 'HisAtri' : 'LRCLIB' }) + '</p>' : '';
  return offsetControl + attribution + '<div class="lyrics">' + lyrics.map(line => {
    const translation = line.translation ? '<span class="lyric-translation">' + esc(line.translation) + '</span>' : '';
    if (!Number.isFinite(line.time)) return '<p class="lyric-line">' + esc(line.text) + translation + '</p>';
    const words = Array.isArray(line.words) ? line.words.filter(word => Number.isFinite(word?.time)) : [];
    const body = words.length ? '<span class="lyric-words">' + words.map(word => '<span class="lyric-word" data-word-time="' + word.time + '"' +
      (Number.isFinite(word.endTime) && word.endTime >= word.time ? ' data-word-end="' + word.endTime + '"' : '') +
      '>' + esc(word.text) + '</span>').join('') + '</span>' : esc(line.text);
    return '<button class="lyric-line' + (words.length ? ' word-lyrics' : '') + '" data-action="seek-lyric" data-time="' +
      line.time + '">' + body + translation + '</button>';
  }).join('') + '<div class="actions">' + matchButton + changeSource + versions + '</div></div>';
}
let pendingLyricSeek;
function activateLyricLine(line, event) {
  clearTimeout(pendingLyricSeek);
  const time = Number(line.dataset.time);
  if (event.detail === 0) {
    clearLyricBrowse();
    return player.seek(time + lyricOffsetSeconds());
  }
  if (event.detail > 1) return;
  // The browser dispatches both click events before the double-click event.
  const track = player.getState().track;
  pendingLyricSeek = setTimeout(() => {
    if (line.isConnected && player.getState().track === track) {
      clearLyricBrowse();
      player.seek(time + lyricOffsetSeconds());
    }
  }, 220);
}
async function lyricsDialog(browse = false) {
  const originalTrack = player.getState().track;
  const originalDialogRevision = dialogRevision;
  if (!browse) {
    try { await refreshMetadataLyricsStatus(); }
    catch (error) { announce(displayError(error, t('无法读取歌词接口设置。', 'Could not read the lyric API settings.'))); return; }
  }
  if (player.getState().track !== originalTrack || dialogRevision !== originalDialogRevision) return;
  const snapshot = player.getState();
  const track = snapshot.track;
  if (!track) return;
  const artist = track.artistIsFallback || track.artist === '未知艺人' ? '' : track.artist;
  const duration = Number(snapshot.duration || track.duration) || 0;
  const custom = !browse && metadataLyricsStatus?.adapter !== 'none';
  const hint = custom ? t('查询会向已配置的 {name} 接口发送填写的歌曲信息。', 'Lookup sends these song details to your configured {name} API.',
    { name: metadataLyricsStatus.adapter === 'hisatri' ? 'HisAtri' : 'LRCLIB' }) : browse ? t('搜索会向 LRCLIB 发送填写的歌曲信息。选择候选版本后才会切换歌词。',
    'Search sends the song details you enter to LRCLIB. Lyrics change after you choose a version.') :
    t('查询会把填写的歌曲信息发送给 LRCLIB。精确匹配也会发送时长。',
      'The search sends the song details you enter to LRCLIB. Exact matching also sends the duration.');
  openDialog(browse ? t('浏览其他歌词版本', 'Browse Other Versions') : t('在线匹配歌词', 'Find lyrics online'),
    '<form class="dialog-inner" data-form="lyric-match" style="padding:0" ' + key(track.id) +
    (browse ? ' data-browse-versions' : ' data-duration="' + duration + '"') +
    '><p class="dialog-message">' + hint + '</p>' +
    '<label class="dialog-field">' + t('歌曲名', 'Song title') + '<input name="title" maxlength="200" required value="' + esc(track.title) + '"></label>' +
    '<label class="dialog-field">' + t('艺人（可选）', 'Artist (optional)') + '<input name="artist" maxlength="200" value="' + esc(artist) + '"></label>' +
    '<label class="dialog-field">' + t('专辑（可选）', 'Album (optional)') + '<input name="album" maxlength="200" value="' +
    esc(browse ? '' : albumForLookup(track)) + '"></label><p class="dialog-message" data-lyric-status role="status"></p>' +
    '<button class="btn primary" type="submit">' + t('查找歌词', 'Search lyrics') +
    '</button><div class="dialog-options" data-lyric-results></div></form>');
  const form = $('[data-form="lyric-match"]', dialog);
  manualLyricTracks.set(form, track);
  if (!browse) manualLyricSources.set(form, { ...metadataLyricsStatus });
  cancelClosedLyricRequest();
}
function activeManualLyricRequest(job) {
  return manualLyricJob === job && !job.controller.signal.aborted && dialog.open && dialog.contains(job.form) &&
    player.getState().track === job.track && player.getState().track?.id === job.form.dataset.id;
}
function cancelClosedLyricRequest() {
  if (!manualLyricJob || activeManualLyricRequest(manualLyricJob)) return;
  const { controller } = manualLyricJob;
  manualLyricJob = undefined;
  controller.abort();
}
function applyMatchedLyrics(job, lines, source) {
  if (!activeManualLyricRequest(job)) return;
  rememberOnlineLyrics(job.form.dataset.id, lines, true, source, job.epoch);
  dialog.close();
  refreshLyrics();
}
async function requestMatchedLyrics(form, data) {
  const status = $('[data-lyric-status]', form);
  const submit = $('button[type=submit]', form);
  if (manualLyricTracks.get(form) !== player.getState().track) {
    status.textContent = t('播放歌曲已变化，请关闭后重新打开歌词查询。', 'The playing track changed. Close and reopen the lyric search.');
    return;
  }
  if (manualLyricJob) {
    status.textContent = t('已在查询歌词。', 'A lyrics search is already running.');
    return;
  }
  const title = lookupText(data.title);
  const artist = lookupText(data.artist);
  const album = lookupText(data.album);
  if (!title) {
    status.textContent = t('请输入歌曲名。', 'Enter a song title.');
    return;
  }
  const browse = form.hasAttribute('data-browse-versions');
  submit.disabled = true;
  const results = $('[data-lyric-results]', form);
  results.replaceChildren();
  manualLyricMatches.delete(form);
  status.textContent = t('正在查询歌词…', 'Searching for lyrics…');
  const controller = new AbortController();
  const job = manualLyricJob = { form, controller, public: browse, track: player.getState().track, epoch: lyricCacheEpoch };
  automaticLyricJob?.controller.abort();
  try {
    const expected = browse ? undefined : manualLyricSources.get(form);
    if (!browse) assertLyricApiSource(await refreshMetadataLyricsStatus(true), expected);
    if (!activeManualLyricRequest(job)) return;
    if (Date.now() < (browse ? lyricsRetryAt : lyricBackoff(expected))) {
      throw lyricsError('busy', t('歌词服务请求频繁，请稍后再试。', 'Too many lyrics requests. Try again shortly.'));
    }
    let exactMiss;
    const custom = !browse && expected?.adapter !== 'none';
    if (!browse && (artist || custom)) {
      try {
        const { lines, source } = await lookupLyrics({ title, artist, album, duration: form.dataset.duration }, controller.signal, expected);
        return applyMatchedLyrics(job, lines, source);
      } catch (error) {
        if (custom) throw error;
        if (error?.code !== 'unmatched') throw error;
        exactMiss = error;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    if (!activeManualLyricRequest(job)) return;
    const query = new URLSearchParams({ track_name: title });
    if (artist) query.set('artist_name', artist);
    if (album && (browse || !artist)) query.set('album_name', album);
    const items = await lrclibResponse(new URL('https://lrclib.net/api/search?' + query), controller.signal);
    if (!activeManualLyricRequest(job)) return;
    const matches = Array.isArray(items) ? items.slice(0, 20).filter(item => !item?.instrumental &&
      lookupText(item?.trackName || item?.name) && lookupText(item.artistName) &&
      (item.syncedLyrics || item.plainLyrics || item.lyricsfile)) : [];
    if (!matches.length) throw exactMiss || lyricsError('unmatched', t('未找到相关歌词，可修改歌曲名或填写艺人后重试。',
      'No lyric results. Edit the song title or add an artist and try again.'));
    manualLyricMatches.set(form, matches);
    status.textContent = artist && !browse ? t('没有完全匹配的结果，请选择一个版本。', 'Choose a version from the related results.') :
      t('请根据艺人、专辑或时长选择歌曲版本。', 'Choose a version by artist, album or duration.');
    results.innerHTML = matches.map((item, index) => btn(
      [lookupText(item.trackName || item.name), lookupText(item.artistName), lookupText(item.albumName),
        Number.isFinite(item.duration) && item.duration > 0 ? formatTime(item.duration) : '',
      ].filter(Boolean).join(' · '), 'music-2', 'choose-lyric-match', 'data-index="' + index + '"')).join('');
  } catch (error) {
    if (activeManualLyricRequest(job)) {
      status.textContent = displayError(error, t('歌词查询失败。', 'Could not search for lyrics.'));
    }
  } finally {
    if (manualLyricJob === job) {
      manualLyricJob = undefined;
      submit.disabled = false;
    }
  }
}
async function chooseLyricMatch(button) {
  const form = button.closest('[data-form="lyric-match"]');
  if (!form || manualLyricTracks.get(form) !== player.getState().track) {
    if (form) $('[data-lyric-status]', form).textContent = t('播放歌曲已变化，请关闭后重新打开歌词查询。',
      'The playing track changed. Close and reopen the lyric search.');
    return;
  }
  const item = manualLyricMatches.get(form)?.[Number(button.dataset.index)];
  if (!item || manualLyricJob) return;
  const job = manualLyricJob = { form, controller: new AbortController(), public: true, track: player.getState().track, epoch: lyricCacheEpoch };
  try {
    const lines = await linesFromOnlineLyrics(item);
    applyMatchedLyrics(job, lines);
  } catch (error) {
    if (activeManualLyricRequest(job)) {
      $('[data-lyric-status]', form).textContent = displayError(error, t('歌词查询失败。', 'Could not search for lyrics.'));
    }
  } finally { if (manualLyricJob === job) manualLyricJob = undefined; }
}
function lookupText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}
function lyricsError(code, message) {
  return Object.assign(new Error(message), { code });
}
async function lrclibResponse(url, signal) {
  const deadline = AbortSignal.timeout(10000);
  const response = await fetch(url, {
    credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { 'Lrclib-Client': 'Groovebox/1.0 (' + location.origin + ')' },
  });
  signal?.throwIfAborted();
  if (response.status === 429 || response.status === 503) {
    const retry = response.headers.get('Retry-After');
    const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
    lyricsRetryAt = Date.now() + Math.max(1000, delay || (response.status === 429 ? 60000 : 1000));
    throw lyricsError('busy', t('歌词服务暂时繁忙，请稍后再试。', 'The lyrics service is busy. Try again shortly.'));
  }
  if (response.status === 404) throw lyricsError('unmatched', t('未找到匹配歌词，可以修改歌曲名、艺人或专辑后重试。',
    'No matching lyrics. Edit the song title, artist, or album and try again.'));
  if (!response.ok) throw new InterfaceError('歌词服务暂时不可用。', 'The lyrics service is temporarily unavailable.');
  return response.json();
}
function lyricBackoff(source = metadataLyricsStatus) {
  return source && source.adapter !== 'none' ? customLyricRetryAt.get(source.revision) || 0 : lyricsRetryAt;
}
function assertLyricApiSource(status, expected) {
  if (!expected || expected.adapter !== status.adapter || expected.revision !== status.revision) {
    throw new InterfaceError('歌词接口设置已变化，请关闭后重新打开查询。', 'Lyric API settings changed. Close and reopen the search.');
  }
}
async function lookupLyrics({ title, artist, album, duration }, signal, expected) {
  const status = await refreshMetadataLyricsStatus(true);
  signal?.throwIfAborted();
  if (expected) assertLyricApiSource(status, expected);
  if (status.adapter !== 'none') {
    const response = await fetch('/api/metadata/lyrics', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Metadata-Revision': status.revision },
      body: JSON.stringify({ title, artist, album, duration: Number(duration) || 0 }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    const item = await response.json();
    signal?.throwIfAborted();
    if (response.status === 404) throw lyricsError('unmatched', t('自定义接口未找到匹配歌词。', 'The configured API found no matching lyrics.'));
    if (response.status === 429) {
      customLyricRetryAt.set(status.revision, Date.now() + Math.min(600, Math.max(1, Number(item.retryAfter) || 60)) * 1000);
      throw lyricsError('busy', t('自定义歌词接口暂时繁忙。', 'The configured lyric API is busy.'));
    }
    if (!response.ok || !validMetadataLyricSource(item) || item.adapter !== status.adapter || item.revision !== status.revision ||
        metadataLyricsStatus.adapter !== status.adapter || metadataLyricsStatus.revision !== status.revision) {
      throw new InterfaceError('自定义歌词接口不可用或设置已变化，请重试。', 'The lyric API is unavailable or its settings changed. Try again.');
    }
    return { lines: await linesFromOnlineLyrics(item), source: { adapter: item.adapter, revision: item.revision } };
  }
  const url = new URL('https://lrclib.net/api/get');
  url.searchParams.set('track_name', title);
  url.searchParams.set('artist_name', artist);
  if (album) url.searchParams.set('album_name', album);
  const seconds = Math.round(Number(duration));
  if (seconds >= 1 && seconds <= 3600) url.searchParams.set('duration', String(seconds));
  return { lines: await linesFromOnlineLyrics(await lrclibResponse(url, signal)) };
}
async function linesFromOnlineLyrics(item) {
  if (item?.instrumental) throw lyricsError('unmatched', t('匹配结果为纯音乐。', 'The matched track is instrumental.'));
  if (item?.hasWordSync === true || (!item?.syncedLyrics && !item?.plainLyrics)) {
    const lines = await lyricsFromYaml(item?.lyricsfile);
    if (lines.length) return lines;
  }
  const timed = typeof item?.syncedLyrics === 'string' && item.syncedLyrics.length <= 100000 ? parseLyrics(item.syncedLyrics) : [];
  if (timed.length) return timed;
  if (typeof item?.plainLyrics === 'string' && item.plainLyrics.length <= 100000 && item.plainLyrics.trim()) {
    return [{ time: null, text: item.plainLyrics.trim() }];
  }
  throw lyricsError('unmatched', t('匹配结果没有可显示的歌词。', 'The match has no lyrics to display.'));
}
function casting() {
  return Boolean(localCast) || audio.remote?.state === 'connected' || audio.webkitCurrentPlaybackTargetIsWireless === true;
}
function updateCasting() {
  updateOpusOutputGain();
  for (const control of $$('[data-action=cast]')) {
    const active = casting();
    const label = active ? t('管理投屏', 'Manage casting') : t('投屏', 'Cast');
    control.setAttribute('aria-pressed', String(active));
    control.setAttribute('aria-label', label);
    control.title = label;
    control.classList.toggle('active', active);
  }
}
async function selectPlaybackDevice() {
  if (!player.getState().track) return announce(t('请先选择歌曲。', 'Select a song first.'));
  try {
    if (localCast) showDlnaPlayback();
    else if (typeof audio.webkitShowPlaybackTargetPicker === 'function') audio.webkitShowPlaybackTargetPicker();
    else if (typeof audio.remote?.prompt === 'function') await audio.remote.prompt();
    else void findDlnaDevices();
  } catch (error) {
    if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') {
      announce(t('暂时无法投屏，请检查浏览器是否发现可用设备。', 'Could not cast. Check for available devices in your browser.'));
    }
  }
}
const castApi = '/api/cast/';
const dlnaStatus = () => $('[data-dlna-status]', dialog);
function sayCast(message) {
  const status = dlnaStatus();
  if (status && dialog.open) status.textContent = message;
  else announce(message);
}
async function findDlnaDevices() {
  if (!player.getState().track) return announce(t('请先选择歌曲。', 'Select a song first.'));
  if (castingBusy || pendingCastCommands) return;
  castingBusy = true;
  openDialog(t('局域网投屏', 'Cast on local network'), '<div class="dialog-message" role="status" data-dlna-status>' +
    t('正在搜索 DLNA 设备…', 'Searching for DLNA devices…') + '</div>');
  const status = dlnaStatus();
  try {
    const { devices } = await api(castApi + 'devices');
    if (!dialog.open || status !== dlnaStatus()) return;
    openDialog(t('局域网投屏', 'Cast on local network'), '<div class="dialog-options">' + devices.map(device =>
      menuItem(device.name, 'cast', 'dlna-start', device.id)).join('') + '</div>' +
      '<p class="dialog-message" role="status" data-dlna-status>' + (devices.length
        ? t('请选择播放设备。', 'Select a playback device.') : t('未找到 DLNA 设备。', 'No DLNA devices found.')) +
      '</p><div class="actions">' + btn(t('重新搜索', 'Search again'), 'refresh-cw', 'dlna-find') +
      (localCast ? btn(t('返回播放控制', 'Back to playback controls'), 'cast', 'dlna-manage') : '') + '</div>');
  } catch (error) { sayCast(displayError(error, t('无法搜索 DLNA 设备。', 'Could not search for DLNA devices.'))); }
  finally { castingBusy = false; pauseWhenHidden(); }
}
function dlnaMime(blob, track) {
  if (/^(?:audio\/[a-z0-9.+-]+|application\/ogg)$/i.test(blob.type)) return blob.type;
  if (blob.type === 'video/mp4') return 'audio/mp4';
  const ext = /\.([a-z0-9]+)$/i.exec(track.path || track.src)?.[1]?.toLowerCase();
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
    ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4' })[ext];
}
async function startDlna(device, name) {
  if (castingBusy || pendingCastCommands) return;
  const { track, currentTime } = player.getState();
  if (!track) return;
  castingBusy = true;
  sayCast(t('正在准备投屏音频…', 'Preparing audio for casting…'));
  try {
    const audioBlob = await readOfflineBlob(track.id) || await fetchAudioBlob(track.src, { signal: AbortSignal.timeout(60000) });
    const mime = dlnaMime(audioBlob, track);
    if (!mime) throw new InterfaceError('所选音频格式无法通过 DLNA 投屏。', 'The selected audio format cannot be cast over DLNA.');
    const query = new URLSearchParams({ device, title: track.title, artist: track.artist || '',
      album: track.album || '', seconds: String(Math.floor(currentTime)) });
    await api(castApi + 'start?' + query, { method: 'POST', headers: { 'Content-Type': mime }, body: audioBlob });
    localCast = { device, name, title: track.title };
    const current = player.getState();
    if (current.track?.id === track.id && current.playing) void player.toggle();
    updateCasting();
    if (dialog.open && dlnaStatus()) showDlnaPlayback();
    else announce(t('已开始局域网投屏。', 'Casting started on the local network.'));
  } catch (error) { sayCast(displayError(error, t('无法开始局域网投屏。', 'Could not start casting on the local network.'))); }
  finally { castingBusy = false; pauseWhenHidden(); }
}
function showDlnaPlayback() {
  if (!localCast) return void findDlnaDevices();
  openDialog(t('局域网投屏', 'Cast on local network'), '<p class="dialog-message">' + esc(localCast.title) + ' · ' + esc(localCast.name) +
    '</p><div class="actions">' + btn(t('播放', 'Play'), 'play', 'dlna-play') + btn(t('暂停', 'Pause'), 'pause', 'dlna-pause') +
    btn(t('停止投屏', 'Stop casting'), 'square', 'dlna-stop') + btn(t('切换设备', 'Switch device'), 'cast', 'dlna-find') +
    '</div><label class="dialog-field">' + t('设备播放进度', 'Device playback position') +
    '<input id="dlna-position" type="range" min="0" max="1" value="0" disabled>' +
    '<span class="small-stat" data-dlna-time></span></label><p class="dialog-message" role="status" data-dlna-status></p>');
  void updateDlnaPosition();
}
async function updateDlnaPosition() {
  const slider = $('#dlna-position', dialog);
  if (checkingCastPosition || pendingCastCommands || !localCast || !dialog.open || !slider) return;
  checkingCastPosition = true;
  try {
    const { position, duration, state } = await api(castApi + 'position');
    if (!slider.isConnected || !localCast) return;
    if (Number.isFinite(position) && Number.isFinite(duration) && duration > 0) {
      slider.max = Math.ceil(duration);
      slider.disabled = false;
      if (document.activeElement !== slider) slider.value = Math.floor(position);
      $('[data-dlna-time]', dialog).textContent = formatTime(position) + ' / ' + formatTime(duration);
    }
    const label = ({
      PLAYING: t('正在设备上播放', 'Playing on device'),
      PAUSED_PLAYBACK: t('设备已暂停', 'Device playback paused'),
      STOPPED: t('设备已停止', 'Device playback stopped'),
    })[state];
    if (label && !castingBusy) dlnaStatus().textContent = label;
  } catch { /* Some DLNA devices expose action controls without position reporting. */ }
  finally { checkingCastPosition = false; }
}
function controlLocalCast(command, value) {
  const current = localCast;
  if (!current || castingBusy) return false;
  pendingCastCommands++;
  castControlQueue = castControlQueue.then(async () => {
    try {
      if (localCast !== current) return;
      await api(castApi + command + (command === 'seek' ? '?' + new URLSearchParams({ seconds: value }) : ''), { method: 'POST' });
      if (command === 'stop') {
        localCast = undefined;
        if (dialog.open && dlnaStatus()) dialog.close();
        announce(t('已停止局域网投屏。', 'Casting stopped.'));
        updateCasting();
      }
      return true;
    } catch (error) {
      sayCast(displayError(error, t('无法控制投屏设备。', 'Could not control the casting device.')));
      return false;
    }
    finally { pendingCastCommands--; void updateDlnaPosition(); }
  });
  return castControlQueue;
}
function playbackArtistMarkup(track, linked, fallback = '') {
  const credit = track ? trackFieldLabel(track, 'artist') : fallback;
  if (!linked || !track?.artist || track.artistIsFallback || !visibleInLibrary(track)) return esc(credit);
  const names = artistsForTrack(track).filter(artist => artist.trim() && artist !== '未知艺人');
  return names.length ? names.map(artist => '<a class="lyric-artist-link" data-lyric-artist="' + esc(artist) + '" href="#' +
    esc(encodeURIComponent('artist/' + artist)) + '">' + esc(artist) + '</a>').join(' · ') : esc(credit);
}
function queueRowScrollDelta(container, row) {
  const panelTop = container.getBoundingClientRect().top + container.clientTop;
  const panelBottom = panelTop + container.clientHeight;
  const { top, bottom } = row.getBoundingClientRect();
  if (top < panelTop) return Math.floor(top - panelTop);
  if (bottom > panelBottom) return Math.ceil(bottom - panelBottom);
  return 0;
}
const audioCodecLabels = new Map([
  ['MPEG 1 Layer 3', 'MP3'], ['MPEG 2 Layer 3', 'MP3'], ['MPEG 2.5 Layer 3', 'MP3'],
]);
const localEncodingReads = new WeakSet();
const remoteEncodingReads = new WeakSet();
let playbackEncodingProbe;
function sameEncodingSource(track, entry) {
  return Boolean(track && entry && track.id === entry.id && track.src === entry.src && track.backupAccount === entry.backupAccount);
}
function applyPlaybackEncoding(track, encoding) {
  if (encoding === undefined) return;
  const current = player.getState();
  const knownTracks = track.provider === 'local' ? locals : state.tracks;
  for (const entry of [track, ...knownTracks, ...current.queue]) {
    if (sameEncodingSource(track, entry) && entry.encoding === undefined) entry.encoding = encoding;
  }
  if (track.provider !== 'local') {
    if (cloudCatalogs.has(catalogSourceId(track))) cloudCatalogEdits.add(track.id);
    save();
  }
  if (sameEncodingSource(track, current.track)) syncPlayer(current);
}
async function probeRemotePlaybackEncoding(track, signal) {
  if (hasOffline(track.id)) {
    const file = await readOfflineBlob(track.id);
    if (file) return readAudioEncoding(file);
  }
  const { inspectRemoteEncoding } = await import('./remote-metadata.js');
  return inspectRemoteEncoding(track.src, { name: track.fileName || track.path, signal });
}
function loadPlaybackEncoding(track) {
  if (playbackEncodingProbe && !sameEncodingSource(track, playbackEncodingProbe.track)) cancelPlaybackEncodingProbe();
  if (!track || track.encoding !== undefined) return;
  if (track.provider === 'local') {
    if (localEncodingReads.has(track)) return;
    localEncodingReads.add(track);
    void readLocalAudioEncoding(track.id).then(encoding => applyPlaybackEncoding(track, encoding)).catch(() => {});
    return;
  }
  if (playbackEncodingProbe || remoteEncodingReads.has(track) || tagReads.has(track.id) || !validCloudTrack(track)) return;
  const controller = new AbortController();
  const probe = playbackEncodingProbe = { track, controller };
  remoteEncodingReads.add(track);
  void probeRemotePlaybackEncoding(track, controller.signal).then(encoding => {
    if (!controller.signal.aborted) applyPlaybackEncoding(track, encoding);
  }).catch(() => {}).finally(() => {
    if (playbackEncodingProbe === probe) playbackEncodingProbe = undefined;
  });
}
function cancelPlaybackEncodingProbe() {
  playbackEncodingProbe.controller.abort();
  remoteEncodingReads.delete(playbackEncodingProbe.track);
  playbackEncodingProbe = undefined;
}
function audioEncodingText(encoding) {
  if (!encoding) return '';
  const aac = encoding.codec === 'MPEG-4/AAC' ? (/^M4A/i.test(encoding.container) ? 'AAC (M4A)' : 'AAC') : '';
  const codec = aac || audioCodecLabels.get(encoding.codec) ||
    (encoding.codec === 'PCM' && encoding.container === 'WAVE' ? 'PCM (WAV)' : encoding.codec) || encoding.container;
  const bitrate = Math.round(encoding.bitrate / 1000);
  const sampleRate = Math.round(encoding.sampleRate / 10) / 100;
  return [codec, bitrate > 0 && bitrate + ' kbps', sampleRate > 0 && sampleRate + ' kHz',
    encoding.lossless === true && encoding.bitsPerSample &&
      t('{depth} 位', '{depth}-bit', { depth: encoding.bitsPerSample })].filter(Boolean).join(' · ');
}
function playbackEncodingMarkup(track) {
  if (!track) return '';
  const { source, active } = describePlaybackEncoding({
    track, origin: location.origin, requestedUrl: audio.src,
    currentUrl: audio.readyState >= 1 ? audio.currentSrc : undefined, compatible: compatibleMedia.get(track.id),
  });
  const original = audioEncodingText(source);
  const compatible = active?.kind === 'compatible' && audioEncodingText(active.encoding);
  return (original ? '<p class="hint" data-source-encoding>' +
    esc(t('原始文件：{format}', 'Source file: {format}', { format: original })) + '</p>' : '') +
    (compatible ? '<p class="hint" data-active-encoding>' +
      esc(t('浏览器兼容音频：{format}', 'Browser compatibility audio: {format}', { format: compatible })) + '</p>' : '') +
    (active?.kind === 'requested-limit' ? '<p class="hint" data-stream-bitrate-limit>' +
      esc(t('请求串流码率上限：{rate} kbps', 'Requested stream limit: {rate} kbps', { rate: active.capKbps })) + '</p>' : '');
}
function renderNow(snapshot) {
  const { track, queue, index } = snapshot;
  if (retainedLyricDisplay && retainedLyricDisplay.track !== track) retainedLyricDisplay = undefined;
  const showEncoding = immersive || (panelOpen && (track?.provider === 'local' || sameEncodingSource(track, panelEncodingRequest)));
  loadPlaybackEncoding(showEncoding ? track : undefined);
  const preview = track || (state.settings.demos ? demoTracks[0] : null);
  if (tab === 'lyrics' || immersive || panelOpen || state.settings.autoMatchLyrics === true) {
    fetchLyrics(track, snapshot.duration || track?.duration, snapshot.playing);
  }
  const encoding = playbackEncodingMarkup(track);
  renderImmersive(track, preview, encoding);
  const artist = playbackArtistMarkup(preview, tab === 'lyrics' && Boolean(track), 'Groovebox');
  const lines = lyricsOf(track);
  const lyricTime = snapshot.currentTime - lyricOffsetSeconds();
  const currentLine = panelOpen && tab === 'queue' && (lines.findLast(line => Number.isFinite(line.time) && line.time <= lyricTime) || lines[0]);
  const lyricPreview = typeof currentLine?.text === 'string' ? currentLine.text.trim().split(/\r?\n/, 1)[0] : '';
  const signature = JSON.stringify([preview?.id, preview?.title, trackArtwork(preview), fav(preview?.id), queue.map(item => item.id),
    index, tab, panelOpen, lines.length, suppliedLyricsOf(track).length, snapshot.playing, getLanguage(), artist, Boolean(lyricPreview), encoding]);
  if (lastNow === signature) {
    const text = $('[data-lyric-preview]', now);
    if (text && text.textContent !== lyricPreview) text.textContent = lyricPreview;
    return;
  }
  lastNow = signature;
  const previous = visibleQueueOccurrence;
  const current = panelOpen && tab === 'queue' && index >= 0 ? { id: track?.id, index } : undefined;
  visibleQueueOccurrence = current;
  const changed = previous && current && (previous.id !== current.id || previous.index !== index);
  const previousList = previous ? $('.queue-list', now) : null;
  const focused = previous && current && now.contains(document.activeElement) ? document.activeElement : null;
  const previousRow = changed ? $('.queue-row.current', now) : null;
  const reveal = current && (!previous || (previousRow && previousList &&
    !previousList.contains(focused) &&
    queueRowScrollDelta(previousList, previousRow) === 0 && queueRowScrollDelta(now, previousRow) === 0));
  const listPosition = previousList?.scrollTop ?? 0;
  const panelPosition = previous ? now.scrollTop : 0;
  now.innerHTML = '<header class="now-head"><h2>' + t('正在播放', 'Now Playing') + '</h2><span>' +
    sleepTimerButton() +
    tool(t('投屏', 'Cast'), 'cast', 'cast', 'aria-pressed="' + String(casting()) + '"', casting()) +
    tool(t('局域网 DLNA', 'Local network DLNA'), 'wifi', localCast ? 'dlna-manage' : 'dlna-find') +
    tool(t('关闭正在播放', 'Close Now Playing'), 'panel-right-close', 'close-panel') + '</span></header>' +
    '<button class="now-cover" data-action="immersive" aria-label="' + t('放大封面', 'Enlarge cover') + '">' +
    cover(preview, 'now-cover') + '</button><div class="now-title"><div class="lyrics-track-heading"><h3>' + esc(preview?.title || t('选择一首歌曲', 'Choose a track')) +
    '</h3><p>' + artist + '</p>' + encoding + '</div>' +
    tool(t('收藏当前歌曲', 'Favorite current song'), 'heart', 'favorite-current', '', fav(preview?.id)) + '</div>' +
    (lyricPreview ? '<button type="button" class="mini-lyrics" data-action="tab-lyrics" aria-label="' +
      esc(t('打开歌词', 'Open Lyrics')) + '"><span data-lyric-preview>' + esc(lyricPreview) + '</span>' + icon('chevron-right') + '</button>' : '') +
    '<div class="now-tabs"><button data-action="tab-queue" class="' + (tab === 'queue' ? 'active' : '') + '">' +
    t('播放队列', 'Queue') + '</button><button data-action="tab-lyrics" class="' +
    (tab === 'lyrics' ? 'active' : '') + '">' + t('歌词', 'Lyrics') + '</button></div>' +
    (tab === 'queue' ? '<header class="section-head"><span class="small-stat">' +
      trackCount(queue.length) + '</span>' +
      (queue.length ? '<button data-action="clear-queue">' + t('清空队列', 'Clear queue') + '</button>' : '') +
      '</header><div class="queue-list"' + (queue.length ? ' role="region" aria-label="' +
      esc(t('播放队列', 'Queue')) + '" tabindex="0"' : '') + '>' +
      (queue.length ? queue.map((item, position) =>
        '<div class="queue-row' + (index === position ? ' current' : '') + '" data-queue-track="' + esc(item.id) +
        '"><button class="track-main" data-action="queue-play" data-index="' +
        position + '"' + (index === position ? ' aria-current="true"' : '') + '>' + cover(item) + '<span class="track-details"><span class="track-name">' + esc(item.title) +
        '</span><small>' + esc(item.artist ? trackFieldLabel(item, 'artist') : '') + '</small></span></button><div class="queue-more">' +
        tool(t('队列选项', 'Queue options'), 'ellipsis', 'queue-menu', 'data-index="' + position + '"') + '</div></div>').join('')
        : '<p class="hint">' + t('播放歌曲后，队列会显示在这里。', 'Play a song to see the queue here.') + '</p>') +
      '</div>' : lyricMarkup(track));
  now.toggleAttribute('data-visible-queue', Boolean(current));
  if (current) {
    const list = $('.queue-list', now);
    list.scrollTop = listPosition;
    now.scrollTop = panelPosition;
    if (reveal) {
      const row = $('.queue-row.current', list);
      if (row) {
        list.scrollTop += queueRowScrollDelta(list, row);
        now.scrollTop += queueRowScrollDelta(now, row);
      }
    }
    if (focused) {
      const trackId = focused.closest('[data-queue-track]')?.dataset.queueTrack;
      const equivalent = focused === previousList ? list : $$('[data-action]', now).find(control =>
        control.dataset.action === focused.dataset.action && control.dataset.index === focused.dataset.index &&
        control.matches('.mini-lyrics') === focused.matches('.mini-lyrics') &&
        control.closest('[data-queue-track]')?.dataset.queueTrack === trackId);
      equivalent?.focus({ preventScroll: true });
    }
  }
  updateCasting();
}
function openLyricsTab() {
  if (tab === 'lyrics') return;
  tab = 'lyrics';
  syncPlayer(player.getState());
  $('.now-tabs [data-action="tab-lyrics"]', now)?.focus({ preventScroll: true });
}
function saveImmersiveScroll(layer) {
  const lyrics = $('.lyrics', layer);
  immersiveScroll = { track: layer.dataset.trackId, top: layer.scrollTop,
    lyricsTop: lyrics.scrollTop, line: lyrics.dataset.position ?? '-1' };
}
let lyricBrowse;
const automaticLyricScroll = new WeakMap();
function setLyricScroll(area, top) {
  const before = area.scrollTop;
  area.scrollTop = top;
  if (area.scrollTop !== before) automaticLyricScroll.set(area, area.scrollTop);
}
function scrollToCurrentLyric(area, line) {
  setLyricScroll(area, Math.max(0, line.offsetTop - area.offsetTop - 35));
}
function clearLyricBrowse() {
  if (lyricBrowse) clearTimeout(lyricBrowse.timer);
  lyricBrowse = undefined;
}
function browseLyrics(area, held) {
  const track = area.closest('.immersive')?.dataset.trackId;
  if (!track) return;
  const remainsHeld = held ?? (lyricBrowse?.track === track && lyricBrowse.held);
  clearLyricBrowse();
  const browse = { track, held: remainsHeld };
  lyricBrowse = browse;
  if (remainsHeld) return;
  browse.timer = setTimeout(() => {
    if (lyricBrowse !== browse) return;
    lyricBrowse = undefined;
    const layer = $('.immersive');
    if (layer?.dataset.trackId !== track || !player.getState().playing) return;
    const lyrics = $('.lyrics', layer);
    const current = $('[data-time].current', lyrics);
    if (current) scrollToCurrentLyric(lyrics, current);
  }, 3000);
}
document.addEventListener('scroll', event => {
  const area = event.target;
  if (!area.matches?.('.immersive .lyrics')) return;
  const expected = automaticLyricScroll.get(area);
  automaticLyricScroll.delete(area);
  if (expected !== area.scrollTop) browseLyrics(area);
}, true);
document.addEventListener('touchstart', event => {
  const area = event.target.closest?.('.immersive .lyrics');
  if (area) browseLyrics(area, true);
}, { passive: true });
for (const type of ['touchend', 'touchcancel']) document.addEventListener(type, event => {
  if (event.touches?.length) return;
  const area = event.target.closest?.('.immersive .lyrics');
  if (area) browseLyrics(area, false);
}, { passive: true });
function setLyricFocus(layer, enabled) {
  layer.toggleAttribute('data-lyric-focus', enabled);
  document.body.toggleAttribute('data-immersive-lyric-focus', enabled);
  $('.layout').inert = enabled;
  $('.player').inert = enabled;
  $('[data-action="lyric-focus"]', layer).setAttribute('aria-pressed', String(enabled));
}
function toggleLyricFocus() {
  const layer = $('.immersive');
  if (!layer) return;
  setLyricFocus(layer, !layer.hasAttribute('data-lyric-focus'));
  $('[data-action="lyric-focus"]', layer).focus({ preventScroll: true });
}
function applyFullscreenLyricsAlignment(layer = $('.immersive')) {
  layer?.toggleAttribute('data-lyrics-centered', state.settings.fullscreenLyricsCentered);
}
function renderImmersive(track, preview, encoding) {
  let layer = $('.immersive');
  if (!immersive) {
    if (layer) {
      saveImmersiveScroll(layer);
      clearLyricBrowse();
      if (layer.hasAttribute('data-lyric-focus')) setLyricFocus(layer, false);
      layer.remove();
    }
    return;
  }
  const trackId = track?.id || '';
  if (lyricBrowse && lyricBrowse.track !== trackId) clearLyricBrowse();
  const lines = lyricsOf(track);
  const artist = playbackArtistMarkup(preview, Boolean(track));
  const signature = JSON.stringify([trackId, trackArtwork(preview), preview?.title, artist, lines.length,
    suppliedLyricsOf(track).length, getLanguage(), encoding]);
  if (layer?.dataset.signature === signature && (!lines.length || lines === immersiveLyrics)) return;
  const focusedControl = layer && document.activeElement?.closest('.immersive-controls') === $('.immersive-controls', layer)
    ? document.activeElement.dataset.action : undefined;
  immersiveLyrics = lines;
  if (layer) saveImmersiveScroll(layer);
  else {
    layer = document.createElement('section');
    layer.className = 'immersive';
    applyFullscreenLyricsAlignment(layer);
    document.body.append(layer);
  }
  layer.setAttribute('aria-label', t('沉浸播放', 'Immersive Player'));
  layer.dataset.trackId = trackId;
  layer.dataset.signature = signature;
  layer.innerHTML = '<div class="immersive-art">' + cover(preview) + '</div><div class="lyrics-track-heading"><div class="immersive-track-copy"><span class="small-stat">' +
    t('正在播放', 'Now Playing') + '</span><h2>' + esc(preview?.title || t('选择一首歌曲', 'Choose a track')) +
    '</h2><p class="hint">' + artist + '</p></div>' + encoding + lyricMarkup(track) +
    '</div><div class="immersive-controls"><div class="immersive-timer">' + sleepTimerButton() + '</div>' +
    tool(t('歌词专注', 'Lyric Focus'), 'focus', 'lyric-focus', 'aria-pressed="' + layer.hasAttribute('data-lyric-focus') + '"') +
    '<div class="immersive-close">' + tool(t('关闭沉浸播放', 'Close Immersive Player'), 'minimize-2', 'immersive') + '</div></div>';
  if (immersiveScroll?.track === trackId) {
    const area = $('.lyrics', layer);
    layer.scrollTop = immersiveScroll.top;
    setLyricScroll(area, immersiveScroll.lyricsTop);
    area.dataset.restoredLine = immersiveScroll.line;
  }
  if (focusedControl) $$('[data-action]', $('.immersive-controls', layer))
    .find(button => button.dataset.action === focusedControl)?.focus({ preventScroll: true });
}
function toggleImmersive(trigger) {
  immersive = !immersive;
  immersivePointer = undefined;
  if (immersive) immersiveTrigger = trigger;
  syncPlayer(player.getState());
  if (immersive) $('.immersive-close button')?.focus({ preventScroll: true });
  else (immersiveTrigger?.isConnected ? immersiveTrigger : $('#player-art')).focus({ preventScroll: true });
}
function playingPlaylistOccurrence(snapshot) {
  const context = snapshot.playlistContext;
  if (context && playPlaylistContexts?.find(Boolean)?.playlist === context.playlist) return context.occurrence;
}
function syncRows(snapshot) {
  const locate = $('[data-playlist-locate]', content);
  if (locate) locate.disabled = !snapshot.track || !playRows.some(track => track.id === snapshot.track.id);
  const resume = $('[data-folder-resume]', content);
  if (resume) resume.disabled = !folderBookmark(playRows);
  const occurrence = playingPlaylistOccurrence(snapshot);
  for (const row of $$('[data-track]', content)) {
    const current = row.dataset.track === snapshot.track?.id && (!occurrence || row.dataset.playlistOccurrence === occurrence);
    row.classList.toggle('is-playing', current);
    if (current && !row.hasAttribute('aria-current')) row.setAttribute('aria-current', 'true');
    else if (!current && row.hasAttribute('aria-current')) row.removeAttribute('aria-current');
    if (current && state.settings.showAlbumTrackProgress && route.startsWith('album/')) {
      const meter = $('.album-track-progress', row);
      const value = trackProgress.get(row.dataset.track);
      if (meter && value !== undefined) {
        meter.hidden = false;
        if (meter.value !== value) meter.value = value;
      }
    }
  }
}
function scrollToTrack(id, occurrence) {
  const row = $$('[data-track]', content).find(item =>
    item.dataset.track === id && (!occurrence || item.dataset.playlistOccurrence === occurrence));
  if (!row) return false;
  row.scrollIntoView({ block: 'center', inline: 'nearest' });
  $('.track-main', row)?.focus({ preventScroll: true });
  return true;
}
function locatePlayingTrack() {
  const snapshot = player.getState();
  const { track } = snapshot;
  if (!track) return;
  if (panelOpen && innerWidth <= 1000) showPanel(false);
  const occurrence = playingPlaylistOccurrence(snapshot);
  if (scrollToTrack(track.id, occurrence)) return;
  if (playlistQuery && playRows.some(item => item.id === track.id)) {
    playlistQuery = '';
    resetSelection();
    render();
    if (scrollToTrack(track.id, occurrence)) return;
  }
  if (route !== 'songs' && library().some(item => item.id === track.id)) {
    trackToLocate = track.id;
    go('songs');
  } else announce(t('当前曲目已不在曲库中。', 'The current track is no longer in the library.'));
}
function progress(element, proportion) {
  element.style.setProperty('--progress', Math.max(0, Math.min(proportion * 100, 100)) + '%');
}
function syncPlayer(snapshot) {
  const { track, playing, currentTime, duration, volume, shuffle, repeat } = snapshot;
  const shownDuration = duration || track?.duration || 0;
  $('#player-title').textContent = track?.title || t('选择一首歌曲', 'Choose a track');
  $('#player-artist').textContent = track?.artist ? trackFieldLabel(track, 'artist') : 'Groovebox';
  $('.play-info').disabled = !track;
  const art = $('#player-art');
  const url = trackArtwork(track);
  if (art.dataset.cover !== url) {
    art.dataset.cover = url;
    art.innerHTML = url ? trackCoverImage(track, url) : icon('music-2');
    updatePlayButtonCoverColor();
  }
  const toggle = $('#player-toggle');
  if (toggle.dataset.playing !== String(playing)) {
    toggle.dataset.playing = String(playing);
    toggle.innerHTML = icon(playing ? 'pause' : 'play');
  }
  const playbackLabel = playing ? t('暂停', 'Pause') : t('播放', 'Play');
  if (toggle.title !== playbackLabel) {
    toggle.title = playbackLabel;
    toggle.setAttribute('aria-label', playbackLabel);
  }
  $('#player-heart').classList.toggle('active', fav(track?.id));
  $('#player-heart').setAttribute('aria-pressed', String(fav(track?.id)));
  $('#shuffle').setAttribute('aria-pressed', String(shuffle));
  const loop = $('#repeat');
  if (loop.dataset.mode !== repeat) {
    loop.dataset.mode = repeat;
    loop.setAttribute('aria-pressed', String(repeat !== 'off'));
    loop.innerHTML = icon(repeat === 'one' ? 'repeat-1' : 'repeat-2');
  }
  const repeatLabel = repeat === 'one' ? t('单曲循环', 'Repeat one')
    : repeat === 'all' ? t('列表循环', 'Repeat queue') : t('关闭循环', 'Repeat off');
  if (loop.title !== repeatLabel) loop.title = repeatLabel;
  $('#current-time').textContent = formatTime(currentTime);
  $('#duration').textContent = formatTime(shownDuration);
  $('#seek').disabled = !track || !shownDuration;
  const proportion = shownDuration > 0 ? currentTime / shownDuration : 0;
  $('#seek').value = proportion * 1000;
  progress($('#seek'), proportion);
  $('#volume').value = volume * 100;
  progress($('#volume'), volume);
  $('#mute').innerHTML = icon(volume ? 'volume-2' : 'volume-x');
  $('#mute').setAttribute('aria-label', volume ? t('静音', 'Mute') : t('取消静音', 'Unmute'));
  syncRows(snapshot);
  renderNow(snapshot);
  const timed = lyricsOf(track).filter(line => Number.isFinite(line.time));
  if (timed.length && (tab === 'lyrics' || immersive)) {
    const lyricTime = currentTime - lyricOffsetSeconds();
    const index = timed.findLastIndex(line => lyricTime >= line.time);
    for (const area of $$('.lyrics')) {
      const lines = $$('[data-time]', area);
      const previous = Number(area.dataset.position ?? -1);
      if (previous !== index) {
        lines[previous]?.classList.remove('current');
        lines[index]?.classList.add('current');
      }
      if (index >= 0 && lines[index]) {
        const words = $$('[data-word-time]', lines[index]);
        const wordIndex = words.findLastIndex(word => Number(word.dataset.wordTime) <= lyricTime);
        words.forEach((word, position) => {
          word.classList.toggle('played', position <= wordIndex);
          const end = word.dataset.wordEnd === undefined ? Infinity : Number(word.dataset.wordEnd);
          word.classList.toggle('current-word', position === wordIndex && lyricTime < end);
        });
        if (words.length) {
          const frame = lyricWordFrame({ ...timed[index], words: words.map(word => ({
            time: Number(word.dataset.wordTime), text: word.textContent,
            ...(word.dataset.wordEnd !== undefined && { endTime: Number(word.dataset.wordEnd) }),
          })) }, lyricTime, { mode: state.settings.lyricWordMode, nextTime: timed[index + 1]?.time, duration: shownDuration });
          const text = $('.lyric-words', lines[index]);
          text?.style.setProperty('--word-progress', Math.min(1, Math.max(0, frame.progress)) * 100 + '%');
          words.forEach((word, position) => word.style.setProperty('--word-opacity', frame.opacities[position]));
        }
      }
      if (index < 0) area.dataset.position = '-1';
      if (index >= 0 && area.dataset.position !== String(index)) {
        area.dataset.position = index;
        if (area.closest('.immersive') && lines[index] && area.dataset.restoredLine !== String(index) && lyricBrowse?.track !== track?.id) {
          scrollToCurrentLyric(area, lines[index]);
        }
      }
      delete area.dataset.restoredLine;
    }
  }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = playing ? 'playing' : track ? 'paused' : 'none';
    if (mediaId !== track?.id) {
      mediaId = track?.id;
      navigator.mediaSession.metadata = track && window.MediaMetadata ? new MediaMetadata({
        title: track.title, artist: trackFieldLabel(track, 'artist'), album: trackFieldLabel(track, 'album'),
        artwork: url ? [{ src: new URL(url, location.href).href }] : [],
      }) : null;
    }
    if (duration > 0 && Number.isFinite(duration)) {
      try { navigator.mediaSession.setPositionState({ duration, position: Math.min(duration, currentTime), playbackRate: audio.playbackRate }); } catch { /* optional */ }
    }
  }
  if (ready && !pendingSave) {
    pendingSave = setTimeout(() => { pendingSave = undefined; save(); }, 1200);
  }
}
function playbackReportEndpoint(track, action) {
  if (!validCloudTrack(track)) return;
  const endpoint = new URL(track.src, location.origin);
  if (!/^\/api\/sources\/[0-9a-f-]{36}\/stream$/.test(endpoint.pathname)) return;
  endpoint.pathname = endpoint.pathname.replace(/\/stream$/, '/' + action);
  return endpoint;
}

const embyPlayback = createPlaybackCheckins({
  resolveEndpoint: track => track?.provider === 'emby' ? playbackReportEndpoint(track, 'playback') : undefined,
  send: (endpoint, payload) => api(endpoint, { method: 'POST', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
});
embyPlayback.setEnabled(state.settings.reportEmbyPlayback);
const listenBrainzPlayback = createListenBrainzPlayback({
  send: payload => api('/api/listenbrainz/listen', { method: 'POST', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  onError(error) {
    if (error.status === 401) setListenBrainzAccount(null);
    announce(displayError(error, t('无法同步 ListenBrainz 收听记录。', 'Could not sync the ListenBrainz listen.')));
  },
});

const recordPlaybackHistory = createPlaybackHistoryRecorder(event => {
  state.history.unshift({ ...event, event: crypto.randomUUID() });
  if (state.history.length > historyLimit) state.history.pop();
  save();
  if (['home', 'history', 'timeline', 'frequent'].includes(route)) render();
});

function sleepTimerButton() {
  return tool(t('睡眠定时', 'Sleep Timer'), 'clock-3', 'sleep-timer', 'aria-haspopup="dialog"', Boolean(sleepTimer));
}
function sleepTimerDialog() {
  openDialog(t('睡眠定时', 'Sleep Timer'), '<form data-form="sleep-timer">' +
    '<label class="dialog-field">' + t('定时分钟数', 'Minutes') + '<input name="minutes" type="number" inputmode="numeric" ' +
    'required min="1" max="' + maxSleepTimerMinutes + '" step="1" value="' + state.settings.sleepTimerMinutes + '"></label>' +
    '<label><input type="checkbox" name="finishTrack"' + (state.settings.sleepTimerFinishTrack ? ' checked' : '') + '> ' +
    t('到时播完当前歌曲', 'Finish the current track when time is up') + '</label>' +
    '<p class="dialog-message" data-sleep-status></p><div class="actions">' +
    '<button class="btn primary" type="submit">' + t('开始定时', 'Start Timer') + '</button>' +
    btn(t('取消定时', 'Cancel Timer'), 'x', 'cancel-sleep-timer', 'disabled') + '</div></form>');
  refreshSleepTimer();
}
function refreshSleepTimer() {
  clearTimeout(sleepTimerTick);
  const remaining = sleepTimer ? sleepTimer.deadline - Date.now() : 0;
  if (sleepTimer && remaining <= 0 && (castingBusy || localCast)) {
    if (castingBusy || pendingCastCommands) sleepTimerTick = setTimeout(refreshSleepTimer, 1000);
    else void updateCastSleepTimer(sleepTimer, localCast);
    updateSleepTimerDisplay(0);
    return;
  }
  if (sleepTimer && remaining <= 0 && (!sleepTimer.finishing || sleepTimer.cast)) {
    if (sleepTimer.finishTrack && player.getState().playing && !sleepTimer.cast) sleepTimer.finishing = true;
    else {
      completeSleepTimer();
      player.pause();
      return;
    }
  }
  const status = updateSleepTimerDisplay(remaining);
  if (sleepTimer && !sleepTimer.finishing) {
    sleepTimerTick = setTimeout(refreshSleepTimer, status ? Math.min(remaining, 1000) : remaining);
  }
}
function updateSleepTimerDisplay(remaining) {
  for (const button of $$('[data-action="sleep-timer"]')) button.classList.toggle('active', Boolean(sleepTimer));
  const status = dialog.open && $('[data-sleep-status]', dialog);
  if (status) {
    status.textContent = sleepTimer?.finishing ? t('播完当前歌曲后暂停。', 'Pausing after the current track ends.') : sleepTimer
      ? t('剩余 {time}', '{time} remaining', { time: formatTime(Math.max(0, Math.ceil(remaining / 1000))) })
      : t('定时未启动。', 'Timer is off.');
    $('[data-action="cancel-sleep-timer"]', dialog).disabled = !sleepTimer;
  }
  return status;
}
async function updateCastSleepTimer(timer, cast) {
  if (timer.checkingCast) return;
  if (timer.cast && timer.cast !== cast && timer.finishing) {
    cancelSleepTimer();
    return;
  }
  timer.cast = cast;
  timer.checkingCast = true;
  const isCurrent = () => sleepTimer === timer && localCast === cast && !castingBusy && !pendingCastCommands;
  let result;
  try {
    result = await applyCastSleepDeadline({ finishTrack: timer.finishTrack,
      getPosition: () => api(castApi + 'position'), pause: () => controlLocalCast('pause'), isCurrent });
  } catch { result = isCurrent() ? 'retry' : 'changed'; }
  timer.checkingCast = false;
  if (sleepTimer !== timer) return;
  if (result === 'paused' || result === 'finished') {
    cancelSleepTimer();
    player.pause();
    announce(result === 'finished' ? t('睡眠定时已结束。', 'Sleep timer ended.') :
      t('睡眠定时结束，投屏已暂停。', 'Sleep timer ended. Casting paused.'));
    return;
  }
  if (result === 'finishing') {
    timer.finishing = true;
    timer.castFailures = 0;
  }
  if (result === 'retry' && (timer.castFailures = (timer.castFailures || 0) + 1) >= 3) {
    cancelSleepTimer();
    announce(t('睡眠定时无法确认投屏已暂停。', 'The sleep timer could not confirm that casting paused.'));
    return;
  }
  updateSleepTimerDisplay(0);
  clearTimeout(sleepTimerTick);
  sleepTimerTick = setTimeout(refreshSleepTimer, 1000);
}
function checkSleepTimer() {
  if (sleepTimer && !sleepTimer.finishing && Date.now() >= sleepTimer.deadline) refreshSleepTimer();
}
function cancelSleepTimer() {
  sleepTimer = undefined;
  refreshSleepTimer();
}
function completeSleepTimer() {
  cancelSleepTimer();
  announce(t('睡眠定时结束，播放已暂停。', 'Sleep timer ended. Playback paused.'));
}
function startSleepTimer(data) {
  const minutes = Number(data.minutes);
  if (!validSleepTimerMinutes(minutes)) return;
  const finishTrack = data.finishTrack === 'on';
  state.settings.sleepTimerMinutes = minutes;
  state.settings.sleepTimerFinishTrack = finishTrack;
  sleepTimer = { deadline: Date.now() + minutes * 60_000, finishTrack };
  save();
  refreshSleepTimer();
}

const player = createPlayer(audio, {
  preloader: createTrackPreloader({ available: track => !hasOffline(track.id) && !compatibleMedia.has(track.id) && !streamBitrate(track) &&
    !localCast && (!audio.remote || audio.remote.state === 'disconnected') && !navigator.connection?.saveData }),
  onChange: syncPlayer,
  onPlaybackChange(snapshot, event, played) {
    if (event.reason === 'stop' && retainedLyricDisplay?.track === snapshot.track) retainedLyricDisplay = undefined;
    if (!localCast && sleepTimer?.finishing && event.reason === 'stop' && !audio.ended) cancelSleepTimer();
    updateFolderBookmark(snapshot);
    updateTrackProgress(snapshot);
    recordPlaybackHistory(snapshot, event, played);
    embyPlayback.update(snapshot, event);
    listenBrainzPlayback.update(snapshot, event, played);
  },
  onPlay(track, playlistContext) {
    if (state.settings.rememberPlaylistPosition && validPlaylistContext(playlistContext, track.id) &&
        (!playlistContext.playlist.startsWith('playlist/') ||
          state.playlists.some(list => 'playlist/' + list.id === playlistContext.playlist))) {
      playlistResumeBookmarks.set(playlistContext.playlist, playlistContext.occurrence);
    }
    remember(track);
    const direct = isDirectCloudSource(librarySourceId(track));
    if (direct) state.directRecent = [{ id: track.id, at: Date.now() },
      ...state.directRecent.filter(item => item.id !== track.id)].slice(0, directRecentLimit);
    save();
    if (direct && (route === 'home' || route === 'history')) render();
    applyEqualizer();
    updateOpusOutputGain();
    if (state.settings.autoReadTags && !hasOffline(track.id) && (!track.embeddedTags || track.encoding === undefined) && !viewedTags.has(track.id)) {
      void readEmbeddedTags(track);
    }
    stopCustomArtwork(job => job.playing && !job.valid());
    void matchOnlineCover(track, false, { playing: true });
  },
  onEnded(track) {
    if (folderPlayback && folderBookmarks.get(folderPlayback.key)?.trackId === track.id) folderBookmarks.delete(folderPlayback.key);
    if (state.settings.reportServerPlayback === true && ['subsonic', 'opensubsonic', 'navidrome'].includes(track.provider)) {
      const endpoint = playbackReportEndpoint(track, 'played');
      if (endpoint) void api(endpoint, { method: 'POST', keepalive: true }).catch(() => {});
    }
    if (!localCast && sleepTimer && (sleepTimer.finishing || Date.now() >= sleepTimer.deadline)) {
      completeSleepTimer();
      return false;
    }
  },
  onError(error, track, { wantsPlayback, retry }) {
    const unsupported = error?.name === 'NotSupportedError' || [3, 4].includes(audio.error?.code);
    if (wantsPlayback && unsupported && /\.(ape|dsf|dff|wma|wv|tta|dts|ac3|mka|amr)$/i.test(track.path || track.title) &&
      (track.src?.startsWith('blob:') || validCloudTrack(track)) && !compatibleMedia.has(track.id)) {
      void prepareCompatibleAudio(track, { retry });
      return;
    }
    const cloudTrack = !['local','demo'].includes(track?.provider);
    const title = track?.title || t('此歌曲', 'this song');
    announce(t('无法播放「{title}」。', 'Could not play “{title}”. ', { title }) + (cloudTrack
      ? t('请确认来源已连接。', 'Check that the source is connected.')
      : t('请检查文件格式和浏览器支持。', 'Check the file format and browser support.')));
    console.warn('Playback error', error?.name);
  },
  resolveTrack: track => compatibleMedia.get(track.id)?.url || resolveOriginalAudio(track, streamBitrate(track)),
});
function streamBitrate(track) {
  return supportsStreamBitrate(track.provider) ? preferredStreamBitrate(state.settings.streamBitrates, navigator.connection) : 0;
}
function resolveOriginalAudio(track, bitrate = 0) {
  const src = track.src;
  const original = () => {
    if (typeof src !== 'string' || !(/^\/(?:assets|api)\//.test(src) || src.startsWith('blob:'))) {
      throw new Error('Unsupported audio source');
    }
    if (!bitrate || !/^\/api\/sources\/[a-f0-9-]{36}\/stream\?/.test(src)) return src;
    const url = new URL(src, location.origin);
    url.searchParams.set('maxBitRate', String(bitrate));
    return url.pathname + url.search;
  };
  return hasOffline(track.id) ? loadOfflineUrl(track.id, audio.currentSrc).then(url => url || original()) : original();
}
function updateTrackProgress({ track, duration, currentTime }) {
  if (!track || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return;
  const value = Math.round(Math.max(0, Math.min(1, currentTime / duration)) * 100);
  if (trackProgress.get(track.id) === value) return;
  trackProgress.delete(track.id);
  trackProgress.set(track.id, value);
  if (trackProgress.size > trackProgressLimit) trackProgress.delete(trackProgress.keys().next().value);
}
function validFolderPlaybackKey(value) {
  return typeof value === 'string' && value.length <= 4096 && /^(?:local-folder|source)\/[\s\S]/.test(value);
}
function currentFolderPlaybackKey() {
  if (!folderViewIsOpen()) return;
  if (route.startsWith('local-folder/')) return route;
  return 'source/' + JSON.stringify([cloud.id, cloud.trail.at(-1).path]);
}
function updateFolderBookmark({ track, currentTime }) {
  if (!folderPlayback?.members.has(track?.id) || audio.ended || !Number.isFinite(currentTime) || currentTime < 0) return;
  const { key } = folderPlayback;
  folderBookmarks.delete(key);
  folderBookmarks.set(key, { trackId: track.id, position: currentTime });
  if (folderBookmarks.size > folderBookmarkLimit) folderBookmarks.delete(folderBookmarks.keys().next().value);
}
function folderBookmark(tracks, folder = currentFolderPlaybackKey()) {
  const mark = folderBookmarks.get(folder);
  return mark && tracks.some(track => track.id === mark.trackId) ? mark : undefined;
}
function folderResumeAction() {
  return btn(t('继续播放目录', 'Resume Folder'), 'history', 'resume-folder', 'data-folder-resume disabled');
}
function resumeFolder() {
  const folder = currentFolderPlaybackKey();
  const mark = folderBookmark(playRows, folder);
  if (!mark) return;
  playList(playRows, playRows.findIndex(track => track.id === mark.trackId), { folder, position: mark.position });
}
function playList(tracks, index = 0, { folder, position, playlistContexts } = {}) {
  if (!tracks.length) return announce(t('当前没有可播放的歌曲。', 'No playable songs here.'));
  for (const track of tracks) remember(track);
  void player.load(tracks, index, true, folder || playlistContexts ? {
    position: folder ? position ?? 0 : undefined, playlistContexts,
  } : undefined);
  folderPlayback = validFolderPlaybackKey(folder) ? { key: folder, members: new Set(tracks.map(track => track.id)) } : undefined;
}
function playRandomAlbum() {
  const albums = [...groupTracks('album').values()];
  if (!albums.length) return;
  playShuffledList(albums[Math.floor(Math.random() * albums.length)]);
}
function playShuffledList(tracks) {
  if (!tracks.length) return;
  const index = Math.floor(Math.random() * tracks.length);
  state.settings.shuffle = player.shuffle(true);
  playList(tracks, index);
  save();
}
function playTrackFromList(tracks, index, trigger) {
  const track = tracks[index];
  if (!track) return;
  const context = playPlaylistContexts?.[index];
  const single = !state.settings.queueAllDirectTracks && trigger?.hasAttribute('data-direct-collection');
  if (state.settings.openPlaybackOnCurrentTrack === true) {
    const snapshot = player.getState();
    const id = track.id;
    if (snapshot.playing && snapshot.track?.id === id && (!single || snapshot.queue.length === 1)) {
      const duplicate = tracks.some((track, position) => position !== index && track.id === id);
      const sameOccurrence = playPlaylistContexts ? context && context.playlist === snapshot.playlistContext?.playlist &&
        context.occurrence === snapshot.playlistContext.occurrence :
        !duplicate || (snapshot.index === index && tracks.length === snapshot.queue.length &&
          tracks.every((track, position) => track.id === snapshot.queue[position].id));
      if (openPlayingTrackDetails(snapshot, sameOccurrence, trigger)) return;
    }
  }
  const folder = currentFolderPlaybackKey();
  if (single) playList([track], 0, { folder, playlistContexts: context ? [context] : undefined });
  else playList(tracks, index, { folder, playlistContexts: playPlaylistContexts });
  openPlaybackForTrack(trigger);
}
function openPlayingTrackDetails(snapshot, sameOccurrence, trigger) {
  if (state.settings.openPlaybackOnCurrentTrack !== true || !snapshot.playing || !sameOccurrence) return false;
  if (!immersive) toggleImmersive(trigger);
  return true;
}
function openPlaybackForTrack(trigger) {
  if (state.settings.openPlaybackOnTrack === true && !immersive) toggleImmersive(trigger);
}
function togglePlayback() {
  if (player.getState().queue.length) void player.toggle();
  else playList(library());
}
function pauseWhenHidden() {
  if (!state.settings.pauseInBackground || !document.hidden) return;
  player.pause();
  if (localCast) void controlLocalCast('pause');
}
function showPanel(open, readEncoding = false) {
  panelOpen = open;
  panelEncodingRequest = open && readEncoding ? player.getState().track : undefined;
  document.body.classList.toggle('panel-closed', !open);
  document.body.classList.toggle('panel-open', open);
  lastNow = '';
  syncPlayer(player.getState());
}
function queueMenu(index) {
  const { queue, index: current } = player.getState();
  if (!queue[index]) return;
  const attr = 'data-index="' + index + '"';
  openDialog(queue[index].title, '<div class="dialog-options">' +
    (current === index ? originalAudioMenuItem(queue[index]) : '') +
    (index > 0 ? btn(t('上移', 'Move up'), 'chevron-up', 'queue-up', attr) : '') +
    (index < queue.length - 1 ? btn(t('下移', 'Move down'), 'chevron-down', 'queue-down', attr) : '') +
    btn(t('移出队列', 'Remove from queue'), 'trash-2', 'queue-remove', attr) + '</div>');
}
async function returnToOriginalAudio(id) {
  const { track } = player.getState();
  if (track?.id !== id || !compatibleTrackIsCurrent(track)) return;
  if (castingBusy || casting() || audio.remote?.state === 'connecting') {
    return announce(t('投屏结束后可切回原始音源。', 'Return to original audio after casting ends.'));
  }
  const compatible = compatibleMedia.get(id);
  const result = await player.switchSource(resolveOriginalAudio);
  if (result === 'changed') {
    if (compatible === compatibleMedia.get(id)) {
      compatibleMedia.delete(id);
      URL.revokeObjectURL(compatible.url);
    }
    save();
    announce(t('已切回原始音源。', 'Switched to original audio.'));
  } else if (result === 'restored') {
    announce(t('无法播放原始音源，已保留兼容音频。', 'The original audio could not be played. The compatible version is still available.'));
  }
}
async function prepareCompatibleAudio(track, { retry } = {}) {
  if (!track) return;
  const pending = converting.get(track.id);
  if (pending) {
    if (retry) pending.retry = retry;
    return;
  }
  const previous = player.getState().track?.id;
  const src = track.src;
  if (!(src?.startsWith('blob:') || validCloudTrack(track))) return announce(t('找不到用于兼容播放的音频。', 'No audio source is available for compatibility playback.'));
  const request = new AbortController();
  const job = { request, retry };
  converting.set(track.id, job);
  try {
    if (!compatibleMedia.has(track.id)) {
      announce(t('正在准备兼容音频，长曲目可能需要一些时间…', 'Preparing compatible audio. Long tracks may take a while…'));
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(180000)]);
      await api('/api/transcode/status', { signal });
      const input = await readOfflineBlob(track.id) || await fetchAudioBlob(src, { signal, allowUnknownType: true, maxBytes: 128 * 1024 * 1024 });
      const supportsFlac = Boolean(audio.canPlayType('audio/flac') || audio.canPlayType('audio/x-flac'));
      const response = await fetch('/api/transcode' + (supportsFlac ? '?format=flac' : ''), {
        method: 'POST',
        headers: { 'Content-Type': input.type || 'application/octet-stream' },
        body: input, signal,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || t('兼容音频准备失败。', 'Could not prepare compatible audio.'));
      }
      const output = await response.blob();
      if (!output.size || output.type !== (supportsFlac ? 'audio/flac' : 'audio/mpeg')) {
        throw new InterfaceError('服务端未返回可播放的兼容音频。', 'The server did not return playable audio.');
      }
      if (request.signal.aborted) return;
      const compatible = { url: URL.createObjectURL(output), mime: output.type };
      compatibleMedia.set(track.id, compatible);
      void readAudioEncoding(output).then(encoding => {
        if (compatibleMedia.get(track.id) !== compatible) return;
        compatible.encoding = encoding;
        const current = player.getState();
        if (current.track?.id === track.id) syncPlayer(current);
      }).catch(() => {});
      if (compatibleMedia.size > 4) {
        const active = player.getState().track?.id;
        const [old, media] = [...compatibleMedia].find(([id]) => id !== active && id !== track.id);
        compatibleMedia.delete(old);
        URL.revokeObjectURL(media.url);
      }
    }
    if (job.retry) {
      if (await job.retry()) announce(t('正在播放兼容音频。', 'Playing compatible audio.'));
      return;
    }
    const current = player.getState();
    if (current.track?.id === previous || current.track?.id === track.id) {
      const queue = current.queue.some(item => item.id === track.id) ? current.queue : [track, ...current.queue];
      await player.load(queue, queue.findIndex(item => item.id === track.id), false);
      save();
    }
    announce(t('兼容音频已准备好。点击播放即可收听。', 'Compatible audio is ready. Select Play to listen.'));
  } catch (error) {
    if (!request.signal.aborted) announce(displayError(error, t('兼容音频准备失败。', 'Could not prepare compatible audio.')));
  }
  finally { if (converting.get(track.id) === job) converting.delete(track.id); }
}
async function compactCover(image) {
  if (!(image instanceof Blob)) return undefined;
  const bitmap = await createImageBitmap(image);
  try {
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .78);
  } finally {
    bitmap.close();
  }
}
function bulkTagAction(tracks) {
  if (bulkTagJob) return btn(t('取消标签读取', 'Cancel Tag Reading'), 'x', 'cancel-read-tags');
  if (!tracks.some(validCloudTrack)) return '';
  const hasUnread = tracks.some(track => validCloudTrack(track) && !track.embeddedTags);
  return btn(t('批量读取音频标签', 'Read Audio Tags in Bulk'), 'tags', 'read-tags-bulk', hasUnread ? '' : 'disabled');
}

function bulkTagStatus(job) {
  return t('正在读取音频标签：{checked} / {total}，已更新 {updated} 首',
    'Reading audio tags: {checked} / {total}, updated {updated}',
    { checked: job.checked, total: job.total, updated: job.updated });
}

function bulkTagStatusMarkup() {
  return bulkTagJob ? '<p class="hint" role="status" data-bulk-tag-status>' + esc(bulkTagStatus(bulkTagJob)) + '</p>' : '';
}

async function readVisibleTrackTags(tracks) {
  if (bulkTagJob) return;
  const candidates = [...new Map(tracks.filter(validCloudTrack).map(track => [track.id, track])).values()];
  if (!candidates.some(track => !track.embeddedTags)) return;
  const job = bulkTagJob = { controller: new AbortController(), ignored: new Set(), total: candidates.length,
    readIds: new Set(state.tracks.filter(track => track.embeddedTags).map(track => track.id)),
    checked: 0, updated: 0, empty: 0, skipped: 0, failed: 0 };
  const { signal } = job.controller;
  render();
  $('[data-action=cancel-read-tags]', content)?.focus({ preventScroll: true });
  try {
    for (const track of candidates) {
      if (signal.aborted) break;
      const read = track.embeddedTags || job.readIds.has(track.id);
      const outcome = read || job.ignored.has(track.id) ? 'skipped' : await readEmbeddedTags(track, false, signal);
      if (signal.aborted) break;
      job[outcome]++;
      job.checked++;
      const status = $('[data-bulk-tag-status]', content);
      if (status) status.textContent = bulkTagStatus(job);
    }
  } finally {
    bulkTagJob = undefined;
    let persistenceError;
    try { await flushCloudCatalogEdits(); } catch (error) { persistenceError = error; }
    const restoreFocus = document.activeElement?.dataset.action === 'cancel-read-tags';
    refreshCurrent();
    if (restoreFocus) $('[data-action=read-tags-bulk]:enabled', content)?.focus({ preventScroll: true });
    const message = signal.aborted
      ? t('已取消批量读取。已更新 {updated} 首。', 'Bulk tag reading canceled. Updated {updated}.', { updated: job.updated })
      : t('标签读取完成。已更新 {updated} 首，跳过 {skipped} 首，无标签 {empty} 首，失败 {failed} 首。',
        'Tag reading complete. Updated {updated}, skipped {skipped}, no tags {empty}, failed {failed}.',
        { updated: job.updated, skipped: job.skipped, empty: job.empty, failed: job.failed });
    announce(persistenceError instanceof CloudCatalogError ? catalogErrorMessage(persistenceError) : message);
  }
}

async function readEmbeddedTags(track, manual = false, batchSignal) {
  if (!validCloudTrack(track) || tagReads.has(track.id) || batchSignal?.aborted) return 'skipped';
  if (playbackEncodingProbe?.track.id === track.id) cancelPlaybackEncodingProbe();
  const request = new AbortController();
  tagReads.set(track.id, request);
  if (!batchSignal) viewedTags.add(track.id);
  const canceled = () => request.signal.aborted || batchSignal?.aborted;
  if (manual) announce(t('正在读取音频标签…', 'Reading audio tags…'));
  try {
    const { inspectRemoteTrack } = await import('./remote-metadata.js');
    const signals = [request.signal, AbortSignal.timeout(12000)];
    if (batchSignal) signals.push(batchSignal);
    const tags = await inspectRemoteTrack(track.src, {
      name: track.fileName || track.path || track.title, signal: AbortSignal.any(signals),
    });
    const embeddedTags = {};
    for (const field of ['title','artist','album']) {
      if (typeof tags[field] === 'string' && tags[field].trim()) embeddedTags[field] = tags[field].trim().slice(0, 300);
    }
    for (const field of ['duration','replayGain','replayGainPeak','replayGainAlbum','replayGainAlbumPeak','r128TrackGain','r128AlbumGain']) {
      if (Number.isFinite(tags[field])) embeddedTags[field] = tags[field];
    }
    const releaseYear = normalizeReleaseYear(tags.releaseYear);
    if (releaseYear) embeddedTags.releaseYear = releaseYear;
    const albumArtist = normalizeAlbumArtist(tags.albumArtist);
    if (albumArtist) embeddedTags.albumArtist = albumArtist;
    const genres = normalizeGenres(tags.genres);
    if (genres.length) embeddedTags.genres = genres;
    if (tags.encoding) embeddedTags.encoding = tags.encoding;
    if (Array.isArray(tags.lyrics) && tags.lyrics.length) embeddedTags.lyrics = tags.lyrics;
    const thumbnail = await compactCover(tags.cover).catch(() => undefined);
    if (safeImage(thumbnail)) embeddedTags.cover = thumbnail;
    if (canceled()) return 'skipped';
    const hasTags = Object.keys(embeddedTags).length > 0;
    if (!hasTags && !batchSignal) {
      if (manual) announce(t('音频中没有可读取的标签。', 'This audio file has no readable tags.'));
      return 'empty';
    }
    embeddedTags.replayGainAlbumRead = true;
    embeddedTags.r128GainRead = true;
    if (!embeddedTags.encoding) embeddedTags.encoding = null;
    const update = entry => {
      const values = { ...embeddedTags };
      if (entry.parsedFromFilename === true) for (const field of ['title', 'artist', 'album', 'albumArtist']) delete values[field];
      Object.assign(entry, { r128TrackGain: undefined, r128AlbumGain: undefined, ...values, embeddedTags, lyrics: entry.lyrics || embeddedTags.lyrics,
        genres: normalizeGenres([...normalizeGenres(entry.genres), ...genres]),
        artistIsFallback: values.artist ? false : entry.artistIsFallback,
        albumIsFallback: values.album ? false : entry.albumIsFallback });
    };
    update(track);
    for (const entry of player.getState().queue) if (entry.id === track.id && entry !== track) update(entry);
    remember(track);
    bulkTagJob?.readIds.add(track.id);
    mediaId = undefined;
    const playerState = player.getState();
    if (playerState.track?.id === track.id) {
      stopCustomArtwork(job => job.playing && !job.valid());
      void matchOnlineCover(track, false, { playing: true });
    }
    save();
    if (cloudCatalogs.has(catalogSourceId(track)) && (!batchSignal || cloudCatalogEdits.size >= 16)) await flushCloudCatalogEdits();
    if (!batchSignal) refreshCurrent();
    else if (playerState.track?.id === track.id) {
      lastNow = '';
      syncPlayer(playerState);
    }
    if (!batchSignal || playerState.track?.id === track.id) applyEqualizer();
    if (manual) announce(t('已更新歌曲标签。', 'Track tags updated.'));
    return hasTags ? 'updated' : 'empty';
  } catch (error) {
    if (manual && !request.signal.aborted) announce(error instanceof CloudCatalogError ? catalogErrorMessage(error) :
      t('无法读取内置标签，请检查音源是否支持分段读取。', 'Could not read embedded tags. Check that the source supports range requests.'));
    return canceled() ? 'skipped' : 'failed';
  } finally {
    if (tagReads.get(track.id) === request) tagReads.delete(track.id);
  }
}
function chooseLocalImport({ kind, name, existing }) {
  const folder = kind === 'folder';
  const keep = folder ? t('导入为独立曲集', 'Import Separate Collection') : t('保留两首', 'Keep Both');
  const replace = folder ? t('更新已有曲集', 'Update Existing Collection') : t('替换已导入副本', 'Replace Imported Copy');
  const prompt = folder ? t('已导入过同名文件夹「{name}」。请选择要更新的曲集，或独立导入。',
    'A folder named “{name}” has already been imported. Choose a collection to update or import it separately.', { name }) :
    t('已有文件名为「{name}」的录音，内容不同。替换只会更新播放器中的副本。',
      'An imported recording named “{name}” has different contents. Replacing updates the player’s copy.', { name });
  return new Promise(resolve => {
    openDialog(folder ? t('导入同名文件夹', 'Import a Folder With the Same Name') : t('导入同名录音', 'Import a Recording With the Same Name'),
      '<div data-local-import-choice><p class="dialog-message">' + esc(prompt) + '</p>' +
      (existing.length > 1 ? '<label class="dialog-field">' + t('要更新的副本', 'Copy to Update') + '<select name="collection">' +
        existing.map((entry, index) => '<option value="' + index + '">' + esc(entry.label) + '</option>').join('') + '</select></label>' :
        '<p class="dialog-message">' + esc(existing[0].label) + '</p>') +
      '<div class="actions"><button type="button" class="btn primary" data-local-import-action="keep" autofocus>' + esc(keep) + '</button>' +
      '<button type="button" class="btn" data-local-import-action="replace">' + esc(replace) + '</button>' +
      '<button type="button" class="btn" data-local-import-action="cancel">' + t('取消', 'Cancel') + '</button></div></div>');
    const panel = $('[data-local-import-choice]', dialog);
    const cancel = () => { if (!dialog.open || !dialog.contains(panel)) finish(null); };
    const observer = new MutationObserver(cancel);
    const finish = decision => {
      observer.disconnect();
      dialog.removeEventListener('close', cancel);
      resolve(decision);
    };
    observer.observe(dialog, { childList: true });
    dialog.addEventListener('close', cancel);
    panel.addEventListener('click', event => {
      const action = event.target.closest('[data-local-import-action]')?.dataset.localImportAction;
      if (!action || !dialog.open || !dialog.contains(panel)) return;
      const choice = existing[Number($('select', panel)?.value ?? 0)];
      finish(action === 'cancel' ? null : { action, id: choice?.id });
      dialog.close();
    });
    $('[autofocus]', panel).focus();
  });
}

let localLyricsTarget;
let localSelectionJob = Promise.resolve();
function queueLocalSelection(files, lyricsTarget) {
  localSelectionJob = localSelectionJob.then(() => importSelection(files, lyricsTarget));
}

function replaceImportedTrack(track, updated) {
  for (const key of Object.keys(track)) if (!Object.hasOwn(updated, key)) delete track[key];
  Object.assign(track, updated);
}

function announceBlockedLocalLibrary() {
  announce(t('请关闭打开此播放器的其他标签页，再刷新本页以完成本地曲库更新。',
    'Close other tabs that have this player open, then reload this page to finish updating the local library.'));
}

async function importSelection(files, lyricsTarget) {
  const startingRoute = route;
  if (!files?.length) return;
  const retained = new Set();
  const retainAudioURL = url => {
    if (audio.src !== url) return false;
    retained.add(url);
    return true;
  };
  announce(t('正在导入音乐…', 'Importing music…'));
  try {
    const imported = await importLocalFiles(files, { resolveConflict: chooseLocalImport, lyricsTarget, retainAudioURL });
    if (!imported) return announce(t('已取消导入。', 'Import canceled.'));
    const prior = new Map(locals.map(track => [track.id, track.src]));
    const replaced = new Set(imported.filter(track => prior.has(track.id) && prior.get(track.id) !== track.src).map(track => track.id));
    invalidateImportedLyricMatches(replaced);
    locals = [...new Map([...locals, ...imported].map(track => [track.id, track])).values()];
    localArtistImages = await hydrateLocalArtistImages();
    const current = player.getState();
    let activeReplacement;
    for (const track of current.queue) {
      const updated = imported.find(item => item.id === track.id);
      if (!updated) continue;
      if (updated.src !== track.src) {
        const compatible = compatibleMedia.get(track.id);
        if (compatible && !retainAudioURL(compatible.url)) URL.revokeObjectURL(compatible.url);
        compatibleMedia.delete(track.id);
        if (track === current.track) activeReplacement = updated;
        else replaceImportedTrack(track, updated);
      } else Object.assign(track, { lyrics: updated.lyrics, cover: updated.cover });
    }
    if (activeReplacement) {
      const result = await player.switchSource(() => activeReplacement.src);
      if (result === 'changed' || result === 'failed' || player.getState().track !== current.track) {
        replaceImportedTrack(current.track, activeReplacement);
      } else {
        const refreshOnAdvance = () => {
          if (player.getState().track === current.track) return;
          audio.removeEventListener('loadstart', refreshOnAdvance);
          audio.removeEventListener('emptied', refreshOnAdvance);
          replaceImportedTrack(current.track, activeReplacement);
        };
        audio.addEventListener('loadstart', refreshOnAdvance);
        audio.addEventListener('emptied', refreshOnAdvance);
      }
      invalidateImportedLyricMatches(replaced);
    }
    announce(imported.length ? t('已导入或更新 {count} 首本地歌曲', 'Local tracks imported or updated: {count}', { count: imported.length }) : t('没有找到可导入的音频或匹配的歌词', 'No audio files or matching lyrics were found'));
    refreshCurrent();
    if (startingRoute === 'sources' && route === startingRoute) go('songs');
  } catch (error) {
    if (error.code === 'local-library-upgrade-blocked') return announceBlockedLocalLibrary();
    const previousCount = locals.length;
    try { [locals, localArtistImages] = await Promise.all([hydrateLocals(), hydrateLocalArtistImages()]); }
    catch { /* Keep the previous visible library. */ }
    refreshCurrent();
    const imported = Math.max(0, locals.length - previousCount);
    announce(error.code === 'stale-local-import' ? t('本地曲库已变化，请重新选择要导入的文件。',
      'The local library changed. Select the files again to import them.') : imported ? t('已保存 {count} 首歌曲。部分导入失败，请检查浏览器存储空间。',
      'Tracks saved: {count}. Some imports failed. Check your browser storage space.',
      { count: imported }) : t('导入失败，请检查浏览器存储空间。', 'Import failed. Check your browser storage space.'));
    console.warn(error?.name);
  } finally {
    for (const url of retained) {
      const release = () => {
        if (audio.src === url) return;
        URL.revokeObjectURL(url);
        audio.removeEventListener('loadstart', release);
        audio.removeEventListener('emptied', release);
      };
      if (audio.src === url) {
        audio.addEventListener('loadstart', release);
        audio.addEventListener('emptied', release);
      } else release();
    }
  }
}

function invalidateImportedLyricMatches(replaced) {
  if (!replaced.size) return;
  let changed = false;
  for (const id of replaced) {
    changed = matchedLyrics.delete(id) || changed;
    automaticLyrics.delete(id);
  }
  if (replaced.has(automaticLyricJob?.id)) {
    const { controller } = automaticLyricJob;
    automaticLyricJob = undefined;
    controller.abort();
  }
  if (replaced.has(manualLyricJob?.form.dataset.id)) {
    const { form, controller } = manualLyricJob;
    manualLyricJob = undefined;
    manualLyricMatches.delete(form);
    controller.abort();
    if (dialog.contains(form)) dialog.close();
  }
  if (replaced.has(retainedLyricDisplay?.track.id)) retainedLyricDisplay = undefined;
  if (changed) save();
}
async function importM3uPlaylist(file) {
  if (!/\.m3u8?$/i.test(file.name)) return announce(t('请选择 M3U 或 M3U8 歌单。', 'Choose an M3U or M3U8 playlist.'));
  try {
    const { maxM3uBytes, M3uError, parseM3u, matchM3u } = await import('./m3u.js');
    if (file.size > maxM3uBytes) throw new M3uError('too-large');
    const { name, entries } = parseM3u(await file.arrayBuffer(), file.name);
    if (!entries.length) return announce(t('歌单没有曲目。', 'The playlist has no tracks.'));
    const { trackIds, skipped } = matchM3u(entries, allTracks(), location.origin);
    if (!trackIds.length) return announce(t('未匹配到曲库歌曲，已跳过 {count} 项。请先导入音频或扫描对应来源。',
      'Skipped {count} entries with no matching tracks. Import the audio or scan its source first.',
      { count: skipped }));
    const list = createLocalPlaylist(name || t('导入的歌单', 'Imported Playlist'), trackIds);
    save();
    go('playlist/' + list.id);
    announce(t('已导入 {count} 首歌曲{detail}。', 'Imported {tracks}.{detail}', {
      count: trackIds.length, tracks: trackCount(trackIds.length),
      detail: skipped ? t('，跳过 {count} 项', ' Skipped {count} {unit}.',
        { count: skipped, unit: skipped === 1 ? 'entry' : 'entries' }) : '',
    }));
  } catch (error) {
    const messages = {
      'too-large': t('歌单最多支持 1 MB 和 10,000 个条目。', 'Playlists are limited to 1 MB and 10,000 entries.'),
      encoding: t('无法读取歌单，请另存为 UTF-8 再导入。', 'Could not read the playlist. Save it as UTF-8 and try again.'),
      stream: t('此文件是 HLS 播放清单。请选择引用曲库歌曲的 M3U 歌单。', 'This file is an HLS manifest. Choose an M3U playlist that references library tracks.'),
    };
    announce(Object.hasOwn(messages, error?.code) ? messages[error.code] : t('无法导入歌单。', 'Could not import the playlist.'));
  }
}
function cacheBytes(bytes) {
  return (Math.max(0, Number(bytes) || 0) / 1024 / 1024).toLocaleString(getLanguage(), { maximumFractionDigits: 2 }) + ' MiB';
}
function lyricCacheBytes() {
  return new TextEncoder().encode(JSON.stringify(savedOnlineLyrics())).byteLength;
}
function setAudioCachePolicy(policy) {
  if (!policy) return;
  if (audioCachePolicy && policy.generation < audioCachePolicy.generation) return;
  if (audioCachePolicy?.generation !== policy.generation) automaticCachePass = undefined;
  audioCachePolicy = policy;
  if (policy.paused) {
    pendingPlaylistCache?.controller.abort();
    playlistPrecache?.controller.abort();
  }
}
function automaticPass(generation) {
  if (automaticCachePass?.generation === generation) return automaticCachePass;
  automaticCachePass = { generation, attempted: readPlaylistCachePass(generation) };
  return automaticCachePass;
}
function recordCacheAttempt(id, generation) {
  if (audioCachePolicy && generation < audioCachePolicy.generation) return;
  const pass = automaticPass(generation);
  pass.attempted.add(id);
  recordPlaylistCacheAttempt(generation, id);
}
function resetCacheAttempts(ids) {
  if (!audioCachePolicy) return;
  const pass = automaticPass(audioCachePolicy.generation);
  for (const id of ids) pass.attempted.delete(id);
  resetPlaylistCacheAttempts(pass.generation, ids);
}
async function showCacheManager() {
  openDialog(t('缓存管理', 'Cache Manager'), '<div data-cache-manager><p role="status">' + t('正在读取…', 'Loading…') + '</p></div>');
  const revision = dialogRevision;
  const results = await Promise.allSettled([readOfflineCachePolicy(), readImageCachePolicy()]);
  if (!dialog.open || dialogRevision !== revision) return;
  const [returnedSong, image] = results.map(result => result.status === 'fulfilled' ? result.value : undefined);
  setAudioCachePolicy(returnedSong);
  const song = returnedSong ? audioCachePolicy : undefined;
  const unavailable = t('当前无法读取缓存，请重试。', 'Cache storage is unavailable. Try again.');
  const rows = '<p data-total-cache-stats>' + (song && image ? t('全部缓存：{bytes}', 'Total cache: {bytes}',
    { bytes: cacheBytes(song.automaticBytes + song.automaticArtworkBytes + image.usedBytes + lyricCacheBytes()) }) : unavailable) + '</p>' +
    '<p data-audio-cache-stats>' + (song ? t('歌曲缓存：{bytes} · {count} 首', 'Song cache: {bytes} · {count} tracks',
    { bytes: cacheBytes(song.automaticBytes), count: song.automaticCount }) : unavailable) + '</p>' +
    '<p data-image-cache-stats>' + (image ? t('图片缓存：{bytes} · {count} 张', 'Image cache: {bytes} · {count} images',
      { bytes: cacheBytes(image.usedBytes), count: image.entryCount }) : unavailable) + '</p>' +
    '<p data-lyric-cache-stats>' + t('歌词缓存：{bytes}', 'Lyric cache: {bytes}', { bytes: cacheBytes(lyricCacheBytes()) }) + '</p>' +
    (song ? '<p>' + t('固定离线音频：{bytes} · {count} 首', 'Pinned offline audio: {bytes} · {count} tracks',
      { bytes: cacheBytes(song.pinnedBytes), count: song.pinnedCount }) + '</p>' : '');
  const limits = '<form data-form="cache-budgets"><label class="dialog-field">' + t('歌曲缓存上限（MiB，至少 200）', 'Song cache limit (MiB, minimum 200)') +
    '<input id="audio-cache-limit" name="audio" type="number" min="0" max="65536" step="1" required value="' + (song?.limitMiB ?? 1024) + '"' + (!song ? ' disabled' : '') + '></label>' +
    '<label class="dialog-field">' + t('图片缓存上限（MiB，至少 50）', 'Image cache limit (MiB, minimum 50)') +
    '<input id="image-cache-limit" name="image" type="number" min="0" max="2048" step="1" required value="' + (image?.limitMiB ?? 250) + '"' + (!image ? ' disabled' : '') + '></label>' +
    '<button class="btn primary" type="submit">' + t('保存缓存上限', 'Save Cache Limits') + '</button><p role="status"></p></form>';
  $('[data-cache-manager]', dialog).innerHTML = rows + limits + '<p>' +
    t('达到歌曲上限时淘汰最久未访问的自动缓存。清理后暂停自动写入，可按需恢复。',
      'At the song limit, discard the least recently accessed automatic copies. Clearing pauses new cache writes until you resume.') + '</p><div class="actions">' +
    btn(t('清理歌曲缓存', 'Clear Song Cache'), 'trash-2', 'clear-audio-cache', !song ? 'disabled' : '') +
    btn(t('清理图片缓存', 'Clear Image Cache'), 'trash-2', 'clear-image-cache', !image ? 'disabled' : '') +
    btn(t('清理歌词缓存', 'Clear Lyrics Cache'), 'trash-2', 'clear-lyrics-cache') +
    btn(t('清理全部缓存', 'Clear All Caches'), 'trash-2', 'clear-all-caches') +
    (song?.paused || image?.paused ? btn(t('恢复自动缓存', 'Resume Caching'), 'play', 'resume-managed-caches') : '') +
    btn(t('刷新', 'Refresh'), 'refresh-cw', 'cache-manager') + '</div>';
}
async function saveCacheBudgets(form) {
  const status = $('[role=status]', form);
  const audioLimit = form.elements.audio;
  const imageLimit = form.elements.image;
  if ([audioLimit, imageLimit].some(input => !input.disabled && (!Number.isSafeInteger(input.valueAsNumber) || input.valueAsNumber < 0))) {
    status.textContent = t('请输入非负整数。', 'Enter a nonnegative whole number.');
    return;
  }
  const submit = $('button[type=submit]', form);
  submit.disabled = true;
  const operations = [];
  if (!audioLimit.disabled) operations.push(configureOfflineCache({ limitMiB: Math.max(200, audioLimit.valueAsNumber) }).then(setAudioCachePolicy));
  if (!imageLimit.disabled) operations.push(configureImageCache({ limitMiB: Math.max(50, imageLimit.valueAsNumber) }));
  const results = await Promise.allSettled(operations);
  if (!dialog.open || !dialog.contains(form)) return;
  submit.disabled = false;
  if (results.some(result => result.status === 'rejected')) {
    status.textContent = t('部分缓存设置未能保存，请刷新后重试。', 'Some cache settings could not be saved. Refresh and try again.');
  } else {
    await showCacheManager();
    announce(t('已保存缓存上限。', 'Cache limits saved.'));
  }
}
function confirmCacheClear(kind) {
  confirmAction(t('清理缓存', 'Clear Cache'),
    t('清理所选缓存并暂停自动写入。固定离线副本、下载到设备的文件与导入的本地音乐会保留。',
      'Clear the selected caches and pause new cache writes. Pinned offline copies, files downloaded to your device and imported local music are kept.'),
    'confirm-managed-cache-clear', kind);
}
async function clearManagedCache(kind) {
  const revision = dialogRevision;
  const confirm = $('[data-action=confirm-managed-cache-clear]', dialog);
  if (confirm?.disabled) return;
  if (confirm) confirm.disabled = true;
  const operations = [];
  if (kind === 'audio' || kind === 'all') {
    pendingPlaylistCache?.controller.abort();
    playlistPrecache?.controller.abort();
    operations.push(clearAutomaticAudioCache().then(setAudioCachePolicy));
  }
  if (kind === 'image' || kind === 'all') operations.push(clearImageCache());
  if (kind === 'all') operations.push(Promise.resolve(clearLyricsCache({ keepDialog: true })));
  const results = await Promise.allSettled(operations);
  refreshCurrent();
  if (dialog.open && dialogRevision === revision) await showCacheManager();
  announce(results.some(result => result.status === 'rejected' || result.value === false)
    ? t('部分缓存未能清理，请刷新后重试。', 'Some caches could not be cleared. Refresh and try again.')
    : t('已清理所选缓存。', 'Selected caches cleared.'));
}
async function resumeManagedCaches() {
  const revision = dialogRevision;
  const results = await Promise.allSettled([resumeAutomaticAudioCache().then(setAudioCachePolicy), resumeImageCache()]);
  schedulePlaylistCache(0);
  if (dialog.open && dialogRevision === revision) await showCacheManager();
  if (results.some(result => result.status === 'rejected')) announce(t('部分缓存无法恢复，请重试。', 'Some caches could not resume. Try again.'));
}
async function offlineAction(id, remove) {
  if (remove && playlistPrecache?.ids.has(id)) playlistPrecache.controller.abort();
  const track = find(id);
  if (!track || offlineOperations.has(id) || removingTracks.has(id)) return;
  const finish = beginOfflineOperation(id);
  try {
    if (remove) {
      await removeOffline(id);
      if (playlistWantsTrack(id) && !state.cacheExclusions.includes(id)) state.cacheExclusions.push(id);
      save();
      announce(t('已删除离线副本。', 'Offline copy deleted.'));
    }
    else {
      remember(track);
      announce(t('正在保存音频…', 'Saving audio…'));
      await cacheAudio(track, { coverSource: customAlbumArtwork(track), coverIdentity: customAlbumArtworkIdentity(track) });
      state.cacheExclusions = state.cacheExclusions.filter(entry => entry !== id);
      save();
      announce(t('音频已保存到离线歌曲。', 'Audio saved to Downloaded Music.'));
    }
    refreshCurrent();
    return true;
  } catch (error) {
    announce(displayError(error, remove ? t('无法删除下载。', 'Could not delete the download.') : t('无法保存离线歌曲。', 'Could not save the offline track.')));
    return false;
  }
  finally { finish(); schedulePlaylistCache(); }
}
function beginOfflineOperation(id) {
  let resolve;
  offlineOperations.set(id, new Promise(done => { resolve = done; }));
  return () => { offlineOperations.delete(id); resolve(); };
}
async function removeDownloadedTrack(id) {
  const track = find(id);
  if (!track) return;
  if (track.provider === 'local') {
    if (!await forgetTrack(id, true)) return false;
    save();
    refreshCurrent();
    return true;
  }
  if (playlistDownload?.trackIds.has(id)) playlistDownload.controller.abort();
  if (playlistPrecache?.ids.has(id)) playlistPrecache.controller.abort();
  clearPreparedDownload(id);
  while (offlineOperations.has(id)) await offlineOperations.get(id);
  return offlineAction(id, true);
}
function playlistWantsTrack(id) {
  return state.playlists.some(list => state.cachedPlaylistIds.includes(list.id) && list.tracks.includes(id));
}
function knownPlaylistTracks(playlist) {
  const tracks = new Map(allTracks().map(track => [track.id, track]));
  return [...new Set(playlist.tracks)].map(id => ({ id, track: tracks.get(id) }));
}
function audioOnDevice(track) {
  return hasOffline(track.id) || Boolean(track.provider === 'local' && track.src?.startsWith('blob:'));
}
function canDownloadTrack(track) {
  return track && (audioOnDevice(track) || validCloudTrack(track) ||
    (track.provider === 'demo' && /^\/assets\/demo-\d+\.m4a$/.test(track.src)));
}
function evictedPlaylistTracks(playlist) {
  if (!audioCachePolicy) return [];
  const attempted = automaticPass(audioCachePolicy.generation).attempted;
  return knownPlaylistTracks(playlist).filter(({ id, track }) => attempted.has(id) && canDownloadTrack(track) &&
    !audioOnDevice(track) && !state.cacheExclusions.includes(id));
}
function playlistDownloadActions(playlist) {
  const enabled = state.cachedPlaylistIds.includes(playlist.id);
  const exportAction = playlistDownload?.id === playlist.id
    ? btn(t('取消下载歌单', 'Cancel playlist download'), 'x', 'cancel-playlist-download')
    : (playlist.tracks.length ? btn(t('下载歌单', 'Download playlist'), 'download', 'download-playlist', key(playlist.id) + (playlistDownload ? ' disabled' : '')) : '');
  const prepared = preparedPlaylistDownload?.id === playlist.id ? preparedPlaylistDownload : null;
  return (playlistPrecache?.playlistId === playlist.id
    ? btn(t('取消预缓存', 'Cancel Pre-cache'), 'x', 'cancel-playlist-precache')
    : btn(t('缓存全部歌曲', 'Pre-cache all songs'), 'hard-drive-download', 'precache-playlist', key(playlist.id) +
      (playlistPrecache || !playlist.tracks.length ? ' disabled' : ''))) +
    btn(enabled ? t('停止自动缓存', 'Stop auto-caching') : t('提前缓存歌单', 'Pre-cache playlist'), enabled ? 'pause' : 'hard-drive-download', 'toggle-playlist-cache', key(playlist.id)) +
    exportAction + (prepared ? '<a class="btn primary" href="' + esc(prepared.url) + '" download="' + esc(prepared.name) + '">' + t('保存 ZIP 到本地', 'Save ZIP') + '</a>' : '') +
    (enabled ? '<button type="button" class="btn" data-action="retry-playlist-cache" ' + key(playlist.id) +
      (playlist.tracks.some(id => playlistCacheFailures.has(id)) || evictedPlaylistTracks(playlist).length ? '' : ' hidden') + '>' + t('重试未缓存曲目', 'Retry uncached tracks') + '</button>' : '') +
    btn(t('已下载音乐', 'Downloaded Music'), 'folder-open', 'downloaded-music');
}
function playlistCacheLabel(playlist) {
  const items = knownPlaylistTracks(playlist);
  const saved = items.filter(({ track }) => track && audioOnDevice(track)).length;
  const missing = items.find(({ id }) => playlistCacheFailures.has(id));
  const excluded = items.filter(({ id }) => state.cacheExclusions.includes(id)).length;
  const unavailable = items.filter(({ track }) => !canDownloadTrack(track)).length;
  const saving = pendingPlaylistCache && items.some(({ id }) => id === pendingPlaylistCache.id);
  const details = [t('已缓存 {saved} / {total} 首', 'Cached tracks: {saved} / {total}', { saved, total: items.length })];
  if (saving) details.push(t('正在缓存', 'Caching'));
  if (playlistPrecache?.playlistId === playlist.id) details.push(t('本次预缓存：{done} / {total}', 'This pre-cache: {done} / {total}',
    { done: playlistPrecache.done, total: playlistPrecache.total }));
  if (audioCachePolicy?.paused) details.push(t('自动缓存已暂停', 'Caching is paused'));
  if (evictedPlaylistTracks(playlist).length) details.push(t('部分自动缓存已淘汰，可手动重试或固定保存', 'Some automatic copies were discarded. Retry or pin them to keep them.'));
  if (state.cachedPlaylistIds.includes(playlist.id)) details.push(t('自动缓存会包含之后添加的歌曲', 'Auto-caching includes songs added later'));
  if (unavailable) details.push(t('{count} 首暂时找不到来源', 'Tracks without a source: {count}', { count: unavailable }));
  if (excluded) details.push(t('{count} 首已手动删除副本', 'Manually removed copies: {count}', { count: excluded }));
  if (missing) details.push(playlistCacheFailureText(playlistCacheFailures.get(missing.id).error));
  return details.join(' · ');
}
function playlistCacheFailureText(error) {
  if (error?.code === 'offline-cache-limit') return t('音频超出自动缓存预算，可增加上限或固定离线保存', 'Audio exceeds the cache budget. Increase the limit or save a pinned offline copy.');
  if (['offline-cache-paused', 'offline-cache-stale'].includes(error?.code)) return t('自动缓存已暂停', 'Caching is paused');
  if (error instanceof UncacheableAudioError) {
    return displayError(error, t('此音频无法缓存。', 'This audio cannot be cached or exceeds the size limit.'));
  }
  return error?.name === 'QuotaExceededError' ? t('浏览器存储空间不足', 'Browser storage is full') :
    t('部分歌曲暂未缓存，将自动重试', 'Some tracks could not be cached. The player will retry.');
}
function playlistZipProgress(processed, total) {
  return t('正在准备 ZIP · {processed} / {total} 首', 'Preparing ZIP · {processed} / {total} tracks', { processed, total });
}
function playlistDownloadStatus(playlist) {
  const job = playlistDownload?.id === playlist.id ? playlistDownload : null;
  const prepared = preparedPlaylistDownload?.id === playlist.id ? preparedPlaylistDownload : null;
  return '<div class="playlist-download-status"><p class="hint" data-playlist-cache-status role="status">' + esc(playlistCacheLabel(playlist)) +
    '</p><p class="hint" data-playlist-export-status role="status">' +
    esc(job ? playlistZipProgress(job.processed, job.total) :
      prepared ? t('已打包 {count} 首原始音频。', 'Original audio files in ZIP: {count}.', { count: prepared.total }) +
        (prepared.unsaved ? t(' 有 {count} 首未能写入浏览器存储，仍可保存 ZIP。',
          ' Tracks not saved in the browser: {count}. You can still save the ZIP.',
          { count: prepared.unsaved }) : '') : '') +
    '</p></div>';
}
function updatePlaylistCacheStatus() {
  const label = $('[data-playlist-cache-status]', content);
  const playlist = label && state.playlists.find(list => route === 'playlist/' + list.id);
  if (playlist) {
    label.textContent = playlistCacheLabel(playlist);
    const retry = $('[data-action=retry-playlist-cache]', content);
    if (retry) retry.hidden = !playlist.tracks.some(id => playlistCacheFailures.has(id)) && !evictedPlaylistTracks(playlist).length;
  }
}
async function retryPlaylistCache(id) {
  const list = state.playlists.find(item => item.id === id);
  if (!list) return;
  for (const trackId of list.tracks) playlistCacheFailures.delete(trackId);
  if (audioCachePolicy?.paused) {
    try { setAudioCachePolicy(await resumeAutomaticAudioCache()); }
    catch { return announce(t('无法恢复缓存。', 'Could not resume caching.')); }
  }
  resetCacheAttempts(list.tracks);
  updatePlaylistCacheStatus();
  schedulePlaylistCache(0);
}
async function togglePlaylistCache(id) {
  const list = state.playlists.find(item => item.id === id);
  if (!list) return;
  if (state.cachedPlaylistIds.includes(id)) {
    state.cachedPlaylistIds = state.cachedPlaylistIds.filter(value => value !== id);
  } else {
    if (audioCachePolicy?.paused) {
      try { setAudioCachePolicy(await resumeAutomaticAudioCache()); }
      catch { return announce(t('无法恢复缓存。', 'Could not resume caching.')); }
    }
    state.cachedPlaylistIds.push(id);
    state.cacheExclusions = state.cacheExclusions.filter(value => !list.tracks.includes(value));
    for (const value of list.tracks) playlistCacheFailures.delete(value);
    resetCacheAttempts(list.tracks);
    void navigator.storage?.persist?.().catch(() => {});
  }
  save();
  render();
}
function schedulePlaylistCache(delay = 80) {
  if (pendingPlaylistCache && !playlistWantsTrack(pendingPlaylistCache.id)) pendingPlaylistCache.controller.abort();
  if (!ready || !state.cachedPlaylistIds.length || pendingPlaylistCache || playlistDownload || playlistPrecache || audioCachePolicy?.paused) return;
  if (playlistCacheTimer !== undefined) return;
  playlistCacheTimer = setTimeout(() => {
    playlistCacheTimer = undefined;
    void cacheNextPlaylistTrack();
  }, delay);
}
async function cacheNextPlaylistTrack() {
  if (pendingPlaylistCache || playlistDownload || playlistPrecache || !navigator.onLine) return;
  let policy;
  try { policy = await readOfflineCachePolicy(); setAudioCachePolicy(policy); } catch { return; }
  if (policy.paused || pendingPlaylistCache || playlistDownload || playlistPrecache) return;
  const wanted = new Set(state.playlists.filter(list => state.cachedPlaylistIds.includes(list.id)).flatMap(list => list.tracks));
  const pass = automaticPass(policy.generation);
  for (const id of wanted) if (hasOffline(id) && !pass.attempted.has(id)) recordCacheAttempt(id, policy.generation);
  const track = allTracks().find(item => wanted.has(item.id) && canDownloadTrack(item) && !audioOnDevice(item) &&
    !pass.attempted.has(item.id) &&
    !offlineOperations.has(item.id) && !removingTracks.has(item.id) && !state.cacheExclusions.includes(item.id) &&
    !(playlistCacheFailures.get(item.id)?.retryAt > Date.now()));
  if (!track) return;
  const controller = new AbortController();
  pendingPlaylistCache = { id: track.id, controller };
  const finish = beginOfflineOperation(track.id);
  updatePlaylistCacheStatus();
  try {
    await cacheAudio(track, { mode: 'automatic', generation: policy.generation,
      coverSource: customAlbumArtwork(track), coverIdentity: customAlbumArtworkIdentity(track), maxBytes: playlistAudioLimit, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(240000)]) });
    recordCacheAttempt(track.id, policy.generation);
    playlistCacheFailures.delete(track.id);
    if (route === 'offline') render();
  } catch (error) {
    if (!controller.signal.aborted) playlistCacheFailures.set(track.id, {
      retryAt: error instanceof UncacheableAudioError || error.name === 'QuotaExceededError' || error.code === 'offline-cache-limit' ? Infinity : Date.now() + 60000,
      error,
    });
  } finally {
    pendingPlaylistCache = undefined;
    finish();
    updatePlaylistCacheStatus();
    schedulePlaylistCache();
  }
}
async function precachePlaylist(id) {
  const list = state.playlists.find(item => item.id === id);
  if (!list || playlistPrecache || playlistDownload || !ready) return;
  const snapshot = knownPlaylistTracks(list);
  const items = snapshot.filter(({ track }) => canDownloadTrack(track));
  if (!items.length) return announce(t('歌单里还没有可缓存的歌曲。', 'This playlist has no cacheable tracks.'));
  let policy;
  try {
    policy = await readOfflineCachePolicy();
    if (policy.paused) policy = await resumeAutomaticAudioCache();
    setAudioCachePolicy(policy);
  } catch { return announce(t('无法打开缓存存储。', 'Could not open cache storage.')); }
  if (playlistPrecache || playlistDownload) return;
  const unavailable = snapshot.length - items.length;
  const job = { playlistId: id, controller: new AbortController(), ids: new Set(items.map(item => item.id)),
    done: unavailable, total: snapshot.length, failures: unavailable };
  playlistPrecache = job;
  pendingPlaylistCache?.controller.abort();
  render();
  try {
    for (const { track } of items) {
      const signal = job.controller.signal;
      signal.throwIfAborted();
      while (offlineOperations.has(track.id)) await offlineOperations.get(track.id);
      signal.throwIfAborted();
      if (removingTracks.has(track.id)) continue;
      const finish = beginOfflineOperation(track.id);
      try {
        if (track.provider !== 'local') await cacheAudio(track, { mode: 'automatic', generation: policy.generation,
          maxBytes: playlistAudioLimit, signal: AbortSignal.any([signal, AbortSignal.timeout(240000)]),
          coverSource: customAlbumArtwork(track), coverIdentity: customAlbumArtworkIdentity(track) });
        recordCacheAttempt(track.id, policy.generation);
        playlistCacheFailures.delete(track.id);
      } catch (error) {
        signal.throwIfAborted();
        if (['offline-cache-paused', 'offline-cache-stale'].includes(error.code)) throw error;
        job.failures++;
        playlistCacheFailures.set(track.id, { retryAt: Infinity, error });
      } finally { finish(); }
      job.done++;
      updatePlaylistCacheStatus();
    }
    announce(job.failures ? t('预缓存完成，{count} 首未能缓存。', 'Pre-cache finished; {count} tracks could not be cached.', { count: job.failures }) :
      t('本次歌单预缓存完成。', 'This playlist pre-cache is complete.'));
  } catch {
    announce(t('已停止本次预缓存。', 'This pre-cache has stopped.'));
  } finally {
    playlistPrecache = undefined;
    render();
    schedulePlaylistCache();
  }
}
function downloadAudioName(track, type) {
  const basename = [track.fileName, track.path, track.playlistLocation].filter(name => typeof name === 'string')
    .map(name => name.split(/[\\/]/).at(-1)).find(isAudioName);
  if (isAudioName(basename)) return basename;
  const extensions = { 'audio/aac': 'aac', 'audio/aiff': 'aiff', 'audio/flac': 'flac', 'audio/m4a': 'm4a', 'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/x-flac': 'flac',
    'audio/x-wav': 'wav', 'audio/x-ms-wma': 'wma', 'application/ogg': 'ogg', 'video/mp4': 'mp4', 'video/webm': 'webm' };
  const title = [track.artist, track.title].filter(Boolean).join(' - ') || t('音频', 'Audio');
  const ext = /^\/assets\/demo-\d+\.m4a$/.test(track.src) ? 'm4a' : extensions[type] || 'audio';
  return title + '.' + ext;
}
function canSaveOriginalAudio(track) {
  return track && track.provider !== 'demo' && (hasOffline(track.id) || originalDownloadSource(track));
}
function originalDownloadSource(track) {
  if (validCloudTrack(track) || (track.provider === 'local' && track.src?.startsWith('blob:' + location.origin + '/'))) return track.src;
}
async function saveOriginalAudio(track) {
  if (!canSaveOriginalAudio(track)) return;
  try {
    const cached = hasOffline(track.id) ? await readOfflineBlob(track.id) : undefined;
    if (cached) { try { await pinOfflineTrack(track.id); } catch { /* The original bytes can still be saved to the device. */ } }
    const portable = cached && URL.createObjectURL(cached);
    if (portable) setTimeout(() => URL.revokeObjectURL(portable), 30000);
    const source = portable || originalDownloadSource(track);
    if (!source) throw new Error('Original audio unavailable');
    let type = cached?.type;
    if (!portable && validCloudTrack(track)) {
      const response = await fetch(source, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (!response.ok || (type && !type.startsWith('audio/') &&
          !['application/octet-stream', 'binary/octet-stream', 'application/ogg', 'video/mp4', 'video/webm'].includes(type))) {
        throw new Error('Original audio unavailable');
      }
    }
    const link = document.createElement('a');
    link.href = source;
    link.download = safeDownloadName(downloadAudioName(track, type));
    link.click();
  } catch {
    announce(t('无法保存原始音频。请检查源文件是否可访问。', 'Could not save the original audio. Check that the source file is accessible.'));
  }
}
async function downloadPlaylist(id) {
  const list = state.playlists.find(item => item.id === id);
  if (!list || playlistDownload || playlistPrecache) return;
  const items = knownPlaylistTracks(list);
  if (!items.length) return announce(t('歌单里还没有歌曲。', 'This playlist is empty.'));
  if (items.some(({ track }) => !canDownloadTrack(track))) return announce(t('歌单中有曲目缺少音源。请连接对应网盘或重新导入本地文件。', 'Some tracks have no audio source. Reconnect the cloud drive or reimport the local files.'));
  const { name } = list;
  const job = { id, controller: new AbortController(), trackIds: new Set(items.map(item => item.id)),
    processed: 0, total: items.length, unsaved: 0 };
  playlistDownload = job;
  const signal = job.controller.signal;
  pendingPlaylistCache?.controller.abort();
  render();
  try {
    const { buildPlaylistArchive } = await import('./playlist-download.js');
    const archive = await buildPlaylistArchive((async function* () {
      for (const { track } of items) {
        signal.throwIfAborted();
        while (offlineOperations.has(track.id)) await offlineOperations.get(track.id);
        signal.throwIfAborted();
        if (removingTracks.has(track.id)) throw new InterfaceError('曲目正在删除，请稍后重试。', 'The track is being removed. Try again shortly.');
        const finish = beginOfflineOperation(track.id);
        try {
          const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(240000)]);
          const local = track.provider === 'local';
          const cached = await readOfflineBlob(track.id);
          if (cached && !local) {
            try { if (!await pinOfflineTrack(track.id)) job.unsaved++; }
            catch { job.unsaved++; }
          }
          const blob = cached || await fetchAudioBlob(track.src, {
            signal: downloadSignal, allowUnknownType: local, maxBytes: playlistAudioLimit,
          });
          if (blob.size > playlistAudioLimit) throw new InterfaceError('单首音频最多可读取 256 MB。', 'Each track must be 256 MB or smaller.');
          signal.throwIfAborted();
          if (!cached && !local) {
            try {
              await saveOfflineTrack(track, blob, { signal: downloadSignal, coverSource: customAlbumArtwork(track), coverIdentity: customAlbumArtworkIdentity(track) });
              state.cacheExclusions = state.cacheExclusions.filter(value => value !== track.id);
              playlistCacheFailures.delete(track.id);
            } catch { job.unsaved++; }
          }
          signal.throwIfAborted();
          yield { name: downloadAudioName(track, blob.type), blob };
        } catch (error) {
          const detail = displayError(error, t('无法读取音频。', 'Could not read the audio.'));
          throw new Error(t('无法下载「{title}」。{detail}', 'Could not download “{title}”. {detail}', { title: track.title, detail }), { cause: error });
        }
        finally { finish(); }
      }
    })(), { signal, onProgress({ processed }) {
      job.processed = processed;
      const status = $('[data-playlist-export-status]', content);
      if (status && route === 'playlist/' + id) status.textContent = playlistZipProgress(processed, job.total);
      updatePlaylistCacheStatus();
    } });
    signal.throwIfAborted();
    if (preparedPlaylistDownload) URL.revokeObjectURL(preparedPlaylistDownload.url);
    const filename = name.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/g, '') || t('Groovebox 歌单', 'Groovebox Playlist');
    preparedPlaylistDownload = { id, name: filename + '.zip', url: URL.createObjectURL(archive), total: job.total,
      unsaved: job.unsaved, trackIds: job.trackIds };
    announce(t('歌单打包完成，可保存 ZIP 到本地。', 'The playlist ZIP is ready to save.'));
  } catch (error) {
    const failure = error.cause ? error.message : displayError(error, t('无法下载歌单。', 'Could not download the playlist.'));
    announce(signal.aborted ? t('已取消歌单下载。', 'Playlist download canceled.') : failure);
  }
  finally {
    playlistDownload = undefined;
    save();
    render();
  }
}
function clearPreparedDownload(trackId) {
  if (!preparedPlaylistDownload?.trackIds.has(trackId)) return;
  URL.revokeObjectURL(preparedPlaylistDownload.url);
  preparedPlaylistDownload = undefined;
}
async function forgetTrack(id, removeAudio = false) {
  const track = find(id);
  if (!track || track.provider === 'demo' || removingTracks.has(id)) return false;
  removingTracks.add(id);
  try {
    await removeTrackFromLibrary(track, removeAudio);
    return true;
  }
  finally { removingTracks.delete(id); schedulePlaylistCache(); }
}
async function removeTrackFromLibrary(track, removeAudio) {
  const { id } = track;
  bulkTagJob?.ignored.add(id);
  if (pendingPlaylistCache?.id === id) pendingPlaylistCache.controller.abort();
  if (playlistPrecache?.ids.has(id)) playlistPrecache.controller.abort();
  if (playlistDownload?.trackIds.has(id)) playlistDownload.controller.abort();
  clearPreparedDownload(id);
  await offlineOperations.get(id);
  converting.get(id)?.request.abort();
  converting.delete(id);
  tagReads.get(id)?.abort();
  tagReads.delete(id);
  viewedTags.delete(id);
  const compatible = compatibleMedia.get(id);
  if (compatible) URL.revokeObjectURL(compatible.url);
  compatibleMedia.delete(id);
  if (removeAudio && hasOffline(id)) await removeOffline(id);
  state.cacheExclusions = state.cacheExclusions.filter(entry => entry !== id);
  playlistCacheFailures.delete(id);
  if (removeAudio && track.provider === 'local') {
    await removeLocal(id);
    locals = locals.filter(item => item.id !== id);
  }
  if (removeAudio && track.provider === 'local') state.removedLibraryTracks.delete(id);
  else state.removedLibraryTracks.add(id);
  if (!hasOffline(id) && !cloudCatalogs.has(catalogSourceId(track))) state.tracks = state.tracks.filter(item => item.id !== id);
  state.favorites = state.favorites.filter(item => item !== id);
  state.history = state.history.filter(item => item.id !== id);
  state.directRecent = state.directRecent.filter(item => item.id !== id);
  for (const list of state.playlists) filterLocalPlaylistTracks(list, item => item !== id);
  const { queue } = player.getState();
  for (let index = queue.length - 1; index >= 0; index--) {
    if (queue[index].id === id) player.remove(index);
  }
  trackProgress.delete(id);
}
const cloudBackupOAuth = new Map([
  ['gdrive', 'https://accounts.google.com/o/oauth2/v2/auth'],
  ['dropbox', 'https://www.dropbox.com/oauth2/authorize'],
  ['onedrive', 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'],
]);
const cloudBackupProviders = new Set(['baidu', ...cloudBackupOAuth.keys()]);
const cloudBackupId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cloudBackupAccount = /^[A-Za-z0-9_-]{43}$/;
let cloudBackupView;
const pendingCloudBackups = new Map();
const cloudBackupWrites = new Set();

const pendingCloudBackupKey = ({ provider, account }) => 'groovebox.' + provider + '-backup.pending.' + account;
function readPendingCloudBackup(scope) {
  const key = pendingCloudBackupKey(scope);
  if (pendingCloudBackups.has(key)) return pendingCloudBackups.get(key);
  try {
    const text = sessionStorage.getItem(key);
    if (!text) return;
    const bytes = new TextEncoder().encode(text);
    const { operation } = readPlaylistSnapshot(bytes, scope);
    return { id: operation, bytes, scope };
  } catch { /* A blocked or invalid browser store cannot supply a retry. */ }
}
function rememberPendingCloudBackup(upload, pending) {
  const key = pendingCloudBackupKey(upload.scope);
  if (pending) pendingCloudBackups.set(key, upload);
  else pendingCloudBackups.delete(key);
  try {
    if (pending) sessionStorage.setItem(key, new TextDecoder().decode(upload.bytes));
    else sessionStorage.removeItem(key);
  } catch { /* The in-memory retry remains available if browser storage is blocked. */ }
}

function cloudPlaylistBackupButton(id) {
  return cloudBackupAvailable(id) ? btn(t('歌单备份', 'Playlist Backup'), 'cloud-upload', id + '-playlist-backup') : '';
}
function cloudBackupAvailable(provider) {
  if (!cloudBackupProviders.has(provider)) return false;
  const status = cloudStatus[provider];
  return status.connected && (status.canBackup || (cloudBackupOAuth.has(provider) &&
    (status.backupAuthorizationAvailable || status.backupReconnectRequired)));
}
function currentCloudBackup(view) {
  return view && view === cloudBackupView && dialog.open && view.panel.isConnected && cloudStatus[view.provider].connected;
}
const cloudBackupAction = (view, verb) => view.provider + '-backup-' + verb;
function cloudBackupStatus(view, message) {
  if (currentCloudBackup(view)) $('[data-cloud-backup-status]', view.panel).textContent = message;
}
function renderCloudBackup(view, body, focus) {
  if (!currentCloudBackup(view)) return;
  $('[data-cloud-backup-actions]', view.panel).innerHTML = body;
  if (focus) $('[data-action="' + cloudBackupAction(view, focus) + '"]', view.panel)?.focus();
}
function cloudBackupError(view, error, fallback) {
  const name = providerLabel(view.provider);
  if (error.status === 401) return t('{name}授权已失效，请重新连接。', 'Reconnect {name} to continue.', { name });
  if (error.status === 403) return t('当前{name}账号无法访问此备份。', 'The current {name} account cannot access this backup.', { name });
  if (error.status === 404) return t('找不到此歌单备份。', 'This playlist backup could not be found.');
  return displayError(error, fallback);
}
function cloudBackupRequest() {
  return { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(45_000) };
}
async function loadCloudBackupList(view, message = '') {
  renderCloudBackup(view, '');
  cloudBackupStatus(view, t('正在读取歌单备份…', 'Loading playlist backups…'));
  try {
    const { account, snapshots } = await api(sourceEndpoint(view.provider, 'backup'), cloudBackupRequest());
    if (typeof account !== 'string' || !cloudBackupAccount.test(account) || !Array.isArray(snapshots)) {
      throw new TypeError('Invalid backup listing');
    }
    view.scope = { provider: view.provider, account };
    const entries = [...new Map(snapshots.filter(item => item && typeof item.id === 'string' && cloudBackupId.test(item.id))
      .map(item => [item.id, item])).values()].sort((left, right) => (Number(right.modifiedAt) || 0) - (Number(left.modifiedAt) || 0));
    const retry = Boolean(readPendingCloudBackup(view.scope));
    const writing = cloudBackupWrites.has(view.provider);
    renderCloudBackup(view, '<p class="dialog-message">' +
      t('备份歌单、收藏和曲目信息。已确认归属的{name}曲目可在另一台设备恢复播放。重新扫描旧曲目所在的目录，可更新曲目归属。',
        'Back up playlists, favorites, and track information. {name} tracks verified for this account can be restored on another device. Rescan the folders containing older tracks to verify them.',
        { name: providerLabel(view.provider) }) +
      '</p><div class="actions">' + btn(retry ? t('重试上传', 'Retry Upload') : t('上传备份', 'Upload Backup'),
      'cloud-upload', cloudBackupAction(view, 'upload'), writing ? 'disabled' : '', true) +
      (retry && !writing ? btn(t('放弃本机重试', 'Discard Local Retry'), null, cloudBackupAction(view, 'discard-retry')) : '') + '</div>' +
      (entries.length ? '<ul class="playlist-order-list">' + entries.map(item => {
        const date = new Date(Number(item.modifiedAt));
        const name = Number(item.modifiedAt) > 0 && Number.isFinite(date.getTime()) ? date.toLocaleString() : item.id;
        return '<li><span>' + esc(name) + '</span>' +
          btn(t('预览恢复', 'Preview Restore'), 'cloud-download', cloudBackupAction(view, 'preview'), key(item.id)) + '</li>';
      }).join('') + '</ul>' : '<p class="dialog-message">' + t('暂无歌单备份。', 'No playlist backups yet.') + '</p>'),
    'upload');
    cloudBackupStatus(view, message);
  } catch (error) {
    if (await recoverCloudBackupScope(view, error)) return;
    renderCloudBackup(view, '<div class="actions">' + btn(t('重试', 'Retry'), 'refresh-cw', cloudBackupAction(view, 'list')) + '</div>',
      'list');
    cloudBackupStatus(view, cloudBackupError(view, error, t('无法读取歌单备份。', 'Could not read playlist backups.')));
  }
}
function openCloudPlaylistBackup(provider, message = '') {
  if (!cloudBackupAvailable(provider)) return;
  openDialog(t('{name}歌单备份', '{name} Playlist Backup', { name: providerLabel(provider) }),
    '<div data-cloud-backup data-' + provider + '-backup><div data-cloud-backup-actions data-' + provider + '-backup-actions></div>' +
    '<p class="dialog-message" data-cloud-backup-status data-' + provider + '-backup-status role="status"></p></div>');
  const view = { provider, panel: $('[data-cloud-backup]', dialog) };
  cloudBackupView = view;
  if (cloudStatus[provider].canBackup) void loadCloudBackupList(view, message);
  else showCloudBackupAuthorization(view, message);
}
function showCloudBackupAuthorization(view, message) {
  view.scope = undefined;
  view.upload = undefined;
  view.preview = undefined;
  const name = providerLabel(view.provider);
  const reconnect = cloudStatus[view.provider].backupReconnectRequired;
  renderCloudBackup(view, '<p class="dialog-message">' +
    esc(reconnect ? t('请先重新连接{name}以确认当前账号，再打开歌单备份单独授权。',
      'Reconnect {name} to verify the current account, then open Playlist Backup to grant separate access.', { name }) :
      t('授权 {name} 后，即可保存和恢复此播放器创建的歌单备份。',
        'Authorize {name} to save and restore playlist backups created by this player.', { name })) +
    '</p><div class="actions">' + btn(reconnect ? t('重新连接 {name}', 'Reconnect {name}', { name }) :
      t('授权 {name} 备份', 'Authorize {name} Backup', { name }), 'cloud',
    cloudBackupAction(view, reconnect ? 'reconnect' : 'authorize'), '', true) + '</div>', reconnect ? 'reconnect' : 'authorize');
  cloudBackupStatus(view, message);
}
async function recoverCloudBackupScope(view, error) {
  const provider = view.provider;
  if (!cloudBackupOAuth.has(provider) || !['backup_scope_required', 'backup_reconnect_required'].includes(error.code) ||
      !currentCloudBackup(view)) return false;
  const status = await api(sourceEndpoint(provider, 'status'), cloudBackupRequest()).catch(() => undefined);
  if (!currentCloudBackup(view)) return false;
  if (status?.connected && !status.canBackup && (status.backupAuthorizationAvailable || status.backupReconnectRequired)) {
    cloudStatus[provider] = status;
  } else if (status || !cloudBackupAvailable(provider)) return false;
  else if (error.code === 'backup_reconnect_required') {
    cloudStatus[provider] = { ...cloudStatus[provider], canBackup: false, backupReconnectRequired: true };
  }
  showCloudBackupAuthorization(view,
    t('{name} 歌单备份需要重新授权。原有播放授权仍可用。',
      'Authorize {name} playlist backup again. Your existing playback access is still available.', { name: providerLabel(provider) }));
  return true;
}
function reconnectCloudBackup() {
  const view = cloudBackupView;
  if (currentCloudBackup(view) && cloudBackupOAuth.has(view.provider) && cloudStatus[view.provider].backupReconnectRequired) {
    location.assign(sourceEndpoint(view.provider, 'connect'));
  }
}
async function authorizeCloudBackup(button) {
  const view = cloudBackupView;
  if (!currentCloudBackup(view) || !cloudBackupOAuth.has(view.provider) || button.disabled) return;
  const name = providerLabel(view.provider);
  button.disabled = true;
  cloudBackupStatus(view, t('正在准备 {name} 授权…', 'Preparing {name} authorization…', { name }));
  try {
    const { authorizeUrl } = await api(sourceEndpoint(view.provider, 'backup/connect'), {
      ...cloudBackupRequest(), method: 'POST', headers: { Accept: 'application/json' },
    });
    const url = new URL(authorizeUrl);
    if (url.origin + url.pathname !== cloudBackupOAuth.get(view.provider) || url.username || url.password || url.hash) {
      throw new TypeError('Invalid backup authorization URL');
    }
    if (currentCloudBackup(view)) location.assign(url.href);
  } catch (error) {
    button.disabled = false;
    if (await recoverCloudBackupScope(view, error)) return;
    cloudBackupStatus(view, cloudBackupError(view, error,
      t('无法开始 {name} 备份授权。', 'Could not start {name} backup authorization.', { name })));
  }
}
function discardCloudBackupRetry() {
  const view = cloudBackupView;
  if (!currentCloudBackup(view) || !view.scope || cloudBackupWrites.has(view.provider)) return;
  const pending = readPendingCloudBackup(view.scope);
  if (!pending) return;
  rememberPendingCloudBackup(pending, false);
  void loadCloudBackupList(view, t('已清除本机重试记录。', 'Local retry cleared.'));
}
function newCloudBackupId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
function cloudSnapshotSummary(snapshot, skipped = snapshot.tracks.filter(track => !track.file).length) {
  return t('歌单 {playlists} 个，收藏 {favorites} 首，曲目记录 {tracks} 条。其中 {skipped} 条缺少可恢复的曲目引用。',
    '{playlists} playlists, {favorites} favorites, and {tracks} track records. {skipped} track records have no restorable reference.',
    { playlists: snapshot.playlists.length, favorites: snapshot.favorites.length, tracks: snapshot.tracks.length, skipped });
}
function cloudBackupConfirmation(view, text, action) {
  return '<p class="dialog-message">' + esc(text) + '</p><div class="actions">' +
    btn(t('返回', 'Back'), null, cloudBackupAction(view, 'list')) +
    btn(t('确认', 'Confirm'), 'check', cloudBackupAction(view, action), '', true) + '</div>';
}
const cloudBackupStream = (provider, file) => sourceEndpoint(provider, 'stream') + '?id=' + encodeURIComponent(file);
function previewCloudBackupUpload() {
  const view = cloudBackupView;
  if (!currentCloudBackup(view) || !view.scope || cloudBackupWrites.has(view.provider)) return;
  try {
    const scope = view.scope;
    const retry = readPendingCloudBackup(scope);
    if (retry) view.upload = retry;
    else {
      const operation = newCloudBackupId();
      const tracks = allTracks();
      const verifiedFiles = new Map();
      const prefix = scope.provider + ':';
      for (const track of tracks) {
        if (track.provider !== scope.provider || track.backupAccount !== scope.account || !track.id.startsWith(prefix)) continue;
        const file = track.id.slice(prefix.length);
        if (validPlaylistSnapshotFile(scope.provider, file) && track.src === cloudBackupStream(scope.provider, file)) {
          verifiedFiles.set(track.id, file);
        }
      }
      view.upload = { id: operation, scope,
        bytes: createPlaylistSnapshot({ ...state, tracks, ...serializePlaylistDates() }, { scope, operation, verifiedFiles }) };
    }
    const snapshot = readPlaylistSnapshot(view.upload.bytes, scope);
    if (!snapshot.playlists.length && !snapshot.favorites.length) {
      return cloudBackupStatus(view, t('暂无要备份的歌单或收藏。', 'There are no playlists or favorites to back up.'));
    }
    cloudBackupStatus(view, '');
    renderCloudBackup(view, cloudBackupConfirmation(view, cloudSnapshotSummary(snapshot) + ' ' +
      (retry ? t('重试同一次上传，使用原来的备份内容。', 'Retry the same upload with the original snapshot.')
        : t('将此快照保存到当前{name}账号。', 'Save this snapshot to the current {name} account.', { name: providerLabel(view.provider) })),
    'confirm-upload'), 'confirm-upload');
  } catch {
    cloudBackupStatus(view, t('无法创建备份。请检查歌单名称或减少备份内容。', 'Could not create the backup. Check playlist names or reduce the backup size.'));
  }
}
async function writeCloudBackup() {
  const view = cloudBackupView;
  if (!currentCloudBackup(view) || !view.upload || cloudBackupWrites.has(view.provider)) return;
  const upload = view.upload;
  rememberPendingCloudBackup(upload, true);
  cloudBackupWrites.add(view.provider);
  renderCloudBackup(view, '');
  cloudBackupStatus(view, t('正在上传歌单备份…', 'Uploading the playlist backup…'));
  let message;
  try {
    const result = await api(sourceEndpoint(view.provider, 'backup') + '?id=' + upload.id, {
      ...cloudBackupRequest(),
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: upload.bytes,
    });
    if (result.id !== upload.id || !['saved', 'already_present', 'reconciled'].includes(result.status)) {
      throw new TypeError('Unknown backup result');
    }
    rememberPendingCloudBackup(upload, false);
    message = t('歌单备份已上传。', 'Playlist backup uploaded.');
  } catch (error) {
    if (['snapshot_conflict', 'invalid_snapshot'].includes(error.code)) {
      rememberPendingCloudBackup(upload, false);
    }
    if (await recoverCloudBackupScope(view, error)) return;
    message = (!error.status || error.code === 'commit_unknown' || (error.status >= 500 && !error.code))
      ? t('暂无法确认上传结果。重试时会使用原来的备份内容。', 'The upload could not be confirmed. Retry with the original snapshot.')
      : cloudBackupError(view, error, t('无法上传歌单备份。', 'Could not upload the playlist backup.'));
  } finally {
    cloudBackupWrites.delete(view.provider);
  }
  if (currentCloudBackup(view)) await loadCloudBackupList(view, message);
  else if (currentCloudBackup(cloudBackupView) && cloudBackupView.provider === view.provider &&
      $('[data-action="' + cloudBackupAction(view, 'upload') + '"]', cloudBackupView.panel)?.disabled) {
    await loadCloudBackupList(cloudBackupView);
  }
}
async function readCloudBackupVersion(id, scope) {
  const response = await fetch(sourceEndpoint(scope.provider, 'backup') + '?id=' + id + '&verify=1', cloudBackupRequest());
  if (!response.ok) {
    const body = response.status === 403 ? await response.json().catch(() => ({})) : {};
    throw Object.assign(new Error(), { status: response.status, code: body.code });
  }
  // The response wraps the snapshot as escaped JSON text and includes a list of available file IDs.
  const limit = maxPlaylistSnapshotBytes * 3 + 128;
  if (Number(response.headers.get('content-length')) > limit) throw new TypeError('Backup exceeds size limit');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let envelope = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new TypeError('Backup exceeds size limit');
      }
      envelope += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  const { snapshot: text, available } = JSON.parse(envelope + decoder.decode());
  if (typeof text !== 'string' || !Array.isArray(available)) throw new TypeError('Invalid backup preview');
  const snapshot = readPlaylistSnapshot(new TextEncoder().encode(text), scope);
  const files = new Set(snapshot.tracks.flatMap(track => track.file ? [track.file] : []));
  if (snapshot.operation !== id || available.some(file => !files.has(file))) throw new TypeError('Backup version does not match');
  return { text, snapshot, available: new Set(available) };
}
function cloudRestoreReferences(snapshot, available) {
  const { provider, account } = snapshot.scope;
  const stored = new Map(allTracks().map(track => [track.id, track]));
  const newTracks = [];
  const ids = snapshot.tracks.map(track => {
    if (!available.has(track.file)) return undefined;
    const id = provider + ':' + track.file;
    const src = cloudBackupStream(provider, track.file);
    const previous = stored.get(id);
    if (previous && (previous.provider !== provider || previous.backupAccount !== account || previous.src !== src)) {
      return undefined;
    }
    if (!previous) newTracks.push({ id, src, provider, backupAccount: account,
      title: track.title ?? t('{name}曲目 {id}', '{name} track {id}', { name: providerLabel(provider), id: track.file }),
      artist: track.artist ?? '未知艺人', artistIsFallback: !track.artist,
      album: track.album ?? providerNames[provider], albumIsFallback: !track.album });
    return id;
  });
  return { ids, newTracks };
}
async function previewCloudBackupRestore(id) {
  const view = cloudBackupView;
  if (!currentCloudBackup(view) || !view.scope || typeof id !== 'string' || !cloudBackupId.test(id)) return;
  renderCloudBackup(view, '');
  cloudBackupStatus(view, t('正在读取恢复预览…', 'Loading the restore preview…'));
  try {
    const preview = await readCloudBackupVersion(id, view.scope);
    if (!currentCloudBackup(view)) return;
    view.preview = preview;
    const { ids } = cloudRestoreReferences(preview.snapshot, preview.available);
    const names = preview.snapshot.playlists.slice(0, 8).map(list => '<li>' + esc(list.name) + '</li>').join('');
    cloudBackupStatus(view, '');
    renderCloudBackup(view, (names ? '<ul>' + names + '</ul>' : '') +
      '<p class="dialog-message">' + esc(cloudSnapshotSummary(preview.snapshot, ids.filter(item => !item).length)) + ' ' +
      t('恢复会合并到当前歌单和收藏，保留已有内容。', 'Restore merges into your current playlists and favorites and keeps existing entries.') +
      '</p><div class="actions">' + btn(t('返回', 'Back'), null, cloudBackupAction(view, 'list')) +
      btn(t('合并恢复', 'Merge Restore'), 'check', cloudBackupAction(view, 'restore'), '', true) + '</div>', 'restore');
  } catch (error) {
    if (await recoverCloudBackupScope(view, error)) return;
    renderCloudBackup(view, '<div class="actions">' + btn(t('返回', 'Back'), null, cloudBackupAction(view, 'list')) + '</div>', 'list');
    cloudBackupStatus(view, cloudBackupError(view, error, t('无法预览此歌单备份。', 'Could not preview this playlist backup.')));
  }
}
function appendRestoredPlaylistTracks(local, restored) {
  const remaining = new Map();
  for (const id of local) remaining.set(id, (remaining.get(id) || 0) + 1);
  const appended = restored.filter(id => {
    const copies = remaining.get(id);
    if (!copies) return true;
    remaining.set(id, copies - 1);
    return false;
  });
  return [...local, ...appended];
}
function restoredPlaylistId(operation, index) {
  // Keep an ID-less playlist stable across repeated restores and later snapshots.
  const suffix = BigInt.asUintN(48, BigInt('0x' + operation.slice(24)) + BigInt(index));
  return operation.slice(0, 14) + '8' + operation.slice(15, 24) + suffix.toString(16).padStart(12, '0');
}
function restoredPlaylistIds({ operation, playlists }) {
  const explicit = new Set(playlists.flatMap(list => list.id ? [list.id] : []));
  const resolved = playlists.map((list, index) => list.id || restoredPlaylistId(operation, index));
  const reserved = new Set(resolved);
  let next = playlists.length;
  return resolved.map((id, index) => {
    if (playlists[index].id || !explicit.has(id)) return id;
    // Use positions beyond the snapshot so unaffected ID-less lists keep their previous IDs.
    let candidate;
    do { candidate = restoredPlaylistId(operation, next++); } while (reserved.has(candidate));
    reserved.add(candidate);
    return candidate;
  });
}
function mergeCloudBackup(snapshot, available) {
  requireCurrentPlaylistStorage();
  const { ids, newTracks } = cloudRestoreReferences(snapshot, available);
  const previous = { playlists: state.playlists, favorites: state.favorites, tracks: state.tracks };
  const createdAt = new Map(playlistCreationDates);
  const modifiedAt = new Map(playlistModificationDates);
  const playlists = new Map(previous.playlists.map(list => [list.id, list]));
  const playlistIds = restoredPlaylistIds(snapshot);
  for (const [index, list] of snapshot.playlists.entries()) {
    const id = playlistIds[index];
    const local = playlists.get(id);
    const tracks = list.tracks.map(reference => ids[reference]).filter(Boolean);
    playlists.set(id, local ? { ...local, tracks: appendRestoredPlaylistTracks(local.tracks, tracks) } : { id, name: list.name, tracks });
    const date = normalizePlaylistCreatedAt(list.createdAt);
    if (date !== undefined && !createdAt.has(id)) createdAt.set(id, date);
    const modified = latestPlaylistDate(modifiedAt.get(id), list.modifiedAt);
    if (modified !== undefined) modifiedAt.set(id, modified);
  }
  const favorites = [...new Set([...previous.favorites, ...snapshot.favorites.map(reference => ids[reference]).filter(Boolean)])];
  Object.assign(state, { playlists: [...playlists.values()], favorites, tracks: [...previous.tracks] });
  for (const track of newTracks) remember(track);
  if (!save({ strict: true, playlistDates: { createdAt, modifiedAt } })) {
    Object.assign(state, previous);
    throw playlistRestoreStorageError();
  }
  refreshCurrent();
}
function playlistRestoreStorageError() {
  return new InterfaceError('无法保存恢复的歌单。请检查浏览器存储空间后重试。',
    'Could not save the restored playlists. Check browser storage and try again.');
}
async function restoreCloudBackup() {
  const view = cloudBackupView;
  if (!currentCloudBackup(view) || !view.preview) return;
  const preview = view.preview;
  renderCloudBackup(view, '');
  cloudBackupStatus(view, t('正在验证歌单备份…', 'Verifying the playlist backup…'));
  try {
    const checked = await readCloudBackupVersion(preview.snapshot.operation, view.scope);
    if (!currentCloudBackup(view)) return;
    if (checked.text !== preview.text || checked.available.size !== preview.available.size ||
        [...checked.available].some(file => !preview.available.has(file))) {
      throw new InterfaceError('备份或可用曲目已变化，请重新预览。', 'The backup or its available tracks changed. Preview it again.');
    }
    mergeCloudBackup(checked.snapshot, checked.available);
    await loadCloudBackupList(view, t('歌单和收藏已合并。', 'Playlists and favorites merged.'));
  } catch (error) {
    if (await recoverCloudBackupScope(view, error)) return;
    renderCloudBackup(view, '<div class="actions">' + btn(t('返回', 'Back'), null, cloudBackupAction(view, 'list')) + '</div>', 'list');
    cloudBackupStatus(view, cloudBackupError(view, error, t('无法验证此歌单备份，请重新预览。', 'Could not verify this playlist backup. Preview it again.')));
  }
}
function cloudPlaylistBackupActions(provider) {
  return {
    [provider + '-playlist-backup']: () => openCloudPlaylistBackup(provider),
    [provider + '-backup-list']: () => { if (currentCloudBackup(cloudBackupView)) void loadCloudBackupList(cloudBackupView); },
    [provider + '-backup-discard-retry']: discardCloudBackupRetry,
    [provider + '-backup-upload']: previewCloudBackupUpload,
    [provider + '-backup-confirm-upload']: () => void writeCloudBackup(),
    [provider + '-backup-preview']: target => void previewCloudBackupRestore(target.dataset.id),
    [provider + '-backup-restore']: () => void restoreCloudBackup(),
    ...(cloudBackupOAuth.has(provider) && {
      [provider + '-backup-authorize']: button => void authorizeCloudBackup(button),
      [provider + '-backup-reconnect']: reconnectCloudBackup,
    }),
  };
}
function showCloudBackupResult(provider, result) {
  const status = cloudStatus[provider];
  const name = providerLabel(provider);
  let message;
  if (result === 'backup-connected' && status.canBackup) {
    message = t('{name} 歌单备份已授权。', '{name} playlist backup was authorized.', { name });
  } else if (result === 'backup-denied') {
    message = t('已取消 {name} 歌单备份授权。', '{name} playlist backup authorization was canceled.', { name });
  } else {
    message = t('无法完成 {name} 歌单备份授权。', 'Could not complete {name} playlist backup authorization.', { name });
  }
  if (status.connected && (result !== 'backup-connected' || !status.canBackup)) {
    message += t(' 原有播放授权仍可用。', ' Your existing playback access is still available.');
  }
  if (cloudBackupAvailable(provider)) openCloudPlaylistBackup(provider, message);
  else announce(message);
}
function cloudPlaylists(id) {
  const source = sources.find(item => item.id === id && item.type === 'webdav');
  if (!source) return;
  const enabled = playlistSync?.id === id;
  const storeInfo = t('在「{name}」保存歌单和收藏。另一台设备可连接同一目录后同步。',
    'Save playlists and favorites in “{name}”. To sync on another device, connect it to the same folder.',
    { name: source.name });
  openDialog(t('云端歌单', 'Cloud Playlists'), '<p class="dialog-message">' + esc(storeInfo) + '</p><div class="actions">' +
    (enabled
      ? btn(t('立即同步', 'Sync now'), 'refresh-cw', 'auto-sync-now', key(id), true) + btn(t('关闭自动同步', 'Disable auto-sync'), 'cloud-off', 'auto-sync-disable', key(id))
      : btn(t('启用自动同步', 'Enable auto-sync'), 'refresh-cw', 'auto-sync-enable', key(id), true) +
        btn(t('上传歌单', 'Upload playlists'), 'cloud-upload', 'sync-upload', key(id)) + btn(t('下载并合并', 'Download and merge'), 'cloud-download', 'sync-download', key(id))) +
    '</div><div class="dialog-message" data-sync-status role="status">' + (enabled && syncLabel ? esc(syncLabel()) : '') + '</div>');
}
function schedulePlaylistSync(delay = 450) {
  if (cloudCatalogScopeStale || cloudCatalogReadError || restoringCatalog) return;
  if (!playlistSync) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void runPlaylistSync(), delay);
}
function updateSyncLabel(label) {
  syncLabel = label;
  const status = $('[data-sync-status]', dialog);
  if (status && $('[data-action=auto-sync-now]', dialog)) status.textContent = label();
}
async function runPlaylistSync() {
  const operationScope = cloudCatalogScope;
  if (cloudCatalogScopeStale || cloudCatalogReadError || restoringCatalog) return;
  const setup = playlistSync;
  if (!setup || !ready || !sources.some(source => source.id === setup.id)) return;
  if (syncJob) { syncRequested = true; return; }
  updateSyncLabel(() => t('正在同步歌单…', 'Syncing playlists…'));
  const start = currentPlaylistSnapshot();
  try {
    requireCurrentPlaylistStorage();
    syncJob = reconcilePlaylists(sourceEndpoint(setup.id, 'backup'), setup.base, start, {
      beforeWrite: async () => { await assertActiveStateScope(operationScope); requireCurrentPlaylistStorage(); },
    });
    const remote = await syncJob;
    if (playlistSync !== setup || cloudCatalogScope !== operationScope || cloudCatalogScopeStale) return;
    requireCurrentPlaylistStorage();
    const current = currentPlaylistSnapshot();
    const merged = mergePlaylists(start, current, remote);
    const previous = { playlists: state.playlists, favorites: state.favorites, tracks: state.tracks };
    const previousBase = setup.base;
    const previousFingerprint = syncFingerprint;
    const playlistDates = importedPlaylistDates(merged, merged.playlists);
    setup.base = remote;
    state.playlists = merged.playlists;
    state.favorites = merged.favorites;
    state.tracks = [...previous.tracks];
    const storedTracks = new Map(state.tracks.map(track => [track.id, track]));
    const currentTracks = new Map(current.tracks.map(track => [track.id, track]));
    const updated = new Map();
    for (const track of merged.tracks) {
      const stored = storedTracks.get(track.id);
      const previous = currentTracks.get(track.id);
      if (!stored || (previous && JSON.stringify(previous) !== JSON.stringify(track))) {
        remember(track);
        if (previous) updated.set(track.id, { previous, track });
      }
    }
    syncFingerprint = JSON.stringify(currentPlaylistSnapshot(playlistDates));
    if (!save({ strict: true, playlistDates })) {
      Object.assign(state, previous);
      setup.base = previousBase;
      syncFingerprint = previousFingerprint;
      throw playlistRestoreStorageError();
    }
    for (const entry of player.getState().queue) {
      const update = updated.get(entry.id);
      if (!update || entry.src !== update.track.src) continue;
      for (const field of Object.keys(update.previous)) if (!Object.hasOwn(update.track, field)) delete entry[field];
      Object.assign(entry, update.track);
    }
    if (updated.has(player.getState().track?.id)) {
      mediaId = undefined;
      applyEqualizer();
    }
    if (syncFingerprint !== JSON.stringify(current)) refreshCurrent();
    updateSyncLabel(() => t('已同步歌单和收藏。', 'Playlists and favorites are synced.'));
    if (syncFingerprint !== JSON.stringify(remote)) syncRequested = true;
  } catch (error) {
    if (playlistSync === setup) updateSyncLabel(() => displayError(error, t('同步失败，稍后会重试。', 'Sync failed. The player will retry.')));
  } finally {
    syncJob = undefined;
    if (syncRequested) {
      syncRequested = false;
      schedulePlaylistSync();
    }
  }
}
async function syncCloudPlaylists(id, upload) {
  const endpoint = sourceEndpoint(id, 'backup');
  const status = $('[data-sync-status]', dialog);
  const say = message => { if (status?.isConnected) status.textContent = message; else announce(message); };
  say(upload ? t('正在上传…', 'Uploading…') : t('正在下载…', 'Downloading…'));
  if (!upload) pendingWebDavRestores += 1;
  try {
    requireCurrentPlaylistStorage();
    if (upload) {
      const ids = new Set([...state.favorites, ...state.playlists.flatMap(list => list.tracks)]);
      const { playlistCreationDates, playlistModificationDates } = serializePlaylistDates();
      const backup = { version: 1, playlists: state.playlists, favorites: state.favorites, tracks: state.tracks.filter(track => ids.has(track.id)),
        ...(playlistCreationDates.length && { playlistCreationDates }),
        ...(playlistModificationDates.length && { playlistModificationDates }) };
      await api(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
      say(t('歌单已上传。', 'Playlists uploaded.'));
    } else {
      const backup = await api(endpoint);
      requireCurrentPlaylistStorage();
      if (backup.version !== 1 || !Array.isArray(backup.playlists)) throw new InterfaceError('云端歌单格式不受支持。', 'The cloud playlist format is unsupported.');
      const lists = backup.playlists.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.tracks));
      const incoming = importedPlaylistDates(backup, lists);
      const createdAt = new Map(playlistCreationDates);
      const modifiedAt = new Map(playlistModificationDates);
      const previous = { playlists: state.playlists, favorites: state.favorites, tracks: state.tracks };
      const playlists = new Map(previous.playlists.map(list => [list.id, list]));
      for (const item of lists) {
        const list = playlists.get(item.id);
        const tracks = item.tracks.filter(track => typeof track === 'string');
        playlists.set(item.id, list ? { ...list, tracks: appendRestoredPlaylistTracks(list.tracks, tracks) }
          : { id: item.id, name: item.name.slice(0, 80), tracks });
        if (incoming.createdAt.has(item.id) && !createdAt.has(item.id)) createdAt.set(item.id, incoming.createdAt.get(item.id));
        const modified = latestPlaylistDate(modifiedAt.get(item.id), incoming.modifiedAt.get(item.id));
        if (modified !== undefined) modifiedAt.set(item.id, modified);
      }
      state.playlists = [...playlists.values()];
      state.tracks = [...previous.tracks];
      if (Array.isArray(backup.favorites)) state.favorites = [...new Set([...state.favorites, ...backup.favorites.filter(item => typeof item === 'string')])];
      if (Array.isArray(backup.tracks)) for (const track of backup.tracks) {
        if (validCloudTrack(track) && !state.tracks.some(item => item.id === track.id)) remember(track);
      }
      if (!save({ strict: true, playlistDates: { createdAt, modifiedAt } })) {
        Object.assign(state, previous);
        throw playlistRestoreStorageError();
      }
      refreshCurrent(); say(t('云端歌单已合并。', 'Cloud playlists merged.'));
    }
  } catch (error) { say(displayError(error, t('无法同步云端歌单。', 'Could not sync cloud playlists.'))); }
  finally { if (!upload) pendingWebDavRestores -= 1; }
}
function downloadBackup(name, value) {
  const file = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportBackup() {
  try { assertCatalogWritable(); } catch (error) { return announce(catalogErrorMessage(error)); }
  const { cachedPlaylistIds, cacheExclusions, ...backup } = state;
  downloadBackup('groovebox-backup.json', { version: 1, ...backup, removedLibraryTracks: [...state.removedLibraryTracks],
    ...(cloudCatalogs.size && { indexedCatalogSources: [...cloudCatalogs.keys()] }),
    settings: serializedSettings(), ...serializePlaylistDates() });
}
function serializedSettings(settings = state.settings) {
  return { ...settings, hiddenLibrarySources: [...settings.hiddenLibrarySources].map(([id, name]) => ({ id, name })),
    directCloudSources: [...settings.directCloudSources],
    sourceFilenameRules: [...settings.sourceFilenameRules].map(([id, rule]) => ({ id, ...rule })) };
}
function exportPlaybackHistory() {
  const ids = new Set(state.history.map(item => item.id));
  const tracks = state.tracks.filter(track => ids.has(track.id) && validCloudTrack(track));
  downloadBackup('groovebox-playback-history.json', { type: 'groovebox-playback-history', version: 1, history: state.history, tracks });
}
async function importPlaybackHistory(file) {
  try {
    if (file.size > 8_000_000) throw new InterfaceError('播放记录备份超过 8 MB。', 'The playback history backup exceeds 8 MB.');
    const backup = JSON.parse(await file.text());
    if (backup?.version !== 1 || backup.type !== 'groovebox-playback-history' || !Array.isArray(backup.history)) {
      throw new InterfaceError('请选择 Groovebox 播放记录备份。', 'Choose a Groovebox playback history backup.');
    }
    state.history = mergePlaybackHistory(state.history, backup.history);
    const referenced = new Set(state.history.map(item => item.id));
    const tracks = new Map(state.tracks.map(track => [track.id, track]));
    if (Array.isArray(backup.tracks)) for (const track of backup.tracks) {
      if (validCloudTrack(track) && referenced.has(track.id) && !tracks.has(track.id)) tracks.set(track.id, track);
    }
    state.tracks = [...tracks.values()];
    save();
    render();
    announce(t('播放记录已合并。', 'Playback history merged.'));
  } catch (error) {
    const fallback = t('无法读取播放记录备份。', 'Could not read the playback history backup.');
    announce(error instanceof SyntaxError ? fallback : displayError(error, fallback));
  }
}
async function restoreBackup(file) {
  try {
    const backup = JSON.parse(await file.text());
    if (backup.version !== 1 || !Array.isArray(backup.playlists)) {
      throw new InterfaceError('没有识别到可用的 Groovebox 备份', 'This is not a supported Groovebox backup.');
    }
    if (restoringCatalog) return;
    assertCatalogWritable();
    requireCurrentPlaylistStorage();
    const tracks = (Array.isArray(backup.tracks) ? backup.tracks : []).filter(validCloudTrack);
    const snapshots = backup.scanSnapshots && typeof backup.scanSnapshots === 'object' && !Array.isArray(backup.scanSnapshots)
      ? backup.scanSnapshots : {};
    const externalize = catalogNeedsDatabase(tracks, snapshots);
    if (!externalize && !cloudCatalogs.size && cloudCatalogScope === legacyCloudCatalogScope) {
      restoringCatalog = true;
      let hasSettings;
      try {
        hasSettings = await withCatalogRestoreLock(async () => {
          await assertActiveStateScope();
          requireCurrentPlaylistStorage();
          return applyPortableBackup(backup, tracks, {});
        });
      } finally { restoringCatalog = false; }
      finishPortableBackup(hasSettings);
      return;
    }
    restoringCatalog = true;
    scanJob?.controller.abort();
    const inertElements = [content, $('#sidebar'), dialog].map(element => [element, element.inert]);
    for (const [element] of inertElements) element.inert = true;
    let hasSettings;
    try {
      if (cloudCatalogFlush) await cloudCatalogFlush;
      hasSettings = await runCloudCatalogWork(() => withCatalogRestoreLock(async () => {
        assertCatalogWritable();
        await assertActiveStateScope();
        requireCurrentPlaylistStorage();
        const previous = [...cloudCatalogs.values()];
        const originScope = cloudCatalogScope;
        const knownFolders = new Set(Array.isArray(backup.indexedCatalogSources) ? backup.indexedCatalogSources : []);
        const incoming = [...catalogGroups(tracks)].filter(([id]) => externalize || cloudCatalogs.has(id))
          .map(([sourceId, entries]) => ({
            sourceId, tracks: [...new Map(entries.map(track => [track.id, savedTrack(track)])).values()],
            snapshots: knownFolders.has(sourceId) ? snapshots[sourceId] || [] : [],
          }));
        const expectedRevisions = new Map(previous.map(record => [record.sourceId, record.revision]));
        for (const { sourceId } of incoming) if (!expectedRevisions.has(sourceId)) expectedRevisions.set(sourceId, null);
        const proposed = new Map(incoming.map(record => [record.sourceId, record]));
        const merged = mergeCloudState(tracks, {}, proposed);
        const candidate = portableBackupValue(backup, merged.tracks, merged.scanSnapshots, state);
        const compact = catalogMetadata(serializableAppState(candidate.value, {
          records: proposed, dates: candidate.dates, catalogEdits: [],
        }));
        let staged;
        let decisionWritten = false;
        try {
          staged = await prepareCloudCatalogRestore(catalogMetadata(incoming), {
            expectedRevisions, expectedScope: originScope, candidateState: compact,
          });
          requireCurrentPlaylistStorage();
          parseScopedAppState(staged.stateText, staged.scope);
          if (!writeStateTextAtScope(staged.scope, staged.stateText)) throw playlistRestoreStorageError();
          decisionWritten = true;
          const text = readStateTextAtScope(staged.scope);
          if (text !== staged.stateText) throw new CloudCatalogError('cloud-catalog-conflict', 'Restore preferences changed');
          const committed = await finalizeCloudCatalogRestore(staged.id, { expectedScope: originScope, candidateText: text });
          replaceRegisteredCatalogs(committed.records);
          cloudCatalogScope = committed.scope;
          bindStateScope(committed.scope);
          cloudCatalogScopeStale = false;
          cloudCatalogEdits.clear();
          staleCloudCatalogs.clear();
          incompleteCatalogRestore = undefined;
          Object.assign(state, candidate.value, mergeCloudState(candidate.value.tracks, candidate.value.scanSnapshots, cloudCatalogs));
          markAppStatePersisted(state, candidate.dates);
          return candidate.hasSettings;
        } catch (error) {
          if (staged && !decisionWritten) {
            await cancelCloudCatalogRestore(staged.id, { expectedScope: originScope });
          } else if (staged) {
            incompleteCatalogRestore = staged;
            cloudCatalogReadError = error;
          }
          throw error;
        }
      }));
    } finally {
      restoringCatalog = false;
      for (const [element, inert] of inertElements) element.inert = inert;
    }
    finishPortableBackup(hasSettings);
  } catch (error) {
    announce(error instanceof CloudCatalogError ? catalogErrorMessage(error) :
      displayError(error, t('无法读取备份。', 'Could not read the backup.')));
  }
}
async function discardIncompleteCatalogRestore() {
  if (!incompleteCatalogRestore || restoringCatalog) return;
  const pending = incompleteCatalogRestore;
  const scope = cloudCatalogScope;
  restoringCatalog = true;
  try {
    await withCatalogRestoreLock(async () => {
      await cancelCloudCatalogRestore(pending.id, { expectedScope: scope });
      try { localStorage.removeItem(pending.scope); } catch { /* The canceled key cannot become active. */ }
    });
    location.reload();
  } catch (error) { announce(catalogErrorMessage(error)); }
  finally { restoringCatalog = false; }
}
function portableBackupValue(backup, tracks, snapshots, baseState) {
    const state = { ...baseState };
    state.favorites = (Array.isArray(backup.favorites) ? backup.favorites : []).filter(id => typeof id === 'string');
    state.history = mergePlaybackHistory(backup.history);
    state.directRecent = normalizeDirectRecent(backup.directRecent);
    state.playlists = backup.playlists.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.tracks))
      .map(item => ({ id: item.id, name: item.name.slice(0, 80), tracks: item.tracks.filter(id => typeof id === 'string') }));
    state.tracks = tracks;
    state.removedLibraryTracks = libraryTrackIdSet(backup.removedLibraryTracks);
    state.scanSnapshots = snapshots;
    state.cloudScanScopes = normalizeCloudScanScopes(backup.cloudScanScopes);
    const hasSettings = backup.settings && typeof backup.settings === 'object';
    if (hasSettings) {
      state.settings = {
        ...defaults,
        hiddenLibrarySources: normalizeHiddenLibrarySources(backup.settings.hiddenLibrarySources),
        directCloudSources: normalizeDirectCloudSources(backup.settings.directCloudSources),
        sourceFilenameRules: normalizeSourceFilenameRules(backup.settings.sourceFilenameRules),
        language: normalizeLanguage(backup.settings.language ?? state.settings.language),
        theme: Object.hasOwn(themes, backup.settings.theme) ? backup.settings.theme : defaults.theme,
        speed: [.5,.75,1,1.25,1.5,2].includes(backup.settings.speed) ? backup.settings.speed : 1,
        volume: Number.isFinite(backup.settings.volume) ? Math.max(0, Math.min(1, backup.settings.volume)) : defaults.volume,
        shuffle: Boolean(backup.settings.shuffle),
        repeat: ['off','all','one'].includes(backup.settings.repeat) ? backup.settings.repeat : 'off',
        ...equalizerSettings(backup.settings),
        eqPreset: backup.settings.eqPreset === '' || Object.hasOwn(equalizerPresets, backup.settings.eqPreset)
          ? backup.settings.eqPreset : undefined,
        replayGain: Boolean(backup.settings.replayGain),
        replayGainMode: backup.settings.replayGainMode === 'album' ? 'album' : 'track',
        keepAwake: Boolean(backup.settings.keepAwake),
        sleepTimerMinutes: validSleepTimerMinutes(backup.settings.sleepTimerMinutes) ? backup.settings.sleepTimerMinutes : defaults.sleepTimerMinutes,
        sleepTimerFinishTrack: backup.settings.sleepTimerFinishTrack === true,
        reportServerPlayback: backup.settings.reportServerPlayback === true,
        reportEmbyPlayback: backup.settings.reportEmbyPlayback === true,
        autoReadTags: Boolean(backup.settings.autoReadTags),
        ...artworkSettings(backup.settings),
        autoMatchLyrics: backup.settings.autoMatchLyrics === true,
        demos: backup.settings.demos !== false,
        showLocalSource: backup.settings.showLocalSource !== false,
        compactPlayer: backup.settings.compactPlayer === true,
        multilineTrackTitles: backup.settings.multilineTrackTitles === true,
        keepTopbarVisible: backup.settings.keepTopbarVisible !== false,
        openPlaybackOnTrack: backup.settings.openPlaybackOnTrack === true,
        openPlaybackOnCurrentTrack: backup.settings.openPlaybackOnCurrentTrack === true,
        restorePlaybackProgress: backup.settings.restorePlaybackProgress !== false,
        rememberPlaylistPosition: backup.settings.rememberPlaylistPosition === true,
        queueAllDirectTracks: backup.settings.queueAllDirectTracks !== false,
        lyricOffsetMs: normalizeLyricOffset(backup.settings.lyricOffsetMs),
        lyricWeight: normalizeLyricWeight(backup.settings.lyricWeight),
        lyricWordMode: normalizeWordRenderMode(backup.settings.lyricWordMode),
        fullscreenLyricsCentered: backup.settings.fullscreenLyricsCentered === true,
        pauseInBackground: backup.settings.pauseInBackground === true,
        streamBitrates: normalizeStreamBitrates(backup.settings.streamBitrates),
        showAlbumTrackProgress: backup.settings.showAlbumTrackProgress === true,
        blockedArtworkArtists: normalizeArtworkArtists(backup.settings.blockedArtworkArtists),
        blurLyrics: backup.settings.blurLyrics === true,
        playButtonCoverColor: backup.settings.playButtonCoverColor === true,
        playButtonStyle: Object.hasOwn(playButtonStyles, backup.settings.playButtonStyle)
          ? backup.settings.playButtonStyle : defaults.playButtonStyle,
        background: safeImage(backup.settings.background) ? backup.settings.background : undefined,
        backgroundBlur: Number.isFinite(backup.settings.backgroundBlur) ? Math.max(0, Math.min(30, backup.settings.backgroundBlur)) : defaults.backgroundBlur,
        backgroundOpacity: Number.isFinite(backup.settings.backgroundOpacity) ? Math.max(0, Math.min(100, backup.settings.backgroundOpacity)) : defaults.backgroundOpacity,
        sort: normalizeSort('songs', backup.settings.sort),
        listSorts: normalizeListSorts(backup.settings.listSorts),
        playlistOverviewOrder: normalizePlaylistOverviewOrder(backup.settings.playlistOverviewOrder),
        genreRules: normalizeGenreRules(backup.settings.genreRules),
        artistRules: normalizeArtistRules(backup.settings.artistRules),
        albumArtistFallback: backup.settings.albumArtistFallback === true,
        albumGridColumns: normalizeAlbumGridColumns(backup.settings.albumGridColumns),
      };
    }
    return { value: state, hasSettings, dates: importedPlaylistDates(backup, state.playlists) };
}
function applyPortableBackup(backup, tracks, snapshots) {
    const previous = { ...state };
    const candidate = portableBackupValue(backup, tracks, snapshots, state);
    Object.assign(state, candidate.value);
    if (!save({ strict: true, catalogRestore: restoringCatalog, playlistDates: candidate.dates })) {
      Object.assign(state, previous);
      throw playlistRestoreStorageError();
    }
    return candidate.hasSettings;
}
function finishPortableBackup(hasSettings) {
    if (hasSettings) {
      if (!state.settings.onlineCover) stopAutomaticArtwork(artworkRequests);
      if (!state.settings.artistImageEngine) stopAutomaticArtwork(portraitRequests);
      classifyGenres = createGenreClassifier(state.settings.genreRules);
      classifyArtists = createArtistClassifier(state.settings.artistRules);
      setInterfaceLanguage(state.settings.language);
      embyPlayback.setEnabled(state.settings.reportEmbyPlayback);
      mediaId = undefined;
      player.volume(state.settings.volume);
      player.shuffle(state.settings.shuffle);
      player.repeat(state.settings.repeat);
      applySettings();
    }
    refreshCurrent();
    announce(t('备份已恢复。', 'Backup restored.'));
}

const actions = {
  'retry-catalog-recovery': () => location.reload(),
  'discard-catalog-recovery': () => confirmAction(t('放弃未完成恢复', 'Discard Incomplete Restore'),
    t('放弃这次未完成的恢复并保留原有曲库与设置？', 'Discard this incomplete restore and keep the previous library and settings?'),
    'confirm-discard-catalog-recovery'),
  'confirm-discard-catalog-recovery': () => void discardIncompleteCatalogRestore(),
  'retry-source-registry': () => void refreshSources(),
  'metadata-api-settings': metadataApiSettings,
  'metadata-artwork-settings': metadataArtworkSettings,
  'sleep-timer': sleepTimerDialog,
  'cancel-sleep-timer': cancelSleepTimer,
  'listenbrainz-connect': connectListenBrainz,
  'listenbrainz-disconnect': target => void disconnectListenBrainz(target),
  'scroll-top': scrollWorkspaceToTop,
  'toggle-library-source': target => {
    const id = target.dataset.id;
    const hidden = state.settings.hiddenLibrarySources;
    if (hidden.has(id)) hidden.delete(id);
    else hidden.set(id, target.dataset.sourceName);
    save();
    render();
    $$('[data-action="toggle-library-source"]', content).find(button => button.dataset.id === id)?.focus({ preventScroll: true });
  },
  'toggle-direct-mode': target => {
    const id = target.dataset.id;
    if (!cloudProviderIds.includes(id) || !cloudStatus[id].connected || scanJob?.sourceId === id) return;
    if (isDirectCloudSource(id)) state.settings.directCloudSources.delete(id);
    else state.settings.directCloudSources.add(id);
    save();
    render();
    $$('[data-action="toggle-direct-mode"]', content).find(button => button.dataset.id === id)?.focus({ preventScroll: true });
  },
  'source-filename-rule': target => sourceFilenameDialog(target.dataset.id),
  menu: () => document.body.classList.toggle('menu-open'),
  back: () => history.back(),
  forward: () => history.forward(),
  'open-sources': () => go('sources'),
  'play-library': () => playList(library()),
  'play-random-album': playRandomAlbum,
  'shuffle-artist': () => playShuffledList(playRows),
  'play-view': () => playList(playRows, playlistStartIndex(playPlaylistContexts, playlistResumeBookmarks), {
    folder: currentFolderPlaybackKey(), playlistContexts: playPlaylistContexts,
  }),
  'resume-folder': resumeFolder,
  'play-row': (target, index) => playTrackFromList(playRows, target.dataset.playIndex === undefined
    ? playRows === rows ? index : playRows.findIndex(track => track.id === rows[index]?.id)
    : Number(target.dataset.playIndex), target),
  'locate-playing': locatePlayingTrack,
  'selection-mode': () => {
    playlistOrdering = false;
    if (selectionMode) resetSelection();
    else selectionMode = true;
    render();
  },
  'select-row': (target, index, event) => selectTrack(index, !selectedTrackIds.has(rows[index]?.id), event.shiftKey),
  'play-selection': () => playList(selectedTracks()),
  'queue-selection': () => {
    for (const track of selectedTracks()) { remember(track); player.enqueue(track); }
    save();
    announce(t('所选歌曲已加入播放队列。', 'Selected tracks added to the queue.'));
  },
  'playlist-selection': () => playlistPicker(),
  'remove-selection': () => confirmAction(t('移除所选歌曲', 'Remove Selected Tracks'),
    t('确定把所选歌曲从当前歌单移除？', 'Remove the selected tracks from this playlist?'), 'confirm-remove-selection'),
  'confirm-remove-selection': () => {
    const list = state.playlists.find(item => item.id === route.slice(9));
    if (list) filterLocalPlaylistTracks(list, id => !selectedTrackIds.has(id));
    resetSelection(); dialog.close(); save(); render();
  },
  featured: target => {
    const track = find(target.dataset.id);
    if (!track) return;
    const album = featuredAlbum(track);
    if (album) go('album/' + albumKey(track));
    else playTrackFromList([track], 0, target);
  },
  'direct-source-album': target => {
    const [id, path] = target.dataset.id.split(':');
    const source = directNavidromeSources().find(entry => entry.id === id);
    const album = source && navidromeHomeAlbums.get(id)?.albums.find(entry => entry.path === path);
    if (album) void openCloud(id, true, [{ name: '根目录', path: '/' }, { name: album.name, path, browseKind: 'album' }]);
  },
  group: target => go(route.slice(0, -1) + '/' + target.dataset.id),
  'search-genre': target => go('genre/' + target.dataset.id),
  'artist-album': target => go('album/' + target.dataset.id),
  favorite: target => favorite(find(target.dataset.id)),
  'favorite-current': () => favorite(player.getState().track || (state.settings.demos && demoTracks[0])),
  'favorite-menu': target => { dialog.close(); favorite(find(target.dataset.id)); },
  'track-menu': target => trackMenu(find(target.dataset.id)),
  'compatible-play': target => { const track = find(target.dataset.id); dialog.close(); void prepareCompatibleAudio(track); },
  'original-audio': target => { dialog.close(); void returnToOriginalAudio(target.dataset.id); },
  'read-tags': target => { const track = find(target.dataset.id); dialog.close(); void readEmbeddedTags(track, true); },
  'read-tags-bulk': () => void readVisibleTrackTags(rows),
  'cancel-read-tags': () => bulkTagJob?.controller.abort(),
  'match-online-cover': target => { const track = find(target.dataset.id); dialog.close(); void matchOnlineCover(track, true); },
  'match-album-cover': () => void matchAlbumArtwork(true),
  'match-artist-portrait': () => void matchArtistPortrait(true),
  'toggle-artist-artwork': () => {
    if (!route.startsWith('artist/')) return;
    const name = route.slice('artist/'.length);
    const id = artistIdentity(name);
    if (!id || id.length > 200) return;
    const blocked = automaticArtworkBlocked(name);
    state.settings.blockedArtworkArtists = blocked ? state.settings.blockedArtworkArtists.filter(value => value !== id) :
      normalizeArtworkArtists([...state.settings.blockedArtworkArtists, id]);
    if (!blocked) stopCustomArtwork(job => !job.valid());
    save();
    render();
    $('[data-action="toggle-artist-artwork"]', content)?.focus({ preventScroll: true });
    if (blocked) {
      void matchArtistPortrait();
      refreshCurrentArtwork();
    }
  },
  'queue-menu': (target, index) => queueMenu(index),
  'queue-play': (target, index) => {
    const snapshot = player.getState();
    if (!snapshot.queue[index] || openPlayingTrackDetails(snapshot, index === snapshot.index, target)) return;
    void player.play(index);
    openPlaybackForTrack(target);
  },
  'queue-up': (target, index) => { dialog.close(); player.move(index, index - 1); },
  'queue-down': (target, index) => { dialog.close(); player.move(index, index + 1); },
  'queue-remove': (target, index) => { dialog.close(); player.remove(index); },
  'clear-queue': () => { player.clear(); folderPlayback = undefined; save(); },
  enqueue: target => {
    const track = find(target.dataset.id);
    if (!track) return;
    dialog.close();
    remember(track);
    player.enqueue(track);
    save();
    announce(t('已添加到播放队列', 'Added to the queue'));
  },
  'enqueue-next': target => {
    const track = find(target.dataset.id);
    if (!track) return;
    dialog.close();
    remember(track);
    player.enqueue(track, true);
    save();
    announce(t('已安排为下一首', 'Queued to play next'));
  },
  'pick-playlist': target => { if (find(target.dataset.id)) playlistPicker(target.dataset.id); },
  'playlist-picker-mode': target => playlistPicker(target.form.dataset.trackId, target.getAttribute('aria-pressed') !== 'true'),
  'new-playlist': () => playlistDialog(),
  'reorder-playlists': () => reorderPlaylistsDialog(),
  'playlist-up': target => movePlaylist(target, -1),
  'playlist-down': target => movePlaylist(target, 1),
  'import-m3u': () => $('#import-m3u-file').click(),
  'new-playlist-from-picker': target => {
    const trackId = target.form.dataset.trackId;
    playlistDialog();
    const form = $('[data-form="playlist"]', dialog);
    if (trackId) form.dataset.trackId = trackId;
    else form.dataset.selection = 'true';
  },
  'rename-playlist': () => playlistDialog(state.playlists.find(item => item.id === route.slice(9))),
  'playlist-order': () => {
    if (!route.startsWith('playlist/') || listSort(route) !== 'default') return;
    playlistOrdering = !playlistOrdering;
    resetSelection();
    render();
    $('[data-action=playlist-order]', content)?.focus({ preventScroll: true });
  },
  'playlist-track-up': (target, index) => movePlaylistTrack(index, -1),
  'playlist-track-down': (target, index) => movePlaylistTrack(index, 1),
  'playlist-selection-up': () => movePlaylistSelection(-1),
  'playlist-selection-down': () => movePlaylistSelection(1),
  'toggle-playlist-cache': target => togglePlaylistCache(target.dataset.id),
  'retry-playlist-cache': target => retryPlaylistCache(target.dataset.id),
  'precache-playlist': target => void precachePlaylist(target.dataset.id),
  'cancel-playlist-precache': () => playlistPrecache?.controller.abort(),
  'download-playlist': target => void downloadPlaylist(target.dataset.id),
  'cancel-playlist-download': () => playlistDownload?.controller.abort(),
  'downloaded-music': () => go('offline'),
  'remove-download': target => confirmAction(t('删除下载', 'Remove download'),
    t('从播放器删除这首歌的下载副本或导入记录？会保留设备和网盘中的原文件。', 'Remove this track’s saved copy from Groovebox? The original file stays on your device or cloud drive.'),
    'confirm-remove-download', target.dataset.id),
  'confirm-remove-download': target => {
    dialog.close();
    void removeDownloadedTrack(target.dataset.id).catch(() => announce(t('无法删除下载。', 'Could not remove the download.')));
  },
  'remove-selected-downloads': () => confirmAction(t('删除下载', 'Remove Downloads'),
    t('从播放器删除所选下载和导入记录？会保留设备和网盘中的原文件。', 'Remove the selected copies from Groovebox? The original files stay on your device or cloud drive.'),
    'confirm-remove-selected-downloads'),
  'confirm-remove-selected-downloads': async () => {
    const tracks = selectedTracks();
    dialog.close(); resetSelection();
    let failed = 0;
    for (const track of tracks) {
      try { if (!await removeDownloadedTrack(track.id)) failed++; } catch { failed++; }
    }
    render();
    const removed = tracks.length - failed;
    announce(t('已删除 {count} 首{detail}。', 'Removed {tracks}.{detail}', {
      count: removed, tracks: trackCount(removed),
      detail: failed ? t('，{count} 首删除失败', ' Could not delete {tracks}.', { count: failed, tracks: trackCount(failed) }) : '',
    }));
  },
  'delete-playlist': () => confirmAction(t('删除歌单', 'Delete Playlist'), t('确定删除这个歌单？', 'Delete this playlist?'), 'confirm-delete-playlist', route.slice(9)),
  'confirm-delete-playlist': target => {
    const { id } = target.dataset;
    state.playlists = state.playlists.filter(item => item.id !== id);
    localPlaylistSlots.delete(id);
    playlistResumeBookmarks.delete('playlist/' + id);
    state.cachedPlaylistIds = state.cachedPlaylistIds.filter(entry => entry !== id);
    if (playlistDownload?.id === id) playlistDownload.controller.abort();
    if (preparedPlaylistDownload?.id === id) {
      URL.revokeObjectURL(preparedPlaylistDownload.url);
      preparedPlaylistDownload = undefined;
    }
    dialog.close(); save(); go('songs');
  },
  'add-to-playlist': target => addToLocalPlaylists(target.form, [target.dataset.id]),
  'remove-from-playlist': target => {
    const list = state.playlists.find(item => item.id === route.slice(9));
    if (list) filterLocalPlaylistTracks(list, id => id !== target.dataset.id);
    dialog.close(); save(); refreshCurrent();
  },
  'cache-offline': target => { dialog.close(); void offlineAction(target.dataset.id, false); },
  'pin-offline': target => { dialog.close(); void offlineAction(target.dataset.id, false); },
  'save-original-audio': target => { dialog.close(); void saveOriginalAudio(find(target.dataset.id)); },
  'drop-offline': target => { dialog.close(); void offlineAction(target.dataset.id, true); },
  'remove-track': target => confirmLibraryRemoval([find(target.dataset.id)].filter(Boolean)),
  'confirm-remove-track': target => void confirmAndRemoveLibraryTracks([find(target.dataset.id)].filter(Boolean)),
  'remove-library-selection': () => confirmLibraryRemoval(selectedLibraryTracks(), true),
  'confirm-remove-library-selection': () => {
    const tracks = selectedLibraryTracks();
    resetSelection();
    void confirmAndRemoveLibraryTracks(tracks);
  },
  'restore-library-track': target => {
    const track = find(target.dataset.id);
    if (!track || !sourceVisibleInCatalog(librarySourceId(track)) || !state.removedLibraryTracks.delete(track.id)) return;
    if (track.provider !== 'local') {
      const restored = savedTrack(track);
      delete restored.directOnly;
      state.tracks = state.tracks.filter(item => item.id !== track.id).concat(restored);
      if (cloudCatalogs.has(catalogSourceId(restored))) cloudCatalogEdits.add(restored.id);
    }
    dialog.close();
    save();
    refreshCurrent();
  },
  'import-files': target => {
    const { track } = player.getState();
    localLyricsTarget = target.closest('.lyrics') && track?.provider === 'local' ? track.id : undefined;
    $('#import-files').click();
  },
  'import-folder': () => { localLyricsTarget = undefined; $('#import-folder').click(); },
  'close-dialog': () => dialog.close(),
  'baidu-source': () => void baiduSource(),
  'baidu-configure': () => void baiduSettings(),
  'baidu-authorize': () => { location.href = '/api/baidu/connect'; },
  'baidu-code': () => void baiduCodeDialog(),
  'baidu-device': () => void baiduDeviceDialog(),
  'oauth-source': target => void oauthSource(target.dataset.id),
  'oauth-authorize': target => { if (cloudProviderIds.includes(target.dataset.id)) location.href = sourceEndpoint(target.dataset.id, 'connect'); },
  'open-cloud': target => void openCloud(target.dataset.id),
  'open-indexed-folder': target => {
    const source = target.dataset.source;
    if (!sourceVisibleInCatalog(source)) return;
    const folder = indexedCloudFolders(state.scanSnapshots[source]).find(entry => entry.path === target.dataset.id);
    if (folder) void openCloud(source, true, [{ name: '根目录', path: '/' }, ...folder.trail], { restoreIndexed: true });
  },
  'server-playlists': () => {
    if (cloud) void openCloud(cloud.id, false, [cloud.trail[0], { path: 'playlists' }]);
  },
  'sync-navidrome-playlists': () => void syncNavidromePlaylists(),
  ...serverPlaylistActions('emby'),
  ...serverPlaylistActions('jellyfin'),
  'remove-jellyfin-playlist-entries': confirmJellyfinGroupRemoval,
  'confirm-remove-jellyfin-playlist-entries': target => void updateServerPlaylist(target, 'jellyfin', 'remove-group'),
  'save-playlist-mirror': () => void saveServerPlaylistMirror(),
  'open-playlist-mirror': target => go('server-playlist/' + target.dataset.id),
  'refresh-playlist-mirror': target => void refreshServerPlaylistMirror(target.dataset.id),
  'remove-playlist-mirror': target => confirmAction(t('移除本地镜像', 'Remove Local Mirror'),
    t('从这台设备移除本地镜像？', 'Remove the local mirror from this device?'), 'confirm-remove-playlist-mirror', target.dataset.id),
  'confirm-remove-playlist-mirror': target => {
    const id = target.dataset.id;
    dialog.close();
    void changeServerPlaylistMirror(id, async () => {
      await deleteServerPlaylistMirror(id);
      serverPlaylistMirrors.delete(id);
      if (route === 'server-playlist/' + id) go('sources');
    }, t('无法移除本地镜像。', 'Could not remove the local mirror.'));
  },
  'open-folder': target => {
    const item = cloud?.items.find(item => String(item.id) === target.dataset.id && item.folder);
    if (item) {
      const { name, path, browseKind } = item;
      void openCloud(cloud.id, false, [...cloud.trail, { name, path, browseKind }]);
    }
  },
  crumb: (target, index) => { if (cloud) void openCloud(cloud.id, false, cloud.trail.slice(0, index + 1)); },
  'reload-cloud': async () => {
    if (!cloud) return;
    const view = cloud;
    if (sources.some(source => source.id === view.id && folderPortraitProviders.has(source.type))) await refreshRemoteArtistIndex(view.id);
    if (cloud === view) void openCloud(view.id, false, view.trail);
  },
  'scan-cloud': () => void scanCloud(),
  'set-scan-start': setCloudScanStart,
  'choose-scan-folders': chooseScanFolders,
  'scan-new-cloud': () => void scanCloud('incremental'),
  'refresh-library': () => void refreshLibrary(),
  'cancel-scan': () => scanJob?.controller.abort(),
  'disconnect-oauth': target => confirmAction(t('断开{name}', 'Disconnect {name}', { name: providerLabel(target.dataset.id) }),
    t('需要播放网盘歌曲时，可以再次授权连接。', 'Reconnect any time to play tracks from this drive.'), 'confirm-disconnect-oauth', target.dataset.id),
  'confirm-disconnect-oauth': target => {
    const id = target.dataset.id;
    dialog.close();
    void api(sourceEndpoint(id, 'disconnect'), { method: 'POST' }).then(async result => {
      cloudStatus[id] = result; baidu = cloudStatus.baidu; cloud = null; go('sources');
      await resetSourceScan(id);
    }).catch(error => announce(error instanceof CloudCatalogError ? catalogErrorMessage(error) :
      displayError(error, t('无法断开网盘。', 'Could not disconnect the cloud drive.'))));
  },
  'disconnect-source': () => {
    if (cloud) confirmAction(t('移除来源', 'Remove Source'), t('确定断开这个媒体服务器？', 'Disconnect this media server?'), 'confirm-disconnect-source', cloud.id);
  },
  'confirm-disconnect-source': target => {
    const id = target.dataset.id;
    dialog.close();
    void api('/api/sources/' + encodeURIComponent(id), { method: 'DELETE' }).then(async () => {
      invalidateRemoteArtistImages(id);
      sources = sources.filter(item => item.id !== id); navidromeHomeAlbums.delete(id); cloud = null; go('sources');
      await resetSourceScan(id);
    }).catch(error => announce(error instanceof CloudCatalogError ? catalogErrorMessage(error) :
      displayError(error, t('无法断开媒体服务器。', 'Could not disconnect the media server.'))));
  },
  'add-source': addSource,
  'plex-sign-in': target => void startPlexSignIn(target),
  'connect-plex-server': target => void connectPlexServer(target),
  'plex-sign-in-again': () => {
    addSource();
    const type = $('[name=type]', dialog);
    type.value = 'plex';
    type.dispatchEvent(new Event('change', { bubbles: true }));
  },
  'cloud-playlists': target => cloudPlaylists(target.dataset.id),
  ...Object.assign({}, ...Array.from(cloudBackupProviders, cloudPlaylistBackupActions)),
  'sync-upload': target => confirmAction(t('上传歌单', 'Upload Playlists'),
    t('将用当前歌单和收藏替换服务器上的 Groovebox 歌单备份。', 'Replace the Groovebox backup on the server with your current playlists and favorites?'), 'confirm-sync-upload', target.dataset.id),
  'confirm-sync-upload': target => { cloudPlaylists(target.dataset.id); void syncCloudPlaylists(target.dataset.id, true); },
  'sync-download': target => void syncCloudPlaylists(target.dataset.id, false),
  'auto-sync-enable': target => {
    const id = target.dataset.id;
    playlistSync = { id, base: playlistSnapshot() };
    syncLabel = '';
    save();
    cloudPlaylists(id);
    schedulePlaylistSync(0);
  },
  'auto-sync-disable': target => {
    playlistSync = undefined;
    clearTimeout(syncTimer);
    syncLabel = '';
    save();
    cloudPlaylists(target.dataset.id);
  },
  'auto-sync-now': () => schedulePlaylistSync(0),
  cast: () => void selectPlaybackDevice(),
  'dlna-find': () => void findDlnaDevices(),
  'dlna-manage': showDlnaPlayback,
  'dlna-start': target => void startDlna(target.dataset.id, target.textContent),
  'dlna-play': () => void controlLocalCast('play'),
  'dlna-pause': () => void controlLocalCast('pause'),
  'dlna-stop': () => void controlLocalCast('stop'),
  toggle: togglePlayback,
  previous: () => void player.previous(),
  next: () => void player.next(),
  shuffle: () => { state.settings.shuffle = player.shuffle(); save(); },
  repeat: () => { state.settings.repeat = player.repeat(); save(); },
  mute: () => {
    const level = player.getState().volume;
    if (level) muteVolume = level;
    state.settings.volume = level ? 0 : muteVolume;
    player.volume(state.settings.volume);
    save();
  },
  'queue-panel': () => {
    if (tab === 'lyrics') { tab = 'queue'; showPanel(true, true); }
    else showPanel(!panelOpen, true);
  },
  'close-panel': () => showPanel(false),
  'tab-queue': () => { tab = 'queue'; syncPlayer(player.getState()); },
  'tab-lyrics': openLyricsTab,
  'seek-lyric': (target, _index, event) => activateLyricLine(target, event),
  'lyric-offset': lyricOffsetDialog,
  'step-lyric-offset': stepLyricOffset,
  'match-lyrics': () => lyricsDialog(),
  'browse-lyric-versions': () => lyricsDialog(true),
  'server-lyric-versions': showServerLyricVersions,
  'choose-server-lyric-version': chooseServerLyricVersion,
  'toggle-lyric-source': toggleLyricSource,
  'clear-lyrics-cache': () => confirmAction(t('清理歌词缓存', 'Clear Lyrics Cache'),
    t('将删除在线匹配结果和暂存的来源歌词。当前歌词会保留到下一次播放，原文件和离线音频会保留。',
      'Clear saved online matches and temporary source lyrics. The current lyrics stay until playback changes. Original files and offline audio are kept.'),
    'confirm-clear-lyrics-cache'),
  'confirm-clear-lyrics-cache': clearLyricsCache,
  'cache-manager': () => void showCacheManager(),
  'clear-audio-cache': () => confirmCacheClear('audio'),
  'clear-image-cache': () => confirmCacheClear('image'),
  'clear-all-caches': () => confirmCacheClear('all'),
  'confirm-managed-cache-clear': target => void clearManagedCache(target.dataset.id),
  'resume-managed-caches': () => void resumeManagedCaches(),
  'choose-lyric-match': chooseLyricMatch,
  immersive: toggleImmersive,
  'lyric-focus': toggleLyricFocus,
  frequent: () => go('frequent'),
  timeline: () => go('timeline'),
  'recent-plays': () => go('history'),
  'play-history': target => {
    const track = find(target.dataset.id);
    if (track) playTrackFromList([track], 0, target);
  },
  'export-history': exportPlaybackHistory,
  'import-history': () => $('#history-restore-file').click(),
  'clear-history': () => confirmAction(t('清除播放历史', 'Clear Playback History'), t('确定清除所有播放记录？', 'Clear the entire playback history?'), 'confirm-clear-history'),
  'confirm-clear-history': () => { state.history = []; state.directRecent = []; dialog.close(); save(); render(); },
  theme: target => {
    if (!Object.hasOwn(themes, target.dataset.id)) return;
    state.settings.theme = target.dataset.id;
    applySettings(); save(); render();
  },
  'background-upload': () => $('#background-file').click(),
  'background-clear': () => { delete state.settings.background; applySettings(); save(); render(); },
  'original-sound': () => {
    Object.assign(state.settings, { eq: [...defaults.eq], eqEnabled: false, eqPreset: 'flat', eqProfile: '', replayGain: false, speed: defaults.speed });
    applySettings(); save(); render();
  },
  'eq-reset': () => {
    Object.assign(state.settings, { eq: [...defaults.eq], eqPreset: 'flat', eqProfile: '' });
    applyEqualizer(); save(); render();
  },
  'eq-save': () => {
    const current = state.settings.eqProfiles.find(profile => profile.name.toLowerCase() === state.settings.eqProfile);
    openDialog(t('保存均衡器配置', 'Save equalizer profile'), '<form class="dialog-inner" data-form="eq-profile" style="padding:0">' +
      '<label class="dialog-field">' + t('配置名称', 'Profile name') + '<input required name="name" maxlength="48" value="' + esc(current?.name || '') + '"></label>' +
      '<p class="dialog-message" role="status">' + t('使用已有名称会更新该配置。', 'Using an existing name updates that profile.') + '</p>' +
      '<button class="btn primary" type="submit">' + t('保存', 'Save') + '</button></form>');
  },
  'eq-delete': () => {
    if (!state.settings.eqProfile) return;
    state.settings.eqProfiles = state.settings.eqProfiles.filter(profile => profile.name.toLowerCase() !== state.settings.eqProfile);
    state.settings.eqProfile = '';
    save(); render(); $('[data-action="eq-save"]')?.focus({ preventScroll: true });
  },
  export: exportBackup,
  restore: () => $('#restore-file').click(),
};

function clearTrackPress() {
  clearTimeout(trackPress?.timer);
  trackPress = undefined;
}
document.addEventListener('pointerdown', event => {
  if (!event.isPrimary) return;
  clearTrackPress();
  suppressedPointerClickWithin = undefined;
  if (event.button !== 0) return;
  const locator = event.pointerType === 'touch' && event.target.closest?.('.play-info:not(:disabled)');
  const button = locator || (!selectionMode && event.target.closest?.('.track-table-long-press [data-action="play-row"]'));
  if (!button) return;
  const index = Number(button.dataset.index);
  const press = { id: event.pointerId, x: event.clientX, y: event.clientY };
  press.timer = setTimeout(() => {
    if (locator) {
      suppressedPointerClickWithin = button;
      locatePlayingTrack();
      return;
    }
    if (!button.isConnected || selectionMode || !rows[index]) return;
    suppressedPointerClickWithin = content;
    selectionMode = true;
    selectTrack(index, true, false);
    render();
    content.querySelector('[data-select-track="' + index + '"]')?.focus({ preventScroll: true });
  }, 550);
  trackPress = press;
});
document.addEventListener('pointermove', event => {
  if (trackPress?.id === event.pointerId && Math.hypot(event.clientX - trackPress.x, event.clientY - trackPress.y) > 10) clearTrackPress();
});
for (const eventName of ['pointerup', 'pointercancel']) {
  document.addEventListener(eventName, event => {
    if (trackPress?.id === event.pointerId) clearTrackPress();
  });
}
content.addEventListener('contextmenu', event => {
  const row = event.target.closest?.('.track-table tr[data-track]');
  if (!row) return;
  if (trackPress && event.target.closest('.track-table-long-press .track-main')) {
    event.preventDefault();
    return;
  }
  if (event.pointerType === 'touch' || selectionMode) return;
  event.preventDefault();
  trackMenu(find(row.dataset.track));
});
document.addEventListener('click', event => {
  if (event.detail > 0 && suppressedPointerClickWithin?.contains(event.target)) {
    suppressedPointerClickWithin = undefined;
    event.preventDefault();
    return;
  }
  const artist = event.target.closest('a[data-lyric-artist],a[data-album-artist]');
  if (artist && !event.button && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    if (artist.dataset.lyricArtist) {
      if (immersive) toggleImmersive();
      if (panelOpen && innerWidth <= 1000) showPanel(false);
    }
    go('artist/' + (artist.dataset.lyricArtist || artist.dataset.albumArtist));
    content.focus({ preventScroll: true });
    return;
  }
  if (event.target.id === 'select-all-tracks') {
    if (event.target.checked) rows.forEach(track => selectedTrackIds.add(track.id));
    else selectedTrackIds.clear();
    selectionAnchor = -1;
    updateSelectionControls();
    return;
  }
  if (event.target.dataset.selectTrack !== undefined) {
    selectTrack(Number(event.target.dataset.selectTrack), event.target.checked, event.shiftKey);
    return;
  }
  const button = event.target.closest('button[data-nav],button[data-action]');
  if (!button) return;
  if (button.dataset.nav) {
    document.body.classList.remove('menu-open');
    go(button.dataset.nav);
  } else {
    const handler = actions[button.dataset.action];
    handler?.(button, Number(button.dataset.index), event);
  }
});
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('close', cancelClosedLyricRequest);
dialog.addEventListener('close', () => { dialogRevision++; });
$('.topbar').addEventListener('click', event => {
  if (!folderViewIsOpen() || event.target.closest?.('button, a, input, label')) return;
  scrollWorkspaceToTop();
});
content.addEventListener('dblclick', event => {
  if ($('#playlist-search', content) && event.target.closest?.('.page-head h1')) scrollWorkspaceToTop();
});
document.addEventListener('dblclick', event => {
  if (event.button !== 0 || !event.target.closest?.('.lyrics .lyric-line') || !player.getState().track) return;
  clearTimeout(pendingLyricSeek);
  event.preventDefault();
  togglePlayback();
});
dialog.addEventListener('change', event => {
  if (event.target.id === 'playlist-overview-sort') {
    state.settings.playlistOverviewOrder = normalizePlaylistOverviewOrder(event.target.value);
    save();
    render();
    reorderPlaylistsDialog('sort');
    return;
  }
  if (event.target.form?.dataset.form === 'pick-local-playlists') return updatePlaylistChoiceCount(event.target.form);
  if (event.target.id === 'dlna-position') {
    void controlLocalCast('seek', Number(event.target.value));
    return;
  }
  if (event.target.name !== 'type' || event.target.form?.dataset.form !== 'source') return;
  const hint = $('[data-source-hint]', event.target.form);
  $('[data-action=plex-sign-in]', event.target.form).hidden = event.target.value !== 'plex';
  hint.textContent = ({
    fnmusic: t('填写音桥的 OpenSubsonic 地址（默认端口 14040），使用已在音桥绑定的飞牛音乐独立账号。',
      'Enter the Yinqiao OpenSubsonic address (port 14040 by default) and the Feiniu Music account linked to it.'),
    smb: t('填写 smb://主机/共享名和有读取权限的账号。服务端需安装 SMB 组件。',
      'Enter smb://host/share and an account with read access. The server requires the SMB component.'),
    plex: t('可以先登录 Plex 再选择服务器，也可以填写服务器地址和访问令牌。',
      'Sign in to Plex to choose a server, or enter a server URL and access token.'),
  })[event.target.value] || '';
});
dialog.addEventListener('submit', async event => {
  const form = event.target;
  event.preventDefault();
  if (form.dataset.form === 'pick-local-playlists') return addToLocalPlaylists(form, new FormData(form).getAll('playlist'));
  if (form.dataset.form === 'include-scan-folders') return includeScanFolders(form);
  const data = Object.fromEntries(new FormData(form));
  if (form.dataset.form === 'cache-budgets') return saveCacheBudgets(form);
  if (form.dataset.form === 'source-filename-rule') return saveSourceFilenameRule(form, data);
  if (form.dataset.form === 'sleep-timer') return startSleepTimer(data);
  if (form.dataset.form === 'listenbrainz-connect') return saveListenBrainzConnection(form, data);
  if (form.dataset.form === 'lyric-match') return requestMatchedLyrics(form, data);
  if (form.dataset.form === 'metadata-api') return saveMetadataApiSettings(form, data);
  if (form.dataset.form === 'metadata-artwork-api') return saveMetadataArtworkSettings(form, data);
  if (form.dataset.form === 'lyric-offset') return saveLyricOffset(form);
  if (form.dataset.form === 'emby-create-playlist') return createServerPlaylist(form, data, 'emby');
  if (form.dataset.form === 'jellyfin-create-playlist') return createServerPlaylist(form, data, 'jellyfin');
  if (form.dataset.form === 'baidu-config') return saveBaiduSettings(form, data);
  if (form.dataset.form === 'baidu-code') return completeBaiduCode(form, data);
  if (form.dataset.form === 'eq-profile') {
    const name = equalizerProfileName(data.name);
    const status = $('[role=status]', form);
    if (!name) { status.textContent = t('请输入配置名称。', 'Enter a profile name.'); return; }
    const id = name.toLowerCase();
    const index = state.settings.eqProfiles.findIndex(profile => profile.name.toLowerCase() === id);
    if (index === -1 && state.settings.eqProfiles.length >= maxEqualizerProfiles) {
      status.textContent = t('最多可保存 30 个均衡器配置。', 'You can save up to 30 equalizer profiles.');
      return;
    }
    const profile = { name, gains: [...state.settings.eq] };
    if (index === -1) state.settings.eqProfiles.push(profile);
    else state.settings.eqProfiles[index] = profile;
    state.settings.eqProfile = id;
    dialog.close(); save(); render(); $('#eq-profile')?.focus({ preventScroll: true });
    return;
  }
  if (form.dataset.form === 'playlist') {
    const name = data.name.trim();
    if (!name) { announce(t('请输入歌单名称。', 'Enter a playlist name.')); return; }
    let list = state.playlists.find(item => item.id === form.dataset.id);
    const track = find(form.dataset.trackId);
    if (list) list.name = name;
    else {
      const chosen = form.dataset.selection ? selectedTracks() : track ? [track] : [];
      chosen.forEach(remember);
      list = createLocalPlaylist(name, chosen.map(item => item.id));
    }
    dialog.close(); save(); go('playlist/' + list.id);
  }
  if (form.dataset.form === 'source') {
    const status = $('.dialog-message', form);
    const submit = $('button[type=submit]', form);
    status.textContent = t('正在连接…', 'Connecting…');
    submit.disabled = true;
    try {
      const { source } = await api('/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      sources.push(source);
      schedulePlaylistSync(0);
      if (dialog.open && dialog.contains(form)) dialog.close();
      openCloud(source.id);
    } catch (error) { status.textContent = displayError(error, t('无法连接媒体服务器。', 'Could not connect to the media server.')); }
    finally { submit.disabled = false; }
  }
});
search.addEventListener('input', () => {
  query = search.value.trim();
  if (query) {
    if (route !== 'search') {
      searchReturn = route;
      playlistOrdering = false;
      resetSelection();
    }
    route = 'search';
    history.replaceState(null, '', '#search');
    render();
    $('.workspace').scrollTop = 0;
  } else if (route === 'search') {
    go(searchReturn);
  }
});
const volumeSlider = $('#volume');
volumeSlider.addEventListener('input', event => {
  state.settings.volume = Number(event.target.value) / 100;
  player.volume(state.settings.volume);
});
volumeSlider.addEventListener('change', save);
volumeSlider.addEventListener('wheel', event => {
  if (event.ctrlKey || event.metaKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  const current = Number(volumeSlider.value);
  const next = Math.max(Number(volumeSlider.min), Math.min(Number(volumeSlider.max), current - Math.sign(event.deltaY) * 5));
  if (next === current) return;
  volumeSlider.value = String(next);
  volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
}, { passive: false });
$('#seek').addEventListener('input', event => {
  const snapshot = player.getState();
  player.seek(Number(event.target.value) * (snapshot.duration || snapshot.track?.duration || 0) / 1000);
});
for (const id of ['#import-files', '#import-folder']) {
  $(id).addEventListener('change', event => {
    const lyricsTarget = id === '#import-files' ? localLyricsTarget : undefined;
    localLyricsTarget = undefined;
    queueLocalSelection(Array.from(event.target.files || []), lyricsTarget);
    event.target.value = '';
  });
  $(id).addEventListener('cancel', () => { localLyricsTarget = undefined; });
}
$('#import-m3u-file').addEventListener('change', event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) void importM3uPlaylist(file);
});
$('#restore-file').addEventListener('change', event => {
  if (event.target.files[0]) void restoreBackup(event.target.files[0]);
  event.target.value = '';
});
$('#history-restore-file').addEventListener('change', event => {
  if (event.target.files[0]) void importPlaybackHistory(event.target.files[0]);
  event.target.value = '';
});
$('#background-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)) return;
  if (file.size > 1800000) return announce(t('请选择小于 1.8 MB 的背景图片。', 'Choose a background image smaller than 1.8 MB.'));
  const reader = new FileReader();
  reader.onload = () => { state.settings.background = reader.result; applySettings(); save(); render(); };
  reader.readAsDataURL(file);
});
content.addEventListener('error', event => {
  if (event.target.classList?.contains('folder-cover')) event.target.outerHTML = icon('folder');
}, true);
content.addEventListener('submit', event => {
  const form = event.target;
  const artist = form.dataset.form === 'artist-rules';
  if (!artist && form.dataset.form !== 'genre-rules') return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  const rules = artist ? normalizeArtistRules(values) : normalizeGenreRules(values);
  if (artist) {
    state.settings.artistRules = rules;
    classifyArtists = createArtistClassifier(rules);
  } else {
    state.settings.genreRules = rules;
    classifyGenres = createGenreClassifier(rules);
  }
  form.elements.separators.value = rules.separators.join('\n');
  form.elements.exceptions.value = rules.exceptions.join('\n');
  save();
  announce(artist ? t('已保存艺人规则。', 'Artist rules saved.') : t('已保存分类规则。', 'Genre rules saved.'));
});
content.addEventListener('change', event => {
  const input = event.target;
  if (input.dataset.eq !== undefined) {
    const index = Number(input.dataset.eq);
    if (!Number.isInteger(index) || index < 0 || index >= state.settings.eq.length) return;
    state.settings.eq[index] = Math.max(-12, Math.min(12, Number(input.value) || 0));
    state.settings.eqPreset = '';
    state.settings.eqProfile = '';
    $('#eq-preset').value = '';
    $('#eq-profile').value = '';
    $('[data-action="eq-delete"]').disabled = true;
    applyEqualizer();
    save();
    return;
  }
  if (input.id === 'lyric-word-mode') {
    state.settings.lyricWordMode = normalizeWordRenderMode(input.value);
    document.documentElement.dataset.lyricWordMode = state.settings.lyricWordMode;
    syncPlayer(player.getState());
    save();
    return;
  }
  if (input.id === 'interface-language') {
    state.settings.language = normalizeLanguage(input.value);
    setInterfaceLanguage(state.settings.language);
    mediaId = undefined;
    save();
    refreshCurrent();
    $('#interface-language')?.focus({ preventScroll: true });
    return;
  }
  const downloadFilter = input.dataset.downloadFilter;
  if (['category', 'artist', 'album', 'genre'].includes(downloadFilter)) {
    downloadFilters[downloadFilter] = input.value;
    resetSelection();
    render();
    return;
  }
  const grid = input.dataset.albumGrid;
  if ((grid === 'catalog' || grid === 'artist') && albumGridChoices.includes(input.value)) {
    state.settings.albumGridColumns[grid] = input.value;
    save();
    render();
    $('[data-album-grid="' + grid + '"]')?.focus({ preventScroll: true });
    return;
  }
  if (input.id === 'sort') {
    const section = route.split('/', 1)[0];
    if (!Object.hasOwn(sortSections, section)) return;
    const value = normalizeSort(section, input.value);
    if (section === 'songs') state.settings.sort = value;
    else state.settings.listSorts[section] = value;
    playlistOrdering = false;
    selectionAnchor = -1;
    save();
    render();
    $('#sort')?.focus({ preventScroll: true });
    return;
  }
  if (input.id === 'speed') { state.settings.speed = Number(input.value); applySettings(); save(); }
  if (input.id === 'eq-enabled') {
    state.settings.eqEnabled = input.checked;
    applyEqualizer(); save();
    return;
  }
  if (input.id === 'eq-preset' && Object.hasOwn(equalizerPresets, input.value)) {
    Object.assign(state.settings, { eq: [...equalizerPresets[input.value]], eqPreset: input.value, eqProfile: '' });
    applyEqualizer(); save(); render(); $('#eq-preset')?.focus({ preventScroll: true });
    return;
  }
  if (input.id === 'eq-profile') {
    const profile = state.settings.eqProfiles.find(entry => entry.name.toLowerCase() === input.value);
    if (!profile) return;
    Object.assign(state.settings, { eq: [...profile.gains], eqPreset: '', eqProfile: input.value });
    applyEqualizer(); save(); render(); $('#eq-profile')?.focus({ preventScroll: true });
    return;
  }
  if (input.id === 'show-local-source') { state.settings.showLocalSource = input.checked; save(); }
  if (input.id === 'album-artist-fallback') { state.settings.albumArtistFallback = input.checked; save(); }
  if (input.id === 'artist-album-cover-fallback') { state.settings.artistAlbumCoverFallback = input.checked; save(); }
  if (input.id === 'lyric-blur') { state.settings.blurLyrics = input.checked; applySettings(); save(); }
  if (input.id === 'fullscreen-lyrics-centered') {
    state.settings.fullscreenLyricsCentered = input.checked;
    applyFullscreenLyricsAlignment();
    save();
  }
  if (input.id === 'play-button-style' && Object.hasOwn(playButtonStyles, input.value)) {
    state.settings.playButtonStyle = input.value;
    applySettings();
    save();
  }
  if (input.id === 'play-button-cover-color') {
    state.settings.playButtonCoverColor = input.checked;
    updatePlayButtonCoverColor();
    save();
  }
  if (input.id === 'compact-player') { state.settings.compactPlayer = input.checked; applySettings(); save(); }
  if (input.id === 'multiline-track-titles') { state.settings.multilineTrackTitles = input.checked; applySettings(); save(); }
  if (input.id === 'lyric-weight' && Object.hasOwn(lyricWeights, input.value)) {
    state.settings.lyricWeight = input.value;
    document.documentElement.dataset.lyricWeight = input.value;
    save();
  }
  if (input.id === 'keep-topbar-visible') { state.settings.keepTopbarVisible = input.checked; applySettings(); save(); }
  if (input.id === 'open-playback-on-track') { state.settings.openPlaybackOnTrack = input.checked; save(); }
  if (input.id === 'open-playback-on-current-track') { state.settings.openPlaybackOnCurrentTrack = input.checked; save(); }
  if (input.id === 'restore-playback-progress') { state.settings.restorePlaybackProgress = input.checked; save(); }
  if (input.id === 'remember-playlist-position') { state.settings.rememberPlaylistPosition = input.checked; save(); }
  if (input.id === 'queue-all-direct-tracks') { state.settings.queueAllDirectTracks = input.checked; save(); }
  if (input.id === 'pause-in-background') { state.settings.pauseInBackground = input.checked; save(); }
  if (['network', 'wifi', 'cellular'].includes(input.dataset.streamBitrate)) {
    const profile = input.dataset.streamBitrate;
    state.settings.streamBitrates = normalizeStreamBitrates({ ...state.settings.streamBitrates,
      [profile]: profile === 'network' ? input.value : Number(input.value) });
    save();
  }
  if (input.id === 'show-album-track-progress') { state.settings.showAlbumTrackProgress = input.checked; save(); }
  if (input.id === 'demo-enabled') { state.settings.demos = input.checked; save(); refreshCurrent(); }
  if (input.id === 'replay-gain') { state.settings.replayGain = input.checked; applyEqualizer(); save(); }
  if (input.id === 'replay-gain-mode') {
    state.settings.replayGainMode = input.value === 'album' ? 'album' : 'track';
    applyEqualizer();
    save();
  }
  if (input.id === 'keep-awake') { state.settings.keepAwake = input.checked; void updateScreenLock(); save(); }
  if (input.id === 'report-server-playback') { state.settings.reportServerPlayback = input.checked; save(); }
  if (input.id === 'report-emby-playback') {
    state.settings.reportEmbyPlayback = input.checked;
    embyPlayback.setEnabled(input.checked);
    save();
  }
  if (input.id === 'auto-read-tags') { state.settings.autoReadTags = input.checked; save(); }
  if (input.id === 'online-cover') {
    state.settings.onlineCover = input.checked;
    if (input.checked) void matchOnlineCover(player.getState().track, false, { playing: true });
    else stopAutomaticArtwork(artworkRequests);
    save();
  }
  if (input.id === 'artist-image-engine') {
    state.settings.artistImageEngine = input.checked;
    if (!input.checked) stopAutomaticArtwork(portraitRequests);
    save();
  }
  if (input.id === 'auto-match-lyrics') {
    state.settings.autoMatchLyrics = input.checked;
    if (!input.checked) automaticLyricJob?.controller.abort();
    save();
    refreshLyrics();
  }
});
content.addEventListener('input', event => {
  const input = event.target;
  if (input.id === 'download-search' || input.id === 'playlist-search') {
    if (!event.isComposing) updateListSearch(input);
    return;
  }
  if (input.id === 'background-blur' || input.id === 'background-opacity') {
    const blur = input.id === 'background-blur';
    state.settings[blur ? 'backgroundBlur' : 'backgroundOpacity'] = Number(input.value);
    input.nextElementSibling.textContent = input.value + (blur ? ' px' : '%');
    applyBackground();
    save();
    return;
  }
  if (input.dataset.eq === undefined) return;
  $('#eq-preset').value = '';
  $('#eq-profile').value = '';
  $('[data-action="eq-delete"]').disabled = true;
  input.nextElementSibling.textContent = input.value + ' dB';
});
function updateListSearch(input) {
  const playlist = input.id === 'playlist-search';
  if (input.value === (playlist ? playlistQuery : downloadFilters.query)) return;
  if (playlist) {
    playlistQuery = input.value;
    playlistOrdering = false;
  } else downloadFilters.query = input.value;
  resetSelection();
  render();
}
content.addEventListener('compositionend', event => {
  if (['download-search', 'playlist-search'].includes(event.target.id)) updateListSearch(event.target);
});
document.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
document.addEventListener('drop', event => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  queueLocalSelection(Array.from(event.dataTransfer.files));
});
document.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' || !event.isPrimary) return;
  const pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  if (event.target.closest?.('.immersive-art')) immersivePointer = pointer;
  if (panelOpen && tab === 'queue' && event.target.closest?.('#now .now-cover, #now .mini-lyrics')) lyricPanelPointer = pointer;
});
document.addEventListener('pointercancel', event => {
  if (immersivePointer?.id === event.pointerId) immersivePointer = undefined;
  if (lyricPanelPointer?.id === event.pointerId) lyricPanelPointer = undefined;
});
document.addEventListener('pointerup', event => {
  if (lyricPanelPointer?.id === event.pointerId) {
    const right = event.clientX - lyricPanelPointer.x;
    const vertical = Math.abs(event.clientY - lyricPanelPointer.y);
    lyricPanelPointer = undefined;
    if (panelOpen && tab === 'queue' && right >= 64 && right > vertical * 1.5) {
      suppressedPointerClickWithin = now;
      openLyricsTab();
    }
  }
  if (immersivePointer?.id !== event.pointerId) return;
  const down = event.clientY - immersivePointer.y;
  const sideways = Math.abs(event.clientX - immersivePointer.x);
  immersivePointer = undefined;
  if (immersive && down >= 72 && down > sideways * 1.5) toggleImmersive();
});
$('.play-info').addEventListener('contextmenu', event => {
  if (event.pointerType === 'touch') event.preventDefault();
});
$('.play-info').addEventListener('mousedown', event => {
  // A touch hold can emit a compatibility mouse event on release.
  if (suppressedPointerClickWithin === event.currentTarget) event.preventDefault();
});
document.addEventListener('keydown', event => {
  const lyricFocus = document.body.hasAttribute('data-immersive-lyric-focus');
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !dialog.open && !lyricFocus) {
    event.preventDefault(); search.focus(); search.select(); return;
  }
  if (event.key === 'Escape' && !dialog.open) {
    if (lyricFocus) {
      event.preventDefault();
      toggleLyricFocus();
      return;
    }
    if (immersive) actions.immersive();
    else if (document.body.classList.contains('menu-open')) document.body.classList.remove('menu-open');
    else if (innerWidth <= 1000) showPanel(false);
  }
  if (dialog.open || event.target.closest?.('input,textarea,select,button,a,[contenteditable],.queue-list')) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
  if (event.code === 'ArrowRight') player.seek(player.getState().currentTime + 5);
  if (event.code === 'ArrowLeft') player.seek(player.getState().currentTime - 5);
});
if ('mediaSession' in navigator) {
  for (const [action, handler] of Object.entries({
    play: () => void player.play(), pause: () => audio.pause(), nexttrack: actions.next, previoustrack: actions.previous,
    seekbackward: ({ seekOffset = 10 }) => player.seek(player.getState().currentTime - seekOffset),
    seekforward: ({ seekOffset = 10 }) => player.seek(player.getState().currentTime + seekOffset),
    seekto: ({ seekTime }) => player.seek(seekTime),
  })) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* browser support varies */ }
  }
}
for (const event of ['playing', 'pause', 'ended', 'emptied']) audio.addEventListener(event, updateScreenLock);
audio.addEventListener('timeupdate', checkSleepTimer);
for (const event of ['loadstart', 'loadedmetadata', 'emptied', 'playing']) audio.addEventListener(event, updateOpusOutputGain);
document.addEventListener('visibilitychange', updateScreenLock);
document.addEventListener('visibilitychange', pauseWhenHidden);
document.addEventListener('visibilitychange', checkSleepTimer);
audio.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', updateCasting);
for (const event of ['connecting', 'connect', 'disconnect']) audio.remote?.addEventListener(event, updateCasting);
window.addEventListener('hashchange', readRoute);
window.addEventListener('online', () => schedulePlaylistSync(0));
window.addEventListener('online', () => schedulePlaylistCache(0));
window.addEventListener('online', retryRemoteArtistImages);
window.addEventListener('online', () => { void refreshMetadataLyricsStatus(true).catch(() => {}); });
window.addEventListener('focus', () => { void refreshMetadataLyricsStatus(true).catch(() => {}); });
window.addEventListener('online', () => { void refreshCustomCoverStatus(true); });
window.addEventListener('focus', () => { void refreshCustomCoverStatus(true); });
dialog.addEventListener('change', ({ target }) => {
  const form = target.closest('form[data-form="metadata-artwork-api"]');
  if (!form) return;
  if (target.name === 'adapter') $('[data-custom-cover-fields]', form).disabled = target.value !== 'hisatri';
  if (target.name === 'headersAction') {
    form.elements.headers.disabled = target.value !== 'replace';
    if (form.elements.headers.disabled) form.elements.headers.value = '';
  }
});
dialog.addEventListener('change', event => {
  if (event.target.id !== 'metadata-lyrics-adapter') return;
  const url = event.target.form?.elements.url;
  if (event.target.value === 'lrclib' && url && !url.value) url.value = 'https://lrclib.net/api/get';
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) retryRemoteArtistImages(); });
window.addEventListener('focus', () => schedulePlaylistSync(0));
setInterval(() => { if (!document.hidden) schedulePlaylistSync(0); }, 15000);
setInterval(() => { if (!document.hidden) schedulePlaylistCache(); }, 15000);
setInterval(() => { if (!document.hidden) void updateDlnaPosition(); }, 2000);
window.addEventListener('pagehide', () => {
  if (!ready) return;
  const snapshot = player.getState();
  if (snapshot.duration > 0) updateFolderBookmark(snapshot);
  embyPlayback.stop();
  save();
});
matchMedia('(max-width:1000px)').addEventListener('change', ({ matches }) => showPanel(!matches));
colorPreference.addEventListener('change', () => { if (state.settings.theme === 'system') applySettings(); });

for (const element of $$('[data-icon]')) element.outerHTML = icon(element.dataset.icon);
player.volume(state.settings.volume);
player.shuffle(state.settings.shuffle);
player.repeat(state.settings.repeat);
applySettings();
showPanel(panelOpen);
readRoute();
const params = new URLSearchParams(location.search);
const oauthId = cloudProviderIds.find(id => params.has(id));
const oauthResult = params.get(oauthId);
const cloudBackupResult = cloudBackupOAuth.has(oauthId) && ['backup-connected', 'backup-denied', 'backup-error'].includes(oauthResult);
const plexAuthorized = params.get('plex') === 'authorized';
if (oauthResult) {
  history.replaceState(null, '', location.pathname + '#sources');
  readRoute();
  const name = providerLabel(oauthId);
  if (!cloudBackupResult && (oauthId !== 'baidu' || oauthResult !== 'redirect-mismatch')) {
    announce(oauthResult === 'connected' ? t('已连接 {name}。', '{name} connected.', { name }) : oauthResult === 'denied' ?
      t('已取消 {name} 授权。', '{name} authorization canceled.', { name }) : t('{name} 授权失败，请重试。', 'Could not authorize {name}. Try again.', { name }));
  }
}
if (plexAuthorized) {
  history.replaceState(null, '', location.pathname + '#sources');
  readRoute();
}
void refreshMetadataLyricsStatus().catch(() => {});
void refreshCustomCoverStatus();
void refreshSources().then(() => {
  if (oauthResult === 'connected' && cloudStatus[oauthId].connected) void openCloud(oauthId);
  if (cloudBackupResult) showCloudBackupResult(oauthId, oauthResult);
  if (oauthId === 'baidu' && oauthResult === 'redirect-mismatch') void baiduSource(true, oauthResult);
  if (plexAuthorized) void choosePlexServer();
});
void api('/api/listenbrainz/status').then(({ account }) => {
  if (account && !listenBrainzAccount) setListenBrainzAccount(account);
}).catch(() => {});
void readServerPlaylistMirrors().then(mirrors => {
  for (const mirror of mirrors) serverPlaylistMirrors.set(mirror.id, mirror);
}).catch(error => {
  if (error.code !== 'local-library-upgrade-blocked') {
    announce(t('浏览器无法打开服务器歌单镜像。', 'Could not open server playlist mirrors in this browser.'));
  }
}).finally(() => {
  loadingServerPlaylistMirrors = false;
  render();
});
try {
  [locals, localArtistImages] = await Promise.all([hydrateLocals(), hydrateLocalArtistImages()]);
} catch (error) {
  if (error.code === 'local-library-upgrade-blocked') announceBlockedLocalLibrary();
  else announce(t('浏览器无法打开本地音乐库。', 'Could not open the local music library in this browser.'));
}
await hydrateOffline().catch(() => announce(t('浏览器无法打开离线歌曲存储。', 'Could not open offline music storage in this browser.')));
try { setAudioCachePolicy(await readOfflineCachePolicy()); } catch { /* Storage errors are reported by the offline UI. */ }
subscribeOfflineCache(policy => {
  setAudioCachePolicy(policy);
  updatePlaylistCacheStatus();
  if (route === 'offline') render();
});
window.addEventListener('storage', event => {
  if (event.key === automaticCachePassKey || event.key?.startsWith(playlistCachePassMarkerPrefix)) automaticCachePass = undefined;
  if (event.key === lyricCacheEpochKey) { synchronizeLyricCacheEpoch(); refreshLyrics(); }
});
subscribeCloudCatalogs(({ sources, scope }, { remote }) => {
  if (!remote) return;
  let changed = false;
  if (scope && scope !== cloudCatalogScope) {
    cloudCatalogScopeStale = true;
    scanJob?.controller.abort();
    clearTimeout(syncTimer);
    changed = true;
  }
  for (const { sourceId, revision } of sources) {
    if ((cloudCatalogs.get(sourceId)?.revision ?? null) === revision || staleCloudCatalogs.has(sourceId)) continue;
    staleCloudCatalogs.add(sourceId);
    changed = true;
  }
  if (changed) {
    announce(catalogErrorMessage(new CloudCatalogError('cloud-catalog-conflict', 'Cloud catalog changed in another tab')));
    render();
  }
});
const unopened = !player.getState().queue.length;
const tracksForRestore = unopened && Array.isArray(loaded.queue) ? new Map(allTracks().map(track => [track.id, track])) : undefined;
const restored = unopened && Array.isArray(loaded.queue) ? loaded.queue.flatMap((id, offset) => {
  const track = tracksForRestore.get(id);
  return track ? [{ track, offset }] : [];
}) : [];
if (restored.length) {
  const original = restored.findIndex(entry => entry.offset === loaded.index);
  const playlistContexts = Array.isArray(loaded.playlistQueue?.occurrences) ? restored.map(({ track, offset }) => {
    const saved = loaded.playlistQueue.occurrences[offset];
    const context = { playlist: loaded.playlistQueue.playlist, occurrence: saved === true ? trackOccurrence(track.id) : saved };
    return validPlaylistContext(context, track.id) ? context : undefined;
  }) : undefined;
  const session = original >= 0 ? { shuffle: loaded.shuffleSession, offsets: restored.map(entry => entry.offset),
    position: state.settings.restorePlaybackProgress ? loaded.position : undefined, playlistContexts } : { playlistContexts };
  if (validFolderPlaybackKey(loaded.folderQueue?.key) && Array.isArray(loaded.folderQueue.outside)) {
    const outside = new Set(loaded.folderQueue.outside);
    folderPlayback = { key: loaded.folderQueue.key, members: new Set(restored.map(({ track }) => track.id).filter(id => !outside.has(id))) };
  }
  await player.load(restored.map(entry => entry.track), Math.max(0, original), false, session);
} else if (unopened && state.settings.demos) {
  await player.load(demoTracks, 0, false);
}
render();
ready = true;
if (cloudCatalogStartupError) announce(catalogErrorMessage(cloudCatalogStartupError));
void flushCloudCatalogEdits();
refreshCurrentArtwork();
schedulePlaylistSync(0);
schedulePlaylistCache(0);
if (window.isSecureContext && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {});
}
