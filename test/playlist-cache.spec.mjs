import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const playlistName = '提前缓存测试歌单';
const tracks = ['离线序曲', '追加乐章', '停止后添加'];
const trackRow = (page, title) => page.locator('#content tbody tr').filter({
  has: page.getByRole('button', { name: title + ' 缓存样本' }),
});
const playlistNav = page => page.locator('#playlist-nav').getByRole('button', { name: playlistName });

async function openBaidu(page) {
  await page.locator('#sidebar [data-nav="sources"]').press('Enter');
  await page.locator('#content [data-action="baidu-source"]').press('Enter');
  await expect(page.getByRole('heading', { name: '百度网盘', exact: true })).toBeVisible();
}

async function addToPlaylist(page, track, create = false) {
  await trackRow(page, track).getByRole('button', { name: '歌曲选项' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '添加到歌单' }).click();
  if (create) {
    await dialog.getByRole('button', { name: '新建歌单' }).click();
    await dialog.getByRole('textbox').fill(playlistName);
    await dialog.getByRole('button', { name: '创建' }).click();
  } else {
    await dialog.getByRole('button', { name: playlistName }).click();
  }
}

async function offlineTrackIds(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('groovebox.offline');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('audio', 'readonly');
      const keys = transaction.objectStore('audio').getAllKeys();
      keys.onsuccess = () => resolve(keys.result);
      keys.onerror = () => reject(keys.error);
      transaction.oncomplete = () => database.close();
    };
  }));
}

async function mockBaidu(page, reachable, stream, folderCover) {
  await page.route('**/api/baidu/status', route => route.fulfill({
    json: { configured: true, connected: reachable() },
  }));
  await page.route('**/api/baidu/list?**', route => reachable() ? route.fulfill({ json: {
    items: tracks.map((title, index) => ({
      id: String(index + 1),
      name: '缓存样本 - ' + title + '.m4a',
      path: '/' + title + '.m4a',
      folder: false,
      streamUrl: '/api/baidu/stream?id=' + (index + 1),
      folderCover,
    })),
  } }) : route.abort('internetdisconnected'));
  await page.route('**/api/baidu/stream?**', route =>
    stream(route, new URL(route.request().url()).searchParams.get('id')));
}

