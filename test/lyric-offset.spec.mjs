import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const openOffset = container => container.getByRole('button', { name: '歌词时间偏移', exact: true }).press('Enter');
const offsetDialog = page => page.getByRole('dialog').filter({
  has: page.getByRole('heading', { name: '歌词时间偏移', exact: true }),
});
const readTime = audio => audio.evaluate(element => element.currentTime);
const at = (audio, seconds) => audio.evaluate((element, value) => { element.currentTime = value; }, seconds);
const currentLine = container => container.locator('.lyric-line.current');

async function saveOffset(dialog) {
  await dialog.getByRole('button', { name: '保存', exact: true }).press('Enter');
  await expect(dialog).not.toBeVisible();
}

test('shifts line and word timing, inversely seeks, and saves the signed offset across reload', async ({ page }) => {
  await page.goto('/#songs');
  const sample = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const lyrics = [
    '[offset:200]',
    '[00:00.00]起始句',
    '[00:05.00]<00:05.00>云海 <00:05.45>长歌',
    '[00:06.15]结尾句',
  ].join('\n');
  await page.locator('#import-files').setInputFiles([
    { name: '测试艺人 - 偏移测试.m4a', mimeType: 'audio/mp4', buffer: sample },
    { name: '测试艺人 - 偏移测试.lrc', mimeType: 'text/plain', buffer: Buffer.from(lyrics) },
  ]);
  await page.locator('#content').getByRole('button', { name: '偏移测试 测试艺人', exact: true }).press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => readTime(audio)).toBeGreaterThan(0);
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => audio.evaluate(element => element.paused)).toBe(true);
  const now = page.locator('#now');
  const lyricsTab = now.getByRole('button', { name: '歌词', exact: true });
  await lyricsTab.press('Enter');

  await at(audio, 5.84);
  await expect(currentLine(now).locator('.current-word')).toHaveText('长歌');
  await openOffset(now);
  const options = offsetDialog(page);
  const value = options.getByRole('spinbutton', { name: '歌词偏移毫秒数' });
  await expect(value).toHaveValue('0');
  const delay = options.getByRole('button', { name: '延后 100 毫秒' });
  for (let step = 0; step < 6; step++) await delay.press('Enter');
  await expect(value).toHaveValue('600');
  await saveOffset(options);
  expect(await readTime(audio)).toBeCloseTo(5.84, 1);
  await expect(currentLine(now).locator('.current-word')).toHaveText('云海');

  await at(audio, 5.5);
  await expect(currentLine(now)).toHaveText('起始句');
  await now.getByRole('button', { name: '播放队列', exact: true }).press('Enter');
  await expect(now.getByRole('button', { name: '打开歌词', exact: true })).toHaveText('起始句');
  await lyricsTab.press('Enter');
  await now.getByRole('button', { name: /云海/ }).press('Enter');
  await expect.poll(() => readTime(audio)).toBeCloseTo(5.8, 1);

  await page.locator('#player-art').press('Enter');
  const immersive = page.getByRole('region', { name: '沉浸播放', exact: true });
  await openOffset(immersive);
  await expect(value).toHaveValue('600');
  await value.fill('-500');
  await options.getByRole('button', { name: '提前 100 毫秒' }).press('Enter');
  await expect(value).toHaveValue('-600');
  await saveOffset(options);
  expect(await readTime(audio)).toBeCloseTo(5.8, 1);
  await expect(currentLine(immersive)).toHaveText('结尾句');
  await immersive.getByRole('button', { name: /云海/ }).press('Enter');
  await expect.poll(() => readTime(audio)).toBeCloseTo(4.6, 1);
  await immersive.getByRole('button', { name: '关闭沉浸播放', exact: true }).press('Enter');
  await page.locator('#sidebar [data-nav=settings]').press('Enter');
  const backup = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份', exact: true }).press('Enter');
  const backupFile = await (await backup).path();

  await page.reload();
  await expect(page.locator('#player-title')).toHaveText('偏移测试');
  await expect.poll(() => readTime(audio)).toBeCloseTo(4.6, 1);
  await lyricsTab.press('Enter');
  await at(audio, 5.0);
  await expect(currentLine(now)).toHaveText('云海 长歌');
  await openOffset(now);
  await expect(value).toHaveValue('-600');
  await options.getByRole('button', { name: '归零' }).press('Enter');
  await expect(value).toHaveValue('0');
  await saveOffset(options);
  await expect(currentLine(now)).toHaveText('起始句');
  expect(await readTime(audio)).toBeCloseTo(5, 1);
  expect(await audio.evaluate(element => element.paused)).toBe(true);

  await page.locator('#restore-file').setInputFiles(backupFile);
  await expect(page.locator('#toast')).toHaveText('备份已恢复。');
  await openOffset(page.locator('#content'));
  await expect(value).toHaveValue('-600');
});
