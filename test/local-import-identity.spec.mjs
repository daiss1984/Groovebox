import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

const artist = 'Fixture Artist';
const stateKey = 'groovebox.state.v1';
const song = (page, title) => page.locator('#content').getByRole('button', { name: title + ' ' + artist, exact: true });
const player = page => page.locator('#audio');
const dialogButton = (page, name) => page.getByRole('dialog').getByRole('button', { name, exact: true });
const choose = (page, action) => page.getByRole('dialog').locator('[data-local-import-action=' + action + ']');
const nav = (page, section) => page.locator('#sidebar [data-nav="' + section + '"]');
const asset = filename => readFile(new URL('../public/assets/' + filename, import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHash = node => node.evaluate(async element => {
  const data = await (await fetch(element.src)).arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
});
async function tagged(sample, title, lyrics) {
  return Buffer.from(await updateBuffer(await asset(sample), { title, artist, album: 'Fixture Album',
    ...(lyrics && { lyrics: '[00:00.00]' + lyrics }) }));
}
async function writeAt(directory, filename, bytes) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  await writeFile(path, bytes);
  return path;
}
async function lyric(page, text) {
  const now = page.locator('#now');
  const line = now.getByRole('button', { name: text, exact: true });
  if (!await line.isVisible()) {
    const tab = now.getByRole('button', { name: '歌词', exact: true });
    if (await tab.isVisible()) await tab.press('Enter');
  }
  await expect(line).toBeVisible();
}

test('preserves playlist identity and active bytes when keeping both recordings, then explicitly replaces only the chosen copy', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'groovebox-local-identity-'));
  const originalId = 'local:track.m4a';
  const oldLyrics = 'Preferred online text for first recording';
  try {
    const bytes = await Promise.all([
      tagged('demo-1.m4a', 'First Recording', 'Embedded first text'),
      tagged('demo-2.m4a', 'Second Recording'),
      tagged('demo-3.m4a', 'Replacement Recording', 'Embedded replacement text'),
    ]);
    const [first, second, replacement] = await Promise.all(bytes.map((sample, i) => writeAt(join(root, String(i)), 'track.m4a', sample)));
    await page.addInitScript(({ stateKey, originalId, oldLyrics }) => {
      if (localStorage.getItem(stateKey)) return;
      localStorage.setItem(stateKey, JSON.stringify({ settings: { demos: false, autoMatchLyrics: false },
        onlineLyrics: [[originalId, [{ time: 0, text: oldLyrics }], true], ['local:unrelated.m4a', [{ time: 0, text: 'Unrelated' }], true]] }));
    }, { stateKey, originalId, oldLyrics });
    await page.goto('/#offline');
    const importFile = path => page.locator('#import-files').setInputFiles(path);
    await importFile(first);

    const row = page.locator('#content [data-track="' + originalId + '"]');
    await expect(song(page, 'First Recording')).toBeVisible();
    await row.getByRole('button', { name: '收藏', exact: true }).press('Enter');
    await row.getByRole('button', { name: '歌曲选项', exact: true }).press('Enter');
    await dialogButton(page, '添加到歌单').press('Enter');
    await dialogButton(page, '新建歌单').press('Enter');
    await page.getByRole('dialog').getByRole('textbox').fill('Original Recording Playlist');
    await dialogButton(page, '创建').press('Enter');
    await expect(page).toHaveURL(/#playlist%2F/);
    await song(page, 'First Recording').press('Enter');
    await lyric(page, oldLyrics);
    await expect.poll(() => sourceHash(player(page))).toBe(hash(bytes[0]));
    const oldSource = await player(page).getAttribute('src');
    const playlistUrl = page.url();

    await importFile(second);
    await choose(page, 'keep').press('Enter');
    await expect(page.locator('#toast')).toContainText('已导入或更新 1 首本地歌曲');
    await expect(row).toContainText('First Recording');
    await expect(song(page, 'Second Recording')).toHaveCount(0);
    await expect(player(page)).toHaveAttribute('src', oldSource);
    expect(await sourceHash(player(page))).toBe(hash(bytes[0]));

    await nav(page, 'offline').press('Enter');
    const secondRow = page.locator('#content tr').filter({
      has: page.getByRole('button', { name: 'Second Recording ' + artist, exact: true }),
    });
    const secondId = await secondRow.getAttribute('data-track');
    expect(secondId).toMatch(/^local:copy\//);
    await page.reload();
    await expect(secondRow).toHaveAttribute('data-track', secondId);
    await importFile(second);
    await expect(page.locator('#toast')).toContainText('已导入或更新 1 首本地歌曲');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.locator('#content tbody tr')).toHaveCount(2);

    await page.goto(playlistUrl);
    await song(page, 'First Recording').press('Enter');
    await lyric(page, oldLyrics);
    await importFile(replacement);
    await page.getByRole('dialog').locator('select[name=collection]').selectOption({ label: 'First Recording · ' + artist });
    await choose(page, 'replace').press('Enter');
    await expect(row).toContainText('Replacement Recording');
    await expect(page.locator('#player-title')).toHaveText('Replacement Recording');
    await expect.poll(() => sourceHash(player(page))).toBe(hash(bytes[2]));
    await lyric(page, 'Embedded replacement text');
    await expect(page.locator('#now').getByRole('button', { name: oldLyrics, exact: true })).toHaveCount(0);
    const remainingMatches = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).onlineLyrics.map(([id]) => id), stateKey);
    expect(remainingMatches).toEqual(['local:unrelated.m4a']);

    await nav(page, 'favorites').press('Enter');
    await expect(row).toContainText('Replacement Recording');
    await nav(page, 'offline').press('Enter');
    await secondRow.getByRole('button', { name: '歌曲选项', exact: true }).press('Enter');
    await dialogButton(page, '从曲库移除').press('Enter');
    await page.getByRole('dialog').getByRole('checkbox', { name: '同时移除播放器里的本地副本', exact: true }).check();
    await dialogButton(page, '确认').press('Enter');
    await expect(secondRow).toHaveCount(0);
    await expect(row).toContainText('Replacement Recording');
    expect(await Promise.all([first, second, replacement].map(path => readFile(path)))).toEqual(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('isolates two same-name folders with identical audio and refreshes missing legacy sidecars while keeping manual lyrics', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'groovebox-local-collection-'));
  try {
    const first = join(root, 'first', 'Music');
    const second = join(root, 'second', 'Music');
    const [audio, manualAudio, firstCover, secondCover, retainedAudio] = await Promise.all([
      tagged('demo-1.m4a', 'Collection Recording', 'Embedded fallback text'),
      tagged('demo-2.m4a', 'Manually Annotated Recording', 'Embedded manual baseline'),
      asset('cover-1.jpg'), asset('cover-2.jpg'),
      tagged('demo-3.m4a', 'Retained Browser Copy', 'Embedded retained text'),
    ]);
    const [firstLyric, retainedFile, retainedLyric] = await Promise.all([
      writeAt(join(first, 'Record'), 'track.lrc', '[00:00.00]First folder sidecar'),
      writeAt(join(first, 'Record'), 'retained.m4a', retainedAudio),
      writeAt(join(first, 'Record'), 'retained.lrc', '[00:00.00]Old retained sidecar'),
      writeAt(join(second, 'Record'), 'track.lrc', '[00:00.00]Second folder sidecar'),
      writeAt(join(first, 'Record'), 'track.m4a', audio),
      writeAt(join(second, 'Record'), 'track.m4a', audio),
      writeAt(join(first, 'Record'), 'manual.m4a', manualAudio),
      writeAt(join(first, 'Record'), 'cover.jpg', firstCover),
      writeAt(join(second, 'Record'), 'cover.jpg', secondCover),
      writeAt(join(first, 'artist'), artist + '.jpg', secondCover),
      writeAt(join(second, 'artist'), artist + '.jpg', firstCover),
    ]);
    const manualLyric = await writeAt(root, 'manual.lrc', '[00:00.00]Manually selected text');
    await page.goto('/#offline');
    const importFolder = path => page.locator('#import-folder').setInputFiles(path);
    await importFolder(first);
    await expect(page.locator('#content tbody tr')).toHaveCount(3);
    await importFolder(second);
    await choose(page, 'keep').press('Enter');
    await expect(page.locator('#content tbody tr')).toHaveCount(4);
    await page.locator('#import-files').setInputFiles(manualLyric);
    await expect(page.locator('#toast')).toContainText('已导入或更新 1 首本地歌曲');

    const state = await page.evaluate(() => new Promise((resolve, reject) => {
      const opened = indexedDB.open('groovebox.library');
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const db = opened.result;
        const tx = db.transaction(['tracks', 'artistImages'], 'readwrite');
        const tracks = tx.objectStore('tracks');
        const first = tracks.get('local:Music/Record/track.m4a');
        const artistImages = tx.objectStore('artistImages').getAll();
        first.onsuccess = () => {
          if (first.result.lyricsSource !== 'folder') return reject(new Error('Expected a genuine folder import'));
          delete first.result.lyricsSource;
          tracks.put(first.result);
        };
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => { db.close(); resolve(artistImages.result.map(({ root, binary }) => [root, Array.from(new Uint8Array(binary.buffer))])); };
      };
    }));
    expect(Object.fromEntries(state.map(([alias, bytes]) => [alias, hash(Buffer.from(bytes))]))).toEqual({
      Music: hash(secondCover), 'Music (2)': hash(firstCover),
    });

    const openCollection = alias => page.goto('/#local-folder/' + encodeURIComponent(alias + '/Record'));
    const recording = song(page, 'Collection Recording');
    await openCollection('Music');
    await expect(recording).toHaveCount(1);
    await expect.poll(() => sourceHash(recording.locator('img'))).toBe(hash(firstCover));
    await recording.press('Enter');
    await lyric(page, 'First folder sidecar');
    await song(page, 'Manually Annotated Recording').press('Enter');
    await lyric(page, 'Manually selected text');
    await openCollection('Music (2)');
    await expect(recording).toHaveCount(1);
    await expect.poll(() => sourceHash(recording.locator('img'))).toBe(hash(secondCover));
    await recording.press('Enter');
    await lyric(page, 'Second folder sidecar');

    await Promise.all([unlink(firstLyric), unlink(retainedFile), unlink(retainedLyric)]);
    await openCollection('Music');
    await page.reload();
    await expect(recording).toBeVisible();
    await importFolder(first);
    await page.getByRole('dialog').locator('select[name=collection]').selectOption({ label: 'Music' });
    await choose(page, 'replace').press('Enter');
    await expect(page.locator('#toast')).toContainText('已导入或更新 3 首本地歌曲');
    await recording.press('Enter');
    await lyric(page, 'Embedded fallback text');
    await song(page, 'Manually Annotated Recording').press('Enter');
    await lyric(page, 'Manually selected text');
    await song(page, 'Retained Browser Copy').press('Enter');
    await lyric(page, 'Embedded retained text');
    expect(await sourceHash(player(page))).toBe(hash(retainedAudio));
    await openCollection('Music (2)');
    await recording.press('Enter');
    await lyric(page, 'Second folder sidecar');
    expect(await readFile(join(first, 'Record', 'track.m4a'))).toEqual(audio);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('discards an automatic lyrics result still pending when the playing recording is replaced', async ({ page }) => {
  const [original, replacement] = await Promise.all([
    tagged('demo-1.m4a', 'Pending Lyrics Original'),
    tagged('demo-2.m4a', 'Pending Lyrics Replacement', 'Replacement embedded text'),
  ]);
  await page.addInitScript(stateKey => {
    if (!localStorage.getItem(stateKey)) localStorage.setItem(stateKey, JSON.stringify({
      settings: { demos: false, autoMatchLyrics: true },
    }));
    const fetchOriginal = window.fetch.bind(window);
    window.pendingLocalMatches = [];
    window.fetch = (input, options) => {
      const url = new URL(input, location.origin);
      if (url.origin !== 'https://lrclib.net') return fetchOriginal(input, options);
      return new Promise(resolve => window.pendingLocalMatches.push({
        title: url.searchParams.get('track_name'), signal: options.signal, resolve,
      }));
    };
  }, stateKey);
  await page.goto('/#offline');
  const importFile = bytes => page.locator('#import-files').setInputFiles({
    name: 'pending.m4a', mimeType: 'audio/mp4', buffer: bytes,
  });
  await importFile(original);
  await song(page, 'Pending Lyrics Original').press('Enter');
  await expect.poll(() => page.evaluate(() => window.pendingLocalMatches[0]?.title)).toBe('Pending Lyrics Original');
  await importFile(replacement);
  await choose(page, 'replace').press('Enter');
  await expect(page.locator('#player-title')).toHaveText('Pending Lyrics Replacement');
  await expect.poll(() => page.evaluate(() => window.pendingLocalMatches.every(match => match.signal.aborted))).toBe(true);
  await page.evaluate(() => {
    for (const match of window.pendingLocalMatches) {
      match.resolve(Response.json({ syncedLyrics: '[00:00.00]An obsolete online lyric' }));
    }
  });
  await lyric(page, 'Replacement embedded text');
  await expect(page.locator('#now').getByRole('button', { name: 'An obsolete online lyric', exact: true })).toHaveCount(0);
  const matches = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).onlineLyrics ?? [], stateKey);
  expect(matches).toEqual([]);
});
