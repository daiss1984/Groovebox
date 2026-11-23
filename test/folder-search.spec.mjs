import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nav = (page, name) => page.locator('#sidebar [data-nav=' + name + ']');
const action = (page, name) => page.locator('#content [data-action=' + name + ']');
const search = page => page.locator('#search');
const matches = page => page.getByRole('region', { name: '文件夹', exact: true });
const title = page => page.locator('#content h1');
const tracks = page => page.locator('#content tbody .track-name');

test('global search opens imported local folders and retains their breadcrumb navigation after refresh', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-folder-search-'));
  try {
    const parent = join(directory, 'Collections');
    const acoustic = join(parent, 'Acoustic Set');
    const sibling = join(parent, 'Live Set');
    await Promise.all([mkdir(acoustic, { recursive: true }), mkdir(sibling, { recursive: true })]);
    const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    await Promise.all([writeFile(join(acoustic, 'Studio fixture.m4a'), audio), writeFile(join(sibling, 'Stage fixture.m4a'), audio)]);

    await page.goto('/#songs');
    await page.locator('#import-folder').setInputFiles(directory);
    await expect(page.locator('#content').getByText('Studio fixture', { exact: true })).toBeVisible();
    await expect(page.locator('#content').getByText('Stage fixture', { exact: true })).toBeVisible();
    await search(page).fill('collections/acousTIC');
    const local = matches(page).getByRole('button', { name: /Acoustic Set.*本地导入.*Collections/ });
    await expect(local).toBeVisible();
    await expect(matches(page).getByRole('button', { name: /Live Set/ })).toHaveCount(0);
    await local.press('Enter');
    await expect(title(page)).toHaveText('Acoustic Set');
    await expect(tracks(page)).toHaveText(['Studio fixture']);
    await page.reload();
    await expect(tracks(page)).toHaveText(['Studio fixture']);
    await page.locator('#content .breadcrumbs').getByRole('button', { name: 'Collections', exact: true }).press('Enter');
    await expect(title(page)).toHaveText('Collections');
    await page.locator('#content .folder-list').getByRole('button', { name: 'Live Set', exact: true }).press('Enter');
    await expect(tracks(page)).toHaveText(['Stage fixture']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('global search lists matching folders before genre groups and opens the selected genre', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      settings: {
        demos: false, onlineCover: false, genreRules: { separators: ['/'], exceptions: [] },
        hiddenLibrarySources: [{ id: 'gdrive', name: 'Google Drive' }],
      },
      tracks: [
        { id: 'baidu:1', provider: 'baidu', src: '/api/baidu/stream?id=1', title: 'Blue Fire', genres: ['Café/Jazz'] },
        { id: 'baidu:2', provider: 'baidu', src: '/api/baidu/stream?id=2', title: 'Grey Dawn', genres: ['CAFÉ'] },
        { id: 'gdrive:3', provider: 'gdrive', src: '/api/gdrive/stream?id=3', title: 'Hidden Track', genres: ['Café Rare'] },
      ],
    }));
  });
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-genre-search-'));
  try {
    const folder = join(directory, 'Café Collection');
    await mkdir(folder);
    await writeFile(join(folder, 'Local fixture.m4a'), await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url)));
    await page.goto('/#songs');
    await page.locator('#import-folder').setInputFiles(directory);
    await expect(tracks(page)).toContainText(['Local fixture']);

    await search(page).fill('cafe\u0301');
    await expect(page.locator('#folder-search-heading, #genre-search-heading')).toHaveText(['文件夹', '风格']);
    await expect(matches(page).getByRole('button', { name: /Café Collection/ })).toBeVisible();
    const genres = page.getByRole('region', { name: '风格', exact: true });
    await expect(genres.getByRole('button')).toHaveText(['Café · 2 首歌曲']);
    await expect(tracks(page)).toContainText(['Blue Fire', 'Grey Dawn']);
    await genres.getByRole('button', { name: 'Café · 2 首歌曲', exact: true }).press('Enter');
    await expect(title(page)).toHaveText('Café');
    await expect(tracks(page)).toHaveText(['Blue Fire', 'Grey Dawn']);

    await search(page).fill('Café Rare');
    await expect(genres).toHaveCount(0);
    await expect(page.getByText('没有找到匹配的音乐')).toBeVisible();
    await search(page).fill('未分类');
    await expect(genres.getByRole('button', { name: '未分类 · 1 首歌曲', exact: true })).toBeVisible();
    await expect(page.getByText('没有找到匹配的音乐')).toHaveCount(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('global search uses the stored cloud folder index, opens the target, and removes deleted folder matches', async ({ page }) => {
  const calls = [];
  let removed = false;
  const folder = (path, name) => ({ id: path, path, name, folder: true });
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?*', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    calls.push(path);
    let items = [];
    if (path === '/') items = [folder('opaque-parent', 'Shared Library')];
    if (path === 'opaque-parent' && !removed) items = [folder('opaque-child', 'Ocean Recordings'), folder('opaque-empty', 'Ocean Empty')];
    if (path === 'opaque-child') items = [{ id: '21', name: 'Cloud fixture.wav', path: '/fixture.wav', streamUrl: '/api/baidu/stream?id=21' }];
    return route.fulfill({ json: { items } });
  });
  await page.goto('/#sources');
  await action(page, 'baidu-source').press('Enter');
  await action(page, 'scan-cloud').press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '扫描完成' })).toBeVisible();
  await nav(page, 'songs').press('Enter');
  await page.reload();
  const scanned = calls.slice();
  await search(page).fill('ocean');
  await expect(matches(page).getByRole('button')).toHaveCount(2);
  await search(page).fill('shared library/OCEAN REC');
  const result = matches(page).getByRole('button', { name: /Ocean Recordings.*百度网盘.*Shared Library/ });
  await expect(result).toBeVisible();
  await expect(tracks(page)).toHaveCount(0);
  await expect(page.getByText('没有找到匹配的音乐')).toHaveCount(0);
  expect(calls).toEqual(scanned);

  await result.press('Enter');
  await expect(tracks(page)).toHaveText(['Cloud fixture']);
  expect(calls).toEqual([...scanned, 'opaque-child']);
  const breadcrumbs = page.locator('#content .breadcrumbs');
  await expect(breadcrumbs.getByRole('button', { name: 'Ocean Recordings', exact: true })).toBeVisible();
  await breadcrumbs.getByRole('button', { name: 'Shared Library', exact: true }).press('Enter');
  await expect(action(page, 'open-folder')).toHaveCount(2);
  removed = true;
  await action(page, 'scan-cloud').press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '扫描完成' })).toBeVisible();
  await search(page).fill('ocean');
  await expect(matches(page)).toHaveCount(0);
  await expect(page.getByText('没有找到匹配的音乐')).toBeVisible();
});

