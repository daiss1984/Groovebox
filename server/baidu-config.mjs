import { createBaiduHandler } from './baidu.mjs';
import { readLocalSettings, writeLocalSettings } from './local-settings.mjs';

const settingsPath = '/api/baidu/config';
const callbackPath = '/api/baidu/callback';
const localHosts = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

class SetupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  }).end(JSON.stringify(data));
}

function checkLocal(req) {
  if (!loopback.has(req.socket.remoteAddress) || !localHosts.test(req.headers.host || '')) {
    throw new SetupError(403, '百度应用配置只能在运行 Groovebox 的电脑上打开。');
  }
  const origin = (req.socket.encrypted ? 'https://' : 'http://') + req.headers.host;
  const fetchSite = req.headers['sec-fetch-site'];
  if ((req.headers.origin && req.headers.origin !== origin) ||
      (fetchSite && !['same-origin', 'none'].includes(fetchSite)) ||
      (req.method === 'POST' && req.headers.origin !== origin)) {
    throw new SetupError(403, '请在同一播放器页面保存配置。');
  }
  return origin;
}

async function readInput(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new SetupError(415, '请使用配置表单。');
  }
  if (Number(req.headers['content-length']) > 4096) throw new SetupError(413, '配置内容过长。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) throw new SetupError(413, '配置内容过长。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SetupError(400, '配置内容无法读取。'); }
}

function validText(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,300}$/.test(value.trim());
}

function normalize(input, origin) {
  if (!validText(input?.clientId) || !validText(input?.clientSecret)) {
    throw new SetupError(400, '请输入百度开放平台的应用 ID 和密钥。');
  }
  let redirect;
  try { redirect = new URL(input.redirectUri ?? origin + callbackPath); }
  catch { throw new SetupError(400, '请输入有效的回调地址。'); }
  if (redirect.origin !== origin || redirect.pathname !== callbackPath || redirect.username || redirect.password ||
      redirect.search || redirect.hash) {
    throw new SetupError(400, '本机配置请使用回调地址 ' + origin + callbackPath);
  }
  return { clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim(), redirectUri: redirect.href };
}

export function createBaiduConfigHandler({ file, sessionFile, env = process.env, request } = {}) {
  let saved = null;
  try { saved = file ? readLocalSettings(file) : null; }
  catch { /* The environment settings remain available if a local storage file is missing or unreadable. */ }
  const initial = {
    clientId: env.BAIDU_CLIENT_ID?.trim(),
    clientSecret: env.BAIDU_CLIENT_SECRET?.trim(),
    redirectUri: env.BAIDU_REDIRECT_URI?.trim(),
  };
  let config = saved?.clientId && saved?.clientSecret && saved?.redirectUri ? saved : initial;
  let generation = 0;

  function connect(settings, ownGeneration) {
    return createBaiduHandler({
      sessionFile,
      request,
      backupGenerationActive: () => generation === ownGeneration,
      env: {
        BAIDU_CLIENT_ID: settings.clientId,
        BAIDU_CLIENT_SECRET: settings.clientSecret,
        BAIDU_REDIRECT_URI: settings.redirectUri,
        BAIDU_BACKUP_APP_FOLDER: settings.clientId === initial.clientId ? env.BAIDU_BACKUP_APP_FOLDER : undefined,
      },
    });
  }
  let handleBaidu = connect(config, generation);
  return async function baiduConfig(req, res, url) {
    if (url.pathname !== settingsPath) return handleBaidu(req, res, url);
    try {
      const origin = checkLocal(req);
      if (req.method === 'GET') {
        send(res, 200, { editable: Boolean(file), redirectUri: origin + callbackPath });
      } else if (req.method === 'POST') {
        if (!file) throw new SetupError(403, '当前实例不支持页面保存应用配置。');
        const next = normalize(await readInput(req), origin);
        const changed = next.clientId !== config.clientId || next.clientSecret !== config.clientSecret || next.redirectUri !== config.redirectUri;
        if (changed) {
          const nextHandler = connect(next, generation + 1);
          writeLocalSettings(file, next);
          config = next;
          handleBaidu = nextHandler;
          generation += 1;
        }
        send(res, 200, { configured: true, changed });
      } else {
        res.setHeader('Allow', 'GET, POST');
        send(res, 405, { error: '此配置请求方式不受支持。' });
      }
    } catch (error) {
      send(res, error instanceof SetupError ? error.status : 500, {
        error: error instanceof SetupError ? error.message : '无法保存应用配置，请检查本机数据目录。',
      });
    }
    return true;
  };
}
