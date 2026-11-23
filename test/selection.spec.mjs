import { expect, test } from '@playwright/test';

test('selects a song range and adds it to a playlist, then removes a selected subset', async ({ page }) => {
  await page.goto('/#songs');
  await page.locator('#sort').selectOption('default');
  await page.getByRole('button', { name: '多选', exact: true }).press('Enter');
  const tracks = page.locator('#content [data-select-track]');
  await tracks.nth(1).press('Space');
  await tracks.nth(3).press('Shift+Space');
  await expect(page.locator('[data-selection-count]')).toHaveText('已选 3 首');
  await expect(page.getByRole('checkbox', { name: '选择全部歌曲' })).toBeChecked({ indeterminate: true });
  await page.getByRole('button', { name: '添加到歌单', exact: true }).press('Enter');
  const dialog = page.locator('#dialog');
  await dialog.getByRole('button', { name: '新建歌单' }).press('Enter');
  await dialog.getByRole('textbox').fill('批量歌单');
  await dialog.getByRole('button', { name: '创建' }).press('Enter');
  await expect(page.getByRole('heading', { name: '批量歌单' })).toBeVisible();
  await expect(page.locator('#content tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: '多选', exact: true }).press('Enter');
  await page.getByRole('checkbox', { name: '选择 Soft Signal' }).press('Space');
  await page.getByRole('button', { name: '移除所选' }).press('Enter');
  await dialog.getByRole('button', { name: '确认' }).press('Enter');
  await expect(page.locator('#content tbody tr')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('#content tbody tr')).toHaveCount(2);
});

const playlistFixture = [
  { id: 'alpha', name: 'First destination', tracks: ['demo-1', 'demo-1'] },
  { id: 'beta', name: 'Second destination', tracks: ['demo-2'] },
  { id: 'untouched', name: 'Untouched destination', tracks: [] },
];

async function preparePlaylists(page) {
  await page.addInitScript(playlists => {
    if (!localStorage.getItem('groovebox.state.v1')) {
      localStorage.setItem('groovebox.state.v1', JSON.stringify({ playlists }));
    }
  }, playlistFixture);
  await page.goto('/#songs');
}
const savedPlaylists = page => page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')).playlists);

test('adds selected songs to several playlists only after confirmation and preserves existing duplicates', async ({ page }) => {
  await preparePlaylists(page);
  await page.getByRole('button', { name: '多选', exact: true }).press('Enter');
  await page.getByRole('checkbox', { name: '选择 Blue Static', exact: true }).press('Space');
  await page.getByRole('checkbox', { name: '选择 Soft Signal', exact: true }).press('Space');
  const add = page.locator('#content').getByRole('button', { name: '添加到歌单', exact: true });
  const dialog = page.locator('#dialog');
  const mode = dialog.getByRole('button', { name: '多选歌单', exact: true });
  const confirm = dialog.getByRole('button', { name: '添加到所选歌单', exact: true });
  const count = dialog.getByRole('status');
  const chooseFirst = dialog.getByRole('checkbox', { name: 'First destination', exact: true });
  const chooseSecond = dialog.getByRole('checkbox', { name: 'Second destination', exact: true });

  await add.press('Enter');
  await expect(chooseFirst).toHaveCount(0);
  await mode.press('Enter');
  await expect(confirm).toBeDisabled();
  await expect(count).toHaveText('已选 0 个歌单');
  await chooseFirst.press('Space');
  await expect(count).toHaveText('已选 1 个歌单');
  await chooseSecond.press('Space');
  await expect(count).toHaveText('已选 2 个歌单');
  expect(await savedPlaylists(page)).toEqual(playlistFixture);
  await chooseSecond.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await savedPlaylists(page)).toEqual(playlistFixture);

  await add.press('Enter');
  await mode.press('Enter');
  await chooseFirst.press('Space');
  await chooseSecond.press('Space');
  await confirm.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '已添加到 2 个歌单' })).toBeVisible();
  const expected = [
    { ...playlistFixture[0], tracks: ['demo-1', 'demo-1', 'demo-2', 'demo-3'] },
    { ...playlistFixture[1], tracks: ['demo-2', 'demo-3'] },
    playlistFixture[2],
  ];
  expect(await savedPlaylists(page)).toEqual(expected);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-nav="playlist/alpha"]').press('Enter');
  await expect(page.locator('#content tbody .track-name')).toHaveText(['After Hours', 'After Hours', 'Blue Static', 'Soft Signal']);
  expect(await savedPlaylists(page)).toEqual(expected);
});

test('the single-song picker can apply multiple destinations and still supports quick single selection', async ({ page }) => {
  await preparePlaylists(page);
  const dialog = page.locator('#dialog');
  const pick = async title => {
    const row = page.locator('#content tr').filter({ has: page.getByText(title, { exact: true }) });
    await row.getByRole('button', { name: '歌曲选项' }).press('Enter');
    await dialog.getByRole('button', { name: '添加到歌单', exact: true }).press('Enter');
  };
  await pick('Blue Static');
  await dialog.getByRole('button', { name: '多选歌单' }).press('Enter');
  await dialog.getByRole('checkbox', { name: 'First destination' }).press('Space');
  await dialog.getByRole('checkbox', { name: 'Untouched destination' }).press('Space');
  await dialog.getByRole('button', { name: '添加到所选歌单', exact: true }).press('Enter');
  await expect(dialog).toBeHidden();
  expect(await savedPlaylists(page)).toEqual([
    { ...playlistFixture[0], tracks: ['demo-1', 'demo-1', 'demo-2'] },
    playlistFixture[1],
    { ...playlistFixture[2], tracks: ['demo-2'] },
  ]);
  await pick('Soft Signal');
  await dialog.getByRole('button', { name: 'Second destination' }).press('Enter');
  await expect(dialog).toBeHidden();
  expect((await savedPlaylists(page))[1].tracks).toEqual(['demo-2', 'demo-3']);
});
