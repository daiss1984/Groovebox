import { expect, test as base } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const filename = 'Fixture Artist - Same Recording.wav';
const mtime = new Date('2025-01-15T12:00:00.000Z');
const lock = (page, action) => page.getByRole('dialog').locator('[data-local-import-action="' + action + '"]');
const titles = page => page.locator('#content tbody .track-name');
const rows = page => page.locator('#content tbody tr[data-track]');
const audio = page => page.locator('#audio');
const toast = page => page.locator('#toast');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const test = base.extend({
  importFixtureRoot: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'musicer-local-import-'));
    try { await use(root); }
    finally { await rm(root, { recursive: true, force: true }); }
  },
});

function tone(frequency) {
  const rate = 16_000;
  const samples = rate * 14;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * 5000), 44 + i * 2);
  return bytes;
}

async function writeRecording(path, frequency) {
  const bytes = tone(frequency);
  await writeFile(path, bytes);
  await utimes(path, mtime, mtime);
  return digest(bytes);
}

async function sameNameFixture(root, frequencies) {
  return Promise.all(frequencies.map(async (frequency, index) => {
    const directory = join(root, 'source-' + index);
    await mkdir(directory);
    const path = join(directory, filename);
    return { path, hash: await writeRecording(path, frequency) };
  }));
}

async function launchLibrary(page) {
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { language: 'en', demos: false } }));
  });
  await page.goto('/#songs');
}

function importFiles(page, paths) { return page.locator('#import-files').setInputFiles(paths); }
function capturePlayback(page) {
  return audio(page).evaluate(media => ({ src: media.currentSrc, position: media.currentTime, paused: media.paused }));
}
function activeBytes(page) {
  return audio(page).evaluate(async media => {
    const response = await fetch(media.currentSrc);
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  });
}

function artworkBytes(row) {
  return row.locator('img').evaluate(async image => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch(image.src)).arrayBuffer()));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  });
}

async function playRow(page, row) {
  await row.locator('.track-main').press('Enter');
  await expect.poll(async () => {
    const state = await capturePlayback(page);
    return !state.paused && state.position > 0.1;
  }).toBe(true);
  return activeBytes(page);
}

test('distinguishes exact same-size and same-mtime recordings selected together and deduplicates their exact reimports', async ({ page, importFixtureRoot }) => {
  const [first, second] = await sameNameFixture(importFixtureRoot, [440, 880]);
  const metadata = await Promise.all([stat(first.path), stat(second.path)]);
  expect(metadata.map(item => [item.size, item.mtimeMs])).toEqual(Array(2).fill([metadata[0].size, metadata[0].mtimeMs]));
  await launchLibrary(page);
  await importFiles(page, [first.path, second.path]);
  await lock(page, 'keep').press('Enter');
  await expect(titles(page)).toHaveText(['Same Recording', 'Same Recording']);
  const ids = await rows(page).evaluateAll(entries => entries.map(row => row.dataset.track));
  expect(new Set(ids).size).toBe(2);
  const hashes = [];
  for (const id of ids) hashes.push(await playRow(page, rows(page).and(page.locator('[data-track="' + id + '"]'))));
  expect(hashes.toSorted()).toEqual([first.hash, second.hash].toSorted());

  await importFiles(page, [second.path, first.path]);
  await expect(toast(page)).not.toHaveText('Importing music…');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  await page.reload();
  await expect(rows(page)).toHaveCount(2);
  expect(await rows(page).evaluateAll(entries => entries.map(row => row.dataset.track))).toEqual(ids);
});

