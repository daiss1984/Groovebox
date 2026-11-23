import { randomUUID } from 'node:crypto';

const prefix = '/api/listenbrainz/';
const upstream = 'https://api.listenbrainz.org/1/';
const cookieName = 'groovebox_listenbrainz';
const lifetime = 7 * 24 * 60 * 60;
const maxSessions = 128;
const maxRequest = 4096;
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

class ListenBrainzError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateBrowser(req, mutate) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  const secure = Boolean(req.socket.encrypted);
  const local = loopback.has(req.socket.remoteAddress) && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host || '');
  if (!(local || secure) || (mutate && origin !== (secure ? 'https://' : 'http://') + host) ||
    (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
    throw new ListenBrainzError(403, 'ListenBrainz 仅可从当前播放器安全连接。');
  }
}

function cookie(res, req, value = '', seconds = 0) {
  res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=${seconds}` +
    (req.socket.encrypted ? '; Secure' : ''));
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function jsonFrom(stream, limit, invalid) {
  const chunks = [];
  let length = 0;
  if (!stream) throw invalid;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw invalid;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid; }
}

function requestJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new ListenBrainzError(415, '请使用 JSON 提交 ListenBrainz 设置。');
  }
  return jsonFrom(req.iterator({ destroyOnReturn: false }), maxRequest, new ListenBrainzError(400, 'ListenBrainz 请求格式不正确。'));
}

function metadataText(value) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 300) : '';
}

async function provider(fetchImpl, path, token, data) {
  const unavailable = new ListenBrainzError(502, 'ListenBrainz 暂时无法连接。');
  try {
    const response = await fetchImpl(upstream + path, {
      method: data ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(6000),
      headers: { Authorization: 'Token ' + token, Accept: 'application/json', ...(data && { 'Content-Type': 'application/json' }) },
      ...(data && { body: JSON.stringify(data) }),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ListenBrainzError(401, 'ListenBrainz 令牌无效或已失效。');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable;
    }
    if (data) {
      await response.body?.cancel();
      return;
    }
    return await jsonFrom(response.body, 4096, unavailable);
  } catch (error) {
    if (error instanceof ListenBrainzError) throw error;
    throw unavailable;
  }
}

export function createListenBrainzHandler({ fetchImpl = fetch, clock = Date.now } = {}) {
  const sessions = new Map();
  return async function handleListenBrainz(req, res, url) {
    if (!url.pathname.startsWith(prefix)) return false;
    try {
      const action = url.pathname.slice(prefix.length);
      validateBrowser(req, req.method !== 'GET');
      if (url.search) throw new ListenBrainzError(400, 'ListenBrainz 请求格式不正确。');
      const now = clock();
      for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
      const id = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      const session = sessions.get(id);
      if (req.method === 'GET' && action === 'status') {
        reply(res, 200, { account: session?.account ?? null });
      } else if (req.method === 'POST' && action === 'connect') {
        const input = (await requestJson(req))?.token;
        const token = typeof input === 'string' ? input.trim() : '';
        if (!/^[a-z\d-]{20,128}$/i.test(token)) {
          throw new ListenBrainzError(400, '请输入有效的 ListenBrainz 用户令牌。');
        }
        const validated = await provider(fetchImpl, 'validate-token', token);
        const account = metadataText(validated?.user_name);
        if (validated?.valid !== true || !account) throw new ListenBrainzError(401, 'ListenBrainz 令牌无效或已失效。');
        if (!sessions.has(id) && sessions.size >= maxSessions) throw new ListenBrainzError(503, 'ListenBrainz 连接数量已满。');
        const nextId = randomUUID();
        sessions.delete(id);
        sessions.set(nextId, { account, token, expires: now + lifetime * 1000, accepted: new Map(), pending: 0 });
        cookie(res, req, nextId, lifetime);
        reply(res, 200, { account });
      } else if (req.method === 'DELETE' && action === 'disconnect') {
        sessions.delete(id);
        cookie(res, req);
        reply(res, 200, { account: null });
      } else if (req.method === 'POST' && action === 'listen') {
        if (!session) throw new ListenBrainzError(401, '请先连接 ListenBrainz。');
        const input = await requestJson(req);
        const listenId = input?.id;
        const title = metadataText(input?.title);
        const artist = metadataText(input?.artist);
        const album = metadataText(input?.album);
        const listenedAt = input?.listenedAt;
        const nowSeconds = Math.floor(now / 1000);
        if (typeof listenId !== 'string' || !uuid.test(listenId) || !title || !artist ||
          !Number.isSafeInteger(listenedAt) || listenedAt > nowSeconds + 60 || listenedAt < nowSeconds - 86400) {
          throw new ListenBrainzError(400, '收听记录缺少有效的歌曲信息或时间。');
        }
        if (sessions.get(id) !== session) throw new ListenBrainzError(401, '请先连接 ListenBrainz。');
        if (!session.accepted.has(listenId)) {
          if (session.pending >= 4) throw new ListenBrainzError(429, 'ListenBrainz 请求过多，请稍后重试。');
          session.pending++;
          session.accepted.set(listenId, false);
          try {
            await provider(fetchImpl, 'submit-listens', session.token, { listen_type: 'single', payload: [{
              listened_at: listenedAt,
              track_metadata: { artist_name: artist, track_name: title, ...(album && { release_name: album }),
                additional_info: { submission_client: 'Groovebox' } },
            }] });
          } catch (error) {
            session.accepted.delete(listenId);
            if (error.status === 401 && sessions.delete(id)) cookie(res, req);
            throw error;
          } finally {
            session.pending--;
          }
          session.accepted.set(listenId, true);
          if (session.accepted.size > 512) {
            const acceptedId = [...session.accepted].find(([, accepted]) => accepted)?.[0];
            session.accepted.delete(acceptedId);
          }
        } else if (!session.accepted.get(listenId)) {
          throw new ListenBrainzError(409, 'ListenBrainz 正在处理此收听记录。');
        }
        reply(res, 200, { submitted: true });
      } else {
        throw new ListenBrainzError(405, '不支持此 ListenBrainz 操作。');
      }
    } catch (error) {
      const serverError = error instanceof ListenBrainzError ? error : new ListenBrainzError(502, 'ListenBrainz 暂时无法连接。');
      reply(res, serverError.status, { error: serverError.message });
    }
    return true;
  };
}
