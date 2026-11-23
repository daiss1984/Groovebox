import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateBuffer } from 'music-metadata';
import { launchSmb2 } from './helpers/smb-fixture.mjs';

const python = process.env.SMB_TEST_PYTHON;
const content = page => page.locator('#content');
const dialog = page => page.getByRole('dialog');
const nav = (page, route) => page.locator('#sidebar [data-nav="' + route + '"]').press('Enter');
const button = (page, label) => content(page).getByRole('button', { name: label, exact: true });
const song = (page, label) => content(page).getByRole('button', { name: label, exact: true });
const readState = page => page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')));

test('keeps real SMB filename rules independent and retains playlist identity, sidecar lyrics and original bytes', async ({ page }) => {
  test.skip(!python, 'Requires SMB_TEST_PYTHON with smbprotocol and impacket');
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), 'groovebox-smb-filename-'));
  const server = launchSmb2(python, root);
  const alphaName = '文件名 SMB Alpha', betaName = '文件名 SMB Beta';
  const alphaFolder = '海湾现场-驻场艺人', betaFolder = '第二张专辑-第二位艺人';
  const targetFile = '10-潮汐-客座歌手.m4a';
  try {
    const share = await server.input;
    const original = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    const tagged = Buffer.from(await updateBuffer(original, { title: '内嵌曲名', artist: '内嵌艺人', album: '内嵌专辑' }));
    const targetPath = join(root, 'first', alphaFolder, targetFile);
    await Promise.all([mkdir(join(root, 'first', alphaFolder), { recursive: true }), mkdir(join(root, 'second', betaFolder), { recursive: true })]);
    await Promise.all([
      writeFile(targetPath, tagged),
      writeFile(join(root, 'first', alphaFolder, '2-开场-客席艺人.m4a'), original),
      writeFile(join(root, 'first', alphaFolder, '10-潮汐-客座歌手.lrc'), '[00:00.00]潮来的时候\n[00:04.00]海湾的声音'),
      writeFile(join(root, 'second', betaFolder, '访客_演唱者.m4a'), original),
    ]);
    await page.addInitScript(() => localStorage.setItem('groovebox.state.v1', localStorage.getItem('groovebox.state.v1') ||
      JSON.stringify({ settings: { demos: false } })));
    const connect = async (branch, name) => {
      await nav(page, 'sources');
      await page.locator('[data-action=add-source]').press('Enter');
      await dialog(page).getByLabel('协议').selectOption('smb');
      await dialog(page).getByLabel('名称').fill(name);
      await dialog(page).getByLabel('服务地址').fill(share.url + '/' + branch);
      await dialog(page).getByLabel('用户名').fill(share.username);
      await dialog(page).getByLabel('密码').fill(share.password);
      await dialog(page).getByRole('button', { name: '连接', exact: true }).press('Enter');
      await expect(content(page).getByRole('heading', { name, exact: true })).toBeVisible();
      return decodeURIComponent(new URL(page.url()).hash).slice('#source/'.length);
    };
    const open = async (name, folder) => {
      await nav(page, 'sources');
      await content(page).locator('.source-card-group').filter({ has: page.getByText(name, { exact: true }) })
        .locator('button.source-card').press('Enter');
      await button(page, folder).press('Enter');
    };
    const rule = async (mode, pattern) => {
      await button(page, '文件名解析').press('Enter');
      await dialog(page).getByLabel('歌曲信息来源').selectOption(mode);
      if (pattern !== undefined) await dialog(page).getByLabel('文件名规则').fill(pattern);
      await dialog(page).getByRole('button', { name: '保存', exact: true }).press('Enter');
      await expect(dialog(page)).toBeHidden();
    };
    const scan = async count => {
      const rescan = content(page).getByRole('button', { name: '重新扫描目录', exact: true });
      await ((await rescan.count()) ? rescan : button(page, '扫描并加入曲库')).press('Enter');
      await expect(page.locator('#toast')).toContainText('扫描完成，共找到 ' + count + ' 首歌曲');
    };
    await page.goto('/#sources');
    const alpha = await connect('first', alphaName);
    await button(page, alphaFolder).press('Enter');
    await expect(song(page, '10-潮汐-客座歌手 未知艺人')).toBeVisible();
    await scan(2);
    await rule('filename', 'track-name-artist');
    await expect(song(page, '潮汐 客座歌手')).toBeVisible();
    await content(page).getByRole('combobox', { name: '排序', exact: true }).selectOption('file-name');
    await expect(content(page).locator('tbody .track-name')).toHaveText(['开场', '潮汐']);
    await scan(2);
    await nav(page, 'songs');
    await expect(song(page, '潮汐 客座歌手')).toBeVisible();
    const stored = (await readState(page)).tracks.find(track => track.title === '潮汐');
    expect(stored.provider).toBe('smb');
    expect(stored.album).toBe('海湾现场');
    expect(stored.src).toContain('/api/sources/' + alpha + '/stream?id=');
    await page.locator('.add-playlist').press('Enter');
    await dialog(page).getByRole('textbox').fill('SMB 曲目身份');
    await dialog(page).getByRole('button', { name: '创建', exact: true }).press('Enter');
    await nav(page, 'songs');
    const row = content(page).locator('tr').filter({ has: page.getByRole('button', { name: '潮汐 客座歌手', exact: true }) });
    await row.getByRole('button', { name: '歌曲选项', exact: true }).press('Enter');
    await dialog(page).getByRole('button', { name: '添加到歌单', exact: true }).press('Enter');
    await dialog(page).getByRole('button', { name: 'SMB 曲目身份', exact: true }).press('Enter');
    await row.getByRole('button', { name: '歌曲选项', exact: true }).press('Enter');
    await dialog(page).getByRole('button', { name: '读取音频标签', exact: true }).press('Enter');
    await expect(page.locator('#toast')).toContainText('已更新歌曲标签');
    await expect(song(page, '潮汐 客座歌手')).toBeVisible();
    await song(page, '潮汐 客座歌手').press('Enter');
    await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
    await page.locator('#now').getByRole('button', { name: '歌词', exact: true }).press('Enter');
    await expect(page.locator('#now').getByRole('button', { name: '潮来的时候', exact: true })).toBeVisible();
    await page.getByRole('contentinfo', { name: '音乐播放器' }).getByRole('button', { name: '暂停', exact: true }).press('Enter');
    const range = await page.request.get(stored.src, { headers: { Range: 'bytes=10-30' } });
    expect(range.status()).toBe(206);
    expect(range.headers()['content-range']).toBe('bytes 10-30/' + tagged.length);
    expect(await range.body()).toEqual(tagged.subarray(10, 31));

    const beta = await connect('second', betaName);
    await button(page, betaFolder).press('Enter');
    await rule('filename', 'name_artist');
    await expect(song(page, '访客 演唱者')).toBeVisible();
    await scan(1);
    await page.reload();
    await button(page, betaFolder).press('Enter');
    await expect(song(page, '访客 演唱者')).toBeVisible();
    const rules = (await readState(page)).settings.sourceFilenameRules;
    expect(rules).toEqual(expect.arrayContaining([
      { id: alpha, mode: 'filename', pattern: 'track-name-artist' },
      { id: beta, mode: 'filename', pattern: 'name_artist' },
    ]));
    await open(alphaName, alphaFolder);
    await expect(song(page, '潮汐 客座歌手')).toBeVisible();
    await rule('tags');
    await expect(song(page, '内嵌曲名 内嵌艺人')).toBeVisible();
    await scan(2);
    await page.locator('#playlist-nav').getByRole('button', { name: 'SMB 曲目身份', exact: true }).press('Enter');
    await expect(song(page, '内嵌曲名 内嵌艺人')).toBeVisible();
    const after = await readState(page);
    expect(after.playlists.find(list => list.name === 'SMB 曲目身份').tracks).toEqual([stored.id]);
    expect(after.tracks.find(track => track.id === stored.id)).toMatchObject({ src: stored.src, title: '内嵌曲名', artist: '内嵌艺人' });
    expect(createHash('sha256').update(await readFile(targetPath)).digest('hex')).toBe(createHash('sha256').update(tagged).digest('hex'));
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
