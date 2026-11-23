import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createOAuthSessionRegistry, durableSession } from './oauth-session-store.mjs';
import { createOnedriveBackup, OnedriveBackupError } from './onedrive-backup.mjs';

const prefix = '/api/onedrive';
const authority = 'https://login.microsoftonline.com/common/oauth2/v2.0/';
const backupAuthority = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/';
const graphOrigin = 'https://graph.microsoft.com';
const graph = graphOrigin + '/v1.0/me/drive';
const scope = graphOrigin + '/Files.Read offline_access';
const backupScope = graphOrigin + '/Files.Read ' + graphOrigin + '/Files.ReadWrite.AppFolder offline_access';
const pendingCookie = 'groovebox_onedrive_pending';
const sessionCookie = 'groovebox_onedrive';
const pendingLifetime = 600;
const sessionLifetime = 30 * 86400;
const lyricsLimit = 1_000_000;
const opaqueKey = /^[\w-]{43}$/;
const itemKey = /^[\da-zA-Z][\da-zA-Z_!.-]{0,255}$/;
const byteRange = /^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/;
const contentRangePattern = /^bytes \d+-\d+\/(?:\d+|\*)$/;
const redirects = new Set([301, 302, 303, 307, 308]);
const methods = new Map([
  ['status', ['GET']], ['connect', ['GET']], ['callback', ['GET']], ['disconnect', ['POST']],
  ['list', ['GET']], ['stream', ['GET', 'HEAD']],
  ['backup/connect', ['POST']], ['backup', ['GET', 'PUT']],
]);
const audioTypes = new Map(Object.entries({
  '.aac': 'audio/aac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.alac': 'audio/mp4',
  '.amr': 'audio/amr', '.ape': 'audio/x-ape', '.flac': 'audio/flac',
  '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff',
  '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp3': 'audio/mpeg', '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.wave': 'audio/wav',
  '.weba': 'audio/webm', '.wma': 'audio/x-ms-wma',
}));

class OnedriveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function authorizationError() {
  return new OnedriveError(401, 'OneDrive 授权已失效，请重新连接。');
}

function backupScopes(value) {
  const granted = typeof value === 'string' ? value.trim().toLowerCase().split(/\s+/)
    .map(name => name.replace(/^https:\/\/graph\.microsoft\.com\//, '')) : [];
  return granted.includes('files.read') && granted.includes('files.readwrite.appfolder') &&
    granted.every(name => ['files.read', 'files.readwrite.appfolder', 'offline_access', 'openid', 'profile', 'email'].includes(name));
}

function validDriveIdentity(identity) {
  return typeof identity?.driveId === 'string' && itemKey.test(identity.driveId) &&
    typeof identity?.ownerId === 'string' && itemKey.test(identity.ownerId);
}

function sameDrive(left, right) {
  return Boolean(left && right && left.driveId === right.driveId && left.ownerId === right.ownerId);
}

function durableOnedriveSession(entry, now) {
  const playback = durableSession(entry, now);
  if (!playback || !validDriveIdentity(entry.backup?.identity)) return playback;
  const backup = durableSession({ token: entry.backup.token, expiresAt: entry.expiresAt }, now);
  if (!backup) return playback;
  const { driveId, ownerId } = entry.backup.identity;
  return { ...playback, backup: { token: backup.token, identity: { driveId, ownerId } } };
}

function callbackURL(value) {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((url.protocol === 'https:' || (loopback && url.protocol === 'http:')) &&
        url.pathname === prefix + '/callback' && !url.username && !url.password &&
        !url.search && !url.hash) return url;
  } catch {
    // A malformed redirect URI disables this provider.
  }
  return null;
}

function cookie(name, value, age, secure) {
  return name + '=' + value + '; Path=' + prefix + '; HttpOnly; SameSite=Lax; Max-Age=' + age +
    (secure ? '; Secure' : '');
}

function cookieValue(req, name) {
  const key = name + '=';
  const entry = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(key));
  const value = entry?.slice(key.length);
  return opaqueKey.test(value ?? '') ? value : '';
}

function randomKey() {
  return randomBytes(32).toString('base64url');
}

function lookup(store, key) {
  const entry = store.get(key);
  if (entry?.expiresAt > Date.now()) return entry;
  if (entry) store.delete(key);
  return null;
}

