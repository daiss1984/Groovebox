import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_TRANSCODE_INPUT_BYTES = 128 * 1024 * 1024;
const maxOutputBytes = 64 * 1024 * 1024;
const outputs = {
  mp3: { mime: 'audio/mpeg', args: ['-c:a', 'libmp3lame', '-q:a', '0',
    '-write_xing', '1', '-id3v2_version', '3'] },
  flac: { mime: 'audio/flac', args: ['-c:a', 'flac', '-compression_level', '5'] },
};
const permittedFormats = [
  'aac', 'ac3', 'aiff', 'amr', 'ape', 'asf', 'au', 'caf', 'dsf', 'dts', 'eac3', 'flac', 'iff',
  'matroska', 'mov', 'mp3', 'mpeg', 'mpegts', 'ogg', 'tta', 'wav', 'wv',
].join(',');

export class TranscodeError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'TranscodeError';
    this.status = status;
  }
}

function canceled(signal) {
  return signal.reason?.name === 'TimeoutError' ? new TranscodeError(504, '音频转换超时。') :
    new TranscodeError(499, '已取消音频转换。');
}

function abortable(pending, signal) {
  if (!signal) return pending;
  return new Promise((resolveValue, reject) => {
    const stop = () => reject(canceled(signal));
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(pending).then(value => {
      signal.removeEventListener('abort', stop);
      resolveValue(value);
    }, error => {
      signal.removeEventListener('abort', stop);
      reject(error);
    });
    if (signal.aborted) stop();
  });
}

function processOutput(stream, limit, collect) {
  let remaining = limit;
  stream?.on('data', value => {
    const size = Math.min(remaining, value.length);
    if (size > 0) collect(value.subarray(0, size));
    remaining -= size;
  });
}

function run(command, args, { stdio, signal, cwd }) {
  if (signal.aborted) return Promise.reject(canceled(signal));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio, cwd, shell: false, windowsHide: true,
        env: { PATH: process.env.PATH, LANG: 'C', ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }) },
      });
    } catch {
      reject(new TranscodeError(503, 'FFmpeg 不可用，请检查服务端配置。'));
      return;
    }
    const stdout = [];
    const stderr = [];
    processOutput(child.stdout, 64 * 1024, chunk => stdout.push(chunk));
    // Keep diagnostics only for classifying failures. Do not send FFmpeg output to clients.
    processOutput(child.stderr, 16 * 1024, chunk => stderr.push(chunk));
    let launchFailure;
    const kill = () => { child.kill('SIGKILL'); };
    child.once('error', error => { launchFailure = error; });
    child.once('spawn', () => { if (signal.aborted) kill(); });
    signal.addEventListener('abort', kill, { once: true });
    child.once('close', code => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) reject(canceled(signal));
      else if (launchFailure) reject(new TranscodeError(503, 'FFmpeg 不可用，请检查服务端配置。'));
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    if (signal.aborted) kill();
  });
}

function bytesSource(value) {
  if (value instanceof Uint8Array) return [value];
  if (value && typeof value === 'object' && (
    typeof value[Symbol.asyncIterator] === 'function' || typeof value[Symbol.iterator] === 'function' ||
    typeof value.getReader === 'function'
  )) return value;
  throw new TranscodeError(400, '转换需要音频文件数据。');
}

async function* abortableInput(input, signal) {
  const iterator = input[Symbol.asyncIterator]?.() ?? input[Symbol.iterator]?.() ?? input.getReader();
  let finished = false;
  try {
    while (!signal.aborted) {
      const part = await abortable(iterator.next?.() ?? iterator.read(), signal);
      if (part.done) {
        finished = true;
        return;
      }
      yield part.value;
    }
    throw canceled(signal);
  } finally {
    // An iterator may be waiting on a partial upload. Its close must not block cleanup.
    if (!finished) {
      void Promise.resolve().then(() => (iterator.return?.() ?? iterator.cancel?.())).catch(() => {});
    }
  }
}

async function receive(input, destination, limit, signal) {
  let bytes = 0;
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) callback(new TranscodeError(413, '音频超过转换输入大小限制。'));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(abortableInput(input, signal), bounded, createWriteStream(destination, { mode: 0o600, flags: 'wx' }), { signal });
  } catch (error) {
    if (signal.aborted) throw canceled(signal);
    if (error instanceof TranscodeError) throw error;
    if (error?.code === 'ENOSPC') throw new TranscodeError(507, '服务端没有足够的转换存储空间。');
    throw new TranscodeError(400, '无法读取转换输入。');
  }
  if (!bytes) throw new TranscodeError(400, '转换音频为空。');
}

function removeDirectory(directory) {
  return directory ? rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 75 }) : Promise.resolve();
}

