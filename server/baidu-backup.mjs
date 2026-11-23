import { posix } from 'node:path';
import { maxPlaylistSnapshotBytes, readPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';
import { baiduBackupDirectory, baiduBackupName, baiduBackupOperation, BackupWriteError, createBaiduBackupFolder, createBaiduBackupWriter } from './baidu-backup-write.mjs';

const errors = new Map(Object.entries({
  backup_unavailable: [403, '服务器尚未启用百度网盘备份。'],
  invalid_backup_request: [400, '无效的百度网盘备份请求。'],
  invalid_snapshot: [400, '备份格式或账号不匹配。'],
  snapshot_too_large: [413, '百度网盘备份超过 1 MB。'],
  snapshot_media_type: [415, '请提交 JSON 歌单备份。'],
  snapshot_missing: [404, '找不到此百度网盘备份。'],
  backup_directory_missing: [404, '百度网盘应用目录中找不到 groovebox-backups。'],
  approved_app_directory_missing: [404, '找不到配置的百度网盘应用目录，请检查开放平台登记的应用目录。'],
  snapshot_unreadable: [422, '此百度网盘文件不是当前账号的有效备份。'],
  invalid_track_reference: [409, '备份中的百度网盘歌曲已不可用，请刷新曲库后重试。'],
  verification_unavailable: [502, '暂时无法验证备份中的百度网盘歌曲，请稍后重试。'],
  snapshot_conflict: [409, '同名备份已存在，原备份已保留。'],
  commit_unknown: [503, '暂时无法确认备份是否保存。可使用同一备份重试。'],
  authorization_required: [403, '百度网盘未授予备份写入权限，或授权已失效。'],
  destination_unavailable: [502, '无法确认百度网盘备份目录，请检查应用目录及权限。'],
  upstream_uncertain: [502, '百度网盘分片上传暂时失败，请稍后重试。'],
  upstream_rejected: [502, '百度网盘拒绝了备份上传，请检查应用目录和网盘空间。'],
  unsupported_precreate_result: [502, '百度网盘未返回可用的上传任务。'],
  part_checksum_mismatch: [502, '百度网盘分片校验失败。'],
}));

export function baiduBackupError(error) {
  const entry = error instanceof BackupWriteError && errors.get(error.code);
  return entry ? { status: entry[0], message: entry[1] } : undefined;
}

function fail(code) {
  throw new BackupWriteError(code);
}

async function readInput(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail('snapshot_media_type');
  if (Number(req.headers['content-length']) > maxPlaylistSnapshotBytes) fail('snapshot_too_large');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.byteLength;
    if (size > maxPlaylistSnapshotBytes) fail('snapshot_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function validateSnapshot(bytes, account, id, code) {
  let snapshot;
  try {
    snapshot = readPlaylistSnapshot(bytes, { provider: 'baidu', account });
  } catch {
    fail(code);
  }
  if (snapshot.operation !== id) fail(code);
  return snapshot;
}

const snapshotName = /^groovebox-playlists-([0-9a-f-]{36})\.json$/;
const listPageSize = 1000;
const maxDirectoryPages = 10;
const metadataBatchSize = 100; // Baidu's official filemetas limit.

export function createBaiduBackup({ appFolder, request, readFile, getAudioType, decodeText, netdiskId }) {
  const directory = baiduBackupDirectory(appFolder);
  const activeWrites = new Map();
  const activeDirectories = new Map();

  function describe(file) {
    const path = decodeText(file?.path);
    const name = posix.basename(path);
    const id = snapshotName.exec(name)?.[1] ?? '';
    if (path !== directory + '/' + name || !baiduBackupOperation.test(id) || String(file?.isdir) !== '0' ||
        (file.server_filename && decodeText(file.server_filename) !== name)) return;
    const fileId = netdiskId(file.fs_id);
    const size = Number(file.size);
    if (!fileId || !Number.isSafeInteger(size) || size <= 0 || size > maxPlaylistSnapshotBytes) return;
    const seconds = Number(file.server_mtime);
    const modifiedAt = Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 8_640_000_000_000 ? seconds * 1000 : 0;
    return { id, name, size, modifiedAt, fileId, path };
  }

  async function listPage(query, dir, signal, start, limit) {
    const { value } = await query('file', { method: 'list', dir, order: 'name', start, limit }, signal);
    if (!Array.isArray(value.list) || value.list.length > limit) fail('destination_unavailable');
    return value.list;
  }

  async function* directoryFiles(query, signal) {
    for (let page = 0; page < maxDirectoryPages; page++) {
      const list = await listPage(query, directory, signal, page * listPageSize, listPageSize).catch(error => {
        if (error.status === 404 && page === 0) fail('backup_directory_missing');
        throw error;
      });
      yield* list;
      if (list.length < listPageSize) return;
    }
    fail('destination_unavailable');
  }

  async function ensureDirectory({ account, query, token, assertActive }, signal) {
    if (activeDirectories.has(account)) return activeDirectories.get(account);
    const create = (async () => {
      await listPage(query, appFolder, signal, 0, 1).catch(error => {
        if (error.status === 404) fail('approved_app_directory_missing');
        throw error;
      });
      await createBaiduBackupFolder(request, token, directory, assertActive);
      await listPage(query, directory, signal, 0, 1).catch(error => {
        if (error.status === 404) fail('backup_directory_missing');
        throw error;
      });
    })();
    activeDirectories.set(account, create);
    try {
      await create;
    } finally {
      activeDirectories.delete(account);
    }
  }

  async function readRemoteSnapshot(path, { query, token, assertActive }, signal) {
    const targetName = posix.basename(path);
    for await (const file of directoryFiles(query, signal)) {
      if (decodeText(file?.path) !== path && decodeText(file?.server_filename) !== targetName) continue;
      const selected = describe(file);
      if (!selected || selected.path !== path) fail('snapshot_conflict');
      const { value } = await query('multimedia', {
        method: 'filemetas', fsids: '[' + selected.fileId + ']', dlink: '1',
      }, signal);
      const row = Array.isArray(value.list) && value.list.length === 1 && value.list[0];
      if (!row || netdiskId(row.fs_id) !== selected.fileId || Number(row.errno ?? 0) !== 0 ||
          decodeText(row.path) !== path || String(row.isdir) !== '0' || Number(row.size) !== selected.size) {
        fail('destination_unavailable');
      }
      assertActive();
      const bytes = await readFile(row, token, signal);
      if (bytes.byteLength !== selected.size) fail('destination_unavailable');
      return { path, bytes };
    }
    return null;
  }

  async function availableFiles(snapshot, query, signal) {
    const ids = snapshot.tracks.flatMap(track => track.file ? [track.file] : []);
    const available = [];
    for (let offset = 0; offset < ids.length; offset += metadataBatchSize) {
      const batch = ids.slice(offset, offset + metadataBatchSize);
      const { value } = await query('multimedia', { method: 'filemetas', fsids: '[' + batch.join(',') + ']' }, signal)
        .catch(error => {
          if (error.status === 401 || error.status === 429) throw error;
          fail('verification_unavailable');
        });
      if (!Array.isArray(value.list)) fail('verification_unavailable');
      const expected = new Set(batch);
      const playable = new Set();
      for (const row of value.list) {
        const id = netdiskId(row?.fs_id);
        if (!expected.delete(id)) fail('verification_unavailable');
        const errno = Number(row.errno ?? 0);
        if (errno === -9) continue;
        const isdir = String(row.isdir);
        const name = decodeText(row.filename ?? row.server_filename ?? row.path);
        if (errno !== 0 || !['0', '1'].includes(isdir) || (!name && isdir === '0')) fail('verification_unavailable');
        if (isdir === '0' && getAudioType(name)) playable.add(id);
      }
      available.push(...batch.filter(id => playable.has(id)));
    }
    return available;
  }

  function reply(res, bytes) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Length': bytes.byteLength,
    }).end(bytes);
  }

  async function serve(req, res, params, { identify, assertActive }) {
    if (!directory) fail('backup_unavailable');
    const id = params.get('id');
    const verify = params.get('verify');
    if (params.size !== Number(id !== null) + Number(verify !== null) ||
        (verify !== null && (verify !== '1' || req.method !== 'GET' || id === null)) ||
        (id !== null && !baiduBackupOperation.test(id)) ||
        (req.method === 'PUT' && id === null)) fail('invalid_backup_request');
    const bytes = req.method === 'PUT' ? await readInput(req) : undefined;
    const signal = AbortSignal.timeout(45_000);
    const identity = await identify(signal);
    const { account, query, token } = identity;
    const send = body => {
      assertActive();
      return reply(res, body);
    };
    let directoryMissing = false;
    const lookup = async (path, signal) => {
      try {
        return await readRemoteSnapshot(path, identity, signal);
      } catch (error) {
        if (error.code !== 'backup_directory_missing') throw error;
        directoryMissing = true;
        return null;
      }
    };
    if (req.method === 'PUT') {
      const snapshot = validateSnapshot(bytes, account, id, 'invalid_snapshot');
      const key = account + ':' + id;
      const current = activeWrites.get(key);
      if (current && !current.bytes.equals(bytes)) fail('snapshot_conflict');
      if (current) return send(Buffer.from(JSON.stringify({ status: await current.result, id })));
      const write = createBaiduBackupWriter({
        directory, token, request, lookupSnapshot: lookup, assertActive,
        async verifyReferences() {
          const available = await availableFiles(snapshot, query, signal);
          if (available.length !== snapshot.tracks.filter(track => track.file).length) fail('invalid_track_reference');
          if (directoryMissing) await ensureDirectory(identity, signal);
        },
      });
      const result = write(id, bytes);
      activeWrites.set(key, { bytes, result });
      try {
        return send(Buffer.from(JSON.stringify({ status: await result, id })));
      } finally {
        activeWrites.delete(key);
      }
    }
    if (id !== null) {
      const item = await lookup(directory + '/' + baiduBackupName(id), signal);
      if (!item) fail('snapshot_missing');
      const snapshot = validateSnapshot(item.bytes, account, id, 'snapshot_unreadable');
      if (verify === '1') {
        const available = await availableFiles(snapshot, query, signal);
        return send(Buffer.from(JSON.stringify({ snapshot: item.bytes.toString('utf8'), available })));
      }
      return send(item.bytes);
    }
    const snapshots = new Map();
    try {
      for await (const file of directoryFiles(query, signal)) {
        const item = describe(file);
        if (!item) continue;
        const { id, name, size, modifiedAt } = item;
        snapshots.set(id, { id, name, size, modifiedAt });
      }
    } catch (error) {
      if (error.code !== 'backup_directory_missing') throw error;
    }
    return send(Buffer.from(JSON.stringify({ account,
      snapshots: [...snapshots.values()].sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name)),
    })));
  }

  return { enabled: Boolean(directory), maxBytes: maxPlaylistSnapshotBytes, serve };
}
