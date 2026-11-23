import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';
import { createOnedriveHandler } from '../server/onedrive.mjs';

const account = 'O'.repeat(43);
const otherAccount = 'X'.repeat(43);
const file = 'A1B2C3!152';
const trackId = 'onedrive:' + file;
const stream = '/api/onedrive/stream?id=' + file;
const baiduId = 'baidu:502';
const baiduTrack = { id: baiduId, title: '百度曲目', src: '/api/baidu/stream?id=502', provider: 'baidu', backupAccount: account };
const playlistId = 'ad1a9956-629f-406e-9944-e93969fbdaab';
const localId = '57c39ba7-4fec-4244-9446-ffcb79fa542c';
const createdAt = 1_700_000_000_000;
const storageKey = 'groovebox.state.v1';
const authority = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const action = (page, name) => page.locator('[data-action="' + name + '"]');
const card = page => action(page, 'oauth-source').and(page.locator('[data-id="onedrive"]'));
const status = page => page.locator('[data-onedrive-backup-status]');
const state = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);

async function initialize(page, initial = {}) {
  await page.addInitScript(({ key, initial }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { demos: false }, ...initial }));
  }, { key: storageKey, initial });
}

async function mockAudio(page) {
  await page.route('**/api/onedrive/list?**', route => route.fulfill({ json: { items: [{
    id: file, name: '云盘艺人 - 圆舞曲.m4a', path: '/Music/录音.m4a', streamUrl: stream, backupAccount: account,
  }] } }));
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

test('OneDrive backup is opt-in, accepts only the designated Microsoft consent URL, and preserves playback after denial', async ({ page, baseURL }) => {
  let offerBackup = false;
  let startCount = 0;
  let consentCount = 0;
  let safeAuthorize = false;
  await mockAudio(page);
  await page.route('**/api/onedrive/status', route => route.fulfill({
    json: { configured: true, connected: true, ...(offerBackup && { backupAuthorizationAvailable: true }) },
  }));
  await page.route('**/api/onedrive/backup/connect', route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().accept).toContain('application/json');
    startCount++;
    return route.fulfill({ json: { authorizeUrl: (safeAuthorize ? authority : authority.replace('/consumers/', '/common/')) + '?state=synthetic' } });
  });
  await page.route('https://login.microsoftonline.com/**', route => {
    consentCount++;
    expect(new URL(route.request().url()).pathname).toBe(new URL(authority).pathname);
    const callback = new URL('/?onedrive=backup-denied', baseURL);
    return route.fulfill({ contentType: 'text/html', body: '<a href="' + callback.href + '">Deny test consent</a>' });
  });
  await initialize(page);
  await page.goto('/#sources');
  await card(page).press('Enter');
  await expect(page.locator('#content .track-name')).toHaveText('圆舞曲');
  await expect(action(page, 'onedrive-playlist-backup')).toHaveCount(0);
  expect(startCount).toBe(0);

  offerBackup = true;
  await page.goto('/#sources');
  await page.reload();
  await action(page, 'onedrive-playlist-backup').press('Enter');
  expect(startCount).toBe(0);
  await action(page, 'onedrive-backup-authorize').press('Enter');
  await expect.poll(() => startCount).toBe(1);
  await expect(action(page, 'onedrive-backup-authorize')).toBeEnabled();
  expect(consentCount).toBe(0);

  safeAuthorize = true;
  await action(page, 'onedrive-backup-authorize').press('Enter');
  await page.getByRole('link', { name: 'Deny test consent' }).press('Enter');
  await expect(status(page)).toContainText('已取消 OneDrive 歌单备份授权');
  expect(consentCount).toBe(1);
  await dismissDialog(page);
  await card(page).press('Enter');
  await playVisibleTrack(page);
});

