const mebibyte = 1024 * 1024;
export const defaultAudioCacheMiB = 1024;
export const minimumAudioCacheMiB = 200;

export class OfflineCachePolicyError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function validAudioCacheLimit(limitMiB) {
  return Number.isSafeInteger(limitMiB) && limitMiB >= minimumAudioCacheMiB && Number.isSafeInteger(limitMiB * mebibyte);
}

export function checkAutomaticCache(policy, generation, bytes = 0) {
  if (generation !== policy.generation) throw new OfflineCachePolicyError('offline-cache-stale');
  if (policy.paused) throw new OfflineCachePolicyError('offline-cache-paused');
  if (bytes > policy.limitMiB * mebibyte) throw new OfflineCachePolicyError('offline-cache-limit');
}

export function automaticEvictions(entries, limitMiB, incomingBytes = 0) {
  const automatic = entries.filter(entry => entry.mode === 'automatic');
  const limit = limitMiB * mebibyte;
  let bytes = automatic.reduce((total, entry) => total + entry.bytes, incomingBytes);
  if (bytes <= limit) return [];
  const evicted = [];
  for (const entry of automatic.sort((a, b) => a.lastAccess - b.lastAccess)) {
    evicted.push(entry.id);
    bytes -= entry.bytes;
    if (bytes <= limit) break;
  }
  return evicted;
}

export function offlineCacheStats(policy, entries) {
  const { limitMiB, generation, paused } = policy;
  const stats = { limitMiB, generation, paused, automaticBytes: 0, automaticCount: 0, pinnedBytes: 0, pinnedCount: 0,
    automaticArtworkBytes: 0, pinnedArtworkBytes: 0, attachedArtworkBytes: 0, totalBytes: 0 };
  for (const { mode, bytes, coverBytes } of entries) {
    if (mode === 'automatic') {
      stats.automaticBytes += bytes;
      stats.automaticCount++;
      stats.automaticArtworkBytes += coverBytes;
    } else {
      stats.pinnedBytes += bytes;
      stats.pinnedCount++;
      stats.pinnedArtworkBytes += coverBytes;
    }
    stats.attachedArtworkBytes += coverBytes;
  }
  stats.totalBytes = stats.automaticBytes + stats.pinnedBytes + stats.attachedArtworkBytes;
  return stats;
}
