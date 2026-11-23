import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { updateBuffer } from 'music-metadata';

const nativeAudio = page => page.locator('#audio').evaluate(audio => ({
  src: audio.currentSrc, rate: audio.playbackRate, time: audio.currentTime, paused: audio.paused,
}));

async function observeGain(page) {
  await page.addInitScript(() => {
    const Context = window.AudioContext || window.webkitAudioContext;
    const createGain = Context.prototype.createGain;
    Context.prototype.createGain = function () {
      const node = createGain.call(this);
      window.r128TestGain ??= node;
      return node;
    };
  });
  return () => page.evaluate(() => window.r128TestGain?.gain.value ?? null);
}

test('applies real Opus R128 gain once and refreshes an older local import', async ({ page }) => {
  const gain = await observeGain(page);
  const parsed = 'R128 fixture';
  const buffer = await readFile(new URL('./fixtures/r128-mixed.opus', import.meta.url));
  const content = page.locator('#content');
  const nav = name => page.locator('#sidebar [data-nav=' + name + ']');
  const track = content.getByRole('button', { name: /^R128 fixture/ });
  const mode = content.getByLabel('ReplayGain 模式');
  const normalization = content.getByLabel('启用 ReplayGain');

  await page.goto('/#songs');
  await page.locator('#audio').evaluate(element => { element.loop = true; });
  await page.locator('#import-files').setInputFiles({ name: 'r128-mixed.opus', mimeType: 'audio/ogg', buffer });
  await track.click();
  await expect(page.locator('#player-title')).toHaveText(parsed);
  await expect.poll(async () => (await nativeAudio(page)).time).toBeGreaterThan(0.1);
  const original = (await nativeAudio(page)).src;
  await nav('settings').click();
  await normalization.check();
  await expect.poll(gain).toBeCloseTo(10 ** (-6 / 20), 4);
  await mode.selectOption('album');
  await expect.poll(gain).toBeCloseTo(10 ** (-12 / 20), 4);
  expect(await nativeAudio(page)).toMatchObject({ src: original, paused: false });

  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('groovebox.library');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('tracks', 'readwrite');
      const store = transaction.objectStore('tracks');
      const get = store.get('local:r128-mixed.opus');
      get.onsuccess = () => {
        const record = get.result;
        delete record.r128TrackGain;
        delete record.r128AlbumGain;
        delete record.r128GainRead;
        store.put(record);
      };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
      transaction.oncomplete = () => { database.close(); resolve(); };
    };
  }));
  await mode.selectOption('track');
  await page.reload();
  await expect(mode).toHaveValue('track');
  await nav('songs').click();
  await track.click();
  await expect.poll(gain).toBeCloseTo(10 ** (-6 / 20), 4);
  await expect.poll(async () => (await nativeAudio(page)).time).toBeGreaterThan(0.1);
});

