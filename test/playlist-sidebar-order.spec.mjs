import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function createPlaylist(page, name) {
  await page.locator('#sidebar .nav-playlist [data-action="new-playlist"]').press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('歌单名称').fill(name);
  await dialog.getByRole('button', { name: '创建', exact: true }).press('Enter');
  await expect(page.locator('#content').getByRole('heading', { name, exact: true })).toBeVisible();
}

test('uses newest-first playlist sorting on first use and persists an explicit manual sort', async ({ page }) => {
  await page.goto('/#home');
  await createPlaylist(page, 'First Created');
  await createPlaylist(page, 'Second Created');

  const entries = page.locator('#playlist-nav button');
  const reorder = page.getByRole('button', { name: '调整歌单顺序', exact: true });
  const dialog = page.getByRole('dialog');
  const sort = dialog.getByRole('combobox', { name: '歌单排序', exact: true });
  await expect(entries).toHaveText(['Second Created', 'First Created']);
  await reorder.press('Enter');
  await expect(sort).toHaveValue('created-at-desc');
  await expect(dialog.locator('[data-action="playlist-up"]')).toHaveCount(0);

  await sort.selectOption('manual');
  await dialog.getByRole('button', { name: '上移 First Created', exact: true }).press('Enter');
  await expect(entries).toHaveText(['First Created', 'Second Created']);
  await page.reload();
  await expect(entries).toHaveText(['First Created', 'Second Created']);
  await reorder.press('Enter');
  await expect(sort).toHaveValue('manual');
});

test('keeps the legacy manual playlist sort when the saved collection is empty', async ({ page }) => {
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ playlists: [] }));
  });
  await page.goto('/#home');
  await createPlaylist(page, 'First Created');
  await createPlaylist(page, 'Second Created');
  await page.getByRole('button', { name: '调整歌单顺序', exact: true }).press('Enter');
  await expect(page.getByRole('dialog').getByRole('combobox', { name: '歌单排序', exact: true })).toHaveValue('manual');
});

test('sorts by playlist modifications and advances dates only for rename and membership edits', async ({ page }) => {
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      playlists: [
        { id: 'first', name: 'First List', tracks: ['demo-1', 'demo-2'] },
        { id: 'legacy', name: 'Legacy List', tracks: [] },
        { id: 'second', name: 'Second List', tracks: [] },
      ],
      playlistCreationDates: [['first', 10], ['legacy', 15], ['second', 20]],
      playlistModificationDates: [['first', 100], ['second', 200]],
    }));
  });
  const initialTime = 1_700_000_000_000;
  await page.clock.setFixedTime(initialTime);
  await page.goto('/#playlist%2Ffirst');
  const sidebar = page.locator('#playlist-nav button');
  const dialog = page.getByRole('dialog');
  const content = page.locator('#content');
  const readState = () => page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')));
  const date = async () => Object.fromEntries((await readState()).playlistModificationDates).first;

  await page.getByRole('button', { name: '调整歌单顺序', exact: true }).click();
  const sort = dialog.getByRole('combobox', { name: '歌单排序', exact: true });
  await expect(sort.locator('option[value="modified-at-desc"]')).toHaveText('修改时间（最新优先）');
  await sort.selectOption('modified-at-desc');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(sidebar).toHaveText(['Second List', 'First List', 'Legacy List']);

  await content.getByRole('button', { name: '手动排序', exact: true }).click();
  await content.locator('[data-action="playlist-track-up"]:enabled').click();
  await content.getByRole('button', { name: '完成排序', exact: true }).click();
  expect((await readState()).playlists[0].tracks).toEqual(['demo-2', 'demo-1']);
  expect(await date()).toBe(100);

  await content.getByRole('button', { name: '重命名', exact: true }).click();
  await dialog.getByLabel('歌单名称').fill('Renamed List');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(sidebar).toHaveText(['Renamed List', 'Second List', 'Legacy List']);
  expect(await date()).toBe(initialTime);

  await page.clock.setFixedTime(initialTime + 1_000);
  await page.locator('#sidebar [data-nav="songs"]').click();
  await content.locator('[data-action="track-menu"][data-id="demo-3"]').click();
  await dialog.getByRole('button', { name: '添加到歌单', exact: true }).click();
  await dialog.locator('[data-action="add-to-playlist"][data-id="first"]').click();
  expect(await date()).toBe(initialTime + 1_000);

  await page.clock.setFixedTime(initialTime + 2_000);
  await sidebar.getByText('Renamed List', { exact: true }).click();
  await content.locator('[data-action="track-menu"][data-id="demo-3"]').click();
  await dialog.getByRole('button', { name: '从歌单移除', exact: true }).click();
  const saved = await readState();
  expect(saved.playlists[0].tracks).toEqual(['demo-2', 'demo-1']);
  expect(saved.playlistCreationDates).toEqual([['first', 10], ['legacy', 15], ['second', 20]]);
  expect(saved.playlistModificationDates).toEqual([['first', initialTime + 2_000], ['second', 200]]);
  await page.reload();
  await expect(sidebar).toHaveText(['Renamed List', 'Second List', 'Legacy List']);
  expect(await date()).toBe(initialTime + 2_000);
});

