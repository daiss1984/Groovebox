import { createHash, createHmac } from 'node:crypto';
import { maxPlaylistSnapshotBytes, readPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';

const rpc = 'https://api.dropboxapi.com/2/';
const content = 'https://content.dropboxapi.com/2/files/';
export const dropboxBackupScopes = Object.freeze(['account_info.read', 'files.content.write']);
const accountId = /^dbid:[A-Za-z0-9_-]{1,128}$/;
const accountKey = /^[A-Za-z0-9_-]{43}$/;
const fileId = /^id:[A-Za-z0-9_-]{1,256}$/;
const operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const validRevision = /^[0-9a-f]{9,128}$/;
const blockSize = 4 * 1024 * 1024;

export class DropboxBackupError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DropboxBackupError';
    this.code = code;
  }
}

function fail(code) {
  throw new DropboxBackupError(code);
}

export function dropboxContentHash(bytes) {
  const hash = createHash('sha256');
  for (let start = 0; start < bytes.byteLength; start += blockSize) {
    hash.update(createHash('sha256').update(bytes.subarray(start, start + blockSize)).digest());
  }
  return hash.digest('hex');
}

async function discard(response) {
  await response.body?.cancel().catch(() => {});
}

async function readBytes(response, maximum) {
  if (!response.body || Number(response.headers.get('content-length')) > maximum) {
    await discard(response);
    fail('invalid_upstream_body');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maximum) fail('invalid_upstream_body');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof DropboxBackupError) throw error;
    fail('upstream_uncertain');
  }
  return Buffer.concat(chunks, size);
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* A malformed provider response is not evidence of absence. */ }
  fail('invalid_upstream_body');
}

async function responseObject(response) {
  return parseObject((await readBytes(response, 64_000)).toString('utf8'));
}

function matchNode(metadata, path) {
  const expectedName = path.slice(path.lastIndexOf('/') + 1);
  return typeof metadata?.id === 'string' && fileId.test(metadata.id) && metadata.path_lower === path &&
    typeof metadata.name === 'string' && metadata.name.toLowerCase() === expectedName &&
    metadata.sharing_info == null && metadata.has_explicit_shared_members !== true;
}

const errors = {
  backup_unavailable: [403, '服务器尚未启用 Dropbox 备份。'],
  backup_reconnect_required: [409, '请先用原来的权限重新连接 Dropbox，再授权备份。'],
  backup_scope_required: [403, '请先授权 Dropbox 歌单备份。'],
  session_changed: [401, 'Dropbox 授权已变更，请重新打开备份。'],
  account_mismatch: [403, '当前 Dropbox 账号与备份授权不匹配。'],
  authorization_required: [403, 'Dropbox 拒绝访问，请检查应用的备份权限。'],
  invalid_backup_request: [400, '无效的 Dropbox 备份请求。'],
  invalid_snapshot: [400, '备份格式或账号不匹配。'],
  snapshot_too_large: [413, 'Dropbox 备份超过 1 MB。'],
  snapshot_media_type: [415, '请提交 JSON 歌单备份。'],
  snapshot_missing: [404, '找不到此 Dropbox 备份。'],
  snapshot_unreadable: [422, '此 Dropbox 文件不是当前账号的有效备份。'],
  snapshot_conflict: [409, '同名备份已存在，原备份已保留。'],
  destination_conflict: [409, 'Dropbox 备份目录冲突，请检查专用目录。'],
  invalid_track_reference: [409, '备份中的 Dropbox 歌曲已不可用，请刷新曲库后重试。'],
  rate_limited: [429, 'Dropbox 请求过多，请稍后重试。'],
  verification_unavailable: [502, '暂时无法验证备份中的 Dropbox 歌曲，请稍后重试。'],
  destination_unavailable: [502, '无法确认 Dropbox 备份目录。'],
  destination_unknown: [503, '暂时无法确认备份目录是否创建，可使用同一备份重试。'],
  upload_rejected: [502, 'Dropbox 拒绝上传，请检查备份目录与网盘空间。'],
  commit_unknown: [503, '暂时无法确认备份是否保存，可使用同一备份重试。'],
};

