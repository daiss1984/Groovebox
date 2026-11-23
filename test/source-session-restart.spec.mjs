import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { launchSmb2 } from './helpers/smb-fixture.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const webdavPython = process.env.GROOVEBOX_WEBDAV_TEST_PYTHON;
const certificate = process.env.GROOVEBOX_WEBDAV_TEST_CERT;
const privateKey = process.env.GROOVEBOX_WEBDAV_TEST_KEY;
const trustFixture = process.env.NODE_EXTRA_CA_CERTS;
const smbPython = process.env.SMB_TEST_PYTHON;
const sourceCookie = 'groovebox_sources';
const nav = (page, section) => page.locator('#sidebar [data-nav="' + section + '"]');
const dialog = page => page.getByRole('dialog');

function childReady(command, args, options, parseUrl) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const close = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  };
  const url = new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = parseUrl(output);
      if (found) resolve(found);
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-1600); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Fixture process exited (' + code + ')\n' + errors)));
  });
  // Both fixture setup and its teardown can await the same readiness promise.
  void url.catch(() => {});
  return { url, close };
}

function launchDav(root) {
  const username = 'isolated-webdav-reader';
  const password = 'temporary-webdav-source-fixture-secret';
  const script = [
    'import sys',
    'from cheroot.ssl.builtin import BuiltinSSLAdapter',
    'from cheroot.wsgi import Server',
    'from wsgidav.wsgidav_app import WsgiDAVApp',
    'root, username, password, cert, key = sys.argv[1:]',
    'app = WsgiDAVApp({"provider_mapping": {"/": root}, "verbose": 0, "dir_browser": {"enable": False},',
    '  "http_authenticator": {"accept_basic": True, "accept_digest": False, "default_to_digest": False},',
    '  "simple_dc": {"user_mapping": {"*": {username: {"password": password}}}}})',
    'server = Server(("127.0.0.1", 0), app)',
    'server.ssl_adapter = BuiltinSSLAdapter(cert, key)',
    'server.prepare()',
    'print("PORT=" + str(server.bind_addr[1]), flush=True)',
    'server.serve()',
  ].join('\n');
  const server = childReady(webdavPython, ['-c', script, root, username, password, certificate, privateKey], {}, output => {
    const port = /^PORT=(\d+)$/m.exec(output)?.[1];
    return port && 'https://127.0.0.1:' + port;
  });
  return { input: server.url.then(url => ({ url, username, password })), stop: server.close };
}

async function launchApp(data, { port = 0, clock } = {}) {
  const args = [...(clock ? ['--import', pathToFileURL(clock).href] : []), 'server/index.mjs'];
  const server = childReady(process.execPath, args, { cwd: project, env: {
    HOST: '127.0.0.1', PORT: String(port), GROOVEBOX_DATA_DIR: data,
    ...(trustFixture && { NODE_EXTRA_CA_CERTS: trustFixture }),
    ...(smbPython && { SMB_PYTHON: smbPython }),
  } }, output => /^Groovebox: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output)?.[1]);
  try {
    const url = await server.url;
    return { url, port: Number(new URL(url).port), close: server.close };
  } catch (error) { await server.close(); throw error; }
}

async function openSource(page, input) {
  await nav(page, 'sources').click();
  await page.locator('#content [data-action=add-source]').click();
  const form = dialog(page);
  await form.getByLabel('协议').selectOption(input.type);
  await form.getByLabel('名称').fill(input.name);
  await form.getByLabel('服务地址').fill(input.url);
  await form.getByLabel('用户名').fill(input.username);
  await form.getByLabel('密码').fill(input.password);
  await form.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('#content').getByRole('heading', { name: input.name, exact: true })).toBeVisible();
}

async function sources(context, app) {
  const response = await context.request.get(app.url + '/api/sources');
  expect(response.status()).toBe(200);
  return (await response.json()).sources;
}

async function cookie(context, app) {
  const item = (await context.cookies()).find(candidate => candidate.name === sourceCookie);
  expect(item).toBeTruthy();
  expect(item).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/sources' });
  expect(item.domain).toBe(new URL(app.url).hostname);
  return item.value;
}

async function assertStream(response, audio) {
  expect(response.status()).toBe(206);
  expect(response.headers()['content-range']).toBe('bytes 64-255/' + audio.length);
  expect(await response.body()).toEqual(audio.subarray(64, 256));
}

