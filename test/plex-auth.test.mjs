import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createSourcesHandler } from '../server/sources.mjs';

test('Plex hosted sign-in scopes its ticket and credentials and preserves existing sources', async t => {
  const accountToken = 'fixture-account-token';
  const serverToken = 'fixture-server-token';
  const priorToken = 'fixture-prior-token';
  const pms = 'http://verified-pms.invalid:32400';
  const prior = 'http://prior-pms.invalid:32400';
  const calls = [];
  let clientId;
  let pinStatus = 'pending';
  const handler = createSourcesHandler({ fetchImpl: async (endpoint, options) => {
    const url = new URL(endpoint);
    const { headers, method } = options;
    const path = url.origin + url.pathname;
    calls.push(path);
    if (path === 'https://plex.tv/api/v2/pins') {
      assert.equal(method, 'POST');
      assert.equal(url.searchParams.get('strong'), 'true');
      clientId = headers['X-Plex-Client-Identifier'];
      assert.match(clientId, /^[\w-]{36}$/);
      assert.equal(options.redirect, 'error');
      return Response.json({ id: 176, code: 'fixture1234', expiresIn: 500 });
    }
    if (path === 'https://plex.tv/api/v2/pins/176') {
      assert.equal(headers['X-Plex-Client-Identifier'], clientId);
      return Response.json({ authToken: pinStatus === 'authorized' ? accountToken : null });
    }
    if (path === 'https://clients.plex.tv/api/v2/resources') {
      assert.equal(headers['X-Plex-Client-Identifier'], clientId);
      assert.equal(headers['X-Plex-Token'], accountToken);
      assert.equal(options.redirect, 'error');
      return Response.json([
        { name: 'Verified', provides: 'server', accessToken: serverToken, connections: [
          { uri: 'https://secure-pms.invalid:32400' }, { uri: pms },
          { uri: 'https://alice:pass@untrusted.invalid/' }, { uri: 'https://untrusted.invalid/?token=offsite' },
        ] },
        { name: 'Unusable', provides: 'device', accessToken: 'device-token', connections: [{ uri: 'https://console.invalid' }] },
      ]);
    }
    if (path === prior + '/library/sections') {
      assert.equal(headers['X-Plex-Token'], priorToken);
      return Response.json({ MediaContainer: { Directory: [] } });
    }
    assert.equal(path, pms + '/library/sections');
    assert.equal(headers['X-Plex-Token'], serverToken);
    assert.equal(headers['X-Plex-Client-Identifier'], clientId);
    return Response.json({ MediaContainer: { Directory: [{ type: 'artist', key: '1', title: 'Private Music' }] } });
  } });
  let origin;
  const server = createServer((req, res) => {
    handler(req, res, new URL(req.url, origin)).then(handled => { if (!handled) res.writeHead(404).end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const send = (path, { body, cookie, sendOrigin = origin } = {}) => fetch(origin + path, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: sendOrigin, ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const api = '/api/sources/plex-auth/';
  const initial = await send('/api/sources', { body: { type: 'plex', url: prior, token: priorToken, name: 'Prior' } });
  assert.equal(initial.status, 201);
  const priorCookieHeader = initial.headers.get('set-cookie');
  assert.match(priorCookieHeader, /HttpOnly; SameSite=Strict/);
  const priorCookie = priorCookieHeader.split(';')[0];
  assert.equal((await send(api + 'start', { sendOrigin: 'https://outside.invalid', body: {} })).status, 403);
  const started = await send(api + 'start', { cookie: priorCookie, body: { url: pms, name: 'Verified Music' } });
  assert.equal(started.status, 200);
  const ticketHeader = started.headers.get('set-cookie');
  assert.match(ticketHeader, /Path=\/api\/sources\/plex-auth; Max-Age=500; HttpOnly; SameSite=Lax/);
  const ticket = ticketHeader.split(';')[0];
  const login = new URL((await started.json()).authUrl);
  assert.equal(login.origin + login.pathname, 'https://app.plex.tv/auth');
  const query = new URLSearchParams(login.hash.slice(2));
  assert.equal(query.get('clientID'), clientId);
  assert.equal(query.get('code'), 'fixture1234');
  assert.equal(query.get('context[device][product]'), 'Groovebox');
  const callback = new URL(query.get('forwardUrl'));
  assert.equal(callback.origin, origin);
  assert.equal(callback.pathname, api + 'return');
  assert.equal((await send(api + 'choices', { cookie: ticket })).status, 403);
  assert.equal((await fetch(callback, { redirect: 'manual' })).status, 410);
  const wrong = new URL(callback);
  wrong.searchParams.set('state', 'wrong');
  assert.equal((await fetch(wrong, { redirect: 'manual', headers: { Cookie: ticket } })).status, 403);
  const returned = await fetch(callback, { redirect: 'manual', headers: { Cookie: ticket, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(returned.status, 303);
  assert.equal(returned.headers.get('location'), '/?plex=authorized#sources');
  assert.equal(returned.headers.get('set-cookie'), null);
  const cookies = priorCookie + '; ' + ticket;
  assert.equal((await send(api + 'choices', { cookie: cookies })).status, 401);
  pinStatus = 'authorized';
  const offered = await send(api + 'choices', { cookie: cookies });
  assert.equal(offered.status, 200);
  const body = await offered.text();
  assert.doesNotMatch(body, /fixture-|untrusted|console/);
  const { choices } = JSON.parse(body);
  assert.deepEqual(choices.map(({ name, url, preferred }) => [name, url, preferred]),
    [['Verified', pms + '/', true], ['Verified', 'https://secure-pms.invalid:32400/', false]]);
  const selection = { choice: choices[0].id, url: 'http://outside.invalid/', token: accountToken };
  assert.equal((await send(api + 'connect', { cookie: priorCookie, body: selection })).status, 410);
  assert.equal((await send(api + 'connect', { cookie: cookies, body: { choice: 'invalid' } })).status, 404);
  const connected = await send(api + 'connect', { cookie: cookies, body: selection });
  assert.equal(connected.status, 201);
  assert.match(connected.headers.get('set-cookie'), /^groovebox_plex_auth=;.*Max-Age=0/);
  const { source } = await connected.json();
  assert.deepEqual(Object.keys(source).sort(), ['id', 'name', 'type']);
  assert.equal(source.name, 'Verified Music');
  const list = await (await fetch(origin + '/api/sources', { headers: { Cookie: priorCookie } })).json();
  assert.deepEqual(list.sources.map(item => item.name), ['Prior', 'Verified Music']);
  assert.equal((await send(api + 'connect', { cookie: cookies, body: selection })).status, 410);
  assert.equal(calls.filter(call => call === pms + '/library/sections').length, 1);
});
