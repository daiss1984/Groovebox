import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createBaiduHandler } from '../server/baidu.mjs';
import { readFile } from 'node:fs/promises';
import { createPlaylistSnapshot, readPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';

const account = 'c'.repeat(43);
const recordingId = '9223372036854775807';
const recording = 'baidu:' + recordingId;
const localOnly = 'local:fixture';
const oldBaidu = 'baidu:1776';
const playlistId = 'c3352be1-6760-4eb4-9afa-696aac54c844';
const untouchedId = '7104b7c8-f6d7-4943-959f-d297d6ea4b5d';
const savedModification = Date.UTC(2025, 6, 7);
const newerModification = Date.UTC(2025, 6, 9);
const stream = '/api/baidu/stream?id=' + recordingId;
const stateKey = 'groovebox.state.v1';
const action = (page, name) => page.locator('[data-action="' + name + '"]');
const nav = (page, value) => page.locator('#sidebar [data-nav="' + value + '"]');
const localState = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), stateKey);

async function initialize(page, state) {
  await page.addInitScript(({ state, key }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { state: { settings: { demos: false }, ...state }, key: stateKey });
}

test('requires confirmation, retries the same immutable backup, and restores playable Baidu tracks into a second browser profile', async ({ page, browser, baseURL }) => {
  const bookings = new Map();
  const uploads = [];
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  let rejectAcknowledgement = true;
  let previewAccount = account;
  let restoreAvailable = true;
  const provider = async target => {
    await target.route('**/api/baidu/status', route => route.fulfill({
      json: { configured: true, connected: true, canBackup: true },
    }));
    await target.route('**/api/baidu/list?**', route => route.fulfill({ json: { items: [{
      id: recordingId, name: '归档艺人 - 档案录音.m4a', path: '/Album/recording.m4a',
      streamUrl: stream, backupAccount: account,
    }] } }));
    await target.route(url => url.pathname === '/api/baidu/backup', async route => {
      const req = route.request();
      const id = new URL(req.url()).searchParams.get('id');
      if (req.method() === 'PUT') {
        const bytes = req.postDataBuffer();
        uploads.push({ id, bytes });
        const existing = bookings.get(id);
        if (existing && !existing.equals(bytes)) {
          return route.fulfill({ status: 409, json: { code: 'snapshot_conflict' } });
        }
        bookings.set(id, bytes);
        if (rejectAcknowledgement) {
          rejectAcknowledgement = false;
          return route.fulfill({ status: 503, json: { code: 'commit_unknown' } });
        }
        return route.fulfill({ json: { id, status: existing ? 'already_present' : 'saved' } });
      }
      if (id && previewAccount !== account) {
        return route.fulfill({ status: 404, json: { code: 'snapshot_not_found' } });
      }
      if (id) {
        expect(new URL(req.url()).searchParams.get('verify')).toBe('1');
        return route.fulfill({ json: {
          snapshot: bookings.get(id).toString(), available: restoreAvailable ? [recordingId] : [],
        } });
      }
      return route.fulfill({ json: {
        account: previewAccount,
        snapshots: [...bookings].map(([id, bytes]) => ({
          id, name: 'groovebox-playlists-' + id + '.json', size: bytes.length, modifiedAt: 1_770_000_000_000,
        })),
      } });
    });
    await target.route('**' + stream, route => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      if (!range) return route.fulfill({ contentType: 'audio/mp4', body: audio, headers: { 'Accept-Ranges': 'bytes' } });
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      return route.fulfill({
        status: 206, contentType: 'audio/mp4', body: audio.subarray(start, end + 1),
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${audio.length}` },
      });
    });
  };
  await provider(page);
  await initialize(page, {
    tracks: [
      { id: localOnly, title: '仅本地', provider: 'local', path: '/Users/private/recording.wav' },
      { id: oldBaidu, title: '旧账号歌', provider: 'baidu', src: '/api/baidu/stream?id=1776', backupAccount: 'd'.repeat(43) },
    ],
    playlists: [{ id: playlistId, name: '云端收藏归档', tracks: [recording, localOnly, recording, oldBaidu] }],
    playlistModificationDates: [[playlistId, savedModification]],
    favorites: [recording],
  });
  await page.goto('/#sources');
  await action(page, 'baidu-source').press('Enter');
  await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
  let current = await localState(page);
  expect(current.tracks.find(track => track.id === recording).backupAccount).toBe(account);

  await action(page, 'baidu-playlist-backup').press('Enter');
  await action(page, 'baidu-backup-upload').press('Enter');
  expect(uploads).toHaveLength(0);
  await action(page, 'baidu-backup-confirm-upload').press('Enter');
  await expect.poll(() => uploads.length).toBe(1);
  const first = uploads[0];
  const snapshot = readPlaylistSnapshot(first.bytes, { provider: 'baidu', account });
  expect(snapshot.version).toBe(3);
  expect(snapshot.operation).toBe(first.id);
  expect(snapshot.playlists).toEqual([{ id: playlistId, modifiedAt: savedModification, name: '云端收藏归档', tracks: [0, 1, 0, 2] }]);
  expect(() => readPlaylistSnapshot(first.bytes, { provider: 'baidu', account: 'e'.repeat(43) })).toThrow(/different cloud account/);
  expect(snapshot.tracks.map(track => track.file)).toEqual([recordingId, undefined, undefined]);
  for (const privateText of ['/Users/', '/Album/', '/api/', 'access_token', '1776']) {
    expect(first.bytes.toString()).not.toContain(privateText);
  }

  await expect(page.locator('[data-baidu-backup-status]')).toContainText('暂无法确认上传结果');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).press('Enter');
  await nav(page, 'playlist/' + playlistId).press('Enter');
  await page.clock.setFixedTime(newerModification);
  await page.getByRole('button', { name: '重命名', exact: true }).press('Enter');
  await page.getByRole('dialog').getByRole('textbox').fill('修改后的本地归档');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).press('Enter');
  expect((await localState(page)).playlistModificationDates).toEqual([[playlistId, newerModification]]);
  await nav(page, 'sources').press('Enter');
  await page.reload();
  await action(page, 'baidu-playlist-backup').press('Enter');
  await action(page, 'baidu-backup-upload').press('Enter');
  await action(page, 'baidu-backup-confirm-upload').press('Enter');
  await expect.poll(() => uploads.length).toBe(2);
  expect(uploads[1]).toEqual(first);
  expect(bookings.size).toBe(1);

  await expect(page.locator('[data-baidu-backup-status]')).toContainText('歌单备份已上传');
  rejectAcknowledgement = true;
  await action(page, 'baidu-backup-upload').press('Enter');
  await action(page, 'baidu-backup-confirm-upload').press('Enter');
  await expect(page.locator('[data-baidu-backup-status]')).toContainText('暂无法确认上传结果');
  expect(uploads[2].id).not.toBe(first.id);
  expect(readPlaylistSnapshot(uploads[2].bytes, { provider: 'baidu', account }).playlists[0]).toMatchObject({
    name: '修改后的本地归档', modifiedAt: newerModification,
  });
  await action(page, 'baidu-backup-discard-retry').press('Enter');
  await expect(page.locator('[data-baidu-backup-status]')).toContainText('已清除本机重试记录');
  await expect(action(page, 'baidu-backup-upload')).toHaveText('上传备份');
  expect(bookings.size).toBe(2);

  const other = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  try {
    const receiver = await other.newPage();
    await provider(receiver);
    await initialize(receiver, {
      tracks: [{ id: localOnly, title: '原有本机歌曲', provider: 'local' }],
      playlists: [{ id: untouchedId, name: '原有歌单', tracks: [localOnly] }],
      favorites: [localOnly],
    });
    const preview = action(receiver, 'baidu-backup-preview').and(receiver.locator('[data-id="' + first.id + '"]'));
    await receiver.goto('/#sources');
    await action(receiver, 'baidu-playlist-backup').press('Enter');
    await preview.press('Enter');
    await expect(action(receiver, 'baidu-backup-restore')).toBeEnabled();
    expect((await localState(receiver)).playlists).toHaveLength(1);

    previewAccount = 'e'.repeat(43);
    await action(receiver, 'baidu-backup-restore').press('Enter');
    await expect(receiver.locator('[data-baidu-backup-status]')).toContainText('找不到此歌单备份');
    expect((await localState(receiver)).playlists).toHaveLength(1);

    previewAccount = account;
    await receiver.reload();
    await action(receiver, 'baidu-playlist-backup').press('Enter');
    await preview.press('Enter');
    await expect(action(receiver, 'baidu-backup-restore')).toBeEnabled();
    restoreAvailable = false;
    await action(receiver, 'baidu-backup-restore').press('Enter');
    await expect(receiver.locator('[data-baidu-backup-status]')).toContainText('请重新预览');
    expect((await localState(receiver)).playlists).toHaveLength(1);

    restoreAvailable = true;
    await action(receiver, 'baidu-backup-list').press('Enter');
    await preview.press('Enter');
    await action(receiver, 'baidu-backup-restore').press('Enter');
    await expect.poll(async () => (await localState(receiver)).playlists.length).toBe(2);
    current = await localState(receiver);
    expect(current.playlists).toEqual([
      { id: untouchedId, name: '原有歌单', tracks: [localOnly] },
      { id: playlistId, name: '云端收藏归档', tracks: [recording, recording] },
    ]);
    expect(current.favorites).toEqual([localOnly, recording]);
    expect(current.playlistModificationDates).toEqual([[playlistId, savedModification]]);
    expect(current.tracks.find(track => track.id === recording)).toMatchObject({ src: stream, backupAccount: account });

    await receiver.reload();
    await action(receiver, 'baidu-playlist-backup').press('Enter');
    await preview.press('Enter');
    await action(receiver, 'baidu-backup-restore').press('Enter');
    await expect(receiver.locator('[data-baidu-backup-status]')).toContainText('歌单和收藏已合并');
    expect((await localState(receiver)).playlists).toEqual(current.playlists);
    expect((await localState(receiver)).playlistModificationDates).toEqual(current.playlistModificationDates);

    await receiver.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).press('Enter');
    await nav(receiver, 'playlist/' + playlistId).press('Enter');
    const rows = receiver.locator('#content .track-main');
    await expect(rows).toHaveCount(2);
    await rows.first().press('Enter');
    await expect.poll(() => receiver.locator('#audio').evaluate(el => el.currentTime)).toBeGreaterThan(0.1);
  } finally {
    await other.close();
  }
});

test('preserves local playlists when browser storage is full or another tab changes them during restore', async ({ page }) => {
  const operation = '23882d46-fdaf-4835-8a62-3d504c8bb1aa';
  const original = {
    tracks: [{ id: localOnly, title: '原有歌曲', provider: 'local' }],
    playlists: [{ id: untouchedId, name: '原有歌单', tracks: [localOnly] }],
    playlistModificationDates: [[untouchedId, savedModification]],
    favorites: [localOnly],
  };
  const snapshot = createPlaylistSnapshot({
    tracks: [{ id: recording, title: '恢复的录音', provider: 'baidu' }],
    playlists: [
      { id: untouchedId, name: '备份中的原有歌单', tracks: [recording] },
      { id: playlistId, name: '恢复的歌单', tracks: [recording] },
    ],
    playlistModificationDates: [[untouchedId, savedModification - 1], [playlistId, savedModification - 2]],
    favorites: [recording],
  }, { scope: { provider: 'baidu', account }, operation, verifiedFiles: new Map([[recording, recordingId]]) });
  await initialize(page, original);
  await page.route('**/api/baidu/status', route => route.fulfill({
    json: { configured: true, connected: true, canBackup: true },
  }));
  await page.route(url => url.pathname === '/api/baidu/backup', route => route.fulfill({
    json: new URL(route.request().url()).searchParams.has('id')
      ? { snapshot: new TextDecoder().decode(snapshot), available: [recordingId] }
      : { account, snapshots: [{ id: operation, modifiedAt: 1_770_000_000_000 }] },
  }));
  await page.goto('/#sources');
  await action(page, 'baidu-playlist-backup').press('Enter');
  await action(page, 'baidu-backup-preview').press('Enter');
  await expect(action(page, 'baidu-backup-restore')).toBeEnabled();
  await page.evaluate(({ key, id }) => {
    const setItem = Storage.prototype.setItem;
    sessionStorage.setItem('test-baidu-quota', '1');
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === key && value.includes(id) && sessionStorage.getItem('test-baidu-quota')) {
        throw new DOMException('Test storage quota exhausted', 'QuotaExceededError');
      }
      return setItem.call(this, name, value);
    };
  }, { key: stateKey, id: recording });
  await action(page, 'baidu-backup-restore').press('Enter');
  await expect(page.locator('[data-baidu-backup-status]')).toContainText('无法保存恢复的歌单');
  expect(await localState(page)).toMatchObject(original);

  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).press('Enter');
  await expect(nav(page, 'playlist/' + playlistId)).toHaveCount(0);
  await nav(page, 'playlist/' + untouchedId).press('Enter');
  await expect(page.locator('#content .track-name')).toHaveText(['原有歌曲']);

  await page.evaluate(() => sessionStorage.removeItem('test-baidu-quota'));
  await nav(page, 'sources').press('Enter');
  await action(page, 'baidu-playlist-backup').press('Enter');
  await action(page, 'baidu-backup-preview').press('Enter');
  await expect(action(page, 'baidu-backup-restore')).toBeEnabled();
  const tab = await page.context().newPage();
  try {
    await tab.route('**/playlist-date-only-tab', route => route.fulfill({ contentType: 'text/html', body: '<title>Second tab</title>' }));
    await tab.goto('/playlist-date-only-tab');
    await tab.evaluate(({ key, id, date }) => {
      const stored = JSON.parse(localStorage.getItem(key));
      stored.playlistModificationDates = [[id, date]];
      localStorage.setItem(key, JSON.stringify(stored));
    }, { key: stateKey, id: untouchedId, date: newerModification });
  } finally { await tab.close(); }
  await action(page, 'baidu-backup-restore').press('Enter');
  await expect(page.locator('[data-baidu-backup-status]')).toContainText('请刷新页面后恢复');
  expect((await localState(page)).playlists).toEqual(original.playlists);
  expect((await localState(page)).playlistModificationDates).toEqual([[untouchedId, newerModification]]);

  await page.reload();
  await action(page, 'baidu-playlist-backup').press('Enter');
  await action(page, 'baidu-backup-preview').press('Enter');
  await action(page, 'baidu-backup-restore').press('Enter');
  await expect(page.locator('[data-baidu-backup-status]')).toContainText('歌单和收藏已合并');
  expect((await localState(page)).favorites).toEqual([localOnly, recording]);
  expect((await localState(page)).playlists[0].name).toBe(original.playlists[0].name);
  expect((await localState(page)).playlistModificationDates).toEqual([[untouchedId, newerModification], [playlistId, savedModification - 2]]);
});

test('leaves the backup controls hidden for a connected Baidu app without backup enabled', async ({ page }) => {
  let backupRequests = 0;
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/baidu/backup**', route => {
    backupRequests++;
    return route.abort();
  });
  await page.goto('/#sources');
  await action(page, 'baidu-source').press('Enter');
  await expect(page.getByRole('button', { name: '扫描并加入曲库', exact: true })).toBeVisible();
  await expect(action(page, 'baidu-playlist-backup')).toHaveCount(0);
  expect(backupRequests).toBe(0);
});

test('uploads and reads a backup through the server OAuth session and scoped Netdisk adapter', async ({ page, baseURL }) => {
  const parent = '/apps/Groovebox Test';
  const directory = parent + '/groovebox-backups';
  const audioPath = '/Music/Server Archive.m4a';
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const snapshots = new Map();
  const pending = new Map();
  const writes = [];
  let directoryExists = false;
  let origin;
  let handler;
  const app = createServer(async (req, res) => {
    try {
      if (await handler(req, res, new URL(req.url, origin))) return;
      const asset = await fetch(new URL(req.url, baseURL));
      res.writeHead(asset.status, { 'Content-Type': asset.headers.get('content-type') || 'application/octet-stream' });
      if (req.method === 'HEAD' || !asset.body) return res.end();
      Readable.fromWeb(asset.body).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  origin = 'http://127.0.0.1:' + app.address().port;
  handler = createBaiduHandler({
    env: {
      BAIDU_CLIENT_ID: 'synthetic-client', BAIDU_CLIENT_SECRET: 'synthetic-secret',
      BAIDU_REDIRECT_URI: origin + '/api/baidu/callback', BAIDU_BACKUP_APP_FOLDER: parent,
    },
    async request(raw, init) {
      const url = new URL(raw);
      if (url.hostname === 'd.pcs.baidu.com' && !url.pathname.endsWith('/superfile2')) {
        const value = url.pathname === '/recording' ? audio : snapshots.get(url.pathname.slice(1))?.bytes;
        if (!value) return new Response(null, { status: 404 });
        const range = /^bytes=(\d+)-(\d*)$/.exec(init.headers?.Range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), value.length - 1) : value.length - 1;
        const mime = url.pathname === '/recording' ? 'audio/mp4' : 'application/octet-stream';
        return new Response(init.method === 'HEAD' ? null : value.subarray(start, end + 1), {
          status: range ? 206 : 200, headers: {
            'Content-Type': mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
            ...(range && { 'Content-Range': `bytes ${start}-${end}/${value.length}` }),
          },
        });
      }
      if (url.pathname.endsWith('/token')) {
        return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 });
      }
      expect(url.searchParams.get('access_token')).toBe('test-access');
      const method = url.searchParams.get('method');
      if (method === 'uinfo') return new Response('{"errno":0,"uk":9223372036854775802}');
      const media = {
        fs_id: recordingId, isdir: 0, path: audioPath, server_filename: 'Server Archive.m4a',
        size: audio.length, dlink: 'https://d.pcs.baidu.com/recording',
      };
      if (method === 'list') {
        const path = url.searchParams.get('dir');
        if (path === '/') return Response.json({ errno: 0, list: [media] });
        if (path === parent) return Response.json({ errno: 0, list: directoryExists ? [{
          fs_id: '233', path: directory, server_filename: 'groovebox-backups', isdir: 1,
        }] : [] });
        expect(path).toBe(directory);
        if (!directoryExists) return Response.json({ errno: -9 });
        return Response.json({ errno: 0, list: [...snapshots.values()].map(item => item.file) });
      }
      if (method === 'filemetas') {
        const ids = url.searchParams.get('fsids').slice(1, -1).split(',');
        const list = ids.map(id => id === recordingId ? media : snapshots.get(id)?.file).filter(Boolean);
        return Response.json({ errno: 0, list });
      }
      writes.push(method);
      const path = (init.body instanceof URLSearchParams ? init.body : url.searchParams).get('path');
      if (method === 'create' && init.body.get('isdir') === '1') {
        expect(path).toBe(directory);
        directoryExists = true;
        return Response.json({ errno: 0, isdir: 1, path, fs_id: '233' });
      }
      expect(path.startsWith(directory + '/groovebox-playlists-')).toBe(true);
      if (method === 'precreate') {
        pending.set(path, {});
        return Response.json({ errno: 0, return_type: 1, uploadid: 'fixture-upload', block_list: [0], path });
      }
      if (method === 'upload') {
        const bytes = Buffer.from(await init.body.get('file').arrayBuffer());
        pending.get(path).bytes = bytes;
        return Response.json({ md5: createHash('md5').update(bytes).digest('hex') });
      }
      if (method === 'create') {
        const { bytes } = pending.get(path);
        const fs_id = '101';
        snapshots.set(fs_id, { bytes, file: {
          fs_id, isdir: 0, path, size: bytes.length, server_mtime: 1_770_000_000,
          dlink: 'https://d.pcs.baidu.com/' + fs_id,
        } });
        return Response.json({ errno: 0, fs_id, path, size: bytes.length, isdir: 0,
          md5: createHash('md5').update(bytes).digest('hex') });
      }
      return Response.json({ errno: 2 }, { status: 400 });
    },
  });

  try {
    const auth = await page.request.get(origin + '/api/baidu/connect', { maxRedirects: 0 });
    expect(auth.status()).toBe(303);
    const state = new URL(auth.headers().location).searchParams.get('state');
    const connected = await page.request.get(origin + '/api/baidu/callback?' + new URLSearchParams({
      state, code: 'synthetic-code',
    }), { maxRedirects: 0 });
    expect(connected.status()).toBe(303);

    await initialize(page, { playlists: [{ id: playlistId, name: '真实接口归档', tracks: [recording] }] });
    await page.goto(origin + '/#sources');
    await action(page, 'baidu-source').press('Enter');
    await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
    const track = (await localState(page)).tracks.find(item => item.id === recording);
    expect(track.backupAccount).toMatch(/^[\w-]{43}$/);
    await action(page, 'baidu-playlist-backup').press('Enter');
    await action(page, 'baidu-backup-upload').press('Enter');
    expect(writes).toEqual([]);
    await action(page, 'baidu-backup-confirm-upload').press('Enter');
    await expect(page.locator('[data-baidu-backup-status]')).toContainText('歌单备份已上传');
    expect(writes).toEqual(['create', 'precreate', 'upload', 'create']);
    const snapshot = readPlaylistSnapshot(snapshots.get('101').bytes, { provider: 'baidu', account: track.backupAccount });
    expect(snapshot.tracks[0].file).toBe(recordingId);
    await action(page, 'baidu-backup-preview').press('Enter');
    await expect(page.getByRole('listitem').filter({ hasText: '真实接口归档' })).toBeVisible();
    await action(page, 'baidu-backup-restore').press('Enter');
    await expect(page.locator('[data-baidu-backup-status]')).toContainText('歌单和收藏已合并');
    expect((await localState(page)).playlists).toEqual([{ id: playlistId, name: '真实接口归档', tracks: [recording] }]);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).toBeHidden();
    await nav(page, 'playlist/' + playlistId).click();
    const restored = page.locator('#content tr[data-track="' + recording + '"] .track-main');
    await expect(restored).toBeVisible();
    await restored.click();
    await expect(page.locator('#now .queue-row.current')).toHaveAttribute('data-queue-track', recording);
    await expect.poll(() => page.locator('#audio').evaluate(el => el.currentTime)).toBeGreaterThan(0.1);
  } finally {
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  }
});
