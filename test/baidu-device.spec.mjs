import { expect, test } from '@playwright/test';

const officialPage = 'https://openapi.baidu.com/device';
const firstState = 'A'.repeat(43);
const secondState = 'B'.repeat(43);

async function mockBaidu(page, poll, options = {}) {
  const requests = { polls: [], starts: 0, list: [], connected: false };
  await page.route('**/api/baidu/status', route => route.fulfill({
    json: { configured: true, connected: requests.connected, codeAvailable: true, deviceAvailable: true },
  }));
  await page.route('**/api/baidu/device/start', route => {
    expect(route.request().method()).toBe('POST');
    const first = ++requests.starts === 1;
    return route.fulfill({ json: {
      state: first ? firstState : secondState,
      userCode: first ? 'FIX-1234' : 'FIX-5678',
      verificationUrl: options.verificationUrl ?? officialPage,
      expiresIn: 300,
      interval: 5,
    } });
  });
  await page.route('**/api/baidu/device/poll', route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['content-type']).toBe('application/json');
    requests.polls.push(route.request().postDataJSON());
    const response = poll(requests.polls.length);
    if (response.json?.status === 'authorized') requests.connected = true;
    return route.fulfill(response);
  });
  await page.route('**/api/baidu/list?**', route => {
    requests.list.push(new URL(route.request().url()).searchParams.get('path'));
    expect(requests.connected).toBe(true);
    return route.fulfill({ json: { items: [
      { id: 'music', name: '设备授权后的音乐目录', path: '/music', folder: true },
    ] } });
  });
  return requests;
}

async function openDeviceFlow(page) {
  const now = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  await page.goto('/#sources');
  await page.getByRole('button', { name: /百度网盘 未连接/ }).press('Enter');
  await page.getByRole('button', { name: '使用百度设备授权' }).press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '百度设备授权' })).toBeVisible();
  return dialog;
}

async function pollAfter(page, milliseconds) {
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/baidu/device/poll'),
    page.clock.runFor(milliseconds),
  ]);
  await response.finished();
}

test('opens the official device page and polls until it can browse the Baidu root', async ({ page, context }) => {
  const requests = await mockBaidu(page, attempt => ({
    json: attempt === 1 ? { status: 'pending', retryAfter: 8 } : { status: 'authorized' },
  }));
  await context.route(officialPage, route => route.fulfill({
    contentType: 'text/html',
    body: '<title>Baidu device fixture</title>',
  }));

  const dialog = await openDeviceFlow(page);
  const link = dialog.getByRole('link', { name: '打开百度设备授权页面' });
  await expect(dialog.getByText('FIX-1234', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveText('正在等待百度确认授权…');
  await expect(link).toHaveAttribute('href', officialPage);
  await expect(link).toHaveAttribute('target', '_blank');
  const [popup] = await Promise.all([page.waitForEvent('popup'), link.press('Enter')]);
  await expect(popup).toHaveURL(officialPage);
  await popup.close();

  await page.clock.runFor(4999);
  expect(requests.polls).toEqual([]);
  await pollAfter(page, 1);
  expect(requests.polls).toEqual([{ state: firstState }]);
  await page.clock.runFor(7999);
  expect(requests.polls).toEqual([{ state: firstState }]);
  await expect(dialog).toBeVisible();
  await pollAfter(page, 1);

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(url => decodeURIComponent(url.hash) === '#source/baidu');
  await expect(page.getByRole('button', { name: '设备授权后的音乐目录' })).toBeVisible();
  expect(requests.polls).toEqual([{ state: firstState }, { state: firstState }]);
  expect(requests.list).toEqual(['/']);
});

test('stops polling after the device dialog is closed', async ({ page }) => {
  const requests = await mockBaidu(page, () => ({ json: { status: 'pending', retryAfter: 5 } }));
  const dialog = await openDeviceFlow(page);
  await expect(dialog.getByText('FIX-1234', { exact: true })).toBeVisible();
  await pollAfter(page, 5000);
  await dialog.getByRole('button', { name: '关闭', exact: true }).press('Enter');
  await expect(dialog).toBeHidden();

  await page.clock.runFor(20000);
  expect(requests.polls).toEqual([{ state: firstState }]);
  expect(requests.list).toEqual([]);
});

test('clears a rejected device code and retries with a new state', async ({ page }) => {
  const rejection = '设备码已失效，请重新获取。';
  const requests = await mockBaidu(page, attempt => attempt === 1
    ? { status: 400, json: { error: rejection } }
    : { json: { status: 'authorized' } });
  const dialog = await openDeviceFlow(page);
  await expect(dialog.getByText('FIX-1234', { exact: true })).toBeVisible();
  await pollAfter(page, 5000);

  await expect(dialog.getByRole('status')).toHaveText(rejection);
  await expect(dialog.getByText('FIX-1234', { exact: true })).toBeHidden();
  await expect(dialog.getByRole('link', { name: '打开百度设备授权页面' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '重新获取设备码' }).press('Enter');
  await expect(dialog.getByText('FIX-5678', { exact: true })).toBeVisible();
  await pollAfter(page, 5000);

  await expect(page.getByRole('button', { name: '设备授权后的音乐目录' })).toBeVisible();
  expect(requests.starts).toBe(2);
  expect(requests.polls).toEqual([{ state: firstState }, { state: secondState }]);
});

test('rejects a device verification URL outside the official Baidu endpoint', async ({ page }) => {
  const requests = await mockBaidu(page, () => { throw new Error('Unexpected poll'); }, {
    verificationUrl: officialPage + '?redirect=untrusted',
  });
  const dialog = await openDeviceFlow(page);
  await expect(dialog.getByRole('status')).toHaveText('百度返回了无法使用的设备授权页面。');
  await expect(dialog.getByRole('link')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '重新获取设备码' })).toBeVisible();
  await page.clock.runFor(10000);
  expect(requests.polls).toEqual([]);
});
