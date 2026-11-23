import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

test('groups tagged album artists precisely and keeps uncredited compilations together', async ({ page }) => {
  const album = 'Open Sessions';
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const fixture = async (title, artist, albumartist) => ({ name: title + '.m4a', mimeType: 'audio/mp4',
    buffer: Buffer.from(await updateBuffer(audio, { title, artist, album, ...(albumartist && { albumartist }) })) });
  const files = await Promise.all([
    fixture('Uncredited dawn', 'First performer'), fixture('Uncredited dusk', 'Second performer'),
    fixture('Credited dawn', 'First performer', 'Session Collective'), fixture('Credited dusk', 'Second performer', 'Session Collective'),
    fixture('Other release', 'Guest performer', 'Studio Ensemble'),
  ]);
  const content = page.locator('#content');
  const nav = section => page.locator('#sidebar [data-nav=' + section + ']');
  const titles = content.locator('tbody .track-name');
  const cards = content.locator('[data-action=group]').filter({ has: page.getByText(album, { exact: true }) });
  const byCaption = caption => cards.filter({ has: page.getByText(caption, { exact: true }) });
  const fallback = content.getByRole('checkbox', { name: '专辑缺少艺人标签时使用歌曲艺人' });

  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles(files);
  await expect(content.getByText('Other release', { exact: true })).toBeVisible();
  await nav('albums').press('Enter');
  await expect(cards).toHaveCount(3);
  await byCaption('2 首歌曲').press('Enter');
  await expect(content.getByText('2 首歌曲 · 未知专辑艺人', { exact: true })).toBeVisible();
  await expect(titles).toHaveText(['Uncredited dawn', 'Uncredited dusk']);
  await nav('albums').press('Enter');
  await byCaption('2 首歌曲 · Session Collective').press('Enter');
  await expect(titles).toHaveText(['Credited dawn', 'Credited dusk']);
  await page.reload();
  await expect(titles).toHaveText(['Credited dawn', 'Credited dusk']);

  await nav('offline').press('Enter');
  const albumFilter = content.getByRole('combobox', { name: '专辑', exact: true });
  await albumFilter.selectOption({ label: 'Open Sessions · Studio Ensemble' });
  await expect(titles).toHaveText(['Other release']);

  await nav('settings').press('Enter');
  await expect(fallback).not.toBeChecked();
  await fallback.press('Space');
  await expect(fallback).toBeChecked();
  const downloaded = page.waitForEvent('download');
  await content.getByRole('button', { name: '导出备份' }).press('Enter');
  const backup = await readFile(await (await downloaded).path());
  expect(JSON.parse(backup).settings.albumArtistFallback).toBe(true);
  await nav('albums').press('Enter');
  await expect(cards).toHaveCount(4);
  await byCaption('1 首歌曲 · Second performer').press('Enter');
  await expect(titles).toHaveText(['Uncredited dusk']);

  await nav('settings').press('Enter');
  await fallback.press('Space');
  await expect(fallback).not.toBeChecked();
  await nav('albums').press('Enter');
  await expect(cards).toHaveCount(3);
  await nav('settings').press('Enter');
  await page.locator('#restore-file').setInputFiles({ name: 'album-artist-backup.json', mimeType: 'application/json', buffer: backup });
  await expect(fallback).toBeChecked();

  // Simulate an older record that stored the audio but had no separate album artist field.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('groovebox.library');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('tracks', 'readwrite');
      const tracks = transaction.objectStore('tracks');
      const get = tracks.get('local:Credited dusk.m4a');
      get.onsuccess = () => {
        const record = get.result;
        delete record.albumArtist;
        tracks.put(record);
      };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
      transaction.oncomplete = () => { database.close(); resolve(); };
    };
  }));
  await page.goto('/#albums');
  await page.reload();
  await expect(byCaption('2 首歌曲 · Session Collective')).toBeVisible();
  await byCaption('2 首歌曲 · Session Collective').press('Enter');
  await expect(titles).toHaveText(['Credited dawn', 'Credited dusk']);
});

test('opens each album credit and keeps credited albums reachable during playback', async ({ page }) => {
  const album = 'Coastal Collection';
  const guest = '南方 & "Guests"';
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const fixture = async (title, artist, release, albumartist) => ({ name: title + '.m4a', mimeType: 'audio/mp4',
    buffer: Buffer.from(await updateBuffer(audio, { title, artist, album: release, ...(albumartist && { albumartist }) })) });
  const files = await Promise.all([
    fixture('Opening number', 'First performer', album, `Various Artists / ${guest}`),
    fixture('Encore number', 'Second performer', album, `Various Artists / ${guest}`),
    fixture('Guest original', guest, 'Solo Works', guest),
    fixture('Miscellaneous', 'Third performer', 'Uncredited Album'),
  ]);
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      settings: { demos: false, artistRules: { separators: ['/'] } },
    }));
  });
  const content = page.locator('#content');
  const albums = page.locator('#sidebar [data-nav=albums]');
  const heading = name => content.getByRole('heading', { name, exact: true });
  const titles = content.locator('tbody .track-name');
  const albumCard = (selector, name) => content.locator(selector).filter({ has: page.getByText(name, { exact: true }) });
  const currentAudio = page.locator('#audio');

  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles(files);
  await expect(titles).toHaveCount(4);
  await albums.press('Enter');
  await albumCard('[data-action=group]', 'Uncredited Album').press('Enter');
  await expect(content.getByText('1 首歌曲 · 未知专辑艺人')).toBeVisible();
  await expect(content.locator('.album-artist-link')).toHaveCount(0);

  await albums.press('Enter');
  await albumCard('[data-action=group]', album).press('Enter');
  await content.getByRole('button', { name: /^Opening number/ }).press('Enter');
  await expect.poll(() => currentAudio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  const compilationCredit = content.getByRole('link', { name: 'Various Artists', exact: true });
  const guestCredit = content.getByRole('link', { name: guest, exact: true });
  await expect(guestCredit).toHaveAttribute('href', '#' + encodeURIComponent('artist/' + guest));
  await compilationCredit.press('Enter');
  await expect(heading('Various Artists')).toBeVisible();
  await expect(content).toBeFocused();
  await expect(titles).toHaveCount(0);
  await expect(content.getByText('这里还没有歌曲')).toHaveCount(0);
  await albumCard('[data-action=artist-album]', album).press('Enter');
  await expect(heading(album)).toBeVisible();
  await guestCredit.press('Enter');
  await expect(heading(guest)).toBeVisible();
  await expect(titles).toHaveText(['Guest original']);
  await expect(albumCard('[data-action=artist-album]', 'Solo Works')).toBeVisible();
  await expect(albumCard('[data-action=artist-album]', album)).toBeVisible();
  await expect(page.locator('#player-title')).toHaveText('Opening number');
  expect(await currentAudio.evaluate(element => !element.paused && element.currentTime > 0.1)).toBe(true);

  await page.reload();
  await expect(heading(guest)).toBeVisible();
  await albumCard('[data-action=artist-album]', album).press('Enter');
  await expect.poll(async () => (await titles.allTextContents()).sort()).toEqual(['Encore number', 'Opening number']);
});
