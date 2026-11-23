import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

const folderName = 'Numeric Fixtures';
const fixtureRows = [
  { file: '01.m4a', title: 'Zulu 1999', year: 1999, mtime: 1_700_000_000 },
  { file: '02.m4a', title: 'Alpha 1999', year: 1999, mtime: 1_700_000_000 },
  { file: '03.m4a', title: 'No year', mtime: 1_600_000_000 },
  { file: '04.m4a', title: 'Late release', year: 2024, mtime: 1_500_000_000 },
];

const songId = file => 'local:' + folderName + '/' + file;
const titles = page => page.locator('#content tbody .track-name');
const sort = page => page.getByRole('combobox', { name: '排序', exact: true });

async function createFolder(testInfo) {
  const folder = testInfo.outputPath(folderName);
  await mkdir(folder, { recursive: true });
  const clip = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  for (const { file, title, year, mtime } of fixtureRows) {
    const path = join(folder, file);
    await writeFile(path, await updateBuffer(clip, { title, artist: 'Date fixture', ...(year && { year }) }));
    await utimes(path, mtime, mtime);
  }
  return folder;
}

async function initialize(page, playlists = []) {
  await page.addInitScript(playlists => {
    const storageKey = 'groovebox.state.v1';
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify({ settings: { demos: false }, playlists }));
  }, playlists);
  await page.goto('/#songs');
}

test('orders real local tags and file dates, preserves playlist occurrences and uses the visible playback order', async ({ page }, testInfo) => {
  const manual = ['04.m4a', '02.m4a', '01.m4a', '02.m4a', '03.m4a'];
  await initialize(page, [{ id: 'fixture', name: 'Numeric playlist', tracks: manual.map(songId) }]);
  await page.locator('#import-folder').setInputFiles(await createFolder(testInfo));
  await expect(titles(page)).toHaveCount(4);
  const baseline = await titles(page).allTextContents();
  const tied = baseline.filter(title => title.endsWith('1999'));
  await sort(page).selectOption('release-year');
  await expect(titles(page)).toHaveText(['No year', ...tied, 'Late release']);
  await sort(page).selectOption('added-at');
  await expect(titles(page)).toHaveText(['Late release', 'No year', ...tied]);
  await sort(page).selectOption('modified-at-desc');
  await expect(titles(page)).toHaveText([...tied, 'No year', 'Late release']);

  await page.locator('#playlist-nav [data-nav="playlist/fixture"]').press('Enter');
  await expect(sort(page)).toHaveValue('default');
  const original = ['Late release', 'Alpha 1999', 'Zulu 1999', 'Alpha 1999', 'No year'];
  await expect(titles(page)).toHaveText(original);
  await sort(page).selectOption('release-year');
  const arranged = ['No year', 'Alpha 1999', 'Zulu 1999', 'Alpha 1999', 'Late release'];
  await expect(titles(page)).toHaveText(arranged);
  await page.getByRole('button', { name: '全部播放', exact: true }).click();
  await expect(sort(page)).toHaveValue('release-year');
  await expect(page.locator('#now .queue-row .track-name')).toHaveText(arranged);
  await page.reload();
  await expect(sort(page)).toHaveValue('release-year');
  await expect(titles(page)).toHaveText(arranged);
  await sort(page).selectOption('default');
  await expect(titles(page)).toHaveText(original);
  await expect(page.getByRole('button', { name: '手动排序', exact: true })).toBeEnabled();
});

test('rescans mtime on identical local audio and reads missing legacy years without inventing dates', async ({ page }, testInfo) => {
  await initialize(page);
  const folder = await createFolder(testInfo);
  await page.locator('#import-folder').setInputFiles(folder);
  await expect(titles(page)).toHaveCount(4);
  await sort(page).selectOption('added-at');
  await expect(titles(page).first()).toHaveText('Late release');
  await page.getByRole('button', { name: '全部播放', exact: true }).press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  const source = await audio.getAttribute('src');
  await utimes(join(folder, '04.m4a'), 1_800_000_000, 1_800_000_000);
  await page.locator('#import-folder').setInputFiles(folder);
  await page.locator('[data-local-import-action=replace]').press('Enter');
  await expect(titles(page).last()).toHaveText('Late release');
  await expect(audio).toHaveAttribute('src', source);
  await sort(page).selectOption('modified-at-desc');
  await expect(titles(page).first()).toHaveText('Late release');

  await page.evaluate(id => new Promise((resolve, reject) => {
    const request = indexedDB.open('groovebox.library');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('tracks', 'readwrite');
      const tracks = transaction.objectStore('tracks');
      const get = tracks.get(id);
      get.onsuccess = () => {
        const record = get.result;
        delete record.modified;
        delete record.releaseYear;
        tracks.put(record);
      };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
      transaction.oncomplete = () => { database.close(); resolve(); };
    };
  }), songId('04.m4a'));
  await page.reload();
  await expect(sort(page)).toHaveValue('modified-at-desc');
  await expect(titles(page).last()).toHaveText('Late release');
  await sort(page).selectOption('release-year');
  await expect(titles(page).first()).toHaveText('No year');
  await expect(titles(page).last()).toHaveText('Late release');
});
