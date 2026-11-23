import { expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const navidromeBin = process.env.NAVIDROME_TEST_BIN;
const ffmpegBin = process.env.FFMPEG_TEST_BIN;
const exec = promisify(execFile);
const title = 'Fixture Lyrics Recording';
const album = 'Fixture Lyrics Album';
const japanese = ['日本語の', '歌詞'];
const languages = [['eng', true], ['fra', false], ['jpn', true]];

function id3Frame(name, value) {
  const header = Buffer.alloc(10);
  header.write(name, 'ascii');
  header.writeUInt32BE(value.length, 4);
  return Buffer.concat([header, value]);
}

function mp3WithLyricVersions(audio) {
  function lyric(language, text) {
    // ID3v2.3 USLT has an encoding byte, a language, an empty description, and lyrics.
    const prefix = Buffer.concat([Buffer.from('\x01' + language, 'ascii'), Buffer.from([0xff, 0xfe, 0, 0, 0xff, 0xfe])]);
    return id3Frame('USLT', Buffer.concat([prefix, Buffer.from(text, 'utf16le')]));
  }
  const frames = Buffer.concat([
    id3Frame('TIT2', Buffer.from('\0' + title, 'ascii')),
    id3Frame('TPE1', Buffer.from('\0Fixture Artist', 'ascii')),
    id3Frame('TALB', Buffer.from('\0' + album, 'ascii')),
    lyric('eng', '[00:01.00]English embedded version'),
    lyric('fra', 'Version française'),
    lyric('jpn', '[00:02.00]<00:02.00>' + japanese[0] + '<00:02.50>' + japanese[1]),
  ]);
  const size = [21, 14, 7, 0].map(shift => (frames.length >>> shift) & 127);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, ...size]);
  return Buffer.concat([header, frames, audio]);
}

test('real Navidrome exposes embedded language versions and remembers the chosen lyrics after reload', async ({ page }) => {
  test.skip(!navidromeBin || !ffmpegBin, 'Provide NAVIDROME_TEST_BIN and FFMPEG_TEST_BIN to run the live fixture.');
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-navidrome-lyric-versions-'));
  const music = join(root, 'music');
  const password = randomBytes(24).toString('hex');
  let navidrome;
  try {
    await mkdir(music);
    const { stdout: mp3 } = await exec(ffmpegBin, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15',
      '-c:a', 'libmp3lame', '-id3v2_version', '0', '-f', 'mp3', 'pipe:1',
    ], { encoding: 'buffer', timeout: 10_000 });
    await writeFile(join(music, 'Recording.mp3'), mp3WithLyricVersions(mp3));
    const reservation = createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const { port } = reservation.address();
    await new Promise(resolveClose => reservation.close(resolveClose));
    const origin = 'http://127.0.0.1:' + port;
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
    const salt = randomBytes(16).toString('hex');
    const token = createHash('md5').update(password + salt).digest('hex');
    async function upstream(method, params) {
      const query = new URLSearchParams({ u: 'admin', s: salt, t: token, v: '1.16.1', c: 'GrooveboxTest', f: 'json', ...params });
      const response = await fetch(origin + '/rest/' + method + '.view?' + query, { signal: AbortSignal.timeout(1500) });
      return (await response.json())['subsonic-response'];
    }
    let id;
    await expect.poll(async () => {
      if (startupError || navidrome.exitCode !== null) return 'Navidrome exited before indexing';
      try {
        const result = await upstream('search3', { query: title, artistCount: '0', albumCount: '0', songCount: '1' });
        id = result.searchResult3?.song?.find(song => song.title === title)?.id;
        return Boolean(id);
      } catch { return false; }
    }, { timeout: 14_000 }).toBe(true);
    const original = await upstream('getLyricsBySongId', { id, enhanced: 'true' });
    const upstreamVersions = original.lyricsList.structuredLyrics;
    expect(upstreamVersions.map(({ lang, synced }) => [lang, synced]).toSorted()).toEqual(languages);
    expect(upstreamVersions.every(version => version.kind === 'main')).toBe(true);
    expect(upstreamVersions.find(version => version.lang === 'jpn').cueLine[0].cue.map(word => word.value)).toEqual(japanese);

    await page.addInitScript(() => {
      if (!localStorage.getItem('groovebox.state.v1')) {
        localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { language: 'en', demos: false } }));
      }
    });
    await page.goto('/#sources');
    await page.getByRole('button', { name: /Add Media Server/ }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Protocol').selectOption('navidrome');
    await dialog.getByLabel('Name', { exact: true }).fill('Isolated Navidrome');
    await dialog.getByLabel('Server URL').fill(origin);
    await dialog.getByLabel('Username').fill('admin');
    await dialog.getByLabel('Password').fill(password);
    const connecting = page.waitForResponse(response => response.url().endsWith('/api/sources') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Connect', exact: true }).press('Enter');
    expect((await connecting).status()).toBe(201);
    await page.locator('#sidebar [data-nav="home"]').press('Enter');
    await page.locator('section[aria-labelledby="direct-recommendations-heading"] button.card').filter({ hasText: album }).press('Enter');
    const lyricResponse = page.waitForResponse(response => /\/api\/sources\/[^/]+\/stream\?id=[\w-]+-lyrics$/.test(response.url()));
    await page.locator('#content').getByRole('button', { name: new RegExp(title) }).press('Enter');
    const response = await lyricResponse;
    expect(response.status()).toBe(200);
    const proxy = await response.json();
    const versions = [{ ...proxy.defaultVersion, lines: proxy.lines }, ...proxy.variants];
    expect(versions.map(({ language, timed }) => [language, timed])).toEqual(upstreamVersions.map(({ lang, synced }) => [lang, synced]));
    expect(versions.find(version => version.language === 'jpn').lines[0].words).toEqual([
      { time: 2, text: japanese[0] }, { time: 2.5, text: japanese[1] },
    ]);
    await expect(page.locator('#player-title')).toHaveText(title);
    await expect.poll(() => page.locator('#audio').evaluate(element => element.paused ? 0 : element.currentTime)).toBeGreaterThan(0.1);
    await page.getByRole('contentinfo', { name: 'Music Player' }).getByRole('button', { name: 'Pause', exact: true }).press('Enter');

    const lyrics = page.locator('#now');
    const lyricsTab = lyrics.getByRole('button', { name: 'Lyrics', exact: true });
    const picker = lyrics.getByRole('button', { name: 'Server Lyric Versions', exact: true });
    await lyricsTab.press('Enter');
    await expect(lyrics.locator('.lyric-line')).toHaveText(upstreamVersions[0].line[0].value);
    await picker.press('Enter');
    await dialog.getByRole('button', { name: 'French · Plain lyrics' }).press('Enter');
    await expect(lyrics.locator('p.lyric-line')).toHaveText('Version française');
    await page.reload();
    await lyricsTab.press('Enter');
    await expect(lyrics.locator('p.lyric-line')).toHaveText('Version française');
    await picker.press('Enter');
    await dialog.getByRole('button', { name: 'Japanese · Synchronized lyrics' }).press('Enter');
    await expect(lyrics.locator('.lyric-word')).toHaveText(japanese);
  } finally {
    if (navidrome?.pid && navidrome.exitCode === null && navidrome.signalCode === null) {
      const stopped = once(navidrome, 'exit');
      navidrome.kill();
      await stopped;
    }
    await rm(root, { recursive: true, force: true });
  }
});