test('Escape cancels an unresolved batch before the next selection prompts and the original audio keeps playing', async ({ page, importFixtureRoot }) => {
  const [first, canceled, next] = await sameNameFixture(importFixtureRoot, [220, 440, 880]);
  const unique = join(dirname(next.path), 'Fixture Artist - Uncommitted.wav');
  await writeRecording(unique, 330);
  await launchLibrary(page);
  await importFiles(page, first.path);
  await expect(titles(page)).toHaveText(['Same Recording']);
  expect(await playRow(page, rows(page).first())).toBe(first.hash);
  const originalId = await rows(page).first().getAttribute('data-track');
  const current = await capturePlayback(page);
  await importFiles(page, [unique, canceled.path]);
  await expect(lock(page, 'keep')).toBeVisible();
  const staleButton = await lock(page, 'keep').elementHandle();
  await importFiles(page, next.path);
  await expect(titles(page)).toHaveText(['Same Recording']);
  await page.keyboard.press('Escape');
  await expect.poll(() => staleButton.evaluate(button => button.isConnected)).toBe(false);
  await expect(lock(page, 'keep')).toBeVisible();
  await lock(page, 'keep').press('Enter');
  await expect(titles(page)).toHaveText(['Same Recording', 'Same Recording']);
  const playing = await capturePlayback(page);
  expect(playing).toMatchObject({ src: current.src, paused: false });
  expect(playing.position).toBeGreaterThanOrEqual(current.position);
  expect(await activeBytes(page)).toBe(first.hash);
  const other = rows(page).and(page.locator('[data-track]:not([data-track="' + originalId + '"])'));
  await expect(other).toHaveCount(1);
  expect(await playRow(page, other)).toBe(next.hash);
});

test('replaces different bytes with the same file stats while retaining the current playback position and track ID', async ({ page, importFixtureRoot }) => {
  const [first, replacement] = await sameNameFixture(importFixtureRoot, [220, 880]);
  await launchLibrary(page);
  await importFiles(page, first.path);
  await expect(titles(page)).toHaveText(['Same Recording']);
  const id = await rows(page).first().getAttribute('data-track');
  expect(await playRow(page, rows(page).first())).toBe(first.hash);
  await audio(page).evaluate(media => { media.currentTime = 4; });
  await expect.poll(async () => (await capturePlayback(page)).position).toBeGreaterThanOrEqual(4);
  const original = await capturePlayback(page);
  await importFiles(page, replacement.path);
  await lock(page, 'replace').press('Enter');
  await expect(toast(page)).not.toHaveText('Importing music…');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toHaveAttribute('data-track', id);
  await expect.poll(async () => (await capturePlayback(page)).src).not.toBe(original.src);
  await expect.poll(async () => {
    const state = await capturePlayback(page);
    return !state.paused && state.position >= original.position - 0.15;
  }).toBe(true);
  await expect.poll(() => activeBytes(page)).toBe(replacement.hash);
  await page.reload();
  await expect(rows(page)).toHaveAttribute('data-track', id);
  expect(await playRow(page, rows(page).first())).toBe(replacement.hash);
});

