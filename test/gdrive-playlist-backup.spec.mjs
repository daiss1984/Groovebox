import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGdriveHandler } from '../server/gdrive.mjs';
import { readPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';

const account = 'G'.repeat(43);
const file = '1_valid-Google_425';
const trackId = 'gdrive:' + file;
const baiduId = 'baidu:502';
const originalList = '6ce73fd5-6ec0-4523-99ac-8e9c3e9baaaf';
const localList = 'd7565116-cc7c-4723-b0a0-a10c2301f607';
const stream = '/api/gdrive/stream?id=' + file;
const stateKey = 'groovebox.state.v1';
const action = (page, name) => page.locator('[data-action="' + name + '"]');
const googleCard = page => action(page, 'oauth-source').and(page.locator('[data-id="gdrive"]'));
const status = page => page.locator('[data-gdrive-backup-status]');
const state = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), stateKey);

async function initialize(page, initial) {
  await page.addInitScript(({ key, initial }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { demos: false }, ...initial }));
  }, { key: stateKey, initial });
}
async function mockAudio(page) {
  await page.route('**/api/gdrive/list?**', route => route.fulfill({
    json: { items: [{ id: file, name: '云盘艺人 - 归档录音.m4a', path: '/Music/录音.m4a', streamUrl: stream, backupAccount: account }] },
  }));
  await page.route('**' + stream, async route => {
    const response = await route.fetch({ url: new URL('/assets/demo-1.m4a', route.request().url()).href });
    await route.fulfill({ response });
  });
}
async function playVisibleTrack(page) {
  await page.locator('#content .track-main').first().press('Enter');
  await expect.poll(() => page.locator('#audio').evaluate(audio => !audio.paused && audio.currentTime > 0.1)).toBe(true);
}
async function dismissDialog(page) {
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).press('Enter');
}

test('Google Drive backup requires explicit consent, refuses a foreign authorize URL and preserves ordinary playback after denial', async ({ page, baseURL }) => {
  let offerBackup = false;
  let starts = 0;
  let external = 0;
  let safeAuthorize = false;
  await page.route('**/api/gdrive/status', route => route.fulfill({
    json: { configured: true, connected: true, ...(offerBackup && { backupAuthorizationAvailable: true }) },
  }));
  await mockAudio(page);
  await page.route('**/api/gdrive/backup/connect', route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().accept).toContain('application/json');
    starts++;
    return route.fulfill({ json: { authorizeUrl: safeAuthorize
      ? 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic'
      : 'https://untrusted.invalid/o/oauth2/v2/auth?state=synthetic' } });
  });
  await page.route('https://untrusted.invalid/**', route => {
    external++;
    return route.abort();
  });
  await page.route('https://accounts.google.com/o/oauth2/v2/auth?**', route => {
    external++;
    const callback = new URL('/?gdrive=backup-denied', baseURL);
    return route.fulfill({ contentType: 'text/html', body: '<a href="' + callback.href + '">Return without granting</a>' });
  });
  await initialize(page, {});
  await page.goto('/#sources');
  await googleCard(page).press('Enter');
  await expect(page.locator('#content .track-name')).toHaveText('归档录音');
  await expect(action(page, 'gdrive-playlist-backup')).toHaveCount(0);
  expect(starts).toBe(0);

  offerBackup = true;
  await page.goto('/#sources');
  await page.reload();
  await action(page, 'gdrive-playlist-backup').press('Enter');
  expect(starts).toBe(0);
  await action(page, 'gdrive-backup-authorize').press('Enter');
  await expect.poll(() => starts).toBe(1);
  await expect(action(page, 'gdrive-backup-authorize')).toBeEnabled();
  expect(external).toBe(0);

  safeAuthorize = true;
  await action(page, 'gdrive-backup-authorize').press('Enter');
  await page.getByRole('link', { name: 'Return without granting' }).click();
  await expect.poll(() => new URL(page.url()).origin).toBe(new URL(baseURL).origin);
  expect(starts).toBe(2);
  expect(external).toBe(1);
  await page.goto('/#sources');
  await googleCard(page).press('Enter');
  await playVisibleTrack(page);
  await expect(action(page, 'gdrive-playlist-backup')).toBeVisible();
});

