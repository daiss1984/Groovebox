import { build } from 'esbuild';
import { createHash } from 'node:crypto';
await build({
  stdin: {
    contents: `
      export { parseBlob, parseFromTokenizer } from "music-metadata";
      export { AbstractTokenizer, EndOfStreamError } from "strtok3/core";
    `,
    resolveDir: process.cwd(),
  },
  platform: 'browser',
  format: 'esm',
  outfile: 'public/metadata.bundle.js',
  bundle: true,
  minify: true,
});
await build({
  stdin: { contents: 'export { parseDocument } from "yaml";', resolveDir: process.cwd() },
  platform: 'browser',
  format: 'esm',
  outfile: 'public/lyricsfile-yaml.bundle.js',
  bundle: true,
  minify: true,
});

import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
const publicDir = new URL('../public/', import.meta.url);
const iconDir = new URL('../node_modules/lucide-static/icons/', import.meta.url);
const code = (await Promise.all((await readdir(publicDir))
  .filter((file) => /\.(?:html|js)$/.test(file) && !file.includes('.bundle.') && file !== 'sw-build.js' && !file.startsWith('.'))
  .map((file) => readFile(new URL(file, publicDir), 'utf8')))).join(' ');
const aliases = { 'music-2': 'music-2', 'mic-2': 'mic-vocal' };
const names = new Set([...code.matchAll(/['"]([a-z0-9]+(?:-[a-z0-9]+)*)['"]/g)].map((match) => match[1]));
const files = new Set(await readdir(iconDir));
const icons = await Promise.all([...names].filter((name) => files.has((aliases[name] || name) + '.svg')).map(async (name) => {
  const svg = await readFile(new URL((aliases[name] || name) + '.svg', iconDir), 'utf8');
  const body = /<svg\b[^>]*>([\s\S]*?)<\/svg>/.exec(svg)?.[1];
  if (!body) throw new Error('Invalid icon SVG: ' + name);
  return '<symbol id="' + name + '" viewBox="0 0 24 24">' + body + '</symbol>';
}));
await writeFile(new URL('icons.svg', publicDir), '<svg xmlns="http://www.w3.org/2000/svg"><!-- Lucide, ISC --><defs>' + icons.join('') + '</defs></svg>');

const shell = [
  'index.html', 'style.css', 'icons.svg', 'assets/hero.jpg', 'app.js', 'locale.js', 'translations.js', 'player.js', 'equalizer-settings.js', 'track-preload.js', 'play-button-color.js', 'demo.js',
  'cloud-scan.js', 'cloud-catalog.js', 'cloud-catalog-state.js', 'catalog-recovery.js', 'source-filename.js', 'genres.js', 'library.js', 'media-storage.js', 'karaoke-formats.js', 'offline.js', 'offline-policy.js', 'image-cache-client.js', 'cast-sleep.js', 'stream-bitrate.js', 'audio-encoding.js',
  'playback-checkins.js', 'listenbrainz-playback.js', 'playback-history.js', 'playlist-download.js', 'playlist-cache-pass.js', 'playlist-sync.js', 'playlist-resume.js', 'playlist-overview.js', 'track-sort.js', 'cloud-playlist-snapshot.js', 'm3u.js', 'remote-metadata.js', 'metadata.bundle.js',
  'lyricsfile.js', 'lyricsfile-yaml.bundle.js', 'lyric-word-render.js', 'opus-output-gain.js', 'assets/opus-gain-probe.opus',
];
const digests = await Promise.all(shell.map(async file =>
  createHash('sha256').update(await readFile(new URL(file, publicDir))).digest('hex')));
const revision = createHash('sha256').update(JSON.stringify([shell, digests])).digest('hex').slice(0, 24);
const manifest = { revision, urls: ['/', ...shell.map(file => '/' + file)] };
const draft = new URL('.sw-build-' + process.pid + '.js', publicDir);
await writeFile(draft, 'self.grooveboxShell = ' + JSON.stringify(manifest) + ';\n');
await rename(draft, new URL('sw-build.js', publicDir));
