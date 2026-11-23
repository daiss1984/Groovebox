import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateBuffer } from 'music-metadata';

// Set GROOVEBOX_WEBDAV_TEST_PYTHON to a Python executable with WsgiDAV and Cheroot installed.
// For HTTPS, also set GROOVEBOX_WEBDAV_TEST_CERT and GROOVEBOX_WEBDAV_TEST_KEY for 127.0.0.1.
// Start Playwright with NODE_EXTRA_CA_CERTS pointing to the fixture's CA certificate.
const python = process.env.GROOVEBOX_WEBDAV_TEST_PYTHON;
const certificate = process.env.GROOVEBOX_WEBDAV_TEST_CERT;
const privateKey = process.env.GROOVEBOX_WEBDAV_TEST_KEY;
const username = 'fixture-user';
const password = 'fixture-password';
const davScript = [
  'import json, sys',
  'from cheroot.ssl.builtin import BuiltinSSLAdapter',
  'from cheroot.wsgi import Server',
  'from wsgidav.wsgidav_app import WsgiDAVApp',
  'root, username, password, cert, key = sys.argv[1:]',
  'app = WsgiDAVApp({"provider_mapping": {"/": root}, "verbose": 0, "dir_browser": {"enable": False},',
  '  "http_authenticator": {"accept_basic": True, "accept_digest": False, "default_to_digest": False},',
  '  "simple_dc": {"user_mapping": {"*": {username: {"password": password}}}}})',
  'def observed_app(environ, start_response):',
  '  if environ["REQUEST_METHOD"] == "PROPFIND": print("WEBDAV_PROPFIND=" + json.dumps(environ["PATH_INFO"]), flush=True)',
  '  if environ["REQUEST_METHOD"] == "GET": print("WEBDAV_GET=" + json.dumps([environ["PATH_INFO"], environ.get("HTTP_RANGE")]), flush=True)',
  '  return app(environ, start_response)',
  'server = Server(("127.0.0.1", 0), observed_app)',
  'if cert and key: server.ssl_adapter = BuiltinSSLAdapter(cert, key)',
  'server.prepare()',
  'print("WEBDAV_PORT=" + str(server.bind_addr[1]), flush=True)',
  'server.serve()',
].join('\n');

const nav = (page, section) => page.locator('#sidebar [data-nav="' + section + '"]');
const dialog = page => page.getByRole('dialog');
const playlist = (page, name) => page.locator('#playlist-nav').getByRole('button', { name });
const row = (page, name) => page.locator('#content tr').filter({ has: page.getByRole('button', { name }) });

async function createPlaylist(page, name) {
  await page.locator('.add-playlist').press('Enter');
  await dialog(page).getByRole('textbox').fill(name);
  await dialog(page).getByRole('button', { name: '创建' }).press('Enter');
  await expect(playlist(page, name)).toBeVisible();
}

async function addTrack(page, song, name) {
  await nav(page, 'songs').press('Enter');
  await row(page, song).locator('[data-action=track-menu]').press('Enter');
  await dialog(page).getByRole('button', { name: '添加到歌单' }).press('Enter');
  await dialog(page).getByRole('button', { name }).press('Enter');
}

