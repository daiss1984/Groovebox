const intervalMs = 10_000;

export function createPlaybackCheckins({ resolveEndpoint, send, now = () => performance.now(), makeId = () => crypto.randomUUID() }) {
  let enabled = false;
  let current;
  let sending = false;
  const pending = [];

  async function flush() {
    if (sending) return;
    sending = true;
    try {
      while (pending.length) {
        const { session, payload } = pending.shift();
        if (session.failed) continue;
        try { await send(session.endpoint, payload); }
        catch { if (payload.event === 'start') session.failed = true; }
      }
    } finally { sending = false; }
  }

  function enqueue(session, event, reason) {
    if (session.failed) return;
    const payload = { event, playSessionId: session.id, positionSeconds: session.position,
      paused: session.paused, ...(reason && { reason }) };
    const queued = { session, payload };
    const last = pending.at(-1);
    if (event === 'progress' && last?.session === session && last.payload.event === 'progress') pending[pending.length - 1] = queued;
    else pending.push(queued);
    void flush();
  }

  function stop() {
    if (!current) return;
    const session = current;
    current = undefined;
    enqueue(session, 'stop');
  }

  function setEnabled(value) {
    enabled = value === true;
    if (!enabled) stop();
  }

  function update({ track, playing, currentTime }, { token, reason }) {
    if (current?.token !== token) stop();
    const position = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
    if (current) {
      current.position = position;
      if (reason === 'stop') {
        current.paused = !playing;
        stop();
        return;
      }
      const stateChanged = current.paused === playing;
      current.paused = !playing;
      if (!stateChanged && reason !== 'seek' && (!playing || now() - current.lastSentAt < intervalMs)) return;
      current.lastSentAt = now();
      enqueue(current, 'progress', stateChanged ? (playing ? 'Unpause' : 'Pause') : 'TimeUpdate');
      return;
    }
    if (!enabled || reason === 'stop' || !playing) return;
    const endpoint = resolveEndpoint(track);
    if (!endpoint) return;
    current = { endpoint, token, id: makeId(), position, paused: false, lastSentAt: now(), failed: false };
    enqueue(current, 'start');
  }

  return { update, setEnabled, stop };
}