test('backs up Google Drive playlists, retries exact bytes after reload, and merges into another profile without rebinding Baidu tracks', async ({ page, browser, baseURL }) => {
  const writes = [];
  const stored = new Map();
  let loseFirstReply = true;
  let backupGrant = true;
  const mockVerified = async target => {
    await mockAudio(target);
    await target.route('**/api/gdrive/status', route => route.fulfill({
      json: { configured: true, connected: true, backupAuthorizationAvailable: true, ...(backupGrant && { canBackup: true }) },
    }));
    await target.route(url => url.pathname === '/api/gdrive/backup', route => {
      const request = route.request();
      const params = new URL(request.url()).searchParams;
      const id = params.get('id');
      if (!backupGrant) return route.fulfill({ status: 403, json: { code: 'backup_scope_required' } });
      if (request.method() === 'PUT') {
        const bytes = request.postDataBuffer();
        const prior = stored.get(id);
        writes.push({ id, bytes });
        if (prior && !prior.equals(bytes)) return route.fulfill({ status: 409, json: { code: 'snapshot_conflict' } });
        stored.set(id, bytes);
        if (loseFirstReply) {
          loseFirstReply = false;
          return route.fulfill({ status: 503, json: { code: 'commit_unknown' } });
        }
        return route.fulfill({ json: { id, status: prior ? 'already_present' : 'saved' } });
      }
      if (id) {
        expect(params.get('verify')).toBe('1');
        return route.fulfill({ json: { snapshot: stored.get(id).toString(), available: [file] } });
      }
      return route.fulfill({ json: { account, snapshots: [...stored].map(([id, bytes]) =>
        ({ id, name: 'groovebox-playlists-' + id + '.json', size: bytes.length, modifiedAt: 1_770_000_000_000 })) } });
    });
  };
  await mockVerified(page);
  await initialize(page, {
    tracks: [{ id: baiduId, title: '仅百度网盘的曲目', src: '/api/baidu/stream?id=502', provider: 'baidu', backupAccount: account }],
    playlists: [{ id: originalList, name: '云盘版歌单', tracks: [trackId, baiduId, trackId] }],
    playlistCreationDates: [[originalList, 1_700_000_000_000]],
    favorites: [trackId, baiduId],
  });
  await page.goto('/#sources');
  await googleCard(page).press('Enter');
  await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
  expect((await state(page)).tracks.find(track => track.id === trackId)).toMatchObject({ backupAccount: account, src: stream });
  await action(page, 'gdrive-playlist-backup').press('Enter');
  await action(page, 'gdrive-backup-upload').press('Enter');
  expect(writes).toHaveLength(0);
  await action(page, 'gdrive-backup-confirm-upload').press('Enter');
  await expect(status(page)).toContainText('暂无法确认上传结果');
  expect(writes).toHaveLength(1);
  const first = writes[0];
  const snapshot = readPlaylistSnapshot(first.bytes, { provider: 'gdrive', account });
  expect(snapshot.playlists[0].tracks).toEqual([0, 1, 0]);
  expect(snapshot.version).toBe(2);
  expect(snapshot.playlists[0].createdAt).toBe(1_700_000_000_000);
  expect(snapshot.tracks.map(track => track.file)).toEqual([file, undefined]);
  expect(first.bytes.toString()).not.toContain('/api/');

  await page.reload();
  await action(page, 'gdrive-playlist-backup').press('Enter');
  await action(page, 'gdrive-backup-upload').press('Enter');
  await action(page, 'gdrive-backup-confirm-upload').press('Enter');
  await expect(status(page)).toContainText('歌单备份已上传');
  expect(writes[1]).toEqual(first);
  expect(stored.size).toBe(1);

  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  try {
    const other = await context.newPage();
    await mockVerified(other);
    await initialize(other, {
      tracks: [{ id: baiduId, title: '原有百度曲目', src: '/api/baidu/stream?id=502', provider: 'baidu' }],
      playlists: [{ id: localList, name: '原有歌单', tracks: [baiduId] }],
      favorites: [baiduId],
    });
    await other.goto('/#sources');
    await action(other, 'gdrive-playlist-backup').press('Enter');
    await action(other, 'gdrive-backup-preview').press('Enter');
    await expect(action(other, 'gdrive-backup-restore')).toBeEnabled();
    backupGrant = false;
    await action(other, 'gdrive-backup-restore').press('Enter');
    await expect(action(other, 'gdrive-backup-authorize')).toBeEnabled();
    expect((await state(other)).playlists).toHaveLength(1);

    backupGrant = true;
    await other.reload();
    await action(other, 'gdrive-playlist-backup').press('Enter');
    for (let attempt = 0; attempt < 2; attempt++) {
      await action(other, 'gdrive-backup-preview').press('Enter');
      await expect(action(other, 'gdrive-backup-restore')).toBeEnabled();
      if (attempt === 0) expect((await state(other)).playlists).toHaveLength(1);
      await action(other, 'gdrive-backup-restore').press('Enter');
      await expect(status(other)).toContainText('歌单和收藏已合并');
    }
    const applied = await state(other);
    expect(applied.playlists).toEqual([
      { id: localList, name: '原有歌单', tracks: [baiduId] },
      { id: originalList, name: '云盘版歌单', tracks: [trackId, trackId] },
    ]);
    expect(applied.favorites).toEqual([baiduId, trackId]);
    expect(applied.playlistCreationDates).toContainEqual([originalList, 1_700_000_000_000]);
    expect(applied.tracks.find(track => track.id === trackId)).toMatchObject({ provider: 'gdrive', src: stream, backupAccount: account });
    await dismissDialog(other);
    await other.locator('#sidebar [data-nav="playlist/' + originalList + '"]').press('Enter');
    await expect(other.locator('#content .track-main')).toHaveCount(2);
    await playVisibleTrack(other);
  } finally {
    await context.close();
  }
});

