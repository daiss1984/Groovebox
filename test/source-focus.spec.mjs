import { expect, test } from '@playwright/test';

const delayedSource = { id: 'fixture-webdav', type: 'webdav', name: 'Delayed WebDAV Source' };

async function deferSourceDiscovery(page) {
  const pending = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route('**/api/sources', async route => {
    pending.resolve();
    await release.promise;
    await route.fulfill({ json: { sources: [delayedSource] } });
  });
  return { pending: pending.promise, release: release.resolve };
}

test('keeps Add Media Server keyboard focus when startup source discovery finishes', async ({ page }) => {
  const { pending, release } = await deferSourceDiscovery(page);
  try {
    await page.goto('/#sources');
    await pending;
    const add = page.getByRole('button', { name: /^添加媒体服务器/ });
    await add.focus();
    await expect(add).toBeFocused();
    release();
    await expect(page.getByRole('button', { name: /^Delayed WebDAV Source/ })).toBeVisible();
    await expect(add).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog').getByRole('heading', { name: '添加媒体服务器', exact: true })).toBeVisible();
  } finally {
    release();
  }
});

test('preserves the focused source ID when several source controls share an action', async ({ page }) => {
  const { pending, release } = await deferSourceDiscovery(page);
  try {
    await page.goto('/#sources');
    await pending;
    const oneDrive = page.locator('#content button[data-action="oauth-source"][data-id="onedrive"]');
    await oneDrive.focus();
    await expect(oneDrive).toBeFocused();
    release();
    await expect(page.getByRole('button', { name: /^Delayed WebDAV Source/ })).toBeVisible();
    await expect(oneDrive).toBeFocused();
  } finally {
    release();
  }
});

test('leaves focus inside the open source dialog when discovery rerenders the page', async ({ page }) => {
  const { pending, release } = await deferSourceDiscovery(page);
  try {
    await page.goto('/#sources');
    await pending;
    await page.getByRole('button', { name: /^添加媒体服务器/ }).press('Enter');
    const address = page.getByRole('dialog').getByLabel('服务地址');
    await address.focus();
    await expect(address).toBeFocused();
    release();
    await expect(page.locator('#source-indicator')).toHaveClass('is-connected');
    await expect(address).toBeFocused();
  } finally {
    release();
  }
});

test('does not move keyboard focus back to Sources after navigating away', async ({ page }) => {
  const { pending, release } = await deferSourceDiscovery(page);
  try {
    await page.goto('/#sources');
    await pending;
    await page.getByRole('button', { name: /^添加媒体服务器/ }).focus();
    const songs = page.locator('#sidebar [data-nav="songs"]');
    await songs.press('Enter');
    await expect(songs).toHaveAttribute('aria-current', 'page');
    await expect(songs).toBeFocused();
    release();
    await expect(page.locator('#source-indicator')).toHaveClass('is-connected');
    await expect(songs).toBeFocused();
  } finally {
    release();
  }
});
