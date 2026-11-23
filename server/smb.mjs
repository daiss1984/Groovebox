import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { imageSignature } from './artwork.mjs';

const worker = fileURLToPath(new URL('./smb_bridge.py', import.meta.url));
const localPython = fileURLToPath(new URL(process.platform === 'win32' ? '../.venv-smb/Scripts/python.exe' : '../.venv-smb/bin/python', import.meta.url));
const maxHeaderBytes = 8 * 1024 * 1024;
const maxLyricsBytes = 1_000_000;
const maxCoverBytes = 8 * 1024 * 1024;
const portraitTypes = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg']]);
const coverTypes = new Map([['cover.png', 'image/png'], ['cover.jpg', 'image/jpeg'], ['cover.jpeg', 'image/jpeg']]);
let liveWorkers = 0;
const audioTypes = new Map(Object.entries({
  '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.alac': 'audio/mp4',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.wave': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma', '.ape': 'audio/x-ape', '.weba': 'audio/webm', '.amr': 'audio/amr',
  '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff',
}));
const failures = new Map([
  ['missing', [503, 'SMB 需要安装 Python 3.10+ 和 smbprotocol，请检查 SMB_PYTHON 配置']],
  ['invalid', [400, 'SMB 文件路径无效']],
  ['link', [403, 'SMB 播放器不访问 DFS 共享或重解析链接']],
  ['denied', [403, 'SMB 拒绝访问，请检查账号密码和共享权限']],
  ['not_found', [404, '找不到该 SMB 共享、目录或音频文件']],
  ['too_many', [413, 'SMB 目录中的项目过多，请缩小来源范围']],
  ['too_large', [413, 'SMB 歌词文件过大']],
  ['cover_too_large', [413, 'SMB 封面文件过大']],
  ['timeout', [504, 'SMB 连接超时，请检查地址与网络']],
  ['unavailable', [502, '无法读取 SMB 共享，请检查网络、地址和 SMB2/3 配置']],
]);

export class SmbError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function failure(code) {
  return new SmbError(...(failures.get(code) || failures.get('unavailable')));
}

function validPart(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    value !== '.' && value !== '..' && !/[\\/:*?"<>|\x00-\x1f\x7f]|[ .]$/.test(value);
}

function decodeParts(path) {
  try {
    return path.replace(/\/$/, '').split('/').map(part => decodeURIComponent(part));
  } catch {
    throw failure('invalid');
  }
}

function settings(input, env) {
  const rawPath = /^smb:\/\/[^/?#]+\/([^?#]*)$/i.exec(input.url || '')?.[1];
  let base;
  try { base = new URL(input.url); }
  catch { throw new SmbError(400, '请输入 smb://主机/共享文件夹'); }
  const port = Number(base.port || 445);
  const host = base.hostname.toLowerCase();
  const validHost = isIP(host) === 4 || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);
  if (base.protocol !== 'smb:' || base.username || base.password || base.search || base.hash ||
    !validHost || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535 ||
    rawPath === undefined || rawPath.length > 8192 || base.href.length > 8192) {
    throw new SmbError(400, '请输入 smb://主机/共享文件夹，账号密码请单独填写');
  }
  const [share, ...root] = decodeParts(rawPath);
  if (!validPart(share) || root.length > 39 || !root.every(validPart)) throw failure('invalid');
  const { username, password } = input;
  if (typeof username !== 'string' || !username || username.length > 512 || username.includes('\0') ||
    typeof password !== 'string' || password.length > 4096 || password.includes('\0')) {
    throw new SmbError(400, '请输入有效的 SMB 用户名和密码');
  }
  base.hostname = host;
  base.pathname = '/' + [share, ...root].map(encodeURIComponent).join('/') + '/';
  if (Number(base.port) === 445) base.port = '';
  return { base, root, workerConfig: { host, port, share, username, password, encrypt: env.SMB_REQUIRE_ENCRYPTION === '1' } };
}

async function responseHeader(iterator) {
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await iterator.next();
    if (done) throw failure('unavailable');
    const end = value.indexOf(10);
    bytes += end < 0 ? value.length : end;
    if (bytes > maxHeaderBytes) throw failure('too_many');
    if (end < 0) {
      chunks.push(value);
      continue;
    }
    chunks.push(value.subarray(0, end));
    try {
      return { meta: JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')), rest: value.subarray(end + 1) };
    } catch {
      throw failure('unavailable');
    }
  }
}

async function openWorker(python, config, signal) {
  if (signal?.aborted) throw failure('unavailable');
  if (liveWorkers >= 16) throw new SmbError(503, 'SMB 连接繁忙，请稍后重试');
  const child = spawn(python, ['-I', worker], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  liveWorkers++;
  let missing = false;
  let timedOut = false;
  const close = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
  const timer = setTimeout(() => { timedOut = true; close(); }, 25_000);
  child.once('close', () => { liveWorkers--; signal?.removeEventListener('abort', close); });
  child.once('error', error => { missing = error.code === 'ENOENT'; });
  child.stdin.on('error', () => {});
  signal?.addEventListener('abort', close, { once: true });
  const iterator = child.stdout[Symbol.asyncIterator]();
  child.stdin.end(JSON.stringify(config) + '\n');
  try {
    const { meta, rest } = await responseHeader(iterator);
    if (meta?.error) throw failure(meta.error);
    return { meta, rest, iterator, close };
  } catch (error) {
    close();
    if (missing) throw failure('missing');
    if (timedOut) throw failure('timeout');
    if (error instanceof SmbError) throw error;
    throw failure('unavailable');
  } finally {
    clearTimeout(timer);
  }
}

async function* bytesFrom(job, expected) {
  let remaining = expected;
  const initial = job.rest.length;
  if (initial > remaining) throw failure('unavailable');
  if (initial) {
    remaining -= initial;
    yield job.rest;
  }
  while (remaining) {
    const { done, value } = await job.iterator.next();
    if (done || value.length > remaining) throw failure('unavailable');
    remaining -= value.length;
    yield value;
  }
}

function decodeLyrics(buffer) {
  if (buffer[0] === 255 && buffer[1] === 254) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer[0] === 254 && buffer[1] === 255) return new TextDecoder('utf-16be').decode(buffer);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('gb18030').decode(buffer); }
}

