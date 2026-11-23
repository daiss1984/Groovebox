import { expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseBuffer } from 'music-metadata';

const navidromeBin = process.env.NAVIDROME_TEST_BIN;
const ffmpegBin = process.env.FFMPEG_TEST_BIN;
const exec = promisify(execFile);
const artist = 'Groovebox Fixture Artist';
const guestArtist = 'Groovebox Fixture Guest';
const artistCredit = artist + ' feat. ' + guestArtist;
const album = 'Groovebox Fixture Album';
const title = 'Groovebox Fixture Recording';
const releaseYear = 2006;

async function availableLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

test('plays, reads synced lyrics, and reports completed playback to a real Navidrome server only when enabled', async ({ page }) => {
  test.skip(!navidromeBin || !ffmpegBin, 'Provide NAVIDROME_TEST_BIN and FFMPEG_TEST_BIN to run the live fixture.');
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-navidrome-fixture-'));
  const music = join(root, 'music');
  const fixturePath = join(music, 'Recording.flac');
  const password = randomBytes(24).toString('hex');
  let navidrome;
  try {
    await mkdir(music);
    await exec(ffmpegBin, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-metadata', 'artist=' + artistCredit, '-metadata', 'album_artist=' + artist,
      '-metadata', 'album=' + album, '-metadata', 'title=' + title, '-metadata', 'genre=Jazz;Rock',
      '-metadata', 'date=' + releaseYear + '-04-17',
      '-c:a', 'flac', fixturePath,
    ], { timeout: 10_000 });
    await exec(ffmpegBin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x128:d=1', '-frames:v', '1',
      join(music, 'cover.jpg')], { timeout: 10_000 });
    await writeFile(join(music, 'Recording.lrc'), '[00:00.00]Fixture introduction\n[00:03.00]Fixture chorus\n');
    const port = await availableLoopbackPort();
    const upstreamOrigin = 'http://127.0.0.1:' + port;
    navidrome = spawn(resolve(navidromeBin), [], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        ND_ADDRESS: '127.0.0.1',
        ND_PORT: String(port),
        ND_MUSICFOLDER: music,
        ND_DATAFOLDER: join(root, 'db'),
        ND_FFMPEGPATH: resolve(ffmpegBin),
        ND_DEVAUTOCREATEADMINPASSWORD: password,
        ND_ENABLEINSIGHTSCOLLECTOR: 'false',
        ND_ENABLEEXTERNALSERVICES: 'false',
        ND_LOGLEVEL: 'error',
      },
      stdio: 'ignore',
    });
    let startupError;
    navidrome.once('error', error => { startupError = error.code; });
    const salt = randomBytes(16).toString('hex');
    const token = createHash('md5').update(password + salt).digest('hex');
    async function upstream(method, values) {
      const params = new URLSearchParams({ u: 'admin', s: salt, t: token, v: '1.16.1', c: 'GrooveboxTest', f: 'json', ...values });
      const response = await fetch(upstreamOrigin + '/rest/' + method + '.view?' + params, { signal: AbortSignal.timeout(1500) });
      return (await response.json())['subsonic-response'];
    }
    let upstreamTrackId;
    await expect.poll(async () => {
      if (startupError || navidrome.exitCode !== null) return 'Navidrome exited before indexing the fixture';
      try {
        const result = await upstream('search3', { query: title, artistCount: '0', albumCount: '0', songCount: '1' });
        upstreamTrackId = result?.searchResult3?.song?.find(song => song.title === title)?.id;
        return Boolean(upstreamTrackId);
      } catch {
        return false;
      }
    }, { timeout: 14_000, message: 'Navidrome should start and index the isolated test track' }).toBe(true);
    async function playCount() {
      const result = await upstream('getSong', { id: upstreamTrackId });
      expect(result?.song?.title).toBe(title);
      expect(result.song.year).toBe(releaseYear);
      return result.song.playCount ?? 0;
    }

    await page.goto('/#sources');
    const reports = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/sources\/[^/]+\/played$/.test(new URL(request.url()).pathname)) reports.push(request.url());
    });
    expect(await playCount()).toBe(0);
    const upstreamArtistFields = (await upstream('getSong', { id: upstreamTrackId })).song;
    expect(upstreamArtistFields.displayArtist).toBe(artistCredit);
    expect(upstreamArtistFields.artists.map(person => person.name)).toEqual([artist, guestArtist]);
    await page.getByRole('button', { name: /添加媒体服务器/ }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('协议').selectOption('navidrome');
    await dialog.getByLabel('名称').fill('Navidrome fixture');
    await dialog.getByLabel('服务地址').fill(upstreamOrigin);
    await dialog.getByLabel('用户名').fill('admin');
    await dialog.getByLabel('密码').fill(password);
    const connected = page.waitForResponse(response =>
      response.url().endsWith('/api/sources') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '连接', exact: true }).press('Enter');
    expect((await connected).status()).toBe(201);
    await page.locator('#sidebar [data-nav="albums"]').press('Enter');
    await expect(page.locator('#content').getByText(album, { exact: true })).toHaveCount(0);
    await page.locator('#sidebar [data-nav="home"]').press('Enter');
    const recommendation = page.locator('section[aria-labelledby="direct-recommendations-heading"] button.card')
      .filter({ has: page.getByText(album, { exact: true }) });
    await expect(recommendation).toBeVisible();
    await expect(recommendation.locator('img')).toHaveAttribute('src', /^\/api\/sources\/[^/]+\/cover\?id=/);
    await expect.poll(() => recommendation.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    const albumPath = (await recommendation.getAttribute('data-id')).split(':')[1];
    expect(albumPath).toMatch(/^[\w-]+$/);
    const [trackListing] = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url());
        return /^\/api\/sources\/[^/]+\/list$/.test(url.pathname) && url.searchParams.get('path') === albumPath;
      }),
      recommendation.press('Enter'),
    ]);
    expect(trackListing.status()).toBe(200);
    expect((await trackListing.json()).items.find(item => item.title === title)).toMatchObject({
      releaseYear, artist: artistCredit, artistNames: [artist, guestArtist], genres: ['Jazz', 'Rock'],
    });
    const track = page.locator('#content').getByRole('button', { name: new RegExp(title) });
    const audio = page.locator('#audio');
    await audio.evaluate(element => {
      let count = 0;
      element.addEventListener('ended', () => { element.dataset.fixtureEnded = String(++count); });
    });
    const streamPromise = page.waitForResponse(response =>
      /\/api\/sources\/[^/]+\/stream\?id=[\w-]+$/.test(response.url()) && !response.url().endsWith('-lyrics'));
    const lyricsPromise = page.waitForResponse(response => /\/api\/sources\/[^/]+\/stream\?id=[\w-]+-lyrics$/.test(response.url()));
    await track.press('Enter');
    const stream = await streamPromise;
    expect(stream.ok()).toBe(true);
    expect(stream.headers()['content-type']).toBe('audio/flac');
    await expect(page.locator('#player-title')).toHaveText(title);
    await expect(page.locator('#player-artist')).toHaveText(artistCredit);
    await expect.poll(() => audio.evaluate(player => player.currentTime)).toBeGreaterThan(0.1);
    await expect.poll(() => audio.evaluate(player => player.duration)).toBeGreaterThan(11);
    const lyrics = await lyricsPromise;
    await page.locator('#player-art').press('Enter');
    expect(lyrics.status()).toBe(200);
    expect(await lyrics.json()).toEqual({ lines: [
      { text: 'Fixture introduction', time: 0 },
      { text: 'Fixture chorus', time: 3 },
    ] });
    await expect(page.getByRole('button', { name: 'Fixture chorus', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭沉浸播放', exact: true }).press('Enter');

    const range = await page.request.get(stream.url(), { headers: { Range: 'bytes=0-15' } });
    const bytes = await readFile(fixturePath);
    expect(range.status()).toBe(206);
    expect(range.headers()['content-range']).toBe('bytes 0-15/' + bytes.length);
    expect(await range.body()).toEqual(bytes.subarray(0, 16));
    const seek = page.getByRole('slider', { name: '播放进度' });
    await seek.evaluate(element => {
      element.value = '600';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect.poll(() => audio.evaluate(player => player.currentTime)).toBeGreaterThan(6);

    async function finishPlayback(number) {
      await expect.poll(() => audio.evaluate(element => !element.paused && element.duration > 11)).toBe(true);
      // Accelerate the fixture while allowing an actual natural end.
      await audio.evaluate(element => { element.playbackRate = 4; });
      await expect(audio).toHaveAttribute('data-fixture-ended', String(number), { timeout: 12_000 });
    }

    await finishPlayback(1);
    expect(reports).toHaveLength(0);
    expect(await playCount()).toBe(0);
    const browseUrl = page.url();
    await page.locator('#sidebar [data-nav="settings"]').press('Enter');
    const optIn = page.getByRole('checkbox', { name: '向媒体服务器报告播放完成' });
    await expect(optIn).toHaveAttribute('id', 'report-server-playback');
    await expect(optIn).not.toBeChecked();
    await optIn.press('Space');
    await expect(optIn).toBeChecked();
    await page.goBack();
    await expect(page).toHaveURL(browseUrl);

    await track.press('Enter');
    await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
    await page.locator('#sidebar [data-nav="songs"]').press('Enter');
    await page.locator('#content').getByRole('button', { name: 'After Hours Velvet Atlas' }).press('Enter');
    await expect(page.locator('#player-title')).toHaveText('After Hours');
    await expect(audio).toHaveAttribute('data-fixture-ended', '1');
    expect(reports).toHaveLength(0);
    expect(await playCount()).toBe(0);
    await page.goBack();
    await expect(page).toHaveURL(browseUrl);

    const expectedReport = new URL(stream.url());
    expectedReport.pathname = expectedReport.pathname.replace(/\/stream$/, '/played');
    for (const count of [1, 2]) {
      const posted = page.waitForResponse(response => response.url() === expectedReport.href && response.request().method() === 'POST');
      await track.press('Enter');
      await finishPlayback(count + 1);
      expect((await posted).ok()).toBe(true);
      await expect.poll(playCount).toBe(count);
      expect(reports).toHaveLength(count);
    }

    const nav = name => page.locator('#sidebar [data-nav="' + name + '"]');
    const artistCard = name => page.locator('#content button.card').filter({ has: page.getByText(name, { exact: true }) });
    await nav('artists').press('Enter');
    await expect(artistCard(artist)).toBeVisible();
    await expect(artistCard(guestArtist)).toBeVisible();
    await expect(artistCard(artistCredit)).toHaveCount(0);
    await artistCard(guestArtist).press('Enter');
    await expect(page.locator('#content .track-name')).toHaveText([title]);
    await expect(page.locator('#content .track-artist')).toHaveText([artistCredit]);

    await nav('settings').press('Enter');
    const separators = page.getByRole('textbox', { name: '艺人分隔符', exact: true });
    const exceptions = page.getByRole('textbox', { name: '不拆分的艺人', exact: true });
    const saveArtistRules = page.getByRole('button', { name: '保存艺人规则', exact: true });
    await separators.fill('Artist feat.');
    await saveArtistRules.press('Enter');
    await nav('artists').press('Enter');
    await expect(artistCard('Groovebox Fixture')).toBeVisible();
    await expect(artistCard(artist)).toHaveCount(0);
    await expect(artistCard(guestArtist)).toBeVisible();

    await nav('settings').press('Enter');
    await exceptions.fill(artistCredit.toLowerCase());
    await saveArtistRules.press('Enter');
    await nav('artists').press('Enter');
    await expect(artistCard(artistCredit)).toBeVisible();
    await expect(artistCard(guestArtist)).toHaveCount(0);
    await page.reload();
    await expect(artistCard(artistCredit)).toBeVisible();

    await nav('settings').press('Enter');
    const wifi = page.getByRole('combobox', { name: 'Wi-Fi 码率' });
    const cellular = page.getByRole('combobox', { name: '移动数据码率' });
    const network = page.getByRole('combobox', { name: '码率使用的网络类型' });
    await expect(wifi).toHaveValue('0');
    await expect(cellular).toHaveValue('0');
    await wifi.selectOption('192');
    await cellular.selectOption('96');
    await network.selectOption('cellular');
    await page.reload();
    await expect(network).toHaveValue('cellular');
    await expect(wifi).toHaveValue('192');
    await expect(cellular).toHaveValue('96');

    await nav('songs').press('Enter');
    await page.locator('#content').getByRole('button', { name: 'After Hours Velvet Atlas' }).press('Enter');
    await expect(page.locator('#player-title')).toHaveText('After Hours');
    await nav('artists').press('Enter');
    await artistCard(artistCredit).press('Enter');
    const transcode = page.waitForResponse(response => {
      const url = new URL(response.url());
      return /^\/api\/sources\/[^/]+\/stream$/.test(url.pathname) && url.searchParams.get('maxBitRate') === '96';
    });
    await page.locator('#content').getByRole('button', { name: title + ' ' + artistCredit, exact: true }).press('Enter');
    const limited = await transcode;
    expect(limited.ok()).toBe(true);
    expect(limited.headers()['content-type']).toBe('audio/mpeg');
    await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
    await page.locator('#player-art').press('Enter');
    await expect(page.getByRole('button', { name: 'Fixture chorus', exact: true })).toBeVisible();
    const invalid = new URL(limited.url());
    invalid.searchParams.append('maxBitRate', '320');
    expect((await page.request.get(invalid.href)).status()).toBe(400);
    const transcoded = await page.request.get(limited.url());
    const { format } = await parseBuffer(await transcoded.body(), { mimeType: 'audio/mpeg' });
    expect(format.codec).toContain('Layer 3');
    expect(format.bitrate).toBeGreaterThan(90_000);
    expect(format.bitrate).toBeLessThan(102_000);
    const originalDownload = await page.request.get(stream.url());
    expect(await originalDownload.body()).toEqual(bytes);
    await page.getByRole('button', { name: '关闭沉浸播放', exact: true }).press('Enter');
    const currentRow = page.locator('#content tbody tr').filter({ hasText: title });
    const trackId = await currentRow.getAttribute('data-track');
    await currentRow.getByRole('button', { name: '歌曲选项' }).press('Enter');
    await page.getByRole('dialog').getByRole('button', { name: '离线保存', exact: true }).press('Enter');
    const offlineHash = () => page.evaluate(async id => {
      const { readOfflineBlob } = await import('/offline.js');
      const blob = await readOfflineBlob(id);
      if (!blob) return '';
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    }, trackId);
    await expect.poll(offlineHash).toBe(createHash('sha256').update(bytes).digest('hex'));
  } finally {
    if (navidrome?.pid && navidrome.exitCode === null && navidrome.signalCode === null) {
      const closed = once(navidrome, 'exit');
      navidrome.kill();
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});
