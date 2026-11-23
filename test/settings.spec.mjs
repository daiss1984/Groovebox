import { expect, test } from '@playwright/test';

test('follows system color changes and remembers the selected mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/#settings');
  await page.getByRole('button', { name: '跟随系统' }).press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
  await page.reload();
  await expect(page.getByRole('button', { name: '跟随系统' })).toHaveClass(/active/);
  await page.getByRole('button', { name: '纸白' }).press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'light');
});

test('persists custom background and its blur and opacity', async ({ page }) => {
  await page.goto('/#settings');
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=', 'base64');
  await page.locator('#background-file').setInputFiles({ name: 'background.png', mimeType: 'image/png', buffer: pixel });
  const blur = page.getByRole('slider', { name: '背景模糊' });
  const opacity = page.getByRole('slider', { name: '图片不透明度' });
  await blur.fill('12');
  await opacity.fill('60');
  await page.reload();
  await expect(blur).toHaveValue('12');
  await expect(opacity).toHaveValue('60');
  const effect = await page.locator('.workspace').evaluate(element => {
    const style = getComputedStyle(element, '::before');
    return { filter: style.filter, opacity: style.opacity, hasBackground: style.backgroundImage.includes('data:image/png') };
  });
  expect(effect).toEqual({ filter: 'blur(12px)', opacity: '0.6', hasBackground: true });
});

test('shows the complete cloud source list and the public-client authorization prerequisite', async ({ page }) => {
  await page.route('**/api/guangya/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.goto('/#sources');
  await expect(page.locator('[data-action=oauth-source], [data-action=baidu-source]')).toHaveCount(10);
  await page.getByRole('button', { name: /光鸭云盘/ }).press('Enter');
  const dialog = page.locator('#dialog');
  await expect(dialog).toContainText('GUANGYA_CLIENT_ID');
  await expect(dialog).toContainText('GUANGYA_REDIRECT_URI');
  await expect(dialog).not.toContainText('GUANGYA_CLIENT_SECRET');
});
