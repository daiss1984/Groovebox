import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGenreClassifier, normalizeGenreRules } from '../public/genres.js';

test('keeps normalized full tags when genre rules are blank', () => {
  const classify = createGenreClassifier({ separators: '\n  \r\n', exceptions: '' });
  assert.deepEqual(classify([' R&B／ソウル ', 'rock / jazz', 'ROCK / JAZZ']), ['R&B／ソウル', 'rock / jazz']);
  assert.deepEqual(normalizeGenreRules(null), { separators: [], exceptions: [] });
});

test('matches literal separators, preferring the longest overlapping separator', () => {
  const classify = createGenreClassifier({ separators: ['+', '++', '／', '[.]', '\\', ' | '] });
  assert.deepEqual(classify(['First++Second+Third／第四', '一[.]二\\三', 'A|B | C']), [
    'First', 'Second', 'Third', '第四', '一', '二', '三', 'A|B', 'C',
  ]);
  assert.deepEqual(classify(['＋', '／／']), ['＋']);
});

test('keeps exact genre exceptions case-insensitively and splits other full tags', () => {
  const rules = normalizeGenreRules({ separators: '/\r\n／\r\n/', exceptions: 'R&B／ソウル\nr&b／ソウル\n Rock/Jazz ' });
  assert.deepEqual(rules, { separators: ['/', '／'], exceptions: ['R&B／ソウル', 'Rock/Jazz'] });
  const classify = createGenreClassifier(rules);
  assert.deepEqual(classify(['r&b／ソウル', 'Rock/Jazz']), ['r&b／ソウル', 'Rock/Jazz']);
  assert.deepEqual(classify(['Country/Rock/Jazz', 'R&B／ソウル／Ambient', 'country']), [
    'Country', 'Rock', 'Jazz', 'R&B', 'ソウル', 'Ambient',
  ]);
});