test('reorders local playlists while retaining the current playlist and playback', async ({ page }) => {
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ playlists: [
      { id: 'first', name: '深夜', tracks: ['demo-1'] },
      { id: 'second', name: '日光', tracks: ['demo-2'] },
      { id: 'third', name: '海风', tracks: ['demo-3'] },
    ] }));
  });

  await page.goto('/#playlist%2Fsecond');
  const entries = page.locator('#playlist-nav button');
  await expect(entries).toHaveText(['深夜', '日光', '海风']);
  await page.locator('#content').getByRole('button', { name: '全部播放', exact: true }).press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  const source = await audio.evaluate(element => element.currentSrc);

  const reorder = page.getByRole('button', { name: '调整歌单顺序' });
  await reorder.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('listitem')).toHaveText(['深夜', '日光', '海风']);
  await expect(dialog.getByRole('button', { name: '上移 深夜' })).toBeDisabled();
  await dialog.getByRole('button', { name: '上移 海风' }).press('Enter');
  const up = dialog.getByRole('button', { name: '上移 海风' });
  await expect(up).toBeFocused();
  await up.press('Enter');
  await expect(dialog.getByRole('listitem')).toHaveText(['海风', '深夜', '日光']);
  await expect(dialog.getByRole('button', { name: '下移 海风' })).toBeFocused();
  await dialog.getByRole('button', { name: '关闭', exact: true }).press('Enter');
  await expect(reorder).toBeFocused();
  await expect(entries).toHaveText(['海风', '深夜', '日光']);
  await expect(entries.last()).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => audio.evaluate(element => [element.currentSrc, element.paused])).toEqual([source, false]);
  await page.reload();
  await expect(entries).toHaveText(['海风', '深夜', '日光']);
});

