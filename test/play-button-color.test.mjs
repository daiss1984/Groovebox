import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverColor, playButtonColors } from '../public/play-button-color.js';

test('samples the strongest cover color and excludes transparent pixels', () => {
  assert.deepEqual(coverColor(Uint8ClampedArray.from([
    28, 110, 200, 255, 31, 112, 220, 255, 255, 255, 255, 255, 255, 30, 35, 0,
  ])), [30, 111, 210]);
  assert.equal(coverColor(Uint8ClampedArray.from([100, 100, 100, 0])), undefined);
});

test('keeps readable foreground ink and adjusts colors that blend into the player panel', () => {
  assert.deepEqual(playButtonColors([30, 110, 200], '#171719'), { background: 'rgb(30, 110, 200)', text: 'white' });
  assert.deepEqual(playButtonColors([70, 170, 90], '#171719'), { background: 'rgb(70, 170, 90)', text: 'black' });
  const relativeLuminance = rgb => rgb.reduce((sum, component, index) => {
    const fraction = component / 255;
    const linear = fraction <= 0.04045 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
  const ratio = (first, second) => (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  for (const [cover, panel, panelRgb] of [
    [[0, 0, 0], '#171719', [23, 23, 25]], [[255, 255, 255], '#f3eee8', [243, 238, 232]],
  ]) {
    const { background, text } = playButtonColors(cover, panel);
    const rgb = background.match(/\d+/g).map(Number);
    assert.notDeepEqual(rgb, cover);
    assert.ok(ratio(relativeLuminance(rgb), relativeLuminance(panelRgb)) >= 3.5);
    assert.ok(ratio(relativeLuminance(rgb), text === 'black' ? 0 : 1) >= 4.5);
  }
});
