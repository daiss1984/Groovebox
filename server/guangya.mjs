import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createOAuthSessionRegistry } from './oauth-session-store.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const prefix = '/api/guangya';
const authEndpoint = 'https://www.guangyapan.com/oauth/';
const accountEndpoint = 'https://openapi-account.guangyapan.com/v1/auth/token';
const api = 'https://openapi.guangyapan.com/openapi/v1/file/';
const sessionCookie = 'groovebox_guangya';
const pendingCookie = 'groovebox_guangya_pending';
const sessionLifetime = 30 * 86400;
const pendingLifetime = 600;
const opaqueKey = /^[A-Za-z0-9_-]{43}$/;
const fileKey = /^[A-Za-z0-9_-]{1,128}$/;
const rangeHeader = /^bytes=(?:\d{1,18}-\d{0,18}|-\d{1,18})$/;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const lyricLimit = 1_000_000;
const methods = {
  status: ['GET'], connect: ['GET'], callback: ['GET'], disconnect: ['POST'],
  list: ['GET'], stream: ['GET', 'HEAD'],
};
const audioTypes = new Map(Object.entries({
  '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.alac': 'audio/mp4',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.wave': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma', '.ape': 'audio/x-ape', '.weba': 'audio/webm', '.amr': 'audio/amr',
  '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff',
}));

class GuangyaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function key() {
  return randomBytes(32).toString('base64url');
}

function isFileId(value) {
  return typeof value === 'string' && fileKey.test(value);
}

function address(value, previous) {
  try {
    return new URL(value, previous);
  } catch {
    return null;
  }
}

function redirectURI(value) {
  const url = address(value);
  if (!url || url.pathname !== prefix + '/callback' || url.username || url.password || url.search || url.hash) return null;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url : null;
}

function cookie(name, value, maxAge, secure) {
  return name + '=' + value + '; Path=' + prefix + '; HttpOnly; SameSite=Lax; Max-Age=' + maxAge +
    (secure ? '; Secure' : '');
}

function cookieValue(req, name) {
  const marker = name + '=';
  const value = req.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(marker))?.slice(marker.length);
  return opaqueKey.test(value ?? '') ? value : '';
}

function currentEntry(store, id) {
  const value = store.get(id);
  if (value?.expiresAt > Date.now()) return value;
  if (value) store.delete(id);
  return null;
}

function saveEntry(store, id, value) {
  for (const [oldId, entry] of store) {
    if (entry.expiresAt <= Date.now()) store.delete(oldId);
  }
  if (store.size >= 2000) store.delete(store.keys().next().value);
  store.set(id, value);
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function redirect(res, target, cookies) {
  res.writeHead(303, { Location: target, 'Set-Cookie': cookies }).end();
}

function mediaType(file) {
  if (Number(file?.resType) !== 1 || typeof file.fileName !== 'string') return null;
  const ext = extname(file.fileName).toLowerCase();
  if (ext === '.lrc' || ext === '.vtt') return 'lyric';
  const mime = String(file.mineType ?? '').toLowerCase();
  return audioTypes.get(ext) || (/^audio\/[a-z0-9.+-]+$/.test(mime) ? mime : null);
}

function publicItem(file) {
  if (!isFileId(file?.fileId) || typeof file.fileName !== 'string' || !file.fileName) return null;
  const folder = Number(file.resType) === 2;
  const type = mediaType(file);
  if (!folder && !type) return null;
  const size = Number(file.fileSize);
  return {
    id: file.fileId, name: file.fileName, path: file.fileId, folder,
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
    streamUrl: type ? prefix + '/stream?id=' + encodeURIComponent(file.fileId) : null,
  };
}

async function readJSON(response) {
  try {
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Unsupported payload');
    return body;
  } catch {
    throw new GuangyaError(502, '光鸭云盘返回了无效的响应。');
  }
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* Upstream is already closed. */ }
}

function downloadAddress(value, previous) {
  const url = typeof value === 'string' && value ? address(value, previous) : null;
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
    !/(?:^|\.)(?:guangyapan|guangyacdn)\.com$/.test(url.hostname)) {
    throw new GuangyaError(502, '光鸭云盘返回了非受信的下载地址。');
  }
  return url;
}

