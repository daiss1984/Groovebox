import { createHash, randomBytes } from 'node:crypto';
import { createDriveReservations, ReservationError } from './gdrive-backup-reservations.mjs';
import { maxPlaylistSnapshotBytes, readPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';

const api = 'https://www.googleapis.com';
const files = '/drive/v3/files';
const multipart = '/upload/drive/v3/files';
const folderMime = 'application/vnd.google-apps.folder';
const folderName = 'Groovebox Playlist Backups';
const jsonMime = 'application/json';
const objectId = /^[A-Za-z0-9_-]{1,256}$/;
const accountId = /^[A-Za-z0-9_-]{43}$/;
const operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const metadataLimit = 256_000;
const fields = 'id,name,mimeType,parents,trashed,ownedByMe,shared,driveId,isAppAuthorized,appProperties,size,modifiedTime,capabilities(canAddChildren,canDownload)';
const marker = 'grooveboxKind';
const accountMarker = 'grooveboxAccount';
const operationMarker = 'grooveboxOperation';
const digestMarker = 'grooveboxSha256';
const folderKind = 'playlist-backup-folder-v1';
const snapshotKind = 'playlist-backup-snapshot-v1';
const reservedFileIds = new Set(['root', 'appDataFolder', 'generateIds']);

export class DriveBackupError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DriveBackupError';
    this.code = code;
  }
}

function fail(code) {
  throw new DriveBackupError(code);
}

async function discard(response) {
  await response.body?.cancel().catch(() => {});
}

async function bodyBytes(response, limit) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await discard(response);
    fail('invalid_upstream_body');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const part of response.body) {
      size += part.length;
      if (size > limit) fail('invalid_upstream_body');
      chunks.push(part);
    }
  } catch (error) {
    if (error instanceof DriveBackupError) throw error;
    fail('upstream_uncertain');
  }
  return Buffer.concat(chunks, size);
}

async function bodyJson(response) {
  const bytes = await bodyBytes(response, metadataLimit);
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* The provider envelope is checked before use. */ }
  fail('invalid_upstream_body');
}

function matchedProperties(file, properties) {
  return Object.entries(properties).every(([key, value]) => file.appProperties?.[key] === value);
}

function privateChild(file, id, parent, properties, name, mimeType) {
  return file.id === id && file.mimeType === mimeType && file.name === name &&
    file.trashed === false && file.ownedByMe === true && file.shared === false && file.isAppAuthorized === true &&
    file.driveId === undefined && Array.isArray(file.parents) && file.parents.length === 1 && file.parents[0] === parent &&
    matchedProperties(file, properties);
}

function multipartBody(metadata, bytes) {
  const boundary = 'groovebox_' + randomBytes(18).toString('hex');
  const head = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n';
  const body = Buffer.concat([Buffer.from(head, 'utf8'), bytes, Buffer.from('\r\n--' + boundary + '--\r\n')]);
  return { body, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary, 'Content-Length': String(body.length) } };
}

const errors = {
  invalid_backup_request: [400, '无效的 Google Drive 备份请求。'],
  invalid_snapshot: [400, '备份格式或账号不匹配。'],
  snapshot_too_large: [413, 'Google Drive 备份超过 1 MB。'],
  snapshot_media_type: [415, '请提交 JSON 歌单备份。'],
  snapshot_missing: [404, '找不到此 Google Drive 备份。'],
  snapshot_unreadable: [422, '此 Google Drive 文件不是当前账号的有效备份。'],
  session_changed: [401, 'Google Drive 授权已变更，请重新打开备份。'],
  backup_unavailable: [403, '服务器尚未启用 Google Drive 备份。'],
  backup_scope_required: [403, '请先授权 Google Drive 歌单备份。'],
  authorization_required: [403, 'Google Drive 拒绝访问，请检查备份权限。'],
  account_mismatch: [403, '当前 Google Drive 账号与备份授权不匹配。'],
  snapshot_conflict: [409, '同名备份已存在，原备份已保留。'],
  destination_conflict: [409, 'Google Drive 备份目录冲突，请检查专用目录。'],
  invalid_track_reference: [409, '备份中的 Google Drive 歌曲已不可用，请刷新曲库后重试。'],
  rate_limited: [429, 'Google Drive 请求过多，请稍后重试。'],
  verification_unavailable: [502, '暂时无法验证备份中的 Google Drive 歌曲，请稍后重试。'],
  destination_unavailable: [502, '无法确认 Google Drive 私有备份目录。'],
  destination_unknown: [503, '暂时无法确认备份目录是否创建，可使用同一备份重试。'],
  storage_unavailable: [503, '无法保留备份文件编号，请检查服务端数据目录。'],
  commit_unknown: [503, '暂时无法确认备份是否保存，可使用同一备份重试。'],
};

