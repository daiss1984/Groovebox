import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const fileName = 'Fixture recording.m4a';
const playlist = { id: 'pin-export-fixture', name: 'Original export fixture', tracks: ['baidu:5150'] };
const track = { id: playlist.tracks[0], provider: 'baidu', title: 'Fixture recording', artist: 'Fixture artist',
  fileName, path: '/' + fileName, src: '/api/baidu/stream?id=5150' };

function archiveEntry(zip) {
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  expect(zip.readUInt16LE(8)).toBe(0);
  const size = zip.readUInt32LE(18);
  const nameEnd = 30 + zip.readUInt16LE(26);
  const content = nameEnd + zip.readUInt16LE(28);
  expect(zip.readUInt32LE(content + size)).toBe(0x02014b50);
  return { name: zip.toString('utf8', 30, nameEnd), data: zip.subarray(content, content + size) };
}

test('downloads original bytes individually and as a ZIP when the cached copy cannot be pinned', async ({ page }) => {
  const expected = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  let sourceRequests = 0;
  await page.route('**/api/baidu/stream?**', route => { sourceRequests++; return route.abort(); });
  await page.addInitScript(({ track, playlist }) => {
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ tracks: [track], playlists: [playlist], settings: {
      language: 'en', demos: false, artistImageEngine: false, onlineCover: false,
    } }));
  }, { playlist, track });
  await page.goto('/#songs');
  await page.evaluate(async track => {
    const offline = await import('/offline.js');
    const response = await fetch('/assets/demo-1.m4a');
    const generation = await offline.offlineCacheGeneration();
    await offline.saveOfflineTrack(track, await response.blob(), { mode: 'automatic', generation });
    window.pinExportFixtureFailures = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (record, ...args) {
      if (this.name === 'cache-entries' && record.id === track.id && record.mode === 'pinned') {
        window.pinExportFixtureFailures++;
        throw new DOMException('Fixture cannot promote an automatic copy', 'QuotaExceededError');
      }
      return put.call(this, record, ...args);
    };
  }, track);

  await page.locator('#content [data-action=track-menu]').press('Enter');
  const menu = page.getByRole('dialog');
  await expect(menu.getByRole('button', { name: 'Keep Offline Copy', exact: true })).toBeVisible();
  const original = page.waitForEvent('download', { timeout: 10_000 });
  await menu.getByRole('button', { name: 'Save Original Audio to Device', exact: true }).press('Enter');
  const file = await original;
  expect(file.suggestedFilename()).toBe(fileName);
  expect(await readFile(await file.path())).toEqual(expected);
  expect(await page.evaluate(() => window.pinExportFixtureFailures)).toBe(1);

  await page.locator('#playlist-nav [data-nav="playlist/' + playlist.id + '"]').press('Enter');
  await expect(page.getByRole('heading', { name: playlist.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Download playlist', exact: true }).press('Enter');
  await expect(page.locator('[data-playlist-export-status]')).toContainText('Tracks not saved in the browser: 1.');
  const archived = page.waitForEvent('download', { timeout: 10_000 });
  await page.getByRole('link', { name: 'Save ZIP', exact: true }).press('Enter');
  const zip = await archived;
  expect(zip.suggestedFilename()).toBe(playlist.name + '.zip');
  expect(archiveEntry(await readFile(await zip.path()))).toEqual({ name: fileName, data: expected });
  expect(await page.evaluate(() => window.pinExportFixtureFailures)).toBe(2);
  expect(await page.evaluate(async id => (await import('/offline.js')).offlineTrackMode(id), track.id)).toBe('automatic');
  expect(sourceRequests).toBe(0);
});
