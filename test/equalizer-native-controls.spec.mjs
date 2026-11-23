import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const standardBands = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const legacyBands = [60, 250, 1000, 4000, 12000];
const presets = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  jazz: [4, 3, 1, 2, -2, -2, 0, 1, 3, 4],
  rock: [5, 4, 3, 1, -1, -1, 0, 2, 4, 5],
  dance: [6, 5, 2, 0, 0, -2, -1, 0, 4, 5],
  classical: [5, 4, 3, 2, -1, -1, 0, 2, 3, 4],
  'hip-hop': [5, 4, 1, 3, -1, -1, 1, 0, 2, 3],
  'late-night': [3, 2, 1, 0, -1, 0, 1, 2, 3, 3],
};
const sliders = page => page.locator('input[type="range"][data-eq]');
const eqEnabled = page => page.locator('#eq-enabled');
const preset = page => page.locator('#eq-preset');
const profile = page => page.locator('#eq-profile');
const sliderGains = page => sliders(page).evaluateAll(inputs => inputs.map(input => Number(input.value)));

async function observeAudioGraph(page) {
  await page.addInitScript(() => {
    const Context = window.AudioContext || window.webkitAudioContext;
    const sources = [];
    const links = new WeakMap();
    const originalSource = Context.prototype.createMediaElementSource;
    const originalConnect = AudioNode.prototype.connect;
    const originalDisconnect = AudioNode.prototype.disconnect;
    Context.prototype.createMediaElementSource = function (...args) {
      const source = originalSource.apply(this, args);
      sources.push(source);
      return source;
    };
    AudioNode.prototype.connect = function (destination, ...args) {
      const result = originalConnect.call(this, destination, ...args);
      if (!links.has(this)) links.set(this, new Set());
      links.get(this).add(destination);
      return result;
    };
    AudioNode.prototype.disconnect = function (...args) {
      const result = originalDisconnect.apply(this, args);
      if (!args.length || typeof args[0] === 'number') links.get(this)?.clear();
      else links.get(this)?.delete(args[0]);
      return result;
    };
    window.readEqualizerGraph = () => {
      const visited = new Set();
      function visit(node) {
        if (visited.has(node)) return;
        visited.add(node);
        for (const child of links.get(node) || []) visit(child);
      }
      sources.forEach(visit);
      return {
        sources: sources.length,
        filters: [...visited].filter(node => node instanceof BiquadFilterNode)
          .map(node => ({ frequency: node.frequency.value, gain: node.gain.value })),
      };
    };
  });
}

const graph = page => page.evaluate(() => window.readEqualizerGraph());
const activeGains = (frequencies, gains) => frequencies.map((frequency, index) => ({ frequency, gain: gains[index] }));
const playback = page => page.locator('#audio').evaluate(audio => ({
  source: audio.currentSrc, time: audio.currentTime, paused: audio.paused, starts: window.equalizerMediaLoads,
}));

async function playDemo(page) {
  await page.locator('#audio').evaluate(audio => {
    window.equalizerMediaLoads = 0;
    audio.addEventListener('loadstart', () => { window.equalizerMediaLoads++; });
  });
  await page.locator('#player-toggle').press('Enter');
  await expect.poll(async () => (await playback(page)).time).toBeGreaterThan(0.1);
  return playback(page);
}

async function expectPlaybackContinues(page, before) {
  const current = await playback(page);
  expect(current).toMatchObject({ source: before.source, paused: false, starts: before.starts });
  expect(current.time).toBeGreaterThanOrEqual(before.time - 0.05);
  await expect.poll(async () => (await playback(page)).time).toBeGreaterThan(current.time);
}

async function expectBands(page, frequencies) {
  await expect(sliders(page)).toHaveCount(frequencies.length);
  expect(await sliders(page).evaluateAll(inputs => inputs.map(input => {
    const match = /([\d.]+)\s*(k?Hz)\b/i.exec(input.labels[0]?.textContent || input.getAttribute('aria-label') || '');
    return {
      frequency: match ? Number(match[1]) * (match[2].toLowerCase() === 'khz' ? 1000 : 1) : null,
      min: Number(input.min), max: Number(input.max), step: Number(input.step || 1),
    };
  }))).toEqual(frequencies.map(frequency => ({ frequency, min: -12, max: 12, step: 1 })));
}

