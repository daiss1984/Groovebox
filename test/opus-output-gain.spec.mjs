import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { signedProbeSample } from '../public/opus-output-gain.js';

const fixture = new URL('./fixtures/opus-gain-tone.opus', import.meta.url);

async function capturePlaybackPCM(page) {
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect;
    const createSource = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (media) {
      const source = createSource.call(this, media);
      window.opusPlaybackSource = source;
      return source;
    };
    function tap(node) {
      const analyser = node.context.createAnalyser();
      analyser.fftSize = 2048;
      connect.call(node, analyser);
      return analyser;
    }
    AudioNode.prototype.connect = function (target, ...args) {
      if (this === window.opusPlaybackSource) window.opusInputTap = tap(this);
      if (target === this.context.destination && this.context instanceof AudioContext) window.opusOutputTap = tap(this);
      return connect.call(this, target, ...args);
    };
    window.opusRms = async () => {
      const input = window.opusInputTap;
      const output = window.opusOutputTap;
      if (!input || !output) return { input: 0, output: 0 };
      const values = new Float32Array(input.fftSize);
      const samples = { input: [], output: [] };
      for (let index = 0; index < 4; index++) {
        input.getFloatTimeDomainData(values);
        samples.input.push(Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length));
        output.getFloatTimeDomainData(values);
        samples.output.push(Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length));
        await new Promise(resolve => setTimeout(resolve, 45));
      }
      return { input: Math.max(...samples.input), output: Math.max(...samples.output) };
    };
  });
  return () => page.evaluate(() => window.opusRms());
}

test('keeps signed OpusHead gain consistent in actual PCM and preserves the original audio across effects changes', async ({ page }) => {
  const bytes = await readFile(fixture);
  const rms = await capturePlaybackPCM(page);
  const originalSources = [];
  const nav = name => page.locator('#sidebar [data-nav=' + name + ']');
  const audio = page.locator('#audio');
  const content = page.locator('#content');
  const selection = name => content.getByRole('button', { name: new RegExp('^' + name) });
  await page.goto('/#songs');
  // At fractional media volume, WebKit reapplies that volume upstream when a new source is loaded.
  await page.locator('#volume').fill('100');
  await audio.evaluate(element => { element.loop = true; });
  await page.locator('#import-files').setInputFiles([
    { name: 'Zero sample.opus', mimeType: 'audio/ogg', buffer: bytes },
    { name: 'Quiet sample.opus', mimeType: 'audio/ogg', buffer: Buffer.from(signedProbeSample(bytes, -12)) },
    { name: 'Loud sample.opus', mimeType: 'audio/ogg', buffer: Buffer.from(signedProbeSample(bytes, 6)) },
    { name: 'Clipping sample.opus', mimeType: 'audio/ogg', buffer: Buffer.from(signedProbeSample(bytes, 36)) },
  ]);
  const readTransferDb = async () => {
    const { input, output } = await rms();
    return 20 * Math.log10(output / input);
  };
  const decoder = await page.evaluate(async () => (await import('/opus-output-gain.js')).opusDecoderCapability());
  expect(['ignored', 'applied']).toContain(decoder);
  if (decoder === 'ignored') {
    await selection('Quiet sample').click();
    await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(.4);
    // Software correction can attach on first playback with the user effects still off.
    await expect.poll(async () => Math.abs(await readTransferDb() + 12)).toBeLessThan(.55);
  }
  await selection('Zero sample').click();
  await nav('settings').click();
  // A small fixed filter enables the existing audio graph on engines with native OpusHead handling.
  await content.locator('[data-eq="9"]').fill('-1');
  await content.locator('#eq-enabled').check();
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(.4);
  await expect.poll(async () => (await rms()).output).toBeGreaterThan(.02);
  const baseline = await rms();
  const readDb = async () => 20 * Math.log10((await rms()).output / baseline.output);
  let previousSource = await audio.evaluate(element => element.currentSrc);
  for (const [name, db] of [['Quiet sample', -12], ['Loud sample', 6]]) {
    await nav('songs').click();
    await selection(name).click();
    await expect.poll(() => audio.evaluate((element, previous) => element.currentSrc === element.src &&
      element.currentSrc.startsWith('blob:') && element.currentSrc !== previous, previousSource)).toBe(true);
    const source = await audio.evaluate(element => element.currentSrc);
    expect(source).toMatch(/^blob:/);
    expect(originalSources).not.toContain(source);
    originalSources.push(source);
    await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(.4);
    const expectedTransfer = decoder === 'ignored' ? db - 1 : -1;
    await expect.poll(async () => Math.abs(await readTransferDb() - expectedTransfer)).toBeLessThan(.55);
    await expect.poll(async () => Math.abs(await readDb() - db)).toBeLessThan(.55);
    await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(.05);
    expect(await audio.evaluate(element => ({ src: element.currentSrc, paused: element.paused }))).toEqual({ src: source, paused: false });
    previousSource = source;
  }
  await nav('settings').click();
  const original = content.getByRole('button', { name: '原声', exact: true });
  await original.click();
  await expect(original).toHaveAttribute('aria-pressed', 'true');
  // Original sound removes the existing 1 dB equalizer margin while keeping the file's gain.
  await expect.poll(async () => Math.abs(await readDb() - 7)).toBeLessThan(.55);
  expect(await audio.evaluate(element => ({ src: element.currentSrc, paused: element.paused }))).toEqual({ src: originalSources[1], paused: false });

  if (decoder === 'applied') return;
  await nav('songs').click();
  await selection('Clipping sample').click();
  await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(.4);
  await expect.poll(async () => Math.abs(await readDb() - 1)).toBeLessThan(.55);
});