test('restores each mixed-ID cloud playlist and its creation date when a fallback collides', async ({ page }) => {
  const operation = '10000000-0000-4000-8000-000000000001';
  const explicit = '10000000-0000-8000-8000-000000000001';
  const unaffected = '10000000-0000-8000-8000-000000000002';
  const secondFile = 'second_google_fixture';
  const secondId = 'gdrive:' + secondFile;
  const snapshot = JSON.stringify({ format: 'groovebox-playlists', version: 2, operation,
    scope: { provider: 'gdrive', account }, tracks: [{ file, title: 'First' }, { file: secondFile, title: 'Second' }],
    playlists: [
      { createdAt: 100, name: 'Collision', tracks: [0, 0] },
      { createdAt: 200, name: 'Independent', tracks: [1] },
      { id: explicit, createdAt: 300, name: 'Explicit', tracks: [0, 1] },
    ], favorites: [],
  });
  await initialize(page, {});
  await page.route('**/api/gdrive/status', route => route.fulfill({ json: { configured: true, connected: true, canBackup: true } }));
  await page.route(url => url.pathname === '/api/gdrive/backup', route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.has('id')) {
      expect(params.get('id')).toBe(operation);
      expect(params.get('verify')).toBe('1');
      return route.fulfill({ json: { snapshot, available: [file, secondFile] } });
    }
    return route.fulfill({ json: { account, snapshots: [{ id: operation, name: 'Fixture', size: snapshot.length, modifiedAt: 1 }] } });
  });

  async function restore() {
    await action(page, 'gdrive-playlist-backup').press('Enter');
    await action(page, 'gdrive-backup-preview').press('Enter');
    await expect(action(page, 'gdrive-backup-restore')).toBeEnabled();
    await action(page, 'gdrive-backup-restore').press('Enter');
    await expect(status(page)).toContainText('歌单和收藏已合并');
    const saved = await state(page);
    return { playlists: saved.playlists, dates: saved.playlistCreationDates };
  }
  await page.goto('/#sources');
  const first = await restore();
  const relocated = first.playlists[0].id;
  expect(relocated).not.toBe(explicit);
  expect(relocated).not.toBe(unaffected);
  expect(first).toEqual({
    playlists: [
      { id: relocated, name: 'Collision', tracks: [trackId, trackId] },
      { id: unaffected, name: 'Independent', tracks: [secondId] },
      { id: explicit, name: 'Explicit', tracks: [trackId, secondId] },
    ],
    dates: [[relocated, 100], [unaffected, 200], [explicit, 300]],
  });
  await page.reload();
  expect(await restore()).toEqual(first);
});

