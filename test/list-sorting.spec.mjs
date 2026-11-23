import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

const sortControl = page => page.getByRole('combobox', { name: '排序', exact: true });
const visibleTitles = page => page.locator('#content tbody .track-name');
const queueTitles = page => page.locator('#now .queue-row .track-name');

test('sorts a playlist and plays its displayed order without rewriting the saved sequence', async ({ page }) => {
  await page.goto('/#settings');
  await page.locator('#restore-file').setInputFiles({
    name: 'playlist-order.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1,
      playlists: [{ id: 'sorting-test', name: '排序测试歌单', tracks: ['demo-2', 'demo-8', 'demo-1'] }],
      settings: { sort: 'artist' },
    })),
  });
  await page.locator('#sidebar [data-nav="songs"]').press('Enter');
  const sort = sortControl(page);
  await expect(sort).toHaveValue('artist');
  await page.locator('#playlist-nav').getByRole('button', { name: '排序测试歌单' }).press('Enter');
  await expect(sort).toHaveValue('default');
  await expect(visibleTitles(page)).toHaveText(['Blue Static', 'Last Light', 'After Hours']);

  await sort.selectOption('title');
  await expect(visibleTitles(page)).toHaveText(['After Hours', 'Blue Static', 'Last Light']);
  await page.locator('#content [data-action="play-view"]').press('Enter');
  await expect(queueTitles(page)).toHaveText(['After Hours', 'Blue Static', 'Last Light']);
  await expect(page.locator('#player-title')).toHaveText('After Hours');

  await page.reload();
  await expect(sort).toHaveValue('title');
  await expect(visibleTitles(page)).toHaveText(['After Hours', 'Blue Static', 'Last Light']);
  await sort.selectOption('default');
  await expect(visibleTitles(page)).toHaveText(['Blue Static', 'Last Light', 'After Hours']);
  await page.locator('#sidebar [data-nav="songs"]').press('Enter');
  await expect(sort).toHaveValue('artist');
});

test('reorders the saved playlist with keyboard controls and preserves order on refresh', async ({ page }) => {
  await page.goto('/#settings');
  await page.locator('#restore-file').setInputFiles({
    name: 'playlist-custom-order.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1,
      playlists: [{ id: 'manual-order', name: '手动歌单顺序', tracks: ['demo-2', 'missing-cloud-track', 'demo-8', 'demo-1'] }],
    })),
  });
  await page.locator('#playlist-nav').getByRole('button', { name: '手动歌单顺序' }).press('Enter');
  await expect(visibleTitles(page)).toHaveText(['Blue Static', 'Last Light', 'After Hours']);
  await page.locator('#content [data-action="play-view"]').press('Enter');
  await expect(queueTitles(page)).toHaveText(['Blue Static', 'Last Light', 'After Hours']);

  const order = page.getByRole('button', { name: '手动排序', exact: true });
  await order.press('Enter');
  await expect(page.getByRole('button', { name: '完成排序', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '上移 Last Light', exact: true }).press('Space');
  await expect(visibleTitles(page)).toHaveText(['Last Light', 'Blue Static', 'After Hours']);
  await expect(page.getByRole('button', { name: '上移 Last Light', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '下移 Last Light', exact: true })).toBeFocused();
  await expect(queueTitles(page)).toHaveText(['Blue Static', 'Last Light', 'After Hours']);
  await page.getByRole('button', { name: '完成排序', exact: true }).press('Enter');

  const sort = sortControl(page);
  await sort.selectOption('title');
  await expect(visibleTitles(page)).toHaveText(['After Hours', 'Blue Static', 'Last Light']);
  await expect(order).toHaveCount(0);
  await sort.selectOption('default');
  await page.reload();
  await expect(visibleTitles(page)).toHaveText(['Last Light', 'Blue Static', 'After Hours']);
  const savedTracks = await page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')).playlists[0].tracks);
  expect(savedTracks).toEqual(['demo-8', 'missing-cloud-track', 'demo-2', 'demo-1']);
  await page.locator('#content [data-action="play-view"]').press('Enter');
  await expect(queueTitles(page)).toHaveText(['Last Light', 'Blue Static', 'After Hours']);
});

