import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createOAuthSessionRegistry, durableSession } from './oauth-session-store.mjs';
import { createGdriveBackup, DriveBackupError, gdriveBackupFailure } from './gdrive-backup.mjs';

const prefix = '/api/gdrive';
const scope = 'https://www.googleapis.com/auth/drive.readonly';
const backupScope = 'https://www.googleapis.com/auth/drive.file';
const broadWriteScopes = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.metadata'];
const authEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const driveEndpoint = 'https://www.googleapis.com/drive/v3/files';
const driveAbout = 'https://www.googleapis.com/drive/v3/about';
const sessionCookie = 'groovebox_gdrive';
const stateCookie = 'groovebox_gdrive_pending';
const sessionLifetime = 30 * 86400;
const stateLifetime = 600;
const opaqueKey = /^[A-Za-z0-9_-]{43}$/;
const fileKey = /^[A-Za-z0-9_-]{1,256}$/;
const rangeHeader = /^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/;
const driveFolder = 'application/vnd.google-apps.folder';
const methods = new Map([
  ['status', ['GET']], ['connect', ['GET']], ['callback', ['GET']], ['disconnect', ['POST']],
  ['list', ['GET']], ['stream', ['GET', 'HEAD']], ['backup/connect', ['POST']], ['backup', ['GET', 'PUT']],
]);
const supportedAudio = new Map(Object.entries({
  '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.alac': 'audio/mp4',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.wave': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma', '.ape': 'audio/x-ape', '.weba': 'audio/webm', '.amr': 'audio/amr',
  '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff',
}));

class DriveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requestURL(endpoint, parameters) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams(parameters).toString();
  return url;
}

function redirectURL(value) {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
      url.pathname === prefix + '/callback' && !url.username && !url.password && !url.hash && !url.search) {
      return url;
    }
  } catch { /* Invalid callback disables the integration. */ }
  return null;
}

function key() {
  return randomBytes(32).toString('base64url');
}

function matchesState(received, expected) {
  return opaqueKey.test(received ?? '') && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function cookieValue(req, name) {
  const marker = name + '=';
  const value = req.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(marker))?.slice(marker.length);
  return opaqueKey.test(value ?? '') ? value : '';
}

function cookie(name, value, maxAge, secure) {
  return name + '=' + value + '; Path=' + prefix + '; HttpOnly; SameSite=Lax; Max-Age=' + maxAge +
    (secure ? '; Secure' : '');
}

function saveEntry(store, id, entry) {
  for (const [oldId, value] of store) {
    if (value.expiresAt <= Date.now()) store.delete(oldId);
  }
  if (store.size >= 2000) store.delete(store.keys().next().value);
  store.set(id, entry);
}

function sessionEntry(store, id) {
  const entry = store.get(id);
  if (entry?.expiresAt > Date.now()) return entry;
  if (entry) store.delete(id);
  return null;
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function redirect(res, destination, cookies) {
  res.writeHead(303, { Location: destination, 'Set-Cookie': cookies }).end();
}

function mediaType(file) {
  if (!file || file.capabilities?.canDownload === false || file.trashed) return null;
  const mime = String(file.mimeType || '').toLowerCase();
  if (mime.startsWith('application/vnd.google-apps.')) return null;
  const extension = extname(String(file.name || '')).toLowerCase();
  if (extension === '.lrc' || extension === '.vtt') return 'lyric';
  return supportedAudio.get(extension) ||
    (/^audio\/[a-z0-9.+-]+$/.test(mime) ? mime : null);
}

function publicItem(file) {
  if (!fileKey.test(file?.id ?? '') || typeof file.name !== 'string' || !file.name) return null;
  const folder = file.mimeType === driveFolder;
  const type = mediaType(file);
  if (!folder && !type) return null;
  return {
    id: file.id, name: file.name, path: file.id, folder, size: Number(file.size) || 0,
    streamUrl: type ? prefix + '/stream?id=' + encodeURIComponent(file.id) : null,
  };
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* Connection has already ended. */ }
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    throw new DriveError(502, 'Google Drive 返回了无效的响应。');
  }
}

