import { expect, test } from '@playwright/test';

test('renders source setup in English and preserves a user-defined Chinese source name', async ({ page }) => {
  const authorizer = 'https://openapi.baidu.com/oauth/2.0/authorize?redirect_uri=oob&state=fixture-state';
  const customName = '我的家用曲库';
  await page.route('**/api/sources', route => route.fulfill({ json: {
    sources: [{ id: 'fixture-webdav', name: customName, type: 'webdav' }],
  } }));
  await page.route('**/api/baidu/status', route => route.fulfill({ json: {
    configured: true, connected: false, codeAvailable: true,
  } }));
  await page.route('**/api/baidu/code/start', route => {
    expect(route.request().method()).toBe('POST');
    return route.fulfill({ json: { authorizeUrl: authorizer, state: 'fixture-state' } });
  });
  await page.route('**/api/baidu/code/complete', route => {
    expect(route.request().postDataJSON()).toEqual({ code: 'fixture-code', state: 'fixture-state' });
    return route.fulfill({ status: 400, json: { error: '授权码已失效，请重新获取。' } });
  });

  await page.goto('/#settings');
  await page.getByLabel('界面语言').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Music Sources' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Music Sources' })).toBeVisible();
  await expect(page.getByRole('button', { name: /我的家用曲库 WebDAV Browse folders and songs/ })).toBeVisible();

  await page.getByRole('button', { name: /^Baidu Netdisk Not connected/ }).press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Connect Baidu Netdisk' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Use a Baidu Authorization Code' }).press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Baidu Authorization Code' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Open Baidu Authorization Page' })).toHaveAttribute('href', authorizer);
  await dialog.getByLabel('Baidu authorization code', { exact: true }).fill('fixture-code');
  await dialog.getByRole('button', { name: 'Connect Baidu Netdisk' }).press('Enter');
  await expect(dialog.getByRole('status')).toHaveText('Baidu authorization failed. Try again.');
  await expect(dialog.getByRole('button', { name: 'Get a New Authorization Page' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: /^Add Media Server/ }).press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Add Media Server' })).toBeVisible();
  await dialog.getByLabel('Protocol').selectOption('fnmusic');
  await expect(dialog.getByText('Enter the Yinqiao OpenSubsonic address', { exact: false })).toBeVisible();
  await expect(dialog.getByLabel('Server URL')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Music Sources' })).toBeVisible();
  await expect(page.getByRole('button', { name: /我的家用曲库/ })).toBeVisible();
});
