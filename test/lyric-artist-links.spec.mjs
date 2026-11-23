import { expect, test } from '@playwright/test';

const firstArtist = 'North';
const secondArtist = '南方 & "Guests"';
const audio = page => page.locator('#audio');
const content = page => page.locator('#content');

async function loadTrack(page) {
  await page.addInitScript(({ firstArtist, secondArtist }) => {
    const key = 'groovebox.state.v1';
    if (localStorage.getItem(key)) return;
    const track = (id, title, artist, artistIsFallback = false) => ({
      id, title, artist, artistIsFallback, provider: 'demo', src: '/assets/demo-1.m4a',
      lyrics: [{ time: 0, text: 'Fixture lyrics' }],
    });
    localStorage.setItem(key, JSON.stringify({
      settings: { demos: false, artistRules: { separators: ['/'] } },
      tracks: [track('credited', 'Linked Recording', `${firstArtist} / ${secondArtist}`),
        track('unknown', 'Unknown Recording', '未知艺人', true)],
    }));
  }, { firstArtist, secondArtist });
  await page.goto('/#songs');
  await content(page).getByRole('button', { name: /^Linked Recording/ }).press('Enter');
  await expect.poll(() => audio(page).evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
}

test('aligns lyric headings and opens exact artist pages from either player view', async ({ page }) => {
  await loadTrack(page);
  const now = page.locator('#now');
  await expect(now.getByRole('link', { name: firstArtist, exact: true })).toHaveCount(0);
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await expect(now.locator('.lyrics-track-heading')).toHaveCSS('text-align', 'left');
  const first = now.getByRole('link', { name: firstArtist, exact: true });
  const second = now.getByRole('link', { name: secondArtist, exact: true });
  await expect(first).toHaveAttribute('href', '#' + encodeURIComponent('artist/' + firstArtist));
  await expect(second).toHaveAttribute('href', '#' + encodeURIComponent('artist/' + secondArtist));
  await audio(page).evaluate(element => { element.currentTime = 5; });
  await first.press('Enter');
  await expect(content(page).getByRole('heading', { name: firstArtist, exact: true })).toBeVisible();
  await expect(content(page)).toBeFocused();
  expect(await audio(page).evaluate(element => !element.paused && element.currentTime >= 5)).toBe(true);

  await page.locator('#player-art').press('Enter');
  const immersive = page.locator('.immersive');
  await expect(immersive.locator('.lyrics-track-heading')).toHaveCSS('text-align', 'left');
  await immersive.getByRole('link', { name: secondArtist, exact: true }).press('Enter');
  await expect(immersive).toHaveCount(0);
  await expect(content(page).getByRole('heading', { name: secondArtist, exact: true })).toBeVisible();
  await expect(content(page).locator('.track-name')).toHaveText(['Linked Recording']);
  await expect(page.locator('#player-title')).toHaveText('Linked Recording');
  expect(await audio(page).evaluate(element => !element.paused && element.currentTime >= 5)).toBe(true);

  await page.locator('#sidebar [data-nav="songs"]').press('Enter');
  await content(page).getByRole('button', { name: 'Unknown Recording 未知艺人', exact: true }).press('Enter');
  await expect(now.locator('.lyrics-track-heading p')).toHaveText('未知艺人');
  await expect(now.locator('.lyrics-track-heading a')).toHaveCount(0);
});

test('opens an artist by touch and dismisses the narrow lyrics pane while audio plays @mobile', async ({ page }) => {
  await loadTrack(page);
  const now = page.locator('#now');
  await expect(now).toBeHidden();
  await page.locator('.player [data-action="queue-panel"]').tap();
  await now.getByRole('button', { name: '歌词', exact: true }).tap();
  await now.getByRole('link', { name: secondArtist, exact: true }).tap();
  await expect(now).toBeHidden();
  await expect(content(page).getByRole('heading', { name: secondArtist, exact: true })).toBeVisible();
  await expect(page.locator('#player-title')).toHaveText('Linked Recording');
  expect(await audio(page).evaluate(element => !element.paused && element.currentTime > 0.1)).toBe(true);
});
