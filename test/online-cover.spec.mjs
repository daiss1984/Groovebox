import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { expect, test } from '@playwright/test';

const artist = '海岛 & 乐团';
const firstAlbum = '黄昏 + 现场';
const secondAlbum = '黎明录音';
const firstCover = '/api/artwork/cover?id=905a104c-d081-48ee-8650-d83d59cafe37';
const secondCover = '/api/artwork/cover?id=477c6eb7-f300-4344-8f48-be4de56a31d0';
const builtIn = '/assets/cover-2.jpg';
const brokenOriginal = '/assets/expired-cover.jpg';
const row = (page, title) => page.locator('#content tbody tr').filter({
  has: page.getByRole('button', { name: title + ' ' + artist, exact: true }),
});
const nowCover = page => page.locator('#now button.now-cover img');
const barCover = page => page.locator('#player-art img');

async function mockLibrary(page, legacy = false) {
  if (legacy) await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { onlineCover: false } }));
  });
  const asset = name => readFile(new URL('../public/assets/' + name, import.meta.url));
  const [audio, image] = await Promise.all([asset('demo-1.m4a'), asset('cover-1.jpg')]);
  const lookups = [];
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => route.fulfill({ json: { items: [
    { id: '51', title: '没有原封面的歌曲', album: firstAlbum },
    { id: '52', title: '带有原封面的歌曲', album: firstAlbum, cover: builtIn },
    { id: '53', title: '其他专辑歌曲', album: secondAlbum },
    { id: '54', title: '没有专辑的歌曲' },
    { id: '55', title: '原封面已失效的歌曲', album: secondAlbum, cover: brokenOriginal },
  ].map(item => ({
    artist,
    name: item.title + '.m4a',
    path: '/' + item.title + '.m4a',
    streamUrl: '/api/baidu/stream?id=' + item.id,
    folder: false,
    ...item,
  })) } }));
  await page.route('**/api/baidu/stream?**', route => route.fulfill({ contentType: 'audio/mp4', body: audio }));
  await page.route('**' + brokenOriginal, route => route.fulfill({ status: 404 }));
  await page.route('**/api/artwork/album?**', route => {
    expect(route.request().method()).toBe('GET');
    const params = Object.fromEntries(new URL(route.request().url()).searchParams);
    lookups.push(params);
    return route.fulfill({ json: { cover: params.album === secondAlbum ? secondCover : firstCover } });
  });
  await page.route('**/api/artwork/cover?**', route => route.fulfill({ contentType: 'image/jpeg', body: image }));
  return lookups;
}

async function playTrack(page, title) {
  await row(page, title).getByRole('button', { name: title + ' ' + artist, exact: true }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText(title);
  await expect(page.locator('#player-toggle')).toHaveAccessibleName('暂停');
}

async function showLibrary(page) {
  if (page.url() === 'about:blank') await page.goto('/');
  await page.locator('#sidebar [data-nav="sources"]').press('Enter');
  await page.locator('#content [data-action="baidu-source"]').press('Enter');
  await expect(page.getByRole('heading', { name: '百度网盘', exact: true })).toBeVisible();
}

test('finds an online album cover on request and preserves it across reloads', async ({ page }) => {
  const lookups = await mockLibrary(page, true);
  const title = '没有原封面的歌曲';
  await showLibrary(page);
  await playTrack(page, title);
  expect(lookups).toEqual([]);
  await expect(row(page, title).locator('img')).toHaveCount(0);

  await row(page, title).getByRole('button', { name: '歌曲选项' }).press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '查找在线封面' }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '已显示在线封面。' })).toBeVisible();
  for (const cover of [row(page, title).locator('img'), nowCover(page), barCover(page)]) {
    await expect(cover).toHaveAttribute('src', firstCover);
  }
  await expect.poll(() => barCover(page).evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  expect(lookups).toEqual([{ artist, album: firstAlbum }]);

  await page.reload();
  await expect(row(page, title).locator('img')).toHaveAttribute('src', firstCover);
  await expect(nowCover(page)).toHaveAttribute('src', firstCover);
  await expect(barCover(page)).toHaveAttribute('src', firstCover);
  await row(page, title).getByRole('button', { name: '歌曲选项' }).press('Enter');
  await expect(page.getByRole('dialog').getByRole('button', { name: '查找在线封面' })).toHaveCount(0);
  expect(lookups).toEqual([{ artist, album: firstAlbum }]);
});

