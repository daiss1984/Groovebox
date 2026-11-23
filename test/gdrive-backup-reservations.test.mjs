import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createDriveReservations, ReservationError } from '../server/gdrive-backup-reservations.mjs';

const execute = promisify(execFile);
const account = 'a'.repeat(43);
const other = 'b'.repeat(43);
const operation = 'c4381e8a-d90a-4ef6-b04b-b03673f6f679';
const bytes = Buffer.from('playlist snapshot');
const client = 'synthetic-google-client';
const parent = 'verified_parent';
const expected = code => error => error instanceof ReservationError && error.code === code;

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'drive-reservations-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('retains allocated folder and snapshot IDs across journal restart without storing bytes', async t => {
  const dataDirectory = await sandbox(t);
  const calls = [];
  const initial = createDriveReservations({ dataDirectory, clientId: client, generateId({ kind, account }) {
    calls.push({ kind, account });
    return 'id_' + kind;
  } });
  const id = await initial.folder(account);
  assert.equal(id, 'id_folder');
  assert.equal(await initial.snapshot(account, operation, id, bytes), 'id_snapshot');
  const restarted = createDriveReservations({ dataDirectory, clientId: client, generateId: () => assert.fail('should reuse its reservation') });
  assert.equal(await restarted.folder(account), 'id_folder');
  assert.equal(await restarted.snapshot(account, operation, id, bytes), 'id_snapshot');
  assert.deepEqual(calls, [{ account, kind: 'folder' }, { account, kind: 'snapshot' }]);
  const journal = join(dataDirectory, 'gdrive-playlist-reservations');
  assert.equal((await lstat(journal)).mode & 0o777, 0o700);
  const fileNames = await readdir(journal);
  assert.equal(fileNames.length, 2);
  for (const name of fileNames) {
    assert.match(name, /^[\w-]{43}\.json$/);
    assert.equal((await lstat(join(journal, name))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(journal, name), 'utf8'), /playlist snapshot|synthetic-google-client/);
  }
});

test('publishes one immutable allocation among independent processes sharing a directory', async t => {
  const dataDirectory = await sandbox(t);
  const child = String.raw`
    const [module, dataDirectory, n, account, operation, parent] = process.argv.slice(1);
    const { createDriveReservations } = await import(module);
    const journal = createDriveReservations({ dataDirectory, clientId: 'synthetic-google-client',
      async generateId({ kind }) {
        await new Promise(resolve => setTimeout(resolve, 20));
        return kind + '_' + n;
      } });
    console.log(await journal.folder(account), await journal.snapshot(account, operation, parent, Buffer.from('playlist snapshot')));
  `;
  const module = new URL('../server/gdrive-backup-reservations.mjs', import.meta.url).href;
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => execute(process.execPath, [
    '--input-type=module', '--eval', child, module, dataDirectory, String(index), account, operation, parent,
  ])));
  const winners = new Set(results.map(({ stdout }) => stdout.trim()));
  assert.equal(winners.size, 1);
  assert.match([...winners][0], /^folder_\d snapshot_\d$/);
  assert.equal((await readdir(join(dataDirectory, 'gdrive-playlist-reservations'))).length, 2);
});

test('keeps operation identity fixed across payload and parent conflicts but isolates account and app', async t => {
  const dataDirectory = await sandbox(t);
  let calls = 0;
  const generateId = () => 'generated_' + ++calls;
  const initial = createDriveReservations({ dataDirectory, clientId: client, generateId });
  await initial.snapshot(account, operation, parent, bytes);
  await assert.rejects(initial.snapshot(account, operation, 'changed_parent', bytes), expected('operation_conflict'));
  await assert.rejects(initial.snapshot(account, operation, parent, Buffer.from('different')), expected('operation_conflict'));
  assert.equal(calls, 1);
  assert.equal(await initial.snapshot(other, operation, parent, bytes), 'generated_2');
  const different = createDriveReservations({ dataDirectory, clientId: 'other-app', generateId });
  assert.equal(await different.snapshot(account, operation, parent, bytes), 'generated_3');
  assert.equal(await initial.snapshot(account, operation, parent, bytes), 'generated_1');
});

test('preserves a conflicting first winner and treats a damaged reservation as an error, without allocation', async t => {
  const dataDirectory = await sandbox(t);
  const initial = createDriveReservations({ dataDirectory, clientId: client, generateId: () => 'first' });
  const otherWriter = createDriveReservations({ dataDirectory, clientId: client, generateId: () => 'second' });
  const results = await Promise.allSettled([
    initial.snapshot(account, operation, parent, bytes),
    otherWriter.snapshot(account, operation, parent, Buffer.from('different')),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.ok(expected('operation_conflict')(results.find(result => result.status === 'rejected').reason));
  const directory = join(dataDirectory, 'gdrive-playlist-reservations');
  const [file] = await readdir(directory);
  await writeFile(join(directory, file), 'damage');
  const noNew = createDriveReservations({ dataDirectory, clientId: client, generateId: () => assert.fail('must not replace damaged reservation') });
  await assert.rejects(noNew.snapshot(account, operation, parent, bytes), expected('corrupt_reservation'));
});

test('guards input and ignores failed generated allocations', async t => {
  const dataDirectory = await sandbox(t);
  const initial = createDriveReservations({ dataDirectory, clientId: client, generateId: () => '../invalid' });
  await assert.rejects(initial.folder('../elsewhere'), expected('invalid_account'));
  assert.throws(() => initial.snapshot(account, '../bad', parent, bytes), expected('invalid_snapshot_reservation'));
  await assert.rejects(initial.folder(account), expected('invalid_generated_id'));
  const repaired = createDriveReservations({ dataDirectory, clientId: client, generateId: () => 'valid' });
  assert.equal(await repaired.folder(account), 'valid');
});
