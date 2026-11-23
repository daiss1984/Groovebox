import { expect, test } from '@playwright/test';

function waveFixture() {
  const samples = 8000 * 2 * 6;
  const wav = Buffer.alloc(44 + samples);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  return wav;
}

test('uses a Baidu filename rule while staying in direct mode across reload and backup', async ({ page }) => {
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  const folder = '现场专辑-驻场乐团';
  await page.route('**/api/baidu/list?**', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    const items = path === '/' ? [{ id: 'album', name: folder, path: '/music', folder: true }] : [{
      id: '31', name: '01-晚场录音.wav', path: '/music/01-晚场录音.wav', streamUrl: '/api/baidu/stream?id=31',
    }];
    return route.fulfill({ json: { items } });
  });
  await page.route('**/api/baidu/stream?**', route => route.fulfill({ contentType: 'audio/wav', body: waveFixture() }));
  const content = page.locator('#content');
  const nav = name => page.locator(`#sidebar [data-nav="${name}"]`);
  const button = name => content.getByRole('button', { name, exact: true });
  const card = content.locator('.source-card-group[aria-label="百度网盘"]');
  const openFolder = async () => {
    await nav('sources').click();
    await card.locator('[data-action=baidu-source]').click();
    await button(folder).click();
  };
  const setRule = async (mode, pattern) => {
    await button('文件名解析').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('歌曲信息来源').selectOption(mode);
    await dialog.getByLabel('文件名规则').fill(pattern);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();
  };

  await page.goto('/#sources');
  await card.getByRole('button', { name: '直连模式', exact: true }).click();
  await openFolder();
  await button('文件名解析').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('歌曲信息来源').selectOption('filename');
  await expect(dialog.getByLabel('文件名规则')).toHaveValue('name');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(button('01-晚场录音 驻场乐团')).toBeVisible();
  await setRule('filename', 'track-name');
  const parsed = button('晚场录音 驻场乐团');
  await expect(parsed).toBeVisible();
  await expect(button('扫描并加入曲库')).toHaveCount(0);
  await parsed.click();
  await expect.poll(() => page.locator('#audio').evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await page.reload();
  await openFolder();
  await expect(parsed).toBeVisible();

  await nav('settings').click();
  const download = page.waitForEvent('download');
  await content.getByRole('button', { name: '导出备份' }).click();
  const exported = await download;
  await openFolder();
  await setRule('filename', 'name');
  await expect(button('01-晚场录音 驻场乐团')).toBeVisible();
  await nav('settings').click();
  await page.locator('#restore-file').setInputFiles(await exported.path());
  await expect(page.locator('#toast')).toContainText('备份已恢复');
  await openFolder();
  await expect(parsed).toBeVisible();
  await expect(button('扫描并加入曲库')).toHaveCount(0);
});

