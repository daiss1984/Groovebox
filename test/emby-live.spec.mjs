import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const embyImage = process.env.EMBY_TEST_IMAGE;
const ffmpeg = process.env.FFMPEG_TEST_BIN;
const exec = promisify(execFile);
const user = 'groovebox-fixture';
const library = 'Groovebox Emby Library';
const artist = 'Groovebox Emby Artist';
const album = 'Groovebox Emby Album';
const title = 'Groovebox Emby Recording';
const secondTitle = 'Second Emby Track';
const multidiscAlbum = 'Groovebox Multidisc Album';
const multidiscTracks = [
  { title: 'Zulu Disc Fixture', disc: 1, track: 1 },
  { title: 'Bravo Disc Fixture', disc: 1, track: 2 },
  { title: 'Alpha Disc Fixture', disc: 2, track: 1 },
];
const playlistName = 'Groovebox Fixture Playlist';
const createdPlaylistName = 'Groovebox 新歌单 & FLAC';
const videoPlaylistName = 'Groovebox Video Playlist';
const lrc = '[00:01.00]First Emby lyric\n[00:03.00]Second Emby lyric\n';

function docker(args) {
  return exec('docker', args, { timeout: 18_000 });
}

function emby(origin, path, { method = 'GET', token, body, mime = 'application/json' } = {}) {
  return fetch(origin + '/emby' + path, {
    method,
    headers: {
      Authorization: 'Emby Client="Groovebox Fixture", Device="Node", DeviceId="GrooveboxFixture", Version="1.0.0"',
      ...(token && { 'X-Emby-Token': token }),
      ...(body && { 'Content-Type': mime }),
    },
    body: body && (mime === 'application/json' ? JSON.stringify(body) : body),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
}

// The Emby REST API creates the library in a fresh, isolated server container.
async function setup(origin, password, artwork) {
  await expect.poll(async () => {
    try {
      const response = await emby(origin, '/System/Info/Public');
      return response.ok && (await response.json()).StartupWizardCompleted !== true;
    } catch {
      return false;
    }
  }, { timeout: 25_000, message: 'Emby should start with a fresh database' }).toBe(true);
  expect((await emby(origin, '/Startup/User')).status).toBe(200);
  expect((await emby(origin, '/Startup/User', {
    method: 'POST', body: { Name: user, Password: password },
  })).ok).toBe(true);
  expect((await emby(origin, '/Startup/RemoteAccess', {
    method: 'POST', body: { EnableRemoteAccess: false, EnableAutomaticPortMapping: false },
  })).ok).toBe(true);
  expect((await emby(origin, '/Startup/Complete', { method: 'POST' })).ok).toBe(true);
  const login = await emby(origin, '/Users/AuthenticateByName', {
    method: 'POST', body: { Username: user, Pw: password },
  });
  expect(login.status).toBe(200);
  const { AccessToken: token, User: { Id: userId } } = await login.json();
  const create = await emby(origin, '/Library/VirtualFolders', {
    method: 'POST', token,
    body: { Name: library, CollectionType: 'music', Paths: ['/music'], RefreshLibrary: false,
      LibraryOptions: { EnableRealtimeMonitor: false, EnableEmbeddedTitles: true } },
  });
  expect(create.ok).toBe(true);
  expect((await emby(origin, '/Library/Refresh', { method: 'POST', token })).ok).toBe(true);
  const query = new URLSearchParams({ IncludeItemTypes: 'Audio', Recursive: 'true', Fields: 'MediaSources' });
  const endpoint = '/Users/' + encodeURIComponent(userId) + '/Items?' + query;
  let tracks;
  await expect.poll(async () => {
    const response = await emby(origin, endpoint, { token });
    if (!response.ok) return 'HTTP ' + response.status;
    tracks = await response.json();
    return tracks.Items;
  }, { timeout: 35_000, message: 'Emby should finish reading the generated audio tags' }).toEqual(expect.arrayContaining([
    expect.objectContaining({ Name: title, Album: album }), expect.objectContaining({ Name: secondTitle, Album: 'Second Emby Album' }),
    ...multidiscTracks.map(entry => expect.objectContaining({ Name: entry.title, ParentIndexNumber: entry.disc, IndexNumber: entry.track })),
  ]));
  const track = tracks.Items.find(item => item.Name === title);
  const items = async parent => {
    const query = new URLSearchParams({ Recursive: 'false' });
    if (parent) query.set('ParentId', parent);
    return (await (await emby(origin, '/Users/' + encodeURIComponent(userId) + '/Items?' + query, { token })).json()).Items;
  };
  const rootView = (await items()).find(item => item.Name === library);
  const artistView = (await items(rootView.Id)).find(item => item.Name === artist);
  const artistAlbums = await items(artistView.Id);
  const albumView = artistAlbums.find(item => item.Name === album);
  const multidiscView = artistAlbums.find(item => item.Name === multidiscAlbum);
  const discFolders = await items(multidiscView.Id);
  expect(discFolders.map(item => [item.Type, item.Name]).sort()).toEqual([['Folder', 'Disc 1'], ['Folder', 'Disc 2']]);
  const multidiscIds = tracks.Items.filter(item => item.Album === multidiscAlbum).map(item => item.AlbumId);
  expect(multidiscIds).toHaveLength(multidiscTracks.length);
  expect(multidiscIds[0]).toBeTruthy();
  expect(new Set(multidiscIds).size).toBe(1);
  // Emby can expose the filesystem folder and the tagged MusicAlbum as different items.
  for (const id of new Set([track.AlbumId, albumView.Id])) {
    const image = '/Items/' + encodeURIComponent(id) + '/Images/Primary';
    const uploaded = await emby(origin, image, { method: 'POST', token, mime: 'image/jpeg', body: artwork.toString('base64') });
    expect(uploaded.ok, 'Emby should store the fixture artwork').toBe(true);
    const direct = await emby(origin, image, { token });
    expect(direct.status, 'Emby should serve its stored artwork').toBe(200);
    await direct.body?.cancel();
  }
  const second = tracks.Items.find(item => item.Name === secondTitle);
  expect(second?.Id).toBeTruthy();
  const playlist = await emby(origin, '/Playlists?' + new URLSearchParams({
    UserId: userId, Name: playlistName, MediaType: 'Audio', Ids: second.Id,
  }), { method: 'POST', token });
  expect(playlist.ok).toBe(true);
  const { Id: playlistId } = await playlist.json();
  expect(playlistId).toBeTruthy();
  const video = await emby(origin, '/Playlists?' + new URLSearchParams({
    UserId: userId, Name: videoPlaylistName, MediaType: 'Video',
  }), { method: 'POST', token });
  expect(video.ok).toBe(true);
  const { Id: videoPlaylistId } = await video.json();
  expect(videoPlaylistId).toBeTruthy();
  return { token, userId, itemId: track.Id, playlistId };
}

test('plays audio, check-ins and server playlist edits against a real Emby server', async ({ page }) => {
  test.skip(!embyImage || !ffmpeg, 'Provide an official local EMBY_TEST_IMAGE and FFMPEG_TEST_BIN.');
  test.setTimeout(95_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'groovebox-emby-fixture-')));
  const config = join(root, 'config');
  const music = join(root, 'music');
  const albumDirectory = join(music, artist, album);
  const secondAlbum = join(music, artist, 'Second Emby Album');
  const multidiscDirectory = join(music, artist, multidiscAlbum);
  const fixture = join(albumDirectory, 'Recording.flac');
  const container = 'groovebox-emby-' + randomUUID();
  const password = randomBytes(24).toString('hex');
  let launched = false;
  try {
    const discDirectory = number => join(multidiscDirectory, 'Disc ' + number);
    await Promise.all([mkdir(config), ...[albumDirectory, secondAlbum, discDirectory(1), discDirectory(2)].map(dir => mkdir(dir, { recursive: true }))]);
    const picture = join(root, 'cover.jpg');
    await exec(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x320:d=1',
      '-frames:v', '1', picture,
    ], { timeout: 10_000 });
    await exec(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6',
      '-metadata', 'artist=' + artist, '-metadata', 'album_artist=' + artist,
      '-metadata', 'album=Second Emby Album', '-metadata', 'title=' + secondTitle,
      '-c:a', 'flac', join(secondAlbum, 'Second.flac'),
    ], { timeout: 10_000 });
    await exec(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-metadata', 'artist=' + artist, '-metadata', 'album_artist=' + artist,
      '-metadata', 'album=' + album, '-metadata', 'title=' + title, '-metadata', 'lyrics=' + lrc,
      '-c:a', 'flac', fixture,
    ], { timeout: 10_000 });
    await writeFile(join(albumDirectory, 'Recording.lrc'), lrc);
    for (const entry of multidiscTracks) {
      await exec(ffmpeg, [
        '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4',
        '-metadata', 'artist=' + artist, '-metadata', 'album_artist=' + artist,
        '-metadata', 'album=' + multidiscAlbum, '-metadata', 'title=' + entry.title,
        '-metadata', 'disc=' + entry.disc, '-metadata', 'track=' + entry.track,
        '-metadata', 'disctotal=2', '-c:a', 'flac', join(discDirectory(entry.disc), entry.title + '.flac'),
      ], { timeout: 10_000 });
    }

    launched = true;
    await docker([
      'run', '--detach', '--rm', '--pull=never', '--name', container,
      '--publish', '127.0.0.1::8096/tcp', '--security-opt', 'no-new-privileges',
      '--mount', 'type=bind,source=' + config + ',target=/config',
      '--mount', 'type=bind,source=' + music + ',target=/music',
      embyImage,
    ]);
    const { stdout } = await docker(['port', container, '8096/tcp']);
    const origin = 'http://' + stdout.trim();
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const upstream = await setup(origin, password, await readFile(picture));

    await page.goto('/#sources');
    const reports = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/sources\/[^/]+\/playback$/.test(new URL(request.url()).pathname)) {
        reports.push(request.postDataJSON());
      }
    });
    async function connectSource() {
      await page.getByRole('button', { name: /添加媒体服务器/ }).press('Enter');
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('协议').selectOption('emby');
      await dialog.getByLabel('名称').fill('Emby fixture');
      await dialog.getByLabel('服务地址').fill(origin);
      await dialog.getByLabel('用户名').fill(user);
      await dialog.getByLabel('密码').fill(password);
      const [connected] = await Promise.all([
        page.waitForResponse(res => res.url().endsWith('/api/sources') && res.request().method() === 'POST'),
        dialog.getByRole('button', { name: '连接', exact: true }).press('Enter'),
      ]);
      expect(connected.status()).toBe(201);
    }
    await connectSource();
    await page.getByRole('button', { name: library, exact: true }).press('Enter');
    await page.getByRole('button', { name: artist, exact: true }).press('Enter');
    const albumFolder = page.getByRole('button', { name: album, exact: true });
    const folderArt = albumFolder.locator('.folder-cover');
    await expect(folderArt).toHaveAttribute('src', /^\/api\/sources\/[^/]+\/cover\?id=/);
    await expect.poll(() => folderArt.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await albumFolder.press('Enter');
    const track = page.locator('#content').getByRole('button', { name: new RegExp(title + ' ' + artist) });
    await expect(track).toBeVisible();
    await expect(page.getByRole('cell', { name: album, exact: true })).toBeVisible();
    const cover = await track.locator('img').getAttribute('src');
    expect(cover).toMatch(/^\/api\/sources\/[^/]+\/cover\?id=/);
    const image = await page.request.get(cover);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toMatch(/^image\//);
    await expect.poll(() => track.locator('img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);

    const lyricsPromise = page.waitForResponse(res => res.url().endsWith('-lyrics'));
    const [stream] = await Promise.all([
      page.waitForResponse(res => /\/api\/sources\/[^/]+\/stream\?id=[\w-]+$/.test(res.url()) && !res.url().endsWith('-lyrics')),
      track.press('Enter'),
    ]);
    expect(stream.ok()).toBe(true);
    expect(stream.headers()['content-type']).toBe('audio/flac');
    await expect(page.locator('#player-title')).toHaveText(title);
    const media = page.locator('#audio');
    await expect.poll(() => media.evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
    const ranged = await page.request.get(stream.url(), { headers: { Range: 'bytes=4-31' } });
    const bytes = await readFile(fixture);
    expect(ranged.status()).toBe(206);
    expect(ranged.headers()['content-range']).toBe('bytes 4-31/' + bytes.length);
    expect(await ranged.body()).toEqual(bytes.subarray(4, 32));

    const lyrics = await lyricsPromise;
    await page.locator('#player-art').press('Enter');
    expect(lyrics.status()).toBe(200);
    expect(await lyrics.json()).toEqual({ lines: [{ text: 'First Emby lyric', time: 1 }, { text: 'Second Emby lyric', time: 3 }] });
    await expect(page.getByRole('button', { name: 'First Emby lyric' })).toBeVisible();
    await page.getByRole('button', { name: '关闭沉浸播放', exact: true }).press('Enter');

    const playbackEndpoint = new URL(stream.url());
    playbackEndpoint.pathname = playbackEndpoint.pathname.replace(/\/stream$/, '/playback');
    async function report(event, reason, action) {
      const [response] = await Promise.all([
        page.waitForResponse(response => {
          if (response.url() !== playbackEndpoint.href || response.request().method() !== 'POST') return false;
          const payload = response.request().postDataJSON();
          return payload.event === event && payload.reason === reason;
        }),
        action(),
      ]);
      expect(response.status()).toBe(200);
      return response.request().postDataJSON();
    }
    async function session() {
      const response = await emby(origin, '/Sessions', { token: upstream.token });
      expect(response.status).toBe(200);
      return (await response.json()).find(session => session.Client === 'Groovebox');
    }
    async function playCount() {
      const response = await emby(origin, '/Users/' + upstream.userId + '/Items/' + upstream.itemId, { token: upstream.token });
      expect(response.status).toBe(200);
      return (await response.json()).UserData?.PlayCount ?? 0;
    }

    const toggle = page.locator('#player-toggle');
    await toggle.press('Enter');
    expect(reports).toHaveLength(0);
    expect((await session())?.NowPlayingItem?.Id).toBeUndefined();
    const playCountBefore = await playCount();
    await page.locator('#sidebar [data-nav="settings"]').press('Enter');
    const setting = page.getByRole('checkbox', { name: '向 Emby 报告播放状态' });
    await expect(setting).not.toBeChecked();
    await setting.press('Space');
    await expect(setting).toBeChecked();
    const start = await report('start', undefined, () => toggle.press('Enter'));
    await expect.poll(async () => (await session())?.NowPlayingItem?.Id).toBe(upstream.itemId);
    const pause = await report('progress', 'Pause', () => toggle.press('Enter'));
    expect(pause.playSessionId).toBe(start.playSessionId);
    await expect.poll(async () => (await session())?.PlayState?.IsPaused).toBe(true);
    const seek = await report('progress', 'TimeUpdate', () =>
      page.getByRole('slider', { name: '播放进度' }).evaluate(element => {
        element.value = '500';
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }));
    expect(seek.positionSeconds).toBeCloseTo(6, 1);
    await expect.poll(async () => (await session())?.PlayState?.PositionTicks).toBe(Math.round(seek.positionSeconds * 10_000_000));
    const resume = await report('progress', 'Unpause', () => toggle.press('Enter'));
    expect(resume.playSessionId).toBe(start.playSessionId);
    await expect.poll(async () => (await session())?.PlayState?.IsPaused).toBe(false);
    const stop = await report('stop', undefined, () => media.evaluate(audio => { audio.playbackRate = 2; }));
    expect(stop.playSessionId).toBe(start.playSessionId);
    expect(stop.positionSeconds).toBeCloseTo(12, 1);
    await expect.poll(async () => (await session())?.NowPlayingItem?.Id).toBeUndefined();
    await expect.poll(playCount).toBe(playCountBefore + 1);

    async function playlistItems() {
      const endpoint = '/Playlists/' + encodeURIComponent(upstream.playlistId) + '/Items?' + new URLSearchParams({ UserId: upstream.userId });
      const response = await emby(origin, endpoint, { token: upstream.token });
      expect(response.status).toBe(200);
      const data = await response.json();
      return data.Items.map(item => item.Name);
    }
    expect(await playlistItems()).toEqual([secondTitle]);
    await page.goBack();
    const titleRow = page.locator('#content tr').filter({ hasText: title });
    await titleRow.getByRole('button', { name: '歌曲选项' }).press('Enter');
    await page.getByRole('button', { name: '添加到 Emby 歌单', exact: true }).press('Enter');
    const playlistChoice = page.getByRole('dialog').getByRole('button', { name: playlistName, exact: true });
    await expect(playlistChoice).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: videoPlaylistName, exact: true })).toHaveCount(0);
    const [added] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/playlist') && response.request().method() === 'POST'),
      playlistChoice.press('Enter'),
    ]);
    expect(added.status()).toBe(200);
    await expect.poll(playlistItems).toEqual([secondTitle, title]);
    await page.getByRole('button', { name: '服务器歌单', exact: true }).press('Enter');
    await page.getByRole('button', { name: playlistName, exact: true }).press('Enter');
    await expect(page.locator('#content .track-name')).toHaveText([secondTitle, title]);
    // Wait for the second song's missing artwork to settle before focusing Playwright's button.
    await expect(page.locator('#content tr').filter({ hasText: secondTitle }).locator('img')).toHaveCount(0);
    const [removed] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/playlist') && response.request().method() === 'POST', { timeout: 10_000 }),
      titleRow.getByRole('button', { name: '从 Emby 歌单移除' }).press('Enter'),
    ]);
    expect(removed.status()).toBe(200);
    await expect(page.locator('#content .track-name')).toHaveText([secondTitle]);
    await expect.poll(playlistItems).toEqual([secondTitle]);
    const stillExists = await emby(origin, '/Users/' + upstream.userId + '/Items/' + upstream.itemId, { token: upstream.token });
    expect(stillExists.status).toBe(200);
    await page.getByRole('button', { name: '服务器歌单', exact: true }).press('Enter');
    await page.getByRole('button', { name: '新建 Emby 歌单', exact: true }).press('Enter');
    const createDialog = page.getByRole('dialog');
    await createDialog.getByLabel('歌单名称').fill(createdPlaylistName);
    const [created] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/playlist') && response.request().method() === 'POST'),
      createDialog.getByRole('button', { name: '创建歌单', exact: true }).press('Enter'),
    ]);
    expect(created.status()).toBe(201);
    await expect(page.getByRole('heading', { name: createdPlaylistName, exact: true })).toBeVisible();
    await expect(page.getByText('此歌单没有歌曲', { exact: true })).toBeVisible();
    const allPlaylists = await emby(origin, '/Users/' + upstream.userId + '/Items?' + new URLSearchParams({
      IncludeItemTypes: 'Playlist', Recursive: 'true',
    }), { token: upstream.token });
    expect(allPlaylists.status).toBe(200);
    const newPlaylist = (await allPlaylists.json()).Items.find(item => item.Name === createdPlaylistName);
    expect(newPlaylist?.Id).toBeTruthy();
    async function createdSongs() {
      const response = await emby(origin, '/Playlists/' + encodeURIComponent(newPlaylist.Id) + '/Items?' +
        new URLSearchParams({ UserId: upstream.userId }), { token: upstream.token });
      expect(response.status).toBe(200);
      return (await response.json()).Items.map(item => item.Name);
    }
    expect(await createdSongs()).toEqual([]);
    await page.getByRole('button', { name: '移除来源', exact: true }).press('Enter');
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).press('Enter');
    await expect(page).toHaveURL(/#sources$/);
    await connectSource();
    await page.getByRole('button', { name: '服务器歌单', exact: true }).press('Enter');
    const reconnectedPlaylist = page.locator('.folder-list').getByRole('button', { name: createdPlaylistName, exact: true });
    await expect(reconnectedPlaylist).toBeVisible();
    await expect(page.getByRole('button', { name: videoPlaylistName, exact: true })).toHaveCount(0);
    await reconnectedPlaylist.press('Enter');
    await expect(page.getByText('此歌单没有歌曲', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '根目录', exact: true }).press('Enter');
    await page.getByRole('button', { name: library, exact: true }).press('Enter');
    await page.getByRole('button', { name: artist, exact: true }).press('Enter');
    await page.getByRole('button', { name: album, exact: true }).press('Enter');
    await titleRow.getByRole('button', { name: '歌曲选项' }).press('Enter');
    await page.getByRole('button', { name: '添加到 Emby 歌单', exact: true }).press('Enter');
    const playlistPicker = page.getByRole('dialog');
    await playlistPicker.getByRole('button', { name: createdPlaylistName, exact: true }).press('Enter');
    await expect.poll(createdSongs).toEqual([title]);
    await expect(playlistPicker).toBeHidden();

    const serverOrder = multidiscTracks.map(entry => entry.title);
    const breadcrumbs = page.locator('.breadcrumbs');
    await breadcrumbs.getByRole('button', { name: artist, exact: true }).press('Enter');
    await expect(breadcrumbs.getByRole('button', { name: album, exact: true })).toHaveCount(0);
    const multidiscFolder = page.locator('.folder-list').getByRole('button', { name: multidiscAlbum, exact: true });
    await expect(multidiscFolder).toBeVisible();
    await multidiscFolder.press('Enter');
    await expect(page.locator('.disc-heading')).toHaveText(['第 1 碟', '第 2 碟']);
    await expect(page.locator('#content .track-name')).toHaveText(serverOrder);
    await expect(page.locator('#content tr[data-track] td:first-child')).toHaveText(['1', '2', '1']);
    await page.getByRole('button', { name: '播放此目录', exact: true }).press('Enter');
    await expect(page.locator('#player-title')).toHaveText(serverOrder[0]);
    await expect(page.locator('.queue-row .track-name')).toHaveText(serverOrder);
    const sort = page.getByRole('combobox', { name: '排序' });
    await sort.selectOption('title');
    await expect(page.locator('.disc-heading')).toHaveCount(0);
    await expect(page.locator('#content .track-name')).toHaveText(serverOrder.toSorted());
    await sort.selectOption('default');
    await expect(page.locator('.disc-heading')).toHaveText(['第 1 碟', '第 2 碟']);

    await page.locator('.folder-list').getByRole('button', { name: 'Disc 1', exact: true }).press('Enter');
    await expect(page.locator('#content .track-name')).toHaveCount(2);
    await expect(page.locator('#content .track-name').filter({ hasText: serverOrder[1] })).toBeVisible();
    await breadcrumbs.getByRole('button', { name: multidiscAlbum, exact: true }).press('Enter');
    await expect(page.locator('#content .track-name')).toHaveText(serverOrder);

    await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
    await expect(page.getByRole('status').filter({ hasText: '扫描完成，共找到 3 首歌曲' })).toBeVisible();
    await page.locator('#sidebar [data-nav="albums"]').press('Enter');
    const albumCard = page.locator('#content button.card').filter({ has: page.getByText(multidiscAlbum, { exact: true }) });
    await albumCard.press('Enter');
    await expect(page.locator('#content .disc-heading')).toHaveText(['第 1 碟', '第 2 碟']);
    await expect(page.locator('#content .track-name')).toHaveText(serverOrder);
    await page.locator('#content .track-main').nth(2).press('Enter');
    await expect(page.locator('#player-title')).toHaveText(serverOrder[2]);
    await page.getByRole('button', { name: '全部播放', exact: true }).press('Enter');
    await expect(page.locator('#player-title')).toHaveText(serverOrder[0]);
    await expect(page.locator('.queue-row .track-name')).toHaveText(serverOrder);
    await page.reload();
    await expect(page.locator('#content .disc-heading')).toHaveText(['第 1 碟', '第 2 碟']);
  } finally {
    if (launched) await docker(['rm', '-f', container]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