function remember(store, key, entry) {
  const now = Date.now();
  for (const [id, value] of store) {
    if (value.expiresAt <= now) store.delete(id);
  }
  if (store.size >= 2000) store.delete(store.keys().next().value);
  store.set(key, entry);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
}

function redirect(res, url, cookies) {
  res.writeHead(303, { Location: url, 'Set-Cookie': cookies }).end();
}

async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The client or upstream may already have ended this request.
  }
}

async function parseJson(response) {
  try {
    const data = await response.json();
    if (data && typeof data === 'object') return data;
  } catch {
    // Avoid returning upstream data or request details.
  }
  throw new OnedriveError(502, 'OneDrive 返回了无效的响应。');
}

function itemType(file) {
  if (!file?.file || file.folder || typeof file.name !== 'string') return null;
  const extension = posix.extname(file.name).toLowerCase();
  if (extension === '.lrc' || extension === '.vtt') return 'lyrics';
  const mime = String(file.file.mimeType || '').toLowerCase();
  return audioTypes.get(extension) || (/^audio\/[a-z0-9.+-]+$/.test(mime) ? mime : null);
}

function audioMetadata(audio) {
  if (!audio || typeof audio !== 'object' || Array.isArray(audio)) return {};
  const metadata = {};
  for (const key of ['title', 'artist', 'album', 'albumArtist']) {
    const label = typeof audio[key] === 'string' ? audio[key].trim() : '';
    if (label && label.length <= 1024 && !/[\x00-\x1f\x7f]/.test(label)) metadata[key] = label;
  }
  const milliseconds = typeof audio.duration === 'string' && /^[1-9]\d{0,15}$/.test(audio.duration)
    ? Number(audio.duration) : audio.duration;
  if (Number.isSafeInteger(milliseconds) && milliseconds > 0) metadata.duration = milliseconds / 1000;
  return metadata;
}

function publicItem(file, account, driveId) {
  if (typeof file?.id !== 'string' || !itemKey.test(file.id) ||
      typeof file.name !== 'string' || !file.name) return null;
  const folder = Boolean(file.folder);
  const type = itemType(file);
  return {
    id: file.id, name: file.name, path: file.id, folder, size: Number(file.size) || 0,
    streamUrl: type ? prefix + '/stream?id=' + encodeURIComponent(file.id) : null,
    ...(type && type !== 'lyrics' ? {
      ...audioMetadata(file.audio),
      ...(account && file.parentReference?.driveId === driveId && !file.remoteItem && !file.deleted && { backupAccount: account }),
    } : {}),
  };
}

function graphNextLink(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OnedriveError(502, 'OneDrive 返回了无效的分页地址。');
  }
  if (url.origin !== graphOrigin || !url.pathname.startsWith('/v1.0/') ||
      url.username || url.password || url.hash) {
    throw new OnedriveError(502, 'OneDrive 返回了无效的分页地址。');
  }
  return url;
}

function downloadURL(value, base) {
  let url;
  try {
    if (!value) throw new Error();
    url = new URL(value, base);
  } catch {
    throw new OnedriveError(502, 'OneDrive 返回了无效的下载地址。');
  }
  const knownHost = /(?:^|\.)(?:1drv\.com|onedrive\.com|sharepoint\.com|sharepointonline\.com|storage\.live\.com|onedrive\.live\.com)$/.test(url.hostname);
  if (!knownHost || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) {
    throw new OnedriveError(502, 'OneDrive 返回了无效的下载地址。');
  }
  return url;
}

function lyricText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  }
}