async function assertEncryptedFiles(root, privateValues) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile());
  expect(files.length).toBeGreaterThan(0);
  for (const entry of files) {
    const path = join(entry.parentPath, entry.name);
    const file = await readFile(path);
    for (const value of privateValues) expect(file.includes(Buffer.from(value))).toBe(false);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0);
  }
}

for (const type of ['webdav', 'smb']) {
  test(type + ' restores private sources and old media IDs across restarts, while retaining profile isolation', async ({ page, browser }) => {
    test.skip(type === 'webdav' ? !(webdavPython && certificate && privateKey && trustFixture) : !smbPython,
      'Requires the isolated HTTPS WsgiDAV or SMB2 fixture');
    test.setTimeout(60_000);
    const root = await mkdtemp(join(tmpdir(), 'groovebox-source-restart-'));
    const data = join(root, 'state');
    const media = join(root, 'share');
    const folder = 'Test Album';
    const secondFolder = 'Separate Profile Folder';
    const file = 'Fixture Artist - Private Recording.m4a';
    const title = 'Private Recording Fixture Artist';
    const lyric = 'Private timed lyric remains available';
    await Promise.all([mkdir(join(media, folder), { recursive: true }), mkdir(join(media, secondFolder), { recursive: true }), mkdir(data)]);
    const [audio, art] = await Promise.all(['demo-1.m4a', 'cover-1.jpg'].map(name => readFile(new URL('../public/assets/' + name, import.meta.url))));
    await Promise.all([
      writeFile(join(media, folder, file), audio),
      writeFile(join(media, folder, 'cover.jpg'), art),
      writeFile(join(media, folder, file.replace(/\.m4a$/, '.lrc')), '[00:00.00]' + lyric + '\n'),
      writeFile(join(media, secondFolder, 'Different Profile Recording.m4a'), audio),
    ]);
    const fixture = type === 'webdav' ? launchDav(media) : launchSmb2(smbPython, media);
    let app, other;
    try {
      app = await launchApp(data);
      const port = app.port;
      const input = await fixture.input;
      const name = type.toUpperCase() + ' continuity fixture';
      const owner = page.context();
      await page.addInitScript(() => {
        const key = 'groovebox.state.v1';
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: {
          demos: false, autoMatchLyrics: false, onlineCover: false, artistImageEngine: false,
        } }));
      });
      await page.goto(app.url + '/#sources');
      await openSource(page, { ...input, type, name });
      const original = (await sources(owner, app))[0];
      expect(original).toEqual({ type, name, id: expect.any(String) });
      const originalCookie = await cookie(owner, app);
      expect(await page.evaluate(cookieName => document.cookie.includes(cookieName + '='), sourceCookie)).toBe(false);

      const base = '/api/sources/' + original.id;
      const folderList = (ctx, path) => ctx.request.get(app.url + base + '/list?path=' + encodeURIComponent(path));
      const rootItems = (await (await folderList(owner, '/')).json()).items;
      const location = rootItems.find(item => item.folder && item.name === folder);
      expect(location).toBeTruthy();
      await page.locator('#content').getByRole('button', { name: folder, exact: true }).click();
      const items = (await (await folderList(owner, location.path)).json()).items;
      const recording = items.find(item => item.name === file);
      expect(recording).toMatchObject({
        streamUrl: expect.stringMatching(/\/stream\?id=/), folderCover: expect.stringMatching(/\/cover\?id=/),
      });
      await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).click();
      await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
      await nav(page, 'songs').click();
      await expect(page.locator('#content').getByRole('heading', { name: '全部歌曲', exact: true })).toBeVisible();
      const range = ctx => ctx.request.get(app.url + recording.streamUrl, { headers: { Range: 'bytes=64-255' } });
      await assertStream(await range(owner), audio);
      const secretText = [input.password, 'Basic ' + Buffer.from(input.username + ':' + input.password).toString('base64'), originalCookie];
      const assertSafe = text => { for (const secret of secretText) expect(text.includes(secret)).toBe(false); };
      assertSafe(JSON.stringify({ source: original, recording }));
      assertSafe(await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) })));
      await nav(page, 'settings').click();
      const backup = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出备份', exact: true }).click();
      assertSafe(await readFile(await (await backup).path(), 'utf8'));
      await nav(page, 'songs').click();
      await expect(page.locator('#content').getByRole('heading', { name: '全部歌曲', exact: true })).toBeVisible();

      other = await browser.newContext({ serviceWorkers: 'block' });
      const foreign = await other.request.post(app.url + '/api/sources', {
        headers: { Origin: app.url },
        data: { ...input, type, name: 'Other browser profile', url: input.url.replace(/\/$/, '') + '/' + encodeURIComponent(secondFolder) },
      });
      expect(foreign.status()).toBe(201);
      const separate = (await foreign.json()).source;
      expect(separate.id).not.toBe(original.id);
      expect(await cookie(other, app) === originalCookie).toBe(false);
      expect((await range(other)).status()).toBe(404);
      expect((await fetch(app.url + recording.streamUrl)).status).toBe(404);

      await app.close();
      app = await launchApp(data, { port });
      // No browse/scan has recreated media IDs in this process.
      const restored = await sources(owner, app);
      const resumed = await range(owner);
      expect({ restored, oldMediaStatus: resumed.status() }).toEqual({ restored: [original], oldMediaStatus: 206 });
      expect(await cookie(owner, app) === originalCookie).toBe(true);
      await assertStream(resumed, audio);
      const restoredArt = await owner.request.get(app.url + recording.folderCover);
      expect(restoredArt.status()).toBe(200);
      expect(await restoredArt.body()).toEqual(art);
      expect(await sources(other, app)).toEqual([separate]);
      expect((await range(other)).status()).toBe(404);
      expect((await fetch(app.url + recording.folderCover)).status).toBe(404);
      await assertEncryptedFiles(data, [...secretText, input.url]);

      await page.reload();
      await page.locator('#content').getByRole('button', { name: title, exact: true }).click();
      const player = page.locator('#audio');
      await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
      const played = await player.evaluate(audio => audio.currentSrc);
      expect(new URL(played).pathname + new URL(played).search).toBe(recording.streamUrl);
      const echoed = await owner.request.get(played);
      expect(echoed.status()).toBe(200);
      expect(createHash('sha256').update(await echoed.body()).digest('hex')).toBe(createHash('sha256').update(audio).digest('hex'));
      await page.locator('#now').getByRole('button', { name: '歌词', exact: true }).click();
      await expect(page.locator('#now').getByRole('button', { name: lyric, exact: true })).toBeVisible();
      const listed = await folderList(owner, location.path);
      expect(listed.status()).toBe(200);
      expect((await listed.json()).items.find(item => item.name === file)).toMatchObject({
        id: recording.id, streamUrl: recording.streamUrl, folderCover: recording.folderCover,
      });

      expect((await owner.request.delete(app.url + base, { headers: { Origin: app.url } })).status()).toBe(200);
      expect((await owner.cookies()).some(item => item.name === sourceCookie)).toBe(false);
      await app.close();
      app = await launchApp(data, { port });
      expect(await sources(owner, app)).toEqual([]);
      expect((await range(owner)).status()).toBe(404);
      const replay = { headers: { Cookie: sourceCookie + '=' + originalCookie } };
      expect(await fetch(app.url + '/api/sources', replay).then(response => response.json())).toEqual({ sources: [] });
      expect((await fetch(app.url + recording.streamUrl, replay)).status).toBe(404);
      expect(await sources(other, app)).toEqual([separate]);

      const separateCookie = await cookie(other, app);
      const snapshot = join(data, 'source-sessions', createHash('sha256').update(separateCookie).digest('hex') + '.enc');
      await app.close();
      const saved = await readFile(snapshot);
      const damaged = Buffer.from(saved);
      damaged[damaged.length - 1] ^= 1;
      await writeFile(snapshot, damaged);
      app = await launchApp(data, { port });
      const rejected = await other.request.get(app.url + '/api/sources');
      expect(rejected.status()).toBe(401);
      expect(await rejected.json()).toMatchObject({ code: 'source_session_unreadable' });
      expect((await other.request.get(app.url + '/api/sources/' + separate.id + '/list?path=%2F')).status()).toBe(401);
      expect(await sources(owner, app)).toEqual([]);

      // Replay authentic fixture bytes with a future application clock while the browser still holds the cookie.
      await app.close();
      await writeFile(snapshot, saved);
      const clock = join(root, 'future-clock.mjs');
      await writeFile(clock, 'const now = Date.now.bind(Date); Date.now = () => now() + 8 * 86400000;\n');
      app = await launchApp(data, { port, clock });
      expect(await cookie(other, app) === separateCookie).toBe(true);
      expect(await sources(other, app)).toEqual([]);
      expect((await other.request.get(app.url + '/api/sources/' + separate.id + '/list?path=%2F')).status()).toBe(404);
    } finally {
      await other?.close();
      await app?.close();
      await fixture.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}
