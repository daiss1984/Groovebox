import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const modeSelect = page => page.getByRole('combobox', { name: 'Word-by-word lyric effect' });
const activeLine = region => region.locator('.lyric-line.current');
const original = line => line.locator('.lyric-words');
const words = line => original(line).locator('.lyric-word');
const clipPercent = text => text.evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue('--word-progress')));
const clock = audio => audio.evaluate(element => element.currentTime);

async function seek(audio, seconds) {
  await audio.evaluate((element, time) => { element.currentTime = time; }, seconds);
  await expect.poll(() => audio.evaluate(element => element.seeking)).toBe(false);
  await expect.poll(() => clock(audio)).toBeCloseTo(seconds, 2);
}

test('renders four timed word effects over local playback and applies the same clock in both lyrics views', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('groovebox.state.v1')) {
      localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: {
        language: 'en', demos: false, autoMatchLyrics: false, onlineCover: false, artistImageEngine: false,
      } }));
    }
  });
  await page.goto('/#songs');
  const fixture = [
    '[00:00]Opening line',
    '[00:04]<00:05>Pine <00:06.50> <00:08>MeadowLong <00:12> <00:13>Dusk<00:14>',
    '[00:22]Plain next line',
    '[00:24]<00:24>Alpha <00:25>BravoLong <00:32>Charlie <00:34>Delta<00:40>',
    ...Array.from({ length: 30 }, (_, index) => '[01:' + String(index).padStart(2, '0') + ']Later line ' + index),
  ].join('\n');
  const sample = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.locator('#import-files').setInputFiles([
    { name: 'Fixture Artist - Word Timing.m4a', mimeType: 'audio/mp4', buffer: sample },
    { name: 'Fixture Artist - Word Timing.lrc', mimeType: 'text/plain', buffer: Buffer.from(fixture) },
  ]);
  await page.locator('#content').getByRole('button', { name: 'Word Timing Fixture Artist', exact: true }).press('Enter');
  const audio = page.locator('#audio');
  await expect.poll(() => clock(audio)).toBeGreaterThan(0.01);
  await page.locator('#player-toggle').press('Enter');
  await expect(audio).toHaveJSProperty('paused', true);
  expect(await audio.evaluate(element => element.duration)).toBeGreaterThan(100);

  const panel = page.locator('#now');
  await panel.getByRole('button', { name: 'Lyrics', exact: true }).press('Enter');
  await page.locator('#sidebar [data-nav=settings]').press('Enter');
  const select = modeSelect(page);
  await expect(select).toHaveValue('opacity-gradient');
  await expect(select.locator('option')).toHaveText(['Off', 'Opacity gradient', 'Slide uniform', 'Slide accurate']);
  const current = activeLine(panel);
  const currentWords = words(current);
  await seek(audio, 4.5);
  await expect(current).toContainText('MeadowLong');
  await expect(currentWords.first()).toHaveCSS('opacity', '0.35');
  await seek(audio, 5);
  await expect(currentWords.first()).toHaveCSS('opacity', '0.5');
  await seek(audio, 5.75);
  await expect(currentWords.first()).toHaveCSS('opacity', '0.75');
  await expect(currentWords.nth(2)).toHaveCSS('opacity', '0.35');
  await seek(audio, 6.9);
  await expect(currentWords.first()).toHaveCSS('opacity', '1');
  await expect(currentWords.nth(2)).toHaveCSS('opacity', '0.35');

  await select.focus();
  await panel.evaluate(element => {
    element.scrollTop = 400;
    window.lyricModeObservation = {
      panel: element, audio: document.querySelector('#audio'), lyrics: element.querySelector('.lyrics'),
      current: element.querySelector('.lyric-line.current'), scrollTop: element.scrollTop,
      source: document.querySelector('#audio').currentSrc,
    };
  });
  await select.selectOption('off');
  await expect(select).toBeFocused();
  await expect(currentWords.nth(2)).toHaveCSS('opacity', '1');
  await expect(currentWords.first()).toHaveCSS('text-decoration-line', 'none');
  expect(await currentWords.nth(2).evaluate(element => getComputedStyle(element).color)).toBe(
    await current.evaluate(element => getComputedStyle(element).color),
  );
  await expect(original(current)).toHaveCSS('background-image', 'none');
  expect(await page.evaluate(() => {
    const before = window.lyricModeObservation;
    const audio = document.querySelector('#audio');
    return before.scrollTop > 100 && before.panel.scrollTop === before.scrollTop &&
      before.lyrics === before.panel.querySelector('.lyrics') &&
      before.current === before.panel.querySelector('.lyric-line.current') &&
      before.audio === audio && before.source === audio.currentSrc;
  })).toBe(true);
  expect(await clock(audio)).toBeCloseTo(6.9, 2);

  await select.selectOption('slide-uniform');
  await expect(original(current)).toHaveCSS('background-clip', 'text');
  await expect(original(current)).toHaveCSS('background-image', /^linear-gradient/);
  await expect(original(current).locator('.lyric-word').nth(2)).toHaveCSS('background-image', 'none');
  await seek(audio, 4.5);
  await expect.poll(() => clipPercent(original(current))).toBe(0);
  await seek(audio, 9.5);
  await expect.poll(() => clipPercent(original(current))).toBeCloseTo(50, 2);
  await seek(audio, 11.75);
  await expect.poll(() => clipPercent(original(current))).toBeCloseTo(75, 2);
  await seek(audio, 15);
  await expect.poll(() => clipPercent(original(current))).toBe(100);
  await expect(current).toContainText('MeadowLong');
  await seek(audio, 22.5);
  await expect(current).toHaveText('Plain next line');
  await expect(original(current)).toHaveCount(0);
  await expect(current).toHaveCSS('background-image', 'none');

  await select.selectOption('slide-accurate');
  await seek(audio, 25.5);
  await expect(current).toHaveText('Alpha BravoLong Charlie Delta');
  await expect.poll(() => clipPercent(original(current))).toBeCloseTo(26.786, 2);
  await seek(audio, 32);
  await expect.poll(() => clipPercent(original(current))).toBeCloseTo(50, 2);
  await seek(audio, 34);
  await expect.poll(() => clipPercent(original(current))).toBeCloseTo(75, 2);
  await seek(audio, 11.75);
  await expect.poll(() => clipPercent(original(current))).toBeGreaterThan(60);
  await seek(audio, 12.125);
  await expect.poll(() => clipPercent(original(current))).toBeCloseTo(37.5, 2);
  await expect(current).toContainText('MeadowLong');

  await page.locator('#player-art').press('Enter');
  const immersive = page.locator('.immersive');
  const fullscreenLine = activeLine(immersive);
  await expect(immersive).toBeVisible();
  await expect.poll(() => clipPercent(original(fullscreenLine))).toBeCloseTo(37.5, 2);
  await immersive.getByRole('button', { name: 'Lyric Timing Offset' }).press('Enter');
  const offsetDialog = page.getByRole('dialog').filter({ hasText: 'Lyric Timing Offset' });
  await offsetDialog.getByRole('spinbutton', { name: 'Offset in milliseconds' }).fill('1000');
  await offsetDialog.getByRole('button', { name: 'Save', exact: true }).press('Enter');
  await expect(offsetDialog).toBeHidden();
  expect(await clock(audio)).toBeCloseTo(12.125, 2);
  // A +1 s setting places the lyric clock at 11.125 s, still inside MeadowLong.
  await expect.poll(() => clipPercent(original(fullscreenLine))).toBeCloseTo(59.375, 2);
  await fullscreenLine.press('Enter');
  await expect.poll(() => clock(audio)).toBeCloseTo(5, 2);
  await expect(fullscreenLine).toContainText('MeadowLong');
  await expect.poll(() => clipPercent(original(fullscreenLine))).toBe(0);
  await expect(audio).toHaveJSProperty('paused', true);

  await immersive.getByRole('button', { name: 'Close Immersive Player' }).press('Enter');
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => clock(audio)).toBeGreaterThan(5.01);
  const playingAt = await clock(audio);
  const playingSource = await audio.evaluate(element => element.currentSrc);
  await select.selectOption('opacity-gradient');
  await expect(audio).toHaveJSProperty('paused', false);
  await expect.poll(() => clock(audio)).toBeGreaterThan(playingAt);
  await expect(audio).toHaveJSProperty('currentSrc', playingSource);
});

test('saves lyric effect selection across reload and complete backup restore', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('groovebox.state.v1')) {
      localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { language: 'en' } }));
    }
  });
  await page.goto('/#settings');
  const select = modeSelect(page);
  await expect(select).toHaveValue('opacity-gradient');
  await select.selectOption('slide-accurate');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).press('Enter');
  const path = await (await downloaded).path();
  const backup = JSON.parse(await readFile(path, 'utf8'));
  expect(backup.settings.lyricWordMode).toBe('slide-accurate');
  await page.reload();
  await expect(select).toHaveValue('slide-accurate');
  await expect(page.locator('html')).toHaveAttribute('data-lyric-word-mode', 'slide-accurate');

  const restore = page.locator('#restore-file');
  delete backup.settings.lyricWordMode;
  await restore.setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(select).toHaveValue('opacity-gradient');
  await expect(page.locator('html')).toHaveAttribute('data-lyric-word-mode', 'opacity-gradient');
  await restore.setInputFiles(path);
  await expect(select).toHaveValue('slide-accurate');
  await expect(page.locator('html')).toHaveAttribute('data-lyric-word-mode', 'slide-accurate');
});
