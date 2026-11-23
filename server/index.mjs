import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createBaiduConfigHandler } from './baidu-config.mjs';
import { readInstallationKey } from './local-settings.mjs';
import { createGdriveHandler } from './gdrive.mjs';
import { createOnedriveHandler } from './onedrive.mjs';
import { createDropboxHandler } from './dropbox.mjs';
import { createBoxHandler } from './box.mjs';
import { createPcloudHandler } from './pcloud.mjs';
import { createAliyundriveHandler } from './aliyundrive.mjs';
import { createDrive123Handler } from './drive123.mjs';
import { createDrive115Handler } from './drive115.mjs';
import { createGuangyaHandler } from './guangya.mjs';
import { createSourcesHandler } from './sources.mjs';
import { createCastHandler } from './cast-bridge.mjs';
import { createTranscodeHandler } from './transcode-handler.mjs';
import { createAudioTranscoder } from './audio-transcode.mjs';
import { createArtworkHandler } from './artwork.mjs';
import { createListenBrainzHandler } from './listenbrainz.mjs';
import { createMetadataHandler } from './metadata-api.mjs';
import { createMetadataArtworkHandler } from './metadata-artwork-api.mjs';

const root = fileURLToPath(new URL('../public', import.meta.url));
const dataDirectory = process.env.GROOVEBOX_DATA_DIR ? resolve(process.env.GROOVEBOX_DATA_DIR) :
  fileURLToPath(new URL('../.groovebox/', import.meta.url));
const sessionFile = provider => join(dataDirectory, provider + '-sessions.enc');
const baidu = createBaiduConfigHandler({
  file: join(dataDirectory, 'baidu-settings.enc'),
  sessionFile: sessionFile('baidu'),
});
const gdrive = createGdriveHandler({ sessionFile: sessionFile('gdrive') });
const onedrive = createOnedriveHandler({ sessionFile: sessionFile('onedrive') });
const dropbox = createDropboxHandler({ sessionFile: sessionFile('dropbox') });
const box = createBoxHandler({ sessionFile: sessionFile('box') });
const pcloud = createPcloudHandler({ sessionFile: sessionFile('pcloud') });
const aliyundrive = createAliyundriveHandler({ sessionFile: sessionFile('aliyundrive') });
const drive123 = createDrive123Handler({ sessionFile: sessionFile('drive123') });
const drive115 = createDrive115Handler({ sessionFile: sessionFile('drive115') });
const guangya = createGuangyaHandler({
  sessionFile: sessionFile('guangya'),
  sessionKey: process.env.GUANGYA_CLIENT_ID && process.env.GUANGYA_REDIRECT_URI
    ? readInstallationKey(dataDirectory) : undefined,
});
const sources = createSourcesHandler({
  sessionDirectory: join(dataDirectory, 'source-sessions'),
  sessionKey: () => readInstallationKey(dataDirectory),
});
const cast = createCastHandler();
const localFfmpeg = join(dataDirectory, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const transcode = createTranscodeHandler({
  convert: createAudioTranscoder({
    command: process.env.FFMPEG_PATH || (existsSync(localFfmpeg) ? localFfmpeg : undefined),
  }),
});
const requestHandlers = [baidu, gdrive, onedrive, dropbox, box, pcloud, aliyundrive, drive123, drive115, guangya, sources, cast, transcode,
  createArtworkHandler(), createListenBrainzHandler(), createMetadataHandler({ dataDir: dataDirectory }),
  createMetadataArtworkHandler({ dataDir: dataDirectory })];
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.m4a': 'audio/mp4',
};
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 5187);
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(req.url, 'http://localhost');
    for (const handle of requestHandlers) {
      if (await handle(req, res, url)) return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    if (url.pathname === '/index.html' || url.pathname === '/') {
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; connect-src 'self' blob: https://lrclib.net; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep)) return res.writeHead(404).end();
    const info = await stat(path).catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!info?.isFile()) return res.writeHead(404).end();
    const headers = { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    if (url.pathname.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=3600';
    let start = 0;
    let end = info.size - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || !info.size || (!range[1] && !Number(range[2]))) {
        return res.writeHead(416, { 'Content-Range': 'bytes */' + info.size }).end();
      }
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else start = Math.max(0, info.size - Number(range[2]));
      if (start > end) return res.writeHead(416, { 'Content-Range': 'bytes */' + info.size }).end();
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + info.size;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(req.headers.range ? 206 : 200, headers);
    if (req.method === 'HEAD' || !info.size) return res.end();
    await pipeline(createReadStream(path, { start, end }), res);
  } catch (error) {
    if (res.destroyed || error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    if (res.headersSent) return res.destroy();
    res.writeHead(error instanceof URIError ? 400 : 500).end();
  }
});
server.listen(port, host, () => console.log('Groovebox: http://' + host + ':' + server.address().port));
