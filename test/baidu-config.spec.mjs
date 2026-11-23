import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('explains mismatched Baidu callbacks and routes users to the configured origin before starting authorization', async ({ page }) => {
  const callback = 'https://player.example.test:443/api/baidu/callback';
  await page.route('**/api/baidu/status', route => route.fulfill({ json: {
    configured: true, connected: false, deviceAvailable: true, codeAvailable: true, redirectUri: callback,
  } }));
  await page.goto('/?baidu=redirect-mismatch');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('redirect_uri_mismatch');
  await expect(dialog.getByText(callback, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: '从回调地址的域名打开播放器' }))
    .toHaveAttribute('href', 'https://player.example.test/#sources');
  await expect(dialog.getByRole('button', { name: '前往百度授权', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '使用百度设备授权' })).toBeVisible();
  await expect(page).toHaveURL(url => url.search === '' && url.hash === '#sources');
});

test('configures Baidu inside the browser and starts OAuth without restarting the backend', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'groovebox-browser-setup-'));
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env, GROOVEBOX_DATA_DIR: directory, HOST: '127.0.0.1', PORT: '0',
      BAIDU_CLIENT_ID: '', BAIDU_CLIENT_SECRET: '', BAIDU_REDIRECT_URI: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let origin;
    await new Promise((resolve, reject) => {
      let output = '';
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Test server exited with code ' + code)));
      child.stdout.on('data', chunk => {
        output += chunk.toString('utf8');
        origin = /Groovebox: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
        if (origin) resolve();
      });
    });
    await page.goto(origin + '/#sources');
    await page.getByRole('button', { name: /百度网盘 未连接/ }).press('Enter');
    await page.getByRole('button', { name: '在网页配置百度应用' }).press('Enter');
    const dialog = page.locator('#dialog');
    await dialog.getByLabel('应用 ID').fill('browser-fixture-id');
    await dialog.getByLabel('应用密钥').fill('browser-fixture-secret');
    await dialog.getByRole('button', { name: '保存配置' }).press('Enter');
    await dialog.getByRole('button', { name: '使用百度授权码' }).press('Enter');
    const link = dialog.getByRole('link', { name: '打开百度授权页面' });
    await expect(link).toBeVisible();
    const authorize = new URL(await link.getAttribute('href'));
    expect(authorize?.origin).toBe('https://openapi.baidu.com');
    expect(authorize?.searchParams.get('client_id')).toBe('browser-fixture-id');
    expect(authorize?.searchParams.get('client_secret')).toBeNull();
    expect(authorize?.searchParams.get('redirect_uri')).toBe('oob');
    expect(child.exitCode).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
