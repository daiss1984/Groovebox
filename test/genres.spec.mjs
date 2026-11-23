import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function findAtom(buffer, name, start = 0, end = buffer.length) {
  for (let offset = start; offset + 8 <= end;) {
    const size = buffer.readUInt32BE(offset);
    if (size < 8 || offset + size > end) break;
    if (buffer.toString('latin1', offset + 4, offset + 8) === name) return { offset, size };
    offset += size;
  }
  throw new Error(`Missing ${name} atom in the audio fixture`);
}

function atom(name, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length);
  header.write(name, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function addGenres(audio, genres) {
  const parents = [];
  let start = 0;
  let end = audio.length;
  for (const name of ['moov', 'udta', 'meta', 'ilst']) {
    const parent = findAtom(audio, name, start, end);
    parents.push(parent);
    start = parent.offset + (name === 'meta' ? 12 : 8);
    end = parent.offset + parent.size;
  }
  const movie = parents[0];
  const free = findAtom(audio, 'free', movie.offset + movie.size);
  const utf8Type = Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]);
  const genresAtom = atom('©gen', Buffer.concat(genres.map(genre =>
    atom('data', Buffer.concat([utf8Type, Buffer.from(genre)])))));
  if (genresAtom.length > free.size - 8) throw new Error('Insufficient space for fixture tags');

  // Move the metadata boundary into the padding without changing any audio chunk offsets.
  const output = Buffer.concat([audio.subarray(0, end), genresAtom, audio.subarray(end, free.offset),
    atom('free', Buffer.alloc(free.size - genresAtom.length - 8)), audio.subarray(free.offset + free.size)]);
  for (const { offset, size } of parents) output.writeUInt32BE(size + genresAtom.length, offset);
  return output;
}

