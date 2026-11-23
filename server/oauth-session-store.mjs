import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const format = Buffer.from('GBX-OAUTH-01');
const maxFileSize = 8 * 1024 * 1024;

export function durableSession(entry, now) {
  if (!Number.isFinite(entry?.expiresAt) || entry.expiresAt <= now) return null;
  const { accessToken, refreshToken, expiresAt } = entry.token ?? {};
  if (typeof accessToken !== 'string' || !accessToken || !Number.isFinite(expiresAt)) return null;
  const refresh = typeof refreshToken === 'string' && refreshToken ? refreshToken : undefined;
  if (expiresAt <= now && !refresh) return null;
  return { token: { accessToken, refreshToken: refresh, expiresAt }, expiresAt: entry.expiresAt };
}

export function createSessionStore(file, secret, identity, normalize = durableSession) {
  const key = Buffer.from(hkdfSync('sha256', secret, identity, 'Groovebox authenticated sessions', 32));

  function read() {
    let data;
    try {
      if (statSync(file).size > maxFileSize) return new Map();
      data = readFileSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      throw error;
    }
    try {
      const index = format.length;
      if (data.length <= index + 28 || !data.subarray(0, index).equals(format)) return new Map();
      const decrypt = createDecipheriv('aes-256-gcm', key, data.subarray(index, index + 12));
      decrypt.setAAD(format);
      decrypt.setAuthTag(data.subarray(index + 12, index + 28));
      const raw = Buffer.concat([decrypt.update(data.subarray(index + 28)), decrypt.final()]);
      const sessions = JSON.parse(raw.toString('utf8'));
      const now = Date.now();
      const entries = new Map();
      for (const [id, entry] of sessions) {
        const durable = normalize(entry, now);
        if (durable && typeof id === 'string' && /^[\w-]{43}$/.test(id)) entries.set(id, durable);
      }
      return entries;
    } catch {
      return new Map();
    }
  }

  function write(sessions) {
    const snapshot = [];
    const now = Date.now();
    for (const [id, entry] of sessions) {
      const durable = normalize(entry, now);
      if (durable) snapshot.push([id, durable]);
    }
    const iv = randomBytes(12);
    const encrypt = createCipheriv('aes-256-gcm', key, iv);
    encrypt.setAAD(format);
    const data = Buffer.concat([encrypt.update(JSON.stringify(snapshot), 'utf8'), encrypt.final()]);
    const bundle = Buffer.concat([format, iv, encrypt.getAuthTag(), data]);
    if (bundle.length > maxFileSize) throw new Error('Session store size limit reached');
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomBytes(12).toString('hex') + '.tmp';
    try {
      writeFileSync(temp, bundle, { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  return { read, write };
}

export function createOAuthSessionRegistry(file, secret, identity, normalize) {
  const store = file ? createSessionStore(file, secret, identity, normalize) : null;
  let entries = store?.read() ?? new Map();

  return {
    get entries() { return entries; },
    commit(change) {
      if (!store) return change(entries);
      const next = new Map(entries);
      change(next);
      store.write(next);
      entries = next;
    },
    persist() {
      store?.write(entries);
    },
  };
}