test('direct mode plays a cloud folder without indexing it and preserves the existing library', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('groovebox.state.v1')) {
      localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { demos: false } }));
    }
  });
  const wave = waveFixture();
  const folderPath = '/Direct music';
  const names = ['Direct Recording', 'Never Played Sibling'];
  const indexed = 'Previously Indexed';
  const playlistName = 'Direct Music Favorites';
  const paths = [];
  let includeNewTracks = false;
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')));
  const nav = name => page.locator(`#sidebar [data-nav="${name}"]`);
  const headings = name => page.locator('#content').getByRole('heading', { name, exact: true });
  const content = page.locator('#content');
  const libraryTitles = content.locator('.track-main .track-name');
  const baidu = content.locator('.source-card-group[aria-label="百度网盘"]');
  const directMode = baidu.getByRole('button', { name: '直连模式', exact: true });
  const openFolder = async () => {
    await baidu.locator('[data-action=baidu-source]').press('Enter');
    await content.getByRole('button', { name: 'Direct music', exact: true }).press('Enter');
  };
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/gdrive/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    paths.push(path);
    const tracks = (includeNewTracks ? [indexed, ...names] : [indexed]).map((title, i) => ({ id: String(i + 1),
      name: title + '.wav', path: `${folderPath}/${title}.wav`, streamUrl: `/api/baidu/stream?id=${i + 1}` }));
    const items = path === '/' ? [{ id: 'folder', name: 'Direct music', path: folderPath, folder: true }] : tracks;
    return route.fulfill({ json: { items } });
  });
  await page.route('**/api/baidu/stream?**', route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ contentType: 'audio/wav', body: wave });
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), wave.length - 1) : wave.length - 1;
    return route.fulfill({ status: 206, contentType: 'audio/wav',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${wave.length}` }, body: wave.subarray(start, end + 1) });
  });
  await page.goto('/#sources');
  await expect(directMode).toHaveAttribute('aria-pressed', 'false');
  await openFolder();
  await content.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '扫描完成' })).toBeVisible();
  await nav('songs').press('Enter');
  await expect(libraryTitles).toHaveText([indexed]);
  await expect(content.getByRole('button', { name: '刷新曲库', exact: true })).toBeVisible();
  const originalIndex = (await state()).scanSnapshots.baidu;

  await nav('sources').press('Enter');
  await directMode.press('Enter');
  await expect(directMode).toHaveAttribute('aria-pressed', 'true');
  await expect(directMode).toBeFocused();
  await expect(content.locator('.source-card-group[aria-label="Google Drive"]')
    .getByRole('button', { name: '直连模式', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await nav('songs').press('Enter');
  await expect(libraryTitles).toHaveCount(0);
  await expect(content.getByRole('button', { name: '刷新曲库', exact: true })).toHaveCount(0);
  await page.locator('#search').fill('Direct music');
  await expect(headings('搜索结果')).toBeVisible();
  await expect(content.locator('[data-action=open-indexed-folder]')).toHaveCount(0);
  await expect(libraryTitles).toHaveCount(0);

  await nav('sources').press('Enter');
  includeNewTracks = true;
  paths.length = 0;
  await openFolder();
  await expect(libraryTitles).toHaveText([indexed, ...names]);
  await expect(content.getByRole('button', { name: '直连模式', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(content.getByRole('button', { name: /收录的目录|扫描并加入曲库|重新扫描目录|只扫描新目录/ })).toHaveCount(0);
  const recording = content.locator('tbody tr').filter({ hasText: names[0] });
  await recording.locator('.track-main').press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.05);
  expect(paths).toEqual(['/', folderPath]);
  await page.locator('#player-toggle').press('Enter');
  await recording.getByRole('button', { name: '收藏', exact: true }).press('Enter');
  const dialog = page.getByRole('dialog');
  await recording.getByRole('button', { name: '歌曲选项' }).press('Enter');
  await dialog.getByRole('button', { name: '添加到歌单' }).press('Enter');
  await dialog.getByRole('button', { name: '新建歌单' }).press('Enter');
  await dialog.getByRole('textbox').fill(playlistName);
  await dialog.getByRole('button', { name: '创建', exact: true }).press('Enter');
  await nav('sources').press('Enter');
  await openFolder();
  await recording.getByRole('button', { name: '歌曲选项' }).press('Enter');
  await dialog.getByRole('button', { name: '离线保存' }).press('Enter');
  await nav('offline').press('Enter');
  await expect(libraryTitles).toHaveText([names[0]]);

  await nav('home').press('Enter');
  const recent = headings('最近播放').locator('xpath=ancestor::section').locator('.track-main .track-name');
  await expect(recent).toHaveText([names[0]]);
  await expect(content.getByRole('region', { name: '播放统计' }).locator('dd')).toHaveText(['0', '0', '0']);
  expect((await state()).scanSnapshots.baidu).toEqual(originalIndex);
  await page.reload();
  await expect(recent).toHaveText([names[0]]);
  await expect(page.locator('#player-title')).toHaveText(names[0]);
  const queue = page.locator('#now .queue-row .track-name');
  await expect(queue).toHaveText([indexed, ...names]);
  await nav('favorites').press('Enter');
  await expect(libraryTitles).toHaveText([names[0]]);
  await page.locator('#playlist-nav').getByRole('button', { name: playlistName }).press('Enter');
  await expect(libraryTitles).toHaveText([names[0]]);

  await nav('sources').press('Enter');
  await expect(directMode).toHaveAttribute('aria-pressed', 'true');
  await baidu.getByRole('button', { name: '从曲库隐藏', exact: true }).press('Enter');
  await nav('home').press('Enter');
  await expect(recent).toHaveCount(0);
  await nav('sources').press('Enter');
  await baidu.getByRole('button', { name: '在曲库显示', exact: true }).press('Enter');
  await directMode.press('Enter');
  await expect(directMode).toHaveAttribute('aria-pressed', 'false');
  await nav('songs').press('Enter');
  await expect(libraryTitles).toHaveText([indexed]);
  await expect(content.getByRole('button', { name: '刷新曲库', exact: true })).toBeVisible();
  await page.locator('#search').fill('Direct music');
  await expect(content.locator('[data-action=open-indexed-folder]')).toHaveCount(1);
  expect((await state()).scanSnapshots.baidu).toEqual(originalIndex);
});

test('excludes explicitly removed tracks from home when they appear in direct playback history', async ({ page }) => {
  await page.addInitScript(() => {
    const tracks = ['Retained direct track', 'Removed direct track'].map((title, index) => ({
      id: 'baidu:' + index, provider: 'baidu', title, directOnly: true, src: '/api/baidu/stream?id=' + index,
    }));
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      tracks, removedLibraryTracks: ['baidu:1'], directRecent: tracks.map(({ id }, index) => ({ id, at: index + 1 })),
      settings: { demos: false, directCloudSources: ['baidu'] },
    }));
  });
  await page.goto('/');
  await expect(page.locator('#content').getByRole('heading', { name: '最近播放', exact: true })
    .locator('xpath=ancestor::section').locator('.track-main .track-name')).toHaveText(['Retained direct track']);
});