async function connectShare(page, address, name = '实际 WebDAV') {
  await nav(page, 'sources').press('Enter');
  await page.locator('[data-action=add-source]').press('Enter');
  const form = dialog(page);
  await form.getByLabel('名称').fill(name);
  await form.getByLabel('服务地址').fill(address);
  await form.getByLabel('用户名').fill(username);
  await form.getByLabel('密码').fill(password);
  await form.getByRole('button', { name: '连接', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function enableAutoSync(page) {
  await dialog(page).getByRole('button', { name: '启用自动同步' }).press('Enter');
  await expect(dialog(page).getByRole('status')).toHaveText('已同步歌单和收藏。');
  await dialog(page).getByRole('button', { name: '关闭', exact: true }).press('Enter');
}

function launchDav(root) {
  const server = spawn(python, ['-c', davScript, root, username, password, certificate || '', privateKey || ''], { stdio: ['ignore', 'pipe', 'pipe'] });
  const folderRequests = [];
  const requests = [];
  const address = new Promise((resolve, reject) => {
    let lines = '';
    let errors = '';
    server.stderr.on('data', chunk => { errors += chunk.toString(); });
    server.once('error', reject);
    server.once('exit', code => reject(new Error('WsgiDAV exited with code ' + code + '\n' + errors)));
    server.stdout.on('data', chunk => {
      lines += chunk.toString();
      const complete = lines.split('\n');
      lines = complete.pop();
      for (const line of complete) {
        if (line.startsWith('WEBDAV_PROPFIND=')) folderRequests.push(JSON.parse(line.slice('WEBDAV_PROPFIND='.length)));
        if (line.startsWith('WEBDAV_GET=')) requests.push(JSON.parse(line.slice('WEBDAV_GET='.length)));
        const match = /^WEBDAV_PORT=(\d+)$/.exec(line);
        if (match) resolve((certificate ? 'https' : 'http') + '://127.0.0.1:' + match[1] + '/');
      }
    });
  });
  return {
    address,
    requests,
    folderRequests,
    get propfind() { return folderRequests.length; },
    async stop() {
      if (server.pid && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
    },
  };
}

test('finds authenticated artist folder photos on real HTTPS WebDAV without merging another share’s portrait', async ({ page, browser }) => {
  test.skip(!python || !certificate || !privateKey, 'Requires a trusted HTTPS WsgiDAV fixture');
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-artist-'));
  const server = launchDav(root);
  try {
    const artist = 'ÉCHO 乐队';
    const filenameArtist = 'e\u0301cho 乐队';
    const albumArtist = '纸上艺人';
    const alpha = '第一来源';
    const beta = '第二来源';
    const contents = ['public/assets/demo-1.m4a', 'public/assets/cover-1.jpg', 'public/assets/cover-2.jpg', 'public/assets/cover-3.jpg'];
    const [audio, first, second, replacement] = await Promise.all(contents.map(path => readFile(new URL('../' + path, import.meta.url))));
    for (const share of ['alpha', 'beta']) {
      await mkdir(join(root, share, 'artist'), { recursive: true });
      const name = share === 'alpha' ? 'First Recording' : 'Second Recording';
      await writeFile(join(root, share, name + '.m4a'), Buffer.from(await updateBuffer(audio, {
        title: name, artist, album: share === 'alpha' ? '第一张专辑' : '第二张专辑',
        ...(share === 'alpha' && { albumartist: albumArtist }),
      })));
      await writeFile(join(root, share, 'artist', filenameArtist + '.jpg'), share === 'alpha' ? first : second);
    }
    await writeFile(join(root, 'alpha', 'artist', filenameArtist + '.png'), '<svg>invalid raster</svg>');
    await writeFile(join(root, 'alpha', 'artist', albumArtist + '.jpg'), first);
    await writeFile(join(root, 'alpha', filenameArtist + '.jpg'), second);

    const origin = await server.address;
    const content = page.locator('#content');
    const track = name => content.getByRole('button', { name: new RegExp('^' + name) });
    const localButton = name => content.getByRole('button', { name, exact: true });
    const heading = name => content.getByRole('heading', { name, exact: true });
    const card = label => content.locator('button.card').filter({ has: page.getByText(label, { exact: true }) });
    const portrait = content.locator('.artist-portrait img');
    const sourceCard = label => content.locator('.source-card-group').filter({ has: page.getByText(label, { exact: true }) });
    const readPortrait = async (image, bytes) => {
      await expect(image).toHaveAttribute('src', /^\/api\/sources\/[a-f\d-]+\/cover\?id=[\w-]{24}$/);
      await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
      const path = await image.getAttribute('src');
      const response = await page.request.get(path);
      expect(response.ok()).toBe(true);
      expect(response.headers()['cache-control']).toBe('private, no-store');
      expect(await response.body()).toEqual(bytes);
      return path;
    };
    const scanWithTags = async name => {
      await localButton('扫描并加入曲库').click();
      await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
      await track(name).waitFor();
      await row(page, new RegExp('^' + name)).locator('[data-action=track-menu]').click();
      await dialog(page).getByRole('button', { name: '读取音频标签', exact: true }).click();
      await expect(page.locator('#toast')).toContainText('已更新歌曲标签');
    };

    const onlineArtistQueries = [];
    await page.route('**/api/artwork/artist?**', route => {
      onlineArtistQueries.push(route.request().url());
      return route.fulfill({ status: 404 });
    });
    await page.route('**/api/artwork/album?**', route => route.fulfill({ status: 404 }));
    await page.goto('/');
    await connectShare(page, new URL('alpha/', origin).href, alpha);
    await scanWithTags('First Recording');
    await nav(page, 'settings').click();
    await content.locator('#online-cover').check();
    await nav(page, 'artists').click();
    const initialPath = await readPortrait(card(artist).locator('img'), first);
    await card(artist).press('Enter');
    await expect(heading(artist)).toBeVisible();
    expect(await readPortrait(portrait, first)).toBe(initialPath);
    expect(onlineArtistQueries).toEqual([]);

    const unauthenticated = await browser.newContext();
    try {
      const appOrigin = new URL(page.url()).origin;
      expect((await unauthenticated.request.get(new URL(initialPath, appOrigin).href)).status()).toBe(404);
      const indexPath = initialPath.slice(0, initialPath.indexOf('/cover?')) + '/artist-portraits';
      expect((await unauthenticated.request.get(new URL(indexPath, appOrigin).href)).status()).toBe(404);
    } finally { await unauthenticated.close(); }

    await nav(page, 'albums').click();
    await card('第一张专辑').click();
    await content.getByRole('link', { name: albumArtist, exact: true }).click();
    await expect(heading(albumArtist)).toBeVisible();
    await readPortrait(portrait, first);
    await nav(page, 'settings').click();
    await content.locator('#online-cover').uncheck();

    await connectShare(page, new URL('beta/', origin).href, beta);
    await scanWithTags('Second Recording');
    const secondSourceId = decodeURIComponent(new URL(page.url()).hash.slice(1)).slice('source/'.length);
    const indexLoaded = page.waitForResponse(response => response.ok() &&
      new URL(response.url()).pathname === '/api/sources/' + secondSourceId + '/artist-portraits');
    await nav(page, 'artists').click();
    await indexLoaded;
    await card(artist).click();
    await expect(heading(artist)).toBeVisible();
    await expect(portrait).toHaveCount(0);

    await nav(page, 'sources').click();
    await sourceCard(alpha).getByRole('button', { name: '从曲库隐藏', exact: true }).click();
    await nav(page, 'artists').click();
    await readPortrait(card(artist).locator('img'), second);
    await card(artist).click();
    await readPortrait(portrait, second);

    await writeFile(join(root, 'beta', 'artist', filenameArtist + '.jpg'), replacement);
    await nav(page, 'sources').click();
    await sourceCard(beta).locator('button.source-card').click();
    await localButton('刷新目录').click();
    await expect(track('Second Recording')).toBeVisible();
    await nav(page, 'artists').click();
    await card(artist).click();
    const refreshed = await readPortrait(portrait, replacement);
    const artistFolderReads = server.folderRequests.filter(path => path.endsWith('/artist/')).length;
    await page.reload();
    await expect(heading(artist)).toBeVisible();
    expect(await readPortrait(portrait, replacement)).toBe(refreshed);
    expect(artistFolderReads).toBeGreaterThanOrEqual(2);
    expect(server.folderRequests.filter(path => path.endsWith('/artist/'))).toHaveLength(artistFolderReads);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('persists independent filename rules and reindexes raw tracks from an actual WebDAV source', async ({ page }) => {
  test.skip(!python, 'Requires GROOVEBOX_WEBDAV_TEST_PYTHON with WsgiDAV and Cheroot installed');
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-filename-'));
  const server = launchDav(root);
  try {
    const primary = '文件名 WebDAV';
    const secondary = '另一来源';
    const folder = '海湾现场-驻场艺人';
    const secondFolder = '第二张专辑-第二位艺人';
    await Promise.all([mkdir(join(root, 'first', folder), { recursive: true }), mkdir(join(root, secondFolder))]);
    const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    const tagAudio = Buffer.from(await updateBuffer(audio, { title: '内嵌曲名', artist: '内嵌艺人', album: '内嵌专辑' }));
    const targetName = '10-潮汐-客座歌手';
    const targetFile = targetName + '.m4a';
    await Promise.all([
      writeFile(join(root, 'first', folder, targetFile), tagAudio),
      writeFile(join(root, 'first', folder, targetName + '.lrc'), '[00:00.00]潮来的时候'),
      writeFile(join(root, 'first', folder, '2-开场-客席艺人.m4a'), audio),
      writeFile(join(root, 'first', folder, '3-歌名-带连字符-客席艺人.m4a'), audio),
      writeFile(join(root, secondFolder, '访客_演唱者.m4a'), audio),
    ]);
    await page.goto('/');
    const base = await server.address;
    const content = page.locator('#content');
    const title = name => content.getByRole('button', { name: new RegExp('^' + name + '(?: |$)') });
    const scoped = label => content.getByRole('button', { name: label, exact: true });
    const ruleButton = () => scoped('文件名解析');
    const setRule = async (mode, pattern) => {
      await ruleButton().click();
      const form = dialog(page);
      await form.getByLabel('歌曲信息来源').selectOption(mode);
      if (pattern !== undefined) await form.getByLabel('文件名规则').fill(pattern);
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expect(form).toBeHidden();
    };
    const catalogTitles = content.locator('tbody .track-name');
    const openSourceCard = async name => {
      await nav(page, 'sources').click();
      await content.locator('article').filter({ has: page.getByText(name, { exact: true }) }).locator('button.source-card').click();
      await expect(content.getByRole('heading', { name, exact: true })).toBeVisible();
    };
    await connectShare(page, new URL('first/', base).href, primary);
    await scoped(folder).click();
    await expect(title(targetName)).toBeVisible();
    await scoped('扫描并加入曲库').click();
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 3 首歌曲');

    await ruleButton().click();
    const ruleDialog = dialog(page);
    await expect(ruleDialog.getByLabel('文件名规则')).toHaveValue('name');
    await ruleDialog.getByLabel('歌曲信息来源').selectOption('filename');
    await ruleDialog.getByLabel('文件名规则').fill('track-artist');
    await ruleDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(ruleDialog.getByRole('status')).toContainText('规则必须有且仅有一个 name');
    await ruleDialog.getByLabel('文件名规则').fill('track-name-artist');
    await ruleDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(title('潮汐 客座歌手')).toBeVisible();
    await expect(title('3-歌名-带连字符-客席艺人 驻场艺人')).toBeVisible();
    await content.getByRole('combobox', { name: '排序', exact: true }).selectOption('file-name');
    await expect(catalogTitles).toHaveText(['开场', '3-歌名-带连字符-客席艺人', '潮汐']);

    await nav(page, 'songs').click();
    await expect(title(targetName)).toBeVisible();
    await openSourceCard(primary);
    await scoped(folder).click();
    await scoped('重新扫描目录').click();
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 3 首歌曲');
    await nav(page, 'songs').click();
    await expect(title('潮汐 客座歌手')).toBeVisible();
    await createPlaylist(page, '曲目身份测试');
    await addTrack(page, /^潮汐 客座歌手$/, '曲目身份测试');
    await row(page, /^潮汐 客座歌手$/).locator('[data-action=track-menu]').click();
    await dialog(page).getByRole('button', { name: '读取音频标签', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('已更新歌曲标签');
    await expect(title('潮汐 客座歌手')).toBeVisible();
    await expect(title('内嵌曲名')).toHaveCount(0);

    await title('潮汐 客座歌手').click();
    await expect.poll(() => page.locator('#audio').evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
    await page.locator('#now').getByRole('button', { name: '歌词', exact: true }).click();
    await expect(page.locator('#now').getByRole('button', { name: '潮来的时候', exact: true })).toBeVisible();
    await expect.poll(() => server.requests.filter(([, range]) => range).map(([path]) =>
      Buffer.from(path, 'latin1').toString('utf8'))).toContain(`/first/${folder}/${targetFile}`);
    await nav(page, 'albums').click();
    await expect(content.getByRole('button', { name: /^海湾现场.*驻场艺人/ })).toBeVisible();

    await connectShare(page, new URL(secondFolder + '/', base).href, secondary);
    await expect(title('访客_演唱者')).toBeVisible();
    await setRule('filename', 'name_artist');
    await expect(title('访客 演唱者')).toBeVisible();
    await expect(content.locator('tbody td').filter({ hasText: '第二张专辑' })).toBeVisible();
    await page.reload();
    await expect(title('访客 演唱者')).toBeVisible();
    await openSourceCard(primary);
    await scoped(folder).click();
    await expect(title('潮汐 客座歌手')).toBeVisible();
    await setRule('tags');
    await expect(title('内嵌曲名 内嵌艺人')).toBeVisible();
    await scoped('重新扫描目录').click();
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 3 首歌曲');
    await playlist(page, '曲目身份测试').click();
    await expect(title('内嵌曲名 内嵌艺人')).toBeVisible();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('uses same-folder covers on real HTTPS WebDAV and prioritizes embedded artwork', async ({ page }) => {
  test.skip(!python || !certificate || !privateKey, 'Requires the trusted HTTPS WsgiDAV fixture');
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-folder-cover-'));
  const server = launchDav(root);
  try {
    const album = join(root, '唱片');
    const nested = join(album, '子目录');
    await mkdir(nested, { recursive: true });
    const [audio, embedded, jpeg] = await Promise.all(['demo-1.m4a', 'cover-1.jpg', 'cover-2.jpg']
      .map(file => readFile(new URL('../public/assets/' + file, import.meta.url))));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=', 'base64');
    const writeTrack = async (directory, title, picture) => writeFile(join(directory, title + '.m4a'),
      Buffer.from(await updateBuffer(audio, { title, artist: 'Fixture Artist', album: 'Fixture Record',
        ...(picture && { picture: [{ type: 'Cover (front)', format: 'image/jpeg', data: picture }] }) })));
    await Promise.all([
      writeTrack(album, 'First'), writeTrack(album, 'Second', embedded), writeTrack(nested, 'Nested'),
      writeFile(join(album, 'cover.png'), png), writeFile(join(album, 'COVER.JPG'), jpeg),
    ]);

    await page.goto('/');
    await connectShare(page, await server.address, 'Cover WebDAV');
    const content = page.locator('#content');
    const tracks = content.locator('.track-main');
    const song = title => tracks.filter({ hasText: title });
    const trackImage = title => song(title).locator('img');
    const imageBytes = async (image, bytes) => {
      await expect(image).toHaveAttribute('src', /^\/api\/sources\/[\w-]+\/cover\?id=[\w-]+$/);
      await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
      const response = await page.request.get(await image.getAttribute('src'));
      expect(response.status()).toBe(200);
      expect(await response.body()).toEqual(bytes);
    };
    const openAlbum = () => content.getByRole('button', { name: '唱片', exact: true }).press('Enter');
    await openAlbum();
    await expect(tracks).toHaveCount(2);
    await imageBytes(trackImage('First'), png);
    const originalFolderCover = await trackImage('First').getAttribute('src');
    await expect(trackImage('Second')).toHaveAttribute('src', originalFolderCover);
    await content.getByRole('button', { name: '子目录', exact: true }).press('Enter');
    await expect(song('Nested')).toBeVisible();
    await expect(trackImage('Nested')).toHaveCount(0);
    await openAlbum();
    await content.getByRole('button', { name: '批量读取音频标签', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toContainText('标签读取完成');
    await expect(trackImage('Second')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    const embeddedThumbnail = await trackImage('Second').getAttribute('src');
    await imageBytes(trackImage('First'), png);
    await content.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 3 首歌曲');

    await nav(page, 'albums').press('Enter');
    const card = content.getByRole('button', { name: /Fixture Record/ });
    await expect(card.locator('img')).toHaveAttribute('src', embeddedThumbnail);
    await card.press('Enter');
    await expect(content.locator('.album-detail-cover img')).toHaveAttribute('src', embeddedThumbnail);
    await nav(page, 'songs').press('Enter');
    await page.reload();
    await imageBytes(trackImage('First'), png);
    await expect(trackImage('Second')).toHaveAttribute('src', embeddedThumbnail);
    await expect(trackImage('Nested')).toHaveCount(0);
    await song('First').press('Enter');
    const player = page.locator('#audio');
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
    const playerArt = page.locator('#player-art img');
    const playback = () => player.evaluate(element => ({ source: element.currentSrc, position: element.currentTime, paused: element.paused }));
    await imageBytes(playerArt, png);
    const start = await playback();

    await writeFile(join(album, 'cover.png'), '<svg/>');
    await content.getByRole('button', { name: '刷新曲库', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toContainText('曲库已刷新');
    await imageBytes(trackImage('First'), jpeg);
    await expect(trackImage('First')).not.toHaveAttribute('src', originalFolderCover);
    await expect(trackImage('Second')).toHaveAttribute('src', embeddedThumbnail);
    await imageBytes(playerArt, jpeg);
    const afterReplacement = await playback();
    expect(afterReplacement).toMatchObject({ source: start.source, paused: false });
    expect(afterReplacement.position).toBeGreaterThan(start.position);
    await Promise.all([rm(join(album, 'cover.png')), rm(join(album, 'COVER.JPG'))]);
    await content.getByRole('button', { name: '刷新曲库', exact: true }).press('Enter');
    await expect(trackImage('First')).toHaveCount(0);
    await expect(trackImage('Second')).toHaveAttribute('src', embeddedThumbnail);
    await expect(playerArt).toHaveCount(0);
    const afterRemoval = await playback();
    expect(afterRemoval).toMatchObject({ source: start.source, paused: false });
    expect(afterRemoval.position).toBeGreaterThan(afterReplacement.position);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test.describe('offline WebDAV folder artwork', () => {
  test.use({ serviceWorkers: 'allow' });

  test('retains only a downloaded track’s authenticated folder cover after an offline reload', async ({ page, context }) => {
    test.skip(!python || !certificate || !privateKey, 'Requires the trusted HTTPS WsgiDAV fixture');
    const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-offline-cover-'));
    const server = launchDav(root);
    try {
      const original = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=', 'base64');
      await Promise.all([
        writeFile(join(root, 'cover.png'), png), writeFile(join(root, 'Saved Recording.m4a'), original),
        writeFile(join(root, 'Unsaved Recording.m4a'), original),
      ]);

      // A pre-existing audio record must survive the upgrade that adds the cover store.
      await page.goto('/assets/cover-1.jpg');
      await page.evaluate(() => new Promise((resolve, reject) => {
        const creation = indexedDB.open('groovebox.offline', 1);
        creation.onupgradeneeded = () => creation.result.createObjectStore('audio', { keyPath: 'id' }).put({
          id: 'legacy-offline', binary: { buffer: new Uint8Array([1, 2, 3]).buffer, type: 'audio/mp4' },
        });
        creation.onerror = () => reject(creation.error);
        creation.onsuccess = () => { creation.result.close(); resolve(); };
      }));
      await page.goto('/');
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await connectShare(page, await server.address, 'Offline Covers WebDAV');
      await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
      await expect(page.locator('#toast')).toContainText('扫描完成，共找到 2 首歌曲');
      await nav(page, 'songs').press('Enter');
      const saved = row(page, /^Saved Recording/);
      const unsaved = row(page, /^Unsaved Recording/);
      async function saveOriginal() {
        await saved.getByRole('button', { name: '歌曲选项' }).press('Enter');
        const downloadEvent = page.waitForEvent('download');
        await dialog(page).getByRole('button', { name: '保存原始音频到本机', exact: true }).press('Enter');
        const download = await downloadEvent;
        expect(download.suggestedFilename()).toMatch(/^Saved Recording\.(?:m4a|mp4)$/);
        expect(await readFile(await download.path())).toEqual(original);
      }
      const source = await saved.locator('.track-main img').getAttribute('src');
      expect(source).toMatch(/^\/api\/sources\/[\w-]+\/cover\?id=/);
      await expect(unsaved.locator('.track-main img')).toHaveAttribute('src', source);
      const id = await saved.getAttribute('data-track');
      await saveOriginal();
      await saved.getByRole('button', { name: '歌曲选项' }).press('Enter');
      await dialog(page).getByRole('button', { name: '离线保存', exact: true }).press('Enter');
      await expect(page.locator('#toast')).toContainText('音频已保存');
      const storageKeys = () => page.evaluate(() => new Promise((resolve, reject) => {
        const opening = indexedDB.open('groovebox.offline');
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const database = opening.result;
          const transaction = database.transaction(['audio', 'folder-covers']);
          const audio = transaction.objectStore('audio').getAllKeys();
          const art = transaction.objectStore('folder-covers').getAllKeys();
          transaction.oncomplete = () => { database.close(); resolve({ audio: audio.result, art: art.result }); };
          transaction.onerror = () => { database.close(); reject(transaction.error); };
        };
      }));
      await expect.poll(storageKeys).toEqual({ audio: ['legacy-offline', id].sort(), art: [id] });
      const globalCache = await page.evaluate(async () => {
        const entries = await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(entry => entry.url)));
        return entries.flat().some(url => url.includes('/api/sources/') && url.includes('/cover?'));
      });
      expect(globalCache).toBe(false);

      await server.stop();
      await context.setOffline(true);
      await page.reload();
      const cachedArt = saved.locator('.track-main img');
      await expect(cachedArt).toHaveAttribute('src', /^blob:/);
      await expect.poll(() => cachedArt.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
      expect(await cachedArt.evaluate(async image => Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())))).toEqual([...png]);
      await expect(unsaved.locator('.track-main img')).toHaveCount(0);
      await nav(page, 'offline').press('Enter');
      await saved.locator('.track-main').press('Enter');
      const playerArt = page.locator('#player-art img');
      await expect(playerArt).toHaveAttribute('src', /^blob:/);
      await expect.poll(() => playerArt.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
      const audio = page.locator('#audio');
      await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
      expect(await audio.evaluate(async element => {
        const hash = await crypto.subtle.digest('SHA-256', await (await fetch(element.currentSrc)).arrayBuffer());
        return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      })).toBe(createHash('sha256').update(original).digest('hex'));
      await saveOriginal();

      await saved.getByRole('button', { name: '删除下载', exact: true }).press('Enter');
      await dialog(page).locator('[data-action=confirm-remove-download]').press('Enter');
      await expect(saved).toHaveCount(0);
      await expect.poll(storageKeys).toEqual({ audio: ['legacy-offline'], art: [] });
    } finally {
      await context.setOffline(false);
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('saves a large original WebDAV WAV directly to disk', async ({ page }) => {
  test.skip(!python || !certificate || !privateKey, 'Requires the trusted HTTPS WsgiDAV fixture');
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-original-download-'));
  const server = launchDav(root);
  try {
    const file = join(root, '高码率原始音频.wav');
    const pcmBytes = 64 * 1024 * 1024;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(pcmBytes + 36, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(96000, 24);
    header.writeUInt32LE(384000, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmBytes, 40);
    await writeFile(file, header);
    await truncate(file, pcmBytes + header.length);
    const checksum = async path => {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest('hex');
    };

    await page.goto('/');
    await connectShare(page, await server.address, 'Large Original WebDAV');
    await row(page, /^高码率原始音频/).getByRole('button', { name: '歌曲选项' }).press('Enter');
    const downloadEvent = page.waitForEvent('download');
    await dialog(page).getByRole('button', { name: '保存原始音频到本机', exact: true }).press('Enter');
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('高码率原始音频.wav');
    const saved = await download.path();
    expect((await stat(saved)).size).toBe(pcmBytes + header.length);
    expect(await checksum(saved)).toBe(await checksum(file));
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('adds only the selected folders to an actual WebDAV library without rescanning existing folders', async ({ page }) => {
  test.skip(!python, 'Requires GROOVEBOX_WEBDAV_TEST_PYTHON with WsgiDAV and Cheroot installed');
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-choose-folders-'));
  const folders = ['Original', 'Added one', 'Added two', 'Skip this'];
  const server = launchDav(root);
  try {
    for (const name of folders) {
      const directory = join(root, name);
      await mkdir(directory);
      await copyFile(new URL('../public/assets/demo-1.m4a', import.meta.url), join(directory, name + ' recording.m4a'));
    }
    await page.goto('/');
    await connectShare(page, await server.address, 'Selected WebDAV');
    const picker = page.getByRole('button', { name: '选择要收录的目录', exact: true });
    const submit = dialog(page).getByRole('button', { name: '收录所选目录', exact: true });
    await picker.press('Enter');
    await dialog(page).getByRole('checkbox', { name: 'Original', exact: true }).press('Space');
    await submit.press('Enter');
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
    const firstScan = server.propfind;
    await picker.press('Enter');
    const existing = dialog(page).getByRole('checkbox', { name: /Original.*已收录/ });
    await expect(existing).toBeChecked();
    await expect(existing).toBeDisabled();
    for (const name of folders.slice(1, 3)) await dialog(page).getByRole('checkbox', { name, exact: true }).press('Space');
    await submit.press('Enter');
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 2 首歌曲');
    expect(server.folderRequests.slice(firstScan).map(path => path.replace(/\/$/, '')).sort()).toEqual(['/Added one', '/Added two']);

    await nav(page, 'songs').press('Enter');
    await page.reload();
    const assertIncluded = async () => {
      for (const name of folders.slice(0, 3)) await expect(row(page, new RegExp(name + ' recording'))).toBeVisible();
      await expect(row(page, /Skip this recording/)).toHaveCount(0);
    };
    await assertIncluded();
    const beforeRefresh = server.propfind;
    await page.getByRole('button', { name: '刷新曲库', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toHaveText('曲库已刷新（1 个来源）。');
    await assertIncluded();
    expect(server.folderRequests.slice(beforeRefresh).map(path => path.replace(/\/$/, '')).sort()).toEqual(['/Added one', '/Added two', '/Original']);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('reuses a prepared next track from an authenticated WsgiDAV share' + (certificate ? ' over HTTPS' : ''), async ({ page }) => {
  test.skip(!python, 'Requires GROOVEBOX_WEBDAV_TEST_PYTHON with WsgiDAV and Cheroot installed');
  expect(Boolean(certificate)).toBe(Boolean(privateKey));
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-preload-'));
  const server = launchDav(root);
  try {
    const sample = new URL('../public/assets/demo-1.m4a', import.meta.url);
    await Promise.all(['A.m4a', 'B.m4a'].map(name => copyFile(sample, join(root, name))));
    const fullRange = 'bytes=0-' + ((await stat(sample)).size - 1);
    await page.goto('/');
    await connectShare(page, await server.address);
    const warmed = page.waitForEvent('requestfinished', request => request.resourceType() === 'fetch' &&
      request.url().includes('/stream?') && request.headers().range === fullRange);
    await page.getByRole('button', { name: 'A 未知艺人', exact: true }).press('Enter');
    await warmed;
    const expected = [['/B.m4a', 'bytes=0-0'], ['/B.m4a', fullRange]];
    const playbackRequests = () => server.requests.filter(([path]) => path === '/B.m4a');
    await expect.poll(playbackRequests).toEqual(expected);
    const audio = page.locator('#audio');
    await page.getByRole('button', { name: '下一首', exact: true }).press('Enter');
    await expect(page.locator('#player-title')).toHaveText('B');
    await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(.15);
    expect(await audio.evaluate(element => element.currentSrc)).toMatch(/^blob:/);
    expect(playbackRequests()).toEqual(expected);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

for (const changed of [false, true]) test.describe('large-track preloading', () => {
  test.use({ serviceWorkers: 'allow' });

  test(changed ? 'ignores an outdated prefix of a large next WebDAV track' :
    'reuses the bounded prefix of a large next WebDAV track while streaming the rest', async ({ page }) => {
    test.skip(!python, 'Requires GROOVEBOX_WEBDAV_TEST_PYTHON with WsgiDAV and Cheroot installed');
    const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-preload-prefix-'));
    const server = launchDav(root);
    try {
      const sampleRate = 48000;
      const samples = sampleRate * 90;
      const wav = Buffer.alloc(44 + 2 * samples);
      wav.write('RIFF', 0);
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(sampleRate, 24);
      wav.writeUInt32LE(2 * sampleRate, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(2 * samples, 40);
      for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(5000 * Math.sin(i * 2 * Math.PI * 440 / sampleRate)), 44 + 2 * i);
      await Promise.all([
        copyFile(new URL('../public/assets/demo-1.m4a', import.meta.url), join(root, 'A.m4a')),
        writeFile(join(root, 'B.wav'), wav),
      ]);
      await page.goto('/');
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await connectShare(page, await server.address);
      await page.getByRole('combobox', { name: '排序' }).selectOption('title');
      const playbackRequests = () => server.requests.filter(([path]) => path === '/B.wav').map(([, range]) => range);
      const warmed = page.waitForEvent('requestfinished', request => request.resourceType() === 'fetch' &&
        request.url().includes('/stream?') && request.headers().range === 'bytes=0-262143');
      await page.getByRole('button', { name: 'A 未知艺人', exact: true }).press('Enter');
      await warmed;
      expect(playbackRequests()).toEqual(['bytes=0-0', 'bytes=0-262143']);
      if (changed) {
        const newer = new Date(Date.now() + 10_000);
        await utimes(join(root, 'B.wav'), newer, newer);
      }

      await page.getByRole('button', { name: '下一首', exact: true }).press('Enter');
      const audio = page.locator('#audio');
      await expect(page.locator('#player-title')).toHaveText('B');
      await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(.15);
      if (changed) {
        expect(playbackRequests().filter(range => range?.startsWith('bytes=0-')).length).toBeGreaterThan(2);
      } else {
        await expect.poll(playbackRequests).toContain('bytes=262144-' + (wav.length - 1));
        expect(playbackRequests()).not.toContain('bytes=0-');
      }
      expect(await audio.evaluate(element => element.currentSrc)).toMatch(/\/api\/sources\/.+_groovebox_prefix=1/);
      await audio.evaluate(element => { element.currentTime = 45; });
      await expect.poll(() => audio.evaluate(element => ({
        timeAdvanced: element.currentTime > 45, paused: element.paused, seeking: element.seeking,
        error: element.error?.code || null,
      }))).toEqual({ timeAdvanced: true, paused: false, seeking: false, error: null });
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('uses an authenticated WsgiDAV share for backup, merge and ETag conflict recovery' + (certificate ? ' over HTTPS' : ''), async ({ page, browser, baseURL }) => {
  test.skip(!python, 'Requires GROOVEBOX_WEBDAV_TEST_PYTHON with WsgiDAV and Cheroot installed');
  expect(Boolean(certificate)).toBe(Boolean(privateKey));
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-share-'));
  const server = launchDav(root);
  let secondProfile;
  try {
    const address = await server.address;
    const backupURL = new URL('groovebox-playlists.json', address);
    const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    async function readBackup() {
      const response = await fetch(backupURL, { headers: { Authorization: authorization } });
      expect(response.status).toBe(200);
      const etag = response.headers.get('etag');
      expect(etag).toMatch(/^".+"$/);
      return { etag, data: await response.json() };
    }

    const firstSong = 'After Hours Velvet Atlas';
    const secondSong = 'Blue Static Nova Lane';
    const name = '跨设备 WebDAV 歌单';
    const otherName = '本地独立歌单';
    await page.goto('/');
    await createPlaylist(page, name);
    await addTrack(page, firstSong, name);
    await connectShare(page, address);
    await page.getByRole('button', { name: '云端歌单' }).press('Enter');
    await dialog(page).getByRole('button', { name: '上传歌单' }).press('Enter');
    await dialog(page).getByRole('button', { name: '确认' }).press('Enter');
    await expect(dialog(page).getByRole('status')).toHaveText('歌单已上传。');
    const initial = (await readBackup()).data;
    expect(initial.playlists).toEqual([expect.objectContaining({ name, tracks: ['demo-1'] })]);
    const [[originalId, originalDate]] = initial.playlistCreationDates;
    expect(originalId).toBe(initial.playlists[0].id);
    expect(originalDate).toEqual(expect.any(Number));

    secondProfile = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    const second = await secondProfile.newPage();
    await second.goto('/');
    await createPlaylist(second, otherName);
    await connectShare(second, address);
    await second.getByRole('button', { name: '云端歌单' }).press('Enter');
    await expect(playlist(second, name)).toHaveCount(0);
    await dialog(second).getByRole('button', { name: '下载并合并' }).press('Enter');
    await expect(dialog(second).getByRole('status')).toHaveText('云端歌单已合并。');
    await expect(playlist(second, name)).toBeVisible();
    await expect(playlist(second, otherName)).toBeVisible();
    const savedDates = target => target.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')).playlistCreationDates);
    expect(await savedDates(second)).toContainEqual([originalId, originalDate]);
    await dialog(second).getByRole('button', { name: '关闭', exact: true }).press('Enter');
    await second.getByRole('button', { name: '调整歌单顺序' }).press('Enter');
    await dialog(second).getByRole('combobox', { name: '歌单排序' }).selectOption('created-at');
    await expect(second.locator('#playlist-nav button')).toHaveText([name, otherName]);
    await dialog(second).getByRole('combobox', { name: '歌单排序' }).selectOption('manual');
    await dialog(second).getByRole('button', { name: '关闭', exact: true }).press('Enter');
    await second.getByRole('button', { name: '云端歌单' }).press('Enter');

    await enableAutoSync(page);
    await enableAutoSync(second);
    const synchronized = (await readBackup()).data;
    expect(synchronized.playlists.map(list => list.name)).toEqual(expect.arrayContaining([name, otherName]));
    const otherId = synchronized.playlists.find(list => list.name === otherName).id;
    const otherDate = new Map(synchronized.playlistCreationDates).get(otherId);
    expect(otherDate).toBeGreaterThan(originalDate);
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await expect.poll(() => savedDates(page)).toContainEqual([otherId, otherDate]);

    const putStatuses = [];
    const backupRoute = /\/api\/sources\/[^/]+\/backup$/;
    page.on('response', response => {
      if (backupRoute.test(response.url()) && response.request().method() === 'PUT') putStatuses.push(response.status());
    });
    let injected = false;
    await page.route(backupRoute, async route => {
      if (route.request().method() === 'PUT' && !injected) {
        injected = true;
        const { etag, data } = await readBackup();
        expect(route.request().headers()['if-match']).toBe(etag);
        data.favorites.push('demo-3');
        const external = await fetch(backupURL, {
          method: 'PUT',
          headers: { Authorization: authorization, 'Content-Type': 'application/json', 'If-Match': etag },
          body: JSON.stringify(data),
        });
        expect(external.status).toBe(204);
        await external.arrayBuffer();
      }
      await route.continue();
    });
    await addTrack(page, secondSong, name);
    await expect.poll(() => putStatuses.slice(0, 2)).toEqual([412, 200]);
    const reconciled = (await readBackup()).data;
    expect(reconciled.playlists.find(list => list.name === name).tracks).toEqual(['demo-1', 'demo-2']);
    expect(reconciled.favorites).toEqual(['demo-3']);

    await playlist(second, name).press('Enter');
    await expect(row(second, firstSong)).toBeVisible();
    await second.evaluate(() => dispatchEvent(new Event('online')));
    await expect(row(second, secondSong)).toBeVisible();
    await nav(second, 'favorites').press('Enter');
    await expect(row(second, 'Soft Signal Mira Kos')).toBeVisible();

    const playlistNames = target => target.locator('#playlist-nav button');
    await page.getByRole('button', { name: '调整歌单顺序' }).press('Enter');
    await dialog(page).getByRole('combobox', { name: '歌单排序' }).selectOption('manual');
    const beforeOrder = await playlistNames(page).allTextContents();
    expect(beforeOrder).toHaveLength(2);
    await dialog(page).getByRole('button', { name: '上移 ' + beforeOrder[1], exact: true }).press('Enter');
    await dialog(page).getByRole('button', { name: '关闭', exact: true }).press('Enter');
    const order = [...beforeOrder].reverse();
    await expect.poll(async () => (await readBackup()).data.playlists.map(list => list.name)).toEqual(order);
    await second.evaluate(() => dispatchEvent(new Event('online')));
    await expect(playlistNames(second)).toHaveText(order);
  } finally {
    await secondProfile?.close();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('restores updated song tags through actual WebDAV playlist sync in a second browser profile', async ({ page, browser, baseURL }) => {
  test.skip(!python, 'Requires GROOVEBOX_WEBDAV_TEST_PYTHON with WsgiDAV and Cheroot installed');
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-sync-tags-'));
  const server = launchDav(root);
  let other;
  try {
    const sample = new URL('../public/assets/demo-1.m4a', import.meta.url);
    const original = 'Original WebDAV Title';
    const changed = 'Tagged WebDAV Title';
    const artist = 'WebDAV Fixture Artist';
    const share = 'Metadata WebDAV';
    const name = '已同步的标签歌单';
    await writeFile(join(root, `${artist} - ${original}.m4a`), await updateBuffer(await readFile(sample), { title: changed, artist }));
    const address = await server.address;
    const openSync = async target => {
      await nav(target, 'sources').press('Enter');
      await target.locator('[data-action="open-cloud"]').filter({ hasText: share }).press('Enter');
      await target.getByRole('button', { name: '云端歌单', exact: true }).press('Enter');
    };
    const connectAndScan = async target => {
      await target.goto('/');
      await connectShare(target, address, share);
      await target.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
      await expect(target.getByRole('button', { name: '重新扫描目录', exact: true })).toBeVisible();
    };
    const storedTitle = async () => {
      const response = await fetch(new URL('groovebox-playlists.json', address), { headers: {
        Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
      } });
      if (response.ok) return (await response.json()).tracks[0]?.title;
      await response.body?.cancel();
    };

    await connectAndScan(page);
    await createPlaylist(page, name);
    await addTrack(page, `${original} ${artist}`, name);
    await openSync(page);
    await enableAutoSync(page);
    await expect.poll(storedTitle).toBe(original);

    other = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    const second = await other.newPage();
    await connectAndScan(second);
    await openSync(second);
    await enableAutoSync(second);
    await playlist(second, name).press('Enter');
    await row(second, `${original} ${artist}`).getByRole('button', { name: `${original} ${artist}`, exact: true }).press('Enter');
    const media = second.locator('#audio');
    await expect.poll(() => media.evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
    const originalSrc = await media.evaluate(audio => audio.currentSrc);

    await playlist(page, name).press('Enter');
    await row(page, `${original} ${artist}`).locator('[data-action="track-menu"]').press('Enter');
    await dialog(page).getByRole('button', { name: '读取音频标签', exact: true }).press('Enter');
    await expect(row(page, `${changed} ${artist}`)).toBeVisible();
    await expect.poll(storedTitle).toBe(changed);
    await second.evaluate(() => dispatchEvent(new Event('online')));
    await expect(row(second, `${changed} ${artist}`)).toBeVisible();
    await expect(second.locator('#player-title')).toHaveText(changed);
    expect(await media.evaluate(audio => ({ src: audio.currentSrc, paused: audio.paused }))).toEqual({ src: originalSrc, paused: false });
    await openSync(second);
    const pendingRead = Promise.withResolvers();
    const releaseRead = Promise.withResolvers();
    let reads = 0;
    await second.route(/\/api\/sources\/[^/]+\/backup$/, async route => {
      if (route.request().method() === 'GET' && ++reads === 1) {
        pendingRead.resolve();
        await releaseRead.promise;
      }
      await route.continue();
    });
    const syncNow = dialog(second).getByRole('button', { name: '立即同步', exact: true });
    try {
      await syncNow.press('Enter');
      await pendingRead.promise;
      await syncNow.press('Enter');
      // Let the second zero-delay scheduling request run while the first read is deliberately held.
      await second.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    } finally {
      releaseRead.resolve();
    }
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    await expect(dialog(second).getByRole('status')).toHaveText('已同步歌单和收藏。');
    await expect.poll(storedTitle).toBe(changed);
  } finally {
    await other?.close();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('hides one of two real WebDAV libraries and restores its scan without fetching either share again', async ({ page }) => {
  test.skip(!python, 'Requires GROOVEBOX_WEBDAV_TEST_PYTHON with WsgiDAV and Cheroot installed');
  expect(Boolean(certificate)).toBe(Boolean(privateKey));
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-visibility-'));
  const folders = ['Shared Visibility Hidden Folder', 'Shared Visibility Visible Folder'];
  const titles = ['Shared Visibility Hidden Track', 'Shared Visibility Visible Track'];
  const artists = ['Hidden Fixture Artist', 'Visible Fixture Artist'];
  const names = ['Hidden WebDAV Library', 'Visible WebDAV Library'];
  const shares = [];
  try {
    for (const [index, folder] of folders.entries()) {
      const shareRoot = join(root, String(index));
      const music = join(shareRoot, folder);
      await mkdir(music, { recursive: true });
      await copyFile(new URL('../public/assets/demo-1.m4a', import.meta.url), join(music, `${artists[index]} - ${titles[index]}.m4a`));
      shares.push(launchDav(shareRoot));
    }
    const addresses = await Promise.all(shares.map(share => share.address));
    const connections = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sources') connections.push(request.url());
    });
    await page.goto('/');
    for (const [index, address] of addresses.entries()) {
      await connectShare(page, address, names[index]);
      await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
      await expect(page.getByRole('button', { name: '重新扫描目录', exact: true })).toBeVisible();
      await expect(page.locator('#toast')).toContainText('扫描完成，共找到 1 首歌曲');
    }

    const songs = titles.map((title, index) => row(page, `${title} ${artists[index]}`));
    const search = page.getByRole('searchbox', { name: '搜索', exact: true });
    const indexedFolders = folders.map(folder => page.locator('#content [data-action="open-indexed-folder"]').filter({ hasText: folder }));
    const artworkGroups = values => values.map(value => page.locator('#content [data-action="group"]').filter({ hasText: value }));
    const toggles = names.map(name => page.getByRole('article', { name, exact: true }));
    const sourceIds = async () => {
      const response = await page.request.get('/api/sources');
      expect(response.status()).toBe(200);
      return (await response.json()).sources.map(source => source.id).sort();
    };
    const recordedSources = await sourceIds();
    expect(recordedSources).toHaveLength(2);
    await nav(page, 'songs').press('Enter');
    await expect(songs[0]).toBeVisible();
    await expect(songs[1]).toBeVisible();
    await songs[0].locator('[data-action="track-menu"]').press('Enter');
    await dialog(page).getByRole('button', { name: '离线保存', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toHaveText('音频已保存到离线歌曲。');

    await search.fill('Shared Visibility');
    for (const result of [...songs, ...indexedFolders]) await expect(result).toBeVisible();
    const portraits = recordedSources.map(id => page.waitForResponse(response => response.ok() &&
      new URL(response.url()).pathname === '/api/sources/' + id + '/artist-portraits'));
    await nav(page, 'artists').press('Enter');
    for (const group of artworkGroups(artists)) await expect(group).toBeVisible();
    await Promise.all(portraits);
    await nav(page, 'albums').press('Enter');
    for (const group of artworkGroups(names)) await expect(group).toBeVisible();
    for (const share of shares) expect(share.propfind).toBeGreaterThanOrEqual(3);
    const baseline = shares.map(share => share.propfind);

    await nav(page, 'sources').press('Enter');
    await toggles[0].getByRole('button', { name: '从曲库隐藏', exact: true }).press('Enter');
    await expect(toggles[0].getByRole('button', { name: '在曲库显示', exact: true })).toBeVisible();
    await expect(toggles[1].getByRole('button', { name: '从曲库隐藏', exact: true })).toBeVisible();
    await page.reload();
    await expect(toggles[0].getByRole('button', { name: '在曲库显示', exact: true })).toBeVisible();
    await nav(page, 'songs').press('Enter');
    await expect(songs[0]).toHaveCount(0);
    await expect(songs[1]).toBeVisible();
    await search.fill('Shared Visibility');
    await expect(songs[0]).toHaveCount(0);
    await expect(indexedFolders[0]).toHaveCount(0);
    await expect(songs[1]).toBeVisible();
    await expect(indexedFolders[1]).toBeVisible();
    await nav(page, 'artists').press('Enter');
    await expect(artworkGroups(artists)[0]).toHaveCount(0);
    await expect(artworkGroups(artists)[1]).toBeVisible();
    await nav(page, 'albums').press('Enter');
    await expect(artworkGroups(names)[0]).toHaveCount(0);
    await expect(artworkGroups(names)[1]).toBeVisible();

    await nav(page, 'offline').press('Enter');
    await expect(songs[0]).toBeVisible();
    await songs[0].locator('.track-main').press('Enter');
    await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentSrc.startsWith('blob:') && audio.currentTime > 0.1)).toBe(true);

    await nav(page, 'sources').press('Enter');
    await toggles[0].getByRole('button', { name: '在曲库显示', exact: true }).press('Enter');
    await expect(toggles[0].getByRole('button', { name: '从曲库隐藏', exact: true })).toBeVisible();
    await search.fill('Shared Visibility');
    for (const result of [...songs, ...indexedFolders]) await expect(result).toBeVisible();
    await nav(page, 'artists').press('Enter');
    for (const group of artworkGroups(artists)) await expect(group).toBeVisible();
    await nav(page, 'albums').press('Enter');
    for (const group of artworkGroups(names)) await expect(group).toBeVisible();
    expect(await sourceIds()).toEqual(recordedSources);
    expect(connections).toHaveLength(2);
    expect(shares.map(share => share.propfind)).toEqual(baseline);

    await test.step('One-click refresh respects visibility and reconciles changed tracks in both indexed shares', async () => {
      const newTitles = ['New Hidden Fixture Track', 'Renamed Visible Fixture Track'];
      const file = (index, title) => join(root, String(index), folders[index], `${artists[index]} - ${title}.m4a`);
      await copyFile(file(0, titles[0]), file(0, newTitles[0]));
      await rename(file(1, titles[1]), file(1, newTitles[1]));
      await nav(page, 'sources').press('Enter');
      await toggles[0].getByRole('button', { name: '从曲库隐藏', exact: true }).press('Enter');
      await nav(page, 'songs').press('Enter');
      const refresh = page.getByRole('button', { name: '刷新曲库', exact: true });
      await refresh.press('Enter');
      await expect(page.locator('#toast')).toHaveText('曲库已刷新（1 个来源）。');
      const additions = newTitles.map((title, index) => row(page, `${title} ${artists[index]}`));
      await expect(additions[1]).toBeVisible();
      await expect(songs[1]).toHaveCount(0);
      expect(shares[0].propfind).toBe(baseline[0]);
      const visibleReads = shares[1].propfind;
      expect(visibleReads).toBeGreaterThan(baseline[1]);

      await nav(page, 'sources').press('Enter');
      await toggles[0].getByRole('button', { name: '在曲库显示', exact: true }).press('Enter');
      await nav(page, 'songs').press('Enter');
      await expect(additions[0]).toHaveCount(0);
      await refresh.press('Enter');
      await expect(page.locator('#toast')).toHaveText('曲库已刷新（2 个来源）。');
      for (const added of additions) await expect(added).toBeVisible();
      expect(shares[0].propfind).toBeGreaterThan(baseline[0]);
      expect(shares[1].propfind).toBeGreaterThan(visibleReads);
      expect(await sourceIds()).toEqual(recordedSources);
      expect(connections).toHaveLength(2);
    });
  } finally {
    await Promise.all(shares.map(share => share.stop()));
    await rm(root, { recursive: true, force: true });
  }
});

test('imports a playlist for indexed HTTPS WebDAV audio and plays the original via the source', async ({ page }) => {
  test.skip(!python, 'Requires GROOVEBOX_WEBDAV_TEST_PYTHON with WsgiDAV and Cheroot installed');
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-m3u-'));
  const server = launchDav(root);
  try {
    const file = '演奏者 - 钢琴片段.m4a';
    const other = '演奏者 - 前奏.m4a';
    const sample = new URL('../public/assets/demo-1.m4a', import.meta.url);
    await Promise.all([file, other].map(name => copyFile(sample, join(root, name))));
    const address = await server.address;
    await page.goto('/');
    await connectShare(page, address);
    await page.getByRole('button', { name: '扫描并加入曲库' }).press('Enter');
    await expect(page.getByRole('status').filter({ hasText: '扫描完成' })).toBeVisible();
    const priorReads = server.propfind;
    const content = page.locator('#content');
    const title = '现有云端歌单';
    const entries = [
      '#EXTM3U', '#PLAYLIST:' + title,
      new URL(encodeURIComponent(other), address).href,
      new URL(encodeURIComponent(file), address).href,
      new URL(encodeURIComponent(file), 'https://unknown.fixture.invalid/').href,
    ];
    const external = [];
    await page.route('https://unknown.fixture.invalid/**', route => {
      external.push(route.request().url());
      return route.abort();
    });
    await page.locator('#import-m3u-file').setInputFiles({
      name: 'cloud.m3u8', mimeType: 'audio/x-mpegurl', buffer: Buffer.from(entries.join('\n')),
    });
    await expect(content.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(content.locator('.track-name')).toHaveText(['前奏', '钢琴片段']);
    await expect(page.getByRole('status').filter({ hasText: '已导入 2 首歌曲，跳过 1 项。' })).toBeVisible();
    expect(server.propfind).toBe(priorReads);
    expect(external).toEqual([]);
    await page.reload();
    await expect(content.locator('.track-name')).toHaveText(['前奏', '钢琴片段']);
    await content.getByRole('button', { name: '钢琴片段 演奏者' }).press('Enter');
    await expect.poll(() => page.locator('#audio').evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
    expect(await page.locator('#audio').evaluate(element => new URL(element.currentSrc).pathname)).toMatch(/^\/api\/sources\//);
    expect(server.propfind).toBe(priorReads);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('resumes independent playback positions in two actual WebDAV folders after a reload', async ({ page }) => {
  test.skip(!python, 'Requires GROOVEBOX_WEBDAV_TEST_PYTHON with WsgiDAV and Cheroot installed');
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-folder-resume-'));
  const server = launchDav(root);
  try {
    const folders = [['First Book', 'First Chapter', 37], ['Other Book', 'Other Chapter', 11]];
    for (const [folder, title] of folders) {
      await mkdir(join(root, folder));
      await copyFile(new URL('../public/assets/demo-1.m4a', import.meta.url), join(root, folder, title + '.m4a'));
    }
    const player = page.locator('#audio');
    const currentTime = () => player.evaluate(audio => audio.currentTime);
    const title = page.locator('#player-title');
    const resume = page.getByRole('button', { name: '继续播放目录', exact: true });
    const openFolder = name => page.locator('#content').getByRole('button', { name, exact: true }).press('Enter');

    await page.goto('/');
    await connectShare(page, await server.address, 'Resume WebDAV');
    for (const [folder, chapter, seconds] of folders) {
      await openFolder(folder);
      await expect(resume).toBeDisabled();
      await page.getByRole('button', { name: '播放此目录', exact: true }).press('Enter');
      await expect(title).toHaveText(chapter);
      await expect.poll(currentTime).toBeGreaterThan(0);
      await player.evaluate((audio, time) => { audio.currentTime = time; }, seconds);
      await expect.poll(currentTime).toBeGreaterThanOrEqual(seconds);
      await expect.poll(() => player.evaluate(audio => audio.seeking)).toBe(false);
      await page.getByRole('button', { name: '根目录', exact: true }).press('Enter');
    }

    await page.reload();
    for (const [folder, chapter, seconds] of folders) {
      await openFolder(folder);
      await resume.press('Enter');
      await expect(title).toHaveText(chapter);
      await expect.poll(currentTime).toBeGreaterThanOrEqual(seconds);
      expect(await currentTime()).toBeLessThan(seconds + 3);
      await expect.poll(() => player.evaluate(audio => audio.paused)).toBe(false);
      await page.getByRole('button', { name: '根目录', exact: true }).press('Enter');
    }
    for (const [folder, chapter] of folders) {
      expect(server.requests.some(([path]) => path === `/${folder}/${chapter}.m4a`)).toBe(true);
    }
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves repeated playlist occurrences and their exact date across HTTPS WebDAV profiles', async ({ page, browser, baseURL }) => {
  test.skip(!python || !certificate || !privateKey, 'Requires the authenticated HTTPS WsgiDAV fixture');
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-repeat-dates-'));
  const server = launchDav(root);
  const backupPath = join(root, 'groovebox-playlists.json');
  const key = 'groovebox.state.v1';
  const original = { id: 'webdav-repeat', name: 'Repeated recordings', tracks: ['demo-1', 'demo-2', 'demo-1'] };
  const legacy = { id: 'webdav-legacy', name: 'Undated recording', tracks: ['demo-2'] };
  const before = Date.UTC(2025, 3, 2);
  const after = Date.UTC(2025, 3, 3);
  let remote;
  try {
    await page.addInitScript(({ key, original, legacy, before }) => {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, JSON.stringify({ playlists: [original, legacy],
        playlistModificationDates: [[original.id, before]] }));
    }, { key, original, legacy, before });
    await page.goto('/');
    const address = await server.address;
    const share = 'HTTPS repeated playlist fixture';
    const openSync = target => target.getByRole('button', { name: '云端歌单', exact: true }).press('Enter');
    const saved = target => target.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    await connectShare(page, address, share);
    await openSync(page);
    await enableAutoSync(page);
    const backup = JSON.parse(await readFile(backupPath, 'utf8'));
    expect(backup.playlists).toEqual([original, legacy]);
    expect(backup.playlistModificationDates).toEqual([[original.id, before]]);

    remote = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    const other = await remote.newPage();
    await other.addInitScript(({ key, original }) => {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, JSON.stringify({ playlists: [{ ...original, tracks: original.tracks.slice(0, 2) }] }));
    }, { key, original });
    await other.goto('/');
    await connectShare(other, address, share);
    await openSync(other);
    await dialog(other).getByRole('button', { name: '下载并合并', exact: true }).press('Enter');
    await expect(dialog(other).getByRole('status')).toHaveText('云端歌单已合并。');
    expect((await saved(other)).playlists).toEqual([original, legacy]);
    expect((await saved(other)).playlistModificationDates).toEqual([[original.id, before]]);
    await enableAutoSync(other);
    await playlist(other, original.name).press('Enter');
    await expect(other.locator('#content .track-main')).toHaveCount(3);
    await other.clock.setFixedTime(after);
    await other.getByRole('button', { name: '重命名', exact: true }).press('Enter');
    await dialog(other).getByRole('textbox').fill('Renamed repeated recordings');
    await dialog(other).getByRole('button', { name: '保存', exact: true }).press('Enter');
    await expect.poll(async () => JSON.parse(await readFile(backupPath, 'utf8')).playlistModificationDates).toEqual([[original.id, after]]);
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await expect(playlist(page, 'Renamed repeated recordings')).toBeVisible();
    expect((await saved(page)).playlistModificationDates).toEqual([[original.id, after]]);
    expect((await saved(page)).playlists).toEqual([{ ...original, name: 'Renamed repeated recordings' }, legacy]);

    // Change the occurrence counts while leaving the set of recordings and track total unchanged.
    const backupURL = new URL('groovebox-playlists.json', address);
    const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    const file = await fetch(backupURL, { headers: { Authorization: authorization } });
    expect(file.status).toBe(200);
    const modified = await file.json();
    const latest = Date.UTC(2025, 3, 4);
    modified.playlists[0].tracks = ['demo-1', 'demo-2', 'demo-2'];
    modified.playlistModificationDates = [[original.id, latest]];
    const write = await fetch(backupURL, { method: 'PUT', headers: {
      Authorization: authorization, 'Content-Type': 'application/json', 'If-Match': file.headers.get('etag'),
    }, body: JSON.stringify(modified) });
    expect(write.status).toBe(204);
    await write.arrayBuffer();
    for (const target of [page, other]) {
      await target.evaluate(() => dispatchEvent(new Event('online')));
      await expect.poll(async () => (await saved(target)).playlistModificationDates).toEqual([[original.id, latest]]);
      expect((await saved(target)).playlists).toEqual(modified.playlists);
    }
  } finally {
    await remote?.close();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ['manual', 'automatic']) test('keeps a newer same-origin tab edit during an in-flight HTTPS WebDAV ' + mode + ' playlist read', async ({ page }) => {
  test.skip(!python || !certificate || !privateKey, 'Requires the authenticated HTTPS WsgiDAV fixture');
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-stale-playlist-tab-'));
  const server = launchDav(root);
  const key = 'groovebox.state.v1';
  const initial = 'Concurrent playlist fixture';
  const changed = 'Rename saved in the second tab';
  const originDate = Date.UTC(2025, 5, 1);
  const changedDate = Date.UTC(2025, 5, 2);
  const endpoint = /\/api\/sources\/[^/]+\/backup$/;
  let heldRead;
  let editor;
  try {
    const address = await server.address;
    const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    const backup = async () => JSON.parse(await readFile(join(root, 'groovebox-playlists.json'), 'utf8'));
    await page.clock.setFixedTime(originDate);
    await page.goto('/');
    await createPlaylist(page, initial);
    await connectShare(page, address, 'Stale tab HTTPS WebDAV');
    const openSync = () => page.getByRole('button', { name: '云端歌单', exact: true }).press('Enter');
    await openSync();
    if (mode === 'automatic') await enableAutoSync(page);
    else {
      await dialog(page).getByRole('button', { name: '上传歌单', exact: true }).press('Enter');
      await dialog(page).getByRole('button', { name: '确认', exact: true }).press('Enter');
      await expect(dialog(page).getByRole('status')).toHaveText('歌单已上传。');
      await dialog(page).getByRole('button', { name: '关闭', exact: true }).press('Enter');
    }
    const original = (await backup()).playlists[0];
    expect(original.name).toBe(initial);
    expect((await backup()).playlistModificationDates).toEqual([[original.id, originDate]]);

    editor = await page.context().newPage();
    await editor.route(endpoint, route => route.abort());
    await editor.clock.setFixedTime(changedDate);
    await editor.goto('/');
    await playlist(editor, initial).press('Enter');

    await page.route(endpoint, async route => {
      if (route.request().method() === 'GET' && heldRead) {
        const read = heldRead;
        read.waiting.resolve();
        await read.release.promise;
      }
      await route.continue();
    });
    await openSync();
    const status = dialog(page).getByRole('status');
    const busy = mode === 'automatic' ? '正在同步歌单…' : '正在下载…';
    const start = async () => {
      heldRead = { waiting: Promise.withResolvers(), release: Promise.withResolvers() };
      await dialog(page).getByRole('button', { name: mode === 'automatic' ? '立即同步' : '下载并合并', exact: true }).press('Enter');
      await heldRead.waiting.promise;
      await expect(status).toHaveText(busy);
    };

    await start();
    await nav(editor, 'settings').press('Enter');
    const coverEngine = editor.locator('#online-cover');
    const initialCoverEngine = await coverEngine.isChecked();
    await coverEngine.press('Space');
    expect((await stored()).settings.onlineCover).toBe(!initialCoverEngine);
    heldRead.release.resolve();
    await expect(status).toHaveText(mode === 'automatic' ? '已同步歌单和收藏。' : '云端歌单已合并。');
    expect((await stored()).playlistModificationDates).toEqual([[original.id, originDate]]);

    await start();
    await playlist(editor, initial).press('Enter');
    await editor.getByRole('button', { name: '重命名', exact: true }).press('Enter');
    await dialog(editor).getByRole('textbox').fill(changed);
    await dialog(editor).getByRole('button', { name: '保存', exact: true }).press('Enter');
    const newer = await stored();
    expect(newer.playlists).toEqual([{ ...original, name: changed }]);
    expect(newer.playlistModificationDates).toEqual([[original.id, changedDate]]);

    heldRead.release.resolve();
    await expect(status).not.toHaveText(busy);
    const durable = await stored();
    expect(durable.playlists).toEqual(newer.playlists);
    expect(durable.playlistModificationDates).toEqual(newer.playlistModificationDates);
    await expect(status).toContainText('刷新页面');
    expect((await backup()).playlists).toEqual([original]);
  } finally {
    heldRead?.release.resolve();
    await editor?.close();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('sorts indexed HTTPS WebDAV songs by actual file time and release year and preserves the dates in backups', async ({ page, browser, baseURL }) => {
  test.skip(!python || !certificate || !privateKey, 'Requires the trusted HTTPS WsgiDAV fixture');
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-wsgidav-track-dates-'));
  const server = launchDav(root);
  const source = 'HTTPS music dates fixture';
  const list = '曲目日期验证歌单';
  const artist = 'Fixture Date Artist';
  const album = 'Fixture Date Album';
  const a = { title: 'Alpha New Release', file: 'alpha.m4a', releaseYear: 2024, modified: Date.UTC(1960, 0, 2) };
  const b = { title: 'Beta Unknown Release', file: 'beta.m4a', modified: Date.UTC(2020, 3, 4) };
  const c = { title: 'Zulu Older Release', file: 'zulu.m4a', releaseYear: 1999, modified: 0 };
  const precise = Date.UTC(2030, 5, 6);
  const stateKey = 'groovebox.state.v1';
  let other;
  try {
    const demo = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    const audio = new Map();
    for (const { title, file, releaseYear, modified } of [a, b, c]) {
      const bytes = Buffer.from(await updateBuffer(demo, { title, artist, album, ...(releaseYear ? { year: releaseYear } : {}) }));
      audio.set(title, bytes);
      const path = join(root, file);
      await writeFile(path, bytes);
      await utimes(path, new Date(modified), new Date(modified));
      expect((await stat(path)).mtimeMs).toBe(modified);
    }
    await page.addInitScript(key => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
        settings: { demos: false, onlineCover: false, artistImageEngine: false },
      }));
    }, stateKey);
    await page.goto('/');
    const address = await server.address;
    await connectShare(page, address, source);
    const { sources } = await (await page.request.get('/api/sources')).json();
    const id = sources.find(item => item.name === source).id;
    const sourceList = '/api/sources/' + id + '/list?path=%2F';
    const management = /\/api\/sources\/[^/]+\/list\?/;
    const indexed = target => target.evaluate(key => JSON.parse(localStorage.getItem(key)).tracks, stateKey);
    const dates = tracks => Object.fromEntries(tracks.map(track => [track.title, track.modified]));
    const titles = target => target.locator('#content tbody .track-name');
    const sort = target => target.locator('#content #sort');
    const heading = (target, name) => target.locator('#content').getByRole('heading', { name, exact: true });
    const openSongs = async target => {
      await nav(target, 'songs').click();
      await expect(heading(target, '全部歌曲')).toBeVisible();
    };
    const openPlaylist = async target => {
      await playlist(target, list).click();
      await expect(heading(target, list)).toBeVisible();
    };
    const openSource = async target => {
      await nav(target, 'sources').click();
      await target.locator('#content [data-action=open-cloud]').filter({ hasText: source }).click();
      await expect(target.getByRole('heading', { name: source, exact: true })).toBeVisible();
    };
    const rescan = async () => {
      await page.getByRole('button', { name: '重新扫描目录', exact: true }).click();
      await expect(page.locator('#toast')).toContainText('扫描完成，共找到 3 首歌曲');
      await expect(page.getByRole('button', { name: '重新扫描目录', exact: true })).toBeEnabled();
    };
    const tracks = await page.request.get(sourceList);
    expect(tracks.status()).toBe(200);
    const wire = await tracks.json();
    expect(Object.fromEntries(wire.items.map(track => [track.name, track.modified])))
      .toEqual({ [a.file]: a.modified, [b.file]: b.modified, [c.file]: c.modified });
    await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 3 首歌曲');
    await openSongs(page);
    await page.locator('#content [data-action=read-tags-bulk]').click();
    await expect(page.locator('#toast')).toContainText('标签读取完成。已更新 3 首');
    await expect(titles(page)).toHaveCount(3);
    expect(dates(await indexed(page))).toEqual({ [a.title]: a.modified, [b.title]: b.modified, [c.title]: c.modified });
    const tags = Object.fromEntries((await indexed(page)).map(track => [track.title, track.releaseYear ?? 0]));
    expect(tags).toEqual({ [a.title]: 2024, [b.title]: 0, [c.title]: 1999 });

    const order = async (target, value, tracks) => {
      await sort(target).selectOption(value);
      await expect(sort(target)).toHaveValue(value);
      await expect(titles(target)).toHaveText(tracks.map(track => track.title));
    };
    await order(page, 'release-year', [b, c, a]);
    for (const value of ['added-at', 'modified-at']) await order(page, value, [a, c, b]);
    for (const value of ['added-at-desc', 'modified-at-desc']) await order(page, value, [b, c, a]);

    await createPlaylist(page, list);
    for (const item of [a, b, c]) await addTrack(page, item.title + ' ' + artist, list);
    await openPlaylist(page);
    await order(page, 'release-year', [b, c, a]);
    const playAll = page.getByRole('button', { name: '全部播放', exact: true });
    await playAll.click();
    await expect(sort(page)).toHaveValue('release-year');
    await expect(page.locator('#now .queue-row .track-name')).toHaveText([b.title, c.title, a.title]);
    await expect(page.locator('#player-title')).toHaveText(b.title);
    const player = page.locator('#audio');
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
    const sourceUrl = await player.evaluate(element => element.currentSrc);
    const raw = await page.request.get(sourceUrl, { headers: { Range: 'bytes=0-255' } });
    expect(raw.status()).toBe(206);
    expect(await raw.body()).toEqual(audio.get(b.title).subarray(0, 256));
    const full = await page.request.get(sourceUrl);
    expect(full.status()).toBe(200);
    expect(createHash('sha256').update(await full.body()).digest('hex'))
      .toBe(createHash('sha256').update(audio.get(b.title)).digest('hex'));
    await order(page, 'default', [a, b, c]);
    await playAll.click();
    await expect(page.locator('#now .queue-row .track-name')).toHaveText([a.title, b.title, c.title]);

    await utimes(join(root, a.file), new Date(precise), new Date(precise));
    await openSource(page);
    await rescan();
    expect(dates(await indexed(page))).toEqual({ [a.title]: precise, [b.title]: b.modified, [c.title]: c.modified });
    for (const value of ['added-at', 'modified-at']) await order(page, value, [c, b, a]);
    for (const value of ['added-at-desc', 'modified-at-desc']) await order(page, value, [a, b, c]);

    // Keep the real share and audio. Exercise a source DTO that omits a formerly supplied timestamp.
    const strip = async intercepted => {
      const upstream = await intercepted.fetch();
      const payload = await upstream.json();
      for (const item of payload.items) if (item.name === b.file) delete item.modified;
      await intercepted.fulfill({ response: upstream, json: payload });
    };
    await page.route(management, strip);
    await rescan();
    await page.unroute(management, strip);
    expect(dates(await indexed(page))).toEqual({ [a.title]: precise, [b.title]: undefined, [c.title]: c.modified });
    await openSongs(page);
    await sort(page).selectOption('default');
    await expect(sort(page)).toHaveValue('default');
    const byTitle = new Map([[b.title, b], [c.title, c]]);
    const epochTies = (await titles(page).allTextContents()).filter(title => byTitle.has(title)).map(title => byTitle.get(title));
    expect(epochTies).toHaveLength(2);
    for (const value of ['added-at', 'modified-at']) await order(page, value, [...epochTies, a]);
    for (const value of ['added-at-desc', 'modified-at-desc']) await order(page, value, [a, ...epochTies]);
    await order(page, 'release-year', [b, c, a]);
    await order(page, 'modified-at-desc', [a, ...epochTies]);
    await page.reload();
    await expect(sort(page)).toHaveValue('modified-at-desc');
    const finalTitles = [a, ...epochTies].map(track => track.title);
    await expect(titles(page)).toHaveText(finalTitles);

    await openSource(page);
    await page.getByRole('button', { name: '云端歌单', exact: true }).click();
    await dialog(page).getByRole('button', { name: '上传歌单', exact: true }).click();
    await dialog(page).getByRole('button', { name: '确认', exact: true }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('歌单已上传。');
    const wireBackup = JSON.parse(await readFile(join(root, 'groovebox-playlists.json'), 'utf8'));
    expect(dates(wireBackup.tracks)).toEqual({ [a.title]: precise, [b.title]: undefined, [c.title]: c.modified });
    expect(wireBackup.tracks.find(track => track.title === b.title)).not.toHaveProperty('modified');

    other = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    const second = await other.newPage();
    await second.goto('/');
    await connectShare(second, address, source);
    await second.getByRole('button', { name: '云端歌单', exact: true }).click();
    await dialog(second).getByRole('button', { name: '下载并合并', exact: true }).click();
    await expect(dialog(second).getByRole('status')).toHaveText('云端歌单已合并。');
    expect(dates(await indexed(second))).toEqual({ [a.title]: precise, [b.title]: undefined, [c.title]: c.modified });
    await dialog(second).getByRole('button', { name: '关闭', exact: true }).click();
    await openPlaylist(second);
    await expect(titles(second)).toHaveText([a.title, b.title, c.title]);
    await order(second, 'modified-at-desc', [a, b, c]);

    await dialog(page).getByRole('button', { name: '关闭', exact: true }).click();
    await nav(page, 'settings').click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出备份', exact: true }).click();
    const exported = await (await download).path();
    await nav(second, 'settings').click();
    await second.locator('#restore-file').setInputFiles(exported);
    await expect(second.locator('#toast')).toHaveText('备份已恢复。');
    await openSongs(second);
    await expect(sort(second)).toHaveValue('modified-at-desc');
    await expect(titles(second)).toHaveText(finalTitles);

    await nav(second, 'settings').click();
    await second.locator('#interface-language').selectOption('en');
    await expect(second.locator('html')).toHaveAttribute('lang', 'en');
    await nav(second, 'songs').click();
    await expect(heading(second, 'All Tracks')).toBeVisible();
    await expect(sort(second)).toHaveValue('modified-at-desc');
    await expect(titles(second)).toHaveText(finalTitles);
    for (const [value, label] of [
      ['release-year', 'Year (Oldest First)'], ['added-at', 'Date added(Asc)'], ['added-at-desc', 'Date added(Desc)'],
      ['modified-at', 'Date modified(Asc)'], ['modified-at-desc', 'Date modified(Desc)'],
    ]) await expect(sort(second).locator('option[value="' + value + '"]')).toHaveText(label);
  } finally {
    await other?.close();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
