import { expect, test } from '@playwright/test';

const layer = page => page.getByRole('region', { name: 'Immersive Player', exact: true });
const trigger = page => page.locator('#player-art');
const toggle = page => layer(page).getByRole('button', { name: 'Lyric Focus', exact: true });
const close = page => layer(page).getByRole('button', { name: 'Close Immersive Player', exact: true });
const time = page => page.locator('#audio').evaluate(audio => audio.currentTime);

async function fixture(page) {
  await page.addInitScript(() => {
    const lyrics = Array.from({ length: 55 }, (_, index) => ({ time: index * 2, text: 'Focus line ' + index }));
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      settings: { demos: false, language: 'en' },
      tracks: [{
        id: 'lyric-focus-fixture', provider: 'demo', title: 'Lyric Focus Track', artist: 'Focus Artist',
        src: '/assets/demo-1.m4a', lyrics,
      }, {
        id: 'lyric-focus-next', provider: 'demo', title: 'Next Fixture', artist: 'Focus Artist',
        src: '/assets/demo-2.m4a',
      }],
    }));
  });
  await page.goto('/#songs');
  return page.locator('#content').getByRole('button', { name: 'Lyric Focus Track Focus Artist', exact: true });
}

test('1. keyboard focus mode hides transport, progress and lyric tools while timed lyrics stay usable', async ({ page, browserName }) => {
  await (await fixture(page)).press('Enter');
  await expect.poll(() => time(page)).toBeGreaterThan(0.1);
  const queue = page.locator('#now .queue-row .track-name');
  const savedQueue = await queue.allTextContents();
  expect(savedQueue).toHaveLength(2);
  await trigger(page).press('Enter');
  await expect(close(page)).toBeFocused();
  const player = page.locator('footer.player');
  const seek = page.locator('#seek');
  const sleep = layer(page).getByRole('button', { name: 'Sleep Timer', exact: true, includeHidden: true });
  const lookup = layer(page).getByRole('button', { name: 'Find lyrics online', exact: true, includeHidden: true });
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(seek).toBeVisible();
  await expect(sleep).toBeVisible();
  await expect(lookup).toBeVisible();

  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
  await expect(toggle(page)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page)).toBeFocused();
  await expect(player).toHaveJSProperty('inert', true);
  await expect(page.locator('.layout')).toHaveJSProperty('inert', true);
  await expect(seek).toBeHidden();
  await expect(page.locator('#current-time')).toBeHidden();
  await expect(sleep).toBeHidden();
  await expect(lookup).toBeHidden();
  await expect(close(page)).toBeVisible();

  const line = layer(page).getByRole('button', { name: 'Focus line 5', exact: true });
  await line.press('Enter');
  await expect.poll(() => time(page)).toBeGreaterThan(10);
  await expect(line).toHaveClass(/current/);
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.paused)).toBe(false);
  const position = await time(page);

  await toggle(page).press('Space');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page)).toBeFocused();
  await expect(seek).toBeVisible();
  await expect(sleep).toBeVisible();
  await expect(lookup).toBeVisible();
  await expect(player).toHaveJSProperty('inert', false);
  await expect(page.locator('.layout')).toHaveJSProperty('inert', false);
  await expect(queue).toHaveText(savedQueue);
  await expect.poll(() => time(page)).toBeGreaterThan(position);
});

test('2. Escape restores controls first and leaving the view restores opener focus', async ({ page }) => {
  await (await fixture(page)).press('Enter');
  await trigger(page).press('Enter');
  await toggle(page).press('Enter');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await toggle(page).press('Escape');
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#seek')).toBeVisible();
  await toggle(page).press('Escape');
  await expect(layer(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();

  await trigger(page).press('Enter');
  await toggle(page).press('Enter');
  await close(page).press('Enter');
  await expect(layer(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await expect(page.locator('footer.player')).toHaveJSProperty('inert', false);
  await trigger(page).press('Enter');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('3. touch restores controls after scrolling long lyrics @mobile', async ({ page }) => {
  await (await fixture(page)).tap();
  const start = await time(page);
  await trigger(page).tap();
  await toggle(page).tap();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#seek')).toBeHidden();
  const lastLine = layer(page).getByRole('button', { name: 'Focus line 54', exact: true });
  await lastLine.scrollIntoViewIfNeeded();
  await expect.poll(() => layer(page).evaluate(element => element.scrollTop)).toBeGreaterThan(200);
  await expect(toggle(page)).toBeInViewport();
  await toggle(page).tap();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#seek')).toBeVisible();
  await expect.poll(() => time(page)).toBeGreaterThan(start);
});
