import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';

test('prepares the next WebDAV audio over bounded ranges and plays it without another request', async ({ page }) => {
  const clip = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const fullRange = 'bytes=0-' + (clip.length - 1);
  const paths = ['/music/A.m4a', '/music/B.m4a'];
  const requests = [];
  const listing = '<D:multistatus xmlns:D="DAV:">' + paths.map(path =>
    '<D:response><D:href>' + path + '</D:href><D:propstat><D:prop><D:resourcetype/>' +
    '<D:getcontenttype>audio/mp4</D:getcontenttype><D:getcontentlength>' + clip.length + '</D:getcontentlength>' +
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>').join('') + '</D:multistatus>';
  const origin = createServer((req, res) => {
    if (req.method === 'PROPFIND' && req.url === '/music/') {
      res.writeHead(207, { 'Content-Type': 'application/xml' }).end(listing);
      return;
    }
    if (req.method !== 'GET' || !paths.includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    const range = req.headers.range;
    requests.push({ path: req.url, range, validator: req.headers['if-range'] });
    const headers = { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', ETag: '"fixture-audio"' };
    if (!range) {
      res.writeHead(200, { ...headers, 'Content-Length': clip.length }).end(clip);
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = match ? Number(match[1]) : clip.length;
    if (start >= clip.length) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + clip.length }).end();
      return;
    }
    const end = match[2] ? Math.min(Number(match[2]), clip.length - 1) : clip.length - 1;
    res.writeHead(206, { ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + clip.length, 'Content-Length': end - start + 1 });
    res.end(clip.subarray(start, end + 1));
  });
  try {
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    await page.goto('/#sources');
    await page.locator('[data-action=add-source]').press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('名称').fill('Preload media');
    await dialog.getByLabel('服务地址').fill('http://127.0.0.1:' + origin.address().port + '/music/');
    await dialog.getByRole('button', { name: '连接', exact: true }).press('Enter');
    const play = page.getByRole('button', { name: 'A 未知艺人', exact: true });
    const trackB = () => requests.filter(request => request.path === paths[1]);
    await expect(play).toBeVisible();
    expect(trackB()).toEqual([]);
    const prefetched = page.waitForEvent('requestfinished', request => request.resourceType() === 'fetch' &&
      request.url().includes('/stream?') && request.headers().range === fullRange);
    await play.press('Enter');
    await prefetched;
    expect(trackB()).toEqual([
      { path: paths[1], range: 'bytes=0-0', validator: undefined },
      { path: paths[1], range: fullRange, validator: '"fixture-audio"' },
    ]);
    const audio = page.locator('#audio');
    await page.getByRole('button', { name: '下一首', exact: true }).press('Enter');
    await expect(page.locator('#player-title')).toHaveText('B');
    await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(.15);
    expect(await audio.evaluate(element => element.currentSrc)).toMatch(/^blob:/);
    expect(trackB()).toHaveLength(2);
  } finally {
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
  }
});
