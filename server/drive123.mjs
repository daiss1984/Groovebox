import { randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createOAuthSessionRegistry } from './oauth-session-store.mjs';

const prefix = '/api/drive123';
const authorizeEndpoint = 'https://yun.123pan.com/auth';
const apiOrigin = 'https://open-api.123pan.com';
const scope = 'user:base,file:all:read,file:all:write';
const pendingCookie = 'groovebox_drive123_pending';
const sessionCookie = 'groovebox_drive123';
const pendingLifetime = 600;
const sessionLifetime = 30 * 86400;
const opaqueKey = /^[\w-]{43}$/;
const byteRange = /^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/;
const lyricsLimit = 1_000_000;
const redirects = new Set([301, 302, 303, 307, 308]);
const methods = new Map([
  ['status', ['GET']], ['connect', ['GET']], ['callback', ['GET']], ['disconnect', ['POST']],
  ['list', ['GET']], ['stream', ['GET', 'HEAD']],
]);
const audioTypes = new Map(Object.entries({
  '.aac': 'audio/aac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.alac': 'audio/mp4',
  '.amr': 'audio/amr', '.ape': 'audio/x-ape', '.flac': 'audio/flac',
  '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff',
  '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp3': 'audio/mpeg', '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.wave': 'audio/wav',
  '.weba': 'audio/webm', '.wma': 'audio/x-ms-wma',
}));

class Drive123Error extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function callbackURL(value) {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol === 'https:' || (loopback && url.protocol === 'http:')) &&
        url.pathname === prefix + '/callback' && !url.username && !url.password &&
        !url.search && !url.hash) return url;
  } catch {
    // A malformed redirect URI disables the provider.
  }
  return null;
}

function randomKey() {
  return randomBytes(32).toString('base64url');
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

function remember(store, key, entry) {
  const now = Date.now();
  for (const [id, value] of store) {
    if (value.expiresAt <= now) store.delete(id);
  }
  if (store.size >= 2000) store.delete(store.keys().next().value);
  store.set(key, entry);
}

function lookup(store, key) {
  const entry = store.get(key);
  if (entry?.expiresAt > Date.now()) return entry;
  if (entry) store.delete(key);
  return null;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
}

function redirect(res, url, cookies) {
  res.writeHead(303, { Location: url, 'Set-Cookie': cookies }).end();
}

function fileId(value) {
  const text = String(value ?? '');
  return /^(?:0|[1-9]\d{0,18})$/.test(text) && BigInt(text) <= 9223372036854775807n ? text : '';
}

function visible(file) {
  return file && Number(file.trashed ?? 0) === 0 && Number(file.status ?? 0) <= 100;
}

function mediaType(file) {
  if (!visible(file) || Number(file.type) !== 0 || typeof file.filename !== 'string') return null;
  const ext = posix.extname(file.filename).toLowerCase();
  if (ext === '.lrc' || ext === '.vtt') return 'lyrics';
  return audioTypes.get(ext) || null;
}

function publicItem(file) {
  if (!visible(file) || typeof file.filename !== 'string' || !file.filename) return null;
  const id = fileId(file.fileId ?? file.fileID);
  if (!id) return null;
  return {
    id,
    name: file.filename,
    path: id,
    folder: Number(file.type) === 1,
    size: Number(file.size) || 0,
    streamUrl: mediaType(file) ? prefix + '/stream?id=' + id : null,
  };
}

function downloadURL(value, base) {
  let url;
  try {
    if (!value || typeof value !== 'string') throw new Error();
    url = new URL(value, base);
  } catch {
    throw new Drive123Error(502, '123 云盘返回了无效下载地址。');
  }
  const officialHost = /(?:^|\.)(?:123pan\.(?:cn|com)|123(?:278|365|592|624|684|685|865|912|957)\.com)$/.test(url.hostname);
  if (!officialHost || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) {
    throw new Drive123Error(502, '123 云盘返回了无效下载地址。');
  }
  return url;
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* The upstream may already be closed. */ }
}

