import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function readInstallationKey(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'vault.key');
  try {
    writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600, flush: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const key = readFileSync(file);
  if (key.length !== 32) throw new Error('Invalid local installation key');
  return key;
}

export function readLocalSettings(file) {
  let bytes;
  try { bytes = readFileSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (bytes.length < 29 || bytes.length > 16384) throw new Error('Invalid local settings format');
  const decipher = createDecipheriv('aes-256-gcm', readInstallationKey(dirname(file)), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from('Groovebox local settings'));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const content = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  return JSON.parse(content.toString('utf8'));
}

export function writeLocalSettings(file, value) {
  const key = readInstallationKey(dirname(file));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('Groovebox local settings'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const temp = file + '.' + randomBytes(12).toString('hex') + '.tmp';
  try {
    writeFileSync(temp, Buffer.concat([nonce, cipher.getAuthTag(), data]), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
