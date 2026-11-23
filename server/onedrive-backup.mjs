import { maxPlaylistSnapshotBytes, readPlaylistSnapshot } from '../public/cloud-playlist-snapshot.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const filename = id => 'groovebox-playlists-' + id + '.json';
const namePattern = /^groovebox-playlists-([0-9a-f-]{36})\.json$/;
const itemFields = 'id,name,file,folder,remoteItem,deleted,shared,size,eTag,lastModifiedDateTime,parentReference';
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const errors = {
  backup_disabled: [403, '此环境未启用 OneDrive 歌单备份。'],
  backup_scope_required: [403, '请单独授权 OneDrive 歌单备份。'],
  backup_unavailable: [403, '当前 OneDrive 账号或应用不支持歌单备份。'],
  account_mismatch: [403, 'OneDrive 授权账号或网盘已变化。'],
  origin_mismatch: [403, '请在播放器中管理 OneDrive 歌单备份。'],
  session_changed: [401, 'OneDrive 会话已变化，请重新连接。'],
  invalid_snapshot: [400, '备份格式或账号不匹配。'],
  invalid_snapshot_id: [400, 'OneDrive 备份标识无效。'],
  snapshot_media_type: [415, '请提交 JSON 歌单备份。'],
  snapshot_too_large: [413, 'OneDrive 歌单备份超过 1 MB。'],
  snapshot_missing: [404, '找不到此 OneDrive 备份。'],
  snapshot_unreadable: [422, '此 OneDrive 文件不是当前账号的有效备份。'],
  snapshot_conflict: [409, '同名备份已存在，原备份已保留。'],
  destination_conflict: [409, 'OneDrive 备份目录或文件已变化。'],
  invalid_track_reference: [409, '部分歌曲在当前 OneDrive 中不可用。'],
  commit_unknown: [503, '暂时无法确认备份是否已上传。'],
  upstream_unavailable: [502, 'OneDrive 歌单备份暂时不可用。'],
};

export class OnedriveBackupError extends Error {
  constructor(code) {
    super(errors[code][1]);
    this.status = errors[code][0];
    this.code = code;
  }
}

function fail(code) { throw new OnedriveBackupError(code); }

async function discard(response) { await response.body?.cancel().catch(() => {}); }

async function bytesFrom(stream, limit, tooLarge) {
  const parts = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) fail(tooLarge);
    parts.push(chunk);
  }
  return Buffer.concat(parts, length);
}

async function responseBytes(response, limit, failure) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await discard(response);
    fail(failure);
  }
  return bytesFrom(response.body, limit, failure);
}

async function json(response) {
  try { return JSON.parse(await responseBytes(response, 2_000_000, 'upstream_unavailable')); }
  catch { fail('upstream_unavailable'); }
}

function validate(bytes, scope, id, failure) {
  let snapshot;
  try { snapshot = readPlaylistSnapshot(bytes, scope); }
  catch { fail(failure); }
  if (snapshot.operation !== id) fail(failure);
  return snapshot;
}