test('keeps imported audio and cover bytes when the source directory is edited until an update is confirmed', async ({ page, importFixtureRoot }) => {
  const [first] = await sameNameFixture(importFixtureRoot, [440]);
  const covers = await Promise.all(['cover-1.jpg', 'cover-2.jpg'].map(file => readFile(new URL('../public/assets/' + file, import.meta.url))));
  const coverSize = Math.max(...covers.map(bytes => bytes.length));
  const [originalCover, replacementCover] = covers.map(bytes => Buffer.concat([bytes], coverSize));
  const coverPath = join(dirname(first.path), 'cover.jpg');
  const writeCover = async bytes => {
    await writeFile(coverPath, bytes);
    await utimes(coverPath, mtime, mtime);
  };
  const scan = () => page.locator('#import-folder').setInputFiles(dirname(first.path));
  await writeCover(originalCover);
  await launchLibrary(page);
  await scan();
  await expect(titles(page)).toHaveText(['Same Recording']);
  const id = await rows(page).first().getAttribute('data-track');
  expect(await playRow(page, rows(page).first())).toBe(first.hash);
  expect(await artworkBytes(rows(page))).toBe(digest(originalCover));

  const replacementHash = await writeRecording(first.path, 880);
  await writeCover(replacementCover);
  expect(await activeBytes(page)).toBe(first.hash);
  expect(await artworkBytes(rows(page))).toBe(digest(originalCover));
  await page.reload();
  await expect(rows(page)).toHaveAttribute('data-track', id);
  expect(await playRow(page, rows(page).first())).toBe(first.hash);
  const oldCoverURL = await rows(page).locator('img').getAttribute('src');
  expect(await artworkBytes(rows(page))).toBe(digest(originalCover));

  await scan();
  await expect(lock(page, 'replace')).toBeVisible();
  expect(await activeBytes(page)).toBe(first.hash);
  await lock(page, 'replace').press('Enter');
  await expect.poll(() => activeBytes(page)).toBe(replacementHash);
  await expect(rows(page)).toHaveAttribute('data-track', id);
  await expect(rows(page).locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(rows(page).locator('img')).not.toHaveAttribute('src', oldCoverURL);
  expect(await artworkBytes(rows(page))).toBe(digest(replacementCover));
});

test('resumes the current imported audio if the confirmed replacement cannot be decoded', async ({ page, importFixtureRoot }) => {
  const [first, broken] = await sameNameFixture(importFixtureRoot, [440, 880]);
  await writeFile(broken.path, Buffer.alloc(tone(880).length));
  await utimes(broken.path, mtime, mtime);
  await launchLibrary(page);
  await importFiles(page, first.path);
  await expect(titles(page)).toHaveText(['Same Recording']);
  const id = await rows(page).first().getAttribute('data-track');
  expect(await playRow(page, rows(page).first())).toBe(first.hash);
  await audio(page).evaluate(media => { media.currentTime = 4; });
  await expect.poll(async () => (await capturePlayback(page)).position).toBeGreaterThanOrEqual(4);
  const original = await capturePlayback(page);

  await importFiles(page, broken.path);
  await lock(page, 'replace').press('Enter');
  await expect(toast(page)).not.toHaveText('Importing music…');
  await expect.poll(async () => {
    const state = await capturePlayback(page);
    return state.src === original.src && !state.paused && state.position >= original.position - 0.15;
  }).toBe(true);
  await expect(rows(page)).toHaveAttribute('data-track', id);
  expect(await activeBytes(page)).toBe(first.hash);
});

test('rejects a stale replacement choice after another tab updated the imported copy', async ({ page, context, importFixtureRoot }) => {
  const [first, stale, replacement] = await sameNameFixture(importFixtureRoot, [220, 440, 880]);
  await launchLibrary(page);
  await importFiles(page, first.path);
  await expect(titles(page)).toHaveText(['Same Recording']);
  const id = await rows(page).first().getAttribute('data-track');
  await importFiles(page, stale.path);
  await expect(lock(page, 'replace')).toBeVisible();

  const other = await context.newPage();
  try {
    await other.goto('/#songs');
    await expect(rows(other)).toHaveAttribute('data-track', id);
    await importFiles(other, replacement.path);
    await lock(other, 'replace').press('Enter');
    await expect(toast(other)).not.toHaveText('Importing music…');
    expect(await playRow(other, rows(other).first())).toBe(replacement.hash);
    await lock(page, 'replace').press('Enter');
    await expect(toast(page)).toContainText(/library changed/i);
    await page.reload();
    await expect(rows(page)).toHaveAttribute('data-track', id);
    expect(await playRow(page, rows(page).first())).toBe(replacement.hash);
  } finally { await other.close(); }
});

test('recovers a blocked local library upgrade after the older tab closes without losing the existing recording', async ({ page, context, importFixtureRoot }) => {
  const [legacy, extra] = await sameNameFixture(importFixtureRoot, [440, 880]);
  const extraPath = join(dirname(extra.path), 'Fixture Artist - Added.wav');
  await writeRecording(extraPath, 880);
  const oldTab = await context.newPage();
  await oldTab.route('**/legacy-local-tab', route => route.fulfill({
    contentType: 'text/html',
    body: '<input type="file">',
  }));
  try {
    await oldTab.goto('/legacy-local-tab');
    await oldTab.locator('input').setInputFiles(legacy.path);
    await oldTab.evaluate(async () => {
      const selected = document.querySelector('input').files[0];
      const audioBinary = { buffer: await selected.arrayBuffer(), type: selected.type };
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('groovebox.library', 3);
        request.onupgradeneeded = () => {
          for (const name of ['tracks', 'serverPlaylists', 'artistImages']) {
            request.result.createObjectStore(name, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      globalThis.fixtureOldDatabase = database;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('tracks', 'readwrite');
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error('Legacy fixture transaction aborted'));
        transaction.objectStore('tracks').put({
          id: 'local:legacy', title: 'Legacy Recording', artist: 'Fixture Artist', provider: 'local',
          path: selected.name, duration: 14, modified: selected.lastModified, audioBinary,
        });
      });
    });

    await launchLibrary(page);
    await expect(toast(page)).toContainText('Close other tabs that have this player open, then reload this page');
    await expect(rows(page)).toHaveCount(0);
    await oldTab.close();
    await page.reload();
    await expect(titles(page)).toHaveText(['Legacy Recording']);
    await importFiles(page, extraPath);
    await expect(titles(page)).toContainText(['Legacy Recording']);
    await expect(titles(page)).toContainText(['Added']);
    await page.reload();
    const legacyRow = rows(page).and(page.locator('[data-track="local:legacy"]'));
    await expect(legacyRow).toHaveCount(1);
    expect(await playRow(page, legacyRow)).toBe(legacy.hash);
    await expect(titles(page)).toContainText(['Added']);
  } finally {
    if (!oldTab.isClosed()) await oldTab.close();
  }
});

test('keeps the previous directory audio, cover, and playing reference if an artist-image write exceeds storage quota', async ({ page, importFixtureRoot: root }) => {
  const first = join(root, 'original', 'Album');
  const replacement = join(root, 'replacement', 'Album');
  await Promise.all([first, replacement].map(directory => mkdir(join(directory, 'artist'), { recursive: true })));
  const files = ['cover-1.jpg', 'cover-2.jpg'].map(file => readFile(new URL('../public/assets/' + file, import.meta.url)));
  const [oldCover, newCover] = await Promise.all(files);
  const originalHash = await writeRecording(join(first, filename), 440);
  const cover = directory => join(directory, 'cover.jpg');
  const portrait = directory => join(directory, 'artist', 'Fixture Artist.jpg');
  await Promise.all([writeFile(cover(first), oldCover), writeFile(portrait(first), oldCover)]);
  const scan = directory => page.locator('#import-folder').setInputFiles(directory);
  await launchLibrary(page);
  await scan(first);
  await expect(titles(page)).toHaveText(['Same Recording']);
  expect(await playRow(page, rows(page).first())).toBe(originalHash);
  const id = await rows(page).first().getAttribute('data-track');
  const start = await capturePlayback(page);

  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'tracks' && args[0]?.audioFile) {
        throw new DOMException('Synthetic File cloning failure', 'DataCloneError');
      }
      if (this.name === 'tracks' && args[0]?.audioBinary) globalThis.fixtureBinaryWrite = true;
      if (this.name === 'artistImages') {
        globalThis.fixtureQuotaHit = true;
        throw new DOMException('Synthetic storage capacity exceeded', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
  });
  await Promise.all([writeRecording(join(replacement, filename), 880),
    writeRecording(join(replacement, 'Fixture Artist - Added.wav'), 330),
    writeFile(cover(replacement), newCover), writeFile(portrait(replacement), newCover)]);
  await scan(replacement);
  await lock(page, 'replace').press('Enter');
  await expect.poll(() => page.evaluate(() => globalThis.fixtureBinaryWrite === true)).toBe(true);
  await expect.poll(() => page.evaluate(() => globalThis.fixtureQuotaHit === true)).toBe(true);
  await expect(toast(page)).toContainText('Import failed');
  await expect(titles(page)).toHaveText(['Same Recording']);
  const playback = await capturePlayback(page);
  expect(playback).toMatchObject({ src: start.src, paused: false });
  expect(playback.position).toBeGreaterThanOrEqual(start.position);
  expect(await activeBytes(page)).toBe(originalHash);

  await page.reload();
  await expect(titles(page)).toHaveText(['Same Recording']);
  await expect(rows(page)).toHaveAttribute('data-track', id);
  expect(await playRow(page, rows(page).first())).toBe(originalHash);
  const artwork = rows(page).locator('img');
  await expect(artwork).toHaveAttribute('src', /^blob:/);
  expect(await artworkBytes(rows(page))).toBe(digest(oldCover));
});