test('pre-caches playlist tracks in the background and plays saved songs after the cloud goes offline', async ({ page }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const art = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
  const folderCover = '/api/baidu/cover?ids=30&folder=' + 'f'.repeat(22) + '&v=' + 'v'.repeat(22) + '&proof=' + 'p'.repeat(43);
  const requests = [];
  let sourceReachable = true;
  let releaseFirstFetch;
  const firstFetch = new Promise(resolve => { releaseFirstFetch = resolve; });

  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (record, ...options) {
      if (this.name === 'folder-covers' && record.id === 'baidu:1') throw new DOMException('Fixture cover quota', 'QuotaExceededError');
      return put.call(this, record, ...options);
    };
  });
  await page.route('**' + folderCover, route => sourceReachable ? route.fulfill({ contentType: 'image/jpeg', body: art }) :
    route.abort('internetdisconnected'));
  await mockBaidu(page, () => sourceReachable, async (route, id) => {
    requests.push(id);
    if (!sourceReachable) return route.abort('internetdisconnected');
    if (id === '1') await firstFetch;
    return route.fulfill({ contentType: 'audio/mp4', body: audio });
  }, folderCover);

  await page.goto('/');
  await openBaidu(page);
  await addToPlaylist(page, tracks[0], true);
  await expect(page.getByRole('heading', { name: playlistName })).toBeVisible();
  expect(requests).toEqual([]);

  try {
    await page.getByRole('button', { name: '提前缓存歌单' }).click();
    await expect.poll(() => requests).toEqual(['1']);
    await expect(page.getByText('已缓存 0 / 1 首', { exact: false })).toBeVisible();
    await page.locator('#sidebar [data-nav="offline"]').click();
    await expect(page.getByRole('heading', { name: '已下载音乐' })).toBeVisible();
    releaseFirstFetch();
    await expect(trackRow(page, tracks[0])).toBeVisible();
  } finally {
    releaseFirstFetch();
  }

  await playlistNav(page).click();
  await expect(page.getByText('已缓存 1 / 1 首', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '停止自动缓存' })).toBeVisible();
  await expect(page.getByText('已缓存 1 / 1 首', { exact: false })).toBeVisible();

  await openBaidu(page);
  await addToPlaylist(page, tracks[1]);
  await playlistNav(page).click();
  await expect(page.getByText('已缓存 2 / 2 首', { exact: false })).toBeVisible();
  expect(requests).toEqual(['1', '2']);

  await page.getByRole('button', { name: '停止自动缓存' }).click();
  await expect(page.getByRole('button', { name: '提前缓存歌单' })).toBeVisible();
  await openBaidu(page);
  await addToPlaylist(page, tracks[2]);
  await playlistNav(page).click();
  await expect(trackRow(page, tracks[2])).toBeVisible();
  expect(await offlineTrackIds(page)).toEqual(['baidu:1', 'baidu:2']);
  expect(requests).toEqual(['1', '2']);

  sourceReachable = false;
  await page.reload();
  await expect(page.getByRole('button', { name: '提前缓存歌单' })).toBeVisible();
  await page.locator('#sidebar [data-nav="offline"]').click();
  await expect(trackRow(page, tracks[0])).toBeVisible();
  await expect(trackRow(page, tracks[0]).locator('.track-main img')).toHaveCount(0);
  await expect(trackRow(page, tracks[2])).toHaveCount(0);
  const cover = trackRow(page, tracks[1]).locator('.track-main img');
  await expect(cover).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => cover.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
  await trackRow(page, tracks[1]).getByRole('button', { name: tracks[1] + ' 缓存样本' }).click();
  await expect(page.locator('#player-title')).toHaveText(tracks[1]);
  await expect(page.locator('#player-art img')).toHaveAttribute('src', /^blob:/);
  const player = page.locator('#audio');
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  expect(await player.evaluate(element => element.currentSrc)).toMatch(/^blob:/);
  expect(requests).toEqual(['1', '2']);
});

test('resumes an unfinished pre-cache after reloading the playlist', async ({ page }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const attempts = [];
  let releaseFirst;
  const firstAttempt = new Promise(resolve => { releaseFirst = resolve; });
  await mockBaidu(page, () => true, async (route, id) => {
    attempts.push(id);
    if (attempts.length === 1) {
      await firstAttempt;
      return route.abort('aborted').catch(() => {});
    }
    return route.fulfill({ contentType: 'audio/mp4', body: audio });
  });

  await page.goto('/');
  await openBaidu(page);
  await addToPlaylist(page, tracks[0], true);
  try {
    await page.getByRole('button', { name: '提前缓存歌单' }).click();
    await expect.poll(() => attempts).toEqual(['1']);
    await page.reload();
    await expect(page.getByRole('button', { name: '停止自动缓存' })).toBeVisible();
    await expect(page.getByText('已缓存 1 / 1 首', { exact: false })).toBeVisible();
    expect(attempts).toEqual(['1', '1']);
    expect(await offlineTrackIds(page)).toEqual(['baidu:1']);
  } finally {
    releaseFirst();
  }
});

