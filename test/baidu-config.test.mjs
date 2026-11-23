import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBaiduConfigHandler } from '../server/baidu-config.mjs';

test('local Baidu web setup activates the OAuth route without restart and stores no plaintext secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-config-test-'));
  const file = join(dir, 'baidu-settings.enc');
  const options = { env: {}, file, sessionFile: join(dir, 'baidu-sessions.enc') };
  let handler = createBaiduConfigHandler(options);
  const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + '/api/baidu';
  const response = (action, options = {}) => fetch(base + '/' + action, { redirect: 'manual', ...options });
  const credentials = { clientId: 'fixture-web-app', clientSecret: 'fixture-private-secret', redirectUri: base + '/callback' };
  const save = (headers, body = credentials) => response('config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  assert.deepEqual(await (await response('status')).json(), { configured: false, connected: false });
  const settings = await response('config');
  assert.deepEqual(await settings.json(), { editable: true, redirectUri: credentials.redirectUri });
  assert.equal((await save({ Origin: 'http://outside.example' })).status, 403);
  assert.equal((await save({})).status, 403);
  assert.equal((await save({ Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await save({ Origin: origin }, { ...credentials, redirectUri: 'https://outside.example/api/baidu/callback' })).status, 400);
  assert.equal((await save({ Origin: origin }, { ...credentials, clientId: credentials.clientId + '复制' })).status, 400);
  assert.equal((await save({ Origin: origin }, { ...credentials, clientId: 'x'.repeat(4500) })).status, 413);
  const saved = await save({ Origin: origin }, { clientId: credentials.clientId, clientSecret: credentials.clientSecret });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { configured: true, changed: true });
  assert.deepEqual(await (await response('status')).json(), { configured: true, connected: false, codeAvailable: true, deviceAvailable: true });
  const bytes = await readFile(file);
  assert.deepEqual(await (await save({ Origin: origin })).json(), { configured: true, changed: false });
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(bytes.includes(Buffer.from(credentials.clientSecret)), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'vault.key'))).mode & 0o777, 0o600);
  }
  for (let pass = 0; pass < 2; pass++) {
    const started = await response('connect');
    assert.equal(started.status, 303);
    const authorize = new URL(started.headers.get('location'));
    assert.equal(authorize.origin, 'https://openapi.baidu.com');
    assert.equal(authorize.searchParams.get('client_id'), credentials.clientId);
    assert.equal(authorize.searchParams.get('redirect_uri'), credentials.redirectUri);
    assert.equal(authorize.searchParams.has('client_secret'), false);
    handler = createBaiduConfigHandler(options);
  }
});

test('revokes pending backup reads only after a changed OAuth configuration is saved', { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'groovebox-backup-config-'));
  let handler;
  const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const prefix = origin + '/api/baidu';
  let blocked;
  const options = {
    file: join(dir, 'baidu-settings.enc'),
    env: {
      BAIDU_CLIENT_ID: 'approved-app', BAIDU_CLIENT_SECRET: 'fixture-secret',
      BAIDU_REDIRECT_URI: prefix + '/callback', BAIDU_BACKUP_APP_FOLDER: '/apps/approved-app',
    },
    async request(url) {
      if (url.pathname === '/oauth/2.0/token') {
        return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
      }
      assert.equal(url.searchParams.get('access_token'), 'fixture-access');
      if (url.searchParams.get('method') === 'uinfo') return Response.json({ errno: 0, uk: '42' });
      assert.equal(url.searchParams.get('method'), 'list');
      assert.equal(url.searchParams.get('dir'), '/apps/approved-app/groovebox-backups');
      const barrier = blocked;
      barrier.started.resolve();
      await barrier.finish.promise;
      return Response.json({ errno: 0, list: [] });
    },
  };
  const get = (action, Cookie) => fetch(prefix + action, {
    redirect: 'manual', ...(Cookie && { headers: { Cookie } }),
  });
  const save = (clientId, clientSecret) => fetch(prefix + '/config', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  async function login() {
    const start = await get('/connect');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cookie = start.headers.getSetCookie()[0].split(';')[0];
    const end = await get('/callback?state=' + state + '&code=fixture', cookie);
    assert.equal(end.headers.get('location'), '/?baidu=connected');
    return end.headers.getSetCookie()[1].split(';')[0];
  }

  handler = createBaiduConfigHandler(options);
  const oldCookie = await login();
  assert.equal((await (await get('/status', oldCookie)).json()).canBackup, true);

  blocked = { started: Promise.withResolvers(), finish: Promise.withResolvers() };
  const unaffected = get('/backup', oldCookie);
  try {
    await blocked.started.promise;
    assert.equal((await save('incomplete-app')).status, 400);
    const unchanged = await save('approved-app', 'fixture-secret');
    assert.deepEqual(await unchanged.json(), { configured: true, changed: false });
  } finally {
    blocked.finish.resolve();
  }
  const authorized = await unaffected;
  assert.equal(authorized.status, 200);
  assert.deepEqual((await authorized.json()).snapshots, []);

  blocked = { started: Promise.withResolvers(), finish: Promise.withResolvers() };
  const pending = get('/backup', oldCookie);
  try {
    await blocked.started.promise;
    const changed = await save('other-app', 'other-secret');
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { configured: true, changed: true });
  } finally {
    blocked.finish.resolve();
  }
  const stale = await pending;
  assert.equal(stale.status, 401);
  const rejected = await stale.json();
  assert.equal(rejected.account, undefined);
  assert.equal(rejected.snapshots, undefined);
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = await login();
    const status = await (await get('/status', cookie)).json();
    assert.equal(status.connected, true);
    assert.notEqual(status.canBackup, true);
    const denied = await get('/backup', cookie);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'backup_unavailable');
    handler = createBaiduConfigHandler(options);
  }
});
