import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

const titles = page => page.locator('#content tbody .track-name');
const sort = page => page.getByRole('combobox', { name: '排序', exact: true });

test('orders actual locally imported filenames apart from their audio tags', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-folder-order-'));
  try {
    const folder = join(directory, 'Numbered Local');
    const branches = ['Volume 10', 'Volume 2'];
    await Promise.all(branches.map(name => mkdir(join(folder, name), { recursive: true })));
    const original = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    const tags = (title) => updateBuffer(original, { title, artist: 'Folder fixture' });
    await Promise.all([
      writeFile(join(folder, '10-morning.m4a'), await tags('Alpha title')),
      writeFile(join(folder, '2-evening.m4a'), await tags('Zulu title')),
      ...branches.map(name => writeFile(join(folder, name, 'subfolder-track.m4a'), original)),
    ]);
    await page.goto('/#songs');
    await page.locator('#import-folder').setInputFiles(directory);
    await expect(titles(page).filter({ hasText: 'Zulu title' })).toBeVisible();
    await page.locator('#search').fill('Numbered Local');
    const matches = page.getByRole('region', { name: '文件夹' });
    await matches.getByRole('button', { name: /^Numbered Local 本地导入/ }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Numbered Local' })).toBeVisible();

    const folders = page.locator('#content .folder-list strong');
    await sort(page).selectOption('file-name');
    await expect(titles(page)).toHaveText(['Zulu title', 'Alpha title']);
    await expect(folders).toHaveText(['Volume 2', 'Volume 10']);
    await sort(page).selectOption('file-name-desc');
    await expect(titles(page)).toHaveText(['Alpha title', 'Zulu title']);
    await expect(folders).toHaveText(['Volume 10', 'Volume 2']);
    await page.reload();
    await expect(sort(page)).toHaveValue('file-name-desc');
    await expect(titles(page)).toHaveText(['Alpha title', 'Zulu title']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uses provider filenames for cloud folders without changing tagged title sorting or the playback order shown', async ({ page }) => {
  const fixtures = [
    { id: '10', folder: false, path: 'opaque-a', name: 'take 10.m4a', title: 'Alpha track', streamUrl: '/api/baidu/stream?id=10' },
    { id: '2', folder: false, path: 'opaque-z', name: 'take 2.m4a', title: 'Zulu track', streamUrl: '/api/baidu/stream?id=2' },
  ];
  const clip = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => route.fulfill({ json: { items: fixtures } }));
  await page.route('**/api/baidu/stream?**', route => route.fulfill({ contentType: 'audio/mp4', body: clip }));
  await page.goto('/#sources');
  await page.locator('[data-action="baidu-source"]').press('Enter');
  await sort(page).selectOption('title');
  await expect(titles(page)).toHaveText(['Alpha track', 'Zulu track']);
  await sort(page).selectOption('file-name');
  await expect(titles(page)).toHaveText(['Zulu track', 'Alpha track']);
  await page.getByRole('button', { name: '播放此目录' }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText('Zulu track');
  await expect(page.locator('#now .queue-row .track-name')).toHaveText(['Zulu track', 'Alpha track']);

  await sort(page).selectOption('file-name-desc');
  await expect(titles(page)).toHaveText(['Alpha track', 'Zulu track']);
  await page.reload();
  await expect(sort(page)).toHaveValue('file-name-desc');
  await expect(titles(page)).toHaveText(['Alpha track', 'Zulu track']);
});