test('OneDrive retries exact bytes in the original account and restores duplicate tracks with their original dates', async ({ page, browser, baseURL }) => {
  const writes = [];
  const stored = new Map();
  let selectedAccount = account;
  let backupAllowed = true;
  const setup = async target => {
    await mockAudio(target);
    await target.route('**/api/onedrive/status', route => route.fulfill({ json: {
      configured: true, connected: true, backupAuthorizationAvailable: true, canBackup: backupAllowed,
    } }));
    await target.route(url => url.pathname === '/api/onedrive/backup', route => {
      const request = route.request();
      const params = new URL(request.url()).searchParams;
      const id = params.get('id');
      if (!backupAllowed) return route.fulfill({ status: 403, json: { code: 'backup_scope_required' } });
      const storageId = selectedAccount + ':' + id;
      const prior = stored.get(storageId);
      if (request.method() === 'PUT') {
        const bytes = request.postDataBuffer();
        writes.push({ id, bytes });
        if (prior && !prior.equals(bytes)) return route.fulfill({ status: 409, json: { code: 'snapshot_conflict' } });
        stored.set(storageId, bytes);
        if (!prior) return route.fulfill({ status: 503, json: { code: 'commit_unknown' } });
        return route.fulfill({ json: { id, status: 'already_present' } });
      }
      if (id) {
        expect(params.get('verify')).toBe('1');
        return prior ? route.fulfill({ json: { snapshot: prior.toString(), available: [file] } }) : route.fulfill({ status: 404 });
      }
      return route.fulfill({ json: { account: selectedAccount, snapshots: [...stored].filter(([key]) => key.startsWith(selectedAccount + ':'))
        .map(([key, bytes]) => ({ id: key.split(':')[1], size: bytes.length, modifiedAt: createdAt })) } });
    });
  };
  await setup(page);
  await initialize(page, {
    tracks: [baiduTrack], favorites: [trackId, baiduId],
    playlists: [{ id: playlistId, name: '云端收藏', tracks: [trackId, baiduId, trackId] }],
    playlistCreationDates: [[playlistId, createdAt]],
  });
  await page.goto('/#sources');
  await card(page).press('Enter');
  await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
  expect((await state(page)).tracks.find(track => track.id === trackId)).toMatchObject({ backupAccount: account, src: stream });
  await action(page, 'onedrive-playlist-backup').press('Enter');
  await action(page, 'onedrive-backup-upload').press('Enter');
  expect(writes).toHaveLength(0);
  await action(page, 'onedrive-backup-confirm-upload').press('Enter');
  await expect(status(page)).toContainText('暂无法确认上传结果');
  const first = writes[0];
  const snapshot = readPlaylistSnapshot(first.bytes, { provider: 'onedrive', account });
  expect(snapshot.version).toBe(2);
  expect(snapshot.playlists[0]).toMatchObject({ createdAt, tracks: [0, 1, 0] });
  expect(snapshot.tracks.map(track => track.file)).toEqual([file, undefined]);
  expect(first.bytes.toString()).not.toContain('/api/');

  selectedAccount = otherAccount;
  await page.reload();
  await action(page, 'onedrive-playlist-backup').press('Enter');
  await expect(action(page, 'onedrive-backup-upload')).toHaveText('上传备份');
  await expect(action(page, 'onedrive-backup-preview')).toHaveCount(0);
  await page.evaluate(key => {
    const current = JSON.parse(localStorage.getItem(key));
    current.playlists[0].name = '变更后的本地名称';
    localStorage.setItem(key, JSON.stringify(current));
  }, storageKey);

  selectedAccount = account;
  await page.reload();
  await action(page, 'onedrive-playlist-backup').press('Enter');
  await expect(action(page, 'onedrive-backup-upload')).toHaveText('重试上传');
  await action(page, 'onedrive-backup-upload').press('Enter');
  await action(page, 'onedrive-backup-confirm-upload').press('Enter');
  await expect(status(page)).toContainText('歌单备份已上传');
  expect(writes).toEqual([first, first]);
  expect(stored.size).toBe(1);

  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  try {
    const other = await context.newPage();
    await setup(other);
    await initialize(other, {
      tracks: [baiduTrack], favorites: [baiduId], playlists: [{ id: localId, name: '原有歌单', tracks: [baiduId] }],
    });
    await other.goto('/#sources');
    await action(other, 'onedrive-playlist-backup').press('Enter');
    await action(other, 'onedrive-backup-preview').press('Enter');
    expect((await state(other)).playlists).toHaveLength(1);
    backupAllowed = false;
    await action(other, 'onedrive-backup-restore').press('Enter');
    await expect(action(other, 'onedrive-backup-authorize')).toBeEnabled();
    expect((await state(other)).playlists).toHaveLength(1);
    backupAllowed = true;
    await other.reload();
    await action(other, 'onedrive-playlist-backup').press('Enter');
    for (let attempt = 0; attempt < 2; attempt++) {
      await action(other, 'onedrive-backup-preview').press('Enter');
      await action(other, 'onedrive-backup-restore').press('Enter');
      await expect(status(other)).toContainText('歌单和收藏已合并');
    }
    const restored = await state(other);
    expect(restored.playlists).toEqual([
      { id: localId, name: '原有歌单', tracks: [baiduId] },
      { id: playlistId, name: '云端收藏', tracks: [trackId, trackId] },
    ]);
    expect(restored.playlistCreationDates).toContainEqual([playlistId, createdAt]);
    expect(restored.favorites).toEqual([baiduId, trackId]);
    expect(restored.tracks.find(track => track.id === trackId)).toMatchObject({ provider: 'onedrive', backupAccount: account, src: stream });
    await dismissDialog(other);
    await other.locator('#sidebar [data-nav="playlist/' + playlistId + '"]').press('Enter');
    await expect(other.locator('#content .track-main')).toHaveCount(2);
    await playVisibleTrack(other);
  } finally { await context.close(); }
});

