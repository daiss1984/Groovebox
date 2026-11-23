import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const artist = 'Grid Fixture';
const duoAlbum = 'Shared Release';
const nav = (page, section) => page.locator('#sidebar [data-nav=' + section + ']');
const catalogControl = page => page.getByRole('combobox', { name: '专辑网格列数', exact: true });
const artistControl = page => page.getByRole('combobox', { name: '艺人专辑网格列数', exact: true });
const columns = grid => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length);

test('controls catalog and artist album grids independently and opens the full credited album', async ({ page }) => {
  await page.addInitScript(({ artist, duoAlbum }) => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    const tracks = [
      ['First contribution', artist, duoAlbum, 'Album Collective'],
      ['Other contribution', 'Other Artist', duoAlbum, 'Album Collective'],
      ['Unrelated version', 'Different Artist', duoAlbum, 'Other Collective'],
      ['Second recording', artist, 'Studio Release', artist],
      ['Third recording', artist, 'Live Release', artist],
    ].map(([title, artist, album, albumArtist], index) => ({ title, artist, album, albumArtist,
      id: 'baidu:grid-' + index, provider: 'baidu', albumIsFallback: false, src: '/api/baidu/stream?id=' + index }));
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { demos: false }, tracks,
      favorites: tracks.map(track => track.id) }));
  }, { artist, duoAlbum });
  await page.goto('/#albums');
  const catalog = page.locator('#content > .card-grid');
  await expect(catalogControl(page)).toHaveValue('auto');
  await catalogControl(page).selectOption('3');
  await expect.poll(() => columns(catalog)).toBe(3);

  const artistDetail = '/#' + encodeURIComponent('artist/' + artist);
  await nav(page, 'artists').press('Enter');
  await page.locator('#content [data-action=group][data-id="Grid Fixture"]').press('Enter');
  const albumSection = page.getByRole('region', { name: '专辑', exact: true });
  const artistGrid = albumSection.locator('.card-grid');
  await expect(artistGrid.locator('strong')).toHaveText(['Live Release', 'Shared Release', 'Studio Release']);
  await expect(artistControl(page)).toHaveValue('auto');
  await artistControl(page).selectOption('1');
  await expect.poll(() => columns(artistGrid)).toBe(1);
  await expect(artistControl(page)).toBeFocused();
  await albumSection.getByRole('button', { name: /Shared Release.*2 首歌曲.*Album Collective/ }).press('Enter');
  await expect(page.locator('#content tbody .track-name')).toHaveText(['First contribution', 'Other contribution']);
  await page.goBack();
  await expect(artistControl(page)).toHaveValue('1');
  await page.reload();
  await expect(artistControl(page)).toHaveValue('1');
  await nav(page, 'albums').press('Enter');
  await expect(catalogControl(page)).toHaveValue('3');

  await nav(page, 'settings').press('Enter');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份' }).press('Enter');
  const backup = await readFile(await (await download).path());
  expect(JSON.parse(backup).settings.albumGridColumns).toEqual({ catalog: '3', artist: '1' });
  await nav(page, 'albums').press('Enter');
  await catalogControl(page).selectOption('auto');
  await page.goto(artistDetail);
  await artistControl(page).selectOption('auto');
  await nav(page, 'settings').press('Enter');
  await page.locator('#restore-file').setInputFiles({ name: 'album-grid.json', mimeType: 'application/json', buffer: backup });
  await expect(page.getByRole('status').filter({ hasText: '备份已恢复' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#albums');
  await expect(catalogControl(page)).toHaveValue('3');
  await expect.poll(() => columns(catalog)).toBe(3);
  await page.goto(artistDetail);
  await expect(artistControl(page)).toHaveValue('1');
  await expect.poll(() => columns(artistGrid)).toBe(1);
  await expect(artistGrid).toBeVisible();
});