export function createSmbSource(input, { env = process.env } = {}) {
  const { base, root, workerConfig } = settings(input, env);
  const python = env.SMB_PYTHON || (existsSync(localPython) ? localPython : 'python3');
  const run = (action, parts, options = {}, signal) => openWorker(python, {
    ...workerConfig, action, parts: [...root, ...parts], ...options,
  }, signal);

  async function list(folder) {
    const names = folder || [];
    const job = await run('list', names);
    try {
      if (!Array.isArray(job.meta?.entries)) throw failure('unavailable');
      const records = [];
      const covers = new Map();
      for (const item of job.meta.entries) {
        if (!validPart(item?.name)) continue;
        const parts = [...names, item.name];
        const path = '/' + parts.join('/');
        const coverName = item.name.toLowerCase();
        if (!item.folder && coverTypes.has(coverName)) {
          if (!covers.has(coverName) && item.size > 0 && item.size <= maxCoverBytes) {
            covers.set(coverName, { parts, type: coverTypes.get(coverName), size: item.size, modified: item.modified });
          }
          continue;
        }
        const suffix = extname(item.name).toLowerCase();
        const sidecar = suffix === '.lrc' || suffix === '.vtt';
        const mime = audioTypes.get(suffix);
        if (!item.folder && !sidecar && !mime) continue;
        records.push({
          key: 'smb:' + path, name: item.name, path, folder: Boolean(item.folder), location: parts,
          stream: item.folder ? undefined : parts, type: mime, sidecar: sidecar && !item.folder,
          size: Math.max(0, Number(item.size) || 0),
        });
      }
      if (covers.size) {
        const candidates = [...coverTypes.keys()].map(name => covers.get(name)).filter(Boolean);
        const id = createHash('sha256').update(JSON.stringify(['smb-cover', candidates])).digest('base64url').slice(0, 24);
        const folderCover = { id, candidates };
        for (const record of records) if (!record.folder && !record.sidecar) record.folderCover = folderCover;
      }
      return records;
    } finally {
      job.close();
    }
  }

  async function listArtistPortraits() {
    if (root.length > 38) return [];
    const folder = ['artist'];
    const job = await run('artist_portraits', folder).catch(error => {
      if (error instanceof SmbError && error.status === 404) return null;
      throw error;
    });
    if (!job) return [];
    try {
      if (!Array.isArray(job.meta?.entries)) throw failure('unavailable');
      const artists = new Map();
      for (const item of job.meta.entries) {
        if (!validPart(item?.name) || item.folder || !Number.isSafeInteger(item.size) ||
            item.size <= 0 || item.size > maxCoverBytes) continue;
        const match = /^(.+)\.(png|jpe?g)$/i.exec(item.name);
        const artist = match && match[1].normalize('NFC').trim().toLowerCase();
        if (!artist) continue;
        const extension = match[2].toLowerCase();
        const rasters = artists.get(artist) || new Map();
        rasters.set(extension, rasters.has(extension) ? null : {
          parts: [...folder, item.name], type: portraitTypes.get(extension), size: item.size, modified: item.modified,
        });
        artists.set(artist, rasters);
      }
      return [...artists].map(([artist, rasters]) => [artist, [...portraitTypes.keys()].map(key => rasters.get(key)).filter(Boolean)])
        .filter(([, candidates]) => candidates.length);
    } finally {
      job.close();
    }
  }

  async function proxy(record, req, res) {
    if (!record.stream || (!record.type && !record.sidecar)) throw failure('not_found');
    const head = req.method === 'HEAD';
    const controller = new AbortController();
    const stop = () => controller.abort();
    res.once('close', stop);
    let job;
    try {
      job = await run(head ? 'head' : 'stream', record.stream, {
        range: record.sidecar ? undefined : req.headers.range,
        lyrics: Boolean(record.sidecar),
      }, controller.signal);
      const { status, size, start, stop: end } = job.meta || {};
      if (![200, 206, 416].includes(status) || ![size, start, end].every(Number.isSafeInteger) ||
        start < 0 || end < start || size < end) throw failure('unavailable');
      const headers = {
        'Content-Type': record.type || 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      };
      if (!record.sidecar) headers['Accept-Ranges'] = 'bytes';
      if (status === 416) return res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + size }).end();
      const expected = end - start;
      if (record.sidecar && expected > maxLyricsBytes) throw failure('too_large');
      if (record.sidecar) {
        if (head) return res.writeHead(200, headers).end();
        const chunks = [];
        for await (const chunk of bytesFrom(job, expected)) chunks.push(chunk);
        const body = Buffer.from(decodeLyrics(Buffer.concat(chunks, expected)));
        return res.writeHead(200, { ...headers, 'Content-Length': body.length }).end(body);
      }
      headers['Content-Length'] = expected;
      if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + (end - 1) + '/' + size;
      res.writeHead(status, headers);
      if (head || !expected) return res.end();
      await pipeline(Readable.from(bytesFrom(job, expected)), res);
    } finally {
      job?.close();
      res.off('close', stop);
    }
  }

  async function readCover(candidate, signal) {
    const job = await run('stream', candidate.parts, { cover: true }, signal);
    try {
      const { status, size, start, stop } = job.meta || {};
      if (status !== 200 || !Number.isSafeInteger(size) || size <= 0 || size > maxCoverBytes || start !== 0 || stop !== size) {
        throw failure('unavailable');
      }
      const chunks = [];
      for await (const chunk of bytesFrom(job, size)) chunks.push(chunk);
      const bytes = Buffer.concat(chunks, size);
      return imageSignature(bytes, candidate.type) ? bytes : undefined;
    } finally {
      job.close();
    }
  }

  async function proxyCover(candidates, req, res) {
    if (!candidates?.length) throw failure('not_found');
    const controller = new AbortController();
    const abort = () => controller.abort();
    const deadline = setTimeout(abort, 15_000);
    res.once('close', abort);
    try {
      for (const candidate of candidates) {
        const bytes = await readCover(candidate, controller.signal).catch(error => {
          if (controller.signal.aborted || !(error instanceof SmbError)) throw error;
          return undefined;
        });
        if (!bytes) continue;
        return res.writeHead(200, {
          'Content-Type': candidate.type,
          'Content-Length': bytes.length,
          'Cache-Control': 'private, no-store',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
        }).end(req.method === 'HEAD' ? undefined : bytes);
      }
      throw new SmbError(404, '找不到有效的 SMB 目录封面');
    } finally {
      clearTimeout(deadline);
      res.off('close', abort);
    }
  }

  return { base, list, listArtistPortraits, proxy, proxyCover };
}
