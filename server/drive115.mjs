import { randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createOAuthSessionRegistry } from './oauth-session-store.mjs';

const prefix = '/api/drive115';
const authOrigin = 'https://passportapi.115.com';
const apiOrigin = 'https://proapi.115.com';
const userAgent = 'Groovebox/1.0';
const authRejections = new Set([40140116, 40140123, 40140124, 40140125, 40140126]);
const pendingCookie = 'groovebox_drive115_pending';
const sessionCookie = 'groovebox_drive115';
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

class Drive115Error extends Error {
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

function mediaType(name) {
  if (typeof name !== 'string') return null;
  const ext = posix.extname(name).toLowerCase();
  if (ext === '.lrc' || ext === '.vtt') return 'lyrics';
  return audioTypes.get(ext) || null;
}

function publicItem(file) {
  if (!file || typeof file.fn !== 'string' || !file.fn || Number(file.aid ?? 1) !== 1) return null;
  const id = fileId(file.fid);
  const category = String(file.fc);
  if (!id || !['0', '1'].includes(category)) return null;
  const folder = category === '0';
  const duration = Number(file.play_long);
  return {
    id,
    name: file.fn,
    path: id,
    folder,
    size: Number(file.fs) || 0,
    streamUrl: !folder && mediaType(file.fn) ? prefix + '/stream?id=' + id : null,
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
  };
}

function downloadURL(value, base) {
  let url;
  try {
    if (!value || typeof value !== 'string') throw new Error();
    url = new URL(value, base);
  } catch {
    throw new Drive115Error(502, '115 网盘返回了无效下载地址。');
  }
  const officialHost = /(?:^|\.)(?:115\.com|115cdn\.(?:net|com)|115vod\.com)$/.test(url.hostname);
  if (!officialHost || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) {
    throw new Drive115Error(502, '115 网盘返回了无效下载地址。');
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
export function createDrive115Handler({ env = process.env, request = globalThis.fetch, sessionFile } = {}) {
  const clientId = env.DRIVE115_CLIENT_ID?.trim();
  const clientSecret = env.DRIVE115_CLIENT_SECRET?.trim();
  const redirectUri = env.DRIVE115_REDIRECT_URI?.trim();
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
      throw new Drive115Error(503, '无法保存 115 网盘 授权，请检查服务端数据目录。');
    }
  }

  function updateSessionToken(session, token) {
    session.token = token;
    persistSessions();
  }

  async function apiRequest(origin, route, { token, query, body, signal } = {}) {
    const url = new URL(route, origin);
    if (query) url.search = new URLSearchParams(query).toString();
    const headers = { Accept: 'application/json', 'User-Agent': userAgent };
    if (token) headers.Authorization = 'Bearer ' + token;
    const timeout = AbortSignal.timeout(15_000);
    const reply = await request(url, {
      method: body ? 'POST' : 'GET', headers, body, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const raw = await reply.text();
    const data = JSON.parse(raw, (key, value, context) => {
      if ((key === 'fid' || key === 'file_id') && typeof value === 'number') return context.source;
      return value;
    });
    return { status: reply.status, ok: reply.ok, data };
  }

  async function exchange(route, params) {
    const reply = await apiRequest(authOrigin, route, { body: new URLSearchParams(params) });
    const code = Number(reply.data?.code || reply.data?.errno);
    const data = reply.data?.data;
    const expiration = Number(data?.expires_in);
    if (reply.status === 401 || [40140116, 40140119, 40140120].includes(code)) {
      throw new Drive115Error(401, '115 网盘授权已失效，请重新连接。');
    }
    if (reply.status === 429 || code === 40140117) {
      throw new Drive115Error(429, '115 网盘授权请求过于频繁，请稍后重试。');
    }
    if (!reply.ok || !reply.data?.state || typeof data?.access_token !== 'string' || !data.access_token ||
        typeof data.refresh_token !== 'string' || !data.refresh_token ||
        !Number.isSafeInteger(expiration) || expiration <= 0) {
      throw new Drive115Error(502, '115 网盘未返回有效的访问令牌。');
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
    if (!token?.refreshToken) throw new Drive115Error(401, '115 网盘授权已失效，请重新连接。');
    session.refreshing = exchange('/open/refreshToken', { refresh_token: token.refreshToken })
      .then(next => {
        updateSessionToken(session, next);
        return next.accessToken;
      })
      .catch(error => {
        if (error instanceof Drive115Error && error.status === 401) updateSessionToken(session, null);
        throw error;
      })
      .finally(() => { session.refreshing = null; });
    return session.refreshing;
  }

  function tokenWasRejected(reply) {
    return reply.status === 401 || authRejections.has(Number(reply.data?.code || reply.data?.errno));
  }

  async function api(session, route, options = {}) {
    const token = await accessToken(session);
    let reply = await apiRequest(apiOrigin, route, { ...options, token });
    if (tokenWasRejected(reply)) {
      reply = await apiRequest(apiOrigin, route, { ...options, token: await accessToken(session, token) });
    }
    if (tokenWasRejected(reply)) {
      updateSessionToken(session, null);
      throw new Drive115Error(401, '115 网盘授权已失效，请重新连接。');
    }
    if (reply.ok && (reply.data?.state === true || reply.data?.state === 1)) return reply.data;
    if (reply.status === 403) throw new Drive115Error(403, '115 网盘拒绝访问。');
    if (reply.status === 404) throw new Drive115Error(404, '115 网盘文件或目录不存在。');
    if (reply.status === 429) throw new Drive115Error(429, '115 网盘请求过于频繁，请稍后重试。');
    throw new Drive115Error(502, '115 网盘暂时无法响应。');
  }

  async function list(session, path) {
    const cid = fileId(path === '/' ? '0' : path);
    if (!cid) throw new Drive115Error(400, '115 网盘文件夹标识无效。');
    const items = new Map();
    const limit = 500;
    let offset = 0;
    for (let page = 0; page < 1000; page += 1) {
      const reply = await api(session, '/open/ufile/files', {
        query: { cid, limit, offset, cur: '1', show_dir: '1' },
      });
      if (!Array.isArray(reply.data)) throw new Drive115Error(502, '115 网盘未返回目录。');
      const previousSize = items.size;
      for (const file of reply.data) {
        const item = publicItem(file);
        if (item) items.set(item.id, item);
      }
      offset += reply.data.length;
      const count = Number(reply.count);
      if (!reply.data.length || (Number.isFinite(count) ? offset >= count : reply.data.length < limit)) {
        return [...items.values()];
      }
      if (items.size === previousSize && reply.data.some(file => publicItem(file))) break;
    }
    throw new Drive115Error(502, '115 网盘未返回完整目录。');
  }

  async function download(url, method, range, controller) {
    const headers = { 'Accept-Encoding': 'identity', 'User-Agent': userAgent, ...(range ? { Range: range } : {}) };
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
    throw new Drive115Error(502, '115 网盘 未返回下载数据。');
  }

  async function serveLyrics(url, req, res, controller) {
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const upstream = await download(url, 'GET', null, controller);
      if (upstream.status !== 200 || !upstream.body) {
        await discard(upstream);
        throw new Drive115Error(502, '115 网盘 未返回歌词数据。');
      }
      if (Number(upstream.headers.get('content-length')) > lyricsLimit) {
        await discard(upstream);
        throw new Drive115Error(413, '115 网盘 歌词文件超过 1 MB。');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.byteLength;
        if (size > lyricsLimit) throw new Drive115Error(413, '115 网盘 歌词文件超过 1 MB。');
        chunks.push(chunk);
      }
      let lyrics;
      try {
        lyrics = decodeLyrics(Buffer.concat(chunks, size)).replace(/\r\n?/g, '\n');
      } catch {
        throw new Drive115Error(415, '不支持此 115 网盘 歌词文件编码。');
      }
      if (lyrics.includes('\0')) throw new Drive115Error(415, '不支持此 115 网盘 歌词文件编码。');
      const body = Buffer.from(lyrics, 'utf8');
      if (body.byteLength > lyricsLimit) throw new Drive115Error(413, '115 网盘 歌词文件超过 1 MB。');
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
    if (!fileid || fileid === '0') throw new Drive115Error(400, '115 网盘 文件标识无效。');
    const range = req.headers.range;
    if (range && !byteRange.test(range)) throw new Drive115Error(416, '音频范围无效。');
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const detail = await api(session, '/open/folder/get_info', { query: { file_id: fileid }, signal: controller.signal });
      const metadata = detail.data;
      const type = String(metadata?.file_category) === '1' ? mediaType(metadata.file_name) : null;
      if (!type) throw new Drive115Error(415, '请选择支持的 115 网盘音频或歌词文件。');
      if (type === 'lyrics' && Number(metadata.size_byte) > lyricsLimit) {
        throw new Drive115Error(413, '115 网盘歌词文件超过 1 MB。');
      }
      if (!/^[a-z0-9]{1,128}$/i.test(metadata.pick_code ?? '')) {
        throw new Drive115Error(502, '115 网盘未返回文件提取码。');
      }
      const form = new FormData();
      form.set('pick_code', metadata.pick_code);
      const { data } = await api(session, '/open/ufile/downurl', { body: form, signal: controller.signal });
      const file = data?.[fileid];
      if (type === 'lyrics' && Number(file?.file_size) > lyricsLimit) {
        throw new Drive115Error(413, '115 网盘歌词文件超过 1 MB。');
      }
      const url = downloadURL(file?.url?.url);
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
        throw new Drive115Error(502, '115 网盘 未返回有效的音频数据。');
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

  return async function drive115Handler(req, res, url) {
    if (!url.pathname.startsWith(prefix + '/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      const action = url.pathname.slice(prefix.length + 1);
      const allowed = methods.get(action);
      if (!allowed) throw new Drive115Error(404, '115 网盘 接口不存在。');
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        throw new Drive115Error(405, '此接口不支持该请求方法。');
      }
      const sessionId = cookieValue(req, sessionCookie);
      const oauthId = cookieValue(req, pendingCookie);
      const session = lookup(sessions.entries, sessionId);
      if (action === 'status') {
        sendJson(res, 200, { configured, connected: Boolean(configured && session?.token) });
      } else if (action === 'disconnect') {
        const origin = req.headers.origin;
        if ((origin && origin !== callback?.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new Drive115Error(403, '请在播放器中断开 115 网盘。');
        }
        if (session) persistSessions(entries => entries.delete(sessionId));
        pending.delete(oauthId);
        res.setHeader('Set-Cookie', [cookie(sessionCookie, '', 0, secure), cookie(pendingCookie, '', 0, secure)]);
        sendJson(res, 200, { configured, connected: false });
      } else if (!configured) {
        throw new Drive115Error(503, '服务器尚未配置 115 网盘 应用。');
      } else if (action === 'connect') {
        if (req.headers.host !== callback.host) throw new Drive115Error(400, '请使用与 115 网盘 回调地址一致的播放器网址。');
        const id = randomKey();
        const state = randomKey();
        pending.delete(oauthId);
        remember(pending, id, { state, expiresAt: Date.now() + pendingLifetime * 1000 });
        const authorize = new URL('/open/authorize', authOrigin);
        authorize.search = new URLSearchParams({
          response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state,
        }).toString();
        redirect(res, authorize.href, [cookie(pendingCookie, id, pendingLifetime, secure)]);
      } else if (action === 'callback') {
        const authorization = lookup(pending, oauthId);
        const state = url.searchParams.get('state') ?? '';
        if (!authorization || !opaqueKey.test(state) ||
            !timingSafeEqual(Buffer.from(state), Buffer.from(authorization.state))) {
          throw new Drive115Error(400, '115 网盘 授权已过期或回调不匹配，请重新连接。');
        }
        pending.delete(oauthId);
        const cookies = [cookie(pendingCookie, '', 0, secure)];
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        let result = error === 'access_denied' ? 'denied' : 'error';
        if (!error && code && code.length <= 4096) {
          try {
            const token = await exchange('/open/authCodeToToken', {
              client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
              code, redirect_uri: redirectUri,
            });
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
        redirect(res, '/?drive115=' + result, cookies);
      } else if (!session?.token) {
        throw new Drive115Error(401, '请先连接 115 网盘。');
      } else if (action === 'list') {
        sendJson(res, 200, { items: await list(session, url.searchParams.get('path') ?? '/') });
      } else {
        await stream(req, res, session, url.searchParams.get('id'));
      }
    } catch (error) {
      if (res.destroyed) return true;
      if (res.headersSent) res.destroy();
      else if (error instanceof Drive115Error) sendJson(res, error.status, { error: error.message });
      else sendJson(res, 502, { error: '无法连接 115 网盘，请稍后重试。' });
    }
    return true;
  };
}
