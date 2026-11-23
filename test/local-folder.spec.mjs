import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('scans a locally selected folder recursively and plays a nested song offline', async ({ page, context }) => {
  const folder = await mkdtemp(join(tmpdir(), 'groovebox-local-scan-'));
  try {
    const nested = join(folder, '唱片', '第二张');
    await mkdir(nested, { recursive: true });
    const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    const nestedOriginal = join(nested, '本地测试艺人 - 子目录歌曲.m4a');
    await Promise.all([
      writeFile(join(folder, '本地测试艺人 - 根目录歌曲.m4a'), audio),
      writeFile(nestedOriginal, audio),
      writeFile(join(nested, '本地测试艺人 - 子目录歌曲.lrc'), '[00:00.00]来自子目录的歌词'),
      writeFile(join(nested, '说明.txt'), '这不是音乐'),
    ]);

    await page.goto('/#offline');
    await expect(page.getByRole('heading', { name: '已下载音乐' })).toBeVisible();
    const [picker] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: '扫描本地文件夹' }).click(),
    ]);
    await picker.setFiles(folder);
    const rootTrack = page.getByRole('button', { name: '根目录歌曲 本地测试艺人' });
    const nestedTrack = page.getByRole('button', { name: '子目录歌曲 本地测试艺人' });
    await expect(rootTrack).toBeVisible();
    await expect(nestedTrack).toBeVisible();
    await expect(page.locator('#content tbody tr')).toHaveCount(2);
    await expect(page).toHaveURL(/#offline$/);

    await page.reload();
    await expect(rootTrack).toBeVisible();
    await expect(nestedTrack).toBeVisible();
    await context.setOffline(true);
    await nestedTrack.click();
    await expect(page.locator('#player-title')).toHaveText('子目录歌曲');
    const player = page.locator('#audio');
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
    expect(await player.evaluate(element => element.currentSrc)).toMatch(/^blob:/);
    await page.locator('#now').getByRole('button', { name: '歌词', exact: true }).click();
    await expect(page.locator('#now').getByRole('button', { name: '来自子目录的歌词' })).toBeVisible();

    const nestedRow = page.locator('#content tbody tr').filter({ has: nestedTrack });
    await nestedRow.getByRole('button', { name: '删除下载' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/保留设备和网盘中的原文件/)).toBeVisible();
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await expect(nestedTrack).toHaveCount(0);
    expect(await readFile(nestedOriginal)).toEqual(audio);
    await expect(rootTrack).toBeVisible();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