function uploadURL(value) {
  let url;
  try { url = new URL(value); }
  catch { fail('upstream_unavailable'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.up.1drv.com') || url.port || url.username || url.password || url.hash) {
    fail('upstream_unavailable');
  }
  return url;
}

export function createOnedriveBackup({ graph, itemKey, itemType, downloadURL }) {
  function endpoint(path, fields) {
    const url = new URL(graph + path);
    if (fields) url.searchParams.set('$select', fields);
    return url;
  }
  function validId(value) { return typeof value === 'string' && itemKey.test(value); }

  return async function backup(req, res, url, { account, driveId, graphRequest, signedRequest, checkSession }) {
    const id = url.searchParams.get('id');
    const verify = url.searchParams.get('verify');
    if (url.searchParams.getAll('id').length > 1 || url.searchParams.getAll('verify').length > 1 ||
        (id !== null && !uuid.test(id)) || (req.method === 'PUT' && id === null) ||
        (verify !== null && (verify !== '1' || id === null || req.method !== 'GET'))) fail('invalid_snapshot_id');
    const scope = { provider: 'onedrive', account };
    let bytes;
    let snapshot;
    if (req.method === 'PUT') {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail('snapshot_media_type');
      if (Number(req.headers['content-length']) > maxPlaylistSnapshotBytes) fail('snapshot_too_large');
      bytes = await bytesFrom(req.iterator({ destroyOnReturn: false }), maxPlaylistSnapshotBytes, 'snapshot_too_large');
      snapshot = validate(bytes, scope, id, 'invalid_snapshot');
    }

    function reply(value) {
      checkSession();
      const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }).end(body);
    }

    async function graphResult(target, options, missing) {
      const response = await graphRequest(target, options);
      if (response.ok) return response;
      await discard(response);
      if (missing && response.status === 404) return null;
      if (response.status === 401) fail('session_changed');
      if (response.status === 403) fail('backup_unavailable');
      fail('upstream_unavailable');
    }

    const root = await json(await graphResult(endpoint('/special/approot', 'id,folder,specialFolder,remoteItem,deleted,shared,parentReference')));
    if (!validId(root?.id) || !root.folder || root.specialFolder?.name !== 'approot' || root.parentReference?.driveId !== driveId ||
        root.remoteItem || root.deleted || root.shared) {
      fail('destination_conflict');
    }
    const folder = '/items/' + encodeURIComponent(root.id);
    const inFolder = item => item?.parentReference?.driveId === driveId && item.parentReference.id === root.id &&
      validId(item.id) && item.file && !item.folder && !item.remoteItem && !item.deleted && !item.shared;
    function snapshotItem(item) {
      const operation = namePattern.exec(item?.name ?? '')?.[1];
      return operation && uuid.test(operation) && inFolder(item) && typeof item.eTag === 'string' && item.eTag.trim() &&
        Number.isSafeInteger(item.size) && item.size > 0 && item.size <= maxPlaylistSnapshotBytes
        ? { id: operation, name: item.name, size: item.size, modifiedAt: Date.parse(item.lastModifiedDateTime) || 0 }
        : undefined;
    }

    async function folderSnapshot() {
      const path = endpoint(folder + ':/' + filename(id) + ':', itemFields);
      const response = await graphResult(path, undefined, true);
      if (!response) return;
      const item = await json(response);
      if (snapshotItem(item)?.id !== id) fail(bytes ? 'snapshot_conflict' : 'snapshot_unreadable');
      let content = await graphRequest(endpoint('/items/' + encodeURIComponent(item.id) + '/content'), { redirect: 'manual' });
      let signed = false;
      for (let hops = 0; redirectStatuses.has(content.status) && hops < 5; hops++) {
        const location = content.headers.get('location');
        const base = content.url || graph;
        await discard(content);
        let target;
        try { target = downloadURL(location, base); }
        catch { fail('upstream_unavailable'); }
        content = await signedRequest(target, { redirect: 'manual' });
        signed = true;
      }
      if (content.status !== 200) {
        await discard(content);
        if (!signed && content.status === 401) fail('session_changed');
        if (!signed && content.status === 403) fail('backup_unavailable');
        fail('upstream_unavailable');
      }
      const data = await responseBytes(content, maxPlaylistSnapshotBytes, bytes ? 'snapshot_conflict' : 'snapshot_unreadable');
      if (data.length !== item.size) fail(bytes ? 'snapshot_conflict' : 'snapshot_unreadable');
      const currentResponse = await graphResult(path, undefined, true);
      const current = currentResponse && await json(currentResponse);
      if (snapshotItem(current)?.id !== id || current.id !== item.id || current.size !== item.size || current.eTag !== item.eTag) {
        fail('destination_conflict');
      }
      return data;
    }

    async function availableFiles(value) {
      const ids = value.tracks.flatMap(track => track.file ? [track.file] : []);
      const available = [];
      for (let index = 0; index < ids.length; index += 8) {
        const batch = await Promise.all(ids.slice(index, index + 8).map(async file => {
          const response = await graphResult(endpoint('/items/' + encodeURIComponent(file), 'id,name,file,folder,remoteItem,deleted,parentReference'), undefined, true);
          if (!response) return;
          const item = await json(response);
          const type = itemType(item);
          if (item?.id === file && item.parentReference?.driveId === driveId && !item.remoteItem && !item.deleted && type && type !== 'lyrics') return file;
        }));
        available.push(...batch.filter(Boolean));
      }
      return available;
    }

    if (req.method === 'GET' && id === null) {
      let page = endpoint(folder + '/children', itemFields);
      const path = page.pathname;
      const seen = new Set();
      const entries = new Map();
      while (page) {
        if (seen.has(page.href) || seen.size >= 1000) fail('upstream_unavailable');
        seen.add(page.href);
        const data = await json(await graphResult(page));
        if (!Array.isArray(data?.value)) fail('upstream_unavailable');
        for (const item of data.value) {
          const entry = snapshotItem(item);
          if (!entry) continue;
          if (entries.has(entry.id) && entries.get(entry.id).key !== item.id) fail('destination_conflict');
          entries.set(entry.id, { key: item.id, entry });
        }
        const next = data['@odata.nextLink'];
        if (!next) break;
        try { page = new URL(next); } catch { fail('upstream_unavailable'); }
        if (page.origin !== new URL(graph).origin || page.pathname !== path || page.username || page.password || page.hash) fail('upstream_unavailable');
      }
      const snapshots = [...entries.values()].map(value => value.entry);
      return reply({ account, snapshots: snapshots.sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name)) });
    }

    if (req.method === 'GET') {
      const uploaded = await folderSnapshot();
      if (!uploaded) fail('snapshot_missing');
      const restored = validate(uploaded, scope, id, 'snapshot_unreadable');
      return reply(verify ? { snapshot: uploaded.toString('utf8'), available: await availableFiles(restored) } : uploaded);
    }

    const sameSnapshot = async () => {
      const existing = await folderSnapshot();
      if (!existing) return false;
      if (!existing.equals(bytes)) fail('snapshot_conflict');
      return true;
    };
    if (await sameSnapshot()) return reply({ status: 'already_present', id });
    const available = await availableFiles(snapshot);
    if (available.length !== snapshot.tracks.filter(track => track.file).length) fail('invalid_track_reference');

    let reported = false;
    let conflict = false;
    try {
      // The upload-session API explicitly supports create-without-overwrite, including at final commit.
      const initiated = await graphRequest(endpoint(folder + ':/' + filename(id) + ':/createUploadSession'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { name: filename(id), '@microsoft.graph.conflictBehavior': 'fail' } }),
      });
      if (initiated.ok) {
        const upload = uploadURL((await json(initiated))?.uploadUrl);
        const result = await signedRequest(upload, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
            'Content-Range': 'bytes 0-' + (bytes.length - 1) + '/' + bytes.length }, body: bytes, redirect: 'error',
        });
        reported = result.status === 201;
        conflict = [409, 412].includes(result.status);
        await discard(result);
      } else {
        await discard(initiated);
        if (initiated.status === 401) fail('session_changed');
        if (initiated.status === 403) fail('backup_unavailable');
        conflict = [409, 412].includes(initiated.status);
      }
    } catch (error) {
      if (['session_changed', 'account_mismatch', 'backup_scope_required', 'backup_unavailable'].includes(error.code)) throw error;
    }

    try {
      if (await sameSnapshot()) return reply({ status: reported ? 'saved' : 'reconciled', id });
    } catch (error) {
      if (['snapshot_conflict', 'destination_conflict', 'session_changed', 'account_mismatch', 'backup_scope_required'].includes(error.code)) throw error;
    }
    fail(conflict ? 'snapshot_conflict' : 'commit_unknown');
  };
}
