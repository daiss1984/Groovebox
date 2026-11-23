import { expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const jellyfinBin = process.env.JELLYFIN_TEST_BIN;
const ffmpeg = process.env.FFMPEG_TEST_BIN;
const exec = promisify(execFile);
const library = 'Groovebox Fixture Library';
const artist = 'Groovebox Fixture Artist';
const album = 'Groovebox Fixture Album';
const title = 'Groovebox Fixture Recording';
const secondTitle = 'Zulu Fixture Recording';
const playlistName = 'Groovebox Jellyfin Fixture Playlist';
const createdName = 'Groovebox Newly Created Jellyfin Playlist';
const keyPlaylistName = 'Groovebox Jellyfin API Key Playlist';

async function availableLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

function jellyfin(origin, path, { method = 'GET', token, body } = {}) {
  const authorization = 'MediaBrowser Client="Groovebox Fixture", Device="Node", DeviceId="GrooveboxFixture", Version="1.0.0"';
  return fetch(origin + path, {
    method,
    headers: {
      Authorization: authorization + (token ? ', Token="' + token + '"' : ''),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(7000),
  });
}

async function prepareLibrary(origin, username, password, music) {
  await expect.poll(async () => {
    try {
      const response = await jellyfin(origin, '/System/Info/Public');
      return response.ok && (await response.json()).StartupWizardCompleted === false;
    } catch {
      return false;
    }
  }, { timeout: 32_000, message: 'Jellyfin should start with a fresh database' }).toBe(true);
  expect((await jellyfin(origin, '/Startup/User')).status).toBe(200);
  expect((await jellyfin(origin, '/Startup/User', {
    method: 'POST', body: { Name: username, Password: password },
  })).status).toBe(204);
  expect((await jellyfin(origin, '/Startup/Complete', { method: 'POST' })).status).toBe(204);
  const login = await jellyfin(origin, '/Users/AuthenticateByName', {
    method: 'POST', body: { Username: username, Pw: password },
  });
  expect(login.status).toBe(200);
  const { AccessToken: token, User: { Id: userId } } = await login.json();
  const query = new URLSearchParams({ name: library, collectionType: 'music', paths: music });
  const create = await jellyfin(origin, '/Library/VirtualFolders?' + query, {
    method: 'POST', token, body: { LibraryOptions: { EnableRealtimeMonitor: false, EnableInternetProviders: false } },
  });
  expect(create.status).toBe(204);
  expect((await jellyfin(origin, '/Library/Refresh', { method: 'POST', token })).status).toBe(204);
  const itemsQuery = new URLSearchParams({ UserId: userId, IncludeItemTypes: 'Audio', Recursive: 'true' });
  let tracks;
  await expect.poll(async () => {
    const response = await jellyfin(origin, '/Items?' + itemsQuery, { token });
    if (!response.ok) return 'Jellyfin returned HTTP ' + response.status;
    tracks = (await response.json()).Items;
    return tracks.map(item => item.Name).sort();
  }, { timeout: 35_000, message: 'Jellyfin should index both generated tracks' }).toEqual([title, secondTitle]);
  const orderedTitles = [secondTitle, title];
  const createPlaylist = await jellyfin(origin, '/Playlists', {
    method: 'POST', token, body: { Name: playlistName, UserId: userId, MediaType: 'Audio',
      Ids: orderedTitles.map(name => tracks.find(item => item.Name === name).Id) },
  });
  expect(createPlaylist.status).toBe(200);
  const { Id: playlistId } = await createPlaylist.json();
  const entries = await jellyfin(origin, '/Playlists/' + playlistId + '/Items?' + new URLSearchParams({ UserId: userId }), { token });
  expect(entries.status).toBe(200);
  expect((await entries.json()).Items.map(item => item.Name)).toEqual(orderedTitles);
  return { userId, token, tracks, playlistId };
}

async function verifyApiKeyPlaylists(page, origin, native, reader, password, otherPlaylistPath) {
  const name = 'Groovebox isolated playlist credential';
  const generated = await jellyfin(origin, '/Auth/Keys?' + new URLSearchParams({ app: name }), { method: 'POST', token: native.token });
  expect([200, 204]).toContain(generated.status);
  const key = generated.status === 200 ? (await generated.json()).AccessToken :
    (await (await jellyfin(origin, '/Auth/Keys', { token: native.token })).json()).Items.find(item => item.AppName === name).AccessToken;
  expect(typeof key).toBe('string');
  const login = await jellyfin(origin, '/Users/AuthenticateByName', { method: 'POST', body: { Username: reader.Name, Pw: password } });
  expect(login.status).toBe(200);
  const { AccessToken: readerToken } = await login.json();
  const elevation = '/System/Configuration/MetadataOptions/Default';
  for (const [token, expected] of [[key, 200], [readerToken, 403]]) {
    const response = await jellyfin(origin, elevation, { token });
    expect(response.status).toBe(expected);
    await response.body?.cancel();
  }

  const connect = (name, token, userId) => page.request.post('/api/sources', { data: { type: 'jellyfin', name, url: origin, token, userId } });
  const appOrigin = new URL(page.url()).origin;
  const mutate = (id, path, data) => page.request.post('/api/sources/' + id + '/playlist?' + new URLSearchParams({ path }), {
    headers: { Origin: appOrigin }, data,
  });
  const list = async (id, path) => {
    const response = await page.request.get('/api/sources/' + id + '/list?' + new URLSearchParams({ path }));
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };
  const rejected = { action: 'create', name: 'Must Not Create From Unverified Source' };
  const missingId = '17955d802532452599d5340bcc50a566';
  for (const [label, token, userId] of [['Key without user ID', key, undefined],
    ['Key with missing user', key, missingId], ['Mismatched user token', readerToken, native.userId]]) {
    const response = await connect(label, token, userId);
    if (response.status() === 201) {
      const { source } = await response.json();
      expect(source.playlistWritable).not.toBe(true);
      expect((await mutate(source.id, 'playlists', rejected)).status()).toBe(405);
    } else {
      expect([400, 401, 403, 404, 502]).toContain(response.status());
    }
  }

  const keySourceName = 'Jellyfin API Key for Verified User';
  const connection = await connect(keySourceName, key, reader.Id);
  expect(connection.status(), await connection.text()).toBe(201);
  const { source } = await connection.json();
  expect(source.playlistWritable).toBe(true);
  expect(source.playlistAuthority).toBe('api-key');
  const playlists = (await list(source.id, 'playlists')).items;
  expect(playlists.map(item => item.name)).not.toContain(createdName);
  const sharedFolder = playlists.find(item => item.name === playlistName);
  const track = (await list(source.id, sharedFolder.path)).items.find(item => item.name === secondTitle);
  const inaccessible = await mutate(source.id, otherPlaylistPath, { action: 'add', trackId: track.id });
  expect(inaccessible.status()).toBe(404);

  const created = await mutate(source.id, 'playlists', { action: 'create', name: keyPlaylistName, userId: native.userId });
  expect(created.status(), await created.text()).toBe(201);
  const { playlist } = await created.json();
  expect((await list(source.id, playlist.path)).items).toEqual([]);
  const nativeList = await jellyfin(origin, '/Items?' + new URLSearchParams({ UserId: reader.Id, IncludeItemTypes: 'Playlist', Recursive: 'true' }),
    { token: readerToken });
  expect(nativeList.status).toBe(200);
  const visible = (await nativeList.json()).Items;
  expect(visible.map(item => item.Name)).not.toContain(rejected.name);
  const { Id: nativeId } = visible.find(item => item.Name === keyPlaylistName);
  const owner = await jellyfin(origin, '/Playlists/' + nativeId + '/Users/' + reader.Id, { token: readerToken });
  expect(owner.status).toBe(200);
  expect(await owner.json()).toMatchObject({ UserId: reader.Id, CanEdit: true });
  const privacy = await jellyfin(origin, '/Playlists/' + nativeId, { token: readerToken });
  expect(privacy.status).toBe(200);
  expect((await privacy.json()).OpenAccess).toBe(false);

  const added = await mutate(source.id, playlist.path, { action: 'add', trackId: track.id });
  expect(added.status(), await added.text()).toBe(200);
  const { items } = await list(source.id, playlist.path);
  expect(items.map(item => item.name)).toEqual([secondTitle]);
  const entryId = items[0].playlistEntry;
  expect(entryId).toMatch(/^[\w-]{24}$/);
  const removed = await mutate(source.id, playlist.path, { action: 'remove', entryId });
  expect(removed.status(), await removed.text()).toBe(200);
  expect((await list(source.id, playlist.path)).items).toEqual([]);
  const nativeEntries = await jellyfin(origin, '/Playlists/' + nativeId + '/Items?' + new URLSearchParams({ UserId: reader.Id }), { token: readerToken });
  expect(nativeEntries.status).toBe(200);
  expect((await nativeEntries.json()).Items).toEqual([]);

  const notice = '添加歌曲需要指定用户有歌单编辑权限。移除歌曲使用管理员 API 密钥。';
  await page.reload();
  await page.locator('#sidebar [data-nav="sources"]').press('Enter');
  const content = page.locator('#content');
  await content.locator('button.source-card').filter({ has: page.getByText(keySourceName, { exact: true }) }).press('Enter');
  await content.getByRole('button', { name: '服务器歌单', exact: true }).press('Enter');
  await content.getByRole('button', { name: playlistName, exact: true }).press('Enter');
  await expect(content.getByText(notice, { exact: true })).toBeVisible();
  await content.locator('tr').filter({ hasText: secondTitle }).getByRole('button', { name: '歌曲选项' }).press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '添加到 Jellyfin 歌单', exact: true }).press('Enter');
  await expect(dialog.getByText(notice, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await verifyAliasedPlaylistWrites(page, origin, { readerToken, nativeId, userId: reader.Id, sourceId: source.id, playlist, track, mutate, list });
}

async function verifyAliasedPlaylistWrites(page, origin, { readerToken, nativeId, userId, sourceId, playlist, track, mutate, list }) {
  let relayMode = 'hold';
  let relayedAdds = 0;
  let reached;
  let unblock;
  const reachedNative = new Promise(resolve => { reached = resolve; });
  const hold = new Promise(resolve => { unblock = resolve; });
  const server = createHttpServer(async (req, res) => {
    try {
      const target = new URL(req.url, origin);
      expect(target.origin).toBe(origin);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = Object.fromEntries(['authorization', 'accept', 'content-type', 'range'].filter(name => req.headers[name])
        .map(name => [name, req.headers[name]]));
      const native = await fetch(target, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
        redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (req.method === 'POST' && target.pathname === '/Playlists/' + nativeId + '/Items') {
        relayedAdds++;
        expect(native.status).toBe(204);
        if (relayMode === 'drop') return res.destroy();
        reached();
        await hold;
      }
      const selected = Object.fromEntries(['content-type', 'content-range', 'accept-ranges'].filter(name => native.headers.has(name))
        .map(name => [name, native.headers.get(name)]));
      res.writeHead(native.status, selected).end(Buffer.from(await native.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const name = 'Jellyfin Loopback Alias';
    const url = 'http://127.0.0.1:' + server.address().port;
    const connected = await page.request.post('/api/sources', { data: { type: 'jellyfin', name, url, token: readerToken } });
    expect(connected.status(), await connected.text()).toBe(201);
    const { source: alias } = await connected.json();
    expect(alias.id).not.toBe(sourceId);
    expect(alias.playlistWritable).toBe(true);
    const aliases = (await list(alias.id, 'playlists')).items;
    const aliasPlaylist = aliases.find(item => item.name === keyPlaylistName);
    const baseline = aliases.find(item => item.name === playlistName);
    const [aliasTrack] = (await list(alias.id, baseline.path)).items;
    const first = mutate(alias.id, aliasPlaylist.path, { action: 'add', trackId: aliasTrack.id });
    try {
      await Promise.race([reachedNative, first.then(async result => { throw Error('Alias write returned before the held native reply: ' + await result.text()); })]);
      const competing = await mutate(sourceId, playlist.path, { action: 'add', trackId: track.id });
      expect(competing.status(), await competing.text()).toBe(409);
    } finally { unblock(); }
    const added = await first;
    expect(added.status(), await added.text()).toBe(200);
    expect((await list(sourceId, playlist.path)).items.map(item => item.name)).toEqual([secondTitle]);

    relayMode = 'drop';
    await page.reload();
    await page.locator('#sidebar [data-nav="sources"]').press('Enter');
    const content = page.locator('#content');
    await content.locator('button.source-card').filter({ has: page.getByText(name, { exact: true }) }).press('Enter');
    await content.getByRole('button', { name: '服务器歌单', exact: true }).press('Enter');
    await content.getByRole('button', { name: playlistName, exact: true }).press('Enter');
    await content.locator('tr').filter({ hasText: secondTitle }).getByRole('button', { name: '歌曲选项' }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '添加到 Jellyfin 歌单', exact: true }).press('Enter');
    const [uncertain] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/sources/' + alias.id + '/playlist' && response.request().method() === 'POST'),
      dialog.getByRole('button', { name: keyPlaylistName, exact: true }).press('Enter'),
    ]);
    expect(uncertain.status(), await uncertain.text()).toBe(503);
    expect((await uncertain.json()).code).toBe('playlist_commit_unknown');
    await expect(content.getByRole('heading', { name: keyPlaylistName, exact: true })).toBeVisible();
    await expect(content.locator('.track-name')).toHaveText([secondTitle, secondTitle]);
    await expect(dialog).toBeHidden();
    const confirmed = await jellyfin(origin, '/Playlists/' + nativeId + '/Items?' + new URLSearchParams({ UserId: userId }), { token: readerToken });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).Items.map(item => item.Name)).toEqual([secondTitle, secondTitle]);
    expect(relayedAdds).toBe(2);
  } finally {
    unblock();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function verifyPlaylistWrites(page, origin, native, source, password) {
  const base = id => '/api/sources/' + id;
  const appOrigin = new URL(page.url()).origin;
  const list = async (id, path) => {
    const response = await page.request.get(base(id) + '/list?' + new URLSearchParams({ path }));
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };
  const mutate = (id, path, data, from = appOrigin) => page.request.post(base(id) + '/playlist?' + new URLSearchParams({ path }), {
    headers: { Origin: from }, data,
  });
  const nativeRows = async id => {
    const response = await jellyfin(origin, '/Playlists/' + id + '/Items?' + new URLSearchParams({ UserId: native.userId }), { token: native.token });
    expect(response.status).toBe(200);
    return (await response.json()).Items;
  };
  const nativeTitles = async id => (await nativeRows(id)).map(item => item.Name);
  const content = page.locator('#content');
  const button = (label, root = content) => root.getByRole('button', { name: label, exact: true });
  const nav = section => page.locator('#sidebar [data-nav="' + section + '"]').press('Enter');
  const openServerPlaylists = async name => {
    await nav('sources');
    await content.locator('button.source-card').filter({ has: page.getByText(name, { exact: true }) }).press('Enter');
    await button('服务器歌单').press('Enter');
  };

  expect(source.playlistWritable).toBe(true);
  const baseline = (await list(source.id, 'playlists')).items.find(item => item.name === playlistName);
  const baselineRows = await list(source.id, baseline.path);
  expect(baselineRows.playlistWritable).toBe(true);
  const trackIds = new Map(baselineRows.items.map(item => [item.name, item.id]));
  await openServerPlaylists(source.name);
  await button('新建 Jellyfin 歌单').press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('歌单名称').fill(createdName);
  const [creation] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === base(source.id) + '/playlist' && response.request().method() === 'POST'),
    button('创建歌单', dialog).press('Enter'),
  ]);
  expect(creation.status(), await creation.text()).toBe(201);
  const { playlist: created } = await creation.json();
  await expect(content.getByRole('heading', { name: createdName, exact: true })).toBeVisible();
  await expect(content.getByText('此歌单没有歌曲', { exact: true })).toBeVisible();
  expect((await list(source.id, created.path)).items).toEqual([]);
  const nativeList = await jellyfin(origin, '/Items?' + new URLSearchParams({ UserId: native.userId, IncludeItemTypes: 'Playlist', Recursive: 'true' }), { token: native.token });
  expect(nativeList.status).toBe(200);
  const { Id: createdNativeId } = (await nativeList.json()).Items.find(item => item.Name === createdName);
  const privacy = await jellyfin(origin, '/Playlists/' + createdNativeId, { token: native.token });
  expect(privacy.status).toBe(200);
  expect((await privacy.json()).OpenAccess).toBe(false);
  expect(await nativeTitles(createdNativeId)).toEqual([]);

  await nav('songs');
  await content.locator('tr').filter({ hasText: title }).getByRole('button', { name: '歌曲选项' }).press('Enter');
  await button('添加到 Jellyfin 歌单', dialog).press('Enter');
  await button(createdName, dialog).press('Enter');
  await expect.poll(() => nativeTitles(createdNativeId)).toEqual([title]);
  for (const name of [secondTitle, title]) {
    const added = await mutate(source.id, created.path, { action: 'add', trackId: trackIds.get(name) });
    expect(added.status(), await added.text()).toBe(200);
  }
  const grouped = await list(source.id, created.path);
  const copies = grouped.items.filter(item => item.name === title);
  expect(copies.map(item => item.playlistRemoveCount)).toEqual([2, 2]);
  expect(new Set(copies.map(item => item.playlistRemoveEntry)).size).toBe(1);
  expect(copies[0].playlistRemoveEntry).toMatch(/^[\w-]{24}$/);
  expect(copies.every(item => item.playlistEntry === undefined)).toBe(true);
  const nativeCopies = (await nativeRows(createdNativeId)).filter(item => item.Name === title);
  expect(nativeCopies).toHaveLength(2);
  expect(new Set(nativeCopies.map(item => item.PlaylistItemId)).size).toBe(1);
  const tampered = await mutate(source.id, created.path, { action: 'remove', entryId: copies[0].playlistRemoveEntry }, 'https://unrelated.invalid');
  expect(tampered.status()).toBe(403);
  const target = native.tracks.find(item => item.Name === title).Id;
  const where = new URLSearchParams({ Ids: target, UserId: native.userId });
  expect((await jellyfin(origin, '/Playlists/' + createdNativeId + '/Items?' + where, { method: 'POST', token: native.token })).status).toBe(204);
  const stale = await mutate(source.id, created.path, { action: 'remove', entryId: copies[0].playlistRemoveEntry });
  expect(stale.status()).toBe(409);
  expect(await nativeTitles(createdNativeId)).toEqual([title, secondTitle, title, title]);

  await openServerPlaylists(source.name);
  await button(createdName).press('Enter');
  await expect(content.locator('.track-name')).toHaveText([title, secondTitle, title, title]);
  const removeGroup = content.locator('[data-action="remove-jellyfin-playlist-entries"]').first();
  await expect(removeGroup).toHaveAccessibleName(/当前 3 项/);
  await removeGroup.press('Enter');
  await expect(dialog).toContainText(title);
  await expect(dialog).toContainText('3');
  await dialog.locator('[data-action="confirm-remove-jellyfin-playlist-entries"]').press('Enter');
  await expect.poll(() => nativeTitles(createdNativeId)).toEqual([secondTitle]);
  await expect(content.locator('.track-name')).toHaveText([secondTitle]);
  await page.reload();
  await openServerPlaylists(source.name);
  await button(createdName).press('Enter');
  await expect(content.locator('.track-name')).toHaveText([secondTitle]);
  await button('播放歌单').press('Enter');
  await expect(page.locator('#player-title')).toHaveText(secondTitle);
  await expect.poll(() => page.locator('#audio').evaluate(audio => !audio.paused && audio.currentTime > 0.1)).toBe(true);

  const readerName = 'jellyfin-fixture-shared';
  const userResult = await jellyfin(origin, '/Users/New', { method: 'POST', token: native.token, body: { Name: readerName, Password: password } });
  expect(userResult.status).toBe(200);
  const reader = await userResult.json();
  expect(reader.Policy.IsAdministrator).toBe(false);
  const share = canEdit => jellyfin(origin, '/Playlists/' + native.playlistId + '/Users/' + reader.Id,
    { method: 'POST', token: native.token, body: { CanEdit: canEdit } });
  expect((await share(false)).status).toBe(204);
  const readerSourceName = 'Jellyfin shared fixture';
  const connection = await page.request.post('/api/sources', { data: {
    type: 'jellyfin', name: readerSourceName, url: origin, username: readerName, password,
  } });
  expect(connection.status(), await connection.text()).toBe(201);
  const { source: shared } = await connection.json();
  const sharedFolders = await list(shared.id, 'playlists');
  expect(sharedFolders.items.map(item => item.name)).not.toContain(createdName);
  const sharedList = sharedFolders.items.find(item => item.name === playlistName);
  expect(sharedList.playlistWritable).toBe(false);
  const readOnly = await list(shared.id, sharedList.path);
  expect(readOnly.playlistWritable).toBe(false);
  const remove = entryId => mutate(shared.id, sharedList.path, { action: 'remove', entryId });
  expect((await remove(baselineRows.items[0].playlistEntry)).status()).toBe(403);
  expect((await mutate(shared.id, sharedList.path, { action: 'add', trackId: readOnly.items[0].id })).status()).toBe(403);
  expect(await nativeTitles(native.playlistId)).toEqual([secondTitle, title]);
  await page.reload();
  await openServerPlaylists(readerSourceName);
  await button(playlistName).press('Enter');
  await expect(content.locator('.track-name')).toHaveText([secondTitle, title]);
  await expect(content.locator('[data-action^="remove-jellyfin-playlist-entr"]')).toHaveCount(0);

  expect((await share(true)).status).toBe(204);
  const editable = await list(shared.id, sharedList.path);
  expect(editable.playlistWritable).toBe(true);
  const ownEntry = editable.items[1].playlistEntry;
  expect(ownEntry).toMatch(/^[\w-]{24}$/);
  expect(ownEntry).not.toBe(baselineRows.items[1].playlistEntry);
  expect((await remove(baselineRows.items[1].playlistEntry)).status()).toBe(404);
  expect((await remove(ownEntry)).status()).toBe(200);
  expect(await nativeTitles(native.playlistId)).toEqual([secondTitle]);
  expect((await remove(ownEntry)).status()).toBe(404);
  await verifyApiKeyPlaylists(page, origin, native, reader, password, created.path);
}

test('authenticates to a real Jellyfin library, streams audio and edits scoped server playlists', async ({ page }) => {
  test.skip(!jellyfinBin || !ffmpeg, 'Provide JELLYFIN_TEST_BIN and FFMPEG_TEST_BIN (with ffprobe next to it) to run the live fixture.');
  test.setTimeout(145_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'groovebox-jellyfin-fixture-')));
  const config = join(root, 'config');
  const cache = join(root, 'cache');
  const music = join(root, 'music');
  const albumDirectory = join(music, artist, album);
  const firstDisc = join(albumDirectory, 'Disc 1');
  const secondDisc = join(albumDirectory, 'Disc 2');
  const fixturePath = join(firstDisc, 'Recording.flac');
  const username = 'groovebox-fixture';
  const password = randomBytes(24).toString('hex');
  let server;
  try {
    await Promise.all([mkdir(config), mkdir(cache), mkdir(firstDisc, { recursive: true }), mkdir(secondDisc, { recursive: true })]);
    await exec(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-metadata', 'artist=' + artist, '-metadata', 'album_artist=' + artist,
      '-metadata', 'album=' + album, '-metadata', 'title=' + title,
      '-metadata', 'disc=1', '-metadata', 'disctotal=2', '-metadata', 'track=1',
      '-c:a', 'flac', fixturePath,
    ], { timeout: 10_000 });
    await exec(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=12',
      '-metadata', 'artist=' + artist, '-metadata', 'album_artist=' + artist,
      '-metadata', 'album=' + album, '-metadata', 'title=' + secondTitle,
      '-metadata', 'disc=2', '-metadata', 'disctotal=2', '-metadata', 'track=1',
      '-c:a', 'flac', join(secondDisc, 'Second.flac'),
    ], { timeout: 10_000 });
    await exec(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x96:d=1',
      '-frames:v', '1', join(albumDirectory, 'folder.jpg'),
    ], { timeout: 10_000 });
    await writeFile(join(firstDisc, 'Recording.lrc'), '[00:01.00]Jellyfin fixture lyrics\n[00:03.00]Second fixture line\n');

    const port = await availableLoopbackPort();
    await writeFile(join(config, 'network.xml'), `<NetworkConfiguration>
      <InternalHttpPort>${port}</InternalHttpPort>
      <LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses>
      <AutoDiscovery>false</AutoDiscovery>
      <EnableIPv6>false</EnableIPv6>
      <EnableRemoteAccess>false</EnableRemoteAccess>
    </NetworkConfiguration>`);
    server = spawn(resolve(jellyfinBin), [
      '--datadir', join(root, 'data'), '--configdir', config, '--cachedir', cache, '--logdir', join(root, 'logs'),
      '--ffmpeg', resolve(ffmpeg), '--nowebclient', '--nonetchange',
    ], {
      cwd: root,
      env: {
        ...process.platform === 'win32' && { SystemRoot: process.env.SystemRoot },
        PATH: dirname(resolve(ffmpeg)) + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
        XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: root,
      },
      stdio: 'ignore',
    });
    server.on('error', () => {});
    const origin = 'http://127.0.0.1:' + port;
    const native = await prepareLibrary(origin, username, password, music);
    const files = [fixturePath, join(secondDisc, 'Second.flac'), join(albumDirectory, 'folder.jpg'), join(firstDisc, 'Recording.lrc')];
    const originals = await Promise.all(files.map(file => readFile(file)));

    await page.goto('/#sources');
    await page.getByRole('button', { name: /添加媒体服务器/ }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('协议').selectOption('jellyfin');
    await dialog.getByLabel('名称').fill('Jellyfin fixture');
    await dialog.getByLabel('服务地址').fill(origin);
    await dialog.getByLabel('用户名').fill(username);
    await dialog.getByLabel('密码').fill(password);
    const connected = page.waitForResponse(response => response.url().endsWith('/api/sources') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '连接', exact: true }).press('Enter');
    const response = await connected;
    expect(response.status()).toBe(201);
    const { source } = await response.json();
    await page.getByRole('button', { name: library, exact: true }).press('Enter');
    await page.getByRole('button', { name: artist, exact: true }).press('Enter');
    await page.getByRole('button', { name: album, exact: true }).press('Enter');
    await expect(page.locator('.disc-heading')).toHaveText(['第 1 碟', '第 2 碟']);
    await expect(page.locator('#content .track-name')).toHaveText([title, secondTitle]);
    await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
    await expect(page.getByRole('status').filter({ hasText: '扫描完成，共找到 2 首歌曲' })).toBeVisible();

    const track = page.getByRole('button', { name: new RegExp(title + ' ' + artist) });
    await expect(track).toBeVisible();
    await expect(page.getByRole('cell', { name: album, exact: true }).first()).toBeVisible();
    const cover = await track.locator('img').getAttribute('src');
    expect(cover).toMatch(/^\/api\/sources\/[^/]+\/cover\?id=/);
    await expect.poll(() => track.locator('img').evaluate(media => media.naturalWidth)).toBeGreaterThan(0);
    const imageResponse = await page.request.get(cover);
    expect(imageResponse.status()).toBe(200);
    expect(imageResponse.headers()['content-type']).toMatch(/^image\//);

    const lyricsPromise = page.waitForResponse(response => response.url().endsWith('-lyrics'));
    const [stream] = await Promise.all([
      page.waitForResponse(response => /\/api\/sources\/[^/]+\/stream\?id=[\w-]+$/.test(response.url()) && !response.url().endsWith('-lyrics')),
      track.press('Enter'),
    ]);
    expect(stream.ok()).toBe(true);
    expect(stream.headers()['content-type']).toBe('audio/flac');
    await expect(page.locator('#player-title')).toHaveText(title);
    const audio = page.locator('#audio');
    await expect.poll(() => audio.evaluate(player => player.currentTime)).toBeGreaterThan(0.1);
    await expect.poll(() => audio.evaluate(player => player.duration)).toBeGreaterThan(11);
    const range = await page.request.get(stream.url(), { headers: { Range: 'bytes=0-15' } });
    const fixtureBytes = await readFile(fixturePath);
    expect(range.status()).toBe(206);
    expect(range.headers()['content-range']).toBe('bytes 0-15/' + fixtureBytes.length);
    expect(await range.body()).toEqual(fixtureBytes.subarray(0, 16));
    const lyrics = await lyricsPromise;
    await page.locator('#player-art').press('Enter');
    expect(lyrics.status()).toBe(200);
    expect(await lyrics.json()).toEqual({ lines: [
      { text: 'Jellyfin fixture lyrics', time: 1 },
      { text: 'Second fixture line', time: 3 },
    ] });
    await expect(page.getByRole('button', { name: 'Jellyfin fixture lyrics', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '服务器歌单', exact: true }).press('Enter');
    await page.getByRole('button', { name: playlistName, exact: true }).press('Enter');
    const orderedTitles = [secondTitle, title];
    await expect(page.locator('.track-table .track-name')).toHaveText(orderedTitles);
    await expect(page.locator('.disc-heading')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: '排序' })).toHaveCount(0);
    await page.getByRole('button', { name: '播放歌单', exact: true }).press('Enter');
    await expect(page.locator('#player-title')).toHaveText(secondTitle);
    await expect(page.locator('.queue-row .track-name')).toHaveText(orderedTitles);
    await page.getByRole('button', { name: '保存为本地镜像', exact: true }).press('Enter');
    await expect(page).toHaveURL(/server-playlist/);
    await page.reload();
    await expect(page.locator('.track-table .track-name')).toHaveText(orderedTitles);
    await page.locator('#sidebar [data-nav="albums"]').press('Enter');
    await page.locator('#content button.card').filter({ has: page.getByText(album, { exact: true }) }).press('Enter');
    await expect(page.locator('#content .disc-heading')).toHaveText(['第 1 碟', '第 2 碟']);
    await expect(page.locator('#content .track-name')).toHaveText([title, secondTitle]);
    await verifyPlaylistWrites(page, origin, native, source, password);
    expect(await Promise.all(files.map(file => readFile(file)))).toEqual(originals);
  } finally {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const closed = once(server, 'exit');
      server.kill();
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});
