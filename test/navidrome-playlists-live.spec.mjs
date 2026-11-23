import { expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const navidromeBin = process.env.NAVIDROME_TEST_BIN;
const ffmpegBin = process.env.FFMPEG_TEST_BIN;
const exec = promisify(execFile);

test('real Navidrome playlists preserve order and repeated songs during playback and mirroring', async ({ page }) => {
  test.skip(!navidromeBin || !ffmpegBin, 'Provide NAVIDROME_TEST_BIN and FFMPEG_TEST_BIN to run the live fixture.');
  test.setTimeout(40_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-navidrome-playlists-'));
  const music = join(root, 'music');
  const password = randomBytes(24).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const token = createHash('md5').update(password + salt).digest('hex');
  const titles = ['Alpha Fixture Track', 'Zebra Fixture Track'];
  const playlistName = 'Fixture server order';
  let navidrome;
  try {
    await mkdir(music);
    await Promise.all(titles.map((title, index) => exec(ffmpegBin, [
      '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 100}:duration=15`,
      '-metadata', 'artist=Fixture Artist', '-metadata', 'album=Fixture Album', '-metadata', `title=${title}`,
      '-c:a', 'flac', join(music, `${index}.flac`),
    ], { timeout: 10_000 })));
    const reservation = createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const { port } = reservation.address();
    await new Promise(resolveClose => reservation.close(resolveClose));
    const upstreamOrigin = `http://127.0.0.1:${port}`;
    navidrome = spawn(resolve(navidromeBin), [], {
      cwd: root,
      env: {
        PATH: process.env.PATH, ND_ADDRESS: '127.0.0.1', ND_PORT: String(port),
        ND_MUSICFOLDER: music, ND_DATAFOLDER: join(root, 'db'), ND_FFMPEGPATH: resolve(ffmpegBin),
        ND_DEVAUTOCREATEADMINPASSWORD: password, ND_ENABLEINSIGHTSCOLLECTOR: 'false',
        ND_ENABLEEXTERNALSERVICES: 'false', ND_LOGLEVEL: 'error',
      },
      stdio: 'ignore',
    });
    let startupError;
    navidrome.once('error', error => { startupError = error.code; });
    const upstream = async (method, values) => {
      const params = new URLSearchParams({ u: 'admin', s: salt, t: token, v: '1.16.1', c: 'GrooveboxTest', f: 'json' });
      for (const [key, value] of values) params.append(key, value);
      const response = await fetch(`${upstreamOrigin}/rest/${method}.view?${params}`, { signal: AbortSignal.timeout(1500) });
      return (await response.json())['subsonic-response'];
    };
    let songs;
    await expect.poll(async () => {
      if (startupError || navidrome.exitCode !== null) return 'Navidrome exited before indexing';
      try {
        const found = await upstream('search3', [['query', 'Fixture Track'], ['songCount', '20']]);
        songs = titles.map(title => found.searchResult3?.song?.find(song => song.title === title)?.id);
        return songs.every(Boolean);
      } catch {
        return false;
      }
    }, { timeout: 14_000 }).toBe(true);
    const upstreamOrder = [1, 0, 1];
    const playlist = await upstream('createPlaylist', [['name', playlistName], ...upstreamOrder.map(index => ['songId', songs[index]])]);
    expect(playlist.status).toBe('ok');
    const expectedTitles = upstreamOrder.map(index => titles[index]);
    const saved = await upstream('getPlaylist', [['id', playlist.playlist.id]]);
    expect(saved.playlist.entry.map(song => song.title)).toEqual(expectedTitles);

    await page.goto('/#settings');
    await page.locator('#remember-playlist-position').check();
    const queueAllDirectTracks = page.locator('#queue-all-direct-tracks');
    await queueAllDirectTracks.uncheck();
    await page.locator('#sidebar [data-nav="sources"]').press('Enter');
    await page.getByRole('button', { name: /添加媒体服务器/ }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('协议').selectOption('navidrome');
    await dialog.getByLabel('名称').fill('Navidrome playlist fixture');
    await dialog.getByLabel('服务地址').fill(upstreamOrigin);
    await dialog.getByLabel('用户名').fill('admin');
    await dialog.getByLabel('密码').fill(password);
    const connected = page.waitForResponse(response => response.url().endsWith('/api/sources') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '连接', exact: true }).press('Enter');
    const session = await connected;
    expect(session.status()).toBe(201);
    const { source } = await session.json();
    await page.getByRole('combobox', { name: '排序' }).selectOption('title');
    await page.getByRole('button', { name: '服务器歌单', exact: true }).press('Enter');
    const directory = page.getByRole('button', { name: playlistName, exact: true });
    await expect(directory).toBeVisible();
    await directory.press('Enter');
    await expect(page.getByRole('heading', { name: playlistName, exact: true })).toBeVisible();
    await expect(page.locator('.track-table .track-name')).toHaveText(expectedTitles);
    await expect(page.getByRole('combobox', { name: '排序' })).toHaveCount(0);
    await page.getByRole('button', { name: '播放歌单', exact: true }).press('Enter');
    await expect(page.locator('#player-title')).toHaveText(expectedTitles[0]);
    await expect.poll(() => page.locator('#audio').evaluate(player => player.currentTime)).toBeGreaterThan(0.1);
    const queue = page.locator('.queue-row');
    await expect(queue.locator('.track-name')).toHaveText(expectedTitles);
    await page.locator('#content .track-main').nth(2).click();
    await expect(queue.locator('.track-name')).toHaveText([expectedTitles[2]]);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1'))
      .playlistResumeBookmarks.some(([, occurrence]) => JSON.parse(occurrence)[2] === 2))).toBe(true);
    await page.getByRole('button', { name: '播放歌单', exact: true }).click();
    await expect(queue.locator('.track-name')).toHaveText(expectedTitles);
    await expect(queue.nth(2)).toHaveClass(/\bcurrent\b/);

    const savedList = page.locator('#playlist-nav [data-nav^="server-playlist/"]');
    await expect(savedList).toHaveCount(0);
    await page.getByRole('button', { name: '保存为本地镜像', exact: true }).press('Enter');
    await expect(savedList).toHaveText(playlistName);
    await expect(page).toHaveURL(/server-playlist/);
    const mirrorUrl = page.url();
    await page.locator('#sidebar [data-nav="settings"]').click();
    await queueAllDirectTracks.check();
    await savedList.click();
    await page.reload();
    await expect(page.locator('.track-table .track-name')).toHaveText(expectedTitles);
    await expect(page.getByRole('button', { name: '重命名', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '手动排序', exact: true })).toHaveCount(0);
    await page.locator('#playlist-search').fill(titles[0]);
    await expect(page.locator('.track-table .track-name')).toHaveText([titles[0]]);
    await page.getByRole('button', { name: '播放歌单', exact: true }).press('Enter');
    await expect(queue.nth(2)).toHaveClass(/\bcurrent\b/);
    await expect.poll(() => page.locator('#audio').evaluate(player => !player.paused && player.currentTime > 0.1)).toBe(true);
    await page.locator('#playlist-search').clear();

    await page.locator('#sidebar .add-playlist[data-action="new-playlist"]').press('Enter');
    await page.getByRole('dialog').getByLabel('歌单名称').fill(playlistName);
    await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).press('Enter');
    const handmade = page.locator('#playlist-nav [data-nav^="playlist/"]');
    await expect(handmade).toHaveText(playlistName);
    await savedList.press('Enter');
    await expect(page).toHaveURL(mirrorUrl);

    const rename = 'Updated fixture playlist';
    const changed = await upstream('updatePlaylist', [['playlistId', playlist.playlist.id], ['name', rename],
      ['songIndexToRemove', '0'], ['songIdToAdd', songs[0]]]);
    expect(changed.status).toBe('ok');
    const serverTracks = (await upstream('getPlaylist', [['id', playlist.playlist.id]])).playlist.entry.map(song => song.title);
    expect(serverTracks).toEqual([titles[0], titles[1], titles[0]]);
    await expect(page.locator('.track-table .track-name')).toHaveText(expectedTitles);

    const directoryUrl = `**/api/sources/${source.id}/list?path=playlists`;
    await page.route(directoryUrl, request => request.fulfill({ status: 503, json: { error: 'Fixture source unavailable' } }));
    await page.getByRole('button', { name: '从服务器刷新镜像', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toHaveText('Fixture source unavailable');
    await expect(page.locator('.track-table .track-name')).toHaveText(expectedTitles);
    await page.unroute(directoryUrl);

    await page.locator('#content .track-table tbody tr').first().getByRole('button', { name: '歌曲选项' }).press('Enter');
    await page.getByRole('dialog').getByRole('button', { name: '离线保存', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toHaveText('音频已保存到离线歌曲。');

    const headers = { Origin: new URL(page.url()).origin };
    expect((await page.request.delete(`/api/sources/${source.id}`, { headers })).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('button', { name: '前往音乐来源', exact: true })).toBeVisible();
    await expect(page.locator('.track-table .track-name')).toHaveText(expectedTitles);
    await page.getByRole('button', { name: '播放歌单', exact: true }).press('Enter');
    await expect.poll(() => page.locator('#audio').evaluate(player => player.currentSrc.startsWith('blob:') &&
      !player.paused && player.currentTime > 0.1)).toBe(true);
    const reconnected = await page.request.post('/api/sources', {
      headers, data: { ...source, url: upstreamOrigin, username: 'admin', password },
    });
    expect(reconnected.status()).toBe(201);
    expect((await reconnected.json()).source.id).toBe(source.id);
    await page.reload();
    await page.getByRole('button', { name: '从服务器刷新镜像', exact: true }).press('Enter');
    await expect(page.getByRole('heading', { name: rename, exact: true })).toBeVisible();
    await expect(page.locator('.track-table .track-name')).toHaveText(serverTracks);
    await expect(page).toHaveURL(mirrorUrl);
    await expect(handmade).toHaveText(playlistName);
    await page.getByRole('button', { name: '播放歌单', exact: true }).press('Enter');
    await expect(queue.first()).toHaveClass(/\bcurrent\b/);
    await expect.poll(() => page.locator('#audio').evaluate(player => !player.paused && player.currentTime > 0.1)).toBe(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: rename, exact: true })).toBeVisible();
    await expect(page.locator('.track-table .track-name')).toHaveText(serverTracks);
    await page.getByRole('button', { name: '移除本地镜像', exact: true }).press('Enter');
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).press('Enter');
    await expect(savedList).toHaveCount(0);
    await expect(handmade).toHaveText(playlistName);
    const stillRemote = (await upstream('getPlaylist', [['id', playlist.playlist.id]])).playlist;
    expect(stillRemote.name).toBe(rename);
    expect(stillRemote.entry.map(song => song.title)).toEqual(serverTracks);

    const emptyName = 'Empty Navidrome fixture';
    const emptyPlaylist = await upstream('createPlaylist', [['name', emptyName]]);
    expect(emptyPlaylist.status).toBe('ok');
    async function openServerPlaylists() {
      await page.locator('#sidebar [data-nav="sources"]').press('Enter');
      await page.getByRole('button', { name: /^Navidrome playlist fixture/ }).press('Enter');
      await page.getByRole('button', { name: '服务器歌单', exact: true }).press('Enter');
    }
    const syncAll = page.getByRole('button', { name: '同步全部服务器歌单', exact: true });
    await openServerPlaylists();
    await expect(page.getByRole('button', { name: emptyName, exact: true })).toBeVisible();
    await syncAll.press('Enter');
    await expect(page.locator('#toast')).toHaveText('已同步 2 个服务器歌单。');
    await expect(savedList).toHaveCount(2);
    await savedList.filter({ hasText: emptyName }).press('Enter');
    await expect(page.getByText('此歌单没有歌曲', { exact: true })).toBeVisible();
    await savedList.filter({ hasText: rename }).press('Enter');
    await expect(page.locator('.track-table .track-name')).toHaveText(serverTracks);

    const changedAgain = 'Resynced fixture playlist';
    expect((await upstream('updatePlaylist', [['playlistId', playlist.playlist.id], ['name', changedAgain]])).status).toBe('ok');
    await openServerPlaylists();
    const emptyPath = await page.getByRole('button', { name: emptyName, exact: true }).getAttribute('data-id');
    await page.route(`**/api/sources/${source.id}/list?path=${emptyPath}`, request => request.fulfill({ status: 503, json: {} }));
    await syncAll.press('Enter');
    await expect(page.locator('#toast')).toHaveText('已同步 1 个歌单，1 个未能同步。');
    await expect(savedList).toHaveCount(2);
    await page.reload();
    await savedList.filter({ hasText: changedAgain }).press('Enter');
    await expect(page.locator('.track-table .track-name')).toHaveText(serverTracks);
    await savedList.filter({ hasText: emptyName }).press('Enter');
    await expect(page.getByText('此歌单没有歌曲', { exact: true })).toBeVisible();
    await expect(handmade).toHaveText(playlistName);

    const exported = join(root, 'Exported Navidrome Playlist.m3u');
    await exec(resolve(navidromeBin), ['pls', '--playlist', playlist.playlist.id, '--output', exported,
      '--datafolder', join(root, 'db'), '--musicfolder', music, '--loglevel', 'error', '--nobanner'], { cwd: root, timeout: 10_000 });
    const exportedText = await readFile(exported, 'utf8');
    expect(exportedText).toMatch(/(?:^|\n)(?!#)[^\n]*\.flac(?:\n|$)/i);
    const paths = (await upstream('getPlaylist', [['id', playlist.playlist.id]])).playlist.entry.map(song => song.path);
    expect(paths.every(Boolean), exportedText).toBe(true);
    await page.locator('#import-m3u-file').setInputFiles(exported);
    await expect(page.locator('#toast'), JSON.stringify({ paths, exportedText })).toContainText('已导入 2 首歌曲');
    await expect(page).toHaveURL(url => decodeURIComponent(url.hash).startsWith('#playlist/'));
    await expect(page.getByRole('heading', { name: changedAgain, exact: true })).toBeVisible();
    const uniqueTitles = [...new Set(serverTracks)];
    await expect(page.locator('.track-table .track-name')).toHaveText(uniqueTitles);
    await page.reload();
    await expect(page.locator('.track-table .track-name')).toHaveText(uniqueTitles);
    await page.locator('#content .track-main').last().press('Enter');
    await expect(page.locator('#player-title')).toHaveText(uniqueTitles.at(-1));
    await expect.poll(() => page.locator('#audio').evaluate(player => !player.paused && player.currentTime > 0.1)).toBe(true);
  } finally {
    if (navidrome?.pid && navidrome.exitCode === null && navidrome.signalCode === null) {
      const exited = once(navidrome, 'exit');
      navidrome.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
