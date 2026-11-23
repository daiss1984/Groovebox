import { createHash } from 'node:crypto';
import { maxPlaylistSnapshotBytes } from '../public/cloud-playlist-snapshot.js';

const xpan = 'https://pan.baidu.com/rest/2.0/xpan/file';
const pcs = 'https://d.pcs.baidu.com/rest/2.0/pcs/superfile2';

export const baiduBackupOperation = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const uploadIdPattern = /^[\w.+/=@:-]{1,512}$/;

export class BackupWriteError extends Error {
  constructor(code, path = undefined) {
    super(code);
    this.name = 'BackupWriteError';
    this.code = code;
    if (path) this.path = path;
  }
}

export function baiduBackupDirectory(appRoot) {
  const match = typeof appRoot === 'string' && /^\/apps\/([^/]{1,120})$/.exec(appRoot);
  if (!match || match[1] !== match[1].normalize('NFC') || match[1] !== match[1].trim() ||
      match[1] === '.' || match[1].includes('..') || /[\p{C}\\%?#:*"|<>]/u.test(match[1]) ||
      Buffer.byteLength(appRoot) > 200) {
    return '';
  }
  return appRoot + '/groovebox-backups';
}

async function readJson(response) {
  const chunks = [];
  let size = 0;
  if (Number(response.headers.get('content-length')) > 32_768) {
    await response.body?.cancel();
    throw new BackupWriteError('unreadable_upstream_result');
  }
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > 32_768) throw new BackupWriteError('unreadable_upstream_result');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
}

export function baiduBackupName(operationId) {
  return 'groovebox-playlists-' + operationId + '.json';
}

async function post(request, token, method, body, extraQuery = {}) {
  const url = new URL(method === 'upload' ? pcs : xpan);
  url.search = new URLSearchParams({ method, access_token: token, ...extraQuery });
  try {
    const response = await request(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new BackupWriteError('upstream_uncertain');
    }
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      throw new BackupWriteError('authorization_required');
    }
    const value = await readJson(response);
    if (value?.errno === -8) throw new BackupWriteError('snapshot_conflict');
    if ([-6, 20016, 20017, 31045].includes(value?.errno)) throw new BackupWriteError('authorization_required');
    if (Number.isInteger(value?.errno) && value.errno !== 0) {
      // Only a confirmed rejection may bypass the readback after a potentially committing request.
      const definitive = [-7, -9, -10, 2].includes(value.errno);
      throw new BackupWriteError(method !== 'upload' && !definitive ? 'upstream_uncertain' : 'upstream_rejected');
    }
    if (!response.ok || (value?.errno !== 0 && !(method === 'upload' && value?.errno === undefined && typeof value?.md5 === 'string'))) {
      throw new BackupWriteError('upstream_uncertain');
    }
    return value;
  } catch (error) {
    if (error instanceof BackupWriteError && error.code !== 'unreadable_upstream_result') throw error;
    // A fetch error may include the token-bearing URL. Keep it out of user-visible errors.
    throw new BackupWriteError('upstream_uncertain');
  }
}


export async function createBaiduBackupFolder(request, token, directory, assertActive) {
  assertActive();
  try {
    await post(request, token, 'create', new URLSearchParams({ path: directory, isdir: '1', size: '0', rtype: '0' }));
  } catch (error) {
    // A competing request or a lost reply can still leave the exact directory readable.
    if (!['snapshot_conflict', 'upstream_uncertain'].includes(error.code)) throw error;
  }
}

export function createBaiduBackupWriter({ directory, token, lookupSnapshot, request, verifyReferences, assertActive }) {
  function submit(method, body, query) {
    assertActive();
    return post(request, token, method, body, query);
  }

  async function checkSnapshot(path, bytes, uncertain) {
    let found;
    try {
      found = await lookupSnapshot(path, AbortSignal.timeout(15_000));
    } catch (error) {
      if (error instanceof BackupWriteError && error.code === 'snapshot_conflict') throw error;
      throw new BackupWriteError(uncertain ? 'commit_unknown' : 'destination_unavailable', path);
    }
    if (found === null) {
      if (uncertain) throw new BackupWriteError('commit_unknown', path);
      return false;
    }
    if (found?.path !== path || !Buffer.isBuffer(found?.bytes) || found.bytes.length > maxPlaylistSnapshotBytes) {
      throw new BackupWriteError(uncertain ? 'commit_unknown' : 'destination_unavailable', path);
    }
    if (!found.bytes.equals(bytes)) throw new BackupWriteError('snapshot_conflict', path);
    return true;
  }

  return async function writeSnapshot(operationId, snapshot) {
    const path = directory + '/' + baiduBackupName(operationId);
    if (await checkSnapshot(path, snapshot, false)) return 'already_present';
    await verifyReferences();

    const md5 = createHash('md5').update(snapshot).digest('hex');
    const fields = { path, size: String(snapshot.length), isdir: '0', rtype: '0', block_list: JSON.stringify([md5]) };
    // The token and name stay fixed for all requests in this operation.
    const reconcile = async () => {
      await checkSnapshot(path, snapshot, true);
      return 'reconciled';
    };
    let precreate;
    try {
      precreate = await submit('precreate', new URLSearchParams({ ...fields, autoinit: '1' }));
    } catch (error) {
      if (error.code === 'upstream_uncertain') return reconcile();
      if (error.code === 'snapshot_conflict' && await checkSnapshot(path, snapshot, false)) return 'already_present';
      throw error;
    }
    if (precreate.path !== undefined && precreate.path !== path) return reconcile();
    if (precreate.return_type === 2) return reconcile();
    if (precreate.return_type !== 1 || typeof precreate.uploadid !== 'string' ||
        !uploadIdPattern.test(precreate.uploadid) || !Array.isArray(precreate.block_list) ||
        precreate.block_list.length > 1 || precreate.block_list.some(index => index !== 0)) {
      throw new BackupWriteError('unsupported_precreate_result', path);
    }

    const uploadid = precreate.uploadid;
    if (precreate.block_list.length) {
      async function upload() {
        const form = new FormData();
        form.set('file', new Blob([snapshot], { type: 'application/octet-stream' }), 'file');
        return submit('upload', form, { type: 'tmpfile', path, uploadid, partseq: '0' });
      }
      let receipt;
      try {
        receipt = await upload();
      } catch (error) {
        if (error.code !== 'upstream_uncertain') throw error;
        // The part is identified by the same upload ID and index. Replay exactly those bytes once.
        receipt = await upload();
      }
      if (typeof receipt.md5 !== 'string' || receipt.md5.toLowerCase() !== md5) {
        throw new BackupWriteError('part_checksum_mismatch', path);
      }
    }

    let receipt;
    try {
      receipt = await submit('create', new URLSearchParams({ ...fields, uploadid }));
    } catch (error) {
      if (error.code === 'upstream_uncertain') return reconcile();
      if (error.code === 'snapshot_conflict' && await checkSnapshot(path, snapshot, false)) return 'already_present';
      throw error;
    }
    if (receipt.path !== path || receipt.size !== snapshot.length || receipt.isdir !== 0 ||
        typeof receipt.md5 !== 'string' || receipt.md5.toLowerCase() !== md5) return reconcile();
    return 'saved';
  };
}