test('connects, separately authorizes, uploads, restores, and plays through the actual OneDrive handler', async ({ page, baseURL }) => {
  const playbackScope = 'https://graph.microsoft.com/Files.Read';
  const backupScope = 'https://graph.microsoft.com/Files.ReadWrite.AppFolder';
  const driveId = 'A1B2C3';
  const root = driveId + '!123';
  const remoteFile = driveId + '!backup';
  const graph = '/v1.0/me/drive';
  const folder = '/items/' + root;
  const uploadUrl = 'https://fixture.up.1drv.com/upload?key=fixture';
  const audioUrl = 'https://fixture.files.1drv.com/audio?key=fixture';
  const backupUrl = 'https://fixture.files.1drv.com/backup?key=fixture';
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const data = await mkdtemp(join(tmpdir(), 'groovebox-onedrive-browser-'));
  const song = { id: file, name: '云盘艺人 - 圆舞曲.m4a', size: audio.length,
    file: { mimeType: 'audio/mp4' }, parentReference: { driveId } };
  const stored = new Map();
  const uploads = [];
  let pending;
  let origin;
  let handler;
  const app = createServer(async (req, res) => {
    try {
      if (await handler(req, res, new URL(req.url, origin))) return;
      const asset = await fetch(new URL(req.url, baseURL));
      const headers = {};
      for (const name of ['content-type', 'content-security-policy']) {
        if (asset.headers.has(name)) headers[name] = asset.headers.get(name);
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
  handler = createOnedriveHandler({
    sessionFile: join(data, 'sessions.enc'),
    env: { ONEDRIVE_CLIENT_ID: 'fixture-client', ONEDRIVE_CLIENT_SECRET: 'fixture-secret',
      ONEDRIVE_REDIRECT_URI: origin + '/api/onedrive/callback', ONEDRIVE_PLAYLIST_BACKUP: '1' },
    async request(raw, options) {
      const url = new URL(raw);
      const headers = new Headers(options.headers);
      const authorization = headers.get('authorization');
      if (url.hostname === 'login.microsoftonline.com') {
        const write = new URLSearchParams(options.body).get('code') === 'backup-consent';
        return Response.json({
          access_token: write ? 'backup-token' : 'playback-token', refresh_token: write ? 'backup-refresh' : 'playback-refresh',
          scope: write ? playbackScope + ' ' + backupScope + ' offline_access' : playbackScope + ' offline_access', expires_in: 3600,
        });
      }
      if (url.href === uploadUrl) {
        expect(authorization).toBeNull();
        expect(options.method).toBe('PUT');
        const bytes = Buffer.from(options.body);
        expect(headers.get('content-range')).toBe(`bytes 0-${bytes.length - 1}/${bytes.length}`);
        uploads.push(bytes);
        const item = { id: remoteFile, name: pending, file: {}, size: bytes.length, eTag: '"fixture-revision"',
          lastModifiedDateTime: '2026-01-20T01:00:00.000Z', parentReference: { id: root, driveId } };
        stored.set(pending, { item, bytes });
        return Response.json(item, { status: 201 });
      }
      if (url.href === backupUrl) {
        expect(authorization).toBeNull();
        return new Response([...stored.values()][0].bytes);
      }
      if (url.href === audioUrl) {
        expect(authorization).toBeNull();
        const range = /^bytes=(\d+)-(\d*)$/.exec(headers.get('range') || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
        return new Response(options.method === 'HEAD' ? null : audio.subarray(start, end + 1), {
          status: range ? 206 : 200, headers: { 'Content-Type': 'audio/mp4', 'Content-Length': end - start + 1,
            ...(range && { 'Content-Range': `bytes ${start}-${end}/${audio.length}` }) },
        });
      }
      expect(url.hostname).toBe('graph.microsoft.com');
      expect(['Bearer playback-token', 'Bearer backup-token']).toContain(authorization);
      if (url.pathname === graph) return Response.json({ id: driveId, driveType: 'personal', owner: { user: { id: 'fixture-owner' } } });
      const itemPath = url.pathname.slice(graph.length);
      if (itemPath === '/root/children') return Response.json({ value: [song] });
      if (itemPath === '/items/' + file) return Response.json(song);
      if (itemPath === '/items/' + file + '/content') {
        expect(authorization).toBe('Bearer playback-token');
        return Response.redirect(audioUrl);
      }
      expect(authorization).toBe('Bearer backup-token');
      if (itemPath === '/special/approot') {
        return Response.json({ id: root, folder: {}, specialFolder: { name: 'approot' }, parentReference: { driveId } });
      }
      if (itemPath === folder + '/children') return Response.json({ value: [...stored.values()].map(value => value.item) });
      if (itemPath === '/items/' + remoteFile + '/content') return Response.redirect(backupUrl);
      const name = itemPath.slice((folder + ':/').length).split(':')[0];
      if (itemPath === folder + ':/' + name + ':/createUploadSession') {
        expect(options.method).toBe('POST');
        expect(JSON.parse(options.body).item).toEqual({ name, '@microsoft.graph.conflictBehavior': 'fail' });
        pending = name;
        return Response.json({ uploadUrl });
      }
      const snapshot = stored.get(name);
      return snapshot ? Response.json(snapshot.item) : Response.json({}, { status: 404 });
    },
  });

  try {
    const login = await page.request.get(origin + '/api/onedrive/connect', { maxRedirects: 0 });
    expect(login.status()).toBe(303);
    const playbackAuthorize = new URL(login.headers().location);
    expect(playbackAuthorize.searchParams.get('scope').split(' ')).toEqual([playbackScope, 'offline_access']);
    const playback = await page.request.get(origin + '/api/onedrive/callback?' + new URLSearchParams({
      state: playbackAuthorize.searchParams.get('state'), code: 'playback-consent',
    }), { maxRedirects: 0 });
    expect(playback.headers().location).toBe('/?onedrive=connected');
    await page.route(authority + '?**', route => {
      const auth = new URL(route.request().url());
      const scopes = auth.searchParams.get('scope').split(' ');
      expect(scopes).toContain(backupScope);
      expect(scopes).not.toContain('https://graph.microsoft.com/Files.ReadWrite');
      const callback = new URL('/api/onedrive/callback', origin);
      callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'backup-consent' });
      return route.fulfill({ contentType: 'text/html', body: '<a href="' + callback.href + '">Grant app-folder fixture access</a>' });
    });
    await initialize(page, {
      playlists: [{ id: playlistId, name: '服务器接口歌单', tracks: [trackId, trackId] }],
      playlistCreationDates: [[playlistId, createdAt]],
    });
    await page.goto(origin + '/#sources');
    await action(page, 'onedrive-playlist-backup').press('Enter');
    await action(page, 'onedrive-backup-authorize').press('Enter');
    await page.getByRole('link', { name: 'Grant app-folder fixture access' }).press('Enter');
    await expect(action(page, 'onedrive-backup-upload')).toBeEnabled();
    await dismissDialog(page);
    await card(page).press('Enter');
    await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
    const verifiedAccount = (await state(page)).tracks.find(track => track.id === trackId).backupAccount;
    expect(verifiedAccount).toMatch(/^[\w-]{43}$/);

    await action(page, 'onedrive-playlist-backup').press('Enter');
    await action(page, 'onedrive-backup-upload').press('Enter');
    expect(uploads).toHaveLength(0);
    await action(page, 'onedrive-backup-confirm-upload').press('Enter');
    await expect(status(page)).toContainText('歌单备份已上传');
    expect(uploads).toHaveLength(1);
    const snapshot = readPlaylistSnapshot(uploads[0], { provider: 'onedrive', account: verifiedAccount });
    expect(snapshot.tracks[0].file).toBe(file);
    expect(snapshot.playlists[0]).toMatchObject({ createdAt, tracks: [0, 0] });

    await action(page, 'onedrive-backup-preview').press('Enter');
    await action(page, 'onedrive-backup-restore').press('Enter');
    await expect(status(page)).toContainText('歌单和收藏已合并');
    await dismissDialog(page);
    await page.locator('#sidebar [data-nav="playlist/' + playlistId + '"]').press('Enter');
    await expect(page.locator('#content .track-main')).toHaveCount(2);
    await playVisibleTrack(page);
  } finally {
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
    await rm(data, { recursive: true, force: true });
  }
});
