import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const nav = (page, section) => page.locator(`#sidebar [data-nav="${section}"]`);
const trackRow = (page, id) => page.locator(`#content [data-track="${id}"]`);
const trackMenu = row => row.getByRole('button', { name: '歌曲选项', exact: true });
const dialogButton = (page, name) => page.getByRole('dialog').getByRole('button', { name, exact: true });
const removeCopy = page => page.getByRole('dialog').getByRole('checkbox', { name: '同时移除播放器里的本地副本', exact: true });

async function mockLibrary(page, provider, titles) {
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { demos: false } }));
  });
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const items = titles.map((title, index) => ({
    id: String(index + 1),
    title,
    name: title + '.m4a',
    path: '/' + title + '.m4a',
    streamUrl: `/api/${provider}/stream?id=${index + 1}`,
  }));
  const mutations = [];
  await page.route(`**/api/${provider}/**`, route => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname.split('/').at(-1);
    if (!['GET', 'HEAD'].includes(request.method())) {
      mutations.push(request.method() + ' ' + endpoint);
      return route.fulfill({ status: 405 });
    }
    if (endpoint === 'status') return route.fulfill({ json: { configured: true, connected: true } });
    if (endpoint === 'list') return route.fulfill({ json: { items } });
    if (endpoint === 'stream') return route.fulfill({ contentType: 'audio/mp4', body: audio });
    return route.fallback();
  });
  const openSource = async () => {
    await nav(page, 'sources').press('Enter');
    const selector = provider === 'baidu' ? '[data-action=baidu-source]' : `[data-action=oauth-source][data-id="${provider}"]`;
    await page.locator(selector).press('Enter');
    await expect(trackRow(page, provider + ':1')).toBeVisible();
  };
  await page.goto('/#sources');
  await openSource();
  await page.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('扫描完成');
  await nav(page, 'songs').press('Enter');
  return { openSource, mutations };
}

async function saveOffline(page, row) {
  await trackMenu(row).press('Enter');
  await dialogButton(page, '离线保存').press('Enter');
  await expect(page.locator('#toast')).toContainText('音频已保存到离线歌曲');
}

async function refreshLibrary(page) {
  await page.getByRole('button', { name: '刷新曲库', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('曲库已刷新');
}

test('removes a Baidu track from its row context menu and preserves its download by default', async ({ page }) => {
  const { openSource, mutations } = await mockLibrary(page, 'baidu', ['Baidu Download', 'Other Baidu Track']);
  const download = trackRow(page, 'baidu:1');
  await saveOffline(page, download);
  await download.getByRole('button', { name: '收藏', exact: true }).press('Enter');
  await download.locator('.track-main').click({ button: 'right' });
  await dialogButton(page, '从曲库移除').press('Enter');
  await expect(removeCopy(page)).toBeVisible();
  await expect(removeCopy(page)).not.toBeChecked();
  await dialogButton(page, '确认').press('Enter');
  await expect(download).toHaveCount(0);
  await expect(trackRow(page, 'baidu:2')).toBeVisible();

  await page.reload();
  await refreshLibrary(page);
  await expect(download).toHaveCount(0);
  await nav(page, 'favorites').press('Enter');
  await expect(download).toHaveCount(0);
  await nav(page, 'offline').press('Enter');
  await expect(download).toBeVisible();

  await openSource();
  await page.getByRole('button', { name: '重新扫描目录', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('扫描完成');
  await expect(download).toBeVisible();
  await nav(page, 'songs').press('Enter');
  await expect(download).toHaveCount(0);

  await openSource();
  await trackMenu(download).press('Enter');
  await dialogButton(page, '加回曲库').press('Enter');
  await nav(page, 'songs').press('Enter');
  await expect(download).toBeVisible();
  expect(mutations).toEqual([]);
});

test('removes selected Google Drive tracks and their downloaded copies only after opting in', async ({ page }) => {
  const { openSource, mutations } = await mockLibrary(page, 'gdrive', ['First Drive Track', 'Second Drive Track', 'Unselected Track']);
  const first = trackRow(page, 'gdrive:1');
  const second = trackRow(page, 'gdrive:2');
  const untouched = trackRow(page, 'gdrive:3');
  await saveOffline(page, first);
  await saveOffline(page, second);
  await saveOffline(page, untouched);
  await page.getByRole('button', { name: '多选', exact: true }).press('Enter');
  const removeSelected = page.getByRole('button', { name: '从曲库移除所选', exact: true });
  await expect(removeSelected).toBeDisabled();
  await first.getByRole('checkbox').check();
  await second.getByRole('checkbox').check();
  await removeSelected.press('Enter');
  await expect(removeCopy(page)).not.toBeChecked();
  await removeCopy(page).check();
  await dialogButton(page, '取消').press('Enter');
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();

  await removeSelected.press('Enter');
  await expect(removeCopy(page)).not.toBeChecked();
  await removeCopy(page).check();
  await dialogButton(page, '确认').press('Enter');
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await expect(untouched).toBeVisible();
  await refreshLibrary(page);
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);

  await nav(page, 'offline').press('Enter');
  await page.reload();
  await expect(untouched).toBeVisible();
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await openSource();
  await expect(second).toBeVisible();
  expect(mutations).toEqual([]);
});

test('keeps an imported local song available until its browser copy is explicitly removed', async ({ page }) => {
  const file = {
    name: 'Removal fixture.m4a',
    mimeType: 'audio/mp4',
    buffer: await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url)),
  };
  await page.goto('/#songs');
  const song = trackRow(page, 'local:' + file.name);
  const importFile = async () => {
    await page.locator('#import-files').setInputFiles(file);
    await expect(song).toBeVisible();
  };
  const openRemoval = async () => {
    await trackMenu(song).press('Enter');
    await dialogButton(page, '从曲库移除').press('Enter');
    await expect(removeCopy(page)).not.toBeChecked();
  };

  await importFile();
  await openRemoval();
  await dialogButton(page, '确认').press('Enter');
  await expect(song).toHaveCount(0);
  await page.reload();
  await expect(song).toHaveCount(0);
  await nav(page, 'offline').press('Enter');
  await expect(song).toBeVisible();

  await trackMenu(song).press('Enter');
  await dialogButton(page, '加回曲库').press('Enter');
  await nav(page, 'songs').press('Enter');
  await expect(song).toBeVisible();
  await openRemoval();
  await removeCopy(page).check();
  await dialogButton(page, '确认').press('Enter');
  await expect(song).toHaveCount(0);
  await nav(page, 'offline').press('Enter');
  await expect(song).toHaveCount(0);
  await page.reload();
  await expect(song).toHaveCount(0);
  await nav(page, 'songs').press('Enter');
  await importFile();
});
