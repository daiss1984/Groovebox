import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { controlDlna, discoverDlnaRenderers } from './dlna.mjs';

const prefix = '/api/cast';
const maxUpload = 60 * 1024 * 1024;
const sessionDuration = 60 * 60 * 1000;
const maxSessions = 24;
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

class CastError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function validateClient(req) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (!loopback.has(req.socket.remoteAddress) || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host || '') ||
    (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) ||
    (origin && origin !== ('http://' + host) && origin !== ('https://' + host))) {
    throw new CastError(403, '局域网投屏仅可在本机播放器操作。');
  }
}

function rangeOf(header, size) {
  if (!header) return { start: 0, end: size - 1 };
  const parsed = /^bytes=(\d{0,12})-(\d{0,12})$/.exec(header);
  if (!parsed || (!parsed[1] && !Number(parsed[2]))) return null;
  const start = parsed[1] ? Number(parsed[1]) : Math.max(0, size - Number(parsed[2]));
  const end = parsed[1] && parsed[2] ? Math.min(size - 1, Number(parsed[2])) : size - 1;
  return start <= end ? { start, end } : null;
}

async function receiveMedia(req, file) {
  let size = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxUpload) return callback(new CastError(413, '单首投屏音频上限为 60 MB。'));
      callback(null, chunk);
    },
  });
  // Keep the request socket available for a JSON error if the transform rejects the body.
  await pipeline(req.iterator({ destroyOnReturn: false }), limit, createWriteStream(file, { mode: 0o600 }), {
    signal: AbortSignal.timeout(120000),
  });
  if (!size) throw new CastError(400, '投屏音频为空。');
  return size;
}

