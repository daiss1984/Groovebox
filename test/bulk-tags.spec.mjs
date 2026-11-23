import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { updateBuffer } from 'music-metadata';

const names = ['A', 'B', 'C'];
const action = (page, name) => page.locator('#content [data-action=' + name + ']');
const row = (page, title) => page.locator('#content tr').filter({ has: page.getByRole('button', { name: title, exact: true }) });

async function taggedWave(name) {
  const sampleRate = 48_000;
  const pcmBytes = 1_600_000;
  const wave = Buffer.alloc(44 + pcmBytes);
  wave.write('RIFF');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(pcmBytes, 40);
  const year = { A: 2005, B: 1999 }[name];
  return Buffer.from(await updateBuffer(wave, { title: 'Tagged ' + name, artist: 'Fixture', album: 'Fixture ' + name,
    genre: 'Ambient', ...(year && { year }), ...(name === 'B' && { albumartist: 'Fixture Ensemble' }) }));
}

test('reads visible cloud tags in bounded ranges, cancels a pending read and skips saved tags', async ({ page }) => {
  const files = await Promise.all(names.map(taggedWave));
  const library = new Map(names.map((name, index) => ['/music/' + name + '.wav', { name, data: files[index], probes: [] }]));
  const file = name => library.get('/music/' + name + '.wav');
  const listing = '<D:multistatus xmlns:D="DAV:">' + Array.from(library, ([path, entry]) =>
    '<D:response><D:href>' + path + '</D:href><D:propstat><D:prop><D:resourcetype/>' +
    '<D:getcontenttype>audio/wav</D:getcontenttype><D:getcontentlength>' + entry.data.length + '</D:getcontentlength>' +
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>').join('') + '</D:multistatus>';
  let stallB = true;
  let stalledClosed = false;
  const server = createServer((req, res) => {
    if (req.method === 'PROPFIND' && req.url === '/music/') {
      res.writeHead(207, { 'Content-Type': 'application/xml' }).end(listing);
      return;
    }
    const entry = library.get(req.url);
    if (req.method !== 'GET' || !entry) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    entry.probes.push(range ? [Number(range[1]), Number(range[2])] : null);
    if (stallB && entry.name === 'B') {
      res.once('close', () => { stalledClosed = true; });
      return;
    }
    if (!range || Number(range[1]) >= entry.data.length) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + entry.data.length }).end();
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), entry.data.length - 1);
    res.writeHead(206, { 'Accept-Ranges': 'bytes', 'Content-Type': 'audio/wav', 'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + entry.data.length, ETag: '"' + entry.name + '"' });
    res.end(entry.data.subarray(start, end + 1));
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await page.goto('/');
    await page.locator('#sidebar [data-nav=sources]').press('Enter');
    await action(page, 'add-source').press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('名称').fill('Tags WebDAV');
    await dialog.getByLabel('服务地址').fill('http://127.0.0.1:' + server.address().port + '/music/');
    await dialog.getByRole('button', { name: '连接', exact: true }).press('Enter');
    await expect(action(page, 'read-tags-bulk')).toBeEnabled();
    await action(page, 'scan-cloud').press('Enter');
    await expect(page.getByRole('status').filter({ hasText: /扫描完成|已扫描|已加入/ })).toBeVisible();
    await page.locator('#sidebar [data-nav=songs]').press('Enter');

    await row(page, 'A 未知艺人').locator('[data-action=track-menu]').press('Enter');
    await dialog.locator('[data-action=read-tags]').press('Enter');
    await expect(row(page, 'Tagged A Fixture')).toBeVisible();
    const savedProbes = file('A').probes.length;

    await action(page, 'read-tags-bulk').press('Enter');
    await expect.poll(() => file('B').probes.length).toBe(1);
    await expect(page.locator('[data-bulk-tag-status]')).toContainText('1 / 3');
    await action(page, 'cancel-read-tags').press('Enter');
    await expect(page.getByRole('status').filter({ hasText: '已取消批量读取' })).toBeVisible();
    await expect.poll(() => stalledClosed).toBe(true);
    expect(file('A').probes).toHaveLength(savedProbes);
    expect(file('C').probes).toHaveLength(0);

    stallB = false;
    await action(page, 'read-tags-bulk').press('Enter');
    await expect(page.getByRole('status').filter({ hasText: '已更新 2 首，跳过 1 首' })).toBeVisible();
    for (const name of names) {
      const { probes, data } = file(name);
      expect(probes.length).toBeGreaterThan(1);
      expect(probes.length).toBeLessThanOrEqual(24 + Number(name === 'B'));
      expect(probes.every(range => range && range[1] - range[0] + 1 <= 65_536)).toBe(true);
      expect(probes.some(([start]) => start > data.length / 2)).toBe(true);
      expect(probes.reduce((total, [start, end]) => total + end - start + 1, 0)).toBeLessThan(data.length / 4);
      await expect(row(page, 'Tagged ' + name + ' Fixture').getByRole('cell', { name: 'Fixture ' + name, exact: true })).toBeVisible();
    }
    expect(file('A').probes).toHaveLength(savedProbes);
    await expect(action(page, 'read-tags-bulk')).toBeDisabled();
    await page.reload();
    await expect(row(page, 'Tagged C Fixture')).toBeVisible();
    await expect(action(page, 'read-tags-bulk')).toBeDisabled();
    await page.locator('#sidebar [data-nav=albums]').press('Enter');
    await page.getByRole('combobox', { name: '排序', exact: true }).selectOption('release-year');
    const albums = page.locator('#content [data-action=group]').filter({ has: page.getByText(/^Fixture [ABC]$/) });
    await expect(albums.locator('strong')).toHaveText(['Fixture B', 'Fixture A', 'Fixture C']);
    await expect(albums.locator('small')).toHaveText(['1 首歌曲 · 1999 · Fixture Ensemble', '1 首歌曲 · 2005', '1 首歌曲']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