test('opening a cached opaque media folder restores expired ancestor mappings on demand', async ({ page }) => {
  const source = { id: 'fixture-media', type: 'webdav', name: 'Fixture Media' };
  const branch = { id: 'folder-a', path: 'folder-a', name: 'Remote Archive', folder: true };
  const leaf = { id: 'folder-b', path: 'folder-b', name: 'Deep Room', folder: true };
  const track = { id: 'song-a', name: 'Recovered recording.m4a', streamUrl: '/api/sources/fixture-media/stream?id=song-a' };
  const listings = new Map([['/', [branch]], [branch.path, [leaf]], [leaf.path, [track]]]);
  const known = new Set(['/']);
  const calls = [];
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [source] } }));
  await page.route('**/api/sources/fixture-media/list?*', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    calls.push(path);
    if (!known.has(path)) return route.fulfill({ status: 404, json: { error: '找不到该文件夹' } });
    const items = listings.get(path);
    for (const item of items) if (item.folder) known.add(item.path);
    return route.fulfill({ json: { items } });
  });

  await page.goto('/#sources');
  await action(page, 'open-cloud').press('Enter');
  await action(page, 'scan-cloud').press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '扫描完成' })).toBeVisible();
  await nav(page, 'songs').press('Enter');
  await page.reload({ waitUntil: 'domcontentloaded' });
  known.clear();
  known.add('/');
  calls.length = 0;
  await search(page).fill('deep room');
  const result = matches(page).getByRole('button', { name: /Deep Room.*Fixture Media.*Remote Archive/ });
  await expect(result).toBeVisible();
  expect(calls).toEqual([]);
  await result.press('Enter');
  await expect(tracks(page)).toHaveText(['Recovered recording']);
  expect(calls).toEqual([leaf.path, '/', branch.path, leaf.path]);
});