export function gdriveBackupFailure(error) {
  if (!(error instanceof DriveBackupError || error instanceof ReservationError)) return;
  const code = error.code === 'operation_conflict' ? 'snapshot_conflict' :
    error instanceof ReservationError ? 'storage_unavailable' : error.code;
  const [status, message] = errors[code] || [502, 'Google Drive 未能完成备份请求，请稍后重试。'];
  return { status, message, code };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('base64url');
}

function validObjectId(id) {
  return typeof id === 'string' && objectId.test(id) && !reservedFileIds.has(id);
}

function propertyFilter(key, value) {
  return "appProperties has { key='" + key + "' and value='" + value + "' }";
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
    snapshot = readPlaylistSnapshot(bytes, { provider: 'gdrive', account });
  } catch {
    fail(code);
  }
  if (snapshot.operation !== operation) fail(code);
  return snapshot;
}

function writeResponse(res, bytes) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Length': bytes.byteLength,
  }).end(bytes);
}

export function createGdriveBackup({ clientId, dataDirectory, request, mediaType }) {
  return async function serve(req, res, params, identify) {
    const id = params.get('id');
    const verify = params.get('verify');
    if (params.size !== Number(id !== null) + Number(verify !== null) ||
        (verify !== null && (verify !== '1' || req.method !== 'GET' || id === null)) ||
        (id !== null && !operationId.test(id)) || (req.method === 'PUT' && id === null)) fail('invalid_backup_request');
    const bytes = req.method === 'PUT' ? await readInput(req) : undefined;
    const { account, token, assertActive } = await identify();
    const snapshot = bytes && validate(bytes, account, id, 'invalid_snapshot');
    const deadline = AbortSignal.timeout(60_000);

    function reply(value) {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      assertActive();
      return writeResponse(res, body);
    }

    async function send(path, parameters, init = {}) {
      assertActive();
      const url = new URL(path, api);
      url.search = new URLSearchParams(parameters);
      try {
        return await request(url, {
          ...init, headers: { ...init.headers, Authorization: 'Bearer ' + token },
          redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
        });
      } catch {
        fail('upstream_uncertain');
      }
    }

    async function getJson(path, parameters, allowMissing = false) {
      const response = await send(path, parameters);
      if (response.ok) return bodyJson(response);
      await discard(response);
      if (allowMissing && response.status === 404) return undefined;
      if (response.status === 401) fail('session_changed');
      if (response.status === 403) fail('authorization_required');
      if (response.status === 429) fail('rate_limited');
      fail('upstream_unavailable');
    }

    async function create(path, parameters, init) {
      try {
        const response = await send(path, parameters, { method: 'POST', ...init });
        await discard(response);
        if (response.ok) return true;
        if ([408, 409, 429].includes(response.status) || response.status >= 500) return false;
        if (response.status === 401) fail('session_changed');
        if (response.status === 403) fail('authorization_required');
        fail('upload_rejected');
      } catch (error) {
        if (error.code !== 'upstream_uncertain') throw error;
        return false;
      }
    }

    async function* findFiles(q) {
      let pageToken;
      const pageTokens = new Set();
      for (let page = 0; page < 12; page++) {
        const list = await getJson(files, { q, fields: 'nextPageToken,incompleteSearch,files(' + fields + ')',
          spaces: 'drive', corpora: 'user', pageSize: '50', ...(pageToken && { pageToken }) });
        if (!Array.isArray(list.files) || list.files.length > 50 || list.incompleteSearch === true) fail('destination_unavailable');
        yield* list.files;
        pageToken = list.nextPageToken;
        if (pageToken === undefined) return;
        if (typeof pageToken !== 'string' || !pageToken.length || pageToken.length > 2048 || pageTokens.has(pageToken)) {
          fail('destination_unavailable');
        }
        pageTokens.add(pageToken);
      }
      fail('destination_unavailable');
    }

    const root = await getJson(files + '/root', { fields: 'id,mimeType,trashed' });
    if (!validObjectId(root.id) || root.mimeType !== folderMime || root.trashed !== false) {
      fail('destination_unavailable');
    }
    const folderProperties = { [marker]: folderKind, [accountMarker]: account };
    const folderCheck = (file, folderId, writable) =>
      privateChild(file, folderId, root.id, folderProperties, folderName, folderMime) &&
      (!writable || file.capabilities?.canAddChildren === true);

    function destinationQuery(parent, mimeType, kind) {
      return "'" + parent + "' in parents and trashed = false and mimeType = '" + mimeType + "' and " +
        propertyFilter(marker, kind) + ' and ' + propertyFilter(accountMarker, account);
    }

    let existingFolder;
    for await (const file of findFiles(destinationQuery(root.id, folderMime, folderKind))) {
      if (!validObjectId(file?.id) || !folderCheck(file, file.id, req.method === 'PUT') ||
          (existingFolder && existingFolder !== file.id)) fail('destination_conflict');
      existingFolder = file.id;
    }

    async function checkFolder(folderId, writable) {
      const file = await getJson(files + '/' + folderId, { fields }, true);
      if (file && !folderCheck(file, folderId, writable)) fail('destination_conflict');
      return Boolean(file);
    }

    function describe(file, folderId) {
      const operation = file?.appProperties?.[operationMarker];
      const checksum = file?.appProperties?.[digestMarker];
      if (!validObjectId(file?.id) || typeof operation !== 'string' ||
          !operationId.test(operation) || typeof checksum !== 'string' || !accountId.test(checksum)) return;
      const name = 'groovebox-playlists-' + operation + '.json';
      const properties = { [marker]: snapshotKind, [accountMarker]: account, [operationMarker]: operation, [digestMarker]: checksum };
      const size = Number(file.size);
      if (!privateChild(file, file.id, folderId, properties, name, jsonMime) || file.capabilities?.canDownload === false ||
          !Number.isSafeInteger(size) || size < 1 || size > maxPlaylistSnapshotBytes) return;
      return { operation, name, size, modifiedAt: Math.max(0, Date.parse(file.modifiedTime) || 0), remoteId: file.id, checksum };
    }

    async function snapshotEntries(folderId, operation) {
      let q = destinationQuery(folderId, jsonMime, snapshotKind);
      if (operation) q += ' and ' + propertyFilter(operationMarker, operation);
      const entries = new Map();
      for await (const file of findFiles(q)) {
        const item = describe(file, folderId);
        if (!item || (operation && operation !== item.operation)) {
          if (operation) fail('snapshot_conflict');
          continue;
        }
        const previous = entries.get(item.operation);
        if (previous && previous.remoteId !== item.remoteId) fail('snapshot_conflict');
        entries.set(item.operation, item);
      }
      return entries;
    }

    async function remoteSnapshot(folderId, remoteId, operation, expectedBytes) {
      const path = files + '/' + remoteId;
      const file = await getJson(path, { fields }, true);
      if (!file) return;
      const item = describe(file, folderId);
      const failure = expectedBytes ? 'snapshot_conflict' : 'snapshot_unreadable';
      if (!item || item.remoteId !== remoteId || item.operation !== operation ||
          (expectedBytes && (item.size !== expectedBytes.byteLength || item.checksum !== digest(expectedBytes)))) fail(failure);
      const response = await send(path, { alt: 'media' }, { headers: { 'Accept-Encoding': 'identity' } });
      if (response.status !== 200 || ![null, 'identity'].includes(response.headers.get('content-encoding'))) {
        await discard(response);
        if (response.status === 401) fail('session_changed');
        if (response.status === 403) fail('authorization_required');
        if (response.status === 429) fail('rate_limited');
        fail('snapshot_unavailable');
      }
      const uploaded = await bodyBytes(response, maxPlaylistSnapshotBytes);
      if (uploaded.byteLength !== item.size || digest(uploaded) !== item.checksum ||
          (expectedBytes && !uploaded.equals(expectedBytes))) fail(failure);
      return uploaded;
    }

    async function availableFiles(snapshot) {
      const ids = snapshot.tracks.flatMap(track => track.file ? [track.file] : []);
      const available = [];
      const batch = 8;
      for (let offset = 0; offset < ids.length; offset += batch) {
        const candidates = await Promise.all(ids.slice(offset, offset + batch).map(async id => {
          if (!validObjectId(id)) return;
          const row = await getJson(files + '/' + id, {
            supportsAllDrives: 'true', fields: 'id,name,mimeType,trashed,capabilities(canDownload)',
          }, true).catch(error => {
            if (['session_changed', 'authorization_required', 'rate_limited'].includes(error.code)) throw error;
            fail('verification_unavailable');
          });
          if (!row) return;
          if (row.id !== id || typeof row.name !== 'string' || typeof row.mimeType !== 'string') fail('verification_unavailable');
          const type = mediaType(row);
          if (type && type !== 'lyric') return id;
        }));
        available.push(...candidates.filter(Boolean));
      }
      return available;
    }

    async function verifyReferences() {
      const available = await availableFiles(snapshot);
      if (available.length !== snapshot.tracks.filter(track => track.file).length) fail('invalid_track_reference');
    }

    if (req.method === 'GET') {
      if (!existingFolder) {
        if (id !== null) fail('snapshot_missing');
        return reply({ account, snapshots: [] });
      }
      if (!await checkFolder(existingFolder, false)) fail('destination_unavailable');
      const entries = await snapshotEntries(existingFolder, id);
      if (id === null) {
        const snapshots = [...entries.values()].map(({ operation: id, name, size, modifiedAt }) => ({ id, name, size, modifiedAt }));
        snapshots.sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name));
        return reply({ account, snapshots });
      }
      const selected = entries.get(id);
      if (!selected) fail('snapshot_missing');
      const uploaded = await remoteSnapshot(existingFolder, selected.remoteId, id);
      if (!uploaded) fail('snapshot_missing');
      const restored = validate(uploaded, account, id, 'snapshot_unreadable');
      if (verify) return reply({ snapshot: uploaded.toString('utf8'), available: await availableFiles(restored) });
      return reply(uploaded);
    }

    let existingSnapshot;
    const journal = createDriveReservations({
      dataDirectory, clientId,
      async generateId({ kind }) {
        if (kind === 'folder' && existingFolder) return existingFolder;
        if (kind === 'snapshot' && existingSnapshot) return existingSnapshot.remoteId;
        const generated = await getJson(files + '/generateIds', { count: '1', space: 'drive', type: 'files', fields: 'ids,space' });
        if (generated.space !== 'drive' || !Array.isArray(generated.ids) || generated.ids.length !== 1 ||
            !validObjectId(generated.ids[0])) fail('invalid_generated_id');
        return generated.ids[0];
      },
    });
    const reserve = promise => promise.catch(error => {
      if (error instanceof DriveBackupError || error instanceof ReservationError) throw error;
      fail('storage_unavailable');
    });
    const folderId = await reserve(journal.folder(account));
    if (!validObjectId(folderId)) fail('destination_conflict');
    if (existingFolder && existingFolder !== folderId) fail('destination_conflict');

    let verified = false;
    if (!await checkFolder(folderId, true)) {
      if (existingFolder) fail('destination_unavailable');
      await verifyReferences();
      verified = true;
      await create(files, { fields }, {
        headers: { 'Content-Type': jsonMime },
        body: JSON.stringify({ id: folderId, name: folderName, mimeType: folderMime, appProperties: folderProperties }),
      });
      if (!await checkFolder(folderId, true)) fail('destination_unknown');
    }
    existingSnapshot = (await snapshotEntries(folderId, id)).get(id);
    const remoteId = await reserve(journal.snapshot(account, id, folderId, bytes));
    if (!validObjectId(remoteId)) fail('snapshot_conflict');
    if (existingSnapshot && existingSnapshot.remoteId !== remoteId) fail('snapshot_conflict');
    if (await remoteSnapshot(folderId, remoteId, id, bytes)) {
      if (!await checkFolder(folderId, true)) fail('destination_unavailable');
      return reply({ status: 'already_present', id });
    }
    if (existingSnapshot) fail('snapshot_unavailable');
    if (!verified) await verifyReferences();
    if (!await checkFolder(folderId, true)) fail('destination_unavailable');
    const name = 'groovebox-playlists-' + id + '.json';
    const appProperties = { [marker]: snapshotKind, [accountMarker]: account, [operationMarker]: id, [digestMarker]: digest(bytes) };
    const accepted = await create(multipart, { fields, uploadType: 'multipart' },
      multipartBody({ id: remoteId, name, mimeType: jsonMime, parents: [folderId], appProperties }, bytes));
    try {
      if (!await checkFolder(folderId, true) || !await remoteSnapshot(folderId, remoteId, id, bytes)) fail('commit_unknown');
      return reply({ status: accepted ? 'saved' : 'reconciled', id });
    } catch (error) {
      if (error.code === 'snapshot_conflict' || error.code === 'destination_conflict') throw error;
      fail('commit_unknown');
    }
  };
}