test('moves selected playlist tracks together in the unsorted list while preserving unresolved slots', async ({ page }) => {
  const playlist = { id: 'move-playlist-selection', name: '批量移动歌单', tracks: ['demo-1', 'unavailable', 'demo-2', 'demo-3', 'demo-4'] };
  await page.addInitScript(playlist => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ playlists: [playlist] }));
  }, playlist);
  await page.goto('/#' + encodeURIComponent('playlist/' + playlist.id));
  const content = page.locator('#content');
  const selection = content.getByRole('button', { name: '多选', exact: true });
  const up = content.getByRole('button', { name: '上移所选', exact: true });
  const down = content.getByRole('button', { name: '下移所选', exact: true });
  const blue = content.getByRole('checkbox', { name: '选择 Blue Static' });
  const soft = content.getByRole('checkbox', { name: '选择 Soft Signal' });
  const original = ['After Hours', 'Blue Static', 'Soft Signal', 'Paper Planes'];
  await expect(visibleTitles(page)).toHaveText(original);
  await content.getByRole('button', { name: '全部播放', exact: true }).press('Enter');
  await expect(queueTitles(page)).toHaveText(original);

  await selection.press('Enter');
  await expect(up).toBeDisabled();
  await expect(down).toBeDisabled();
  await blue.press('Space');
  await soft.press('Space');
  await up.press('Enter');
  await expect(visibleTitles(page)).toHaveText(['Blue Static', 'Soft Signal', 'After Hours', 'Paper Planes']);
  await expect(up).toBeDisabled();
  await expect(down).toBeFocused();
  await expect(blue).toBeChecked();
  await expect(soft).toBeChecked();
  await down.press('Enter');
  await expect(visibleTitles(page)).toHaveText(original);
  await down.press('Enter');
  const changed = ['After Hours', 'Paper Planes', 'Blue Static', 'Soft Signal'];
  await expect(visibleTitles(page)).toHaveText(changed);
  await expect(down).toBeDisabled();
  await expect(up).toBeFocused();
  await expect(queueTitles(page)).toHaveText(original);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')).playlists[0].tracks))
    .toEqual(['demo-1', 'unavailable', 'demo-4', 'demo-2', 'demo-3']);

  await sortControl(page).selectOption('title');
  await expect(up).toHaveCount(0);
  await sortControl(page).selectOption('default');
  await expect(up).toBeVisible();
  await content.getByRole('searchbox', { name: '搜索此歌单' }).fill('Blue');
  await expect(up).toHaveCount(0);
  await page.reload();
  await expect(visibleTitles(page)).toHaveText(changed);
});

test('sorts album and artist cards independently from their track lists', async ({ page }) => {
  await page.goto('/#artists');
  const sort = sortControl(page);
  const cards = page.locator('#content [data-action="group"] strong');
  await expect(cards.first()).toHaveText('Velvet Atlas');
  await sort.selectOption('name');
  await expect(cards.first()).toHaveText('Fern & Fields');
  await expect(cards.last()).toHaveText('Velvet Atlas');

  await page.locator('#content [data-action="group"][data-id="Velvet Atlas"]').press('Enter');
  await expect(sort).toHaveValue('default');
  await expect(visibleTitles(page)).toHaveText(['After Hours', 'Slow Motion']);
  await sort.selectOption('title-desc');
  await expect(visibleTitles(page)).toHaveText(['Slow Motion', 'After Hours']);

  await page.locator('#sidebar [data-nav="albums"]').press('Enter');
  await expect(sort).toHaveValue('default');
  await sort.selectOption('track-count');
  await expect(cards.first()).toHaveText('Midnight Tape');
  await expect(cards.nth(1)).toHaveText('Still Life');
  await page.locator('#sidebar [data-nav="artists"]').press('Enter');
  await expect(sort).toHaveValue('name');
});