test('matches native ten-band EQ controls, applies presets only when enabled, and restores a custom curve', async ({ page }) => {
  await observeAudioGraph(page);
  await page.goto('/#settings');
  await expect(eqEnabled(page)).not.toBeChecked();
  await expectBands(page, standardBands);
  await expect(preset(page)).toHaveValue('flat');
  expect(await preset(page).locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean)))
    .toEqual(Object.keys(presets));
  expect(await sliderGains(page)).toEqual(presets.flat);

  const playing = await playDemo(page);
  await preset(page).selectOption('rock');
  await expect.poll(() => sliderGains(page)).toEqual(presets.rock);
  expect((await graph(page)).filters.every(filter => filter.gain === 0)).toBe(true);
  await eqEnabled(page).check();
  await expect.poll(() => graph(page)).toEqual({ sources: 1, filters: activeGains(standardBands, presets.rock) });

  for (const [name, gains] of Object.entries(presets)) {
    await preset(page).selectOption(name);
    await expect.poll(() => sliderGains(page)).toEqual(gains);
    if (name === 'flat') {
      expect((await graph(page)).filters.every(filter => filter.gain === 0)).toBe(true);
    } else {
      await expect.poll(() => graph(page)).toEqual({ sources: 1, filters: activeGains(standardBands, gains) });
    }
  }
  const custom = [7, ...presets['late-night'].slice(1)];
  await sliders(page).first().evaluate(slider => { slider.value = '7'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
  expect((await graph(page)).filters).toEqual(activeGains(standardBands, presets['late-night']));
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('groovebox.state.v1')).settings.eq)).toEqual(presets['late-night']);
  await sliders(page).first().dispatchEvent('change');
  await expect.poll(() => graph(page)).toEqual({ sources: 1, filters: activeGains(standardBands, custom) });
  await sliders(page).first().fill('7');
  await expect(preset(page)).toHaveValue('');
  await expect.poll(() => graph(page)).toEqual({ sources: 1, filters: activeGains(standardBands, custom) });
  await eqEnabled(page).uncheck();
  expect((await graph(page)).filters.every(filter => filter.gain === 0)).toBe(true);
  expect(await sliderGains(page)).toEqual(custom);
  await eqEnabled(page).check();
  await expect.poll(() => graph(page)).toEqual({ sources: 1, filters: activeGains(standardBands, custom) });
  await expectPlaybackContinues(page, playing);

  await page.reload();
  await expect(eqEnabled(page)).toBeChecked();
  await expect(preset(page)).toHaveValue('');
  expect(await sliderGains(page)).toEqual(custom);

  const exported = page.waitForEvent('download');
  await page.locator('#content [data-action="export"]').click();
  const backup = await readFile(await (await exported).path());
  expect(JSON.parse(backup).settings).toMatchObject({ eqEnabled: true, eq: custom });
  await page.locator('#content [data-action="eq-reset"]').click();
  await expect(eqEnabled(page)).toBeChecked();
  await expect(preset(page)).toHaveValue('flat');
  expect(await sliderGains(page)).toEqual(presets.flat);
  await eqEnabled(page).uncheck();
  await page.locator('#restore-file').setInputFiles({ name: 'equalizer-backup.json', mimeType: 'application/json', buffer: backup });
  await expect(eqEnabled(page)).toBeChecked();
  await expect(preset(page)).toHaveValue('');
  expect(await sliderGains(page)).toEqual(custom);
});

test('legacy five-band profiles retain their frequencies and share the same uninterrupted native audio source', async ({ page }) => {
  const legacy = [7, -4, 2, 1, -3];
  await page.addInitScript(gains => {
    if (localStorage.getItem('groovebox.state.v1')) return;
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      settings: { eq: gains, eqProfiles: [{ name: 'Evening Legacy', gains }], eqProfile: 'evening legacy' },
    }));
  }, legacy);
  await observeAudioGraph(page);
  await page.goto('/#settings');
  await expect(eqEnabled(page)).toBeChecked();
  await expectBands(page, legacyBands);
  await expect(profile(page)).toHaveValue('evening legacy');
  expect(await sliderGains(page)).toEqual(legacy);
  const original = await playDemo(page);
  await expect.poll(() => graph(page)).toEqual({ sources: 1, filters: activeGains(legacyBands, legacy) });

  await preset(page).selectOption('dance');
  await expectBands(page, standardBands);
  await expect.poll(() => sliderGains(page)).toEqual(presets.dance);
  await expect.poll(() => graph(page)).toEqual({ sources: 1, filters: activeGains(standardBands, presets.dance) });
  await expectPlaybackContinues(page, original);
  const beforeRestore = await playback(page);

  await profile(page).selectOption('evening legacy');
  await expectBands(page, legacyBands);
  expect(await sliderGains(page)).toEqual(legacy);
  await expect.poll(() => graph(page)).toEqual({ sources: 1, filters: activeGains(legacyBands, legacy) });
  await expectPlaybackContinues(page, beforeRestore);
});