export function createAudioTranscoder({
  command = process.env.FFMPEG_PATH || 'ffmpeg',
  inputLimit = MAX_TRANSCODE_INPUT_BYTES,
  outputLimit = maxOutputBytes,
  maxConcurrent = 2,
  maxResults = 6,
  timeoutMs = 120_000,
  retentionMs = 15 * 60_000,
  tempRoot = tmpdir(),
} = {}) {
  const executable = typeof command === 'string' && /[\\/]/.test(command) ? resolve(command) : command;
  let capability;
  let converting = 0;
  let leased = 0;

  async function check({ signal } = {}) {
    if (signal?.aborted) throw canceled(signal);
    capability ??= run(executable, ['-hide_banner', '-protocols'], {
      stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(5000),
    }).then(({ code, stdout }) => {
      const inputProtocols = stdout.split(/\r?\nOutput:\s*\r?\n/)[0];
      if (code !== 0 || !/^\s*pipe\s*$/m.test(inputProtocols)) {
        throw new TranscodeError(503, 'FFmpeg 不可用或不支持受限音频输入。');
      }
      return Object.freeze({ seekable: /^\s*fd\s*$/m.test(inputProtocols) });
    }).catch(error => {
      capability = undefined;
      throw error;
    });
    return abortable(capability, signal);
  }

  async function transcode(input, { signal, format = 'mp3' } = {}) {
    if (!Object.hasOwn(outputs, format)) throw new TranscodeError(400, '不支持所选的兼容播放格式。');
    const outputConfig = outputs[format];
    const source = bytesSource(input);
    if (signal?.aborted) throw canceled(signal);
    if (converting >= maxConcurrent || leased >= maxResults) {
      throw new TranscodeError(429, '音频转换资源正在使用，请稍后再试。');
    }
    converting++;
    leased++;
    let directory;
    let complete = false;
    const timeout = new AbortController();
    const deadline = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const timeoutTimer = setTimeout(() => timeout.abort(new DOMException('Audio conversion timed out', 'TimeoutError')), timeoutMs);
    try {
      const { seekable } = await check({ signal: deadline });
      directory = await mkdtemp(join(tempRoot, 'groovebox-transcode-'));
      const inputPath = join(directory, 'input');
      const outputPath = join(directory, 'audio.' + format);
      await receive(source, inputPath, inputLimit, deadline);

      const handle = await open(inputPath, 'r');
      const probe = [
        '-protocol_whitelist', seekable ? 'fd' : 'pipe', '-format_whitelist', permittedFormats,
        '-probesize', '5242880', '-analyzeduration', '5000000', '-max_streams', '16', '-threads', '1',
        ...(seekable ? ['-fd', '3'] : []), '-i', seekable ? 'fd:' : 'pipe:0',
      ];
      let outcome;
      try {
        outcome = await run(executable, [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-n',
          '-max_alloc', '67108864', '-filter_threads', '1', ...probe,
          '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1',
          ...outputConfig.args, '-threads', '1', '-fs', String(outputLimit + 4096), '-f', format, outputPath,
        ], {
          stdio: seekable ? ['ignore', 'ignore', 'pipe', handle.fd] : [handle.fd, 'ignore', 'pipe'],
          cwd: directory, signal: deadline,
        });
      } finally {
        await handle.close();
      }

      if (deadline.aborted) throw canceled(deadline);
      if (outcome.code !== 0) {
        if (/unknown encoder|encoder[^\r\n]+not found/i.test(outcome.stderr)) {
          throw new TranscodeError(503, '此 FFmpeg 版本不支持 ' + format.toUpperCase() + ' 编码。');
        }
        if (/no space left on device/i.test(outcome.stderr)) throw new TranscodeError(507, '服务端没有足够的转换存储空间。');
        throw new TranscodeError(422, '无法解码所选音频。');
      }
      const output = await stat(outputPath, { throwIfNoEntry: false });
      if (!output?.isFile() || output.size < 128) throw new TranscodeError(422, '无法解码所选音频。');
      if (output.size > outputLimit) throw new TranscodeError(413, '转换后的音频超过输出大小限制。');
      // The inherited descriptor keeps user-supplied input bytes out of FFmpeg's filesystem arguments.
      // Remove the staging file before leasing the completed audio.
      await rm(inputPath);
      let disposing;
      const timer = setTimeout(() => { void dispose().catch(() => {}); }, retentionMs);
      timer.unref();
      function dispose() {
        clearTimeout(timer);
        disposing ??= removeDirectory(directory).finally(() => { leased--; });
        return disposing;
      }
      complete = true;
      return { path: outputPath, size: output.size, mime: outputConfig.mime, dispose };
    } catch (error) {
      if (error instanceof TranscodeError) throw error;
      if (deadline.aborted) throw canceled(deadline);
      if (error?.code === 'ENOSPC') throw new TranscodeError(507, '服务端没有足够的转换存储空间。');
      throw new TranscodeError(502, '音频转换失败。');
    } finally {
      clearTimeout(timeoutTimer);
      converting--;
      if (!complete) {
        await removeDirectory(directory).catch(() => {});
        leased--;
      }
    }
  }

  transcode.check = check;
  return transcode;
}

export const transcodeAudio = createAudioTranscoder();
