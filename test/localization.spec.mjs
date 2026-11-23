import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('switches the settings interface to English, persists it, and switches back', async ({ page }) => {
  await page.goto('/#settings');
  const document = page.locator('html');
  const language = page.locator('#interface-language');
  const settings = page.locator('#content');
  const allTracks = page.locator('#sidebar [data-nav="songs"]');
  await expect(document).toHaveAttribute('lang', 'zh-CN');
  await expect(settings.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(language).toHaveAccessibleName('界面语言');
  await expect(language).toHaveValue('zh-CN');
  await expect(allTracks).toHaveAccessibleName('全部歌曲');
  await expect(language.locator('option[value="zh-CN"]')).toHaveText('简体中文');
  await expect(language.locator('option[value="en"]')).toHaveText('English');

  await language.selectOption('en');
  await expect(document).toHaveAttribute('lang', 'en');
  await expect(language).toHaveAccessibleName('Interface language');
  await expect(allTracks).toHaveAccessibleName('All Tracks');
  await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Ten-band equalizer' })).toBeVisible();
  await expect(settings.getByRole('checkbox', { name: 'Find missing cover art automatically' })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Lavender', exact: true })).toBeVisible();
  await expect(settings.getByRole('combobox', { name: 'Play button style' }).locator('option[value="rounded"]')).toHaveText('Rounded square');

  await page.reload();
  await expect(document).toHaveAttribute('lang', 'en');
  await expect(language).toHaveValue('en');
  await expect(allTracks).toHaveAccessibleName('All Tracks');
  await expect(settings.getByRole('button', { name: 'Export backup', exact: true })).toBeVisible();

  await language.selectOption('zh-CN');
  await expect(document).toHaveAttribute('lang', 'zh-CN');
  await expect(language).toHaveAccessibleName('界面语言');
  await expect(allTracks).toHaveAccessibleName('全部歌曲');
  await expect(settings.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await page.reload();
  await expect(language).toHaveValue('zh-CN');
  await expect(settings.getByRole('button', { name: '导出备份', exact: true })).toBeVisible();
});

test('restores the interface language from a backup and accepts older backup files', async ({ page }) => {
  await page.goto('/#settings');
  const language = page.locator('#interface-language');
  const upload = page.locator('#restore-file');
  const restore = settings => upload.setInputFiles({
    name: 'groovebox-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, playlists: [], settings })),
  });

  await restore({ language: 'en' });
  await expect(language).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  await restore({ theme: 'lavender' });
  await expect(page.getByRole('button', { name: 'Lavender', exact: true })).toHaveClass(/active/);
  await expect(language).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  await restore({ language: 'ja' });
  await expect(language).toHaveValue('ja');
  await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
  await restore({ language: 'ko' });
  await expect(language).toHaveValue('ko');
  await expect(page.getByRole('heading', { name: '설정', exact: true })).toBeVisible();
});

for (const locale of [
  { id: 'ja', name: '日本語', language: '表示言語', allTracks: 'すべての曲', pause: '一時停止', count: '8 曲', sources: '音楽ソース' },
  { id: 'ko', name: '한국어', language: '인터페이스 언어', allTracks: '모든 곡', pause: '일시 정지', count: '8곡', sources: '음악 소스' },
]) {
  test(`switches to ${locale.name} during playback and keeps the language after reload`, async ({ page }) => {
    await page.goto('/#songs');
    await page.locator('#content').getByRole('button', { name: /After Hours Velvet Atlas/ }).press('Enter');
    await expect(page.locator('#player-toggle')).toHaveAccessibleName('暂停');
    await page.locator('#sidebar [data-nav="settings"]').press('Enter');

    const language = page.locator('#interface-language');
    await expect(language.locator(`option[value="${locale.id}"]`)).toHaveText(locale.name);
    await language.selectOption(locale.id);
    await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
    await expect(language).toHaveAccessibleName(locale.language);
    await expect(page.locator('#sidebar [data-nav="songs"]')).toHaveAccessibleName(locale.allTracks);
    await expect(page.locator('#player-toggle')).toHaveAccessibleName(locale.pause);
    await expect(page.locator('#player-title')).toHaveText('After Hours');
    await expect(page.locator('#now').getByText(locale.count, { exact: true })).toBeVisible();

    await page.reload();
    await expect(language).toHaveValue(locale.id);
    await expect(language).toHaveAccessibleName(locale.language);
    await page.locator('#sidebar [data-nav="sources"]').press('Enter');
    await expect(page.locator('#content').getByRole('heading', { name: locale.sources, exact: true })).toBeVisible();
  });
}

test('searches and manages downloaded music in English while keeping song names unchanged', async ({ page }) => {
  await page.goto('/#settings');
  await page.locator('#interface-language').selectOption('en');
  await page.locator('#sidebar [data-nav="offline"]').press('Enter');
  await expect(page.getByRole('heading', { name: 'Downloaded Music', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan Local Folder', exact: true })).toBeVisible();

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Open Local Music', exact: true }).press('Enter'),
  ]);
  const file = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await chooser.setFiles({ name: '原始艺人 - 月光测试曲.m4a', mimeType: 'audio/mp4', buffer: file });
  const track = page.getByRole('button', { name: '月光测试曲 原始艺人', exact: true });
  await expect(track).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search downloaded music', exact: true });
  await search.fill('not a matching track');
  await expect(track).toHaveCount(0);
  await search.fill('月光');
  await expect(track).toBeVisible();

  const category = page.getByRole('combobox', { name: 'Category' });
  await category.selectOption({ label: 'Offline Copies' });
  await expect(track).toHaveCount(0);
  await category.selectOption({ label: 'Local Imports' });
  await expect(track).toBeVisible();

  const item = page.locator('#content tbody tr').filter({ has: track });
  await item.getByRole('button', { name: 'Remove download', exact: true }).press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Remove download', exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
  await expect(track).toHaveCount(0);
});