test('sorts Chinese album names by pinyin in both interface languages', async ({ page }) => {
  const names = ['赵', '陈', '张', '白', '李', '胡', 'Beta', 'alpha'];
  const ascending = ['白', '陈', '胡', '李', '张', '赵'];
  await page.addInitScript(names => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    const tracks = names.map((album, index) => ({ id: 'baidu:pinyin-' + index, provider: 'baidu', title: 'Track ' + index,
      artist: 'Album fixture', album, albumIsFallback: false, releaseYear: 2020, src: '/api/baidu/stream?id=' + index }));
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ tracks, settings: { demos: false, language: 'en' } }));
  }, names);
  const cards = page.locator('#content .card-grid strong');
  const chinese = cards.filter({ hasText: /^[赵陈张白李胡]$/ });
  const latin = cards.filter({ hasText: /^(Beta|alpha)$/ });
  await page.goto('/#albums');
  const englishSort = page.getByRole('combobox', { name: 'Sort', exact: true });
  await englishSort.selectOption('name');
  await expect(chinese).toHaveText(ascending);
  await expect(latin).toHaveText(['alpha', 'Beta']);
  await englishSort.selectOption('name-desc');
  await expect(chinese).toHaveText([...ascending].reverse());
  await expect(latin).toHaveText(['Beta', 'alpha']);
  await englishSort.selectOption('release-year');
  await expect(chinese).toHaveText(ascending);

  await page.locator('#sidebar [data-nav="settings"]').press('Enter');
  await page.locator('#interface-language').selectOption('zh-CN');
  await page.locator('#sidebar [data-nav="albums"]').press('Enter');
  const sort = sortControl(page);
  await expect(sort).toHaveValue('release-year');
  await expect(chinese).toHaveText(ascending);
  await sort.selectOption('name-desc');
  await expect(chinese).toHaveText([...ascending].reverse());
  await page.reload();
  await expect(sort).toHaveValue('name-desc');
  await expect(chinese).toHaveText([...ascending].reverse());
});

test('sorts album cards by their album artist and leaves uncredited albums last', async ({ page }) => {
  const catalog = [
    ['Alpha archive', '赵收藏'], ['Gamma sessions', '白唱片'], ['Beta sessions', '白唱片'], ['A shared recording', undefined],
  ];
  await page.addInitScript(catalog => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    const tracks = catalog.map(([album, albumArtist], index) => ({
      id: 'baidu:album-credit-sort-' + index, provider: 'baidu', title: 'Recording ' + index,
      artist: 'Performer ' + (9 - index), album, albumArtist, albumIsFallback: false, src: '/api/baidu/stream?id=' + index,
    }));
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ tracks, settings: { demos: false } }));
  }, catalog);
  await page.goto('/#albums');
  const sort = sortControl(page);
  const cards = page.locator('#content .card-grid strong');
  await sort.selectOption('name');
  await expect(cards).toHaveText(['A shared recording', 'Alpha archive', 'Beta sessions', 'Gamma sessions']);
  await sort.selectOption('album-artist');
  const byArtist = ['Beta sessions', 'Gamma sessions', 'Alpha archive', 'A shared recording'];
  await expect(cards).toHaveText(byArtist);
  await page.reload();
  await expect(sort).toHaveValue('album-artist');
  await expect(cards).toHaveText(byArtist);
  await page.locator('#content .card-grid button').filter({ hasText: 'Beta sessions' }).press('Enter');
  await expect(visibleTitles(page)).toHaveText(['Recording 2']);
  await expect(sort).toHaveValue('default');
});