export function dropboxBackupFailure(error) {
  if (!(error instanceof DropboxBackupError)) return;
  const [status, message] = errors[error.code] || [502, 'Dropbox 未能完成备份请求，请稍后重试。'];
  return { status, message, code: error.code };
}

export function dropboxAccountKey(clientId, secret, id) {
  if (typeof id !== 'string' || !accountId.test(id)) return undefined;
  return createHmac('sha256', secret).update(JSON.stringify(['Groovebox Dropbox playlist backup', clientId, id])).digest('base64url');
}

async function checkAccess(response) {
  if (response.status === 401) {
    const value = await responseObject(response).catch(() => undefined);
    if (value?.error?.['.tag'] === 'missing_scope') fail('backup_scope_required');
    fail('session_changed');
  }
  if (response.status === 403 || response.status === 429) {
    await discard(response);
    fail(response.status === 403 ? 'authorization_required' : 'rate_limited');
  }
}

export async function currentDropboxAccount(request, clientId, secret, token, signal = AbortSignal.timeout(12_000)) {
  const response = await request(rpc + 'users/get_current_account', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token },
    redirect: 'error', signal,
  });
  if (response.status !== 200) {
    await checkAccess(response);
    await discard(response);
    fail('account_unverified');
  }
  const account = await responseObject(response);
  const key = dropboxAccountKey(clientId, secret, account.account_id);
  if (!key || account.disabled === true) fail('account_unverified');
  return key;
}

