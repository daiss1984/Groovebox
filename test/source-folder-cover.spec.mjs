import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const sourceId = '59c8866f-8044-4136-88e8-eb917e393598';
const sourceApi = '/api/sources/' + sourceId;
const artistId = 'artist-fixture';
const albumId = 'album-fixture';
const artistCover = sourceApi + '/cover?id=' + artistId;
const albumCover = sourceApi + '/cover?id=' + albumId;

async function assertCover(folder, src) {
  const image = folder.locator('img');
  await expect(image).toHaveAttribute('src', src);
  await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
}

async function assertFolderIcon(folder) {
  await expect(folder).toBeVisible();
  await expect(folder.locator('img')).toHaveCount(0);
  await expect(folder.locator('svg use[href="/icons.svg#folder"]')).toHaveCount(1);
}

for (const [type, label] of [['opensubsonic', 'OpenSubsonic'], ['fnmusic', '飞牛音乐']]) {
  test('browses ' + label + ' artist and album artwork with a folder-icon fallback', async ({ page }) => {
    const sourceName = label + '测试媒体库';
    const image = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
    const directories = {
      '/': [
        { id: artistId, name: '有封面的艺人', cover: artistCover },
        { id: 'artist-without-cover', name: '没有封面的艺人' },
        { id: 'stale-cover', name: '封面已失效的艺人', cover: sourceApi + '/cover?id=stale-cover' },
        { id: 'artist-external-cover', name: '封面地址无效的艺人', cover: 'https://example.invalid/image.jpg' },
      ],
      [artistId]: [
        { id: albumId, name: '有封面的专辑', cover: albumCover },
        { id: 'album-without-cover', name: '没有封面的专辑' },
      ],
      [albumId]: [],
    };
    const listRequests = [];
    const coverRequests = new Set();
    const externalRequests = [];
    await page.route('https://example.invalid/**', route => {
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.route('**/api/sources', route => route.fulfill({
      json: { sources: [{ id: sourceId, name: sourceName, type }] },
    }));
    await page.route('**' + sourceApi + '/list?**', route => {
      const path = new URL(route.request().url()).searchParams.get('path');
      listRequests.push(path);
      expect(directories).toHaveProperty(path);
      return route.fulfill({ json: { items: directories[path].map(item => ({
        folder: true, path: item.id, size: 0, ...item,
      })) } });
    });
    await page.route('**' + sourceApi + '/cover?**', route => {
      const id = new URL(route.request().url()).searchParams.get('id');
      coverRequests.add(id);
      if (id === 'stale-cover') return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: 'image/jpeg', body: image });
    });

    await page.goto('/#sources');
    await page.getByRole('button', { name: new RegExp(sourceName) }).press('Enter');
    const folders = page.locator('.folder-list');
    const artist = folders.getByRole('button', { name: '有封面的艺人', exact: true });
    await assertCover(artist, artistCover);
    await assertFolderIcon(folders.getByRole('button', { name: '没有封面的艺人', exact: true }));
    await assertFolderIcon(folders.getByRole('button', { name: '封面已失效的艺人', exact: true }));
    await assertFolderIcon(folders.getByRole('button', { name: '封面地址无效的艺人', exact: true }));
    await artist.press('Enter');

    const album = folders.getByRole('button', { name: '有封面的专辑', exact: true });
    await assertCover(album, albumCover);
    await assertFolderIcon(folders.getByRole('button', { name: '没有封面的专辑', exact: true }));
    await album.press('Enter');
    await expect(page.locator('.breadcrumbs').getByRole('button', { name: '有封面的专辑', exact: true })).toBeVisible();
    await expect(page.getByText('当前目录没有音频文件')).toBeVisible();
    expect(listRequests).toEqual(['/', artistId, albumId]);
    expect([...coverRequests].sort()).toEqual([artistId, albumId, 'stale-cover'].sort());
    expect(externalRequests).toEqual([]);
  });
}
