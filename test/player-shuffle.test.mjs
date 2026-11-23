import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayer } from '../public/player.js';

class AudioFixture extends EventTarget {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = 60;
  volume = 1;

  load() {
    this.currentTime = 0;
    this.ended = false;
  }

  pause() {
    this.paused = true;
  }

  removeAttribute() {
    this.src = '';
  }

  async play() {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event('playing'));
  }

  end() {
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}

function timeRanges(ranges = []) {
  return { length: ranges.length, start: index => ranges[index][0], end: index => ranges[index][1] };
}

class SwitchingAudioFixture extends AudioFixture {
  preload = 'metadata';
  readyState = 0;
  played = timeRanges();

  load() {
    super.load();
    this.error = undefined;
    this.readyState = 0;
    this.played = timeRanges();
    const source = this.src;
    queueMicrotask(() => {
      if (!source || source !== this.src || source === '/pending') return;
      if (source === '/unavailable') {
        this.error = new Error('The source cannot play');
        this.dispatchEvent(new Event('error'));
        return;
      }
      this.readyState = 3;
      this.dispatchEvent(new Event('loadedmetadata'));
      this.dispatchEvent(new Event('canplay'));
    });
  }
}

const track = id => ({ id, src: '/' + id });
const current = player => player.getState().track.id;
const queue = player => player.getState().queue.map(entry => entry.id);

test('switches the active source without restarting the playback session or losing played ranges', async () => {
  const audio = new SwitchingAudioFixture();
  const updates = [];
  const starts = [];
  const player = createPlayer(audio, {
    onPlay: item => starts.push(item.id),
    onPlaybackChange(snapshot, event, played) {
      const ranges = Array.from({ length: played.length }, (_, index) => [played.start(index), played.end(index)]);
      updates.push({ snapshot, event, ranges });
    },
  });
  player.shuffle(true);
  await player.load(['A', 'B', 'A'].map(track), 2);
  player.enqueue(track('C'), true);
  const shuffle = player.shuffleSnapshot();
  const token = updates.at(-1).event.token;
  audio.currentTime = 8;
  audio.played = timeRanges([[0, 8]]);

  assert.equal(await player.switchSource(() => '/original'), 'changed');
  assert.equal(player.getState().index, 2);
  assert.equal(player.getState().currentTime, 8);
  assert.equal(player.getState().playing, true);
  assert.equal(audio.preload, 'metadata');
  assert.deepEqual(queue(player), ['A', 'B', 'A', 'C']);
  assert.deepEqual(player.shuffleSnapshot(), shuffle);
  assert.deepEqual(starts, ['A']);

  audio.played = timeRanges([[7, 12]]);
  audio.dispatchEvent(new Event('timeupdate'));
  assert.ok(updates.every(({ event }) => event.token === token && event.reason !== 'stop'));
  assert.deepEqual(updates.at(-1).ranges, [[0, 12]]);
  await player.next();
  assert.equal(current(player), 'C');
});

test('restores a failed source while paused and ignores a source resolved after switching tracks', async () => {
  const audio = new SwitchingAudioFixture();
  const onError = () => assert.fail('A recovered source should not report a playback error');
  const player = createPlayer(audio, { onError });
  await player.load(['A', 'B'].map(track));
  player.pause();
  audio.currentTime = 11;
  assert.equal(await player.switchSource(() => '/unavailable'), 'restored');
  assert.equal(audio.src, '/A');
  assert.equal(player.getState().currentTime, 11);
  assert.equal(player.getState().playing, false);

  const candidate = Promise.withResolvers();
  const switching = player.switchSource(() => candidate.promise);
  await player.next();
  candidate.resolve('/late');
  assert.equal(await switching, 'canceled');
  assert.equal(audio.src, '/B');
  assert.equal(current(player), 'B');
  assert.equal(player.getState().playing, true);

  const loading = player.switchSource(() => '/pending');
  await Promise.resolve();
  assert.equal(audio.src, '/pending');
  await player.play(0);
  assert.equal(await loading, 'canceled');
  assert.equal(audio.src, '/A');
  assert.equal(audio.preload, 'metadata');
});

