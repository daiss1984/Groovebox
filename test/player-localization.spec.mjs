import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('localizes the player, lyrics dialog, queue, and casting without translating track data', async ({ page }) => {
  const clip = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.addInitScript(() => {
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      settings: { demos: false },
      tracks: [
        { id: 'locale-a', provider: 'jellyfin', src: '/api/sources/mock/stream?id=a',
          title: '海边录音', artist: '演奏者', album: '独立唱片', albumIsFallback: false },
        {
          id: 'locale-b', provider: 'jellyfin', src: '/api/sources/mock/stream?id=b', title: '下一首录音', artist: '演奏者',
          lyrics: [{ time: 1, text: '这行歌词不能翻译' }],
        },
      ],
    }));
  });
  await page.route('**/api/sources/mock/stream?*', route => route.fulfill({ body: clip, contentType: 'audio/mp4' }));
  await page.route('**/api/cast/devices', route => route.fulfill({ json: { devices: [{ id: 'local-fixture', name: '我的音响' }] } }));

  await page.goto('/#songs');
  await expect(page.locator('#now')).toHaveAccessibleName('正在播放');
  await page.locator('#content').getByRole('button', { name: '海边录音 演奏者' }).press('Enter');
  await expect(page.locator('#player-toggle')).toHaveAccessibleName('暂停');
  await page.locator('#sidebar [data-nav="settings"]').press('Enter');
  await page.locator('#interface-language').selectOption('en');

  const now = page.locator('#now');
  await expect(now.getByRole('heading', { name: 'Now Playing' })).toBeVisible();
  await expect(page.locator('#player-toggle')).toHaveAccessibleName('Pause');
  await expect(page.locator('#player-title')).toHaveText('海边录音');
  await expect(page.locator('#player-artist')).toHaveText('演奏者');
  await expect(now.getByText('2 tracks')).toBeVisible();
  await now.getByRole('button', { name: 'Queue options' }).first().press('Enter');
  const dialog = page.locator('#dialog');
  await expect(dialog.getByRole('button', { name: 'Move down' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove from queue' })).toBeVisible();
  await page.keyboard.press('Escape');

  await now.getByRole('button', { name: 'Lyrics', exact: true }).press('Enter');
  await expect(now.getByText('No lyrics available')).toBeVisible();
  await now.getByRole('button', { name: 'Find lyrics online' }).press('Enter');
  await expect(dialog.getByLabel('Song title')).toHaveValue('海边录音');
  await expect(dialog.getByLabel('Artist')).toHaveValue('演奏者');
  await expect(dialog.getByLabel('Album (optional)')).toHaveValue('独立唱片');
  await expect(dialog.getByRole('button', { name: 'Search lyrics' })).toBeVisible();
  await page.keyboard.press('Escape');

  await now.getByRole('button', { name: 'Local network DLNA' }).press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Cast on local network' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '我的音响' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.locator('#sidebar [data-nav="songs"]').press('Enter');
  await page.locator('#content').getByRole('button', { name: '下一首录音 演奏者' }).press('Enter');
  await expect(now.getByRole('button', { name: '这行歌词不能翻译' })).toBeVisible();
  await page.locator('#player-art').press('Enter');
  await expect(page.getByRole('region', { name: 'Immersive Player' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close Immersive Player' })).toBeVisible();
});
