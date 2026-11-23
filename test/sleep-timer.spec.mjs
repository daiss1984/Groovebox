import { expect, test } from '@playwright/test';

const title = page => page.locator('#player-title');
const playing = page => page.locator('#audio').evaluate(audio => !audio.paused && !audio.ended);
const openTimer = scope => scope.getByRole('button', { name: '睡眠定时', exact: true }).press('Enter');

async function startPlayback(page) {
  await page.clock.install({ time: new Date('2026-06-21T10:00:00Z') });
  await page.goto('/#songs');
  await expect(title(page)).toHaveText('After Hours');
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.duration)).toBeGreaterThan(160);
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0);
}

test('sleep timer pauses at the deadline, can be canceled, and remembers the last duration', async ({ page }) => {
  await startPlayback(page);
  const panel = page.locator('#now');
  const dialog = page.getByRole('dialog');
  await openTimer(panel);
  await expect(dialog.getByText('定时未启动。')).toBeVisible();
  await dialog.getByLabel('定时分钟数').fill('2');
  await dialog.getByRole('button', { name: '开始定时' }).press('Enter');
  await expect(dialog.getByText(/剩余 2:00|剩余 1:59/)).toBeVisible();
  await page.clock.fastForward(120_100);
  await expect.poll(() => playing(page)).toBe(false);
  await expect(dialog.getByText('定时未启动。')).toBeVisible();
  await expect(title(page)).toHaveText('After Hours');

  await dialog.getByRole('button', { name: '关闭', exact: true }).press('Enter');
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(() => playing(page)).toBe(true);
  await openTimer(panel);
  await dialog.getByRole('button', { name: '开始定时' }).press('Enter');
  await dialog.getByRole('button', { name: '取消定时' }).press('Enter');
  await expect(dialog.getByText('定时未启动。')).toBeVisible();
  await page.clock.fastForward(120_100);
  await expect.poll(() => playing(page)).toBe(true);

  await page.reload();
  await expect(title(page)).toHaveText('After Hours');
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.duration)).toBeGreaterThan(160);
  await openTimer(panel);
  await expect(dialog.getByLabel('定时分钟数')).toHaveValue('2');
  await expect(dialog.getByRole('button', { name: '取消定时' })).toBeDisabled();
});

test('lets the current track finish in immersive mode and suppresses repeat and automatic advance', async ({ page }) => {
  await startPlayback(page);
  await page.locator('#repeat').press('Enter');
  await page.locator('#repeat').press('Enter');
  await expect(page.locator('#repeat')).toHaveAttribute('title', '单曲循环');
  await page.locator('#player-art').press('Enter');
  const immersive = page.getByRole('region', { name: '沉浸播放', exact: true });
  await openTimer(immersive);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定时分钟数').fill('1');
  await dialog.getByRole('checkbox', { name: '到时播完当前歌曲' }).press('Space');
  await dialog.getByRole('button', { name: '开始定时' }).press('Enter');
  await page.clock.fastForward(60_100);
  await expect(dialog.getByText('播完当前歌曲后暂停。')).toBeVisible();
  await expect.poll(() => playing(page)).toBe(true);

  const audio = page.locator('#audio');
  await audio.evaluate(element => { element.currentTime = element.duration - .2; });
  await expect.poll(() => audio.evaluate(element => element.ended)).toBe(true);
  await expect(dialog.getByText('定时未启动。')).toBeVisible();
  await expect.poll(() => playing(page)).toBe(false);
  await expect(title(page)).toHaveText('After Hours');
  await dialog.getByRole('button', { name: '关闭', exact: true }).press('Enter');
  await immersive.getByRole('button', { name: '关闭沉浸播放' }).press('Enter');
  await page.getByRole('button', { name: '下一首', exact: true }).press('Enter');
  await expect(title(page)).toHaveText('Blue Static');
  await expect.poll(() => playing(page)).toBe(true);
  await page.reload();
  await expect(title(page)).toHaveText('Blue Static');
  await expect.poll(() => audio.evaluate(element => element.duration)).toBeGreaterThan(140);
  await openTimer(page.locator('#now'));
  await expect(dialog.getByRole('checkbox', { name: '到时播完当前歌曲' })).toBeChecked();
});

test('pauses DLNA at the deadline or waits for the receiver to finish the song', async ({ page }) => {
  let transport = 'PLAYING';
  let reads = 0;
  let pauses = 0;
  await page.route('**/api/cast/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'devices') return route.fulfill({ json: { devices: [{ id: 'receiver', name: 'Fixture Speaker' }] } });
    if (action === 'position') {
      reads++;
      return route.fulfill({ json: { position: 8, duration: 164, state: transport } });
    }
    if (action === 'pause') {
      pauses++;
      transport = 'PAUSED_PLAYBACK';
    }
    if (action === 'play') transport = 'PLAYING';
    return route.fulfill({ json: { active: true } });
  });
  await startPlayback(page);
  const panel = page.locator('#now');
  const dialog = page.getByRole('dialog');
  const openCast = () => panel.getByRole('button', { name: '局域网 DLNA' }).press('Enter');
  const close = () => dialog.getByRole('button', { name: '关闭', exact: true }).press('Enter');
  const start = () => dialog.getByRole('button', { name: '开始定时' }).press('Enter');
  await openCast();
  await dialog.getByRole('button', { name: 'Fixture Speaker' }).press('Enter');
  await expect(dialog.getByText('After Hours · Fixture Speaker')).toBeVisible();
  await expect.poll(() => playing(page)).toBe(false);
  await close();

  await openTimer(panel);
  await dialog.getByLabel('定时分钟数').fill('1');
  await start();
  await page.clock.fastForward(60_100);
  await expect.poll(() => pauses).toBe(1);
  await expect(dialog.getByText('定时未启动。')).toBeVisible();
  await close();

  await openCast();
  await dialog.getByRole('button', { name: '播放', exact: true }).press('Enter');
  await expect.poll(() => transport).toBe('PLAYING');
  await close();
  await openTimer(panel);
  await dialog.getByRole('checkbox', { name: '到时播完当前歌曲' }).press('Space');
  await start();
  const previousReads = reads;
  await page.clock.fastForward(60_100);
  await expect(dialog.getByText('播完当前歌曲后暂停。')).toBeVisible();
  expect(reads).toBeGreaterThan(previousReads);
  expect(pauses).toBe(1);
  transport = 'STOPPED';
  await page.clock.fastForward(1100);
  await expect(dialog.getByText('定时未启动。')).toBeVisible();
  expect(pauses).toBe(1);
});