test('browses, plays and filters imported tracks by their saved audio genres', async ({ page, context }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const tagged = (name, ...genres) => ({
    name: `流派测试艺人 - ${name}.m4a`,
    mimeType: 'audio/mp4',
    buffer: genres.length ? addGenres(audio, genres) : audio,
  });
  const genreNav = page.locator('#sidebar').getByRole('button', { name: '分类', exact: true });
  const content = page.locator('#content');
  const card = genre => content.locator('button.card').filter({ hasText: genre });
  const track = title => content.getByRole('button', { name: `${title} 流派测试艺人`, exact: true });
  const player = page.locator('#audio');
  const jazz = '爵士乐';
  const ambient = '氛围音乐';

  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles([
    tagged('清晨电台', jazz),
    tagged('深夜回声', jazz, ambient),
    tagged('无标签录音'),
  ]);
  await expect(track('清晨电台')).toBeVisible();
  await expect(track('无标签录音')).toBeVisible();
  await genreNav.press('Enter');
  await expect(page).toHaveURL(/#genres$/);
  await card(jazz).press('Enter');
  await expect(page).toHaveURL(/#genre%2F/);
  await expect(content.getByRole('heading', { name: jazz, exact: true })).toBeVisible();
  await expect(track('清晨电台')).toBeVisible();
  await expect(track('深夜回声')).toBeVisible();
  await expect(track('无标签录音')).toHaveCount(0);

  await track('深夜回声').press('Enter');
  await expect(page.locator('#player-title')).toHaveText('深夜回声');
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await page.reload();
  await expect(content.getByRole('heading', { name: jazz, exact: true })).toBeVisible();
  await expect(track('清晨电台')).toBeVisible();
  await expect(track('深夜回声')).toBeVisible();

  await genreNav.press('Enter');
  await card(ambient).press('Enter');
  await expect(content.getByRole('heading', { name: ambient, exact: true })).toBeVisible();
  await expect(track('深夜回声')).toBeVisible();
  await expect(track('清晨电台')).toHaveCount(0);
  await genreNav.press('Enter');
  await card('未分类').press('Enter');
  await expect(content.getByRole('heading', { name: '未分类', exact: true })).toBeVisible();
  await expect(track('无标签录音')).toBeVisible();
  await expect(track('深夜回声')).toHaveCount(0);

  await page.locator('#sidebar').getByRole('button', { name: '已下载音乐', exact: true }).press('Enter');
  await expect(content.getByRole('combobox', { name: '分类', exact: true })).toBeVisible();
  const filter = content.getByRole('combobox', { name: '流派', exact: true });
  await filter.selectOption({ label: ambient });
  await expect(track('深夜回声')).toBeVisible();
  await expect(track('清晨电台')).toHaveCount(0);
  await expect(track('无标签录音')).toHaveCount(0);
  await context.setOffline(true);
  await filter.selectOption({ label: '未分类' });
  await expect(track('深夜回声')).toHaveCount(0);
  await track('无标签录音').press('Enter');
  await expect(page.locator('#player-title')).toHaveText('无标签录音');
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  expect(await player.evaluate(element => element.currentSrc)).toMatch(/^blob:/);
});

test('categorizes a Baidu track after reading its audio tag over HTTP ranges', async ({ page }) => {
  const audio = addGenres(await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url)), ['Fusion']);
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?*', route => route.fulfill({ json: { items: [{
    id: '99', folder: false, name: '云端艺人 - 合奏.m4a', path: '/云端艺人 - 合奏.m4a', streamUrl: '/api/baidu/stream?id=99',
  }] } }));
  const ranges = [];
  await page.route('**/api/baidu/stream?id=99', route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ contentType: 'audio/mp4', body: audio });
    ranges.push(range[0]);
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
    return route.fulfill({ status: 206, contentType: 'audio/mp4',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${audio.length}` },
      body: audio.subarray(start, end + 1),
    });
  });

  await page.goto('/#sources');
  await page.locator('#content [data-action="baidu-source"]').press('Enter');
  await page.getByRole('row', { name: /合奏/ }).getByRole('button', { name: '歌曲选项' }).press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '读取音频标签', exact: true }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '已更新歌曲标签' })).toBeVisible();
  expect(ranges.length).toBeGreaterThan(0);
  await page.locator('#sidebar [data-nav="genres"]').press('Enter');
  await page.locator('#content .card').filter({ hasText: 'Fusion' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Fusion', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '合奏 云端艺人', exact: true }).press('Enter');
  await expect(page.locator('#player-toggle')).toHaveAccessibleName('暂停');
});

test('applies saved literal genre rules across categories, search and offline filters without rewriting tags', async ({ page }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const content = page.locator('#content');
  const nav = name => page.locator('#sidebar [data-nav="' + name + '"]');
  const cardName = name => content.locator('button.card').filter({ has: page.getByText(name, { exact: true }) });
  const titles = content.locator('tbody .track-name');
  const separators = content.getByRole('textbox', { name: '流派分隔符', exact: true });
  const exceptions = content.getByRole('textbox', { name: '不拆分的流派', exact: true });
  const saveRules = () => content.getByRole('button', { name: '保存分类规则' }).press('Enter');
  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles([
    { name: 'Wave Artist - Warm Tide.m4a', mimeType: 'audio/mp4', buffer: addGenres(audio, ['Indie Rock／Jazz', 'Soul++Ambient']) },
    { name: 'Wave Artist - Night Signal.m4a', mimeType: 'audio/mp4', buffer: addGenres(audio, ['R&B／ソウル']) },
  ]);
  await expect(titles.filter({ hasText: 'Night Signal' })).toBeVisible();
  await nav('genres').press('Enter');
  await expect(cardName('Indie Rock／Jazz')).toBeVisible();
  await expect(cardName('Soul++Ambient')).toBeVisible();

  await nav('settings').press('Enter');
  await separators.fill('／\n++');
  await exceptions.fill('r&b／ソウル');
  await saveRules();
  await expect(page.getByRole('status').filter({ hasText: '已保存分类规则' })).toBeVisible();
  const backupReady = page.waitForEvent('download');
  await content.getByRole('button', { name: '导出备份' }).press('Enter');
  const backup = await readFile(await (await backupReady).path());
  expect(JSON.parse(backup).settings.genreRules).toEqual({ separators: ['／', '++'], exceptions: ['r&b／ソウル'] });

  await nav('genres').press('Enter');
  await expect(cardName('Indie Rock／Jazz')).toHaveCount(0);
  await expect(cardName('Soul++Ambient')).toHaveCount(0);
  await expect(cardName('Jazz')).toBeVisible();
  await expect(cardName('R&B／ソウル')).toBeVisible();
  await expect(cardName('ソウル')).toHaveCount(0);
  await cardName('Ambient').press('Enter');
  await expect(titles).toHaveText(['Warm Tide']);
  await page.reload();
  await expect(titles).toHaveText(['Warm Tide']);

  const search = page.locator('#search');
  await search.fill('Indie Rock／Jazz');
  await expect(titles).toHaveCount(0);
  await search.fill('Jazz');
  await expect(titles).toHaveText(['Warm Tide']);
  await nav('offline').press('Enter');
  const filter = content.getByRole('combobox', { name: '流派', exact: true });
  await filter.selectOption({ label: 'R&B／ソウル' });
  await expect(titles).toHaveText(['Night Signal']);
  await filter.selectOption({ label: 'Jazz' });
  await expect(titles).toHaveText(['Warm Tide']);

  await nav('settings').press('Enter');
  await separators.fill('');
  await exceptions.fill('');
  await saveRules();
  await nav('genres').press('Enter');
  await expect(cardName('Indie Rock／Jazz')).toBeVisible();
  await expect(cardName('Jazz')).toHaveCount(0);
  await nav('settings').press('Enter');
  await page.locator('#restore-file').setInputFiles({ name: 'genre-backup.json', mimeType: 'application/json', buffer: backup });
  await expect(separators).toHaveValue('／\n++');
  await expect(exceptions).toHaveValue('r&b／ソウル');
  await nav('genres').press('Enter');
  await expect(cardName('Jazz')).toBeVisible();
  await expect(cardName('Indie Rock／Jazz')).toHaveCount(0);
});
