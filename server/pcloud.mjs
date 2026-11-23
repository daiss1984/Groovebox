import { randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createOAuthSessionRegistry } from './oauth-session-store.mjs';

const prefix = '/api/pcloud';
const authorizeEndpoint = 'https://my.pcloud.com/oauth2/authorize';
const us = 'api.pcloud.com';
const eu = 'eapi.pcloud.com';
const pendingCookie = 'groovebox_pcloud_pending';
const sessionCookie = 'groovebox_pcloud';
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

class PcloudError extends Error {
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

function apiHost(params) {
  const location = params.get('locationid');
  const host = params.get('hostname');
  const byLocation = location === '1' ? us : location === '2' ? eu : null;
  if ((location && !byLocation) || (host && host !== us && host !== eu) ||
      (byLocation && host && byLocation !== host)) return null;
  return byLocation || host || null;
}

function fileId(value) {
  const text = String(value ?? '');
  return /^(?:0|[1-9]\d{0,19})$/.test(text) && BigInt(text) <= 18446744073709551615n ? text : '';
}

function mediaType(file) {
  if (!file || file.isfolder || typeof file.name !== 'string') return null;
  const ext = posix.extname(file.name).toLowerCase();
  if (ext === '.lrc' || ext === '.vtt') return 'lyrics';
  const declared = String(file.contenttype || '').toLowerCase();
  return audioTypes.get(ext) || (/^audio\/[a-z0-9.+-]+$/.test(declared) ? declared : null);
}

function publicItem(file) {
  if (!file || typeof file.name !== 'string' || file.canread === false) return null;
  const folder = Boolean(file.isfolder);
  const prefixedId = typeof file.id === 'string' ? file.id.slice(1) : '';
  const id = fileId((folder ? file.folderid : file.fileid) ?? prefixedId);
  if (!id) return null;
  return {
    id: (folder ? 'd' : 'f') + id,
    name: file.name,
    path: folder ? id : file.path || id,
    folder,
    size: Number(file.size) || 0,
    streamUrl: mediaType(file) ? prefix + '/stream?id=' + id : null,
  };
}

function downloadURL(value, base) {
  let url;
  try {
    if (!value) throw new Error();
    url = new URL(value, base);
  } catch {
    throw new PcloudError(502, 'pCloud 返回了无效下载地址。');
  }
  if (!url.hostname.endsWith('.pcloud.com') || url.hostname === us || url.hostname === eu ||
      url.hostname === 'my.pcloud.com' || url.protocol !== 'https:' || url.port ||
      url.username || url.password || url.hash) {
    throw new PcloudError(502, 'pCloud 返回了无效下载地址。');
  }
  return url;
}

function fileLink(data) {
  if (!Array.isArray(data.hosts) || typeof data.path !== 'string' ||
      !/^\/(?![/\\])/.test(data.path) || /[\x00-\x20\x7f]/.test(data.path)) {
    throw new PcloudError(502, 'pCloud 返回了无效下载地址。');
  }
  for (const host of data.hosts) {
    if (typeof host !== 'string' || !/^[a-z\d.-]+$/i.test(host)) continue;
    try {
      return downloadURL('https://' + host + data.path);
    } catch {
      // Try the next advertised host.
    }
  }
  throw new PcloudError(502, 'pCloud 返回了无效下载地址。');
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

function durablePcloudSession(entry, now) {
  if (!Number.isFinite(entry?.expiresAt) || entry.expiresAt <= now ||
      (entry.host !== us && entry.host !== eu) || typeof entry.token !== 'string' || !entry.token) return null;
  return { host: entry.host, token: entry.token, expiresAt: entry.expiresAt };
}

// A sessionFile enables encrypted sessions scoped to this OAuth app and callback.
export function createPcloudHandler({ env = process.env, request = globalThis.fetch, sessionFile } = {}) {
  const clientId = env.PCLOUD_CLIENT_ID?.trim();
  const clientSecret = env.PCLOUD_CLIENT_SECRET?.trim();
  const redirectUri = env.PCLOUD_REDIRECT_URI?.trim();
  const callback = callbackURL(redirectUri);
  const configured = Boolean(clientId && clientSecret && callback);
  const secure = callback?.protocol === 'https:';
  const pending = new Map();
  const sessions = createOAuthSessionRegistry(
    configured ? sessionFile : undefined, clientSecret, JSON.stringify([prefix, clientId, callback?.href]),
    durablePcloudSession,
  );

  function persistSessions(change) {
    try {
      if (change) sessions.commit(change);
      else sessions.persist();
    } catch {
      throw new PcloudError(503, '无法保存 pCloud 授权，请检查服务端数据目录。');
    }
  }

  async function api(session, method, params, { form, signal } = {}) {
    const url = new URL('https://' + session.host + '/' + method);
    // pCloud can retain authentication for the lifetime of a keep-alive connection.
    const headers = { Accept: 'application/json', Connection: 'close' };
    if (session.token) headers.Authorization = 'Bearer ' + session.token;
    const values = new URLSearchParams(params);
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    else url.search = values.toString();
    const timeout = AbortSignal.timeout(15_000);
    const reply = await request(url, {
      method: form ? 'POST' : 'GET', headers, body: form ? values : undefined,
      redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const raw = await reply.text();
    const data = JSON.parse(raw, (key, value, context) => {
      if ((key === 'fileid' || key === 'folderid') && typeof value === 'number') return context.source;
      return value;
    });
    const result = Number(data?.result);
    if (reply.ok && result === 0) return data;
    if (reply.status === 401 || result === 1000 || result === 2000) {
      if (session.token) {
        session.token = null;
        persistSessions();
      }
      throw new PcloudError(401, 'pCloud 授权已失效，请重新连接。');
    }
    if (reply.status === 403 || result === 2003) throw new PcloudError(403, 'pCloud 拒绝访问。');
    if (reply.status === 404 || [2002, 2005, 2009].includes(result)) {
      throw new PcloudError(404, 'pCloud 文件或目录不存在。');
    }
    if (reply.status === 429 || result === 4000) throw new PcloudError(429, 'pCloud 请求过于频繁，请稍后重试。');
    throw new PcloudError(502, 'pCloud 暂时无法响应。');
  }

  async function list(session, path) {
    const folderid = fileId(path === '/' ? '0' : path);
    if (!folderid) throw new PcloudError(400, 'pCloud 文件夹标识无效。');
    const listing = await api(session, 'listfolder', { folderid });
    if (!Array.isArray(listing.metadata?.contents)) throw new PcloudError(502, 'pCloud 未返回目录。');
    return listing.metadata.contents.map(publicItem).filter(Boolean);
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
    throw new PcloudError(502, 'pCloud 未返回下载数据。');
  }

  async function serveLyrics(url, req, res, controller) {
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const upstream = await download(url, 'GET', null, controller);
      if (upstream.status !== 200 || !upstream.body) {
        await discard(upstream);
        throw new PcloudError(502, 'pCloud 未返回歌词数据。');
      }
      if (Number(upstream.headers.get('content-length')) > lyricsLimit) {
        await discard(upstream);
        throw new PcloudError(413, 'pCloud 歌词文件超过 1 MB。');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.byteLength;
        if (size > lyricsLimit) throw new PcloudError(413, 'pCloud 歌词文件超过 1 MB。');
        chunks.push(chunk);
      }
      let lyrics;
      try {
        lyrics = decodeLyrics(Buffer.concat(chunks, size)).replace(/\r\n?/g, '\n');
      } catch {
        throw new PcloudError(415, '不支持此 pCloud 歌词文件编码。');
      }
      if (lyrics.includes('\0')) throw new PcloudError(415, '不支持此 pCloud 歌词文件编码。');
      const body = Buffer.from(lyrics, 'utf8');
      if (body.byteLength > lyricsLimit) throw new PcloudError(413, 'pCloud 歌词文件超过 1 MB。');
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
    if (!fileid || fileid === '0') throw new PcloudError(400, 'pCloud 文件标识无效。');
    const range = req.headers.range;
    if (range && !byteRange.test(range)) throw new PcloudError(416, '音频范围无效。');
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const options = { signal: controller.signal };
      const { metadata } = await api(session, 'stat', { fileid }, options);
      const type = mediaType(metadata);
      if (!type) throw new PcloudError(415, '请选择支持的 pCloud 音频或歌词文件。');
      if (type === 'lyrics' && Number(metadata.size) > lyricsLimit) {
        throw new PcloudError(413, 'pCloud 歌词文件超过 1 MB。');
      }
      const url = fileLink(await api(session, 'getfilelink', { fileid, forcedownload: '1' }, options));
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
        throw new PcloudError(502, 'pCloud 未返回有效的音频数据。');
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

  return async function pcloudHandler(req, res, url) {
    if (!url.pathname.startsWith(prefix + '/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      const action = url.pathname.slice(prefix.length + 1);
      const allowed = methods.get(action);
      if (!allowed) throw new PcloudError(404, 'pCloud 接口不存在。');
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        throw new PcloudError(405, '此接口不支持该请求方法。');
      }
      const sessionId = cookieValue(req, sessionCookie);
      const oauthId = cookieValue(req, pendingCookie);
      const session = lookup(sessions.entries, sessionId);
      if (action === 'status') {
        sendJson(res, 200, { configured, connected: Boolean(configured && session?.token) });
      } else if (action === 'disconnect') {
        const origin = req.headers.origin;
        if ((origin && origin !== callback?.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new PcloudError(403, '请在播放器中断开 pCloud。');
        }
        if (session) persistSessions(entries => entries.delete(sessionId));
        pending.delete(oauthId);
        res.setHeader('Set-Cookie', [cookie(sessionCookie, '', 0, secure), cookie(pendingCookie, '', 0, secure)]);
        sendJson(res, 200, { configured, connected: false });
      } else if (!configured) {
        throw new PcloudError(503, '服务器尚未配置 pCloud 应用。');
      } else if (action === 'connect') {
        if (req.headers.host !== callback.host) throw new PcloudError(400, '请使用与 pCloud 回调地址一致的播放器网址。');
        const id = randomKey();
        const state = randomKey();
        pending.delete(oauthId);
        remember(pending, id, { state, expiresAt: Date.now() + pendingLifetime * 1000 });
        const authorize = new URL(authorizeEndpoint);
        authorize.search = new URLSearchParams({
          response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state,
        }).toString();
        redirect(res, authorize.href, [cookie(pendingCookie, id, pendingLifetime, secure)]);
      } else if (action === 'callback') {
        const authorization = lookup(pending, oauthId);
        const state = url.searchParams.get('state') ?? '';
        if (!authorization || !opaqueKey.test(state) ||
            !timingSafeEqual(Buffer.from(state), Buffer.from(authorization.state))) {
          throw new PcloudError(400, 'pCloud 授权已过期或回调不匹配，请重新连接。');
        }
        pending.delete(oauthId);
        const cookies = [cookie(pendingCookie, '', 0, secure)];
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const host = apiHost(url.searchParams);
        let result = error === 'access_denied' ? 'denied' : 'error';
        if (!error && host && code && code.length <= 4096) {
          try {
            const data = await api({ host }, 'oauth2_token', { client_id: clientId, client_secret: clientSecret, code }, { form: true });
            if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Missing pCloud access token');
            const id = randomKey();
            persistSessions(entries => {
              entries.delete(sessionId);
              remember(entries, id, { host, token: data.access_token, expiresAt: Date.now() + sessionLifetime * 1000 });
            });
            cookies.push(cookie(sessionCookie, id, sessionLifetime, secure));
            result = 'connected';
          } catch {
            // The browser receives a generic failure marker.
          }
        }
        redirect(res, '/?pcloud=' + result, cookies);
      } else if (!session?.token) {
        throw new PcloudError(401, '请先连接 pCloud。');
      } else if (action === 'list') {
        sendJson(res, 200, { items: await list(session, url.searchParams.get('path') ?? '/') });
      } else {
        await stream(req, res, session, url.searchParams.get('id'));
      }
    } catch (error) {
      if (res.destroyed) return true;
      if (res.headersSent) res.destroy();
      else if (error instanceof PcloudError) sendJson(res, error.status, { error: error.message });
      else sendJson(res, 502, { error: '无法连接 pCloud，请稍后重试。' });
    }
    return true;
  };
}
