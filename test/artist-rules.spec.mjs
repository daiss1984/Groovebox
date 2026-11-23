import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

test('classifies credited artists with literal separators and keeps whole-name exceptions', async ({ page }) => {
  const rawCredit = 'North ++ South / North';
  const title = 'Joint recording';
  await page.addInitScript(() => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { demos: false }, tracks: [{
      id: 'baidu:artist-rules', provider: 'baidu', title: 'Cloud session', artist: 'North / East',
      album: 'Remote album', albumIsFallback: false, src: '/api/baidu/stream?id=311',
    }] }));
  });
  const portraitQueries = [];
  await page.route('**/api/artwork/artist?*', route => {
    portraitQueries.push(Object.fromEntries(new URL(route.request().url()).searchParams));
    return route.fulfill({ status: 404 });
  });
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const fixture = async (title, artist) => ({ name: title + '.m4a', mimeType: 'audio/mp4',
    buffer: Buffer.from(await updateBuffer(audio, { title, artist, album: 'Split album' })) });
  const fixtures = await Promise.all([fixture(title, rawCredit), fixture('Band recording', 'AC/DC')]);
  const content = page.locator('#content');
  const nav = name => page.locator('#sidebar [data-nav=' + name + ']');
  const titles = content.locator('tbody .track-name');
  const card = name => content.locator('button.card').filter({ has: page.getByText(name, { exact: true }) });
  const separators = content.getByRole('textbox', { name: '艺人分隔符', exact: true });
  const exceptions = content.getByRole('textbox', { name: '不拆分的艺人', exact: true });
  const save = () => content.getByRole('button', { name: '保存艺人规则', exact: true }).press('Enter');

  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles(fixtures);
  await expect(content.getByRole('button', { name: title + ' ' + rawCredit, exact: true })).toBeVisible();
  await nav('artists').press('Enter');
  await expect(card(rawCredit)).toBeVisible();
  await expect(card('North / East')).toBeVisible();

  await nav('settings').press('Enter');
  await separators.fill('++\n/');
  await exceptions.fill('ac/dc');
  await save();
  await expect(page.getByRole('status').filter({ hasText: '已保存艺人规则' })).toBeVisible();
  const download = page.waitForEvent('download');
  await content.getByRole('button', { name: '导出备份' }).press('Enter');
  const backup = await readFile(await (await download).path());
  expect(JSON.parse(backup).settings.artistRules).toEqual({ separators: ['++', '/'], exceptions: ['ac/dc'] });

  await nav('artists').press('Enter');
  await expect(card(rawCredit)).toHaveCount(0);
  await expect(card('North / East')).toHaveCount(0);
  await expect(card('AC')).toHaveCount(0);
  await expect(card('AC/DC')).toBeVisible();
  await expect(card('East')).toBeVisible();
  await expect(card('North').locator('small')).toHaveText('2 首歌曲');
  await card('South').press('Enter');
  await expect(content.getByRole('heading', { name: 'South', exact: true })).toBeVisible();
  await expect(titles).toHaveText([title]);
  await expect(content.getByRole('button', { name: title + ' ' + rawCredit, exact: true })).toBeVisible();
  await content.getByRole('button', { name: '查找艺人照片' }).press('Enter');
  await expect.poll(() => portraitQueries.slice()).toEqual([{ artist: 'South', album: 'Split album' }]);
  await page.reload();
  await expect(titles).toHaveText([title]);

  const search = page.locator('#search');
  await search.fill('south');
  await expect(titles).toHaveText([title]);
  await nav('offline').press('Enter');
  const filter = content.getByRole('combobox', { name: '艺人', exact: true });
  await filter.selectOption({ label: 'North' });
  await expect(titles).toHaveText([title]);
  await filter.selectOption({ label: 'AC/DC' });
  await expect(titles).toHaveText(['Band recording']);

  await nav('settings').press('Enter');
  await separators.fill('');
  await save();
  await nav('artists').press('Enter');
  await expect(card(rawCredit)).toBeVisible();
  await expect(card('South')).toHaveCount(0);
  await nav('settings').press('Enter');
  await page.locator('#restore-file').setInputFiles({ name: 'artist-rules-backup.json', mimeType: 'application/json', buffer: backup });
  await expect(separators).toHaveValue('++\n/');
  await expect(exceptions).toHaveValue('ac/dc');
  await nav('artists').press('Enter');
  await expect(card('South')).toBeVisible();
  await expect(card('AC/DC')).toBeVisible();
});
