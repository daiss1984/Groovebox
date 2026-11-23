import { randomBytes, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createOAuthSessionRegistry } from './oauth-session-store.mjs';

const prefix = '/api/aliyundrive';
const scopes = ['user:base', 'file:all:read'];
const authEndpoint = 'https://openapi.alipan.com/oauth/authorize';
const tokenEndpoint = 'https://openapi.alipan.com/oauth/access_token';
const api = 'https://openapi.alipan.com/adrive/v1.0/';
const redirectStatus = new Set([301, 302, 303, 307, 308]);
const sessionCookie = 'groovebox_aliyundrive';
const stateCookie = 'groovebox_aliyundrive_pending';
const sessionLifetime = 30 * 86400;
const stateLifetime = 600;
const opaqueKey = /^[A-Za-z0-9_-]{43}$/;
const driveKey = /^\d{1,30}$/;
const fileKey = /^[A-Za-z0-9_-]{1,256}$/;
const rangeHeader = /^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/;
const methods = new Map([
  ['status', ['GET']], ['connect', ['GET']], ['callback', ['GET']], ['disconnect', ['POST']],
  ['list', ['GET']], ['stream', ['GET', 'HEAD']],
]);
const supportedAudio = new Map(Object.entries({
  '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.alac': 'audio/mp4',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.wave': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma', '.ape': 'audio/x-ape', '.weba': 'audio/webm', '.amr': 'audio/amr',
  '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff',
}));

class AliyunError extends Error {
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
  if (file?.type !== 'file' || file.can_download === false) return null;
  const extension = extname(String(file.name || '')).toLowerCase();
  const mime = String(file.mime_type || '').toLowerCase();
  if (extension === '.lrc' || extension === '.vtt') return 'lyric';
  return supportedAudio.get(extension) || (/^audio\/[a-z0-9.+-]+$/.test(mime) ? mime : null);
}

function identifier(value) {
  const [driveId, fileId, unexpected] = String(value ?? '').split(':');
  if (unexpected !== undefined || !driveKey.test(driveId) || !fileKey.test(fileId ?? '')) {
    throw new AliyunError(400, '阿里云盘文件或目录标识无效。');
  }
  return { drive_id: driveId, file_id: fileId };
}

function publicItem(file, driveId) {
  if (!fileKey.test(file?.file_id ?? '') || typeof file.name !== 'string' || !file.name) return null;
  const folder = file.type === 'folder';
  const type = mediaType(file);
  if (!folder && !type) return null;
  const id = driveId + ':' + file.file_id;
  return {
    id, name: file.name, path: id, folder, size: Number(file.size) || 0,
    streamUrl: type ? prefix + '/stream?id=' + encodeURIComponent(id) : null,
  };
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* Connection has already ended. */ }
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    throw new AliyunError(502, '阿里云盘返回了无效的响应。');
  }
}