test('preloads the same shuffled entry that Next plays and lets play-next replace a pending candidate', async t => {
  t.mock.method(Math, 'random', () => .99);
  const audio = new AudioFixture();
  const prepared = [];
  const taken = [];
  const player = createPlayer(audio, { preloader: {
    prepare(entry) { if (entry) prepared.push(entry.id); },
    take(entry) { taken.push(entry.id); },
    clear() {},
  } });
  player.shuffle(true);
  await player.load(['A', 'B', 'C'].map(track));
  assert.equal(prepared.at(-1), 'C');
  await player.next();
  assert.equal(current(player), 'C');
  assert.equal(taken.at(-1), 'C');
  assert.equal(prepared.at(-1), 'B');
  player.enqueue(track('D'), true);
  assert.equal(prepared.at(-1), 'D');
  await player.next();
  assert.equal(current(player), 'D');
  assert.equal(taken.at(-1), 'D');
  assert.equal(prepared.at(-1), 'B');
});

test('retries the same track through its usual source when the prefetched media cannot play', async () => {
  const audio = new AudioFixture();
  const attempts = [];
  const play = audio.play.bind(audio);
  audio.play = async () => {
    attempts.push(audio.src);
    if (audio.src.startsWith('blob:')) throw new DOMException('unsupported fixture', 'NotSupportedError');
    return play();
  };
  const player = createPlayer(audio, { preloader: {
    prepare() {}, take(entry) { if (entry.id === 'B') return new Blob(['fixture']); }, clear() {},
  } });
  await player.load(['A', 'B'].map(track));
  assert.equal(await player.next(), true);
  assert.equal(current(player), 'B');
  assert.equal(attempts[0], '/A');
  assert.match(attempts[1], /^blob:/);
  assert.equal(attempts[2], '/B');
});

async function fixture(t, ids, repeatMode = 'all', random = () => 0) {
  t.mock.method(Math, 'random', random);
  const audio = new AudioFixture();
  const player = createPlayer(audio);
  player.shuffle(true);
  player.repeat(repeatMode);
  await player.load(ids.map(track));
  return { audio, player };
}

test('visits every queue position in repeat-all cycles and goes back across a cycle boundary', async t => {
  const { player } = await fixture(t, ['A', 'B', 'C']);
  assert.equal(current(player), 'A');
  await player.next();
  assert.equal(current(player), 'B');
  await player.next();
  assert.equal(current(player), 'C');
  await player.next();
  assert.equal(current(player), 'A');

  await player.previous();
  assert.equal(current(player), 'C');
  await player.previous();
  assert.equal(current(player), 'B');
  await player.next();
  assert.equal(current(player), 'C');
  await player.next();
  assert.equal(current(player), 'A');
  await player.next();
  assert.equal(current(player), 'B');
  await player.next();
  assert.equal(current(player), 'C');
  assert.deepEqual(queue(player), ['A', 'B', 'C']);
});

test('honors explicit play-next entries while retaining forward shuffle history', async t => {
  const { player } = await fixture(t, ['A', 'B', 'C'], 'off');
  await player.next();
  await player.next();
  assert.equal(current(player), 'C');
  await player.previous();
  assert.equal(current(player), 'B');
  player.enqueue(track('Y'), true);
  player.enqueue(track('X'), true);
  assert.deepEqual(queue(player), ['A', 'B', 'X', 'Y', 'C']);
  await player.next();
  assert.equal(current(player), 'X');
  await player.next();
  assert.equal(current(player), 'Y');
  await player.next();
  assert.equal(current(player), 'C');
  await player.previous();
  assert.equal(current(player), 'Y');
  await player.previous();
  assert.equal(current(player), 'X');
  await player.next();
  await player.next();
  assert.equal(current(player), 'C');
  player.enqueue(track('E'));
  await player.next();
  assert.equal(current(player), 'E');
  assert.equal(await player.next(), false);
});

test('prefers a different song between cycles when the last track is queued more than once', async t => {
  const { player } = await fixture(t, ['A', 'B', 'A']);
  await player.next();
  await player.next();
  assert.equal(player.getState().index, 2);
  await player.next();
  assert.equal(current(player), 'B');
  await player.previous();
  assert.equal(player.getState().index, 2);
});

test('does not resurrect removed entries and respects actual history after queue reorder', async t => {
  const { player } = await fixture(t, ['A', 'B', 'C']);
  for (let index = 0; index < 4; index++) await player.next();
  assert.equal(current(player), 'B');
  player.remove(2);
  player.move(1, 0);
  assert.deepEqual(queue(player), ['B', 'A']);
  await player.previous();
  assert.equal(current(player), 'A');
  await player.previous();
  assert.equal(current(player), 'B');
  await player.previous();
  assert.equal(current(player), 'A');
  await player.next();
  assert.equal(current(player), 'B');
});