test('reports browser quota failures and keeps the remaining songs downloadable', async ({ page }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const requests = [];
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (record, ...options) {
      if (this.name === 'audio' && record.id === 'baidu:1') {
        throw new DOMException('Test storage quota exceeded', 'QuotaExceededError');
      }
      return put.call(this, record, ...options);
    };
  });
  await mockBaidu(page, () => true, (route, id) => {
    requests.push(id);
    return route.fulfill({ contentType: 'audio/mp4', body: audio });
  });

  await page.goto('/');
  await openBaidu(page);
  await addToPlaylist(page, tracks[0], true);
  await openBaidu(page);
  await addToPlaylist(page, tracks[1]);
  await playlistNav(page).click();
  await page.getByRole('button', { name: '提前缓存歌单' }).click();

  const cacheStatus = page.locator('[data-playlist-cache-status]');
  await expect(cacheStatus).toContainText('已缓存 1 / 2 首');
  await expect(cacheStatus).toContainText('浏览器存储空间不足');
  expect(await offlineTrackIds(page)).toEqual(['baidu:2']);

  await page.getByRole('button', { name: '下载歌单', exact: true }).click();
  await expect(page.locator('[data-playlist-export-status]')).toContainText('1 首未能写入浏览器存储');
  await expect(page.getByRole('link', { name: '保存 ZIP 到本地' })).toBeVisible();
  expect(requests).toEqual(['1', '2', '1']);
  expect(await offlineTrackIds(page)).toEqual(['baidu:2']);
});

test('searches and filters downloaded music, then removes only the confirmed cached copy', async ({ page }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await mockBaidu(page, () => true, route => route.fulfill({ contentType: 'audio/mp4', body: audio }));
  await page.goto('/');
  await page.locator('#import-files').setInputFiles({
    name: '本地样本 - 本地检索曲.m4a', mimeType: 'audio/mp4', buffer: audio,
  });
  await expect(page.getByRole('status').filter({ hasText: '已导入或更新 1 首本地歌曲' })).toBeVisible();
  await openBaidu(page);
  const cloudRow = trackRow(page, tracks[0]);
  await cloudRow.getByRole('button', { name: '歌曲选项' }).press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '离线保存' }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '音频已保存到离线歌曲' })).toBeVisible();

  await page.locator('#sidebar [data-nav="offline"]').press('Enter');
  await expect(page.getByRole('heading', { name: '已下载音乐' })).toBeVisible();
  const localSong = page.getByRole('button', { name: '本地检索曲 本地样本' });
  await expect(localSong).toBeVisible();
  await expect(cloudRow).toBeVisible();

  const search = page.getByRole('searchbox', { name: '搜索已下载音乐' });
  const category = page.getByRole('combobox', { name: '分类' });
  await search.fill('缓存样本');
  await expect(cloudRow).toBeVisible();
  await expect(localSong).toHaveCount(0);
  await search.fill('');
  await category.selectOption('local');
  await expect(localSong).toBeVisible();
  await expect(cloudRow).toHaveCount(0);
  await category.selectOption('cached');
  await expect(cloudRow).toBeVisible();
  await expect(localSong).toHaveCount(0);

  await category.selectOption('all');
  const artist = page.getByRole('combobox', { name: '艺人' });
  await artist.selectOption('本地样本');
  await expect(localSong).toBeVisible();
  await expect(cloudRow).toHaveCount(0);
  await artist.selectOption('');
  const album = page.getByRole('combobox', { name: '专辑' });
  await album.selectOption('百度网盘');
  await expect(cloudRow).toBeVisible();
  await expect(localSong).toHaveCount(0);
  await album.selectOption('');
  const deleteButton = cloudRow.getByRole('button', { name: '删除下载', exact: true });
  await deleteButton.press('Enter');
  await expect(dialog.getByRole('heading', { name: '删除下载' })).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).press('Enter');
  await expect(cloudRow).toBeVisible();
  expect(await offlineTrackIds(page)).toEqual(['baidu:1']);
  await deleteButton.press('Enter');
  await dialog.getByRole('button', { name: '确认', exact: true }).press('Enter');
  await expect(cloudRow).toHaveCount(0);
  expect(await offlineTrackIds(page)).toEqual([]);
  await category.selectOption('all');
  await expect(localSong).toBeVisible();
  await page.reload();
  await expect(localSong).toBeVisible();
  await expect(cloudRow).toHaveCount(0);
});
