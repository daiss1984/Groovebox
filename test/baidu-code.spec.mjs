import { expect, test } from '@playwright/test';

test('connects Baidu with a fresh authorization code after a rejected attempt', async ({ page }) => {
  const rejectedMessage = '授权码已失效，请重新获取。';
  const authorizationUrl = state => 'https://openapi.baidu.com/oauth/2.0/authorize?' + new URLSearchParams({
    client_id: 'fixture-app', response_type: 'code', redirect_uri: 'oob', scope: 'basic netdisk', state,
  });
  let connected = false;
  let starts = 0;
  const attempts = [];

  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected, codeAvailable: true } }));
  await page.route('**/api/baidu/code/start', route => {
    expect(route.request().method()).toBe('POST');
    const state = 'fixture-state-' + ++starts;
    return route.fulfill({ json: { authorizeUrl: authorizationUrl(state), state } });
  });
  await page.route('**/api/baidu/code/complete', route => {
    expect(route.request().method()).toBe('POST');
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) return route.fulfill({ status: 400, json: { error: rejectedMessage } });
    connected = true;
    return route.fulfill({ json: { connected: true } });
  });
  await page.route('**/api/baidu/list?**', route => {
    expect(connected).toBe(true);
    expect(new URL(route.request().url()).searchParams.get('path')).toBe('/');
    return route.fulfill({ json: { items: [{ id: '1', name: '授权后的音乐目录', path: '/music', folder: true }] } });
  });

  await page.goto('/#sources');
  await page.getByRole('button', { name: /百度网盘 未连接/ }).press('Enter');
  await page.getByRole('button', { name: '使用百度授权码' }).press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '百度授权码登录' })).toBeVisible();
  const authorize = dialog.getByRole('link', { name: '打开百度授权页面' });
  const code = dialog.getByLabel('百度授权码', { exact: true });
  const complete = dialog.getByRole('button', { name: '连接百度网盘', exact: true });
  await expect(authorize).toHaveAttribute('href', authorizationUrl('fixture-state-1'));
  await expect(authorize).toHaveAttribute('target', '_blank');
  await code.fill('rejected-test-code');
  await complete.press('Enter');
  await expect(dialog.getByText(rejectedMessage)).toBeVisible();

  await dialog.getByRole('button', { name: '重新获取授权页面' }).press('Enter');
  await expect(authorize).toHaveAttribute('href', authorizationUrl('fixture-state-2'));
  await expect(code).toHaveValue('');
  await code.fill('accepted-test-code');
  await complete.press('Enter');

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(url => decodeURIComponent(url.hash) === '#source/baidu');
  await expect(page.getByRole('button', { name: '授权后的音乐目录' })).toBeVisible();
  expect(attempts).toEqual([
    { state: 'fixture-state-1', code: 'rejected-test-code' },
    { state: 'fixture-state-2', code: 'accepted-test-code' },
  ]);
});

test('leaves authorization disabled when the supplied URL is outside the official Baidu flow', async ({ page }) => {
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: false, codeAvailable: true } }));
  await page.route('**/api/baidu/code/start', route => route.fulfill({ json: {
    authorizeUrl: 'https://example.invalid/oauth/2.0/authorize?redirect_uri=oob', state: 'fixture-state',
  } }));

  await page.goto('/#sources');
  await page.getByRole('button', { name: /百度网盘 未连接/ }).press('Enter');
  await page.getByRole('button', { name: '使用百度授权码' }).press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('status')).toHaveText('无法打开百度授权页面。');
  await expect(dialog.getByRole('link', { name: '打开百度授权页面' })).toHaveCount(0);
  await expect(dialog.getByLabel('百度授权码', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '连接百度网盘', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '重新获取授权页面' })).toBeVisible();
});
