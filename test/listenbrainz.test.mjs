import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createListenBrainzPlayback } from '../public/listenbrainz-playback.js';
import { createListenBrainzHandler } from '../server/listenbrainz.mjs';

const now = 1_750_000_000_000;
const token = '2096b883-ad81-4af5-b892-a42a9e009b40';
const listen = { id: '0fa9ef1d-1c03-4da1-9b88-65fa9bd5cdb6', title: 'Fixture track', artist: 'Fixture artist',
  album: 'Fixture album', listenedAt: Math.floor(now / 1000) };

test('keeps ListenBrainz tokens server-side and posts one scoped listen for the consenting browser', async t => {
  const upstream = [];
  let expired = false;
  const handler = createListenBrainzHandler({ clock: () => now, fetchImpl: async (url, options) => {
    assert.ok(url.startsWith('https://api.listenbrainz.org/1/'));
    assert.equal(options.redirect, 'error');
    upstream.push({ path: new URL(url).pathname, auth: options.headers.Authorization, body: options.body && JSON.parse(options.body) });
    if (url.endsWith('validate-token')) return Response.json(options.headers.Authorization === 'Token ' + token
      ? { valid: true, user_name: 'fixture-account' } : { valid: false });
    return Response.json({ status: expired ? 'unauthorized' : 'ok' }, { status: expired ? 401 : 200 });
  } });
  const server = createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://localhost'))) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const send = (action, { method = 'GET', body, cookie, from = origin } = {}) => fetch(origin + '/api/listenbrainz/' + action, {
    method, headers: { ...(method !== 'GET' && { Origin: from }), ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  assert.deepEqual(await (await send('status')).json(), { account: null });
  assert.equal((await send('connect', { method: 'POST', body: { token }, from: 'https://elsewhere.invalid' })).status, 403);
  assert.equal((await send('listen', { method: 'POST', body: listen })).status, 401);
  assert.deepEqual(upstream, []);
  const invalid = await send('connect', { method: 'POST', body: { token: '00000000-0000-4000-8000-000000000000' } });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get('set-cookie'), null);
  const connected = await send('connect', { method: 'POST', body: { token } });
  assert.equal(connected.status, 200);
  const header = connected.headers.get('set-cookie');
  assert.match(header, /Path=\/api\/listenbrainz\/; HttpOnly; SameSite=Strict/);
  assert.ok(!header.includes(token));
  const cookie = header.split(';')[0];
  assert.deepEqual(await connected.json(), { account: 'fixture-account' });
  assert.deepEqual(await (await send('status', { cookie })).json(), { account: 'fixture-account' });
  assert.deepEqual(await (await send('status')).json(), { account: null });
  assert.equal((await send('listen', { method: 'POST', cookie, body: { ...listen, title: '' } })).status, 400);
  assert.equal((await send('listen', { method: 'POST', cookie, body: { ...listen, listenedAt: 1 } })).status, 400);
  const valid = { method: 'POST', cookie, body: { ...listen, url: 'http://private.example/audio' } };
  assert.deepEqual(await (await send('listen', valid)).json(), { submitted: true });
  assert.equal((await send('listen', valid)).status, 200);
  assert.equal(upstream.length, 3);
  assert.deepEqual(upstream.at(-1), { path: '/1/submit-listens', auth: 'Token ' + token, body: { listen_type: 'single', payload: [{
    listened_at: listen.listenedAt, track_metadata: { track_name: listen.title, artist_name: listen.artist, release_name: listen.album,
      additional_info: { submission_client: 'Groovebox' } },
  }] } });
  const disconnected = await send('disconnect', { method: 'DELETE', cookie });
  assert.equal(disconnected.status, 200);
  assert.match(disconnected.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await send('listen', valid)).status, 401);
  const reconnected = await send('connect', { method: 'POST', body: { token } });
  const newCookie = reconnected.headers.get('set-cookie').split(';')[0];
  expired = true;
  const revoked = await send('listen', { ...valid, cookie: newCookie });
  assert.equal(revoked.status, 401);
  assert.deepEqual(await (await send('status', { cookie: newCookie })).json(), { account: null });
});

test('reports only active new playback after half the track or four minutes of actual coverage', () => {
  const events = [];
  const reporter = createListenBrainzPlayback({ send: payload => events.push(payload), clock: () => now, makeId: () => listen.id });
  const track = { title: listen.title, artist: listen.artist, album: listen.album };
  const update = (token, duration, spans, current = track) => reporter.update({ track: current, duration }, { token }, {
    length: spans.length, start: index => spans[index][0], end: index => spans[index][1],
  });
  const existing = Symbol();
  update(existing, 100, [[0, 49]]);
  reporter.setEnabled(true);
  update(existing, 100, [[0, 95]]);
  const playing = Symbol();
  update(playing, 100, [[0, 10], [95, 100]]);
  assert.deepEqual(events, []);
  update(playing, 100, [[0, 40], [90, 100]]);
  update(playing, 100, [[0, 100]]);
  assert.deepEqual(events, [listen]);
  const long = Symbol();
  update(long, 900, [[0, 239]]);
  assert.equal(events.length, 1);
  update(long, 900, [[0, 240]]);
  update(Symbol(), 100, [[0, 100]], { ...track, provider: 'demo' });
  update(Symbol(), 100, [[0, 100]], { ...track, artistIsFallback: true });
  const pausedByDisconnect = Symbol();
  update(pausedByDisconnect, 100, [[0, 49]]);
  reporter.setEnabled(false);
  reporter.setEnabled(true);
  update(pausedByDisconnect, 100, [[0, 100]]);
  assert.deepEqual(events, [listen, listen]);
});
