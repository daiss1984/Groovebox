import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const region = page => page.locator('.immersive');
const now = page => page.locator('#now');
const audio = page => page.locator('#audio');
const setting = page => page.locator('#fullscreen-lyrics-centered');
const open = page => page.locator('#player-art');
const close = page => region(page).locator('.immersive-close button');
const time = page => audio(page).evaluate(element => element.currentTime);

async function fixture(page, language = 'zh-CN', long = false) {
  await page.addInitScript(({ language, long }) => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    const lyrics = [{ time: 0, text: 'Warm opening' }, {
      time: 3, text: 'Morning light', translation: '晨光',
      words: [{ time: 3, text: 'Morning ' }, { time: 3.5, text: 'light' }],
    }, { time: 8, text: 'Evening' }];
    if (long) for (let index = 0; index < 40; index++) lyrics.push({ time: 10 + index, text: 'Later line ' + index });
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      settings: { demos: false, language },
      tracks: [{ id: 'alignment-fixture', provider: 'demo', src: '/assets/demo-1.m4a', lyrics,
        title: 'Alignment Track', artist: 'Fixture Artist' }],
    }));
  }, { language, long });
  await page.goto('/#songs');
  return page.locator('#content').getByRole('button', { name: 'Alignment Track Fixture Artist', exact: true });
}

async function textCenter(locator) {
  return locator.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const bounds = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { text: bounds.left + bounds.width / 2, box: box.left + box.width / 2 };
  });
}

test('centers each immersive lyric and track heading while preserving follow, focus, words and the side panel', async ({ page }) => {
  await (await fixture(page, 'zh-CN', true)).press('Enter');
  await expect.poll(() => time(page)).toBeGreaterThan(0.05);
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => audio(page).evaluate(element => element.paused)).toBe(true);
  await now(page).getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await page.goto('/#settings');
  await expect(page.getByRole('checkbox', { name: '全屏歌词文字居中', exact: true })).not.toBeChecked();
  await page.getByRole('combobox', { name: '歌词字体粗细', exact: true }).selectOption('bold');
  await page.getByRole('checkbox', { name: '模糊未播放歌词', exact: true }).press('Space');
  await audio(page).evaluate(element => { element.currentTime = 3.75; });

  await open(page).press('Enter');
  await expect(close(page)).toBeFocused();
  const trackTitle = region(page).getByRole('heading', { name: 'Alignment Track' });
  const artist = region(page).getByRole('link', { name: 'Fixture Artist' });
  const artistRow = region(page).locator('.immersive-track-copy .hint');
  const warm = region(page).getByRole('button', { name: 'Warm opening', exact: true });
  const evening = region(page).getByRole('button', { name: 'Evening', exact: true });
  const translation = region(page).locator('.lyric-translation');
  const lyrics = region(page).locator('.lyrics');
  const art = region(page).locator('.immersive-art');
  const controls = region(page).locator('.immersive-controls');
  const durationBefore = await audio(page).evaluate(element => element.duration);
  const oldArt = await art.boundingBox();
  const oldControls = await controls.boundingBox();
  await expect(trackTitle).toHaveCSS('text-align', 'left');
  await expect(artistRow).toHaveCSS('text-align', 'left');
  await expect(warm).toHaveCSS('text-align', 'left');
  await expect(region(page).locator('.current-word')).toHaveText('light');
  await lyrics.evaluate(element => { element.scrollTop = 500; });
  const browsed = await lyrics.evaluate(element => element.scrollTop);
  expect(browsed).toBeGreaterThan(300);

  await close(page).press('Enter');
  await expect(open(page)).toBeFocused();
  await setting(page).press('Space');
  await expect(setting(page)).toBeFocused();
  await expect(setting(page)).toBeChecked();
  await expect(now(page).locator('.lyric-line').first()).toHaveCSS('text-align', 'left');
  await expect(now(page).locator('.lyrics-track-heading')).toHaveCSS('text-align', 'left');
  expect(await time(page)).toBeCloseTo(3.75, 1);
  await open(page).press('Enter');
  await expect(close(page)).toBeFocused();
  await expect(lyrics).toHaveJSProperty('scrollTop', browsed);
  await expect(artist).toHaveAttribute('href', '#artist%2FFixture%20Artist');
  await expect(artistRow).toHaveCSS('text-align', 'center');
  for (const element of [trackTitle, artistRow, warm, evening, translation]) {
    await expect(element).toHaveCSS('text-align', 'center');
    const center = await textCenter(element);
    expect(Math.abs(center.text - center.box)).toBeLessThan(2);
  }
  expect(await art.boundingBox()).toEqual(oldArt);
  expect(await controls.boundingBox()).toEqual(oldControls);
  expect(await audio(page).evaluate(element => element.duration)).toBe(durationBefore);
  await expect(translation).toHaveText('晨光');
  await expect(region(page).locator('.current-word')).toHaveText('light');
  await expect(region(page).locator('.current-word')).toHaveCSS('font-weight', '700');
  await expect(warm).toHaveCSS('filter', 'blur(1.25px)');
  await evening.press('Enter');
  await expect.poll(() => time(page)).toBeCloseTo(8, 1);
  await expect(evening).toHaveClass(/current/);

  await close(page).press('Enter');
  await now(page).getByRole('button', { name: '播放队列', exact: true }).press('Enter');
  const preview = now(page).locator('[data-lyric-preview]');
  await expect(preview).toHaveText('Evening');
  await expect(preview).toHaveCSS('text-align', 'left');
});

test('preserves the localized setting across reload and backup while older backups default to off', async ({ page }) => {
  await fixture(page, 'en');
  await page.goto('/#settings');
  const checkbox = page.getByRole('checkbox', { name: 'Center fullscreen lyric text', exact: true });
  await expect(checkbox).not.toBeChecked();
  await checkbox.press('Space');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).press('Enter');
  const path = await (await download).path();
  const backup = JSON.parse(await readFile(path, 'utf8'));
  expect(backup.settings.fullscreenLyricsCentered).toBe(true);
  await page.reload();
  await expect(checkbox).toBeChecked();
  const restore = page.locator('#restore-file');
  delete backup.settings.fullscreenLyricsCentered;
  await restore.setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(checkbox).not.toBeChecked();
  await restore.setInputFiles(path);
  await expect(checkbox).toBeChecked();
});

test('keeps playing when enabling centered lyrics and supports touch-seeking @mobile', async ({ page }) => {
  await (await fixture(page, 'en')).tap();
  await expect.poll(() => time(page)).toBeGreaterThan(0.05);
  await open(page).tap();
  await expect(region(page).locator('.lyric-line').first()).toHaveCSS('text-align', 'left');
  await close(page).tap();
  await page.goto('/#settings');
  const previous = await time(page);
  await setting(page).tap();
  await expect(setting(page)).toBeChecked();
  await expect.poll(() => time(page)).toBeGreaterThan(previous);
  await open(page).tap();
  const target = region(page).getByRole('button', { name: 'Evening', exact: true });
  await expect(target).toHaveCSS('text-align', 'center');
  await target.tap();
  await expect.poll(() => time(page)).toBeGreaterThanOrEqual(8);
  await expect(target).toHaveClass(/current/);
});