test('retains prior visits when a track is selected directly or removed while active', async t => {
  const { player } = await fixture(t, ['A', 'B', 'C', 'D'], 'off');
  await player.next();
  assert.equal(current(player), 'B');
  await player.play(2);
  assert.equal(current(player), 'C');
  await player.remove(2);
  assert.equal(current(player), 'D');
  await player.previous();
  assert.equal(current(player), 'B');
  await player.previous();
  assert.equal(current(player), 'A');
  assert.deepEqual(queue(player), ['A', 'B', 'D']);
});

test('allows manual next in repeat-one and does not duplicate automatic repeats in history', async t => {
  const { player, audio } = await fixture(t, ['A', 'B'], 'one');
  audio.end();
  assert.equal(current(player), 'A');
  await player.next();
  assert.equal(current(player), 'B');
  audio.end();
  assert.equal(current(player), 'B');
  await player.previous();
  assert.equal(current(player), 'A');
  await player.next();
  assert.equal(current(player), 'B');
  assert.equal(await player.next(), false);
});

test('repeat-all works with duplicate queue entries and caps retained shuffle history', async t => {
  const { player } = await fixture(t, ['A']);
  for (let index = 0; index < 800; index++) await player.next();
  let visited = 0;
  while (await player.previous()) {
    visited++;
    assert.equal(current(player), 'A');
    assert.ok(visited < 800);
  }
  assert.ok(visited >= 128, 'keeps a substantial back history without unbounded growth');

  const duplicate = track('A');
  await player.load([duplicate, duplicate]);
  assert.equal(player.getState().index, 0);
  await player.next();
  assert.equal(player.getState().index, 1);
  await player.next();
  assert.equal(player.getState().index, 0);
});

test('restores the exact occurrence, skips missing entries and retains the pending next-up override', async t => {
  const { player } = await fixture(t, ['A', 'B', 'A', 'C'], 'off');
  await player.next();
  await player.next();
  await player.next();
  await player.previous();
  player.enqueue(track('Y'), true);
  await player.move(2, 1);
  const snapshot = player.shuffleSnapshot();
  const kept = player.getState().queue.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.id !== 'B');
  const reloaded = createPlayer(new AudioFixture());
  reloaded.shuffle(true);
  await reloaded.load(kept.map(item => item.entry), 1, false, { shuffle: snapshot, offsets: kept.map(item => item.index) });
  assert.equal(reloaded.getState().index, 1);
  await reloaded.previous();
  assert.equal(reloaded.getState().index, 0);
  await reloaded.next();
  assert.equal(current(reloaded), 'Y');
  await reloaded.next();
  assert.equal(reloaded.getState().index, 1);
  await reloaded.next();
  assert.equal(current(reloaded), 'C');
  assert.equal(await reloaded.next(), false);
});

test('a later audio retry cannot replace a different selected queue entry', async () => {
  const audio = new AudioFixture();
  let retry;
  const player = createPlayer(audio, { onError(_error, _track, failure) { retry = failure.retry; } });
  const repeated = track('A');
  await player.load([repeated, repeated, track('B')], 1);
  audio.error = { code: 4 };
  audio.dispatchEvent(new Event('error'));
  const firstRetry = retry;
  delete audio.error;
  assert.equal(await firstRetry(), true);
  assert.equal(player.getState().index, 1);
  assert.equal(await firstRetry(), false);

  audio.error = { code: 4 };
  audio.dispatchEvent(new Event('error'));
  delete audio.error;
  await player.play(0);
  assert.equal(await retry(), false);
  assert.equal(player.getState().index, 0);
});

test('reports actual ends once per play, including manual replay and repeat-one', async () => {
  const audio = new AudioFixture();
  const completed = [];
  const player = createPlayer(audio, { onEnded: selected => completed.push(selected.id) });
  await player.load([track('A'), track('B')]);
  await player.next();
  assert.deepEqual(completed, []);
  audio.end();
  audio.dispatchEvent(new Event('ended'));
  assert.deepEqual(completed, ['B']);
  await player.play();
  audio.end();
  assert.deepEqual(completed, ['B', 'B']);
  player.repeat('one');
  await player.play();
  audio.end();
  audio.end();
  assert.deepEqual(completed, ['B', 'B', 'B', 'B']);
  assert.equal(current(player), 'B');
});
