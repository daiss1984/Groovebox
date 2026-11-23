export function createListenBrainzPlayback({ send, onError = () => {}, clock = Date.now, makeId = () => crypto.randomUUID() }) {
  let enabled = false;
  let selection;
  return {
    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled && selection) selection.eligible = false;
    },
    update({ track, duration }, { token }, played) {
      if (selection?.token !== token) {
        const eligible = enabled && track?.provider !== 'demo' && !track?.artistIsFallback && track?.artist && track.title;
        selection = { token, eligible, startedAt: Math.floor(clock() / 1000) };
      }
      if (!enabled || !selection?.eligible || !Number.isFinite(duration) || duration <= 0) return;
      let listened = 0;
      for (let i = 0; i < played.length; i++) listened += played.end(i) - played.start(i);
      if (listened < Math.min(duration / 2, 240)) return;
      selection.eligible = false;
      Promise.resolve(send({ id: makeId(), title: track.title, artist: track.artist, listenedAt: selection.startedAt,
        ...(track.album && !track.albumIsFallback && { album: track.album }) })).catch(onError);
    },
  };
}
