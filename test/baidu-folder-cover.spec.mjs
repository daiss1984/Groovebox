import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { updateBuffer } from 'music-metadata';

test('shows Baidu directory artwork and updates the playing cover when rescanning', async ({ page }) => {
  const folder = '/云端唱片';
  const [audio, embedded, jpeg] = await Promise.all(['demo-1.m4a', 'cover-1.jpg', 'cover-2.jpg']
    .map(file => readFile(new URL('../public/assets/' + file, import.meta.url))));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=', 'base64');
  const audioById = new Map(await Promise.all(['First', 'Second', 'Unsafe'].map(async (title, index) => [String(index + 1),
    Buffer.from(await updateBuffer(audio, { title, artist: 'Baidu Test', album: 'Baidu Record',
      ...(index === 1 && { picture: [{ type: 'Cover (front)', format: 'image/jpeg', data: embedded }] }) }))])));
  const coverUrl = version => '/api/baidu/cover?ids=30%2C31&folder=' + 'a'.repeat(22) + '&v=' + version.repeat(22) + '&proof=' + 's'.repeat(43);
  let version = 'p';
  const untrustedRequests = [];
  await page.route('https://untrusted.example/**', route => {
    untrustedRequests.push(route.request().url());
    return route.abort();
  });
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    const tracks = ['First', 'Second', 'Unsafe'].map((title, index) => ({ id: String(index + 1), name: title + '.m4a',
      path: folder + '/' + title + '.m4a', folder: false, streamUrl: '/api/baidu/stream?id=' + (index + 1),
      folderCover: index === 2 ? '/\\untrusted.example/cover.png' : version ? coverUrl(version) : undefined }));
    const items = path === '/' ? [{ id: '10', name: '云端唱片', path: folder, folder: true }] : tracks;
    return route.fulfill({ json: { items } });
  });
  await page.route('**/api/baidu/cover?**', route => {
    const v = new URL(route.request().url()).searchParams.get('v');
    return v === 'p'.repeat(22) ? route.fulfill({ contentType: 'image/png', body: png }) :
      route.fulfill({ contentType: 'image/jpeg', body: jpeg });
  });
  await page.route('**/api/baidu/stream?**', route => {
    const bytes = audioById.get(new URL(route.request().url()).searchParams.get('id'));
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/mp4', body: bytes.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', ...(range && { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }) } });
  });

  const nav = name => page.locator('#sidebar [data-nav="' + name + '"]');
  const content = page.locator('#content');
  const track = name => content.locator('.track-main').filter({ hasText: name });
  const art = name => track(name).locator('img');
  const expectCover = async (image, source) => {
    await expect(image).toHaveAttribute('src', source);
    await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
  };
  await page.goto('/#sources');
  await content.locator('[data-action=baidu-source]').press('Enter');
  await content.getByRole('button', { name: '云端唱片', exact: true }).press('Enter');
  await expectCover(art('First'), coverUrl('p'));
  await expectCover(art('Second'), coverUrl('p'));
  await expect(art('Unsafe')).toHaveCount(0);
  expect(untrustedRequests).toEqual([]);
  await content.getByRole('button', { name: '批量读取音频标签', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('标签读取完成');
  await expectCover(art('Second'), /^data:image\/jpeg;base64,/);
  const supplied = await art('Second').getAttribute('src');
  await content.getByRole('button', { name: '扫描并加入曲库', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toContainText('扫描完成，共找到 3 首歌曲');
  await nav('albums').press('Enter');
  await expectCover(content.getByRole('button', { name: /Baidu Record/ }).locator('img'), supplied);

  await nav('songs').press('Enter');
  await page.reload();
  await expectCover(art('First'), coverUrl('p'));
  await expectCover(art('Second'), supplied);
  await track('First').press('Enter');
  const playerArt = page.locator('#player-art img');
  await expectCover(playerArt, coverUrl('p'));
  const readAudio = () => page.locator('#audio').evaluate(element => ({
    source: element.currentSrc, paused: element.paused, position: element.currentTime,
  }));
  await expect.poll(async () => (await readAudio()).position).toBeGreaterThan(0.1);
  const start = await readAudio();
  const refresh = content.getByRole('button', { name: '刷新曲库', exact: true });
  version = 'j';
  await refresh.press('Enter');
  await expectCover(art('First'), coverUrl('j'));
  await expectCover(playerArt, coverUrl('j'));
  const changed = await readAudio();
  expect(changed).toMatchObject({ source: start.source, paused: false });
  expect(changed.position).toBeGreaterThan(start.position);
  version = '';
  await refresh.press('Enter');
  await expect(art('First')).toHaveCount(0);
  await expect(playerArt).toHaveCount(0);
  await expectCover(art('Second'), supplied);
  await expect.poll(readAudio).toMatchObject({ source: start.source, paused: false });
  await expect.poll(async () => (await readAudio()).position).toBeGreaterThan(changed.position);
  expect(untrustedRequests).toEqual([]);
});