// A sessionFile enables encrypted sessions scoped to this OAuth app and callback.
export function createAliyundriveHandler({ env = process.env, request = globalThis.fetch, sessionFile } = {}) {
  const clientId = env.ALIYUNDRIVE_CLIENT_ID?.trim();
  const clientSecret = env.ALIYUNDRIVE_CLIENT_SECRET?.trim();
  const callback = redirectURL(env.ALIYUNDRIVE_REDIRECT_URI?.trim());
  const configured = Boolean(clientId && clientSecret && callback);
  const secure = callback?.protocol === 'https:';
  const pending = new Map();
  const sessions = createOAuthSessionRegistry(
    configured ? sessionFile : undefined, clientSecret, JSON.stringify([prefix, clientId, callback?.href]),
  );

  function persistSessions(change) {
    try {
      if (change) sessions.commit(change);
      else sessions.persist();
    } catch {
      throw new AliyunError(503, '无法保存 阿里云盘 授权，请检查服务端数据目录。');
    }
  }

  function updateSessionToken(session, token) {
    session.token = token;
    persistSessions();
  }

  async function exchange(params, previousRefresh) {
    const response = await request(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...params, client_id: clientId, client_secret: clientSecret }),
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    const data = await parseJson(response);
    if (!response.ok) {
      const invalid = [data.error, data.code].some(value => /invalid_grant|RefreshTokenInvalid|InvalidRefreshToken|RefreshTokenExpired/i.test(String(value)));
      throw new AliyunError(invalid ? 401 : 502, invalid ? '阿里云盘授权已失效，请重新连接。' : '阿里云盘授权失败。');
    }
    const lifetime = Number(data.expires_in);
    if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new AliyunError(502, '阿里云盘未返回有效的访问令牌。');
    }
    if (typeof data.scope === 'string' && scopes.some(scope => !data.scope.split(/[,\s]+/).includes(scope))) {
      throw new AliyunError(403, '请授权阿里云盘只读访问权限。');
    }
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : previousRefresh,
      expiresAt: Date.now() + lifetime * 1000,
    };
  }

  async function accessToken(session, rejected) {
    const current = session.token;
    const remaining = current ? current.expiresAt - Date.now() : 0;
    if (current && expectedToken(current, rejected, remaining)) return current.accessToken;
    if (!current?.refreshToken) throw new AliyunError(401, '阿里云盘授权已失效，请重新连接。');
    if (!session.refresh) {
      session.refresh = exchange({ grant_type: 'refresh_token', refresh_token: current.refreshToken }, current.refreshToken)
        .then(token => {
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

  async function fetchAliyun(url, { headers = {}, body, signal, stream = false, redirect = 'error' } = {}) {
    const headerTimeout = stream ? new AbortController() : null;
    const timer = headerTimeout && setTimeout(() => headerTimeout.abort(), 20_000);
    const timeout = headerTimeout?.signal || AbortSignal.timeout(20_000);
    try {
      return await request(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function aliyunRequest(session, path, body, signal) {
    function send(token) {
      return fetchAliyun(api + path, { body, signal, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    }
    const token = await accessToken(session);
    let response = await send(token);
    if (response.status === 401) {
      await discard(response);
      response = await send(await accessToken(session, token));
    }
    if (response.ok) return parseJson(response);
    const status = response.status;
    await discard(response);
    if (status === 401) {
      updateSessionToken(session, null);
      throw new AliyunError(401, '阿里云盘授权已失效，请重新连接。');
    }
    if (status === 403) throw new AliyunError(403, '阿里云盘拒绝访问，请检查应用或文件权限。');
    if (status === 404) throw new AliyunError(404, '在阿里云盘中找不到此文件或目录。');
    if (status === 429) throw new AliyunError(429, '阿里云盘请求过多，请稍后重试。');
    throw new AliyunError(502, '阿里云盘暂时无法响应。');
  }

  function availableDrives(session) {
    if (!session.drives) {
      session.drives = aliyunRequest(session, 'user/getDriveInfo', {}).then(data => {
        const drives = new Map();
        for (const [id, name] of [
          [data.resource_drive_id, '资源库'], [data.backup_drive_id, '备份盘'], [data.default_drive_id, '我的云盘'],
        ]) {
          if (driveKey.test(id ?? '') && !drives.has(id)) drives.set(id, name);
        }
        if (!drives.size) throw new AliyunError(502, '阿里云盘未返回可用的网盘。');
        return drives;
      }).catch(error => { session.drives = null; throw error; });
    }
    return session.drives;
  }

  async function list(session, path) {
    const drives = await availableDrives(session);
    if (path === '/' && drives.size > 1) {
      return [...drives].map(([driveId, name]) => {
        const id = driveId + ':root';
        return { id, name, path: id, folder: true, size: 0, streamUrl: null };
      });
    }
    const { drive_id, file_id } = identifier(path === '/' ? drives.keys().next().value + ':root' : path);
    if (!drives.has(drive_id)) throw new AliyunError(404, '找不到此阿里云盘。');
    const items = new Map();
    const markers = new Set();
    let marker;
    do {
      const data = await aliyunRequest(session, 'openFile/list', {
        drive_id, parent_file_id: file_id, limit: 100, ...(marker ? { marker } : {}),
      });
      if (!Array.isArray(data.items)) throw new AliyunError(502, '阿里云盘未返回目录。');
      for (const file of data.items) {
        const item = publicItem(file, drive_id);
        if (item) items.set(item.id, item);
      }
      marker = data.next_marker;
      if (marker && (typeof marker !== 'string' || markers.has(marker) || markers.size >= 1000)) {
        throw new AliyunError(502, '阿里云盘未返回完整目录。');
      }
      if (marker) markers.add(marker);
    } while (marker);
    return [...items.values()];
  }

  function downloadURL(raw, previous) {
    const url = new URL(raw, previous);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      !/(?:^|\.)(?:aliyundrive\.(?:net|cloud|com)|alipan\.com)$/.test(url.hostname)) {
      throw new AliyunError(502, '阿里云盘返回了非受信的下载地址。');
    }
    return url;
  }

  async function download(session, file, headers, signal) {
    const signed = await aliyunRequest(session, 'openFile/getDownloadUrl', { ...file, expire_sec: 900 }, signal);
    if (typeof signed.url !== 'string' || !signed.url || (signed.method && String(signed.method).toUpperCase() !== 'GET')) {
      throw new AliyunError(502, '阿里云盘未返回有效的下载地址。');
    }
    let url = downloadURL(signed.url);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchAliyun(url, { headers, signal, stream: true, redirect: 'manual' });
      if (!redirectStatus.has(response.status)) return response;
      const location = response.headers.get('location');
      await discard(response);
      if (!location || redirects === 3) break;
      url = downloadURL(location, url);
    }
    throw new AliyunError(502, '阿里云盘返回了无效的下载重定向。');
  }

  async function stream(req, res, session, id) {
    const file = identifier(id);
    if (file.file_id === 'root' || !(await availableDrives(session)).has(file.drive_id)) {
      throw new AliyunError(404, '找不到此阿里云盘文件。');
    }
    const range = req.headers.range;
    if (range && !rangeHeader.test(range)) throw new AliyunError(416, '音频范围无效。');

    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const info = await aliyunRequest(session, 'openFile/get', file, controller.signal);
      const type = mediaType(info);
      if (!type) throw new AliyunError(415, '此 阿里云盘文件不是可播放的音频或歌词。');
      if (type === 'lyric' && Number(info.size) > 1_000_000) throw new AliyunError(413, '阿里云盘歌词文件过大。');

      const headers = {
        'Accept-Encoding': 'identity',
        ...(range && type !== 'lyric' ? { Range: range } : {}),
      };
      const upstream = await download(session, file, headers, controller.signal);
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
        throw new AliyunError(502, '阿里云盘未返回有效的音频数据。');
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
          if (size > 1_000_000) throw new AliyunError(413, '阿里云盘歌词文件过大。');
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

  return async function aliyundriveHandler(req, res, url) {
    if (!url.pathname.startsWith(prefix + '/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const action = url.pathname.slice(prefix.length + 1);
    const allowed = methods.get(action);

    try {
      if (!allowed) throw new AliyunError(404, '阿里云盘接口不存在。');
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        throw new AliyunError(405, '此接口不支持该请求方法。');
      }
      const sessionId = cookieValue(req, sessionCookie);
      const authorizationId = cookieValue(req, stateCookie);
      const session = sessionEntry(sessions.entries, sessionId);

      if (action === 'status') {
        const token = session?.token;
        sendJson(res, 200, { configured, connected: Boolean(configured && token && (token.expiresAt > Date.now() || token.refreshToken)) });
      } else if (action === 'disconnect') {
        const origin = req.headers.origin;
        if ((origin && origin !== callback?.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new AliyunError(403, '请在播放器中断开阿里云盘。');
        }
        if (session) persistSessions(entries => entries.delete(sessionId));
        pending.delete(authorizationId);
        res.setHeader('Set-Cookie', [cookie(sessionCookie, '', 0, secure), cookie(stateCookie, '', 0, secure)]);
        sendJson(res, 200, { configured, connected: false });
      } else if (!configured) {
        throw new AliyunError(503, '服务端尚未配置 阿里云盘应用。');
      } else if (action === 'connect') {
        if (req.headers.host !== callback.host) throw new AliyunError(400, '请使用与阿里云盘回调地址一致的播放器网址。');
        const id = key();
        const state = key();
        pending.delete(authorizationId);
        saveEntry(pending, id, { state, expiresAt: Date.now() + stateLifetime * 1000 });
        redirect(res, requestURL(authEndpoint, {
          response_type: 'code', client_id: clientId, redirect_uri: callback.href,
          scope: scopes.join(','), state,
        }).href, [cookie(stateCookie, id, stateLifetime, secure)]);
      } else if (action === 'callback') {
        const authorization = sessionEntry(pending, authorizationId);
        const cookies = [cookie(stateCookie, '', 0, secure)];
        let result = 'error';
        if (authorization && matchesState(url.searchParams.get('state'), authorization.state)) {
          pending.delete(authorizationId);
          const code = url.searchParams.get('code');
          if (url.searchParams.get('error') === 'access_denied') {
            result = 'denied';
          } else if (!url.searchParams.has('error') && code && code.length < 4096) {
            try {
              const token = await exchange({
                grant_type: 'authorization_code', code,
              });
              const id = key();
              persistSessions(entries => {
                entries.delete(sessionId);
                saveEntry(entries, id, { token, expiresAt: Date.now() + sessionLifetime * 1000 });
              });
              cookies.push(cookie(sessionCookie, id, sessionLifetime, secure));
              result = 'connected';
            } catch { /* Send only a generic failure marker to the app. */ }
          }
        }
        redirect(res, '/?aliyundrive=' + result, cookies);
      } else if (!session?.token) {
        throw new AliyunError(401, '请先连接阿里云盘。');
      } else if (action === 'list') {
        sendJson(res, 200, { items: await list(session, url.searchParams.get('path') ?? '/') });
      } else {
        await stream(req, res, session, url.searchParams.get('id'));
      }
    } catch (error) {
      if (res.destroyed) return true;
      if (res.headersSent) res.destroy();
      else if (error instanceof AliyunError) sendJson(res, error.status, { error: error.message });
      else sendJson(res, 502, { error: '暂时无法连接阿里云盘。' });
    }
    return true;
  };
}
