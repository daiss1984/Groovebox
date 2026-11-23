import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlaybackCheckins } from '../public/playback-checkins.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('reports opt-in starts, state changes, seeks, heartbeat and stop with matching sessions', async () => {
  let time = 0;
  let id = 0;
  const calls = [];
  const controller = createPlaybackCheckins({
    resolveEndpoint: track => track?.endpoint,
    send: async (endpoint, payload) => { calls.push({ endpoint, ...payload }); },
    now: () => time,
    makeId: () => String(++id),
  });
  const token = Symbol();
  const update = (playing, currentTime, reason = 'change') =>
    controller.update({ track: { endpoint: '/playback' }, playing, currentTime }, { token, reason });

  update(true, 1);
  assert.deepEqual(calls, []);
  controller.setEnabled(true);
  update(true, 2);
  await flush();
  time = 9999;
  update(true, 3);
  assert.equal(calls.length, 1);
  time = 10000;
  update(true, 4);
  await flush();
  update(false, 4);
  await flush();
  update(false, 9, 'seek');
  await flush();
  update(true, 9);
  await flush();
  controller.setEnabled(false);
  controller.stop();
  await flush();
  assert.deepEqual(calls.map(call => [
    call.endpoint, call.playSessionId, call.event, call.reason, call.positionSeconds, call.paused,
  ]), [
    ['/playback', '1', 'start', undefined, 2, false],
    ['/playback', '1', 'progress', 'TimeUpdate', 4, false],
    ['/playback', '1', 'progress', 'Pause', 4, true],
    ['/playback', '1', 'progress', 'TimeUpdate', 9, true],
    ['/playback', '1', 'progress', 'Unpause', 9, false],
    ['/playback', '1', 'stop', undefined, 9, false],
  ]);
});

test('keeps replacement sessions ordered behind a pending start and combines superseded progress', async () => {
  const calls = [];
  const firstPost = Promise.withResolvers();
  let id = 0;
  const controller = createPlaybackCheckins({
    resolveEndpoint: track => track.endpoint,
    send: (endpoint, payload) => {
      calls.push([endpoint, payload.event, payload.positionSeconds, payload.playSessionId]);
      return calls.length === 1 ? firstPost.promise : Promise.resolve();
    },
    makeId: () => String(++id),
  });
  const firstToken = Symbol();
  controller.setEnabled(true);
  const play = (token, endpoint, position, reason = 'change') =>
    controller.update({ track: { endpoint }, playing: true, currentTime: position }, { token, reason });
  play(firstToken, '/first', 0);
  play(firstToken, '/first', 3, 'seek');
  play(firstToken, '/first', 7, 'seek');
  play(Symbol(), '/second', 0);
  assert.deepEqual(calls, [['/first', 'start', 0, '1']]);
  firstPost.resolve();
  await flush();
  assert.deepEqual(calls, [
    ['/first', 'start', 0, '1'],
    ['/first', 'progress', 7, '1'],
    ['/first', 'stop', 7, '1'],
    ['/second', 'start', 0, '2'],
  ]);
});

test('skips pending progress and stops when sending the corresponding start fails', async () => {
  const calls = [];
  const controller = createPlaybackCheckins({
    resolveEndpoint: track => track.endpoint,
    send: async (endpoint, payload) => {
      calls.push([endpoint, payload.event]);
      if (endpoint === '/unavailable') throw new Error('Unavailable');
    },
    makeId: () => 'test-session',
  });
  const token = Symbol();
  controller.setEnabled(true);
  const update = (endpoint, token, reason) =>
    controller.update({ track: { endpoint }, playing: true, currentTime: 10 }, { token, reason });
  update('/unavailable', token, 'change');
  update('/unavailable', token, 'seek');
  update('/available', Symbol(), 'change');
  await flush();
  assert.deepEqual(calls, [['/unavailable', 'start'], ['/available', 'start']]);
});