test('blocks automatic artwork for one artist and keeps manual requests available', async ({ page }) => {
  const albumRequests = await mockLibrary(page, true);
  const artistRequests = [];
  await page.route('**/api/artwork/artist?**', route => {
    artistRequests.push(new URL(route.request().url()).searchParams.get('artist'));
    return route.fulfill({ status: 404 });
  });

  await showLibrary(page);
  const title = '没有原封面的歌曲';
  await playTrack(page, title);
  const artistUrl = '/#' + encodeURIComponent('artist/' + artist);
  const toggle = page.getByRole('button', { name: '停用自动匹配图片' });
  await page.goto(artistUrl);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.press('Enter');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#sidebar [data-nav="settings"]').press('Enter');
  await page.getByRole('checkbox', { name: '自动查找缺失的在线封面' }).check();
  await page.getByRole('checkbox', { name: '自动查找艺人照片' }).check();
  await page.goto(artistUrl);
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '查找艺人照片' }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '未找到可核实来源的艺人照片' })).toBeVisible();
  expect(artistRequests).toEqual([artist]);

  await showLibrary(page);
  await playTrack(page, title);
  expect(albumRequests).toEqual([]);
  await row(page, title).getByRole('button', { name: '歌曲选项' }).press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '查找在线封面' }).press('Enter');
  await expect(barCover(page)).toHaveAttribute('src', firstCover);
  expect(albumRequests).toEqual([{ artist, album: firstAlbum }]);

  await page.goto(artistUrl);
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await showLibrary(page);
  await playTrack(page, '其他专辑歌曲');
  await expect(barCover(page)).toHaveAttribute('src', secondCover);
  expect(albumRequests).toEqual([{ artist, album: firstAlbum }, { artist, album: secondAlbum }]);
});

test('automatically finds missing covers while retaining a track’s original cover', async ({ page }) => {
  const lookups = await mockLibrary(page, true);
  await showLibrary(page);
  await playTrack(page, '没有原封面的歌曲');
  await page.locator('#sidebar [data-nav="settings"]').press('Enter');
  const setting = page.getByRole('checkbox', { name: '自动查找缺失的在线封面' });
  await expect(setting).not.toBeChecked();
  await setting.press('Space');
  await expect(setting).toBeChecked();
  await expect(barCover(page)).toHaveAttribute('src', firstCover);
  expect(lookups).toEqual([{ artist, album: firstAlbum }]);

  await showLibrary(page);
  const originalTitle = '带有原封面的歌曲';
  await playTrack(page, originalTitle);
  for (const cover of [row(page, originalTitle).locator('img'), nowCover(page), barCover(page)]) {
    await expect(cover).toHaveAttribute('src', builtIn);
  }
  await row(page, originalTitle).getByRole('button', { name: '歌曲选项' }).press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '查找在线封面' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭' }).press('Enter');
  expect(lookups).toEqual([{ artist, album: firstAlbum }]);

  await playTrack(page, '其他专辑歌曲');
  await expect(barCover(page)).toHaveAttribute('src', secondCover);
  expect(lookups).toEqual([{ artist, album: firstAlbum }, { artist, album: secondAlbum }]);
});

test('offers no online lookup when the cloud source name is only a fallback album', async ({ page }) => {
  const lookups = await mockLibrary(page, true);
  await showLibrary(page);
  const fallbackTitle = '没有专辑的歌曲';
  const fallback = row(page, fallbackTitle);
  await expect(fallback.getByRole('cell', { name: '百度网盘', exact: true })).toBeVisible();
  await fallback.getByRole('button', { name: '歌曲选项' }).press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '查找在线封面' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭' }).press('Enter');
  await playTrack(page, fallbackTitle);

  await page.locator('#sidebar [data-nav="settings"]').press('Enter');
  const setting = page.getByRole('checkbox', { name: '自动查找缺失的在线封面' });
  await setting.press('Space');
  await expect(setting).toBeChecked();
  await expect(barCover(page)).toHaveCount(0);
  await showLibrary(page);
  await playTrack(page, '其他专辑歌曲');
  await expect(barCover(page)).toHaveAttribute('src', secondCover);
  await playTrack(page, fallbackTitle);
  await expect(barCover(page)).toHaveCount(0);
  expect(lookups).toEqual([{ artist, album: secondAlbum }]);
});

test('replaces a broken original cover on request without automatically querying', async ({ page }) => {
  const lookups = await mockLibrary(page, true);
  const title = '原封面已失效的歌曲';
  await showLibrary(page);
  await playTrack(page, title);
  await expect(barCover(page)).toHaveCount(0);
  expect(lookups).toEqual([]);

  await row(page, title).getByRole('button', { name: '歌曲选项' }).press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '查找在线封面' }).press('Enter');
  await expect(barCover(page)).toHaveAttribute('src', secondCover);
  await expect.poll(() => barCover(page).evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  expect(lookups).toEqual([{ artist, album: secondAlbum }]);
});

test('automatically replaces a broken original cover after enabling the setting', async ({ page }) => {
  const lookups = await mockLibrary(page, true);
  await page.goto('/#settings');
  const setting = page.getByRole('checkbox', { name: '自动查找缺失的在线封面' });
  await setting.press('Space');
  await expect(setting).toBeChecked();
  await showLibrary(page);
  await playTrack(page, '原封面已失效的歌曲');
  await expect(barCover(page)).toHaveAttribute('src', secondCover);
  expect(lookups).toEqual([{ artist, album: secondAlbum }]);
});

async function seedAlbums(page, entries, onlineCover = false) {
  await page.addInitScript(({ entries, onlineCover }) => {
    const storage = 'groovebox.state.v1';
    if (localStorage.getItem(storage)) return;
    localStorage.setItem(storage, JSON.stringify({
      settings: { demos: false, onlineCover },
      tracks: entries.map((entry, index) => ({
        id: 'artwork-fixture-' + index, title: 'Artwork fixture track ' + (index + 1), provider: 'navidrome',
        albumIsFallback: false, ...entry,
      })),
    }));
  }, { entries, onlineCover });
}

