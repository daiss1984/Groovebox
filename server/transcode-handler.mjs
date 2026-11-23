import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const pathname = '/api/transcode';

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function authorize(req, { requireOrigin = true } = {}) {
  const host = req.headers.host;
  const origin = (req.socket.encrypted ? 'https://' : 'http://') + host;
  const remote = req.socket.remoteAddress;
  if (!['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(remote) ||
      !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host || '') ||
      ((requireOrigin || req.headers.origin) && req.headers.origin !== origin) ||
      (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
    throw new RequestError(403, '兼容播放只能在运行 Groovebox 的本机页面发起。');
  }
}

export function createTranscodeHandler({ convert } = {}) {
  return async function handleTranscode(req, res, url) {
    if (url.pathname !== pathname && url.pathname !== pathname + '/status') return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (url.pathname === pathname + '/status' && req.method === 'GET') {
      try {
        authorize(req, { requireOrigin: false });
        const transcode = convert || (await import('./audio-transcode.mjs')).transcodeAudio;
        await transcode.check?.();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end('{"available":true}');
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 503;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ error: error?.status ? error.message : '服务端需要安装 FFmpeg 才能兼容播放。' }));
      }
      return true;
    }
    if (req.method !== 'POST' || url.pathname !== pathname) {
      res.writeHead(405, { Allow: 'POST' }).end();
      return true;
    }
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once('close', disconnected);
    let result;
    try {
      authorize(req);
      const mime = (req.headers['content-type'] || '').split(';')[0].toLowerCase();
      if (!/^(?:audio\/[a-z0-9.+-]{1,50}|application\/(?:ogg|octet-stream)|video\/(?:mp4|webm))$/.test(mime)) {
        throw new RequestError(415, '请选择音频文件进行兼容处理。');
      }
      const transcode = convert || (await import('./audio-transcode.mjs')).transcodeAudio;
      const format = url.searchParams.get('format') ?? 'mp3';
      if (!['mp3', 'flac'].includes(format)) throw new RequestError(400, '不支持所选的兼容播放格式。');
      result = await transcode(req.iterator({ destroyOnReturn: false }), { signal: controller.signal, format });
      if (!controller.signal.aborted) {
        res.writeHead(200, {
          'Content-Type': format === 'flac' ? 'audio/flac' : 'audio/mpeg',
          'Content-Length': result.size,
          'X-Content-Type-Options': 'nosniff',
        });
        await pipeline(createReadStream(result.path), res, { signal: controller.signal });
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        if (!req.complete) res.setHeader('Connection', 'close');
        const known = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
        res.writeHead(known ? error.status : 502, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ error: known ? error.message : '无法准备兼容音频。' }));
      } else if (!res.destroyed) res.destroy();
    } finally {
      res.off('close', disconnected);
      if (result) await Promise.resolve(result.dispose()).catch(() => {});
    }
    return true;
  };
}
