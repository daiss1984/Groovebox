import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Optional fixture: official Subsonic 6.1.6 on loopback, default fixture account
// admin/admin, and indexed "Fixture Artist / Fixture Album / Fixture Track.m4a".
// Give the test the server URL and the path to the original M4A.
const target = process.env.GROOVEBOX_SUBSONIC_TEST_URL;
const sourceFile = process.env.GROOVEBOX_SUBSONIC_TEST_AUDIO;

test('authenticates with classic Subsonic, browses its album and plays original audio', async ({ page, request }) => {
  test.skip(!target || !sourceFile, 'Requires GROOVEBOX_SUBSONIC_TEST_URL and GROOVEBOX_SUBSONIC_TEST_AUDIO fixtures');
  expect(new URL(target).hostname).toBe('127.0.0.1');
  const source = { type: 'subsonic', name: 'Official Subsonic', url: target, username: 'admin' };
  const denied = await request.post('/api/sources', { data: { ...source, password: 'invalid-fixture-password' } });
  expect(denied.status()).toBe(401);

  await page.goto('/#sources');
  await page.getByRole('button', { name: /^添加媒体服务器/ }).press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('协议').selectOption(source.type);
  await dialog.getByLabel('名称', { exact: true }).fill(source.name);
  await dialog.getByLabel('服务地址').fill(source.url);
  await dialog.getByLabel('用户名').fill(source.username);
  await dialog.getByLabel('密码').fill('admin');
  await dialog.getByRole('button', { name: '连接', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: source.name })).toBeVisible();
  await page.getByRole('button', { name: 'Fixture Artist', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Fixture Album', exact: true }).press('Enter');
  await page.getByRole('button', { name: /Fixture Track Fixture Artist/ }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText('Fixture Track');
  const audio = page.locator('#audio');
  await expect.poll(() => audio.evaluate(player => player.currentTime)).toBeGreaterThan(0.2);
  const src = await audio.evaluate(player => player.currentSrc);
  expect(new URL(src).pathname).toMatch(/^\/api\/sources\/[a-z0-9-]+\/stream$/);
  expect(src).not.toContain(source.username);

  const response = await page.request.get(src, { headers: { Range: 'bytes=16-63' } });
  expect(response.status()).toBe(206);
  expect(response.headers()['content-range']).toMatch(/^bytes 16-63\/\d+$/);
  expect(await response.body()).toEqual((await readFile(sourceFile)).subarray(16, 64));
});