test('connects, upgrades, uploads, previews and plays through the actual Google Drive server handler', async ({ page, baseURL }) => {
  const root = 'fixture_root';
  const folderMime = 'application/vnd.google-apps.folder';
  const readonly = 'https://www.googleapis.com/auth/drive.readonly';
  const writeScope = 'https://www.googleapis.com/auth/drive.file';
  const filesBase = '/drive/v3/files';
  const dataDirectory = await mkdtemp(join(tmpdir(), 'groovebox-gdrive-browser-'));
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const song = {
    id: file, name: '云盘艺人 - 归档录音.m4a', mimeType: 'audio/mp4', trashed: false,
    size: String(audio.length), capabilities: { canDownload: true },
  };
  const remote = new Map();
  const uploads = [];
  let generated = 0;
  let origin;
  let handler;

  function mediaResponse(bytes, type, options) {
    const header = new Headers(options.headers).get('range') ?? '';
    const range = /^bytes=(\d+)-(\d*)$/.exec(header);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return new Response(options.method === 'HEAD' ? null : bytes.subarray(start, end + 1), {
      status: range ? 206 : 200, headers: {
        'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
        ...(range && { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }),
      },
    });
  }

  const app = createServer(async (req, res) => {
    try {
      if (await handler(req, res, new URL(req.url, origin))) return;
      const asset = await fetch(new URL(req.url, baseURL));
      const headers = {};
      for (const header of ['content-type', 'content-security-policy']) {
        if (asset.headers.has(header)) headers[header] = asset.headers.get(header);
      }
      res.writeHead(asset.status, headers);
      if (!asset.body || req.method === 'HEAD') return res.end();
      Readable.fromWeb(asset.body).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  origin = 'http://127.0.0.1:' + app.address().port;
  handler = createGdriveHandler({
    backupDataDirectory: dataDirectory,
    sessionFile: join(dataDirectory, 'sessions.enc'),
    env: {
      GDRIVE_CLIENT_ID: 'synthetic-client', GDRIVE_CLIENT_SECRET: 'fixture-secret',
      GDRIVE_REDIRECT_URI: origin + '/api/gdrive/callback', GDRIVE_PLAYLIST_BACKUP: '1',
    },
    async request(raw, options) {
      const url = new URL(raw);
      const pathname = url.pathname;
      const token = new Headers(options.headers).get('authorization');
      if (url.hostname === 'oauth2.googleapis.com') {
        const upgrade = new URLSearchParams(options.body).get('code') === 'backup-consent';
        return Response.json({
          access_token: upgrade ? 'backup-token' : 'playback-token', refresh_token: upgrade ? 'backup-refresh' : 'playback-refresh',
          scope: upgrade ? readonly + ' ' + writeScope : readonly, expires_in: 3600,
        });
      }
      expect(url.hostname).toBe('www.googleapis.com');
      expect(['Bearer backup-token', 'Bearer playback-token']).toContain(token);
      if (pathname === '/drive/v3/about') return Response.json({ user: { permissionId: 'fixture-permission' } });
      if (options.method === 'POST') {
        expect(token).toBe('Bearer backup-token');
        let metadata;
        let bytes;
        if (pathname === '/upload' + filesBase) {
          expect(url.searchParams.get('uploadType')).toBe('multipart');
          const contentType = new Headers(options.headers).get('content-type');
          const boundary = contentType.match(/boundary=([\w-]+)/)?.[1];
          const parts = Buffer.from(options.body).toString().split('--' + boundary);
          expect(parts).toHaveLength(4);
          metadata = JSON.parse(parts[1].split('\r\n\r\n')[1]);
          bytes = Buffer.from(parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2));
          uploads.push(bytes);
        } else {
          expect(pathname).toBe(filesBase);
          metadata = JSON.parse(options.body);
        }
        expect(metadata.id).toMatch(/^allocated_/);
        if (remote.has(metadata.id)) return Response.json({}, { status: 409 });
        const row = {
          ...metadata, parents: metadata.parents || [root], trashed: false, ownedByMe: true, shared: false,
          isAppAuthorized: true, size: String(bytes?.length || 0), modifiedTime: '2026-01-20T01:00:00.000Z',
          capabilities: { canAddChildren: !bytes, canDownload: Boolean(bytes) },
        };
        remote.set(metadata.id, { row, bytes });
        return Response.json(row);
      }
      if (pathname === filesBase + '/generateIds') return Response.json({ ids: ['allocated_' + ++generated], space: 'drive' });
      if (pathname === filesBase + '/root') return Response.json({ id: root, mimeType: folderMime, trashed: false });
      if (pathname === filesBase) {
        const query = url.searchParams.get('q') ?? '';
        if (!query.includes('grooveboxKind')) return Response.json({ files: [song] });
        const found = [...remote.values()].map(({ row }) => row)
          .filter(row => query.includes(row.appProperties.grooveboxKind) && query.includes("'" + row.parents[0] + "' in parents"));
        return Response.json({ files: found });
      }
      const id = pathname.slice(filesBase.length + 1);
      const record = id === file ? { row: song, bytes: audio } : remote.get(id);
      if (!record) return Response.json({}, { status: 404 });
      return url.searchParams.get('alt') === 'media'
        ? mediaResponse(record.bytes, record.row.mimeType, options) : Response.json(record.row);
    },
  });

  try {
    const login = await page.request.get(origin + '/api/gdrive/connect', { maxRedirects: 0 });
    expect(login.status()).toBe(303);
    const stateCode = new URL(login.headers().location).searchParams.get('state');
    const playback = await page.request.get(origin + '/api/gdrive/callback?' + new URLSearchParams({
      state: stateCode, code: 'playback-consent',
    }), { maxRedirects: 0 });
    expect(playback.headers().location).toBe('/?gdrive=connected');
    await page.route('https://accounts.google.com/o/oauth2/v2/auth?**', route => {
      const auth = new URL(route.request().url());
      expect(auth.searchParams.get('scope')).toBe(writeScope);
      expect(auth.searchParams.get('include_granted_scopes')).toBe('true');
      const url = new URL('/api/gdrive/callback', origin);
      url.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'backup-consent' });
      return route.fulfill({ contentType: 'text/html', body: '<a href="' + url.href + '">Grant fixture access</a>' });
    });

    await initialize(page, { playlists: [{ id: originalList, name: '服务器接口歌单', tracks: [trackId, trackId] }] });
    await page.goto(origin + '/#sources');
    await action(page, 'gdrive-playlist-backup').press('Enter');
    await action(page, 'gdrive-backup-authorize').press('Enter');
    await page.getByRole('link', { name: 'Grant fixture access' }).click();
    await expect(action(page, 'gdrive-backup-upload')).toBeEnabled();
    await dismissDialog(page);
    await page.goto(origin + '/#sources');
    await googleCard(page).press('Enter');
    await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
    const verifiedAccount = (await state(page)).tracks.find(track => track.id === trackId).backupAccount;
    expect(verifiedAccount).toMatch(/^[\w-]{43}$/);
    await action(page, 'gdrive-playlist-backup').press('Enter');
    await action(page, 'gdrive-backup-upload').press('Enter');
    expect(uploads).toHaveLength(0);
    const [storedResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/gdrive/backup' && response.request().method() === 'PUT'),
      action(page, 'gdrive-backup-confirm-upload').press('Enter'),
    ]);
    expect(storedResponse.status(), await storedResponse.text()).toBe(200);
    await expect(status(page)).toContainText('歌单备份已上传');
    expect(uploads).toHaveLength(1);
    expect(readPlaylistSnapshot(uploads[0], { provider: 'gdrive', account: verifiedAccount }).tracks[0].file).toBe(file);
    expect([...remote.values()].map(item => item.row.mimeType)).toEqual([folderMime, 'application/json']);

    await action(page, 'gdrive-backup-preview').press('Enter');
    await action(page, 'gdrive-backup-restore').press('Enter');
    await expect(status(page)).toContainText('歌单和收藏已合并');
    await dismissDialog(page);
    await page.locator('#sidebar [data-nav="playlist/' + originalList + '"]').press('Enter');
    await expect(page.locator('#content .track-main')).toHaveCount(2);
    await playVisibleTrack(page);
  } finally {
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
