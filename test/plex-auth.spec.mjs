import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { expect, test } from '@playwright/test';
import { createSourcesHandler } from '../server/sources.mjs';

test('connects through Plex hosted sign-in and plays the explicitly selected server', async ({ page, baseURL }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const pms = 'http://127.0.0.1:32400';
  const accountToken = 'account-token-fixture';
  const serverToken = 'server-token-fixture';
  let clientId;
  const handle = createSourcesHandler({ fetchImpl: async (endpoint, options) => {
    const url = new URL(endpoint);
    const { headers } = options;
    if (url.origin === 'https://plex.tv' && url.pathname === '/api/v2/pins') {
      clientId = headers['X-Plex-Client-Identifier'];
      return Response.json({ id: 42, code: 'fixturepin', expiresIn: 600 });
    }
    if (url.origin === 'https://plex.tv' && url.pathname === '/api/v2/pins/42') {
      expect(headers['X-Plex-Client-Identifier']).toBe(clientId);
      return Response.json({ authToken: accountToken });
    }
    if (url.origin === 'https://clients.plex.tv' && url.pathname === '/api/v2/resources') {
      expect(headers['X-Plex-Token']).toBe(accountToken);
      return Response.json([{ name: 'Fixture media server', provides: 'server', accessToken: serverToken, connections: [{ uri: pms }] }]);
    }
    if (url.origin === 'http://prior.fixture.invalid') {
      expect(headers['X-Plex-Token']).toBe('prior-token-fixture');
      return Response.json({ MediaContainer: { Directory: [] } });
    }
    expect(url.origin).toBe(pms);
    expect(headers['X-Plex-Token']).toBe(serverToken);
    expect(headers['X-Plex-Client-Identifier']).toBe(clientId);
    if (url.pathname === '/library/sections') {
      return Response.json({ MediaContainer: { Directory: [{ type: 'artist', key: '1', title: 'Music' }] } });
    }
    if (url.pathname === '/library/sections/1/all') {
      return Response.json({ MediaContainer: { Metadata: [{
        type: 'track', ratingKey: '92', title: 'Signed-in recording', grandparentTitle: 'Fixture Singer',
        Media: [{ container: 'm4a', Part: [{ key: '/library/parts/recording' }] }],
      }] } });
    }
    expect(url.pathname).toBe('/library/parts/recording');
    return new Response(audio, { headers: { 'Content-Type': 'audio/mp4', 'Content-Length': String(audio.length) } });
  } });
  let origin;
  let setCallback;
  const callback = new Promise(resolve => { setCallback = resolve; });
  const local = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    try {
      if (url.pathname === '/api/sources/plex-auth/start') {
        const end = res.end;
        res.end = function (body, ...args) {
          if (this.statusCode === 200) {
            const auth = new URL(JSON.parse(body).authUrl);
            setCallback(new URLSearchParams(auth.hash.slice(2)).get('forwardUrl'));
          }
          return end.call(this, body, ...args);
        };
      }
      if (await handle(req, res, url)) return;
      const response = await fetch(baseURL + url.pathname + url.search, { method: req.method, redirect: 'manual' });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });
  local.listen(0, '127.0.0.1');
  await once(local, 'listening');
  origin = 'http://127.0.0.1:' + local.address().port;
  try {
    const prior = await page.request.post(origin + '/api/sources', {
      headers: { Origin: origin },
      data: { type: 'plex', name: 'Prior source', url: 'http://prior.fixture.invalid', token: 'prior-token-fixture' },
    });
    expect(prior.status()).toBe(201);
    const initialCookie = (await page.context().cookies()).find(cookie => cookie.name === 'groovebox_sources');
    expect(initialCookie).toBeDefined();
    await page.route('https://app.plex.tv/auth', async route => route.fulfill({
      contentType: 'text/html', body: '<a href="' + await callback + '">Continue as fixture account</a>',
    }));

    await page.goto(origin + '/#sources');
    await expect(page.getByRole('button', { name: /Prior source/ })).toBeVisible();
    await page.getByRole('button', { name: /添加媒体服务器/ }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('协议').selectOption('plex');
    await dialog.getByLabel('名称').fill('Plex name');
    await dialog.getByLabel('访问令牌').fill('must-not-be-sent');
    const [start] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/api/sources/plex-auth/start'),
      dialog.getByRole('button', { name: '使用 Plex 账号登录', exact: true }).press('Enter'),
    ]);
    expect(start.request().postDataJSON()).toEqual({ name: 'Plex name', url: '' });
    const next = new URL(await callback);
    expect(next.origin).toBe(origin);
    await expect(page).toHaveURL(/^https:\/\/app\.plex\.tv\/auth/);
    const [returned] = await Promise.all([
      page.waitForResponse(response => response.url() === next.href),
      page.getByRole('link', { name: 'Continue as fixture account' }).press('Enter'),
    ]);
    expect(returned.status()).toBe(303);
    await expect(dialog.getByRole('heading', { name: '选择 Plex 服务器' })).toBeVisible();
    await expect(page).toHaveURL(origin + '/#sources');
    await dialog.getByRole('button', { name: /Fixture media server.*127\.0\.0\.1/ }).press('Enter');
    await expect(dialog).toBeHidden();
    await page.locator('#content').getByRole('button', { name: 'Music', exact: true }).press('Enter');
    await page.locator('#content').getByRole('button', { name: 'Signed-in recording Fixture Singer' }).press('Enter');
    await expect(page.locator('#player-title')).toHaveText('Signed-in recording');
    await expect.poll(() => page.locator('#audio').evaluate(media => media.currentTime)).toBeGreaterThan(0.05);
    await page.locator('#sidebar [data-nav="sources"]').press('Enter');
    await expect(page.getByRole('button', { name: /Prior source/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Plex name/ })).toBeVisible();
    const finalCookies = await page.context().cookies();
    expect(finalCookies.find(cookie => cookie.name === 'groovebox_sources')?.value).toBe(initialCookie.value);
    expect(finalCookies.some(cookie => cookie.name === 'groovebox_plex_auth')).toBe(false);
  } finally {
    local.closeAllConnections();
    await new Promise(resolve => local.close(resolve));
  }
});
