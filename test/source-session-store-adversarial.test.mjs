import assert from 'node:assert/strict';
import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSourceSessionStore, SourceSessionStoreError } from '../server/source-session-store.mjs';

const now = 1_800_000_000_000;
const week = 7 * 24 * 60 * 60 * 1000;
const sessionA = Buffer.alloc(32, 0x14).toString('base64url');
const sessionB = Buffer.alloc(32, 0x98).toString('base64url');
const key = Buffer.alloc(32, 0x33);
const tokenA = 'synthetic-password-from-session-A';
const tokenB = 'synthetic-password-from-session-B';
const nameFor = value => createHash('sha256').update(value).digest('hex');
const snapshot = token => ({
  expires: now + 60_000,
  sources: [{ type: 'webdav', base: 'https://private-fixture.test/dav/', username: 'fixture', password: token }],
});

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'groovebox-source-storage-adversarial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'sessions');
  const file = id => join(directory, nameFor(id) + '.enc');
  return { directory, file, store: createSourceSessionStore(directory, key) };
}

function errorCode(code) {
  return error => error instanceof SourceSessionStoreError && error.code === code && error.message === code &&
    !JSON.stringify(error).includes('synthetic-password');
}

function typedInvalidCiphertext(id, data) {
  const format = Buffer.from('GBX-SOURCE-01');
  const derived = hkdfSync('sha256', key, format, 'Groovebox local source sessions', 32);
  const nonce = randomBytes(12);
  const encrypt = createCipheriv('aes-256-gcm', Buffer.from(derived), nonce);
  encrypt.setAAD(Buffer.concat([format, Buffer.from(nameFor(id), 'hex')]));
  const ciphertext = Buffer.concat([encrypt.update(JSON.stringify(data), 'utf8'), encrypt.final()]);
  return Buffer.concat([format, nonce, encrypt.getAuthTag(), ciphertext]);
}

test('persists two isolated source sessions with private modes and removes a disconnected session across reopen', t => {
  const { directory, file, store } = fixture(t);
  assert.equal(store.read(sessionA, now), null);
  assert.equal(fs.existsSync(directory), false);
  store.write(sessionA, snapshot(tokenA), now);
  store.write(sessionB, snapshot(tokenB), now);
  assert.deepEqual(fs.readdirSync(directory).sort(), [nameFor(sessionA) + '.enc', nameFor(sessionB) + '.enc'].sort());
  for (const id of [sessionA, sessionB]) {
    const bytes = fs.readFileSync(file(id));
    for (const privateValue of [tokenA, tokenB, id, 'private-fixture.test']) assert.equal(bytes.includes(privateValue), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file(id)).mode & 0o777, 0o600);
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const reopened = createSourceSessionStore(directory, key);
  assert.deepEqual(reopened.read(sessionA, now), { version: 1, ...snapshot(tokenA) });
  assert.deepEqual(reopened.read(sessionB, now), { version: 1, ...snapshot(tokenB) });
  reopened.remove(sessionA);
  reopened.remove(sessionA);
  assert.equal(fs.existsSync(file(sessionA)), false);
  const afterDisconnect = createSourceSessionStore(directory, key);
  assert.equal(afterDisconnect.read(sessionA, now), null);
  assert.deepEqual(afterDisconnect.read(sessionB, now), { version: 1, ...snapshot(tokenB) });
});

test('rejects swapped session records, tampered ciphertext and the wrong installation key', t => {
  const { directory, file, store } = fixture(t);
  store.write(sessionA, snapshot(tokenA), now);
  store.write(sessionB, snapshot(tokenB), now);
  const a = fs.readFileSync(file(sessionA));
  const b = fs.readFileSync(file(sessionB));
  fs.writeFileSync(file(sessionA), b);
  fs.writeFileSync(file(sessionB), a);
  for (const id of [sessionA, sessionB]) assert.throws(() => store.read(id, now), errorCode('invalid'));

  fs.writeFileSync(file(sessionA), a);
  const foreignInstallation = createSourceSessionStore(directory, Buffer.alloc(32, 0x44));
  assert.throws(() => foreignInstallation.read(sessionA, now), errorCode('invalid'));
  const damaged = Buffer.from(a);
  damaged[damaged.length - 1] ^= 0x80;
  for (const invalid of [damaged, a.subarray(0, 14)]) {
    fs.writeFileSync(file(sessionA), invalid);
    assert.throws(() => store.read(sessionA, now), errorCode('invalid'));
  }
  fs.writeFileSync(file(sessionA), a);
  assert.deepEqual(store.read(sessionA, now), { version: 1, ...snapshot(tokenA) });
});

