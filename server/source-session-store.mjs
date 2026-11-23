import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const format = Buffer.from('GBX-SOURCE-01');
const filePattern = /^([a-f0-9]{64})\.enc$/;
const sessionPattern = /^[A-Za-z0-9_-]{43}$/;
const sessionLife = 7 * 24 * 60 * 60 * 1000;
const maxFileSize = 16 * 1024 * 1024;
const maxTotalSize = 128 * 1024 * 1024;
const maxSessions = 256;

export class SourceSessionStoreError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function sessionName(id) {
  if (typeof id !== 'string' || !sessionPattern.test(id)) throw new SourceSessionStoreError('invalid');
  return createHash('sha256').update(id).digest('hex');
}

export function createSourceSessionStore(directory, secret) {
  if (typeof directory !== 'string' || !directory || !(secret instanceof Uint8Array) || secret.byteLength !== 32) {
    throw new SourceSessionStoreError('unavailable');
  }
  const key = Buffer.from(hkdfSync('sha256', secret, format, 'Groovebox local source sessions', 32));
  const pathFor = name => join(directory, name + '.enc');
  const aad = name => Buffer.concat([format, Buffer.from(name, 'hex')]);

  function read(name, now) {
    const path = pathFor(name);
    let bytes;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size > maxFileSize) throw new SourceSessionStoreError('invalid');
      bytes = readFileSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SourceSessionStoreError) throw error;
      throw new SourceSessionStoreError('unavailable');
    }
    try {
      const offset = format.length;
      if (bytes.length <= offset + 28 || bytes.length > maxFileSize || !bytes.subarray(0, offset).equals(format)) throw new Error();
      const decrypt = createDecipheriv('aes-256-gcm', key, bytes.subarray(offset, offset + 12));
      decrypt.setAAD(aad(name));
      decrypt.setAuthTag(bytes.subarray(offset + 12, offset + 28));
      const data = JSON.parse(Buffer.concat([decrypt.update(bytes.subarray(offset + 28)), decrypt.final()]).toString('utf8'));
      if (data?.version !== 1 || !Number.isSafeInteger(data.expires) || data.expires <= 0 ||
          data.expires > now + sessionLife || !Array.isArray(data.sources) || data.sources.length > 30) throw new Error();
      return data;
    } catch { throw new SourceSessionStoreError('invalid'); }
  }

  function files() {
    try { return readdirSync(directory).flatMap(file => filePattern.exec(file)?.[1] ?? []); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new SourceSessionStoreError('unavailable');
    }
  }

  function prune(now, all = false) {
    for (const name of files()) {
      const path = pathFor(name);
      try {
        // Newly written sessions already have a future expiry. An old source snapshot may
        // still be live after another write, so read its fixed expiry before deleting it.
        if (!all && lstatSync(path).mtimeMs > now - sessionLife) continue;
        const data = read(name, now);
        if (data?.expires <= now) rmSync(path, { force: true });
      } catch (error) {
        if (!['ENOENT', 'invalid'].includes(error.code)) throw error;
      }
    }
  }

  function capacity(name, bundleSize) {
    const others = files().filter(file => file !== name);
    const total = others.reduce((size, file) => {
      try { return size + lstatSync(pathFor(file)).size; }
      catch (error) { if (error.code === 'ENOENT') return size; throw error; }
    }, bundleSize);
    return others.length < maxSessions && total <= maxTotalSize;
  }

  return {
    read(id, now) {
      const name = sessionName(id);
      const entry = read(name, now);
      if (entry && entry.expires <= now) {
        try { rmSync(pathFor(name), { force: true }); } catch { /* An expired session can never be restored. */ }
        return null;
      }
      return entry;
    },
    write(id, entry, now) {
      const name = sessionName(id);
      const path = pathFor(name);
      const temp = path + '.' + randomBytes(12).toString('hex') + '.tmp';
      if (!Number.isSafeInteger(entry?.expires) || entry.expires <= now || entry.expires > now + sessionLife ||
          !Array.isArray(entry.sources) || entry.sources.length > 30) throw new SourceSessionStoreError('invalid');
      let value;
      try { value = Buffer.from(JSON.stringify({ version: 1, expires: entry.expires, sources: entry.sources }), 'utf8'); }
      catch { throw new SourceSessionStoreError('invalid'); }
      const bundleSize = value.byteLength + format.byteLength + 28;
      if (bundleSize > maxFileSize) throw new SourceSessionStoreError('limit');
      try {
        // Check aggregate capacity before replacing the existing snapshot.
        prune(now);
        if (!capacity(name, bundleSize)) {
          prune(now, true);
          if (!capacity(name, bundleSize)) throw new SourceSessionStoreError('limit');
        }
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aad(name));
        const data = Buffer.concat([cipher.update(value), cipher.final()]);
        const bundle = Buffer.concat([format, nonce, cipher.getAuthTag(), data]);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(temp, bundle, { mode: 0o600, flag: 'wx', flush: true });
        renameSync(temp, path);
      } catch (error) {
        if (error instanceof SourceSessionStoreError) throw error;
        throw new SourceSessionStoreError('unavailable');
      } finally {
        try { rmSync(temp, { force: true }); } catch { /* A failed write cannot publish the temporary file. */ }
      }
    },
    remove(id) {
      try { rmSync(pathFor(sessionName(id)), { force: true }); }
      catch (error) { if (error instanceof SourceSessionStoreError) throw error; throw new SourceSessionStoreError('unavailable'); }
    },
  };
}