test('applies the R128 comments from a streamed Opus without replacing the remote source', async ({ page }) => {
  const gain = await observeGain(page);
  const buffer = await readFile(new URL('./fixtures/r128-mixed.opus', import.meta.url));
  const stream = '/api/baidu/stream?id=2712';
  const ranges = [];
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => route.fulfill({ json: { items: [{ id: '2712',
    name: 'Streaming sample.opus', path: '/Streaming sample.opus', streamUrl: stream,
  }] } }));
  await page.route('**' + stream, route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ body: buffer, contentType: 'audio/ogg' });
    ranges.push(range[0]);
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : buffer.length - 1, buffer.length - 1);
    return route.fulfill({ status: 206, contentType: 'audio/ogg', body: buffer.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${buffer.length}` } });
  });
  await page.goto('/#sources');
  const content = page.locator('#content');
  await content.locator('[data-action=baidu-source]').click();
  await page.locator('#audio').evaluate(element => { element.loop = true; });
  await content.getByRole('button', { name: /^Streaming sample/ }).click();
  await expect.poll(async () => (await nativeAudio(page)).time).toBeGreaterThan(0.1);
  const original = (await nativeAudio(page)).src;
  await content.getByRole('button', { name: '歌曲选项' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '读取音频标签', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('已更新歌曲标签');
  expect(ranges).toContain('bytes=0-65535');
  await page.locator('#sidebar [data-nav=settings]').click();
  await content.getByLabel('启用 ReplayGain').check();
  await expect.poll(gain).toBeCloseTo(10 ** (-6 / 20), 4);
  await content.getByLabel('ReplayGain 模式').selectOption('album');
  await expect.poll(gain).toBeCloseTo(10 ** (-12 / 20), 4);
  expect(await nativeAudio(page)).toMatchObject({ src: original, paused: false });
});

test('saves, switches, updates and restores named equalizer profiles', async ({ page }) => {
  await page.addInitScript(() => {
    const Context = window.AudioContext || window.webkitAudioContext;
    const createFilter = Context.prototype.createBiquadFilter;
    window.profileFilters = [];
    Context.prototype.createBiquadFilter = function () {
      const filter = createFilter.call(this);
      window.profileFilters.push(filter);
      return filter;
    };
  });
  await page.goto('/#settings');
  await page.locator('#eq-enabled').check();
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(async () => (await nativeAudio(page)).time).toBeGreaterThan(0.1);
  const originalSrc = (await nativeAudio(page)).src;
  const profiles = page.getByRole('combobox', { name: '均衡器配置', exact: true });
  const bass = page.locator('[data-eq="0"]');
  const treble = page.locator('[data-eq="9"]');
  const original = page.getByRole('button', { name: '原声', exact: true });
  const saveProfile = async name => {
    await page.getByRole('button', { name: '保存均衡器配置', exact: true }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('配置名称').fill(name);
    await dialog.getByRole('button', { name: '保存', exact: true }).press('Enter');
    await expect(dialog).toBeHidden();
  };
  await bass.fill('4');
  await saveProfile('Desktop');
  await original.press('Enter');
  await expect(profiles).toHaveValue('');
  await expect(bass).toHaveValue('0');
  await treble.fill('-5');
  await page.locator('#eq-enabled').check();
  await saveProfile('Night & <quiet>');

  await profiles.selectOption({ label: 'Desktop' });
  await expect(bass).toHaveValue('4');
  await expect(treble).toHaveValue('0');
  expect(await page.evaluate(() => window.profileFilters.map(filter => filter.gain.value))).toEqual([4, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(await nativeAudio(page)).toMatchObject({ src: originalSrc, paused: false });
  await bass.fill('6');
  await expect(profiles).toHaveValue('');
  await saveProfile('Desktop');
  await expect(profiles.getByRole('option', { name: 'Desktop', exact: true })).toHaveCount(1);
  await page.reload();
  await expect(profiles).toHaveValue('desktop');
  await expect(bass).toHaveValue('6');
  await expect(original).toHaveAttribute('aria-pressed', 'false');

  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份' }).press('Enter');
  const backup = await readFile(await (await exported).path());
  await page.getByRole('button', { name: '删除均衡器配置', exact: true }).press('Enter');
  await expect(profiles.getByRole('option', { name: 'Desktop', exact: true })).toHaveCount(0);
  await expect(bass).toHaveValue('6');
  await page.locator('#restore-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
  await expect(profiles).toHaveValue('desktop');
  await profiles.selectOption({ label: 'Night & <quiet>' });
  await expect(bass).toHaveValue('0');
  await expect(treble).toHaveValue('-5');
});

test('preserves the original media source and adds headroom for combined EQ and ReplayGain', async ({ page }) => {
  const demo = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const measured = await updateBuffer(demo, {
    title: 'Measured fixture', replaygain_track_gain: '+6 dB', replaygain_track_peak: '0.5',
  });
  const unmeasured = await updateBuffer(demo, { title: 'Unmeasured fixture', replaygain_track_gain: '+6 dB' });
  await page.addInitScript(() => {
    const Context = window.AudioContext || window.webkitAudioContext;
    const fixture = window.audioFixture = { connections: new WeakMap() };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...args) {
      fixture.connections.set(this, target);
      return connect.call(this, target, ...args);
    };
    const source = Context.prototype.createMediaElementSource;
    Context.prototype.createMediaElementSource = function (audio) {
      fixture.source = source.call(this, audio);
      return fixture.source;
    };
  });
  await page.goto('/');
  await page.locator('#import-files').setInputFiles([
    { name: 'Measured.m4a', mimeType: 'audio/mp4', buffer: Buffer.from(measured) },
    { name: 'Unmeasured.m4a', mimeType: 'audio/mp4', buffer: Buffer.from(unmeasured) },
  ]);
  const songs = page.locator('#sidebar [data-nav="songs"]');
  const settings = page.locator('#sidebar [data-nav="settings"]');
  const tracks = page.getByRole('table');
  const measuredTrack = tracks.getByRole('button', { name: /Measured fixture/ });
  const unmeasuredTrack = tracks.getByRole('button', { name: /Unmeasured fixture/ });
  await songs.press('Enter');
  await expect(page.getByRole('heading', { name: '全部歌曲', exact: true })).toBeVisible();
  await measuredTrack.press('Enter');
  await expect.poll(async () => (await nativeAudio(page)).time).toBeGreaterThan(0.1);
  const originalSrc = (await nativeAudio(page)).src;
  expect(originalSrc).toMatch(/^blob:/);
  expect(await page.evaluate(() => Boolean(window.audioFixture.source))).toBe(false);

  await settings.press('Enter');
  const original = page.getByRole('button', { name: '原声', exact: true });
  await expect(original).toHaveAttribute('aria-pressed', 'true');
  const replayGain = page.getByLabel('启用 ReplayGain');
  await replayGain.press('Space');
  await expect(original).toHaveAttribute('aria-pressed', 'false');
  const preamp = () => page.evaluate(() => {
    const { source, connections } = window.audioFixture;
    return connections.get(source).gain.value;
  });
  await expect.poll(preamp).toBeCloseTo(10 ** (-1 / 20) / 0.5, 3);

  await page.locator('[data-eq="0"]').fill('12');
  await page.locator('#eq-enabled').check();
  await page.locator('[data-eq="1"]').fill('12');
  const measuredPeak = await page.evaluate(() => {
    const { source, connections } = window.audioFixture;
    const frequencies = Float32Array.from({ length: 6001 }, (_, index) => 4 * index);
    const combined = new Float64Array(frequencies.length).fill(1);
    const magnitudes = new Float32Array(frequencies.length);
    const phases = new Float32Array(frequencies.length);
    const gain = connections.get(source);
    for (let node = connections.get(gain); node && node !== source.context.destination; node = connections.get(node)) {
      node.getFrequencyResponse(frequencies, magnitudes, phases);
      for (let i = 0; i < combined.length; i++) {
        if (Number.isFinite(magnitudes[i])) combined[i] *= magnitudes[i];
      }
    }
    return 0.5 * gain.gain.value * Math.max(...combined);
  });
  expect(measuredPeak).toBeGreaterThan(0.86);
  expect(measuredPeak).toBeLessThan(0.92);

  const speed = page.getByLabel('播放速度');
  await speed.selectOption('1.5');
  await original.press('Enter');
  await expect(original).toHaveAttribute('aria-pressed', 'true');
  await expect(speed).toHaveValue('1');
  await expect(replayGain).not.toBeChecked();
  for (const band of await page.locator('[data-eq]').all()) await expect(band).toHaveValue('0');
  expect(await page.evaluate(() => {
    const { source, connections } = window.audioFixture;
    return connections.get(source) === source.context.destination;
  })).toBe(true);
  expect(await nativeAudio(page)).toMatchObject({ src: originalSrc, rate: 1, paused: false });

  await songs.press('Enter');
  await unmeasuredTrack.press('Enter');
  await expect(page.locator('#player-title')).toHaveText('Unmeasured fixture');
  await settings.press('Enter');
  await replayGain.press('Space');
  await expect.poll(preamp).toBeCloseTo(10 ** (-1 / 20), 3);
  await original.press('Enter');
  await page.reload();
  await expect(original).toHaveAttribute('aria-pressed', 'true');
  await songs.press('Enter');
  await unmeasuredTrack.press('Enter');
  await expect.poll(async () => (await nativeAudio(page)).time).toBeGreaterThan(0.1);
  expect(await page.evaluate(() => Boolean(window.audioFixture.source))).toBe(false);
});

test('applies album tags to separate songs, backfills old imports and falls back to track gain', async ({ page }) => {
  const demo = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  const files = await Promise.all([
    ['Album first', '-3 dB', '-8 dB', '0.9'],
    ['Album second', '-5 dB', '-8 dB', '0.9'],
    ['Track only', '-4 dB'],
  ].map(async ([title, trackGain, albumGain, albumPeak]) => ({
    name: title + '.m4a', mimeType: 'audio/mp4',
    buffer: Buffer.from(await updateBuffer(demo, {
      title, album: 'ReplayGain fixture', replaygain_track_gain: trackGain,
      ...(albumGain && { replaygain_album_gain: albumGain, replaygain_album_peak: albumPeak }),
    })),
  })));
  await page.addInitScript(() => {
    const Context = window.AudioContext || window.webkitAudioContext;
    const createGain = Context.prototype.createGain;
    Context.prototype.createGain = function () {
      window.audioFixtureGain = createGain.call(this);
      return window.audioFixtureGain;
    };
  });
  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles(files);
  const content = page.locator('#content');
  await expect(content.getByText('Album first', { exact: true })).toBeVisible();
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('groovebox.library');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('tracks', 'readwrite');
      const store = transaction.objectStore('tracks');
      const find = store.get('local:Album first.m4a');
      find.onsuccess = () => {
        const track = find.result;
        delete track.replayGainAlbum;
        delete track.replayGainAlbumPeak;
        delete track.replayGainAlbumRead;
        store.put(track);
      };
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
  await page.reload();
  const playTrack = async title => {
    await content.getByRole('button', { name: title + ' 未知艺人', exact: true }).press('Enter');
    await expect(page.locator('#player-title')).toHaveText(title);
  };
  const actualGain = () => page.evaluate(() => window.audioFixtureGain?.gain.value);
  await playTrack('Album first');
  await page.locator('#sidebar [data-nav="settings"]').press('Enter');
  const enabled = content.getByLabel('启用 ReplayGain');
  const mode = content.getByLabel('ReplayGain 模式');
  await expect(mode).toHaveValue('track');
  await enabled.press('Space');
  await expect.poll(actualGain).toBeCloseTo(10 ** (-3 / 20), 4);
  await mode.selectOption('album');
  await expect.poll(actualGain).toBeCloseTo(10 ** (-8 / 20), 4);

  await page.reload();
  await expect(mode).toHaveValue('album');
  await expect(enabled).toBeChecked();
  await page.locator('#sidebar [data-nav="songs"]').press('Enter');
  await playTrack('Album second');
  await expect.poll(actualGain).toBeCloseTo(10 ** (-8 / 20), 4);
  await playTrack('Track only');
  await expect.poll(actualGain).toBeCloseTo(10 ** (-4 / 20), 4);
});