test('rejects malformed authenticated envelopes and respects the exact seven-day expiry boundary', t => {
  const { file, store } = fixture(t);
  const valid = { ...snapshot(tokenA), expires: now + week };
  store.write(sessionA, valid, now);
  assert.deepEqual(store.read(sessionA, now), { version: 1, ...valid });
  assert.equal(store.read(sessionA, now + week), null);
  assert.equal(fs.existsSync(file(sessionA)), false);
  assert.equal(store.read(sessionA, now + week + 1), null);
  assert.throws(() => store.read('not-a-session', now), errorCode('invalid'));
  for (const malformed of [
    { version: 2, ...valid },
    { version: 1, ...valid, expires: now + week + 1 },
    { version: 1, ...valid, expires: String(now + week) },
    { version: 1, ...valid, sources: { password: tokenA } },
  ]) {
    fs.writeFileSync(file(sessionA), typedInvalidCiphertext(sessionA, malformed));
    assert.throws(() => store.read(sessionA, now), errorCode('invalid'));
  }
});

test('keeps the last valid state after invalid payloads or an oversized replacement', t => {
  const { directory, file, store } = fixture(t);
  const existing = snapshot(tokenA);
  store.write(sessionA, existing, now);
  const initialBytes = fs.readFileSync(file(sessionA));
  const cycle = {};
  cycle.self = cycle;
  for (const invalid of [
    { ...existing, expires: now },
    { ...existing, expires: now + week + 1 },
    { ...existing, sources: null },
    { ...existing, sources: [cycle] },
    { ...existing, sources: [{ token: 2n }] },
  ]) {
    assert.throws(() => store.write(sessionA, invalid, now), errorCode('invalid'));
    assert.deepEqual(fs.readFileSync(file(sessionA)), initialBytes);
  }
  assert.throws(() => store.write(sessionA, { ...existing, sources: [{ token: 'x'.repeat(16 * 1024 * 1024) }] }, now),
    errorCode('limit'));
  assert.deepEqual(store.read(sessionA, now), { version: 1, ...existing });
  assert.deepEqual(fs.readFileSync(file(sessionA)), initialBytes);
  assert.deepEqual(fs.readdirSync(directory), [nameFor(sessionA) + '.enc']);
});

test('reclaims an expired record at capacity and still rejects an additional live session', t => {
  const { directory, file, store } = fixture(t);
  const createdAt = Date.now();
  const expiredAt = createdAt + 1000;
  const first = { ...snapshot(tokenA), expires: expiredAt };
  store.write(sessionA, first, createdAt);
  for (let index = 0; index < 255; index++) {
    fs.writeFileSync(join(directory, index.toString(16).padStart(64, '0') + '.enc'), '');
  }
  const second = { ...snapshot(tokenB), expires: expiredAt + 60_000 };
  store.write(sessionB, second, expiredAt);
  assert.equal(fs.existsSync(file(sessionA)), false);
  assert.deepEqual(store.read(sessionB, expiredAt), { version: 1, ...second });
  const third = Buffer.alloc(32, 0x45).toString('base64url');
  const prior = fs.readFileSync(file(sessionB));
  assert.throws(() => store.write(third, second, expiredAt), errorCode('limit'));
  assert.equal(fs.existsSync(file(third)), false);
  assert.deepEqual(fs.readFileSync(file(sessionB)), prior);
});

test('a failed atomic rename leaves the durable predecessor unchanged and removes its temporary file', t => {
  const { directory, file, store } = fixture(t);
  const original = snapshot(tokenA);
  store.write(sessionA, original, now);
  const before = fs.readFileSync(file(sessionA));
  const renameSync = fs.renameSync;
  let injected = false;
  const rename = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === file(sessionA)) {
      assert.match(source, /\.enc\.[a-f\d]{24}\.tmp$/);
      assert.equal(fs.existsSync(source), true);
      assert.deepEqual(fs.readFileSync(destination), before);
      injected = true;
      throw Object.assign(new Error(tokenB + ' failed to publish'), { code: 'EIO' });
    }
    return renameSync(source, destination);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.write(sessionA, snapshot(tokenB), now), errorCode('unavailable'));
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.deepEqual(fs.readdirSync(directory), [nameFor(sessionA) + '.enc']);
  assert.deepEqual(fs.readFileSync(file(sessionA)), before);
  assert.deepEqual(createSourceSessionStore(directory, key).read(sessionA, now), { version: 1, ...original });
});