// A sessionFile enables encrypted sessions scoped to this OAuth app and callback.
export function createOnedriveHandler({ env = process.env, request = globalThis.fetch, sessionFile } = {}) {
  const clientId = env.ONEDRIVE_CLIENT_ID?.trim();
  const clientSecret = env.ONEDRIVE_CLIENT_SECRET?.trim();
  const redirectUri = env.ONEDRIVE_REDIRECT_URI?.trim();
  const callback = callbackURL(redirectUri);
  const configured = Boolean(clientId && clientSecret && callback);
  const backupEnabled = configured && env.ONEDRIVE_PLAYLIST_BACKUP === '1';
  const secure = callback?.protocol === 'https:';
  const pending = new Map();
  const sessions = createOAuthSessionRegistry(
    configured ? sessionFile : undefined, clientSecret, JSON.stringify([prefix, clientId, callback?.href]), durableOnedriveSession,
  );
  const backup = createOnedriveBackup({ graph, itemKey, itemType, downloadURL });
  const refreshingBackup = new WeakMap();

  function persistSessions(change) {
    try {
      if (change) sessions.commit(change);
      else sessions.persist();
    } catch {
      throw new OnedriveError(503, '无法保存 OneDrive 授权，请检查服务端数据目录。');
    }
  }

  function updateSessionToken(session, token) {
    session.token = token;
    persistSessions();
  }

  async function exchange(parameters, previousRefresh, forBackup = false) {
    const response = await request(new URL('token', forBackup ? backupAuthority : authority), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: forBackup ? backupScope : scope, ...parameters }),
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    const data = await parseJson(response);
    if (data.error === 'invalid_grant') throw authorizationError();
    const lifetime = Number(data.expires_in);
    if (!response.ok || typeof data.access_token !== 'string' || !data.access_token ||
        !Number.isSafeInteger(lifetime) || lifetime <= 0) {
      throw new OnedriveError(502, 'OneDrive 授权失败。');
    }
    if (forBackup && !backupScopes(data.scope)) throw new OnedriveBackupError('backup_scope_required');
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token || previousRefresh,
      expiresAt: Date.now() + lifetime * 1000,
    };
  }

  function accountFor({ driveId, ownerId }) {
    return createHmac('sha256', clientSecret).update(JSON.stringify(['groovebox-onedrive-backup-v1', clientId, driveId, ownerId])).digest('base64url');
  }

  function backupSessionCheck(sessionId, session, grant, token) {
    if (!session?.token || lookup(sessions.entries, sessionId) !== session) throw new OnedriveBackupError('session_changed');
    if ((grant && session.backup !== grant) || (token && grant.token !== token)) throw new OnedriveBackupError('backup_scope_required');
  }

  function updateBackupGrant(session, grant) {
    const previous = session.backup;
    session.backup = grant;
    try { persistSessions(); }
    catch (error) { session.backup = previous; throw error; }
  }

  async function readDrive(token) {
    const endpoint = new URL(graph);
    endpoint.searchParams.set('$select', 'id,driveType,owner');
    const response = await request(endpoint, { method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(12_000) });
    if (!response.ok) {
      await discard(response);
      throw new OnedriveBackupError(response.status === 401 ? 'session_changed' : [403, 404].includes(response.status) ? 'backup_unavailable' : 'upstream_unavailable');
    }
    const drive = await parseJson(response);
    const identity = { driveId: drive.id, ownerId: drive.owner?.user?.id };
    return drive.driveType === 'personal' && validDriveIdentity(identity) ? identity : null;
  }

  async function playbackBackupIdentity(sessionId, session) {
    backupSessionCheck(sessionId, session);
    let access = await accessToken(session);
    backupSessionCheck(sessionId, session);
    let identity;
    try { identity = await readDrive(access); }
    catch (error) {
      if (error.code !== 'session_changed') throw error;
      backupSessionCheck(sessionId, session);
      access = await accessToken(session, access);
      backupSessionCheck(sessionId, session);
      identity = await readDrive(access);
    }
    backupSessionCheck(sessionId, session);
    const token = session.token;
    if (token.accessToken !== access) throw new OnedriveBackupError('session_changed');
    return { identity, token };
  }

  async function backupToken(sessionId, session, grant, rejected) {
    backupSessionCheck(sessionId, session, grant);
    const token = grant.token;
    if (token !== rejected && token.expiresAt > Date.now() + (token.refreshToken ? 30_000 : 0)) return token;
    if (!token.refreshToken) {
      updateBackupGrant(session, undefined);
      throw new OnedriveBackupError('backup_scope_required');
    }
    if (!refreshingBackup.has(grant)) {
      const refresh = exchange({ grant_type: 'refresh_token', refresh_token: token.refreshToken }, token.refreshToken, true)
        .then(async next => {
          backupSessionCheck(sessionId, session, grant, token);
          const identity = await readDrive(next.accessToken);
          backupSessionCheck(sessionId, session, grant, token);
          if (!sameDrive(identity, grant.identity)) throw new OnedriveBackupError('account_mismatch');
          grant.token = next;
          try { persistSessions(); }
          catch (error) { grant.token = token; throw error; }
          return next;
        })
        .catch(error => {
          backupSessionCheck(sessionId, session, grant, token);
          if (error.status === 401 || error.code === 'backup_scope_required' || error.code === 'account_mismatch') {
            updateBackupGrant(session, undefined);
            throw new OnedriveBackupError(error.code === 'account_mismatch' ? 'account_mismatch' : 'backup_scope_required');
          }
          throw error;
        })
        .finally(() => refreshingBackup.delete(grant));
      refreshingBackup.set(grant, refresh);
    }
    return refreshingBackup.get(grant);
  }

  function checkBackupOrigin(req) {
    const origin = req.headers.origin;
    if (req.headers.host !== callback.host || (origin ? origin !== callback.origin : req.method !== 'GET') ||
        ['same-site', 'cross-site'].includes(req.headers['sec-fetch-site'])) throw new OnedriveBackupError('origin_mismatch');
  }

  async function executeBackup(req, res, url, sessionId, session) {
    checkBackupOrigin(req);
    backupSessionCheck(sessionId, session);
    const grant = session.backup;
    if (!grant) throw new OnedriveBackupError('backup_scope_required');
    let token = await backupToken(sessionId, session, grant);
    let playbackToken;
    const checkSession = () => {
      backupSessionCheck(sessionId, session, grant, token);
      if (playbackToken && session.token !== playbackToken) throw new OnedriveBackupError('session_changed');
    };
    checkSession();
    const backupIdentityRequest = async () => {
      try { return await readDrive(token.accessToken); }
      catch (error) {
        if (error.code !== 'session_changed') throw error;
        checkSession();
        token = await backupToken(sessionId, session, grant, token);
        checkSession();
        try { return await readDrive(token.accessToken); }
        catch (retryError) {
          if (retryError.code !== 'session_changed') throw retryError;
          checkSession();
          updateBackupGrant(session, undefined);
          throw new OnedriveBackupError('backup_scope_required');
        }
      }
    };
    const [playback, backupIdentity] = await Promise.all([playbackBackupIdentity(sessionId, session), backupIdentityRequest()]);
    playbackToken = playback.token;
    checkSession();
    if (!sameDrive(playback.identity, grant.identity) || !sameDrive(backupIdentity, grant.identity)) {
      updateBackupGrant(session, undefined);
      throw new OnedriveBackupError('account_mismatch');
    }
    const abort = new AbortController();
    const close = () => abort.abort();
    res.once('close', close);
    function upstream(target, options, headers) {
      checkSession();
      return request(target, { method: 'GET', redirect: 'error', ...options, headers: { ...options?.headers, ...headers },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) });
    }
    try {
      await backup(req, res, url, { account: accountFor(grant.identity), driveId: grant.identity.driveId, checkSession,
        graphRequest: (target, options) => upstream(target, options, { Authorization: 'Bearer ' + token.accessToken }),
        signedRequest: (target, options) => upstream(target, options),
      });
    } finally { res.off('close', close); }
  }

  async function accessToken(session, rejected) {
    if (session.refreshing) return session.refreshing;
    const token = session.token;
    if (token && token.accessToken !== rejected && token.expiresAt > Date.now() + (token.refreshToken ? 30_000 : 0)) {
      return token.accessToken;
    }
    if (!token?.refreshToken) {
      updateSessionToken(session, null);
      throw authorizationError();
    }
    session.refreshing = exchange({ grant_type: 'refresh_token', refresh_token: token.refreshToken }, token.refreshToken)
      .then(next => {
        updateSessionToken(session, next);
        return next.accessToken;
      })
      .catch(error => {
        if (error instanceof OnedriveError && error.status === 401) updateSessionToken(session, null);
        throw error;
      })
      .finally(() => { session.refreshing = null; });
    return session.refreshing;
  }

  async function graphRequest(session, url, { signal, download } = {}) {
    async function send(token) {
      const timeout = AbortSignal.timeout(15_000);
      return request(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token, ...(download ? {} : { Accept: 'application/json' }) },
        redirect: download ? 'manual' : 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    }

    const token = await accessToken(session);
    let response = await send(token);
    if (response.status === 401) {
      await discard(response);
      response = await send(await accessToken(session, token));
    }
    if (response.ok || (download && redirects.has(response.status))) return response;
    const status = response.status;
    await discard(response);
    if (status === 401) {
      updateSessionToken(session, null);
      throw authorizationError();
    }
    if (status === 403) throw new OnedriveError(403, 'OneDrive 拒绝访问，请检查授权和文件权限。');
    if (status === 404) throw new OnedriveError(404, 'OneDrive 文件或目录不存在。');
    if (status === 429) throw new OnedriveError(429, 'OneDrive 请求过于频繁，请稍后重试。');
    throw new OnedriveError(502, 'OneDrive 暂时无法响应。');
  }

  async function list(session, folder, identity) {
    if (folder !== '/' && !itemKey.test(folder)) throw new OnedriveError(400, 'OneDrive 文件夹标识无效。');
    let page = new URL(graph + (folder === '/' ? '/root' : '/items/' + encodeURIComponent(folder)) + '/children');
    page.searchParams.set('$select', 'id,name,size,file,folder,audio' + (identity ? ',parentReference,remoteItem,deleted' : ''));
    const account = identity && accountFor(identity);
    const items = new Map();
    const visited = new Set();
    while (page) {
      if (visited.has(page.href) || visited.size >= 1000) {
        throw new OnedriveError(502, 'OneDrive 未返回完整目录。');
      }
      visited.add(page.href);
      const data = await parseJson(await graphRequest(session, page));
      if (!Array.isArray(data.value)) throw new OnedriveError(502, 'OneDrive 未返回目录。');
      for (const file of data.value) {
        const item = publicItem(file, account, identity?.driveId);
        if (item) items.set(item.id, item);
      }
      page = data['@odata.nextLink'] ? graphNextLink(data['@odata.nextLink']) : null;
    }
    return [...items.values()];
  }

  async function downloadContent(url, method, range, controller) {
    const headers = { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) };
    for (let hops = 0; hops < 5; hops += 1) {
      const deadline = setTimeout(() => controller.abort(), 15_000);
      let response;
      try {
        response = await request(url, { method, headers, redirect: 'manual', signal: controller.signal });
      } finally {
        clearTimeout(deadline);
      }
      if (!redirects.has(response.status)) return response;
      await discard(response);
      url = downloadURL(response.headers.get('location'), url);
    }
    throw new OnedriveError(502, 'OneDrive 未返回下载数据。');
  }

  async function serveLyrics(requested, req, res, controller) {
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await downloadContent(requested, 'GET', null, controller);
      if (response.status !== 200 || !response.body) {
        await discard(response);
        throw new OnedriveError(502, 'OneDrive 未返回歌词数据。');
      }
      if (Number(response.headers.get('content-length')) > lyricsLimit) {
        await discard(response);
        throw new OnedriveError(413, 'OneDrive 歌词文件超过 1 MB。');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > lyricsLimit) throw new OnedriveError(413, 'OneDrive 歌词文件超过 1 MB。');
        chunks.push(chunk);
      }
      let lyrics;
      try {
        lyrics = lyricText(Buffer.concat(chunks, size)).replace(/\r\n?/g, '\n');
      } catch {
        throw new OnedriveError(415, '不支持此 OneDrive 歌词文件编码。');
      }
      if (lyrics.includes('\0')) throw new OnedriveError(415, '不支持此 OneDrive 歌词文件编码。');
      const body = Buffer.from(lyrics, 'utf8');
      if (body.byteLength > lyricsLimit) throw new OnedriveError(413, 'OneDrive 歌词文件超过 1 MB。');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.byteLength,
        'Content-Security-Policy': "default-src 'none'",
      }).end(req.method === 'HEAD' ? undefined : body);
    } finally {
      clearTimeout(deadline);
    }
  }

  async function stream(req, res, session, id) {
    if (!itemKey.test(id ?? '')) throw new OnedriveError(400, 'OneDrive 文件标识无效。');
    const range = req.headers.range;
    if (range && !byteRange.test(range)) throw new OnedriveError(416, '音频范围无效。');
    const base = graph + '/items/' + encodeURIComponent(id);
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const metadata = new URL(base);
      metadata.searchParams.set('$select', 'id,name,size,file,folder');
      const info = await parseJson(await graphRequest(session, metadata, { signal: controller.signal }));
      const type = itemType(info);
      if (!type) throw new OnedriveError(415, '请选择支持的 OneDrive 音频或歌词文件。');
      if (type === 'lyrics' && Number(info.size) > lyricsLimit) {
        throw new OnedriveError(413, 'OneDrive 歌词文件超过 1 MB。');
      }

      const signed = await graphRequest(session, new URL(base + '/content'), {
        signal: controller.signal, download: true,
      });
      await discard(signed);
      if (!redirects.has(signed.status)) throw new OnedriveError(502, 'OneDrive 未返回下载地址。');
      const download = downloadURL(signed.headers.get('location'));
      if (type === 'lyrics') {
        await serveLyrics(download, req, res, controller);
        return;
      }

      let upstream = await downloadContent(download, req.method, range, controller);
      if (req.method === 'HEAD' && [405, 501].includes(upstream.status)) {
        await discard(upstream);
        upstream = await downloadContent(download, 'GET', range, controller);
      }
      const contentRange = upstream.headers.get('content-range');
      if (upstream.status === 416) {
        await discard(upstream);
        if (/^bytes \*\/\d+$/.test(contentRange ?? '')) res.setHeader('Content-Range', contentRange);
        res.writeHead(416).end();
        return;
      }
      const encoding = upstream.headers.get('content-encoding');
      const upstreamType = upstream.headers.get('content-type') ?? '';
      if (![200, 206].includes(upstream.status) ||
          (upstream.status === 206 && !contentRangePattern.test(contentRange ?? '')) ||
          (encoding && encoding.toLowerCase() !== 'identity') ||
          /^(?:text\/|application\/(?:json|xml))/i.test(upstreamType) ||
          (req.method === 'GET' && !upstream.body)) {
        await discard(upstream);
        throw new OnedriveError(502, 'OneDrive 未返回有效的音频数据。');
      }
      const length = upstream.headers.get('content-length');
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('Accept-Ranges', 'bytes');
      if (length && /^\d+$/.test(length)) res.setHeader('Content-Length', length);
      if (upstream.status === 206) res.setHeader('Content-Range', contentRange);
      res.writeHead(upstream.status);
      if (req.method === 'HEAD') {
        await discard(upstream);
        res.end();
      } else {
        await pipeline(Readable.fromWeb(upstream.body), res);
      }
    } finally {
      res.off('close', abort);
    }
  }

  return async function onedriveHandler(req, res, url) {
    if (!url.pathname.startsWith(prefix + '/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    try {
      const action = url.pathname.slice(prefix.length + 1);
      const allowed = methods.get(action);
      if (!allowed) throw new OnedriveError(404, 'OneDrive 接口不存在。');
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        throw new OnedriveError(405, '此接口不支持该请求方法。');
      }

      const sessionId = cookieValue(req, sessionCookie);
      const oauthId = cookieValue(req, pendingCookie);
      const session = lookup(sessions.entries, sessionId);
      if (action === 'status') {
        const token = session?.token;
        const connected = Boolean(configured && token && (token.expiresAt > Date.now() || token.refreshToken));
        const playback = connected && backupEnabled ? await playbackBackupIdentity(sessionId, session).catch(() => null) : null;
        const identity = playback?.token === session?.token ? playback?.identity : null;
        const grant = session?.backup;
        sendJson(res, 200, { configured, connected,
          ...(identity && { backupAuthorizationAvailable: true }),
          ...(identity && sameDrive(identity, grant?.identity) && (grant.token.expiresAt > Date.now() || grant.token.refreshToken) && { canBackup: true }),
        });
      } else if (action === 'disconnect') {
        const origin = req.headers.origin;
        if ((origin && origin !== callback?.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new OnedriveError(403, '请在播放器中断开 OneDrive。');
        }
        if (session) persistSessions(entries => entries.delete(sessionId));
        pending.delete(oauthId);
        res.setHeader('Set-Cookie', [cookie(sessionCookie, '', 0, secure), cookie(pendingCookie, '', 0, secure)]);
        sendJson(res, 200, { configured, connected: false });
      } else if (!configured) {
        throw new OnedriveError(503, '服务器尚未配置 OneDrive 应用。');
      } else if (action === 'connect' || action === 'backup/connect') {
        const forBackup = action === 'backup/connect';
        let identity;
        if (forBackup) {
          if (!backupEnabled) throw new OnedriveBackupError('backup_disabled');
          checkBackupOrigin(req);
          const playback = await playbackBackupIdentity(sessionId, session);
          if (playback.token !== session.token) throw new OnedriveBackupError('session_changed');
          identity = playback.identity;
          if (!identity) throw new OnedriveBackupError('backup_unavailable');
        }
        if (req.headers.host !== callback.host) throw new OnedriveError(400, '请使用与 OneDrive 回调地址一致的播放器网址。');
        const id = randomKey();
        const state = randomKey();
        const verifier = randomKey();
        pending.delete(oauthId);
        remember(pending, id, { state, verifier, expiresAt: Date.now() + pendingLifetime * 1000,
          ...(forBackup && { sessionId, session, previousGrant: session.backup, identity }) });
        const authorize = new URL('authorize', forBackup ? backupAuthority : authority);
        authorize.search = new URLSearchParams({
          response_type: 'code', response_mode: 'query', client_id: clientId, redirect_uri: redirectUri,
          scope: forBackup ? backupScope : scope, state, ...(forBackup && { prompt: 'consent' }),
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        }).toString();
        const cookies = [cookie(pendingCookie, id, pendingLifetime, secure)];
        if (forBackup && req.headers.accept?.includes('application/json')) {
          res.setHeader('Set-Cookie', cookies);
          sendJson(res, 200, { authorizeUrl: authorize.href });
        } else redirect(res, authorize.href, cookies);
      } else if (action === 'callback') {
        const authorization = lookup(pending, oauthId);
        const state = url.searchParams.get('state') ?? '';
        if (!authorization || !opaqueKey.test(state) ||
          !timingSafeEqual(Buffer.from(state), Buffer.from(authorization.state))) {
          throw new OnedriveError(400, 'OneDrive 授权已过期或回调不匹配，请重新连接。');
        }
        pending.delete(oauthId);
        const cookies = [cookie(pendingCookie, '', 0, secure)];
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const forBackup = Boolean(authorization.identity);
        let result = error === 'access_denied' ? 'denied' : 'error';
        if (!error && code && code.length <= 4096) {
          try {
            if (forBackup && (!backupEnabled || authorization.sessionId !== sessionId || authorization.session !== session ||
                session.backup !== authorization.previousGrant)) throw new OnedriveBackupError('session_changed');
            const token = await exchange({
              grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: authorization.verifier,
            }, undefined, forBackup);
            if (forBackup) {
              const [playback, backupIdentity] = await Promise.all([playbackBackupIdentity(sessionId, session), readDrive(token.accessToken)]);
              backupSessionCheck(sessionId, session);
              if (session.token !== playback.token || session.backup !== authorization.previousGrant || !sameDrive(playback.identity, authorization.identity) ||
                  !sameDrive(backupIdentity, authorization.identity)) throw new OnedriveBackupError('account_mismatch');
              updateBackupGrant(session, { token, identity: authorization.identity });
            } else {
              const id = randomKey();
              persistSessions(entries => {
                entries.delete(sessionId);
                remember(entries, id, { token, expiresAt: Date.now() + sessionLifetime * 1000 });
              });
              cookies.push(cookie(sessionCookie, id, sessionLifetime, secure));
            }
            result = 'connected';
          } catch {
            // The browser receives a generic failure marker.
          }
        }
        redirect(res, '/?onedrive=' + (forBackup ? 'backup-' : '') + result, cookies);
      } else if (action === 'backup') {
        if (!backupEnabled) throw new OnedriveBackupError('backup_disabled');
        await executeBackup(req, res, url, sessionId, session);
      } else if (!session?.token) {
        throw new OnedriveError(401, '请先连接 OneDrive。');
      } else if (action === 'list') {
        const playback = backupEnabled ? await playbackBackupIdentity(sessionId, session).catch(() => null) : null;
        const identity = playback?.token === session.token ? playback?.identity : null;
        const items = await list(session, url.searchParams.get('path') ?? '/', identity);
        if (identity && (session.token !== playback.token || lookup(sessions.entries, sessionId) !== session)) {
          for (const item of items) delete item.backupAccount;
        }
        sendJson(res, 200, { items });
      } else {
        await stream(req, res, session, url.searchParams.get('id'));
      }
    } catch (error) {
      if (res.destroyed) return true;
      if (res.headersSent) res.destroy();
      else if (error instanceof OnedriveBackupError) sendJson(res, error.status, { error: error.message, code: error.code });
      else if (error instanceof OnedriveError) sendJson(res, error.status, { error: error.message });
      else sendJson(res, 502, { error: '无法连接 OneDrive，请稍后重试。' });
    }
    return true;
  };
}
