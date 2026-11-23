export const historyLimit = 1500;

export function createPlaybackHistoryRecorder(record, clock = Date.now) {
  let play;
  return ({ track, duration }, { token }, ranges) => {
    if (!track) return;
    if (!play || play.token !== token) play = { token, at: clock(), recorded: false };
    if (play.recorded) return;
    const threshold = Number.isFinite(duration) && duration > 0 ? Math.min(duration / 2, 180) : 180;
    let listened = 0;
    for (let index = 0; index < ranges.length; index++) listened += ranges.end(index) - ranges.start(index);
    if (listened < threshold) return;
    play.recorded = true;
    record({ id: track.id, at: play.at });
  };
}

export function playbackStatistics(history, now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 6);
  const todayStart = today.getTime();
  const weekStartTime = weekStart.getTime();
  const heard = new Set();
  let playsToday = 0;
  let playsThisWeek = 0;
  for (const { id, at } of history) {
    if (at > now) continue;
    heard.add(id);
    if (at >= todayStart) playsToday++;
    if (at >= weekStartTime) playsThisWeek++;
  }
  return { playsToday, playsThisWeek, tracksPlayed: heard.size };
}

export function mergePlaybackHistory(current, incoming = []) {
  const events = new Map();
  for (const collection of [current, incoming]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (typeof item?.id !== 'string' || !item.id || item.id.length > 4096 ||
          !Number.isSafeInteger(item.at) || item.at < 0 || item.at > 8.64e15) continue;
      const { id, at } = item;
      const event = typeof item.event === 'string' && /^[a-f0-9-]{36}$/i.test(item.event) ? item.event : null;
      const key = event || JSON.stringify([id, at]);
      if (!events.has(key)) events.set(key, event ? { id, at, event } : { id, at });
    }
  }
  return [...events.values()].sort((a, b) => b.at - a.at).slice(0, historyLimit);
}