async function serveLanMedia(renderer, file, size, mime) {
  const route = '/audio/' + randomBytes(24).toString('base64url');
  const server = createServer(async (req, res) => {
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/i, '');
    if (peer !== renderer.address || req.url !== route) return res.writeHead(404).end();
    if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    const range = rangeOf(req.headers.range, size);
    if (!range) return res.writeHead(416, { 'Content-Range': 'bytes */' + size }).end();
    const { start, end } = range;
    const headers = {
      'Accept-Ranges': 'bytes', 'Content-Type': mime, 'Content-Length': end - start + 1,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    };
    if (req.headers.range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    res.writeHead(req.headers.range ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    try { await pipeline(createReadStream(file, { start, end }), res); }
    catch { if (!res.destroyed) res.destroy(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, renderer.localAddress, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();
  return {
    uri: new URL('http://' + renderer.localAddress + ':' + server.address().port + route).href,
    close() { server.close(); server.closeAllConnections(); },
  };
}

async function dispose(track) {
  if (!track) return;
  clearTimeout(track.timer);
  track.bridge?.close();
  if (track.directory) await rm(track.directory, { recursive: true, force: true });
}

export function createCastHandler({ discover = discoverDlnaRenderers, control = controlDlna } = {}) {
  const sessions = new Map();
  const rendererOwners = new Map();
  function unlock(track, session) {
    if (track && rendererOwners.get(track.renderer.id) === session) rendererOwners.delete(track.renderer.id);
  }
  let pendingDiscoveries = 0;

  return async function castHandler(req, res, url) {
    if (!url.pathname.startsWith(prefix + '/')) return false;
    try {
      validateClient(req);
      const action = url.pathname.slice(prefix.length + 1);
      const cookie = req.headers.cookie?.match(/(?:^|;\s*)groovebox_cast=([\w-]{43})(?:;|$)/)?.[1];
      let session = sessions.get(cookie);
      if (action === 'devices' && req.method === 'GET') {
        for (const [id, previous] of sessions) {
          if (!previous.busy && previous.expires <= Date.now()) {
            sessions.delete(id);
            unlock(previous.active, previous);
            await dispose(previous.active);
          }
        }
        if (pendingDiscoveries >= 3) throw new CastError(429, '已有设备搜索正在进行，请稍后重试。');
        pendingDiscoveries++;
        let discovered;
        try { discovered = await discover({ signal: AbortSignal.timeout(6500) }); }
        finally { pendingDiscoveries--; }
        if (!session || !sessions.has(cookie)) {
          if (sessions.size >= maxSessions) throw new CastError(503, '投屏会话已满，请稍后再试。');
          const id = randomBytes(32).toString('base64url');
          session = { active: null, busy: false };
          sessions.set(id, session);
          res.setHeader('Set-Cookie', 'groovebox_cast=' + id + '; HttpOnly; SameSite=Strict; Path=' + prefix +
            (req.socket.encrypted ? '; Secure' : ''));
        }
        session.expires = Date.now() + sessionDuration;
        session.renderers = new Map(discovered.map(renderer => [renderer.id, renderer]));
        json(res, 200, { devices: discovered.map(({ id, name }) => ({ id, name })) });
        return true;
      }

      if (action === 'position' && req.method === 'GET') {
        if (!session?.active) throw new CastError(404, '当前没有局域网投屏。');
        const renderer = session.active.renderer;
        const signal = AbortSignal.timeout(4000);
        const [position, transport] = await Promise.all([
          control(renderer, 'getPosition', {}, { signal }),
          control(renderer, 'getTransport', {}, { signal }),
        ]);
        json(res, 200, { position: position?.position, duration: position?.duration, state: transport?.state });
        return true;
      }

      if (req.method !== 'POST' || !['start', 'play', 'pause', 'stop', 'seek'].includes(action)) {
        throw new CastError(405, '此投屏操作不受支持。');
      }
      if (!session || session.expires <= Date.now()) throw new CastError(404, '请先搜索局域网投屏设备。');
      if (session.busy) throw new CastError(409, '投屏设备正在处理上一项操作。');
      session.busy = true;
      try {
        if (action === 'start') {
          const renderer = session.renderers.get(url.searchParams.get('device'));
          if (!renderer) throw new CastError(404, '请先从列表选择可用的投屏设备。');
          const declaredMime = (req.headers['content-type'] || '').split(';')[0].toLowerCase();
          const mime = declaredMime === 'application/ogg' ? 'audio/ogg' : declaredMime;
          if (!/^(?:audio\/[a-z0-9.+-]{1,50}|application\/ogg)$/i.test(mime)) {
            throw new CastError(415, '投屏需要可识别的音频格式。');
          }
          if (Number(req.headers['content-length']) > maxUpload) throw new CastError(413, '单首投屏音频上限为 60 MB。');
          const owner = rendererOwners.get(renderer.id);
          if (owner && owner !== session) throw new CastError(409, '此设备正在另一个 Groovebox 会话播放。');
          rendererOwners.set(renderer.id, session);
          const next = { renderer };
          try {
            next.directory = await mkdtemp(join(tmpdir(), 'groovebox-cast-'));
            const file = join(next.directory, 'audio');
            const size = await receiveMedia(req, file);
            next.bridge = await serveLanMedia(renderer, file, size, mime);
            const text = key => (url.searchParams.get(key) || '').slice(0, 200);
            const metadata = { uri: next.bridge.uri, title: text('title'), artist: text('artist'), album: text('album'), mime };
            await control(renderer, 'setUri', metadata, { signal: AbortSignal.timeout(5000) });
            await control(renderer, 'play', {}, { signal: AbortSignal.timeout(5000) });
            const seconds = Number(url.searchParams.get('seconds'));
            if (seconds > 1 && seconds <= 86400) {
              await control(renderer, 'seek', { seconds }, { signal: AbortSignal.timeout(3000) }).catch(() => {});
            }
          } catch (error) {
            if (session.active?.renderer.id !== renderer.id) unlock(next, session);
            await dispose(next);
            throw error;
          }
          const previous = session.active;
          session.active = next;
          if (previous && previous.renderer.id !== renderer.id) {
            await control(previous.renderer, 'stop', {}, { signal: AbortSignal.timeout(4000) }).catch(() => {});
          }
          if (previous?.renderer.id !== renderer.id) unlock(previous, session);
          await dispose(previous);
          next.timer = setTimeout(() => {
            if (session.active === next) {
              session.active = null;
              unlock(next, session);
            }
            void dispose(next).catch(() => {});
          }, sessionDuration);
          next.timer.unref();
        } else {
          const active = session.active;
          if (!active) throw new CastError(404, '当前没有局域网投屏。');
          const seconds = Number(url.searchParams.get('seconds'));
          if (action === 'seek' && (!url.searchParams.has('seconds') || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400)) {
            throw new CastError(400, '无效的投屏定位时间。');
          }
          try { await control(active.renderer, action, action === 'seek' ? { seconds } : {}, { signal: AbortSignal.timeout(5000) }); }
          finally {
            if (action === 'stop') {
              session.active = null;
              unlock(active, session);
              await dispose(active);
            }
          }
        }
        session.expires = Date.now() + sessionDuration;
        json(res, 200, { active: Boolean(session.active) });
      } finally { session.busy = false; }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const status = Number.isInteger(error?.status) ? error.status : 502;
        json(res, status, { error: Number.isInteger(error?.status) ? error.message : '局域网投屏失败。' });
      } else if (!res.destroyed) res.destroy();
    }
    return true;
  };
}
