import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { expect, test } from '@playwright/test';
import { createDropboxHandler } from '../server/dropbox.mjs';
import { readPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';

const id = 'id:song-LmN_920';
const trackId = 'dropbox:' + id;
const playlistId = '6ce73fd5-6ec0-4523-99ac-8e9c3e9baaaf';
const stream = '/api/dropbox/stream?id=' + encodeURIComponent(id);
const action = (page, name) => page.locator('[data-action="' + name + '"]');
const dropboxCard = page => page.locator('[data-action="oauth-source"][data-id="dropbox"]');
const status = page => page.locator('[data-dropbox-backup-status]');
const state = page => page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')));

test('reconnects legacy Dropbox playback before requesting backup consent and preserves playback after denial', async ({ page, baseURL }) => {
  let legacy = true;
  let reconnects = 0;
  let approvals = 0;
  let archiveCalls = 0;
  await page.route('**/api/dropbox/status', route => route.fulfill({ json: {
    configured: true, connected: true, ...(legacy ? { backupReconnectRequired: true } : { backupAuthorizationAvailable: true }),
  } }));
  await page.route('**/api/dropbox/connect', route => {
    expect(route.request().method()).toBe('GET');
    reconnects++;
    legacy = false;
    return route.fulfill({ contentType: 'text/html', body: '<a href="/?dropbox=connected">Return with playback access</a>' });
  });
  await page.route('**/api/dropbox/backup/connect', route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().accept).toContain('application/json');
    approvals++;
    return route.fulfill({ json: { authorizeUrl: 'https://www.dropbox.com/oauth2/authorize?state=fixture' } });
  });
  await page.route('https://www.dropbox.com/oauth2/authorize?**', route => route.fulfill({
    contentType: 'text/html', body: '<a href="' + new URL('/?dropbox=backup-denied', baseURL) + '">Return without backup access</a>',
  }));
  await page.route(url => url.pathname === '/api/dropbox/backup', route => {
    archiveCalls++;
    return route.abort();
  });
  await page.route('**/api/dropbox/list?**', route => route.fulfill({ json: { items: [
    { id, name: 'Dropbox Artist - Dropbox Song.m4a', path: '/song.m4a', streamUrl: stream },
  ] } }));
  await page.route(url => url.pathname === '/api/dropbox/stream' && url.searchParams.get('id') === id, async route => {
    const response = await route.fetch({ url: new URL('/assets/demo-1.m4a', route.request().url()).href });
    await route.fulfill({ response });
  });
  await page.goto('/#sources');
  await action(page, 'dropbox-playlist-backup').click();
  await expect(action(page, 'dropbox-backup-authorize')).toHaveCount(0);
  await action(page, 'dropbox-backup-reconnect').click();
  await page.getByRole('link', { name: 'Return with playback access' }).click();
  await expect(page.locator('#content .track-name')).toHaveText('Dropbox Song');
  await action(page, 'dropbox-playlist-backup').click();
  expect(approvals).toBe(0);
  await action(page, 'dropbox-backup-authorize').click();
  await page.getByRole('link', { name: 'Return without backup access' }).click();
  await expect(status(page)).toContainText('已取消 Dropbox 歌单备份授权');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await dropboxCard(page).click();
  await page.locator('#content .track-main').click();
  await expect.poll(() => page.locator('#audio').evaluate(audio => !audio.paused && audio.currentTime > 0.1)).toBe(true);
  expect([reconnects, approvals, archiveCalls]).toEqual([1, 1, 0]);
});