test('puts new and imported playlists first, sorts the picker independently, and preserves sidebar order and dates through backup', async ({ page, browser, baseURL }) => {
  const stateKey = 'groovebox.state.v1';
  const legacy = [
    { id: 'legacy-z', name: 'Zulu Legacy', tracks: ['demo-1'] },
    { id: 'legacy-b', name: 'Beta Legacy', tracks: ['demo-2'] },
  ];
  await page.addInitScript(({ key, playlists }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ playlists }));
  }, { key: stateKey, playlists: legacy });

  const entries = target => target.locator('#playlist-nav button');
  const readState = target => target.evaluate(key => JSON.parse(localStorage.getItem(key)), stateKey);
  const dialog = target => target.getByRole('dialog');
  const sort = target => dialog(target).getByRole('combobox', { name: '歌单排序', exact: true });
  const open = target => target.getByRole('button', { name: '调整歌单顺序', exact: true }).click();
  const close = target => dialog(target).getByRole('button', { name: '关闭', exact: true }).click();
  const want = target => target.locator('#content');
  const pickerNames = ['Alpha New', 'Zulu New', 'Zulu Legacy', 'Beta Legacy'];

  await page.goto('/#home');
  await page.locator('#sidebar .nav-playlist [data-action="new-playlist"]').click();
  await dialog(page).getByLabel('歌单名称').fill('Zulu New');
  await dialog(page).getByRole('button', { name: '创建', exact: true }).click();
  await expect(want(page).getByRole('heading', { name: 'Zulu New', exact: true })).toBeVisible();
  await expect(entries(page)).toHaveText(['Zulu New', 'Zulu Legacy', 'Beta Legacy']);
  const [[manualId, manualDate]] = (await readState(page)).playlistCreationDates;
  await page.waitForFunction(date => Date.now() > date, manualDate);
  const audioContents = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.locator('#import-files').setInputFiles({
    name: 'playlist-sort-source.m4a', mimeType: 'audio/mp4', buffer: audioContents,
  });
  await expect(page.locator('#toast')).toContainText('已导入或更新 1 首本地歌曲');
  await page.locator('#import-m3u-file').setInputFiles({
    name: 'Alpha New.m3u', mimeType: 'audio/x-mpegurl',
    buffer: Buffer.from('#EXTM3U\nplaylist-sort-source.m4a\n'),
  });
  await expect(want(page).getByRole('heading', { name: 'Alpha New', exact: true })).toBeVisible();
  await expect(entries(page)).toHaveText(pickerNames);
  const initial = await readState(page);
  expect(initial.playlistModificationDates).toEqual(initial.playlistCreationDates);
  const [[m3uId, m3uDate], [, originalManualDate]] = initial.playlistCreationDates;
  expect(initial.playlistCreationDates).toHaveLength(2);
  expect(originalManualDate).toBe(manualDate);
  expect(m3uDate).toBeGreaterThan(manualDate);

  await want(page).getByRole('button', { name: '全部播放', exact: true }).click();
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  const src = await audio.evaluate(element => element.currentSrc);

  await open(page);
  await expect(sort(page)).toHaveValue('manual');
  await dialog(page).getByRole('button', { name: '上移 Zulu New', exact: true }).click();
  await expect(entries(page)).toHaveText(['Zulu New', 'Alpha New', 'Zulu Legacy', 'Beta Legacy']);
  const manualOrder = (await readState(page)).playlists;
  await sort(page).selectOption('name');
  await expect(sort(page)).toBeFocused();
  await expect(entries(page)).toHaveText(['Alpha New', 'Beta Legacy', 'Zulu Legacy', 'Zulu New']);
  await expect(dialog(page).locator('[data-action="playlist-up"]')).toHaveCount(0);
  await close(page);
  await want(page).getByRole('button', { name: '歌曲选项', exact: true }).press('Enter');
  await dialog(page).getByRole('button', { name: '添加到歌单', exact: true }).press('Enter');
  await expect(dialog(page).locator('[data-action="add-to-playlist"]')).toHaveText(pickerNames);
  await dialog(page).getByRole('button', { name: '多选歌单', exact: true }).press('Enter');
  await expect(dialog(page).locator('.playlist-choice')).toHaveText(pickerNames);
  await close(page);
  await open(page);
  await sort(page).selectOption('created-at');
  await expect(entries(page)).toHaveText(['Zulu New', 'Alpha New', 'Zulu Legacy', 'Beta Legacy']);
  await sort(page).selectOption('created-at-desc');
  await expect(entries(page)).toHaveText(['Alpha New', 'Zulu New', 'Zulu Legacy', 'Beta Legacy']);
  await close(page);
  await expect(page.locator('#playlist-nav [aria-current="page"]')).toHaveAttribute('data-nav', 'playlist/' + m3uId);
  await expect.poll(() => audio.evaluate(element => [element.currentSrc, element.paused])).toEqual([src, false]);
  expect((await readState(page)).playlists).toEqual(manualOrder);

  await page.locator('#playlist-nav [data-nav="playlist/' + manualId + '"]').click();
  await page.waitForFunction(date => Date.now() > date, m3uDate);
  await want(page).getByRole('button', { name: '重命名', exact: true }).click();
  await dialog(page).getByLabel('歌单名称').fill('Aardvark New');
  await dialog(page).getByRole('button', { name: '保存', exact: true }).click();
  await expect(entries(page)).toHaveText(['Alpha New', 'Aardvark New', 'Zulu Legacy', 'Beta Legacy']);
  await open(page);
  await sort(page).selectOption('name');
  await expect(entries(page)).toHaveText(['Aardvark New', 'Alpha New', 'Beta Legacy', 'Zulu Legacy']);
  await sort(page).selectOption('created-at-desc');
  await close(page);
  expect(Object.fromEntries((await readState(page)).playlistCreationDates)).toEqual(Object.fromEntries(initial.playlistCreationDates));
  await page.reload();
  await expect(entries(page)).toHaveText(['Alpha New', 'Aardvark New', 'Zulu Legacy', 'Beta Legacy']);

  await page.locator('#sidebar [data-nav="settings"]').click();
  const download = page.waitForEvent('download');
  await want(page).getByRole('button', { name: '导出备份', exact: true }).click();
  const file = await (await download).path();
  const backup = JSON.parse(await readFile(file, 'utf8'));
  expect(Object.fromEntries(backup.playlistCreationDates)).toEqual(Object.fromEntries(initial.playlistCreationDates));
  expect(Object.fromEntries(backup.playlistModificationDates)[manualId]).toBeGreaterThan(m3uDate);
  expect(Object.fromEntries(backup.playlistModificationDates)[m3uId]).toBe(m3uDate);
  expect(backup.settings.playlistOverviewOrder).toBe('created-at-desc');
  expect(backup.playlists.map(list => list.name)).toEqual(['Aardvark New', 'Alpha New', 'Zulu Legacy', 'Beta Legacy']);

  const receiver = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  try {
    const restored = await receiver.newPage();
    await restored.goto('/#settings');
    await restored.locator('#restore-file').setInputFiles(file);
    await expect(restored.locator('#toast')).toContainText('备份已恢复');
    expect((await readState(restored)).playlistModificationDates).toEqual(backup.playlistModificationDates);
    await expect(entries(restored)).toHaveText(['Alpha New', 'Aardvark New', 'Zulu Legacy', 'Beta Legacy']);
    await open(restored);
    await expect(sort(restored)).toHaveValue('created-at-desc');
    await sort(restored).selectOption('manual');
    await expect(entries(restored)).toHaveText(backup.playlists.map(list => list.name));
    await expect(dialog(restored).getByRole('button', { name: '上移 Alpha New', exact: true })).toBeEnabled();
  } finally {
    await receiver.close();
  }
});
