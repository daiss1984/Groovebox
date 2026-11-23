const repeatModes = ['off', 'all', 'one'];
const shuffleHistoryLimit = 512;

function mergePlayedRanges(previous, played) {
  const ranges = previous.slice();
  for (let index = 0; index < (played?.length ?? 0); index++) ranges.push([played.start(index), played.end(index)]);
  ranges.sort(([first], [second]) => first - second);
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function createPlayer(audio, {
  onChange = () => {},
  onPlay = () => {},
  onPlaybackChange = () => {},
  onEnded = () => {},
  onError = () => {},
  resolveTrack = track => track.src,
  preloader,
} = {}) {
  let queue = [];
  let active = null;
  let shuffled = false;
  let shufflePath = [];
  let shufflePosition = -1;
  const shuffleVisited = new Set();
  let shuffleNext = [];
  let plannedShuffleEntry;
  let repeatMode = 'off';
  let preloadedUrl;

  function getState() {
    const ready = Boolean(active?.ready);
    const change = active?.sourceChange?.reloading ? active.sourceChange : undefined;
    return {
      queue: queue.map(entry => entry.track),
      index: queue.indexOf(active?.entry),
      track: active?.entry.track ?? null,
      playlistContext: active?.entry.playlistContext,
      playing: change ? active.wantsPlayback : ready && !audio.paused && !audio.ended,
      currentTime: change?.position ?? (ready && Number.isFinite(audio.currentTime) ? audio.currentTime : 0),
      duration: change?.duration ?? (ready && Number.isFinite(audio.duration) ? audio.duration : 0),
      volume: audio.volume,
      shuffle: shuffled,
      repeat: repeatMode,
    };
  }

  function playbackRanges() {
    if (!active?.priorPlayed) return audio.played;
    const ranges = mergePlayedRanges(active.priorPlayed, active.sourceChange?.reloading ? undefined : audio.played);
    return { length: ranges.length, start: index => ranges[index][0], end: index => ranges[index][1] };
  }

  function notify(reason = 'change') {
    const snapshot = getState();
    if (active?.started && !active.playbackStopped && !active.sourceChange?.reloading) {
      onPlaybackChange(snapshot, { token: active.playbackToken, reason }, playbackRanges());
    }
    onChange(snapshot);
    if (preloader) {
      const upcoming = active?.started && !active.playbackStopped && (active.wantsPlayback || audio.ended) && repeatMode !== 'one'
        ? nextCandidate() : undefined;
      preloader.prepare(upcoming?.track);
    }
  }

  function stopPlayback() {
    if (!active?.started || active.playbackStopped) return;
    active.playbackStopped = true;
    onPlaybackChange(getState(), { token: active.playbackToken, reason: 'stop' }, playbackRanges());
  }

  function resetShuffle(entry = active?.entry) {
    shufflePath = entry ? [entry] : [];
    shufflePosition = shufflePath.length - 1;
    shuffleVisited.clear();
    if (entry) shuffleVisited.add(entry);
    shuffleNext = [];
    plannedShuffleEntry = undefined;
  }

  function shuffleSnapshot() {
    if (!shuffled || !active) return undefined;
    const offsets = new Map(queue.map((entry, index) => [entry, index]));
    return {
      path: shufflePath.map(entry => offsets.get(entry)),
      position: shufflePosition,
      visited: [...shuffleVisited].map(entry => offsets.get(entry)),
      next: shuffleNext.map(entry => offsets.get(entry)),
    };
  }

  function restoreShuffle(entry, session) {
    const snapshot = session?.shuffle;
    if (!shuffled || !Array.isArray(snapshot?.path) || snapshot.path.length > shuffleHistoryLimit ||
        !Number.isInteger(snapshot.position) || !Array.isArray(snapshot.visited) || !Array.isArray(snapshot.next)) return;
    const byOffset = new Map(queue.map((item, index) => [session.offsets?.[index] ?? index, item]));
    if (byOffset.get(snapshot.path[snapshot.position]) !== entry) return;

    shufflePath = [];
    shufflePosition = -1;
    snapshot.path.forEach((offset, index) => {
      const item = byOffset.get(offset);
      if (!item) return;
      shufflePath.push(item);
      if (index <= snapshot.position) shufflePosition++;
    });
    shuffleVisited.clear();
    for (const offset of snapshot.visited) {
      const item = byOffset.get(offset);
      if (item) shuffleVisited.add(item);
    }
    if (!shuffleVisited.size) shuffleVisited.add(entry);
    shuffleNext = [...new Set(snapshot.next.map(offset => byOffset.get(offset)).filter(Boolean))];
  }

  function recordShuffleVisit(entry) {
    shufflePath.splice(++shufflePosition, 0, entry);
    shuffleVisited.add(entry);
    if (shufflePath.length > shuffleHistoryLimit) {
      shufflePath.shift();
      shufflePosition--;
    }
    return entry;
  }

  function selectShuffleEntry(entry) {
    // An explicit selection replaces the forward path, while Previous retains
    // the actual tracks heard before it.
    shufflePath.length = shufflePosition + 1;
    shuffleNext = shuffleNext.filter(candidate => candidate !== entry);
    plannedShuffleEntry = undefined;
    if (shuffleVisited.has(entry)) shuffleVisited.clear();
    recordShuffleVisit(entry);
  }

  function planShuffleEntry() {
    if (plannedShuffleEntry) return plannedShuffleEntry;
    let upcoming = queue.filter(candidate => !shuffleVisited.has(candidate));
    if (!upcoming.length && repeatMode === 'all') {
      const alternatives = queue.filter(candidate => candidate !== active.entry);
      const distinct = alternatives.filter(candidate => candidate.track.id !== active.entry.track.id);
      upcoming = distinct.length ? distinct : alternatives.length ? alternatives : queue;
    }
    if (upcoming.length) plannedShuffleEntry = upcoming[Math.floor(Math.random() * upcoming.length)];
    return plannedShuffleEntry;
  }

  function nextCandidate() {
    if (shuffled) return shuffleNext[0] || shufflePath[shufflePosition + 1] || planShuffleEntry();
    return queue[queue.indexOf(active.entry) + 1] || (repeatMode === 'all' ? queue[0] : undefined);
  }

  function nextShuffleEntry() {
    const requested = shuffleNext.shift();
    if (requested) {
      plannedShuffleEntry = undefined;
      return recordShuffleVisit(requested);
    }
    const recorded = shufflePath[shufflePosition + 1];
    if (recorded) {
      shufflePosition++;
      return recorded;
    }

    const entry = planShuffleEntry();
    plannedShuffleEntry = undefined;
    if (entry && shuffleVisited.has(entry)) shuffleVisited.clear();
    if (entry) return recordShuffleVisit(entry);
  }

  function removeShuffleEntry(entry) {
    if (entry === plannedShuffleEntry) plannedShuffleEntry = undefined;
    shuffleVisited.delete(entry);
    shuffleNext = shuffleNext.filter(candidate => candidate !== entry);
    const originalPosition = shufflePosition;
    shufflePosition = -1;
    shufflePath = shufflePath.filter((candidate, index) => {
      if (candidate === entry) return false;
      if (index <= originalPosition) shufflePosition++;
      return true;
    });
  }

  function stopMedia() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (preloadedUrl) URL.revokeObjectURL(preloadedUrl);
    preloadedUrl = undefined;
  }

  function cancelSourceChange() {
    const change = active?.sourceChange;
    if (!change) return;
    change.controller.abort();
    if (change.reloading) audio.preload = change.preload;
  }

  function waitForSource(src, change) {
    const signal = AbortSignal.any([change.controller.signal, AbortSignal.timeout(10000)]);
    return new Promise(resolve => {
      function finish(ready) {
        for (const [event, listener] of Object.entries(listeners)) audio.removeEventListener(event, listener);
        signal.removeEventListener('abort', fail);
        resolve(ready);
      }
      const fail = () => finish(false);
      const ready = () => { if (!audio.seeking && audio.readyState >= 3) finish(true); };
      const listeners = {
        loadedmetadata: () => {
          try {
            audio.currentTime = Math.min(change.position, Number.isFinite(audio.duration) ? audio.duration : Infinity);
          } catch { fail(); }
        },
        canplay: ready,
        seeked: ready,
        error: fail,
      };
      if (signal.aborted) return fail();
      Object.entries(listeners).forEach(([event, listener]) => audio.addEventListener(event, listener));
      signal.addEventListener('abort', fail, { once: true });
      try {
        audio.pause();
        audio.src = src;
        audio.load();
      } catch { fail(); }
    });
  }

  function switchSource(resolveSource) {
    const selection = active;
    if (!selection?.ready || selection.sourceChange || !audio.src) return Promise.resolve('canceled');
    const change = { controller: new AbortController(), reloading: false, preload: audio.preload };
    selection.sourceChange = change;
    const previous = audio.src;
    const isCurrent = () => active === selection && !change.controller.signal.aborted;
    async function trySource(src) {
      if (!await waitForSource(src, change) || !isCurrent()) return false;
      if (selection.wantsPlayback) {
        try { await audio.play(); }
        catch (error) {
          if (isCurrent() && error?.name === 'AbortError' && !selection.wantsPlayback) return true;
          return false;
        }
      }
      return isCurrent();
    }
    async function run() {
      let result = 'restored';
      try {
        let src;
        try { src = await resolveSource(selection.entry.track); } catch { /* Keep the compatible source. */ }
        if (!isCurrent()) return 'canceled';
        if (!src || src === previous) return result;
        const snapshot = getState();
        change.position = snapshot.currentTime;
        change.duration = snapshot.duration;
        selection.priorPlayed = mergePlayedRanges(selection.priorPlayed ?? [], audio.played);
        selection.playRequest++;
        change.reloading = true;
        audio.preload = 'auto';
        if (await trySource(src)) result = 'changed';
        else if (isCurrent() && !await trySource(previous)) result = 'failed';
        return isCurrent() ? result : 'canceled';
      } finally {
        if (isCurrent()) {
          selection.sourceChange = undefined;
          if (change.reloading) audio.preload = change.preload;
          if (result === 'failed') {
            reportFailure(selection, new Error('Could not reload the previous audio source.'));
          } else {
            markPlaying();
            notify();
          }
        }
      }
    }
    change.loading = run();
    return change.loading;
  }

  function reportFailure(selection, error) {
    if (active !== selection || selection.failureReported) return false;
    if (selection.preloaded && !selection.started) {
      return select(selection.entry, selection.wantsPlayback, false, selection.initialPosition);
    }
    stopPlayback();
    const wantsPlayback = selection.wantsPlayback;
    selection.wantsPlayback = false;
    selection.failureReported = true;
    onError(error, selection.entry.track, { wantsPlayback,
      retry: () => active === selection && selection.failureReported ? select(selection.entry, true, true, selection.initialPosition) : false });
    notify();
    return false;
  }

  function startMedia(selection) {
    if (active !== selection || !selection.wantsPlayback || !selection.ready) {
      return Promise.resolve(false);
    }
    selection.failureReported = false;
    const request = ++selection.playRequest;
    try {
      return Promise.resolve(audio.play()).then(
        () => active === selection && selection.wantsPlayback,
        error => selection.playRequest === request && error?.name !== 'AbortError' ? reportFailure(selection, error) : false,
      );
    } catch (error) {
      return Promise.resolve(reportFailure(selection, error));
    }
  }

  function select(entry, autoplay, usePreload = true, initialPosition) {
    if (!entry) return Promise.resolve(false);
    if (!usePreload) preloader?.clear();
    const prefetched = usePreload ? preloader?.take(entry.track) : undefined;
    stopPlayback();
    cancelSourceChange();
    active = null;
    stopMedia();
    const selection = {
      entry,
      wantsPlayback: autoplay,
      ready: false,
      started: false,
      completed: false,
      playbackStopped: false,
      playbackToken: Symbol(),
      failureReported: false,
      playRequest: 0,
      loading: null,
      preloaded: Boolean(prefetched),
      initialPosition,
    };
    active = selection;
    notify();

    function setSource(resolved) {
      if (active !== selection) return false;
      const src = typeof resolved === 'string' ? resolved : resolved?.src;
      if (!src) throw new Error('No playable source is available for this track.');
      audio.src = src;
      if (initialPosition !== undefined) audio.currentTime = initialPosition;
      selection.ready = true;
      notify();
      return selection.wantsPlayback ? startMedia(selection) : true;
    }

    const fail = error => reportFailure(selection, error);

    try {
      if (prefetched instanceof Blob) preloadedUrl = URL.createObjectURL(prefetched);
      const resolved = preloadedUrl || prefetched || resolveTrack(entry.track);
      selection.loading = resolved && typeof resolved.then === 'function'
        ? Promise.resolve(resolved).then(setSource).catch(fail)
        : Promise.resolve(setSource(resolved));
    } catch (error) {
      selection.loading = Promise.resolve(fail(error));
    }
    return selection.loading;
  }

  function clear() {
    stopPlayback();
    cancelSourceChange();
    queue = [];
    active = null;
    resetShuffle();
    preloader?.clear();
    stopMedia();
    notify();
  }

  function load(tracks, index = 0, autoplay = true, session) {
    const entries = Array.from(tracks, (track, position) => ({ track, playlistContext: session?.playlistContexts?.[position] }));
    if (!entries.length) {
      clear();
      return Promise.resolve(false);
    }
    queue = entries;
    const entry = queue[index] ?? queue[0];
    resetShuffle(entry);
    restoreShuffle(entry, session);
    const position = Number.isFinite(session?.position) && session.position >= 0 ? session.position : undefined;
    return select(entry, autoplay, true, position);
  }

  function play(index = queue.indexOf(active?.entry)) {
    const entry = queue[index];
    if (!entry) return Promise.resolve(false);
    if (entry !== active?.entry) {
      if (shuffled) selectShuffleEntry(entry);
      else resetShuffle(entry);
      return select(entry, true);
    }
    if (active.failureReported && (!active.ready || audio.error)) {
      return select(entry, true);
    }
    active.wantsPlayback = true;
    if (active.sourceChange?.reloading) {
      const selection = active;
      return selection.sourceChange.loading.then(() => active === selection && getState().playing);
    }
    if (!active.ready) return active.loading;
    if (active.completed || active.playbackStopped) {
      const position = audio.ended ? 0 : audio.currentTime;
      active.completed = false;
      active.started = false;
      active.playbackStopped = false;
      active.playbackToken = Symbol();
      active.priorPlayed = undefined;
      // The element retains its played ranges when replaying an ended source. Reset them for this play.
      audio.load();
      if (Number.isFinite(position)) audio.currentTime = position;
    }
    if (audio.ended) audio.currentTime = 0;
    return startMedia(active);
  }

  function toggle() {
    if (!active) return play(0);
    if (active.wantsPlayback && !audio.ended) {
      pause();
      return Promise.resolve(false);
    }
    return play();
  }

  function pause() {
    if (!active) return;
    active.wantsPlayback = false;
    active.playRequest++;
    audio.pause();
    notify();
  }

  function next(automatic = false) {
    if (!active) return play(0);
    if (automatic && repeatMode === 'one') return select(active.entry, true);

    let entry;
    if (shuffled) {
      entry = nextShuffleEntry();
    } else entry = nextCandidate();
    if (entry) return select(entry, true);
    if (automatic) active.wantsPlayback = false;
    notify();
    return Promise.resolve(false);
  }

  function previous() {
    if (!active) return Promise.resolve(false);
    if (active.ready && audio.currentTime > 3) {
      seek(0);
      return Promise.resolve(true);
    }

    let entry;
    if (shuffled) {
      if (shufflePosition > 0) entry = shufflePath[--shufflePosition];
    } else {
      entry = queue[queue.indexOf(active.entry) - 1];
      if (!entry && repeatMode === 'all') entry = queue.at(-1);
    }
    if (entry) return select(entry, true);
    seek(0);
    return Promise.resolve(false);
  }

  function seek(seconds) {
    if (!active?.ready || !Number.isFinite(seconds)) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : Infinity;
    const change = active.sourceChange?.reloading ? active.sourceChange : undefined;
    const position = Math.min(change?.duration || duration, Math.max(0, seconds));
    if (change) change.position = position;
    if (!change || audio.readyState >= 1) audio.currentTime = position;
    notify();
  }

  function volume(level) {
    if (!Number.isFinite(level)) return;
    audio.volume = Math.min(1, Math.max(0, level));
    notify();
  }

  function shuffle(enabled = !shuffled) {
    if (shuffled !== Boolean(enabled)) {
      shuffled = Boolean(enabled);
      resetShuffle();
    }
    notify();
    return shuffled;
  }

  function repeat(mode = repeatModes[(repeatModes.indexOf(repeatMode) + 1) % repeatModes.length]) {
    if (repeatModes.includes(mode) && mode !== repeatMode) {
      repeatMode = mode;
      plannedShuffleEntry = undefined;
    }
    notify();
    return repeatMode;
  }

  function enqueue(track, nextUp = false) {
    if (!track) return;
    const entry = {track};
    if (plannedShuffleEntry && shuffleVisited.has(plannedShuffleEntry)) plannedShuffleEntry = undefined;
    if (!active) {
      queue.push(entry);
      resetShuffle(entry);
      return select(entry, false);
    }
    if (nextUp) {
      queue.splice(queue.indexOf(active.entry) + 1, 0, entry);
      if (shuffled) shuffleNext.unshift(entry);
    } else {
      queue.push(entry);
    }
    notify();
  }

  function remove(index) {
    if (!Number.isInteger(index) || !queue[index]) return;
    const [entry] = queue.splice(index, 1);
    if (shuffled) removeShuffleEntry(entry);
    if (entry !== active?.entry) {
      notify();
      return;
    }
    if (!queue.length) {
      clear();
      return;
    }
    const replacement = queue[Math.min(index, queue.length - 1)];
    if (shuffled) selectShuffleEntry(replacement);
    else resetShuffle(replacement);
    return select(replacement, active.wantsPlayback);
  }

  function move(from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || !queue[from] || !queue[to] || from === to) return;
    const [entry] = queue.splice(from, 1);
    queue.splice(to, 0, entry);
    notify();
  }

  for (const type of ['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'volumechange']) {
    audio.addEventListener(type, () => notify());
  }
  audio.addEventListener('seeked', () => notify('seek'));
  audio.addEventListener('pause', () => {
    if (active?.ready && !active.sourceChange?.reloading && audio.paused && !audio.ended) active.wantsPlayback = false;
    notify();
  });
  function markPlaying() {
    if (active?.ready && !active.sourceChange?.reloading && !audio.paused) {
      active.wantsPlayback = true;
      if (!active.started) {
        active.started = true;
        onPlay(active.entry.track, active.entry.playlistContext);
      }
    }
  }
  audio.addEventListener('playing', () => {
    markPlaying();
    notify();
  });
  audio.addEventListener('ended', () => {
    if (!active?.ready || active.sourceChange?.reloading || !active.started || !audio.ended || active.completed) return;
    stopPlayback();
    active.completed = true;
    if (onEnded(active.entry.track) === false) {
      active.wantsPlayback = false;
      notify();
    } else void next(true);
  });
  audio.addEventListener('error', () => {
    if (!active?.ready || active.sourceChange?.reloading || !audio.error) return;
    void reportFailure(active, new Error(audio.error.message || 'The browser could not load this audio file.'));
  });

  function playlistQueueSnapshot() {
    const contexts = queue.map(entry => entry.playlistContext);
    return contexts.some(Boolean) ? contexts : undefined;
  }

  return {getState, shuffleSnapshot, playlistQueueSnapshot, load, play, pause, toggle, next, previous, seek, volume, shuffle, repeat, enqueue, remove, move, clear, switchSource};
}