test('uploads, reads, and plays via the actual Dropbox application handler with a simulated upstream', async ({ page, baseURL }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const audioRow = { '.tag': 'file', id, name: 'Dropbox Artist - Dropbox Song.m4a',
    path_lower: '/dropbox-artist-song.m4a', size: audio.length, is_downloadable: true };
  const objects = new Map();
  const uploads = [];
  const readScope = 'files.metadata.read files.content.read';
  const scopes = readScope + ' account_info.read files.content.write';
  const accountId = 'dbid:synthetic-owner';
  let origin;
  let handler;

  const app = createServer(async (req, res) => {
    try {
      if (await handler(req, res, new URL(req.url, origin))) return;
      const asset = await fetch(new URL(req.url, baseURL));
      const headers = Object.fromEntries([...asset.headers].filter(([key]) => ['content-security-policy', 'content-type'].includes(key)));
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
  handler = createDropboxHandler({
    env: {
      DROPBOX_CLIENT_ID: 'synthetic-client', DROPBOX_CLIENT_SECRET: 'fixture-only-secret',
      DROPBOX_REDIRECT_URI: origin + '/api/dropbox/callback', DROPBOX_PLAYLIST_BACKUP: '1',
    },
    async request(raw, options) {
      const url = new URL(raw);
      const header = new Headers(options.headers);
      if (url.pathname === '/oauth2/token') {
        const upgrade = new URLSearchParams(options.body).get('code') === 'backup-consent';
        return Response.json({
          access_token: upgrade ? 'backup-token' : 'playback-token',
          refresh_token: upgrade ? 'backup-refresh' : 'playback-refresh',
          expires_in: 3600, token_type: 'bearer', scope: upgrade ? scopes : readScope, account_id: accountId,
        });
      }
      const token = header.get('authorization');
      expect(['Bearer playback-token', 'Bearer backup-token']).toContain(token);
      if (url.pathname === '/2/users/get_current_account') return Response.json({ account_id: accountId, disabled: false });
      const args = JSON.parse(header.get('dropbox-api-arg') || options.body || '{}');
      const path = args.path;
      const existing = path === id ? { metadata: audioRow, bytes: audio }
        : objects.get(path) || [...objects.values()].find(row => row.metadata.id === path);
      const missing = () => Response.json({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, { status: 409 });
      if (url.pathname === '/2/files/get_metadata') return existing ? Response.json(existing.metadata) : missing();
      if (url.pathname === '/2/files/list_folder') {
        if (!path) return Response.json({ entries: [audioRow], cursor: '1', has_more: false });
        if (existing?.metadata['.tag'] !== 'folder') return missing();
        const entries = [...objects.values()].map(row => row.metadata).filter(row =>
          row['.tag'] === 'file' && row.path_lower.startsWith(existing.metadata.path_lower + '/'));
        return Response.json({ entries, cursor: 'adaptive-1', has_more: false });
      }
      if (url.pathname === '/2/files/create_folder_v2') {
        expect(token).toBe('Bearer backup-token');
        expect(args.autorename).toBe(false);
        const metadata = { '.tag': 'folder', id: 'id:fixture-folder', name: path.slice(1), path_lower: path };
        objects.set(path, { metadata });
        return Response.json({ metadata });
      }
      if (url.pathname === '/2/files/upload') {
        expect(token).toBe('Bearer backup-token');
        expect(args).toMatchObject({ mode: 'add', strict_conflict: true, autorename: false });
        const bytes = Buffer.from(options.body);
        const contentHash = createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest('hex');
        expect(args.content_hash).toBe(contentHash);
        const metadata = {
          '.tag': 'file', id: 'id:fixture-backup', name: path.split('/').at(-1), path_lower: path,
          size: bytes.length, rev: 'abcdef123456', content_hash: contentHash, is_downloadable: true,
          has_explicit_shared_members: false, server_modified: '2026-01-01T10:00:00Z',
        };
        uploads.push(bytes);
        objects.set(path, { metadata, bytes });
        return Response.json(metadata);
      }
      if (url.pathname === '/2/files/download' && existing?.bytes) {
        const bytes = existing.bytes;
        const range = /^bytes=(\d+)-(\d*)$/.exec(header.get('range') || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        return new Response(bytes.subarray(start, end + 1), { status: range ? 206 : 200, headers: {
          'Dropbox-API-Result': JSON.stringify(existing.metadata), 'Content-Length': end - start + 1,
          'Content-Type': path === id ? 'audio/mp4' : 'application/octet-stream',
          ...(range && { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }),
        } });
      }
      return missing();
    },
  });

  try {
    const login = await page.request.get(origin + '/api/dropbox/connect', { maxRedirects: 0 });
    expect(login.status()).toBe(303);
    const stateCode = new URL(login.headers().location).searchParams.get('state');
    const playback = await page.request.get(origin + '/api/dropbox/callback?' + new URLSearchParams({
      state: stateCode, code: 'playback-consent',
    }), { maxRedirects: 0 });
    expect(playback.headers().location).toBe('/?dropbox=connected');
    await page.route('https://www.dropbox.com/oauth2/authorize?**', route => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('include_granted_scopes')).toBe('user');
      expect(url.searchParams.get('scope')).toContain('files.content.write');
      const callback = new URL('/api/dropbox/callback', origin);
      callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'backup-consent' });
      return route.fulfill({ contentType: 'text/html', body: '<a href="' + callback.href + '">Authorize fixture backup</a>' });
    });
    await page.addInitScript(({ playlistId, trackId }) => {
      const key = 'groovebox.state.v1';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
        settings: { demos: false }, playlists: [{ id: playlistId, name: 'Dropbox 测试歌单', tracks: [trackId, trackId] }],
      }));
    }, { playlistId, trackId });
    await page.goto(origin + '/#sources');
    await action(page, 'dropbox-playlist-backup').click();
    await action(page, 'dropbox-backup-authorize').click();
    await page.getByRole('link', { name: 'Authorize fixture backup' }).click();
    await expect(action(page, 'dropbox-backup-upload')).toBeEnabled();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await dropboxCard(page).click();
    await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
    const track = (await state(page)).tracks.find(item => item.id === trackId);
    expect(track).toMatchObject({ src: stream, backupAccount: expect.stringMatching(/^[\w-]{43}$/) });
    await action(page, 'dropbox-playlist-backup').click();
    await action(page, 'dropbox-backup-upload').click();
    expect(uploads).toHaveLength(0);
    const [response] = await Promise.all([
      page.waitForResponse(value => new URL(value.url()).pathname === '/api/dropbox/backup' && value.request().method() === 'PUT'),
      action(page, 'dropbox-backup-confirm-upload').click(),
    ]);
    expect(response.status(), await response.text()).toBe(200);
    await expect(status(page)).toContainText('歌单备份已上传');
    expect(uploads).toHaveLength(1);
    const snapshot = readPlaylistSnapshot(uploads[0], { provider: 'dropbox', account: track.backupAccount });
    expect(snapshot.tracks[0].file).toBe(id);
    expect(snapshot.playlists[0].tracks).toEqual([0, 0]);
    await action(page, 'dropbox-backup-preview').click();
    await action(page, 'dropbox-backup-restore').click();
    await expect(status(page)).toContainText('歌单和收藏已合并');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('#sidebar [data-nav="playlist/' + playlistId + '"]').click();
    await expect(page.locator('#content .track-main')).toHaveCount(2);
    await page.locator('#content .track-main').first().click();
    await expect.poll(() => page.locator('#audio').evaluate(audio => !audio.paused && audio.currentTime > 0.1)).toBe(true);
  } finally {
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  }
});
