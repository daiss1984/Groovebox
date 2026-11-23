import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createOnedriveHandler } from '../server/onedrive.mjs';

test('indexes OneDrive Personal tags without downloading audio and honors the filename rule', async ({ page, baseURL }) => {
  const root = 'ABCD!1';
  const tagged = 'ABCD!2';
  const plain = 'ABCD!3';
  const filename = '原文件曲名-原文件艺人.m4a';
  let origin;
  let handle;
  const upstreamPaths = [];
  const streamRequests = [];
  const app = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === '/api/onedrive/stream') streamRequests.push(url.search);
      if (await handle(req, res, url)) return;
      const asset = await fetch(new URL(req.url, baseURL));
      const headers = Object.fromEntries([...asset.headers].filter(([key]) => ['content-security-policy', 'content-type'].includes(key)));
      res.writeHead(asset.status, headers);
      if (!asset.body || req.method === 'HEAD') return res.end();
      Readable.fromWeb(asset.body).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  origin = 'http://127.0.0.1:' + app.address().port;
  handle = createOnedriveHandler({
    env: {
      ONEDRIVE_CLIENT_ID: 'synthetic-client', ONEDRIVE_CLIENT_SECRET: 'fixture-only-secret',
      ONEDRIVE_REDIRECT_URI: origin + '/api/onedrive/callback',
    },
    async request(url) {
      if (url.hostname === 'login.microsoftonline.com') {
        return Response.json({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_in: 3600 });
      }
      upstreamPaths.push(url.pathname);
      if (!url.searchParams.get('$select')?.split(',').includes('audio')) return new Response(null, { status: 400 });
      if (url.pathname === '/v1.0/me/drive/root/children') {
        return Response.json({ value: [{ id: root, name: '测试目录', folder: {} }] });
      }
      if (url.pathname === '/v1.0/me/drive/items/' + root + '/children') {
        return Response.json({ value: [
          { id: tagged, name: filename, file: {}, audio: {
            title: '标签曲名', artist: '标签艺人', album: '标签专辑', albumArtist: '专辑艺人', duration: 184250,
          } },
          { id: plain, name: '文件名艺人 - 无标签曲名.flac', file: {} },
          { id: 'ABCD!4', name: filename.replace('.m4a', '.lrc'), file: {} },
        ] });
      }
      return new Response(null, { status: 404 });
    },
  });

  try {
    const connected = await page.request.get(origin + '/api/onedrive/connect', { maxRedirects: 0 });
    expect(connected.status()).toBe(303);
    const state = new URL(connected.headers().location).searchParams.get('state');
    const callback = await page.request.get(origin + '/api/onedrive/callback?' + new URLSearchParams({ state, code: 'fixture' }),
      { maxRedirects: 0 });
    expect(callback.headers().location).toBe('/?onedrive=connected');
    await page.addInitScript(() => {
      const key = 'groovebox.state.v1';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { demos: false, autoReadTags: false } }));
    });
    const content = page.locator('#content');
    const button = name => content.getByRole('button', { name, exact: true });
    const track = id => page.evaluate(id => JSON.parse(localStorage.getItem('groovebox.state.v1')).tracks
      .find(row => row.id === 'onedrive:' + id), id);
    const openFolder = async () => {
      await page.locator('#sidebar [data-nav="sources"]').click();
      await content.locator('[data-action="oauth-source"][data-id="onedrive"]').click();
      await button('测试目录').click();
    };
    await page.goto(origin + '/#sources');
    await openFolder();
    await expect(button('标签曲名 标签艺人')).toBeVisible();
    await button('扫描并加入曲库').click();
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 2 首歌曲');
    expect(await track(tagged)).toMatchObject({
      title: '标签曲名', artist: '标签艺人', album: '标签专辑', albumArtist: '专辑艺人', duration: 184.25,
      path: tagged, fileName: filename, src: '/api/onedrive/stream?id=' + tagged,
      lyrics: '/api/onedrive/stream?id=ABCD!4',
    });
    expect(await track(plain)).toMatchObject({ title: '无标签曲名', artist: '文件名艺人', album: 'OneDrive' });
    await page.locator('#sidebar [data-nav="songs"]').click();
    await page.reload();
    await expect(button('标签曲名 标签艺人')).toBeVisible();
    await expect(button('无标签曲名 文件名艺人')).toBeVisible();

    await openFolder();
    await button('文件名解析').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('歌曲信息来源').selectOption('filename');
    await dialog.getByLabel('文件名规则').fill('name-artist');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(button('原文件曲名 原文件艺人')).toBeVisible();
    await button('重新扫描目录').click();
    await expect(page.locator('#toast')).toContainText('扫描完成，共找到 2 首歌曲');
    expect(await track(tagged)).toMatchObject({ title: '原文件曲名', artist: '原文件艺人', duration: 184.25 });
    expect(streamRequests).toEqual([]);
    expect(upstreamPaths).toContain('/v1.0/me/drive/items/' + root + '/children');
    expect(upstreamPaths.every(path => path.endsWith('/children'))).toBe(true);
  } finally {
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  }
});