function decodeLyrics(buffer) {
  if (buffer[0] === 255 && buffer[1] === 254) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer[0] === 254 && buffer[1] === 255) return new TextDecoder('utf-16be').decode(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(buffer);
  }
}

async function sendLyrics(req, res, upstream) {
  const contentType = (upstream.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const allowed = ['', 'text/plain', 'text/vtt', 'text/lrc', 'text/x-lrc', 'application/octet-stream', 'binary/octet-stream', 'application/x-subrip'];
  if (upstream.status !== 200 || !allowed.includes(contentType)) {
    await discard(upstream);
    throw new GuangyaError(502, '光鸭云盘未返回有效的歌词。');
  }
  if (Number(upstream.headers.get('content-length')) > lyricLimit) {
    await discard(upstream);
    throw new GuangyaError(413, '光鸭云盘歌词文件超过 1 MB。');
  }
  if (req.method === 'HEAD') {
    await discard(upstream);
    return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end();
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    size += chunk.byteLength;
    if (size > lyricLimit) throw new GuangyaError(413, '光鸭云盘歌词文件超过 1 MB。');
    chunks.push(chunk);
  }
  let content;
  try {
    content = decodeLyrics(Buffer.concat(chunks, size)).replace(/\r\n?/g, '\n');
  } catch {
    throw new GuangyaError(415, '不支持此光鸭云盘歌词编码。');
  }
  const normalized = Buffer.from(content, 'utf8');
  if (content.includes('\0')) throw new GuangyaError(415, '不支持此光鸭云盘歌词编码。');
  if (normalized.length > lyricLimit) throw new GuangyaError(413, '光鸭云盘歌词文件超过 1 MB。');
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': normalized.length }).end(normalized);
}

// The public client has no OAuth secret. Persistence requires a private 32-byte installation key.
export function createGuangyaHandler({ env = process.env, request = globalThis.fetch, sessionFile, sessionKey } = {}) {
  const clientId = env.GUANGYA_CLIENT_ID?.trim();
  const callback = redirectURI(env.GUANGYA_REDIRECT_URI?.trim());
  const configured = Boolean(clientId && callback);
  const secure = callback?.protocol === 'https:';
  const pending = new Map();
  const privateKey = sessionKey instanceof Uint8Array && sessionKey.byteLength === 32 ? sessionKey : null;
  const sessions = createOAuthSessionRegistry(
    configured && privateKey ? sessionFile : undefined, privateKey, JSON.stringify([prefix, clientId, callback?.href]),
  );
  const nextAllowed = new Map();

  function persistSessions(change) {
    try {
      if (change) sessions.commit(change);
      else sessions.persist();
    } catch {
      throw new GuangyaError(503, '无法保存光鸭云盘授权，请检查服务端数据目录。');
    }
  }

  function updateSessionToken(session, token) {
    session.token = token;
    persistSessions();
  }

  async function exchange(parameters, previousRefresh) {
    const response = await request(accountEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-client-id': clientId },
      body: JSON.stringify({ client_id: clientId, ...parameters }),
      redirect: 'error', signal: AbortSignal.timeout(12_000),
    });
    if (previousRefresh && [400, 401, 403].includes(response.status)) {
      await discard(response);
      throw new GuangyaError(401, '光鸭云盘授权已失效，请重新连接。');
    }
    const body = await readJSON(response);
    if (previousRefresh && (body.error === 'invalid_grant' || Number(body.code) === 117)) {
      throw new GuangyaError(401, '光鸭云盘授权已失效，请重新连接。');
    }
    const lifetime = Number(body.expires_in);
    if (!response.ok || typeof body.access_token !== 'string' || !body.access_token ||
      (body.token_type && String(body.token_type).toLowerCase() !== 'bearer') || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new GuangyaError(502, '光鸭云盘未返回有效的访问令牌。');
    }
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : previousRefresh,
      expiresAt: Date.now() + lifetime * 1000,
    };
  }

  async function getAccessToken(session, rejected) {
    const token = session.token;
    const remaining = (token?.expiresAt ?? 0) - Date.now();
    if (token && (rejected ? token.accessToken !== rejected && remaining > 0 : remaining > (token.refreshToken ? 30_000 : 0))) {
      return token.accessToken;
    }
    if (!token?.refreshToken) throw new GuangyaError(401, '光鸭云盘授权已失效，请重新连接。');
    if (!session.refreshing) {
      session.refreshing = exchange({ grant_type: 'refresh_token', refresh_token: token.refreshToken }, token.refreshToken)
        .then(next => {
          updateSessionToken(session, next);
          return next.accessToken;
        })
        .catch(error => {
          if (error.status === 401) updateSessionToken(session, null);
          throw error;
        })
        .finally(() => { session.refreshing = null; });
    }
    return session.refreshing;
  }

  async function pace(operation) {
    const now = performance.now();
    const next = Math.max(now, nextAllowed.get(operation) ?? now);
    if (next - now > 4000) throw new GuangyaError(429, '光鸭云盘请求过多，请稍后重试。');
    nextAllowed.set(operation, next + (operation === 'get_file_list' ? 225 : 550));
    if (next > now) await delay(next - now);
  }

  async function query(session, operation, parameters) {
    const url = new URL(api + operation);
    url.search = new URLSearchParams(parameters).toString();
    async function send(token) {
      await pace(operation);
      const response = await request(url, {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, 'x-client-id': clientId },
        redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        await discard(response);
        return { status: response.status };
      }
      return { status: response.status, body: await readJSON(response) };
    }
    const token = await getAccessToken(session);
    let result = await send(token);
    if (result.status === 401 || Number(result.body?.code) === 117) {
      result = await send(await getAccessToken(session, token));
    }
    const code = Number(result.body?.code);
    if (result.status === 200 && code === 0 && result.body.data && typeof result.body.data === 'object') return result.body.data;
    if (result.status === 401 || code === 117) {
      updateSessionToken(session, null);
      throw new GuangyaError(401, '光鸭云盘授权已失效，请重新连接。');
    }
    if (code === 430) throw new GuangyaError(403, '此光鸭云盘操作需要有效的云盘会员。');
    if (result.status === 403 || [111, 120, 123, 167].includes(code)) {
      throw new GuangyaError(403, '光鸭云盘拒绝访问，请检查应用及文件权限。');
    }
    if (result.status === 404 || [146, 149].includes(code)) throw new GuangyaError(404, '光鸭云盘文件或目录不存在。');
    if (result.status === 429) throw new GuangyaError(429, '光鸭云盘请求过多，请稍后重试。');
    throw new GuangyaError(502, '光鸭云盘暂时无法返回数据。');
  }

  async function list(session, path) {
    if (path !== '/' && !isFileId(path)) throw new GuangyaError(400, '无效的光鸭云盘目录标识。');
    const pageSize = 100;
    const items = new Map();
    const seenPages = new Set();
    let returned = 0;
    for (let page = 0; page < 1000; page++) {
      const data = await query(session, 'get_file_list', { page, pageSize, orderBy: 0, sortType: 0, ...(path === '/' ? {} : { parentId: path }) });
      if (!Array.isArray(data.list)) throw new GuangyaError(502, '光鸭云盘未返回目录。');
      if (!data.list.length) return [...items.values()];
      const firstId = data.list[0]?.fileId;
      if (!isFileId(firstId) || seenPages.has(firstId)) break;
      seenPages.add(firstId);
      for (const file of data.list) {
        const item = publicItem(file);
        if (item) items.set(item.id, item);
      }
      returned += data.list.length;
      const total = Number(data.total ?? NaN);
      if ((Number.isSafeInteger(total) && total >= 0 && returned >= total) ||
        ((!Number.isSafeInteger(total) || total < 0) && data.list.length < pageSize)) {
        return [...items.values()];
      }
    }
    throw new GuangyaError(502, '光鸭云盘未返回完整目录。');
  }

  function mediaMetadata(session, id) {
    session.media ??= new Map();
    const saved = session.media.get(id);
    if (saved && saved.expiresAt > Date.now()) return saved.value;
    const record = { expiresAt: Infinity };
    record.value = (async () => {
      const { fileInfo } = await query(session, 'get_file_detail', { fileId: id });
      const type = mediaType(fileInfo);
      if (fileInfo?.fileId !== id || !type) throw new GuangyaError(415, '此光鸭云盘文件不是可播放的音频或歌词。');
      if (type === 'lyric' && Number(fileInfo.fileSize) > lyricLimit) throw new GuangyaError(413, '光鸭云盘歌词文件超过 1 MB。');
      const signed = await query(session, 'get_res_download_url', { fileId: id });
      const link = downloadAddress(signed.signedURL);
      const lifetime = Number(signed.urlDuration);
      record.expiresAt = Date.now() + (Number.isFinite(lifetime) ? Math.max(0, Math.min(45_000, lifetime * 1000 - 5_000)) : 0);
      return { type, link };
    })().catch(error => { if (session.media.get(id) === record) session.media.delete(id); throw error; });
    if (session.media.size >= 128) session.media.delete(session.media.keys().next().value);
    session.media.set(id, record);
    return record.value;
  }

  async function openAudio(link, headers, signal) {
    let url = link;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      let response;
      try {
        response = await request(url, { headers, redirect: 'manual', signal: AbortSignal.any([signal, controller.signal]) });
      } finally {
        clearTimeout(timer);
      }
      if (!redirectStatuses.has(response.status)) return response;
      const location = response.headers.get('location');
      await discard(response);
      if (!location || redirects === 3) break;
      url = downloadAddress(location, url);
    }
    throw new GuangyaError(502, '光鸭云盘未返回有效的下载重定向。');
  }

  async function stream(req, res, session, id) {
    if (!isFileId(id)) throw new GuangyaError(400, '无效的光鸭云盘文件标识。');
    const range = req.headers.range;
    if (range && !rangeHeader.test(range)) throw new GuangyaError(416, '光鸭云盘音频范围无效。');
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once('close', close);
    try {
      const metadata = mediaMetadata(session, id);
      let media = await metadata;
      const download = ({ link, type }) => openAudio(link, {
        'Accept-Encoding': 'identity', ...(range && type !== 'lyric' ? { Range: range } : {}),
      }, controller.signal);
      let upstream = await download(media);
      if ([401, 403].includes(upstream.status)) {
        await discard(upstream);
        if (session.media.get(id)?.value === metadata) session.media.delete(id);
        media = await mediaMetadata(session, id);
        upstream = await download(media);
      }
      const encoding = upstream.headers.get('content-encoding');
      const contentRange = upstream.headers.get('content-range');
      const length = upstream.headers.get('content-length');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      if (upstream.status === 416 && media.type !== 'lyric') {
        await discard(upstream);
        if (/^bytes \*\/\d+$/.test(contentRange ?? '')) res.setHeader('Content-Range', contentRange);
        return res.writeHead(416).end();
      }
      if ((encoding && encoding !== 'identity') || ![200, 206].includes(upstream.status) || !upstream.body ||
        (upstream.status === 206 && !/^bytes \d+-\d+\/(?:\d+|\*)$/.test(contentRange ?? ''))) {
        await discard(upstream);
        throw new GuangyaError(502, '光鸭云盘未返回有效的媒体内容。');
      }
      if (media.type === 'lyric') return await sendLyrics(req, res, upstream);
      const contentType = upstream.headers.get('content-type') || '';
      if (/^(?:text\/|application\/(?:json|xml|xhtml))/i.test(contentType)) {
        await discard(upstream);
        throw new GuangyaError(502, '光鸭云盘未返回有效的音频数据。');
      }
      res.setHeader('Content-Type', media.type);
      if (upstream.status === 206 || /^bytes$/i.test(upstream.headers.get('accept-ranges') ?? '')) res.setHeader('Accept-Ranges', 'bytes');
      if (length && /^\d+$/.test(length)) res.setHeader('Content-Length', length);
      if (upstream.status === 206) res.setHeader('Content-Range', contentRange);
      res.writeHead(upstream.status);
      if (req.method === 'HEAD') {
        await discard(upstream);
        return res.end();
      }
      await pipeline(Readable.fromWeb(upstream.body), res);
    } finally {
      res.off('close', close);
    }
  }

  return async function guangyaHandler(req, res, url) {
    if (!url.pathname.startsWith(prefix + '/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const action = url.pathname.slice(prefix.length + 1);
    try {
      if (!Object.hasOwn(methods, action)) throw new GuangyaError(404, '光鸭云盘接口不存在。');
      if (!methods[action].includes(req.method)) {
        res.setHeader('Allow', methods[action].join(', '));
        throw new GuangyaError(405, '此接口不支持该请求方法。');
      }
      const sid = cookieValue(req, sessionCookie);
      const pendingId = cookieValue(req, pendingCookie);
      const session = currentEntry(sessions.entries, sid);
      if (action === 'status') {
        const token = session?.token;
        reply(res, 200, { configured, connected: Boolean(configured && token && (token.expiresAt > Date.now() || token.refreshToken)) });
      } else if (action === 'disconnect') {
        if ((req.headers.origin && req.headers.origin !== callback?.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new GuangyaError(403, '请在播放器中断开光鸭云盘。');
        }
        if (session) persistSessions(entries => entries.delete(sid));
        pending.delete(pendingId);
        res.setHeader('Set-Cookie', [cookie(sessionCookie, '', 0, secure), cookie(pendingCookie, '', 0, secure)]);
        reply(res, 200, { configured, connected: false });
      } else if (!configured) {
        throw new GuangyaError(503, '服务端尚未配置光鸭云盘应用。');
      } else if (action === 'connect') {
        if (req.headers.host !== callback.host) throw new GuangyaError(400, '请使用与光鸭云盘回调地址一致的播放器网址。');
        const id = key();
        const state = key();
        const verifier = key();
        pending.delete(pendingId);
        saveEntry(pending, id, { state, verifier, expiresAt: Date.now() + pendingLifetime * 1000 });
        const target = new URL(authEndpoint);
        target.search = new URLSearchParams({
          client_id: clientId, response_type: 'code', scope: 'user offline',
          code_challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
          code_challenge_method: 'S256', redirect_uri: callback.href, state,
        }).toString();
        redirect(res, target.href, [cookie(pendingCookie, id, pendingLifetime, secure)]);
      } else if (action === 'callback') {
        const authorization = currentEntry(pending, pendingId);
        const state = url.searchParams.get('state');
        const cookies = [cookie(pendingCookie, '', 0, secure)];
        let result = 'error';
        if (authorization && opaqueKey.test(state ?? '') && timingSafeEqual(Buffer.from(state), Buffer.from(authorization.state))) {
          pending.delete(pendingId);
          const code = url.searchParams.get('code');
          if (url.searchParams.get('error') === 'access_denied') {
            result = 'denied';
          } else if (!url.searchParams.has('error') && code && code.length < 4096) {
            try {
              const token = await exchange({
                grant_type: 'authorization_code', code, code_verifier: authorization.verifier, redirect_uri: callback.href,
              });
              const id = key();
              persistSessions(entries => {
                entries.delete(sid);
                saveEntry(entries, id, { token, expiresAt: Date.now() + sessionLifetime * 1000 });
              });
              cookies.push(cookie(sessionCookie, id, sessionLifetime, secure));
              result = 'connected';
            } catch { /* The UI receives only a generic error marker. */ }
          }
        }
        redirect(res, '/?guangya=' + result, cookies);
      } else if (!session?.token) {
        throw new GuangyaError(401, '请先连接光鸭云盘。');
      } else if (action === 'list') {
        reply(res, 200, { items: await list(session, url.searchParams.get('path') ?? '/') });
      } else {
        await stream(req, res, session, url.searchParams.get('id'));
      }
    } catch (error) {
      if (res.destroyed) return true;
      if (res.headersSent) res.destroy();
      else if (error instanceof GuangyaError) reply(res, error.status, { error: error.message });
      else reply(res, 502, { error: '暂时无法连接光鸭云盘。' });
    }
    return true;
  };
}
