import { expect, test } from '@playwright/test';

const token = '0de9d846-d86b-4aef-aa41-363f97ebfefb';
const fixtureTitle = 'Little Tone';
const fixtureArtist = 'Local Fixture Artist';

function audioFixture() {
  const sampleRate = 8000;
  const samples = sampleRate * 8;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

test('opts in to ListenBrainz and reports genuine media playback once without counting seeks', async ({ page }) => {
  let account;
  const listens = [];
  await page.route('**/api/listenbrainz/*', async route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'connect') {
      expect(route.request().postDataJSON()).toEqual({ token });
      account = 'fixture-listener';
    } else if (action === 'disconnect') {
      expect(route.request().method()).toBe('DELETE');
      account = null;
    } else if (action === 'listen') {
      listens.push(route.request().postDataJSON());
      return route.fulfill({ json: { submitted: true } });
    }
    return route.fulfill({ json: { account: account ?? null } });
  });

  await page.goto('/#settings');
  await page.getByRole('checkbox', { name: '显示原创演示歌曲' }).press('Space');
  await page.getByRole('button', { name: '连接 ListenBrainz', exact: true }).press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ListenBrainz 用户令牌').fill(token);
  await dialog.getByRole('button', { name: '连接', exact: true }).press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByText('已连接 fixture-listener', { exact: true })).toBeVisible();
  expect(await page.evaluate(value => Object.values(localStorage).some(entry => entry.includes(value)), token)).toBe(false);
  await page.reload();
  await expect(page.getByText('已连接 fixture-listener', { exact: true })).toBeVisible();

  await page.locator('#sidebar [data-nav="songs"]').press('Enter');
  await page.locator('#import-files').setInputFiles({
    name: fixtureArtist + ' - ' + fixtureTitle + '.wav', mimeType: 'audio/wav', buffer: audioFixture(),
  });
  const track = page.locator('#content .track-main').filter({ hasText: fixtureTitle });
  const audio = page.locator('#audio');
  await track.press('Enter');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await audio.evaluate(element => { element.currentTime = element.duration - 0.1; });
  await expect.poll(() => audio.evaluate(element => element.ended)).toBe(true);
  expect(listens).toEqual([]);

  await track.press('Enter');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await audio.evaluate(element => { element.playbackRate = 3; });
  await expect.poll(() => listens.length).toBe(1);
  expect(listens[0]).toEqual({ id: expect.any(String), title: fixtureTitle, artist: fixtureArtist, listenedAt: expect.any(Number) });
  await expect.poll(() => audio.evaluate(element => element.ended)).toBe(true);
  expect(listens).toHaveLength(1);

  await page.locator('#sidebar [data-nav="settings"]').press('Enter');
  await page.getByRole('button', { name: '断开 ListenBrainz', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: '连接 ListenBrainz', exact: true })).toBeVisible();
  await page.locator('#sidebar [data-nav="songs"]').press('Enter');
  await track.press('Enter');
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await audio.evaluate(element => { element.playbackRate = 3; });
  await expect.poll(() => audio.evaluate(element => element.ended)).toBe(true);
  expect(listens).toHaveLength(1);
});
