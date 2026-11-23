import { expect, test } from '@playwright/test';

for (const [code, status, message] of [
  ['source_session_unreadable', 401, '已保存的媒体连接无法读取，请重新添加媒体来源。'],
  ['sources_storage_unavailable', 503, '暂时无法读取媒体连接，请重试。'],
]) test('shows an actionable source registry error and recovers on retry: ' + code, async ({ page }) => {
  let healthy = false;
  let reads = 0;
  await page.route('**/api/sources', route => {
    reads++;
    return healthy ? route.fulfill({ json: { sources: [{
      id: 'f86bf404-0a60-4bd6-bb4b-4ea5f2b225c5', type: 'webdav', name: 'Recovered private source',
    }] } }) : route.fulfill({ status, json: { code, error: 'internal-credential-must-not-be-rendered' } });
  });
  await page.goto('/#sources');
  const warning = page.locator('[data-source-registry-error]');
  await expect(warning).toContainText(message);
  await expect(page.getByText('internal-credential-must-not-be-rendered')).toHaveCount(0);
  await expect(page.locator('#content [data-action="open-cloud"]')).toHaveCount(0);
  const retry = warning.getByRole('button', { name: '重试媒体连接', exact: true });
  await retry.press('Enter');
  await expect.poll(() => reads).toBe(2);
  await expect(retry).toBeFocused();
  healthy = true;
  await retry.press('Enter');
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Recovered private source/ })).toBeVisible();
  expect(reads).toBe(3);
});

test('a new empty source registry does not show a restore error', async ({ page }) => {
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [] } }));
  await page.goto('/#sources');
  await expect(page.getByRole('button', { name: /^添加媒体服务器/ })).toBeVisible();
  await expect(page.locator('[data-source-registry-error]')).toHaveCount(0);
});
