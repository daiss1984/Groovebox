import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

const folderUrl = path => '/#' + encodeURIComponent('local-folder/' + path);
const resume = page => page.getByRole('button', { name: '继续播放目录', exact: true });
const currentTitle = page => page.locator('#player-title');
const audio = page => page.locator('#audio');
const currentTime = page => audio(page).evaluate(element => element.currentTime);

async function jumpTo(page, seconds) {
  await expect.poll(() => audio(page).evaluate(element => element.duration)).toBeGreaterThan(seconds);
  await page.locator('#seek').evaluate((control, target) => {
    control.value = String(target / document.querySelector('#audio').duration * 1000);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  }, seconds);
  await expect.poll(() => currentTime(page)).toBeGreaterThan(seconds - 1);
}

test('remembers separate local folder positions after switching folders and refreshing', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-folder-resume-'));
  const root = join(directory, 'Library');
  try {
    const original = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
    for (const [name, titles] of [['Book A', ['Chapter One', 'Chapter Two']], ['Book B', ['Other Story']]]) {
      const target = join(root, name);
      await mkdir(target, { recursive: true });
      for (const [index, title] of titles.entries()) {
        await writeFile(join(target, (index + 1) + '.m4a'), await updateBuffer(original, { title }));
      }
    }

    await page.goto('/#songs');
    await page.locator('#import-folder').setInputFiles(root);
    await expect(page.locator('#content').getByText('Chapter Two', { exact: true })).toBeVisible();
    await page.goto(folderUrl('Library/Book A'));
    await expect(resume(page)).toBeDisabled();
    await page.locator('#content .track-main').filter({ hasText: 'Chapter Two' }).press('Enter');
    await expect.poll(() => currentTime(page)).toBeGreaterThan(0);
    await jumpTo(page, 47);

    await page.goto(folderUrl('Library/Book B'));
    await expect(resume(page)).toBeDisabled();
    await page.getByRole('button', { name: '全部播放', exact: true }).press('Enter');
    await expect(currentTitle(page)).toHaveText('Other Story');
    await expect.poll(() => currentTime(page)).toBeGreaterThan(0);
    await jumpTo(page, 19);

    await page.reload();
    await page.goto(folderUrl('Library/Book A'));
    await resume(page).press('Enter');
    await expect(currentTitle(page)).toHaveText('Chapter Two');
    await expect.poll(() => currentTime(page)).toBeGreaterThan(46);
    expect(await currentTime(page)).toBeLessThan(50);
    await expect.poll(() => audio(page).evaluate(element => element.paused)).toBe(false);

    await page.goto(folderUrl('Library/Book B'));
    await resume(page).press('Enter');
    await expect(currentTitle(page)).toHaveText('Other Story');
    await expect.poll(() => currentTime(page)).toBeGreaterThan(18);
    expect(await currentTime(page)).toBeLessThan(23);

    await page.getByRole('button', { name: '全部播放', exact: true }).press('Enter');
    await expect.poll(() => currentTime(page)).toBeLessThan(2);
    await expect(resume(page)).toBeEnabled();
    await expect.poll(() => currentTime(page)).toBeGreaterThan(0);
    await audio(page).evaluate(element => { element.currentTime = element.duration - .2; });
    await expect.poll(() => audio(page).evaluate(element => element.ended)).toBe(true);
    await expect(resume(page)).toBeDisabled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
