import { constants } from 'node:fs';
import { lstat, mkdir, open, link, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const accountKey = /^[A-Za-z0-9_-]{43}$/;
const providerId = /^[A-Za-z0-9_-]{1,256}$/;
const operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/;
const maxSnapshotBytes = 1_000_000;
const hash = data => createHash('sha256').update(data).digest('base64url');

export class ReservationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createDriveReservations({ dataDirectory, clientId, generateId }) {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 1024 || typeof generateId !== 'function') {
    throw new ReservationError('invalid_reservation_config');
  }
  const directory = join(dataDirectory, 'gdrive-playlist-reservations');
  const app = hash('Groovebox Drive snapshot reservation' + JSON.stringify(clientId));
  let ready;

  function initialize() {
    ready ??= (async () => {
      await mkdir(directory, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      if (!(await lstat(directory)).isDirectory()) throw new ReservationError('invalid_reservation_directory');
      await syncDirectory(dataDirectory);
    })().catch(error => {
      ready = undefined;
      throw error;
    });
    return ready;
  }

  function checked(record, expected) {
    if (!record || record.version !== 1 || record.app !== expected.app || record.account !== expected.account ||
        record.operation !== expected.operation || typeof record.id !== 'string' || !providerId.test(record.id) ||
        (expected.operation !== null && (typeof record.parent !== 'string' || !providerId.test(record.parent) ||
          typeof record.digest !== 'string' || !accountKey.test(record.digest)))) {
      throw new ReservationError('corrupt_reservation');
    }
    if (record.parent !== expected.parent || record.digest !== expected.digest) throw new ReservationError('operation_conflict');
    return record.id;
  }

  async function read(path, expected) {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > 2048) throw new ReservationError('corrupt_reservation');
      let record;
      try {
        record = JSON.parse(await file.readFile('utf8'));
      } catch {
        throw new ReservationError('corrupt_reservation');
      }
      return checked(record, expected);
    } catch (error) {
      if (!file && error.code === 'ENOENT') return undefined;
      throw error;
    } finally {
      await file?.close();
    }
  }

  async function reserve(account, operation, parent, digest) {
    if (typeof account !== 'string' || !accountKey.test(account)) throw new ReservationError('invalid_account');
    const name = hash(JSON.stringify([app, account, operation])) + '.json';
    const path = join(directory, name);
    const record = { version: 1, app, account, operation, parent, digest };
    await initialize();
    const previous = await read(path, record);
    if (previous) {
      await syncDirectory(directory);
      return previous;
    }
    const temporary = join(directory, '.' + name + '.' + randomUUID() + '.tmp');
    const id = await generateId({ account, kind: operation ? 'snapshot' : 'folder' });
    if (typeof id !== 'string' || !providerId.test(id)) throw new ReservationError('invalid_generated_id');
    try {
      await writeFile(temporary, JSON.stringify({ ...record, id }), { mode: 0o600, flag: 'wx', flush: true });
      try {
        await link(temporary, path);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const winner = await read(path, record);
      if (!winner) throw new ReservationError('reservation_unavailable');
      await syncDirectory(directory);
      return winner;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  return {
    folder: account => reserve(account, null, null, null),
    snapshot(account, operation, parent, bytes) {
      if (typeof operation !== 'string' || !operationId.test(operation) || typeof parent !== 'string' ||
          !providerId.test(parent) || !(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maxSnapshotBytes) {
        throw new ReservationError('invalid_snapshot_reservation');
      }
      return reserve(account, operation, parent, hash(bytes));
    },
  };
}
