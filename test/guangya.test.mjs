import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createGuangyaHandler } from '../server/guangya.mjs';

const clientId = 'registered-app-for-fixture';
const apiOrigin = 'https://openapi.guangyapan.com';
const account = 'https://openapi-account.guangyapan.com/v1/auth/token';
const prefix = '/api/guangya';
const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
const songId = '9223372036854775807';
const folderId = '9223372036854775808';
const lyricId = '9223372036854775809';

async function fixture(t, upstream, { configured = true, sessionFile, sessionKey } = {}) {
  const failures = [];
  let handler;
  const server = createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://fixture.invalid'))) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const callback = origin + prefix + '/callback';
  function restart({ key = sessionKey, appId = clientId } = {}) {
    handler = createGuangyaHandler({
      sessionFile, sessionKey: key,
      env: configured ? { GUANGYA_CLIENT_ID: appId, GUANGYA_REDIRECT_URI: callback } : {},
      async request(url, init) {
        try {
          return await upstream(new URL(url), init);
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
    });
  }
  restart();
  return { origin, callback, restart, fetch: (path, options) => fetch(origin + prefix + path, { redirect: 'manual', ...options }) };
}

function bearer(access = 'access-initial', refresh = 'refresh-initial') {
  return Response.json({ token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 600 });
}

function response(data) {
  return Response.json({ code: 0, msg: 'success[0]', data });
}

async function begin(app) {
  const start = await app.fetch('/connect');
  assert.equal(start.status, 303);
  const cookie = start.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly; SameSite=Lax; Max-Age=600/);
  const target = new URL(start.headers.get('location'));
  assert.equal(target.origin, 'https://www.guangyapan.com');
  assert.equal(target.pathname, '/oauth/');
  assert.equal(target.searchParams.get('client_id'), clientId);
  assert.equal(target.searchParams.get('scope'), 'user offline');
  assert.equal(target.searchParams.get('response_type'), 'code');
  assert.equal(target.searchParams.get('redirect_uri'), app.callback);
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  const state = target.searchParams.get('state');
  const challenge = target.searchParams.get('code_challenge');
  assert.match(state, /^[\w-]{43}$/);
  assert.match(challenge, /^[\w-]{43}$/);
  return { cookie: cookie.split(';')[0], state, challenge };
}

async function finish(app, start, { code = 'test-authorization-code', state = start.state, cookie = start.cookie } = {}) {
  return app.fetch('/callback?' + new URLSearchParams({ code, state }), { headers: { Cookie: cookie } });
}

async function connect(app) {
  const start = await begin(app);
  const end = await finish(app, start);
  assert.equal(end.headers.get('location'), '/?guangya=connected');
  return { Cookie: end.headers.getSetCookie()[1].split(';')[0] };
}

test('Guangya is unconfigured without an app ID and registered callback', async t => {
  const app = await fixture(t, () => assert.fail('Must not call Guangya'), { configured: false });
  assert.deepEqual(await (await app.fetch('/status')).json(), { configured: false, connected: false });
  assert.equal((await app.fetch('/connect')).status, 503);
});

test('Guangya Web OAuth verifies state, browser, challenge and replay without a secret', async t => {
  let exchanges = 0;
  let start;
  const app = await fixture(t, (url, init) => {
    assert.equal(url.href, account);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-client-id'], clientId);
    assert.equal(init.redirect, 'error');
    const payload = JSON.parse(init.body);
    assert.deepEqual(Object.keys(payload).sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
    assert.equal(payload.client_id, clientId);
    assert.equal(payload.grant_type, 'authorization_code');
    assert.equal(payload.code, 'test-authorization-code');
    assert.equal(payload.redirect_uri, app.callback);
    assert.notEqual(payload.code_verifier, start.state);
    assert.equal(createHash('sha256').update(payload.code_verifier, 'ascii').digest('base64url'), start.challenge);
    exchanges++;
    return bearer();
  });
  start = await begin(app);
  assert.equal((await finish(app, start, { state: 'x'.repeat(43) })).headers.get('location'), '/?guangya=error');
  assert.equal((await finish(app, start, { cookie: '' })).headers.get('location'), '/?guangya=error');
  assert.equal(exchanges, 0);

  const completed = await finish(app, start);
  assert.equal(completed.headers.get('location'), '/?guangya=connected');
  const [, session] = completed.headers.getSetCookie();
  assert.match(session, /HttpOnly; SameSite=Lax/);
  assert.equal(session.includes('access-initial'), false);
  const headers = { Cookie: session.split(';')[0] };
  assert.deepEqual(await (await app.fetch('/status', { headers })).json(), { configured: true, connected: true });
  assert.deepEqual(await (await app.fetch('/status')).json(), { configured: true, connected: false });
  assert.equal((await finish(app, start)).headers.get('location'), '/?guangya=error');

  const rejected = await begin(app);
  const denied = await app.fetch('/callback?' + new URLSearchParams({ error: 'access_denied', state: rejected.state }),
    { headers: { Cookie: rejected.cookie } });
  assert.equal(denied.headers.get('location'), '/?guangya=denied');
  assert.equal((await finish(app, rejected)).headers.get('location'), '/?guangya=error');
  assert.equal(exchanges, 1);

  assert.equal((await app.fetch('/disconnect', { method: 'POST', headers: { ...headers, Origin: 'https://elsewhere.invalid' } })).status, 403);
  assert.deepEqual(await (await app.fetch('/disconnect', { method: 'POST', headers: { ...headers, Origin: app.origin } })).json(),
    { configured: true, connected: false });
  assert.equal((await app.fetch('/list', { headers })).status, 401);
});

test('Guangya reads all pages, preserves large IDs, refreshes once, and serves Range and bounded lyrics', async t => {
  let renewals = 0;
  let audioLinks = 0;
  const rangeRequests = [];
  const audio = { fileId: songId, fileName: '艺人 - 晚风.FLAC', resType: 1, mineType: 'audio/flac', fileSize: 8 };
  const lyric = { fileId: lyricId, fileName: '艺人 - 晚风.LRC', resType: 1, fileSize: 32 };
  const app = await fixture(t, (url, init) => {
    if (url.href === account) {
      const body = JSON.parse(init.body);
      if (body.grant_type === 'authorization_code') return bearer();
      assert.deepEqual(body, { client_id: clientId, grant_type: 'refresh_token', refresh_token: 'refresh-initial' });
      renewals++;
      return bearer('access-refreshed', 'refresh-rotated');
    }
    if (url.origin === apiOrigin) {
      assert.equal(init.headers['x-client-id'], clientId);
      assert.equal(init.headers.sign, undefined);
      if (init.headers.Authorization === 'Bearer access-initial') return Response.json({ code: 117, msg: 'expired' });
      assert.equal(init.headers.Authorization, 'Bearer access-refreshed');
      if (url.pathname.endsWith('/get_file_list')) {
        assert.equal(url.searchParams.get('pageSize'), '100');
        switch (url.searchParams.get('parentId')) {
          case null: return response({ total: 1, list: [{ fileId: folderId, fileName: '专辑', resType: 2 }] });
          case folderId: {
            const pages = [audio, lyric, { fileId: '8822', fileName: '其他.pdf', resType: 1, mineType: 'application/pdf' }];
            const file = pages[Number(url.searchParams.get('page'))];
            return response({ total: 3, list: file ? [file] : [] });
          }
          default: return Response.json({ code: 430 });
        }
      }
      const id = url.searchParams.get('fileId');
      assert.ok([songId, lyricId].includes(id));
      if (url.pathname.endsWith('/get_file_detail')) return response({ fileInfo: id === songId ? audio : lyric });
      assert.equal(url.pathname, '/openapi/v1/file/get_res_download_url');
      if (id === songId) audioLinks++;
      return response({ signedURL: 'https://download.guangyacdn.com/' + id + '?sig=a%2Bb', urlDuration: 300 });
    }
    assert.equal(url.origin, 'https://download.guangyacdn.com');
    assert.equal(url.search, '?sig=a%2Bb');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers['x-client-id'], undefined);
    if (url.pathname.endsWith('/' + lyricId)) {
      assert.equal(init.headers.Range, undefined);
      const gbk = Buffer.concat([Buffer.from('[00:04.00]'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\r\n')]);
      return new Response(gbk, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    assert.equal(url.pathname, '/' + songId);
    rangeRequests.push(init.headers.Range);
    return new Response(bytes.slice(2, 5), { status: 206, headers: { 'Content-Range': 'bytes 2-4/8', 'Content-Length': '3' } });
  });

  const headers = await connect(app);
  const [root, nested] = await Promise.all([
    app.fetch('/list?path=%2F', { headers }),
    app.fetch('/list?path=' + folderId, { headers }),
  ]);
  assert.deepEqual(await root.json(), { items: [{ id: folderId, name: '专辑', path: folderId, folder: true, size: 0, streamUrl: null }] });
  const items = (await nested.json()).items;
  assert.deepEqual(items.map(({ id, name, streamUrl }) => [id, name, streamUrl]), [
    [songId, audio.fileName, prefix + '/stream?id=' + songId],
    [lyricId, lyric.fileName, prefix + '/stream?id=' + lyricId],
  ]);
  assert.equal(renewals, 1);

  const stream = '/stream?id=' + songId;
  const [range, head] = await Promise.all([
    app.fetch(stream, { headers: { ...headers, Range: 'bytes=2-4' } }),
    app.fetch(stream, { method: 'HEAD', headers: { ...headers, Range: 'bytes=2-4' } }),
  ]);
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-4/8');
  assert.equal(range.headers.get('accept-ranges'), 'bytes');
  assert.equal(range.headers.get('content-type'), 'audio/flac');
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), bytes.slice(2, 5));
  assert.equal(head.status, 206);
  assert.equal(await head.text(), '');
  assert.deepEqual(rangeRequests, ['bytes=2-4', 'bytes=2-4']);
  assert.equal(audioLinks, 1);

  const words = await app.fetch('/stream?id=' + lyricId, { headers: { ...headers, Range: 'bytes=2-4' } });
  assert.equal(words.status, 200);
  assert.equal(words.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await words.text(), '[00:04.00]中文\n');
  const membership = await app.fetch('/list?path=123', { headers });
  assert.equal(membership.status, 403);
  assert.match((await membership.json()).error, /会员/);
});

test('Guangya rejects foreign download destinations and redirect hops without following them', async t => {
  const targets = [];
  const app = await fixture(t, (url, init) => {
    if (url.href === account) return bearer();
    if (url.origin === apiOrigin) {
      const id = url.searchParams.get('fileId');
      if (url.pathname.endsWith('/get_file_detail')) return response({ fileInfo: { fileId: id, fileName: 'test.mp3', resType: 1 } });
      return response({
        signedURL: id === '1' ? 'https://guangyacdn.com.elsewhere.invalid/media' : 'https://download.guangyacdn.com/redirected',
        urlDuration: 300,
      });
    }
    targets.push(url.href);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(url.href, 'https://download.guangyacdn.com/redirected');
    return new Response(null, { status: 302, headers: { Location: 'https://foreign.invalid/signed-audio' } });
  });
  const headers = await connect(app);
  for (const id of ['1', '2']) {
    const result = await app.fetch('/stream?id=' + id, { headers });
    assert.equal(result.status, 502);
    assert.match((await result.json()).error, /非受信/);
  }
  assert.deepEqual(targets, ['https://download.guangyacdn.com/redirected']);
});

test('Guangya restores only with the private key and remembers token renewal and upstream revocation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-guangya-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'auth.enc');
  const sessionKey = Buffer.alloc(32, 0x31);
  let renewed = 0;
  let revoke = false;
  let downloadLinks = 0;
  const cdn = 'https://stream.guangyacdn.com/track?signature=private-signed-link';
  const app = await fixture(t, (url, options) => {
    if (url.href === account) {
      const body = JSON.parse(options.body);
      if (body.grant_type === 'authorization_code') return bearer();
      if (revoke) return Response.json({ error: 'invalid_grant' }, { status: 401 });
      assert.equal(body.refresh_token, 'refresh-initial');
      renewed++;
      return bearer('access-renewed', 'refresh-renewed');
    }
    if (url.href === cdn) {
      assert.equal(options.headers.Authorization, undefined);
      return new Response(bytes, { headers: { 'Content-Length': String(bytes.byteLength) } });
    }
    assert.equal(url.origin, apiOrigin);
    if (revoke || options.headers.Authorization === 'Bearer access-initial') return Response.json({ code: 117 });
    assert.equal(options.headers.Authorization, 'Bearer access-renewed');
    if (url.pathname.endsWith('/get_file_list')) return response({ total: 0, list: [] });
    if (url.pathname.endsWith('/get_file_detail')) {
      return response({ fileInfo: { fileId: songId, fileName: '晚风.mp3', resType: 1, fileSize: 8 } });
    }
    assert.match(url.pathname, /\/get_res_download_url$/);
    downloadLinks++;
    return response({ signedURL: cdn, urlDuration: 60 });
  }, { sessionFile, sessionKey });

  const headers = await connect(app);
  const encrypted = await readFile(sessionFile);
  assert.equal(encrypted.includes(Buffer.from('refresh-initial')), false);
  for (const replacement of [{ key: null }, { key: Buffer.alloc(32, 0x32) }, { appId: 'another-public-client' }]) {
    app.restart(replacement);
    assert.deepEqual(await (await app.fetch('/status', { headers })).json(), { configured: true, connected: false });
  }
  app.restart();
  assert.deepEqual(await (await app.fetch('/list', { headers })).json(), { items: [] });
  assert.equal(renewed, 1);
  const getAudio = () => app.fetch('/stream?id=' + songId, { headers });
  for (let restart = 0; restart < 2; restart++) {
    const audio = await getAudio();
    assert.equal(audio.status, 200);
    assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), bytes);
    app.restart();
  }
  assert.equal(renewed, 1);
  assert.equal(downloadLinks, 2);
  const stored = await readFile(sessionFile);
  assert.notDeepEqual(stored, encrypted);
  assert.equal(stored.includes(Buffer.from('refresh-renewed')), false);
  assert.equal(stored.includes(Buffer.from('private-signed-link')), false);

  revoke = true;
  assert.equal((await app.fetch('/list', { headers })).status, 401);
  app.restart();
  assert.deepEqual(await (await app.fetch('/status', { headers })).json(), { configured: true, connected: false });
  assert.equal((await app.fetch('/list', { headers })).status, 401);
});

test('Guangya without a private installation key keeps sessions in memory only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-guangya-no-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'auth.enc');
  const app = await fixture(t, url => {
    assert.equal(url.href, account);
    return bearer();
  }, { sessionFile });
  const headers = await connect(app);
  assert.deepEqual(await (await app.fetch('/status', { headers })).json(), { configured: true, connected: true });
  await assert.rejects(readFile(sessionFile), { code: 'ENOENT' });
  app.restart();
  assert.deepEqual(await (await app.fetch('/status', { headers })).json(), { configured: true, connected: false });
});