async function readInput(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail('snapshot_media_type');
  if (Number(req.headers['content-length']) > maxPlaylistSnapshotBytes) fail('snapshot_too_large');
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.byteLength;
    if (length > maxPlaylistSnapshotBytes) fail('snapshot_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function validate(bytes, account, operation, code) {
  let snapshot;
  try {
    snapshot = readPlaylistSnapshot(bytes, { provider: 'dropbox', account });
  } catch {
    fail(code);
  }
  if (snapshot.operation !== operation) fail(code);
  return snapshot;
}

const snapshotName = operation => 'groovebox-playlists-' + operation + '.json';
const matchesName = /^groovebox-playlists-([0-9a-f-]{36})\.json$/;
const hashString = /^[0-9a-f]{64}$/;

export function createDropboxBackup({ request, mediaType }) {
  return async function serve(req, res, params, identify) {
    const id = params.get('id');
    const verify = params.get('verify');
    if (params.size !== Number(id !== null) + Number(verify !== null) ||
        (verify !== null && (verify !== '1' || req.method !== 'GET' || id === null)) ||
        (id !== null && !operationId.test(id)) || (req.method === 'PUT' && id === null)) fail('invalid_backup_request');

    const bytes = req.method === 'PUT' ? await readInput(req) : undefined;
    const { account, token, assertActive } = await identify();
    if (typeof account !== 'string' || !accountKey.test(account)) fail('account_unverified');
    const snapshot = bytes && validate(bytes, account, id, 'invalid_snapshot');
    const deadline = AbortSignal.timeout(60_000);
    // All paths remain within the effective root configured for the pinned Dropbox user app.
    const directory = '/groovebox-playlist-backups-' + account.slice(0, 20).toLowerCase();

    function reply(value) {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      assertActive();
      return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Length': body.length }).end(body);
    }

    async function post(url, options = {}) {
      assertActive();
      try {
        return await request(url, { ...options, method: 'POST',
          headers: { ...options.headers, Authorization: 'Bearer ' + token },
          redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
        });
      } catch {
        fail('upstream_uncertain');
      }
    }

    function call(route, fields) {
      return post(rpc + route, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
    }

    async function metadata(path) {
      const response = await call('files/get_metadata', { path, include_has_explicit_shared_members: true });
      if (response.status === 200) return responseObject(response);
      if (response.status === 409) {
        const { error } = await responseObject(response);
        if (error?.['.tag'] === 'path' && error.path?.['.tag'] === 'not_found') return null;
        fail('destination_unavailable');
      }
      await checkAccess(response);
      await discard(response);
      fail('destination_unavailable');
    }

    async function submit(send, route) {
      try {
        const response = await send();
        if (response.status === 409) {
          const { error } = await responseObject(response);
          const reason = error?.['.tag'] === 'path' ? (route === 'folder' ? error.path : error.reason) : undefined;
          if (reason?.['.tag'] === 'no_write_permission') fail('authorization_required');
          if (['insufficient_space', 'disallowed_name', 'malformed_path', 'team_folder', 'operation_suppressed'].includes(reason?.['.tag'])) {
            fail('upload_rejected');
          }
          return false;
        }
        if (response.status !== 429) await checkAccess(response);
        await discard(response);
        if (response.status === 200) return true;
        if ([408, 429].includes(response.status) || response.status >= 500) return false;
        fail('upload_rejected');
      } catch (error) {
        if (!['upstream_uncertain', 'invalid_upstream_body'].includes(error.code)) throw error;
        return false;
      }
    }

    async function checkFolder(expected) {
      const row = await metadata(directory);
      if (!row) return;
      if (row['.tag'] !== 'folder' || !matchNode(row, directory) || row.shared_folder_id != null ||
          (expected && row.id !== expected)) fail('destination_conflict');
      return row.id;
    }

    function describe(row, operation, tagged = true) {
      const path = directory + '/' + snapshotName(operation);
      if ((tagged && row?.['.tag'] !== 'file') || !matchNode(row, path) || row.is_downloadable === false ||
          !Number.isSafeInteger(row.size) || row.size < 1 || row.size > maxPlaylistSnapshotBytes ||
          typeof row.content_hash !== 'string' || !hashString.test(row.content_hash) ||
          typeof row.rev !== 'string' || !validRevision.test(row.rev)) return;
      return { id: operation, name: snapshotName(operation), size: row.size, modifiedAt: Math.max(0, Date.parse(row.server_modified) || 0) };
    }

    async function readSnapshot(operation, expected) {
      const path = directory + '/' + snapshotName(operation);
      const found = await metadata(path);
      if (!found) return;
      const failure = expected ? 'snapshot_conflict' : 'snapshot_unreadable';
      if (!describe(found, operation) || (expected && (found.size !== expected.length || found.content_hash !== dropboxContentHash(expected)))) {
        fail(failure);
      }
      const download = await post(content + 'download', {
        headers: { 'Dropbox-API-Arg': JSON.stringify({ path }), 'Accept-Encoding': 'identity' },
      });
      if (download.status !== 200 || ![null, 'identity'].includes(download.headers.get('content-encoding'))) {
        await checkAccess(download);
        await discard(download);
        fail('snapshot_unavailable');
      }
      try {
        const header = download.headers.get('dropbox-api-result');
        if (!header || header.length > 16_000) fail('invalid_upstream_body');
        const result = parseObject(header);
        if (!describe(result, operation, false) || result.id !== found.id || result.rev !== found.rev ||
            result.content_hash !== found.content_hash || result.size !== found.size) fail(failure);
      } catch (error) {
        await discard(download);
        throw error;
      }
      const uploaded = await readBytes(download, maxPlaylistSnapshotBytes);
      if (uploaded.byteLength !== found.size || dropboxContentHash(uploaded) !== found.content_hash ||
          (expected && !uploaded.equals(expected))) fail(failure);
      return uploaded;
    }

    async function listSnapshots() {
      const snapshots = new Map();
      const cursors = new Set();
      let cursor;
      for (let page = 0; page < 15; page++) {
        const response = await call(cursor ? 'files/list_folder/continue' : 'files/list_folder', cursor ? { cursor } : {
          path: directory, recursive: false, include_deleted: false, include_mounted_folders: false,
          include_has_explicit_shared_members: true, limit: 100,
        });
        if (!response.ok) {
          await checkAccess(response);
          await discard(response);
          fail('destination_unavailable');
        }
        const list = parseObject((await readBytes(response, 256_000)).toString('utf8'));
        if (!Array.isArray(list.entries) || list.entries.length > 1000 || typeof list.has_more !== 'boolean') fail('destination_unavailable');
        for (const row of list.entries) {
          const operation = typeof row?.name === 'string' && matchesName.exec(row.name.toLowerCase())?.[1];
          if (!operationId.test(operation ?? '')) continue;
          const entry = describe(row, operation);
          if (!entry) continue;
          const previous = snapshots.get(operation);
          if (previous && previous.fileId !== row.id) fail('snapshot_conflict');
          snapshots.set(operation, { fileId: row.id, entry });
        }
        if (!list.has_more) return [...snapshots.values()].map(({ entry }) => entry)
          .sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
        cursor = list.cursor;
        if (typeof cursor !== 'string' || !cursor.length || cursor.length > 8192 || cursors.has(cursor)) fail('destination_unavailable');
        cursors.add(cursor);
      }
      fail('destination_unavailable');
    }

    async function availableFiles(value) {
      const ids = value.tracks.flatMap(track => track.file ? [track.file] : []);
      const available = [];
      const batch = 8;
      for (let offset = 0; offset < ids.length; offset += batch) {
        const found = await Promise.all(ids.slice(offset, offset + batch).map(async id => {
          if (!fileId.test(id)) return;
          const row = await metadata(id).catch(error => {
            if (['session_changed', 'backup_scope_required', 'authorization_required', 'rate_limited'].includes(error.code)) throw error;
            fail('verification_unavailable');
          });
          if (!row) return;
          if (row.id !== id || typeof row.name !== 'string' || typeof row['.tag'] !== 'string') fail('verification_unavailable');
          const type = mediaType(row);
          if (type && type !== 'lyric') return id;
        }));
        available.push(...found.filter(Boolean));
      }
      return available;
    }

    let folder = await checkFolder();
    if (req.method === 'GET') {
      if (id === null) {
        const snapshots = folder ? await listSnapshots() : [];
        if (folder && !await checkFolder(folder)) fail('destination_unavailable');
        return reply({ account, snapshots });
      }
      if (!folder) fail('snapshot_missing');
      const uploaded = await readSnapshot(id);
      if (!uploaded) fail('snapshot_missing');
      const restored = validate(uploaded, account, id, 'snapshot_unreadable');
      const result = verify ? { snapshot: uploaded.toString('utf8'), available: await availableFiles(restored) } : uploaded;
      if (!await checkFolder(folder)) fail('snapshot_missing');
      return reply(result);
    }

    if (folder && await readSnapshot(id, bytes)) {
      if (!await checkFolder(folder)) fail('destination_unavailable');
      return reply({ status: 'already_present', id });
    }
    const available = await availableFiles(snapshot);
    if (available.length !== snapshot.tracks.filter(track => track.file).length) fail('invalid_track_reference');
    if (!folder) {
      await submit(() => call('files/create_folder_v2', { path: directory, autorename: false }), 'folder');
      try {
        folder = await checkFolder();
        if (!folder) fail('destination_unknown');
      } catch (error) {
        if (error.code === 'destination_conflict') throw error;
        fail('destination_unknown');
      }
    }
    if (!await checkFolder(folder)) fail('destination_unavailable');
    const path = directory + '/' + snapshotName(id);
    const accepted = await submit(() => post(content + 'upload', {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: false, strict_conflict: true,
          content_hash: dropboxContentHash(bytes) }),
      }, body: bytes,
    }), 'upload');
    try {
      if (!await checkFolder(folder) || !await readSnapshot(id, bytes)) fail('commit_unknown');
      return reply({ status: accepted ? 'saved' : 'reconciled', id });
    } catch (error) {
      if (['snapshot_conflict', 'destination_conflict'].includes(error.code)) throw error;
      fail('commit_unknown');
    }
  };
}
