import { randomBytes, randomUUID } from 'node:crypto';

const prefix = '/api/sources/plex-auth';
const cookieName = 'groovebox_plex_auth';
const lifetime = 600;
const product = 'Groovebox';
const cookiePattern = /(?:^|;\s*)groovebox_plex_auth=([\w-]{43})(?:;|$)/;
const tokenValid = value => typeof value === 'string' && /^[a-z\d._~-]{1,4096}$/i.test(value);

export class PlexAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function ticketCookie(req, ticket, seconds) {
  return cookieName + '=' + ticket + '; Path=' + prefix + '; Max-Age=' + seconds + '; HttpOnly; SameSite=Lax' +
    (req.socket.encrypted ? '; Secure' : '');
}

export function createPlexAuthorization({ fetchImpl, bodyText, parseBase }) {
  const attempts = new Map();
  const ticketFor = req => cookiePattern.exec(req.headers.cookie || '')?.[1];
  function forget(ticket) {
    clearTimeout(attempts.get(ticket)?.timer);
    attempts.delete(ticket);
  }
  function attemptFor(req) {
    const ticket = ticketFor(req);
    const attempt = attempts.get(ticket);
    if (!attempt || attempt.expires <= Date.now()) {
      forget(ticket);
      throw new PlexAuthError(410, 'Plex 授权已过期，请重新登录');
    }
    return attempt;
  }

  async function plexJson(endpoint, clientId, { method = 'GET', token } = {}) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json', 'X-Plex-Product': product, 'X-Plex-Client-Identifier': clientId,
          ...(token && { 'X-Plex-Token': token }) },
      });
    } catch { throw new PlexAuthError(502, '无法访问 Plex 授权服务'); }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403, 404].includes(response.status)) throw new PlexAuthError(401, 'Plex 授权未完成或已失效，请重新登录');
      throw new PlexAuthError(502, 'Plex 授权服务暂时不可用');
    }
    try { return JSON.parse(await bodyText(response.body, 1024 * 1024)); }
    catch { throw new PlexAuthError(502, 'Plex 授权服务返回无效数据'); }
  }

  async function start(req, res, input, origin) {
    const preferred = typeof input.url === 'string' && input.url.trim() ? parseBase(input.url.trim(), 'plex').href : '';
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : '';
    for (const [id, attempt] of attempts) if (attempt.expires <= Date.now()) forget(id);
    const previous = ticketFor(req);
    if (previous) forget(previous);
    if (attempts.size >= 128) throw new PlexAuthError(503, 'Plex 授权会话已满，请稍后再试');
    const ticket = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const clientId = randomUUID();
    const attempt = { state, name, preferred, clientId, expires: Date.now() + lifetime * 1000 };
    attempts.set(ticket, attempt);
    try {
      const pin = await plexJson('https://plex.tv/api/v2/pins?strong=true', clientId, { method: 'POST' });
      const pinId = typeof pin?.id === 'string' || Number.isSafeInteger(pin?.id) ? String(pin.id) : '';
      if (!/^[1-9]\d{0,19}$/.test(pinId) || typeof pin?.code !== 'string' || !/^[a-z\d]{4,128}$/i.test(pin.code)) {
        throw new PlexAuthError(502, 'Plex 未返回有效授权码');
      }
      const seconds = Number.isFinite(pin.expiresIn) ? Math.min(lifetime, Math.floor(pin.expiresIn)) : lifetime;
      if (seconds < 1) throw new PlexAuthError(502, 'Plex 授权码已经过期');
      attempt.pinId = pinId;
      attempt.expires = Date.now() + seconds * 1000;
      attempt.timer = setTimeout(() => forget(ticket), seconds * 1000);
      attempt.timer.unref();
      const forwardUrl = origin + prefix + '/return?' + new URLSearchParams({ state });
      const params = new URLSearchParams({ clientID: clientId, code: pin.code, forwardUrl, 'context[device][product]': product });
      res.setHeader('Set-Cookie', ticketCookie(req, ticket, seconds));
      return { authUrl: 'https://app.plex.tv/auth#?' + params };
    } catch (error) {
      forget(ticket);
      throw error;
    }
  }

  function returned(req, url) {
    const attempt = attemptFor(req);
    if (!attempt.pinId || url.searchParams.get('state') !== attempt.state) {
      throw new PlexAuthError(403, 'Plex 授权回调无效，请重新登录');
    }
    attempt.returned = true;
  }

  async function choices(req) {
    const attempt = attemptFor(req);
    if (!attempt.returned) throw new PlexAuthError(403, '请先在 Plex 完成授权');
    if (attempt.pending) throw new PlexAuthError(409, '正在读取 Plex 服务器信息');
    if (!attempt.connections) {
      attempt.pending = true;
      try {
        const pin = await plexJson('https://plex.tv/api/v2/pins/' + attempt.pinId, attempt.clientId);
        if (!tokenValid(pin?.authToken)) throw new PlexAuthError(401, 'Plex 授权未完成，请重新登录');
        const resources = await plexJson('https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1',
          attempt.clientId, { token: pin.authToken });
        if (!Array.isArray(resources)) throw new PlexAuthError(502, 'Plex 未返回可用的服务器列表');
        const connections = new Map();
        for (const resource of resources.slice(0, 32)) {
          if (typeof resource?.provides !== 'string' || !resource.provides.split(',').includes('server') || !tokenValid(resource.accessToken)
            || !Array.isArray(resource.connections)) continue;
          for (const item of resource.connections.slice(0, 16)) {
            try {
              if (typeof item?.uri !== 'string' || item.uri.length > 2048) continue;
              const url = parseBase(item.uri, 'plex').href;
              const name = typeof resource.name === 'string' ? resource.name.trim().slice(0, 100) : '';
              connections.set(randomUUID(), { url, name, token: resource.accessToken, preferred: url === attempt.preferred });
            } catch { /* Ignore malformed advertised connections. */ }
          }
        }
        attempt.connections = connections;
      } finally { attempt.pending = false; }
    }
    return [...attempt.connections].map(([id, { name, url, preferred }]) => ({ id, name, url, preferred }))
      .sort((a, b) => Number(b.preferred) - Number(a.preferred));
  }

  async function connect(req, res, choice, addSource) {
    const ticket = ticketFor(req);
    const attempt = attemptFor(req);
    const server = attempt.connections?.get(choice);
    if (!server) throw new PlexAuthError(404, '找不到该 Plex 服务器');
    if (attempt.pending) throw new PlexAuthError(409, '正在连接 Plex 服务器');
    attempt.pending = true;
    try {
      const source = await addSource({ type: 'plex', url: server.url, token: server.token, name: attempt.name || server.name }, attempt.clientId);
      forget(ticket);
      res.appendHeader('Set-Cookie', ticketCookie(req, '', 0));
      return source;
    } finally { attempt.pending = false; }
  }

  return { start, returned, choices, connect };
}
