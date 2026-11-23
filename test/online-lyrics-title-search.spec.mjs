import { expect, test } from '@playwright/test';

const title = '晴天';
const now = page => page.locator('#now');
const lyricsDialog = page => page.getByRole('dialog');

async function openTrackWithoutArtist(page) {
  await page.addInitScript(title => {
    const storage = 'groovebox.state.v1';
    if (localStorage.getItem(storage)) return;
    localStorage.setItem(storage, JSON.stringify({
      settings: { demos: false, autoMatchLyrics: true },
      tracks: [{ id: 'title-only-fixture', title, artist: '未知艺人', artistIsFallback: true,
        provider: 'demo', src: '/assets/demo-1.m4a' }],
    }));
  }, title);
  await page.goto('/#songs');
  await page.locator('#content').getByRole('button', { name: '晴天 未知艺人', exact: true }).press('Enter');
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
  await now(page).getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await now(page).getByRole('button', { name: '在线匹配', exact: true }).press('Enter');
  const dialog = lyricsDialog(page);
  await expect(dialog.getByLabel('歌曲名')).toHaveValue(title);
  await expect(dialog.getByLabel('艺人（可选）')).toHaveValue('');
}

test('searches online by title alone and applies only the manually selected lyric version', async ({ page }) => {
  const requests = [];
  await page.route(/^https:\/\/lrclib\.net\/api\/(?:get|search)(?:\?|$)/, route => {
    const request = route.request();
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Lrclib-Client',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const url = new URL(request.url());
    const params = Object.fromEntries(url.searchParams);
    requests.push([url.pathname, params]);
    return route.fulfill({ headers, json: [
      { trackName: title, artistName: 'Artist One', albumName: 'Live', duration: 190, syncedLyrics: '[00:03.00]First version lyrics' },
      { trackName: title, artistName: 'Artist Two', albumName: 'Studio', duration: 160, syncedLyrics: '[00:05.00]Chosen version lyrics' },
      { trackName: title, artistName: 'Instrumental', instrumental: true, plainLyrics: 'No lyrics' },
    ] });
  });
  await openTrackWithoutArtist(page);
  expect(requests).toEqual([]);
  const dialog = lyricsDialog(page);
  await dialog.getByRole('button', { name: '查找歌词', exact: true }).press('Enter');
  await expect(dialog.getByRole('status')).toHaveText('请根据艺人、专辑或时长选择歌曲版本。');
  await expect(dialog.locator('[data-action="choose-lyric-match"]')).toHaveCount(2);
  expect(requests).toEqual([['/api/search', { track_name: title }]]);
  await expect(now(page).getByText('暂无歌词', { exact: true })).toBeVisible();
  const match = dialog.getByRole('button', { name: `${title} · Artist Two · Studio · 2:40`, exact: true });
  await match.press('Enter');
  await expect(now(page).getByRole('button', { name: 'Chosen version lyrics' })).toBeVisible();
  await expect(now(page).getByRole('button', { name: 'First version lyrics' })).toHaveCount(0);
  await page.reload();
  await now(page).getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await expect(now(page).getByRole('button', { name: 'Chosen version lyrics' })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('returns actual LRCLIB lyrics after searching for a Chinese title without artist metadata', async ({ page }) => {
  test.skip(process.env.GROOVEBOX_LRCLIB_LIVE !== '1', 'Set GROOVEBOX_LRCLIB_LIVE=1 to query live LRCLIB.');
  test.setTimeout(30_000);
  await openTrackWithoutArtist(page);
  const attempted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/search' &&
    response.request().method() === 'GET');
  const dialog = lyricsDialog(page);
  await dialog.getByRole('button', { name: '查找歌词', exact: true }).press('Enter');
  expect((await attempted).status()).toBe(200);
  const match = dialog.locator('[data-action="choose-lyric-match"]').filter({ hasText: /周杰[伦倫]|Jay Chou/i }).first();
  await expect(match).toBeVisible();
  await match.press('Enter');
  await expect(now(page).locator('.lyric-line[data-time]').first()).toBeVisible();
});