function includesBackupScope(token) {
  return Array.isArray(token?.scopes) && [scope, backupScope].every(value => token.scopes.includes(value)) &&
    !broadWriteScopes.some(value => token.scopes.includes(value));
}

function confirmedBackup(token) {
  return opaqueKey.test(token?.backupAccount ?? '') && Boolean(token.refreshToken) && includesBackupScope(token);
}

function durableGoogleSession(entry, now) {
  const session = durableSession(entry, now);
  if (session && confirmedBackup(entry.token)) {
    session.token.scopes = [scope, backupScope];
    session.token.backupAccount = entry.token.backupAccount;
  }
  return session;
}

// A sessionFile enables encrypted sessions scoped to this OAuth app and callback.
export function createGdriveHandler({ env = process.env, request = globalThis.fetch, sessionFile,
  backupDataDirectory = sessionFile && dirname(sessionFile) } = {}) {
  const clientId = env.GDRIVE_CLIENT_ID?.trim();
  const clientSecret = env.GDRIVE_CLIENT_SECRET?.trim();
  const callback = redirectURL(env.GDRIVE_REDIRECT_URI?.trim());
  const configured = Boolean(clientId && clientSecret && callback);
  const backupEnabled = configured && env.GDRIVE_PLAYLIST_BACKUP === '1';
  const secure = callback?.protocol === 'https:';
  const pending = new Map();
  const listedAccount = new WeakMap();
  const backup = backupEnabled && backupDataDirectory && createGdriveBackup({
    clientId, dataDirectory: backupDataDirectory, request, mediaType,
  });
  const sessions = createOAuthSessionRegistry(
    configured ? sessionFile : undefined, clientSecret, JSON.stringify([prefix, clientId, callback?.href]), durableGoogleSession,
  );

  function persistSessions(change) {
    try {
      if (change) sessions.commit(change);
      else sessions.persist();
    } catch {
      throw new DriveError(503, '无法保存 Google Drive 授权，请检查服务端数据目录。');
    }
  }

  function updateSessionToken(session, token) {
    session.token = token;
    persistSessions();
  }

  async function exchange(params, previousRefresh) {
    const response = await request(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }),
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    const data = await parseJson(response);
    if (!response.ok) {
      const invalid = data.error === 'invalid_grant';
      throw new DriveError(invalid ? 401 : 502, invalid ? 'Google Drive 授权已失效，请重新连接。' : 'Google Drive 授权失败。');
    }
    const lifetime = Number(data.expires_in);
    if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new DriveError(502, 'Google Drive 未返回有效的访问令牌。');
    }
    const scopes = typeof data.scope === 'string' ? data.scope.trim().split(/\s+/) : undefined;
    if (scopes && !scopes.includes(scope)) {
      throw new DriveError(403, '请授权 Google Drive 只读访问权限。');
    }
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : previousRefresh,
      expiresAt: Date.now() + lifetime * 1000,
      scopes,
    };
  }

  async function accessToken(session, rejected) {
    const current = session.token;
    const remaining = current ? current.expiresAt - Date.now() : 0;
    if (current && expectedToken(current, rejected, remaining)) return current.accessToken;
    if (!current?.refreshToken) throw new DriveError(401, 'Google Drive 授权已失效，请重新连接。');
    if (!session.refresh) {
      session.refresh = exchange({ grant_type: 'refresh_token', refresh_token: current.refreshToken }, current.refreshToken)
        .then(token => {
          if (confirmedBackup(current) && includesBackupScope(token)) token.backupAccount = current.backupAccount;
          updateSessionToken(session, token);
          return token.accessToken;
        })
        .catch(error => {
          if (error.status === 401) updateSessionToken(session, null);
          throw error;
        })
        .finally(() => { session.refresh = null; });
    }
    return session.refresh;
  }

  function expectedToken(token, rejected, remaining) {
    if (rejected) return token.accessToken !== rejected && remaining > 0;
    return remaining > (token.refreshToken ? 30_000 : 0);
  }

  async function backupAccount(access, signal = AbortSignal.timeout(12_000)) {
    const response = await request(requestURL(driveAbout, { fields: 'user(permissionId)' }), {
      headers: { Authorization: 'Bearer ' + access, Accept: 'application/json' },
      redirect: 'error', signal,
    });
    if (!response.ok) {
      await discard(response);
      throw new DriveError(502, '无法验证 Google Drive 备份账号。');
    }
    const { user } = await parseJson(response);
    if (typeof user?.permissionId !== 'string' || !fileKey.test(user.permissionId)) {
      throw new DriveError(502, 'Google Drive 未返回可验证的账号。');
    }
    return createHmac('sha256', clientSecret)
      .update(JSON.stringify(['Groovebox Google Drive playlist backup', clientId, user.permissionId]))
      .digest('base64url');
  }

  function beginAuthorization(req, res, authorizationId, backupSessionId) {
    if (req.headers.host !== callback.host) throw new DriveError(400, '请使用与 Google Drive 回调地址一致的播放器网址。');
    const id = key();
    const state = key();
    const verifier = key();
    pending.delete(authorizationId);
    saveEntry(pending, id, { state, verifier, backupSessionId, expiresAt: Date.now() + stateLifetime * 1000 });
    const authorizeUrl = requestURL(authEndpoint, {
      response_type: 'code', client_id: clientId, redirect_uri: callback.href,
      scope: backupSessionId ? backupScope : scope,
      ...(backupSessionId && { include_granted_scopes: 'true' }),
      access_type: 'offline', prompt: 'consent', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).href;
    const pendingCookie = cookie(stateCookie, id, stateLifetime, secure);
    const jsonResponse = backupSessionId && req.headers.accept?.split(',').some(value =>
      value.split(';', 1)[0].trim().toLowerCase() === 'application/json');
    if (jsonResponse) {
      res.setHeader('Set-Cookie', pendingCookie);
      return sendJson(res, 200, { authorizeUrl });
    }
    redirect(res, authorizeUrl, [pendingCookie]);
  }

  async function approveBackup(session, sessionId, grant) {
    const assertActive = () => {
      if (sessionEntry(sessions.entries, sessionId) !== session || !session.token) {
        throw new DriveError(401, 'Google Drive 授权已变更。');
      }
    };
    assertActive();
    const access = await accessToken(session);
    assertActive();
    const previousToken = session.token;
    if (access !== previousToken.accessToken) throw new DriveError(401, 'Google Drive 授权已变更。');
    const expectedAccount = await backupAccount(access);
    assertActive();
    let token = await exchange(grant);
    if (!includesBackupScope(token) || await backupAccount(token.accessToken) !== expectedAccount) {
      throw new DriveError(403, 'Google Drive 备份权限或账号不匹配。');
    }
    if (!token.refreshToken && previousToken.refreshToken) {
      assertActive();
      // Google may omit a new refresh token. Verify the existing one independently before using it for backup.
      token = await exchange({ grant_type: 'refresh_token', refresh_token: previousToken.refreshToken }, previousToken.refreshToken);
      if (!includesBackupScope(token) || await backupAccount(token.accessToken) !== expectedAccount) {
        throw new DriveError(403, 'Google Drive 备份权限或账号不匹配。');
      }
    }
    assertActive();
    if (!token.refreshToken || session.token !== previousToken) throw new DriveError(401, 'Google Drive 授权已变更。');
    return { token: { ...token, backupAccount: expectedAccount }, previousToken };
  }

  async function driveRequest(session, url, { headers = {}, signal, stream = false, onToken } = {}) {
    async function send(token) {
      onToken?.(token);
      const headerTimeout = stream ? new AbortController() : null;
      const timer = headerTimeout && setTimeout(() => headerTimeout.abort(), 20_000);
      const timeout = headerTimeout?.signal || AbortSignal.timeout(20_000);
      try {
        return await request(url, {
          headers: { ...headers, Authorization: 'Bearer ' + token },
          redirect: 'error',
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const token = await accessToken(session);
    let response = await send(token);
    if (response.status === 401) {
      await discard(response);
      response = await send(await accessToken(session, token));
    }
    if (response.ok || response.status === 416) return response;
    const status = response.status;
    await discard(response);
    if (status === 401) {
      updateSessionToken(session, null);
      throw new DriveError(401, 'Google Drive 授权已失效，请重新连接。');
    }
    if (status === 403) throw new DriveError(403, 'Google Drive 拒绝访问，请检查应用或文件权限。');
    if (status === 404) throw new DriveError(404, '在 Google Drive 中找不到此文件。');
    if (status === 429) throw new DriveError(429, 'Google Drive 请求过多，请稍后重试。');
    throw new DriveError(502, 'Google Drive 暂时无法响应。');
  }

  async function list(session, sessionId, path) {
    const folderId = path === '/' ? 'root' : path;
    if (!fileKey.test(folderId)) throw new DriveError(400, 'Google Drive 文件夹标识无效。');
    const items = new Map();
    const pageTokens = new Set();
    const tokens = new Set();
    const onToken = backup && (token => { if (tokens.size < 2) tokens.add(token); });
    let pageToken;
    do {
      const url = requestURL(driveEndpoint, {
        q: "'" + folderId + "' in parents and trashed = false", spaces: 'drive',
        orderBy: 'folder,name_natural', pageSize: '1000',
        fields: 'nextPageToken,files(id,name,mimeType,size,capabilities(canDownload))',
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
        ...(pageToken ? { pageToken } : {}),
      });
      const data = await parseJson(await driveRequest(session, url, { onToken: onToken || undefined }));
      if (!Array.isArray(data.files)) throw new DriveError(502, 'Google Drive 未返回目录。');
      for (const file of data.files) {
        const item = publicItem(file);
        if (item) items.set(item.id, item);
      }
      pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken;
      if (pageToken) {
        if (pageTokens.has(pageToken) || pageTokens.size >= 1000) {
          throw new DriveError(502, 'Google Drive 未返回完整目录。');
        }
        pageTokens.add(pageToken);
      }
    } while (pageToken);
    const result = [...items.values()];
    const token = session.token;
    const audio = item => item.streamUrl && !/\.(?:lrc|vtt)$/i.test(item.name);
    if (!confirmedBackup(token) || tokens.size !== 1 || !tokens.has(token.accessToken) || !result.some(audio)) return result;
    let account = listedAccount.get(token);
    if (!account) {
      account = await backupAccount(token.accessToken, AbortSignal.timeout(3000)).catch(() => undefined);
      if (account === token.backupAccount) listedAccount.set(token, account);
    }
    if (account !== token.backupAccount || session.token !== token || sessionEntry(sessions.entries, sessionId) !== session) return result;
    return result.map(item => audio(item) ? { ...item, backupAccount: account } : item);
  }

  async function serveBackup(req, res, session, sessionId, params) {
    if (!backup) throw new DriveBackupError('backup_unavailable');
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    if ((origin && origin !== callback.origin) || (fetchSite && !['same-origin', 'none'].includes(fetchSite)) ||
        (req.method === 'PUT' && origin !== callback.origin)) throw new DriveError(403, '请在播放器中使用 Google Drive 备份。');
    let pinned;
    const assertActive = () => {
      if (sessionEntry(sessions.entries, sessionId) !== session || !session.token ||
          (pinned && (session.token !== pinned || pinned.expiresAt <= Date.now()))) throw new DriveBackupError('session_changed');
    };
    try {
      await backup(req, res, params, async () => {
        assertActive();
        if (!confirmedBackup(session.token)) throw new DriveBackupError('backup_scope_required');
        const token = await accessToken(session);
        pinned = session.token;
        assertActive();
        if (!confirmedBackup(pinned) || pinned.accessToken !== token) throw new DriveBackupError('backup_scope_required');
        const account = await backupAccount(token);
        assertActive();
        if (account !== pinned.backupAccount) throw new DriveBackupError('account_mismatch');
        return { account, token, assertActive };
      });
    } catch (error) {
      if (!['commit_unknown', 'destination_unknown'].includes(error.code)) assertActive();
      throw error;
    }
  }

  async function stream(req, res, session, id) {
    if (!fileKey.test(id ?? '')) throw new DriveError(400, 'Google Drive 文件标识无效。');
    const range = req.headers.range;
    if (range && !rangeHeader.test(range)) throw new DriveError(416, '音频范围无效。');

    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    const base = driveEndpoint + '/' + encodeURIComponent(id);
    try {
      const info = await parseJson(await driveRequest(session, requestURL(base, {
        supportsAllDrives: 'true', fields: 'id,name,mimeType,size,trashed,capabilities(canDownload)',
      }), { signal: controller.signal }));
      const type = mediaType(info);
      if (!type) throw new DriveError(415, '此 Google Drive 文件不是可播放的音频或歌词。');
      if (type === 'lyric' && Number(info.size) > 1_000_000) throw new DriveError(413, 'Google Drive 歌词文件过大。');

      const url = requestURL(base, { alt: 'media', supportsAllDrives: 'true' });
      const headers = { 'Accept-Encoding': 'identity', ...(range && type !== 'lyric' ? { Range: range } : {}) };
      const upstream = await driveRequest(session, url, { headers, stream: true, signal: controller.signal });
      const length = upstream.headers.get('content-length');
      const contentRange = upstream.headers.get('content-range');
      if (upstream.status === 416) {
        await discard(upstream);
        if (contentRange) res.setHeader('Content-Range', contentRange);
        return res.writeHead(416).end();
      }
      const encoding = upstream.headers.get('content-encoding');
      if (![200, 206].includes(upstream.status) || (encoding && encoding !== 'identity') ||
        (upstream.status === 206 && !/^bytes \d+-\d+\/(?:\d+|\*)$/.test(contentRange ?? ''))) {
        await discard(upstream);
        throw new DriveError(502, 'Google Drive 未返回有效的音频数据。');
      }
      if (type === 'lyric') {
        if (req.method === 'HEAD') {
          await discard(upstream);
          return res.writeHead(200, { 'Content-Type': 'text/plain' }).end();
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of upstream.body) {
          size += chunk.byteLength;
          if (size > 1_000_000) throw new DriveError(413, 'Google Drive 歌词文件过大。');
          chunks.push(chunk);
        }
        return res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': size }).end(Buffer.concat(chunks));
      }

      res.setHeader('Content-Type', type);
      res.setHeader('Accept-Ranges', 'bytes');
      if (length && /^\d+$/.test(length)) res.setHeader('Content-Length', length);
      if (upstream.status === 206) res.setHeader('Content-Range', contentRange);
      res.writeHead(upstream.status);
      if (req.method === 'HEAD' || !upstream.body) {
        await discard(upstream);
        return res.end();
      }
      await pipeline(Readable.fromWeb(upstream.body), res);
    } finally {
      res.off('close', abort);
    }
  }

  return async function gdriveHandler(req, res, url) {
    if (!url.pathname.startsWith(prefix + '/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const action = url.pathname.slice(prefix.length + 1);
    const allowed = methods.get(action);

    try {
      if (!allowed) throw new DriveError(404, 'Google Drive 接口不存在。');
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        throw new DriveError(405, '此接口不支持该请求方法。');
      }
      const sessionId = cookieValue(req, sessionCookie);
      const authorizationId = cookieValue(req, stateCookie);
      const session = sessionEntry(sessions.entries, sessionId);

      if (action === 'status') {
        const token = session?.token;
        const connected = Boolean(configured && token && (token.expiresAt > Date.now() || token.refreshToken));
        const backupAuthorizationAvailable = backupEnabled && connected ? true : undefined;
        const canBackup = backupAuthorizationAvailable && confirmedBackup(token) ? true : undefined;
        sendJson(res, 200, { configured, connected, backupAuthorizationAvailable, canBackup });
      } else if (action === 'disconnect') {
        const origin = req.headers.origin;
        if ((origin && origin !== callback?.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new DriveError(403, '请在播放器中断开 Google Drive。');
        }
        if (session) persistSessions(entries => entries.delete(sessionId));
        pending.delete(authorizationId);
        res.setHeader('Set-Cookie', [cookie(sessionCookie, '', 0, secure), cookie(stateCookie, '', 0, secure)]);
        sendJson(res, 200, { configured, connected: false });
      } else if (!configured) {
        throw new DriveError(503, '服务端尚未配置 Google Drive 应用。');
      } else if (action === 'connect') {
        beginAuthorization(req, res, authorizationId);
      } else if (action === 'backup/connect') {
        if (!backupEnabled) throw new DriveError(403, '服务器尚未启用 Google Drive 备份授权。');
        const fetchSite = req.headers['sec-fetch-site'];
        if (req.headers.origin !== callback.origin || (fetchSite && fetchSite !== 'same-origin')) {
          throw new DriveError(403, '请在播放器中授权 Google Drive 备份。');
        }
        if (!session?.token) throw new DriveError(401, '请先连接 Google Drive。');
        beginAuthorization(req, res, authorizationId, sessionId);
      } else if (action === 'callback') {
        const authorization = sessionEntry(pending, authorizationId);
        const backupSessionId = authorization?.backupSessionId;
        const cookies = [cookie(stateCookie, '', 0, secure)];
        let result = backupSessionId ? 'backup-error' : 'error';
        if (authorization && matchesState(url.searchParams.get('state'), authorization.state)) {
          pending.delete(authorizationId);
          const code = url.searchParams.get('code');
          const activeBackup = backupEnabled && backupSessionId === sessionId && session?.token;
          const providerError = url.searchParams.get('error');
          if ((!backupSessionId || activeBackup) && providerError === 'access_denied') {
            result = backupSessionId ? 'backup-denied' : 'denied';
          } else if ((!backupSessionId || activeBackup) && !url.searchParams.has('error') && code && code.length < 4096) {
            try {
              const grant = {
                grant_type: 'authorization_code', code, redirect_uri: callback.href, code_verifier: authorization.verifier,
              };
              const { token, previousToken } = backupSessionId
                ? await approveBackup(session, sessionId, grant) : { token: await exchange(grant) };
              if (backupSessionId && (sessionEntry(sessions.entries, sessionId) !== session || session.token !== previousToken)) {
                throw new DriveError(401, 'Google Drive 授权已变更。');
              }
              const id = key();
              persistSessions(entries => {
                entries.delete(sessionId);
                saveEntry(entries, id, { token, expiresAt: Date.now() + sessionLifetime * 1000 });
              });
              cookies.push(cookie(sessionCookie, id, sessionLifetime, secure));
              result = backupSessionId ? 'backup-connected' : 'connected';
            } catch { /* Send only a generic failure marker to the app. */ }
          }
        }
        redirect(res, '/?gdrive=' + result, cookies);
      } else if (!session?.token) {
        throw new DriveError(401, '请先连接 Google Drive。');
      } else if (action === 'list') {
        sendJson(res, 200, { items: await list(session, sessionId, url.searchParams.get('path') ?? '/') });
      } else if (action === 'backup') {
        await serveBackup(req, res, session, sessionId, url.searchParams);
      } else {
        await stream(req, res, session, url.searchParams.get('id'));
      }
    } catch (error) {
      if (res.destroyed) return true;
      const failure = gdriveBackupFailure(error);
      if (res.headersSent) res.destroy();
      else if (failure) sendJson(res, failure.status, { error: failure.message, code: failure.code });
      else if (error instanceof DriveError) sendJson(res, error.status, { error: error.message });
      else sendJson(res, 502, { error: '暂时无法连接 Google Drive。' });
    }
    return true;
  };
}
