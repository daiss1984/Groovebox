import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nav = (page, route) => page.locator('#sidebar [data-nav="' + route + '"]');
const content = page => page.locator('#content');
const sourceCard = (page, name) => content(page).locator('.source-card-group[aria-label="' + name + '"]');
const titles = page => content(page).locator('tbody .track-name');

test('hides local files from discovery but keeps them playable in downloads and reuses folder metadata', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'groovebox-hidden-local-'));
  const collection = join(root, 'Private Sessions');
  try {
    await mkdir(collection);
    const fixture = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    await writeFile(join(collection, 'Local Artist - Morning Recording.m4a'), fixture);
    await page.goto('/#songs');
    await page.locator('#import-folder').setInputFiles(root);
    await expect(titles(page)).toContainText(['Morning Recording']);
    const term = page.locator('#search');
    await term.fill('Private Sessions');
    await expect(content(page).getByRole('button', { name: /Private Sessions.*本地导入/ })).toBeVisible();

    await nav(page, 'sources').press('Enter');
    const card = sourceCard(page, '本地文件');
    await card.getByRole('button', { name: '从曲库隐藏' }).press('Enter');
    await expect(card.getByRole('button', { name: '在曲库显示' })).toBeFocused();
    await page.reload();
    await expect(card.getByRole('button', { name: '在曲库显示' })).toBeVisible();
    await nav(page, 'songs').press('Enter');
    await expect(titles(page)).not.toContainText(['Morning Recording']);
    await nav(page, 'artists').press('Enter');
    await expect(content(page).getByRole('button', { name: /Local Artist/ })).toHaveCount(0);
    await term.fill('Private Sessions');
    await expect(content(page).getByText('没有找到匹配的音乐')).toBeVisible();

    await nav(page, 'offline').press('Enter');
    await content(page).getByRole('button', { name: 'Morning Recording Local Artist' }).press('Enter');
    await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);

    await nav(page, 'sources').press('Enter');
    await card.getByRole('button', { name: '在曲库显示' }).press('Enter');
    await term.fill('Private Sessions');
    await expect(content(page).getByRole('button', { name: /Private Sessions.*本地导入/ })).toBeVisible();
    await nav(page, 'songs').press('Enter');
    await expect(titles(page)).toContainText(['Morning Recording']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves hidden-source settings and lets a disconnected saved library be shown', async ({ page }) => {
  const source = { id: 'fixture-dav', type: 'webdav', name: 'Saved Archive' };
  let connected = true;
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: connected ? [source] : [] } }));
  await page.addInitScript(({ id }) => {
    const storage = 'groovebox.state.v1';
    if (localStorage.getItem(storage)) return;
    localStorage.setItem(storage, JSON.stringify({
      settings: { demos: false },
      tracks: [{
        id: id + ':cloud-audio', provider: 'webdav', title: 'Archive Recording', artist: 'Archive Artist',
        src: '/api/sources/' + id + '/stream?id=audio',
      }],
      playlists: [{ id: 'manual-list', name: 'Saved Playlist', tracks: [id + ':cloud-audio'] }],
    }));
  }, source);

  await page.goto('/#sources');
  const card = sourceCard(page, source.name);
  await card.getByRole('button', { name: '从曲库隐藏' }).press('Enter');
  await nav(page, 'songs').press('Enter');
  await expect(titles(page)).toHaveCount(0);
  await nav(page, 'playlist/manual-list').press('Enter');
  await expect(titles(page)).toHaveText(['Archive Recording']);

  await nav(page, 'settings').press('Enter');
  const exportReady = page.waitForEvent('download');
  await content(page).getByRole('button', { name: '导出备份' }).press('Enter');
  const backup = await readFile(await (await exportReady).path());
  expect(JSON.parse(backup).settings.hiddenLibrarySources).toEqual([{ id: source.id, name: source.name }]);

  connected = false;
  await nav(page, 'sources').press('Enter');
  await page.reload();
  await expect(card.getByText('曲目已从曲库隐藏')).toBeVisible();
  await card.getByRole('button', { name: '在曲库显示' }).press('Enter');
  await nav(page, 'songs').press('Enter');
  await expect(titles(page)).toHaveText(['Archive Recording']);

  await page.locator('#restore-file').setInputFiles({ name: 'visibility.json', mimeType: 'application/json', buffer: backup });
  await expect(titles(page)).toHaveCount(0);
  await nav(page, 'sources').press('Enter');
  await expect(card.getByRole('button', { name: '在曲库显示' })).toBeVisible();
});

test('keeps an authorized Baidu source browsable while hiding its indexed tracks', async ({ page }) => {
  let lists = 0;
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => {
    lists++;
    const path = new URL(route.request().url()).searchParams.get('path');
    const items = path === '/' ? [{ id: '451', name: 'Baidu Indie', path: '/Baidu Indie', folder: true }] : [{
      id: '452', title: 'Baidu example', name: 'example.m4a', path: '/Baidu Indie/example.m4a',
      streamUrl: '/api/baidu/stream?id=452', artist: 'Baidu Artist', genres: ['Indie'],
    }];
    return route.fulfill({ json: { items } });
  });

  await page.goto('/#sources');
  const card = sourceCard(page, '百度网盘');
  const browse = card.locator('[data-action="baidu-source"]');
  await browse.press('Enter');
  await content(page).getByRole('button', { name: '扫描并加入曲库' }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '扫描完成' })).toBeVisible();
  const initial = lists;
  await nav(page, 'sources').press('Enter');
  await card.getByRole('button', { name: '从曲库隐藏' }).press('Enter');
  await expect(browse).toContainText('已连接');
  await nav(page, 'genres').press('Enter');
  await expect(content(page).getByRole('button', { name: /Indie/ })).toHaveCount(0);
  const search = page.locator('#search');
  await search.fill('Baidu');
  await expect(content(page).getByText('没有找到匹配的音乐')).toBeVisible();
  await nav(page, 'sources').press('Enter');
  await card.getByRole('button', { name: '在曲库显示' }).press('Enter');
  await search.fill('Baidu');
  await expect(content(page).getByRole('button', { name: /Baidu Indie.*百度网盘/ })).toBeVisible();
  await expect(titles(page)).toHaveText(['Baidu example']);
  expect(lists).toBe(initial);
});

test('keeps a source page open when a local import finishes after navigating away', async ({ page }) => {
  await page.goto('/#songs');
  await expect(content(page).getByRole('heading', { name: '全部歌曲' })).toBeVisible();
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const requested = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route('**/metadata.bundle.js', async route => {
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  await page.locator('#import-files').setInputFiles({
    name: 'Slow local.m4a', mimeType: 'audio/mp4', buffer: audio,
  });
  await requested.promise;
  await nav(page, 'sources').press('Enter');
  await expect(content(page).getByRole('heading', { name: '音乐来源' })).toBeVisible();
  release.resolve();
  await expect(page.getByRole('status').filter({ hasText: '已导入或更新 1 首本地歌曲' })).toBeVisible();
  await expect(content(page).getByRole('heading', { name: '音乐来源' })).toBeVisible();
  await expect(page).toHaveURL(/#sources$/);
});
