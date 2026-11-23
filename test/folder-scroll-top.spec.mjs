import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const returnToTop = page => page.getByRole('button', { name: '回到顶部', exact: true });
const workspace = page => page.locator('.workspace');
const scrollPosition = page => workspace(page).evaluate(element => element.scrollTop);

async function scrollWorkspace(page) {
  await workspace(page).evaluate(element => { element.scrollTop = 650; });
  await expect.poll(() => scrollPosition(page)).toBeGreaterThan(0);
}

function shortWave() {
  const audio = Buffer.alloc(44 + 1600);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(1600, 40);
  return audio;
}

test('returns to the top of a locally imported folder without interrupting playback', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-folder-scroll-'));
  const folder = join(directory, 'Long Folder Fixture');
  try {
    await mkdir(folder);
    const wave = shortWave();
    const recording = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    await Promise.all([
      writeFile(join(folder, 'Playing Fixture.m4a'), recording),
      ...Array.from({ length: 38 }, (_, index) => writeFile(join(folder, `Song ${index}.wav`), wave)),
    ]);

    await page.goto('/#home');
    await expect(returnToTop(page)).toHaveCount(0);
    await page.goto('/#songs');
    await page.locator('#import-folder').setInputFiles(directory);
    const search = page.getByRole('searchbox', { name: '搜索', exact: true });
    await expect(page.locator('#content .track-name').filter({ hasText: 'Playing Fixture' })).toBeVisible();
    await search.fill('Long Folder Fixture');
    await page.locator('#content .folder-row').filter({ hasText: 'Long Folder Fixture' }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Long Folder Fixture', exact: true })).toBeVisible();
    await expect(page.locator('#content tbody tr')).toHaveCount(39);
    await page.locator('#content').getByRole('button', { name: /Playing Fixture/ }).press('Enter');
    const top = returnToTop(page);
    const url = page.url();
    const audio = page.locator('#audio');
    await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
    await scrollWorkspace(page);
    await search.dispatchEvent('click');
    expect(await scrollPosition(page)).toBeGreaterThan(0);
    await top.press('Enter');
    await expect.poll(() => scrollPosition(page)).toBe(0);
    await expect(top).toBeFocused();
    await expect(page).toHaveURL(url);
    expect(await audio.evaluate(element => !element.paused)).toBe(true);

    await scrollWorkspace(page);
    await page.locator('.topbar').dispatchEvent('click', { detail: 1 });
    await expect.poll(() => scrollPosition(page)).toBe(0);
    await expect(page.getByRole('heading', { name: 'Long Folder Fixture', exact: true })).toBeVisible();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('taps the mobile folder toolbar to return to the top without rereading the server @mobile', async ({ page }) => {
  const path = '/subfolder';
  const requests = [];
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => {
    const current = new URL(route.request().url()).searchParams.get('path');
    requests.push(current);
    const items = current === '/' ? [{ id: 'subfolder', path, name: 'Mobile Music Folder', folder: true }] :
      Array.from({ length: 48 }, (_, id) => ({ id: String(id), path: `${path}/${id}`, name: `Folder ${id}`, folder: true }));
    return route.fulfill({ json: { items } });
  });
  await page.goto('/#source%2Fbaidu');
  await page.getByRole('button', { name: 'Mobile Music Folder', exact: true }).press('Enter');
  await expect(page.locator('#content .folder-row')).toHaveCount(48);
  expect(requests).toEqual(['/', path]);
  await scrollWorkspace(page);
  const bar = await page.locator('.topbar').boundingBox();
  await page.touchscreen.tap(bar.x + 8, bar.y + 4);
  await expect.poll(() => scrollPosition(page)).toBe(0);
  expect(requests).toEqual(['/', path]);

  await scrollWorkspace(page);
  await returnToTop(page).tap();
  await expect.poll(() => scrollPosition(page)).toBe(0);
  expect(requests).toEqual(['/', path]);
});

async function seedCatalog(page) {
  await page.addInitScript(() => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    const tracks = Array.from({ length: 32 }, (_, index) => ({
      id: 'baidu:catalog-' + index, provider: 'baidu', title: 'Track ' + index,
      artist: 'Artist ' + index, album: 'Album ' + index, genres: ['Genre ' + index],
      albumIsFallback: false, src: '/api/baidu/stream?id=' + index,
    }));
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      tracks, settings: { demos: false, onlineCover: false },
      playlists: [{ id: 'catalog', name: 'Catalog Playlist', tracks: tracks.map(track => track.id) }],
    }));
  });
}

test('returns to the top of a playlist repeatedly without replacing its current selection', async ({ page }) => {
  await seedCatalog(page);
  await page.goto('/#playlist%2Fcatalog');
  await page.getByRole('button', { name: '多选', exact: true }).press('Enter');
  const selected = page.getByRole('checkbox', { name: '选择 Track 0', exact: true });
  await selected.press('Space');
  await expect(selected).toBeChecked();
  const top = returnToTop(page);
  const url = page.url();
  for (let attempt = 0; attempt < 2; attempt++) {
    await scrollWorkspace(page);
    await expect(top).toBeInViewport();
    await top.press('Enter');
    await expect.poll(() => scrollPosition(page)).toBe(0);
    await expect(top).toBeFocused();
    await expect(selected).toBeChecked();
    await expect(page).toHaveURL(url);
  }
});

test('taps Back to Top on the catalog without opening the navigation drawer @mobile', async ({ page }) => {
  await seedCatalog(page);
  for (const [route, title] of [['songs', '全部歌曲'], ['albums', '专辑'], ['artists', '艺人'], ['genres', '分类']]) {
    await page.goto('/#' + route, { waitUntil: 'domcontentloaded' });
    const heading = page.getByRole('heading', { name: title, exact: true });
    await expect(heading).toBeInViewport();
    await scrollWorkspace(page);
    await expect(heading).not.toBeInViewport();
    await expect(page.locator('#sidebar')).toBeHidden();
    await returnToTop(page).tap();
    await expect.poll(() => scrollPosition(page)).toBe(0);
    await expect(heading).toBeInViewport();
    await expect(page).toHaveURL(new RegExp('#' + route + '$'));
  }
});
