import { expect, test } from '@playwright/test';

test('uses the browser device picker and mirrors remote playback connection state', async ({ page }) => {
  await page.addInitScript(() => {
    const remote = new EventTarget();
    remote.state = 'disconnected';
    remote.prompt = async () => {
      window.castPrompts = (window.castPrompts || 0) + 1;
      remote.state = 'connected';
      remote.dispatchEvent(new Event('connect'));
    };
    window.disconnectCast = () => {
      remote.state = 'disconnected';
      remote.dispatchEvent(new Event('disconnect'));
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitShowPlaybackTargetPicker', { value: undefined });
    Object.defineProperty(HTMLMediaElement.prototype, 'remote', { value: remote });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '立即播放' }).click();
  const cast = page.locator('footer [data-action=cast]');
  await cast.click();
  await expect(cast).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.castPrompts)).toBe(1);
  await page.evaluate(() => window.disconnectCast());
  await expect(cast).toHaveAttribute('aria-pressed', 'false');
});

test('uses the AirPlay picker and updates the wireless playback state', async ({ page }) => {
  await page.addInitScript(() => {
    let wireless = false;
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitCurrentPlaybackTargetIsWireless', {
      get: () => wireless,
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitShowPlaybackTargetPicker', {
      value() {
        window.airPlayPrompts = (window.airPlayPrompts || 0) + 1;
        wireless = true;
        this.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '立即播放' }).click();
  const cast = page.locator('footer [data-action=cast]');
  await cast.click();
  await expect(cast).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.airPlayPrompts)).toBe(1);
});

test('selects a DLNA receiver, sends the selected audio and controls playback', async ({ page }) => {
  const commands = [];
  let uploads = 0;
  await page.route('**/api/cast/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const action = url.pathname.split('/').at(-1);
    if (action === 'devices') return route.fulfill({ json: { devices: [{ id: 'receiver1', name: '客厅音响' }] } });
    if (action === 'position') return route.fulfill({ json: { position: 12, duration: 164, state: 'PLAYING' } });
    commands.push(action);
    if (action === 'start') {
      expect(url.searchParams.get('device')).toBe('receiver1');
      expect(url.searchParams.get('title')).toBe('After Hours');
      expect(request.headers()['content-type']).toBe('audio/mp4');
      const body = request.postDataBuffer();
      if (body) expect(body.length).toBeGreaterThan(1000000);
      uploads++;
    } else if (action === 'seek') expect(url.searchParams.get('seconds')).toBe('40');
    return route.fulfill({ json: { active: action !== 'stop' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '立即播放' }).click();
  await page.locator('#sidebar [data-nav=settings]').press('Enter');
  await page.getByRole('checkbox', { name: '切到后台时暂停播放' }).check();
  await page.locator('#now').getByRole('button', { name: '局域网 DLNA' }).click();
  const dialog = page.locator('#dialog');
  await dialog.getByRole('button', { name: '客厅音响' }).click();
  await expect(dialog.getByText('After Hours · 客厅音响')).toBeVisible();
  expect(uploads).toBe(1);
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(() => commands.includes('pause')).toBe(true);
  await dialog.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => commands.includes('play')).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => commands.filter(command => command === 'pause').length).toBe(2);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const slider = dialog.getByRole('slider', { name: '设备播放进度' });
  await expect(slider).toBeEnabled();
  await slider.fill('40');
  await expect.poll(() => commands.includes('seek')).toBe(true);
  await dialog.getByRole('button', { name: '停止投屏' }).click();
  await expect(dialog).toBeHidden();
  expect(commands).toEqual(['start', 'pause', 'play', 'pause', 'seek', 'stop']);
});
