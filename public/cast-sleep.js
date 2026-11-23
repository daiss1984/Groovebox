export async function applyCastSleepDeadline({ finishTrack, getPosition, pause, isCurrent }) {
  if (!isCurrent()) return 'changed';
  if (finishTrack) {
    const { state } = await getPosition();
    if (!isCurrent()) return 'changed';
    if (state === 'PLAYING' || state === 'TRANSITIONING') return 'finishing';
    if (['STOPPED', 'NO_MEDIA_PRESENT', 'PAUSED_PLAYBACK'].includes(state)) return 'finished';
  }
  const paused = await pause();
  if (!isCurrent()) return 'changed';
  return paused ? 'paused' : 'retry';
}
