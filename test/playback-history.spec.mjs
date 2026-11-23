import { expect, test } from '@playwright/test';

test.describe('home statistics in a calendar week that crosses daylight saving time', () => {
  test.use({ timezoneId: 'America/New_York' });

  test('shows the empty summary, then counts only plays up to now in their local date buckets', async ({ page }) => {
    const now = new Date('2026-11-05T17:30:00Z');
    await page.clock.setFixedTime(now);
    await page.goto('/#home');
    const statistics = page.getByRole('region', { name: '播放统计', exact: true });
    const counts = statistics.locator('dd');
    await expect(counts).toHaveText(['0', '0', '0']);
    await statistics.getByRole('button', { name: '播放时光机' }).press('Enter');
    await expect(page.getByText('播放歌曲后，记录会显示在这里')).toBeVisible();

    const history = [
      { id: 'demo-1', at: Date.parse('2026-11-05T05:00:00Z') },
      { id: 'demo-1', at: Date.parse('2026-11-05T04:59:59.999Z') },
      { id: 'demo-2', at: Date.parse('2026-10-30T04:00:00Z') },
      { id: 'demo-3', at: Date.parse('2026-10-30T03:59:59.999Z') },
      { id: 'demo-2', at: now.getTime() },
      { id: 'future', at: now.getTime() + 1 },
    ];
    await page.locator('#history-restore-file').setInputFiles({ name: 'playback-statistics.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ type: 'groovebox-playback-history', version: 1, history })) });
    await expect(page.getByText('6 条播放记录')).toBeVisible();
    await page.goto('/#home');
    await expect(counts).toHaveText(['2', '4', '3']);
    await page.reload();
    await expect(counts).toHaveText(['2', '4', '3']);
  });
});

test('backs up dated playback events and merges them across browser profiles', async ({ page, browser, baseURL }, testInfo) => {
  const day = new Date(2026, 5, 15, 12, 35).getTime();
  await page.addInitScript(({ day }) => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ history: [
      { id: 'demo-1', at: day },
      { id: 'demo-1', at: day - 90000 },
      { id: 'unavailable', at: day - 86400000 },
    ] }));
  }, { day });
  await page.goto('/#history');
  await page.getByRole('button', { name: '播放时光机' }).press('Enter');
  await expect(page.getByRole('heading', { name: '播放时光机' })).toBeVisible();
  await expect(page.getByText('3 条播放记录')).toBeVisible();
  await expect(page.getByText('2 次播放')).toBeVisible();
  await expect(page.getByText('曲目不可用', { exact: true }).last()).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出播放记录' }).press('Enter');
  const file = testInfo.outputPath('history.json');
  await (await download).saveAs(file);

  const context = await browser.newContext({ baseURL });
  try {
    const other = await context.newPage();
    await other.addInitScript(({ day }) => {
      if (localStorage.getItem('groovebox.state.v1')) return;
      localStorage.setItem('groovebox.state.v1', JSON.stringify({ history: [{ id: 'other-device', at: day + 90000 }] }));
    }, { day });
    await other.goto('/#timeline');
    await expect(other.getByText('1 条播放记录')).toBeVisible();
    await other.locator('#history-restore-file').setInputFiles(file);
    await expect(other.getByText('4 条播放记录')).toBeVisible();
    await other.locator('#history-restore-file').setInputFiles(file);
    await expect(other.getByText('播放记录已合并。')).toBeVisible();
    await other.reload();
    await expect(other.getByText('4 条播放记录')).toBeVisible();
    await expect(other.getByText('3 次播放')).toBeVisible();
    await other.getByRole('button', { name: /After Hours/ }).first().press('Enter');
    await expect.poll(() => other.locator('#audio').evaluate(audio => audio.paused)).toBe(false);
    await expect(other.getByText('4 条播放记录')).toBeVisible();
  } finally {
    await context.close();
  }
});

function shortAudio() {
  const sampleRate = 8000;
  const bytesPerSample = 2;
  const sampleBytes = sampleRate * bytesPerSample * 4;
  const wav = Buffer.alloc(44 + sampleBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(sampleBytes, 40);
  return wav;
}

test('qualifies actual listening without counting a seek or an instant replay', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-06-16T12:00:00Z'));
  await page.addInitScript(() => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { demos: false } }));
  });
  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles({ name: 'Playback Fixture.wav', mimeType: 'audio/wav', buffer: shortAudio() });
  await page.locator('#content .track-main').filter({ hasText: 'Playback Fixture' }).press('Enter');
  const audio = page.locator('#audio');
  const ended = () => audio.evaluate(element => element.ended);
  const position = () => audio.evaluate(element => element.currentTime);
  const toggle = page.locator('#player-toggle');
  const count = number => page.getByText(`${number} 条播放记录`, { exact: true });

  await expect.poll(position).toBeGreaterThan(0);
  await audio.evaluate(element => { element.currentTime = element.duration - .2; });
  await expect.poll(ended).toBe(true);
  await page.goto('/#timeline');
  await expect(count(0)).toBeVisible();

  await toggle.press('Enter');
  await expect.poll(position).toBeGreaterThan(0);
  await expect(count(0)).toBeVisible();
  await expect(count(1)).toBeVisible();
  await expect.poll(position).toBeGreaterThanOrEqual(2);
  await expect.poll(ended).toBe(true);
  await expect(count(1)).toBeVisible();

  await toggle.press('Enter');
  await expect.poll(position).toBeGreaterThan(0);
  await expect(count(1)).toBeVisible();
  await expect(count(2)).toBeVisible();
  await expect.poll(position).toBeGreaterThanOrEqual(2);
  await page.goto('/#home');
  await expect(page.getByRole('region', { name: '播放统计' }).locator('dd')).toHaveText(['2', '2', '1']);
  await page.reload();
  await expect(page.getByRole('region', { name: '播放统计' }).locator('dd')).toHaveText(['2', '2', '1']);
});
