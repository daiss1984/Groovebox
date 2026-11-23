import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { classifyOpusProbe, opusHeader, signedProbeSample, verifiedOpusOutputGain } from '../public/opus-output-gain.js';

const fixture = new URL('../public/assets/opus-gain-probe.opus', import.meta.url);

test('reads signed CRC-verified Opus output gain and rejects chained or corrupt audio', async () => {
  const zero = await readFile(fixture);
  const quiet = new Uint8Array(signedProbeSample(zero, -12.5));
  const loud = new Uint8Array(signedProbeSample(zero, 6.125));
  assert.equal(opusHeader(zero).gainDb, 0);
  assert.equal(opusHeader(quiet).gainDb, -12.5);
  assert.equal(opusHeader(loud).gainDb, 6.125);
  const badCRC = quiet.slice();
  badCRC[22] ^= 1;
  assert.equal(opusHeader(badCRC), undefined);
  assert.equal(opusHeader(quiet.subarray(0, 45)), undefined);
  assert.equal(await verifiedOpusOutputGain(new Blob([quiet])), -12.5);
  assert.equal(await verifiedOpusOutputGain(new Blob([quiet, zero])), 0);
  assert.equal(await verifiedOpusOutputGain(new Blob([quiet.subarray(0, quiet.length - 1)])), 0);
  assert.equal(await verifiedOpusOutputGain(new Blob([badCRC])), 0);
});

test('leaves silent or inconclusive decoder measurements unclassified', () => {
  const amplitude = db => .04 * 10 ** (db / 20);
  assert.equal(classifyOpusProbe([0, -12, 6].map(amplitude)), 'applied');
  assert.equal(classifyOpusProbe([0, 0, 0].map(amplitude)), 'ignored');
  assert.equal(classifyOpusProbe([0, 12, -6].map(amplitude)), 'unknown');
  assert.equal(classifyOpusProbe([0, -12, 0].map(amplitude)), 'unknown');
  assert.equal(classifyOpusProbe([0, 0, 0]), 'unknown');
});