function decodeLyrics(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  }
}

// A sessionFile enables encrypted sessions scoped to this OAuth app and callback.
export function createDrive123Handler({ env = process.env, request = globalThis.fetch, sessionFile } = {}) {
  const clientId = env.DRIVE123_CLIENT_ID?.trim();
  const clientSecret = env.DRIVE123_CLIENT_SECRET?.trim();
  const redirectUri = env.DRIVE123_REDIRECT_URI?.trim();
  const callback = callbackURL(redirectUri);
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
      throw new Drive123Error(503, '无法保存 123 云盘 授权，请检查服务端数据目录。');
    }
  }

  function updateSessionToken(session, token) {
    session.token = token;
    persistSessions();
  }

  async function apiRequest(route, params, { token, method = 'GET', signal } = {}) {
    const url = new URL(route, apiOrigin);
    url.search = new URLSearchParams(params).toString();
    const headers = { Accept: 'application/json', Platform: 'open_platform' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const timeout = AbortSignal.timeout(15_000);
    const reply = await request(url, {
      method, headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const raw = await reply.text();
    const data = JSON.parse(raw, (key, value, context) => {
      if (['fileId', 'fileID', 'lastFileId'].includes(key) && typeof value === 'number') return context.source;
      return value;
    });
    return { status: reply.status, ok: reply.ok, data };
  }

  async function exchange(params) {
    const { status, ok, data } = await apiRequest('/api/v1/oauth2/access_token',
      { client_id: clientId, client_secret: clientSecret, ...params }, { method: 'POST' });
    const expiration = Number(data?.expires_in);
    if (status === 401 || Number(data?.code) === 401 ||
        data?.error === 'invalid_grant' || Number(data?.code) === 400) {
      throw new Drive123Error(401, '123 云盘授权已失效，请重新连接。');
    }
    if (status === 429 || Number(data?.code) === 429) {
      throw new Drive123Error(429, '123 云盘授权请求过于频繁，请稍后重试。');
    }
    if (!ok || typeof data?.access_token !== 'string' || !data.access_token ||
        typeof data.refresh_token !== 'string' || !data.refresh_token ||
        !Number.isSafeInteger(expiration) || expiration <= 0) {
      throw new Drive123Error(502, '123 云盘未返回有效的访问令牌。');
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + expiration * 1000,
    };
  }

  async function accessToken(session, rejected) {
    if (session.refreshing) return session.refreshing;
    const token = session.token;
    if (token && token.accessToken !== rejected && token.expiresAt > Date.now() + 30_000) {
      return token.accessToken;
    }
    if (!token?.refreshToken) throw new Drive123Error(401, '123 云盘授权已失效，请重新连接。');
    session.refreshing = exchange({ grant_type: 'refresh_token', refresh_token: token.refreshToken })
      .then(next => {
        updateSessionToken(session, next);
        return next.accessToken;
      })
      .catch(error => {
        if (error instanceof Drive123Error && error.status === 401) updateSessionToken(session, null);
        throw error;
      })
      .finally(() => { session.refreshing = null; });
    return session.refreshing;
  }

  function tokenWasRejected(reply) {
    return reply.status === 401 || Number(reply.data?.code) === 401;
  }

  async function api(session, route, params, signal) {
    const token = await accessToken(session);
    let reply = await apiRequest(route, params, { token, signal });
    if (tokenWasRejected(reply)) {
      reply = await apiRequest(route, params, { token: await accessToken(session, token), signal });
    }
    if (tokenWasRejected(reply)) {
      updateSessionToken(session, null);
      throw new Drive123Error(401, '123 云盘授权已失效，请重新连接。');
    }
    const code = Number(reply.data?.code);
    if (reply.ok && code === 0) return reply.data.data;
    if (reply.status === 403 || code === 403) throw new Drive123Error(403, '123 云盘拒绝访问。');
    if (reply.status === 404 || code === 5066) throw new Drive123Error(404, '123 云盘文件或目录不存在。');
    if (code === 5113) throw new Drive123Error(429, '123 云盘下载流量已用完。');
    if (reply.status === 429 || code === 429) throw new Drive123Error(429, '123 云盘请求过于频繁，请稍后重试。');
    throw new Drive123Error(502, '123 云盘暂时无法响应。');
  }

  async function list(session, path) {
    const parentFileId = fileId(path === '/' ? '0' : path);
    if (!parentFileId) throw new Drive123Error(400, '123 云盘文件夹标识无效。');
    const items = new Map();
    const visited = new Set();
    let next;
    do {
      const data = await api(session, '/api/v2/file/list', {
        parentFileId, limit: '100', ...(next ? { lastFileId: next } : {}),
      });
      if (!Array.isArray(data?.fileList)) throw new Drive123Error(502, '123 云盘未返回目录。');
      for (const file of data.fileList) {
        const item = publicItem(file);
        if (item) items.set(item.id, item);
      }
      if (String(data.lastFileId) === '-1') break;
      next = fileId(data.lastFileId);
      if (!next || visited.has(next) || visited.size >= 1000) {
        throw new Drive123Error(502, '123 云盘未返回完整目录。');
      }
      visited.add(next);
    } while (true);
    return [...items.values()];
  }

  async function download(url, method, range, controller) {
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
    throw new Drive123Error(502, '123 云盘 未返回下载数据。');
  }

  async function serveLyrics(url, req, res, controller) {
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const upstream = await download(url, 'GET', null, controller);
      if (upstream.status !== 200 || !upstream.body) {
        await discard(upstream);
        throw new Drive123Error(502, '123 云盘 未返回歌词数据。');
      }
      if (Number(upstream.headers.get('content-length')) > lyricsLimit) {
        await discard(upstream);
        throw new Drive123Error(413, '123 云盘 歌词文件超过 1 MB。');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.byteLength;
        if (size > lyricsLimit) throw new Drive123Error(413, '123 云盘 歌词文件超过 1 MB。');
        chunks.push(chunk);
      }
      let lyrics;
      try {
        lyrics = decodeLyrics(Buffer.concat(chunks, size)).replace(/\r\n?/g, '\n');
      } catch {
        throw new Drive123Error(415, '不支持此 123 云盘 歌词文件编码。');
      }
      if (lyrics.includes('\0')) throw new Drive123Error(415, '不支持此 123 云盘 歌词文件编码。');
      const body = Buffer.from(lyrics, 'utf8');
      if (body.byteLength > lyricsLimit) throw new Drive123Error(413, '123 云盘 歌词文件超过 1 MB。');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.byteLength,
        'Content-Security-Policy': "default-src 'none'",
      }).end(req.method === 'HEAD' ? undefined : body);
    } finally {
      clearTimeout(deadline);
    }
  }

  async function stream(req, res, session, id) {
    const fileid = fileId(id);
    if (!fileid || fileid === '0') throw new Drive123Error(400, '123 云盘 文件标识无效。');
    const range = req.headers.range;
    if (range && !byteRange.test(range)) throw new Drive123Error(416, '音频范围无效。');
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const metadata = await api(session, '/api/v1/file/detail', { fileID: fileid }, controller.signal);
      const type = mediaType(metadata);
      if (!type) throw new Drive123Error(415, '请选择支持的 123 云盘 音频或歌词文件。');
      if (type === 'lyrics' && Number(metadata.size) > lyricsLimit) {
        throw new Drive123Error(413, '123 云盘 歌词文件超过 1 MB。');
      }
      const data = await api(session, '/api/v1/file/download_info', { fileId: fileid }, controller.signal);
      const url = downloadURL(data?.downloadUrl);
      if (type === 'lyrics') {
        await serveLyrics(url, req, res, controller);
        return;
      }
      let upstream = await download(url, req.method, range, controller);
      if (req.method === 'HEAD' && [405, 501].includes(upstream.status)) {
        await discard(upstream);
        upstream = await download(url, 'GET', range, controller);
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
          (upstream.status === 206 && !/^bytes \d+-\d+\/(?:\d+|\*)$/.test(contentRange ?? '')) ||
          (encoding && encoding.toLowerCase() !== 'identity') ||
          /^(?:text\/|application\/(?:json|xml))/i.test(upstreamType) ||
          (req.method === 'GET' && !upstream.body)) {
        await discard(upstream);
        throw new Drive123Error(502, '123 云盘 未返回有效的音频数据。');
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

  return async function drive123Handler(req, res, url) {
    if (!url.pathname.startsWith(prefix + '/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      const action = url.pathname.slice(prefix.length + 1);
      const allowed = methods.get(action);
      if (!allowed) throw new Drive123Error(404, '123 云盘 接口不存在。');
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        throw new Drive123Error(405, '此接口不支持该请求方法。');
      }
      const sessionId = cookieValue(req, sessionCookie);
      const oauthId = cookieValue(req, pendingCookie);
      const session = lookup(sessions.entries, sessionId);
      if (action === 'status') {
        sendJson(res, 200, { configured, connected: Boolean(configured && session?.token) });
      } else if (action === 'disconnect') {
        const origin = req.headers.origin;
        if ((origin && origin !== callback?.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new Drive123Error(403, '请在播放器中断开 123 云盘。');
        }
        if (session) persistSessions(entries => entries.delete(sessionId));
        pending.delete(oauthId);
        res.setHeader('Set-Cookie', [cookie(sessionCookie, '', 0, secure), cookie(pendingCookie, '', 0, secure)]);
        sendJson(res, 200, { configured, connected: false });
      } else if (!configured) {
        throw new Drive123Error(503, '服务器尚未配置 123 云盘 应用。');
      } else if (action === 'connect') {
        if (req.headers.host !== callback.host) throw new Drive123Error(400, '请使用与 123 云盘 回调地址一致的播放器网址。');
        const id = randomKey();
        const state = randomKey();
        pending.delete(oauthId);
        remember(pending, id, { state, expiresAt: Date.now() + pendingLifetime * 1000 });
        const authorize = new URL(authorizeEndpoint);
        authorize.search = new URLSearchParams({
          client_id: clientId, redirect_uri: redirectUri, scope, state,
        }).toString();
        redirect(res, authorize.href, [cookie(pendingCookie, id, pendingLifetime, secure)]);
      } else if (action === 'callback') {
        const authorization = lookup(pending, oauthId);
        const state = url.searchParams.get('state') ?? '';
        if (!authorization || !opaqueKey.test(state) ||
            !timingSafeEqual(Buffer.from(state), Buffer.from(authorization.state))) {
          throw new Drive123Error(400, '123 云盘 授权已过期或回调不匹配，请重新连接。');
        }
        pending.delete(oauthId);
        const cookies = [cookie(pendingCookie, '', 0, secure)];
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        let result = error === 'access_denied' ? 'denied' : 'error';
        if (!error && code && code.length <= 4096) {
          try {
            const token = await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
            const id = randomKey();
            persistSessions(entries => {
              entries.delete(sessionId);
              remember(entries, id, { token, expiresAt: Date.now() + sessionLifetime * 1000 });
            });
            cookies.push(cookie(sessionCookie, id, sessionLifetime, secure));
            result = 'connected';
          } catch {
            // The browser receives a generic failure marker.
          }
        }
        redirect(res, '/?drive123=' + result, cookies);
      } else if (!session?.token) {
        throw new Drive123Error(401, '请先连接 123 云盘。');
      } else if (action === 'list') {
        sendJson(res, 200, { items: await list(session, url.searchParams.get('path') ?? '/') });
      } else {
        await stream(req, res, session, url.searchParams.get('id'));
      }
    } catch (error) {
      if (res.destroyed) return true;
      if (res.headersSent) res.destroy();
      else if (error instanceof Drive123Error) sendJson(res, error.status, { error: error.message });
      else sendJson(res, 502, { error: '无法连接 123 云盘，请稍后重试。' });
    }
    return true;
  };
}