test('sorts local albums by tagged release year and backfills existing imports', async ({ page }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const track = async (name, album, date) => ({ name: name + '.m4a', mimeType: 'audio/mp4',
    buffer: Buffer.from(await updateBuffer(audio, { title: name, artist: 'Year Fixture', album, ...(date && { date }) })) });
  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles(await Promise.all([
    track('Fixture first', 'Year Z Older', '1996-11-09'), track('Fixture second', 'Year Z Older', '1997'),
    track('Fixture third', 'Year A Newer', '2024'), track('Fixture fourth', 'Year Untagged'),
  ]));
  await expect(visibleTitles(page)).toContainText(['Fixture first', 'Fixture second', 'Fixture third', 'Fixture fourth']);
  await page.locator('#sidebar [data-nav="albums"]').press('Enter');
  const cards = page.locator('#content [data-action="group"][data-id^="Year "]');
  const sort = sortControl(page);
  await expect(cards.locator('small')).toHaveText(['2 首歌曲', '1 首歌曲', '1 首歌曲']);

  await sort.selectOption('release-year');
  await expect(cards.locator('strong')).toHaveText(['Year Z Older', 'Year A Newer', 'Year Untagged']);
  await expect(cards.locator('small')).toHaveText(['2 首歌曲 · 1996', '1 首歌曲 · 2024', '1 首歌曲']);
  await sort.selectOption('release-year-desc');
  await expect(cards.locator('strong')).toHaveText(['Year A Newer', 'Year Z Older', 'Year Untagged']);

  // Model a stored audio record from an older release that did not persist the year.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('groovebox.library');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('tracks', 'readwrite');
      const store = transaction.objectStore('tracks');
      const get = store.get('local:Fixture third.m4a');
      get.onsuccess = () => {
        const record = get.result;
        delete record.releaseYear;
        store.put(record);
      };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
  await page.reload();
  await expect(sort).toHaveValue('release-year-desc');
  await expect(cards.locator('small')).toHaveText(['1 首歌曲 · 2024', '2 首歌曲 · 1996', '1 首歌曲']);
  await sort.selectOption('name');
  await expect(cards.locator('strong')).toHaveText(['Year A Newer', 'Year Untagged', 'Year Z Older']);
  await expect(cards.locator('small')).toHaveText(['1 首歌曲', '1 首歌曲', '2 首歌曲']);
});

test('sorts cloud folders and tracks without changing downloaded track preferences', async ({ page }) => {
  await page.route('**/api/baidu/status', route => route.fulfill({
    json: { configured: true, connected: true },
  }));
  await page.route('**/api/baidu/list?**', route => route.fulfill({ json: { items: [
    { id: 'z-dir', folder: true, name: 'Zulu folder', path: '/z-dir' },
    { id: 'a-dir', folder: true, name: 'Alpha folder', path: '/a-dir' },
    { id: '5', duration: 10, name: 'B Artist - Zulu song.m4a' },
    { id: '6', duration: 20, name: 'A Artist - Alpha song.m4a' },
    { id: '7', name: 'C Artist - Unknown length.m4a' },
  ].map(item => item.folder ? item : {
    ...item, folder: false, path: '/' + item.name, streamUrl: '/api/baidu/stream?id=' + item.id,
  }) } }));

  const baiduSource = page.locator('#content [data-action="baidu-source"]');
  await page.goto('/#sources');
  await expect(baiduSource).toContainText('已连接');
  await baiduSource.press('Enter');
  const sort = sortControl(page);
  const folders = page.locator('#content .folder-row span');
  await expect(folders).toHaveText(['Zulu folder', 'Alpha folder']);
  await expect(visibleTitles(page)).toHaveText(['Zulu song', 'Alpha song', 'Unknown length']);
  await sort.selectOption('title');
  await expect(folders).toHaveText(['Alpha folder', 'Zulu folder']);
  await expect(visibleTitles(page)).toHaveText(['Alpha song', 'Unknown length', 'Zulu song']);
  await sort.selectOption('duration');
  await expect(folders).toHaveText(['Zulu folder', 'Alpha folder']);
  await expect(visibleTitles(page)).toHaveText(['Zulu song', 'Alpha song', 'Unknown length']);

  await page.locator('#sidebar [data-nav="offline"]').press('Enter');
  await expect(sort).toHaveValue('default');
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.locator('#import-files').setInputFiles(['Zulu local.m4a', 'Alpha local.m4a']
    .map(name => ({ name, mimeType: 'audio/mp4', buffer: audio })));
  await expect(visibleTitles(page)).toHaveCount(2);
  await sort.selectOption('title-desc');
  await expect(visibleTitles(page)).toHaveText(['Zulu local', 'Alpha local']);
  await page.reload();
  await expect(sort).toHaveValue('title-desc');
  await expect(visibleTitles(page)).toHaveText(['Zulu local', 'Alpha local']);
  await page.locator('#sidebar [data-nav="sources"]').press('Enter');
  await expect(baiduSource).toContainText('已连接');
  await baiduSource.press('Enter');
  await expect(sort).toHaveValue('duration');
});