async function openAlbum(page, album) {
  if (page.url() === 'about:blank') await page.goto('/#albums');
  else await page.locator('#sidebar [data-nav="albums"]').press('Enter');
  await page.locator('#content [data-action="group"]').filter({ hasText: album }).press('Enter');
  await expect(page.getByRole('heading', { name: album, exact: true })).toBeVisible();
}

test('finds album artwork without playing a track and restores it to the album detail and grid', async ({ page }) => {
  const lookups = await mockLibrary(page);
  await seedAlbums(page, [{ artist, album: firstAlbum }, { artist, album: firstAlbum }]);
  await openAlbum(page, firstAlbum);
  expect(lookups).toEqual([]);
  await page.getByRole('button', { name: '查找在线封面', exact: true }).press('Enter');
  const detail = page.locator('.album-detail-cover img');
  await expect(detail).toHaveAttribute('src', firstCover);
  await expect.poll(() => detail.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  expect(lookups).toEqual([{ artist, album: firstAlbum }]);
  await page.reload();
  await expect(detail).toHaveAttribute('src', firstCover);
  await page.locator('#sidebar [data-nav="albums"]').press('Enter');
  const card = page.locator('#content [data-action="group"]').filter({ hasText: firstAlbum });
  await expect(card.locator('img')).toHaveAttribute('src', firstCover);
  expect(lookups).toEqual([{ artist, album: firstAlbum }]);
});

test('auto-finds artwork for an exact album and keeps original artwork or ambiguous albums untouched', async ({ page }) => {
  const lookups = await mockLibrary(page);
  const ambiguous = '同名专辑';
  const originalCompilation = '已有封面的多艺人合集';
  const compilation = '合集专辑';
  const compilationArtist = 'Various Artists';
  await seedAlbums(page, [
    { artist, album: firstAlbum }, { artist, album: firstAlbum, cover: builtIn },
    { artist, album: secondAlbum, cover: brokenOriginal },
    { artist, album: ambiguous }, { artist: 'Another Artist', album: ambiguous },
    { artist, album: originalCompilation }, { artist: 'Another Artist', album: originalCompilation, cover: builtIn },
    { artist, album: compilation, albumArtist: compilationArtist },
    { artist: 'Another Artist', album: compilation, albumArtist: compilationArtist },
  ], true);

  await openAlbum(page, firstAlbum);
  await expect(page.locator('.album-detail-cover img')).toHaveAttribute('src', builtIn);
  await expect(page.getByRole('button', { name: '查找在线封面' })).toHaveCount(0);
  expect(lookups).toEqual([]);

  await openAlbum(page, ambiguous);
  await expect(page.locator('.album-detail-cover img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查找在线封面' })).toHaveCount(0);
  expect(lookups).toEqual([]);

  await openAlbum(page, originalCompilation);
  await expect(page.locator('.album-detail-cover img')).toHaveAttribute('src', builtIn);
  await expect(page.getByRole('button', { name: '查找在线封面' })).toHaveCount(0);
  expect(lookups).toEqual([]);

  await openAlbum(page, secondAlbum);
  await expect(page.locator('.album-detail-cover img')).toHaveAttribute('src', secondCover);
  expect(lookups).toEqual([{ artist, album: secondAlbum }]);

  await openAlbum(page, compilation);
  await expect(page.locator('.album-detail-cover img')).toHaveAttribute('src', firstCover);
  expect(lookups).toEqual([{ artist, album: secondAlbum }, { artist: compilationArtist, album: compilation }]);
});

test('album detail loads an actual MusicBrainz and Cover Art Archive image', async ({ page }) => {
  test.skip(process.env.GROOVEBOX_ARTWORK_LIVE !== '1', 'Set GROOVEBOX_ARTWORK_LIVE=1 to query the public artwork providers.');
  test.setTimeout(100_000);
  const album = 'Discovery';
  await seedAlbums(page, [{ artist: 'Daft Punk', album }]);
  await openAlbum(page, album);
  const retryDeadline = Date.now() + 70_000;
  let response;
  for (;;) {
    const lookup = page.waitForResponse(result => new URL(result.url()).pathname === '/api/artwork/album');
    await page.getByRole('button', { name: '查找在线封面', exact: true }).press('Enter');
    response = await lookup;
    if (response.status() !== 429) break;
    const wait = Math.max(1, Number(response.headers()['retry-after']) || 1) * 1000 + 200;
    if (Date.now() + wait > retryDeadline) break;
    await setTimeout(wait);
  }
  expect(response.status()).toBe(200);
  const { cover } = await response.json();
  expect(cover).toMatch(/^\/api\/artwork\/cover\?id=[a-f0-9-]{36}$/);
  const detail = page.locator('.album-detail-cover img');
  await expect(detail).toHaveAttribute('src', cover);
  await expect.poll(() => detail.evaluate(image => image.naturalWidth)).toBeGreaterThan(100);
});
