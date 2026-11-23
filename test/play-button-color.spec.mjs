import { expect, test } from '@playwright/test';

const playButton = page => page.locator('#player-toggle');
const setting = page => page.getByRole('checkbox', { name: '播放键颜色跟随封面', exact: true });

async function seedCoverTracks(page) {
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (localStorage.getItem(key)) return;
    const image = color => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 16;
      if (color) {
        const context = canvas.getContext('2d');
        context.fillStyle = color;
        context.fillRect(0, 0, 16, 16);
      }
      return canvas.toDataURL('image/png');
    };
    const fixtures = [
      ['Blue Fixture', image('rgb(30, 110, 200)')],
      ['Green Fixture', image('rgb(70, 170, 90)')],
      ['Transparent Fixture', image()],
      ['No Cover Fixture', undefined],
    ];
    localStorage.setItem(key, JSON.stringify({
      settings: { demos: false }, tracks: fixtures.map(([title, cover], index) => ({
        id: `color-fixture-${index}`, title, cover, artist: 'Fixture Artist', provider: 'demo', src: '/assets/demo-1.m4a',
      })),
    }));
  });
}

async function play(page, title) {
  const songs = page.locator('#sidebar [data-nav="songs"]');
  if (await songs.getAttribute('aria-current') !== 'page') await songs.press('Enter');
  await page.locator('#content').getByRole('button', { name: `${title} Fixture Artist`, exact: true }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText(title);
}

test('matches the play button to each cover and restores the selected theme for missing artwork', async ({ page }) => {
  await seedCoverTracks(page);
  await page.goto('/#songs');
  const button = playButton(page);
  const themeColor = 'rgb(250, 155, 114)';
  await play(page, 'Blue Fixture');
  await expect(button).toHaveCSS('background-color', themeColor);
  await page.locator('#sidebar [data-nav="settings"]').press('Enter');
  await expect(setting(page)).not.toBeChecked();
  await setting(page).press('Space');
  await expect(button).toHaveCSS('background-color', 'rgb(30, 110, 200)');
  await expect(button).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect.poll(() => page.locator('html').evaluate(element => element.style.getPropertyValue('--accent'))).toBe('#fa9b72');

  await play(page, 'Green Fixture');
  await expect(button).toHaveCSS('background-color', 'rgb(70, 170, 90)');
  await expect(button).toHaveCSS('color', 'rgb(0, 0, 0)');
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(button).toHaveCSS('background-color', 'rgb(70, 170, 90)');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(page.locator('#player-title')).toHaveText('Green Fixture');
  await expect(button).toHaveCSS('background-color', 'rgb(70, 170, 90)');
  await page.locator('#sidebar [data-nav="settings"]').press('Enter');
  await expect(setting(page)).toBeChecked();
  await page.getByLabel('播放按钮样式').selectOption('outline');
  await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(button).toHaveCSS('border-top-color', 'rgb(70, 170, 90)');
  await play(page, 'Transparent Fixture');
  await expect(button).toHaveCSS('border-top-color', themeColor);
  await play(page, 'No Cover Fixture');
  await expect(button).toHaveCSS('border-top-color', themeColor);
  await play(page, 'Green Fixture');
  await expect(button).toHaveCSS('border-top-color', 'rgb(70, 170, 90)');
  await page.locator('#sidebar [data-nav="settings"]').press('Enter');
  await setting(page).press('Space');
  await expect(button).toHaveCSS('border-top-color', themeColor);
});
