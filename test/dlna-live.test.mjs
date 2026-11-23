import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCastHandler } from '../server/cast-bridge.mjs';
import { applyCastSleepDeadline } from '../public/cast-sleep.js';

const exec = promisify(execFile);
const rendererName = 'Groovebox Test Renderer';

function makeTone(duration = 24) {
  const sampleRate = 16000;
  const pcm = Buffer.alloc(duration * sampleRate * 2);
  for (let i = 0; i < pcm.length / 2; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 1500), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function waitPosition(request, check) {
  const end = Date.now() + 7000;
  let latest;
  while (Date.now() < end) {
    latest = await (await request('position')).json();
    if (check(latest)) return latest;
    await delay(200);
  }
  assert.fail('Expected receiver state, last SOAP result: ' + JSON.stringify(latest));
}

async function runCast() {
  const handler = createCastHandler();
  const app = createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://127.0.0.1'))) res.writeHead(404).end();
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = 'http://127.0.0.1:' + app.address().port;
  let cookie;
  const request = (action, options = {}) => fetch(origin + '/api/cast/' + action, {
    ...options, headers: { ...options.headers, Origin: origin, ...(cookie && { Cookie: cookie }) },
    signal: AbortSignal.timeout(10000),
  });
  try {
    const found = await request('devices');
    assert.equal(found.status, 200);
    cookie = found.headers.get('set-cookie').split(';')[0];
    const { devices } = await found.json();
    const receiver = devices.find(device => device.name === rendererName);
    assert.ok(receiver, 'The isolated real receiver must respond to SSDP and advertise AVTransport');
    const params = new URLSearchParams({ device: receiver.id, title: 'Synthetic & isolated tone', artist: 'Fixture' });
    const start = await request('start?' + params, {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: makeTone(),
    });
    assert.equal(start.status, 200, await start.text());
    const played = await waitPosition(request, value => value.state === 'PLAYING' && value.position >= 1 && value.duration >= 23);
    assert.ok(played.position < 8);
    const seek = await request('seek?seconds=8', { method: 'POST' });
    assert.equal(seek.status, 200, await seek.text());
    const jumped = await waitPosition(request, value => value.state === 'PLAYING' && value.position >= 8);
    assert.ok(jumped.position < 13);
    let pauses = 0;
    const finish = finishTrack => applyCastSleepDeadline({ finishTrack, isCurrent: () => true,
      getPosition: async () => (await request('position')).json(),
      pause: async () => {
        pauses++;
        return (await request('pause', { method: 'POST' })).ok;
      } });
    assert.equal(await finish(false), 'paused');
    await waitPosition(request, value => value.state === 'PAUSED_PLAYBACK');
    const resume = await request('play', { method: 'POST' });
    assert.equal(resume.status, 200, await resume.text());
    await waitPosition(request, value => value.state === 'PLAYING');
    const short = await request('start?' + params, {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: makeTone(3),
    });
    assert.equal(short.status, 200, await short.text());
    await waitPosition(request, value => value.state === 'PLAYING' && value.duration === 3);
    assert.equal(await finish(true), 'finishing');
    await waitPosition(request, value => value.state === 'STOPPED');
    assert.equal(await finish(true), 'finished');
    assert.equal(pauses, 1);
    const stop = await request('stop', { method: 'POST' });
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), { active: false });
    const stopped = await request('position');
    assert.equal(stopped.status, 404);
    await stopped.body?.cancel();
  } finally {
    if (cookie) await request('stop', { method: 'POST' }).then(result => result.body?.cancel(), () => {});
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  }
}

if (process.env.GROOVEBOX_DLNA_DRIVER === '1') {
  await runCast();
} else {
  // The renderer image uses Debian's gmediarender with GStreamer's base and good plugins.
  // https://packages.debian.org/trixie/gmediarender
  const image = process.env.DLNA_TEST_IMAGE;
  test('casts through the real SSDP and AVTransport stack of GMediaRender', {
    skip: !image && 'Provide a local DLNA_TEST_IMAGE with gmediarender as its entry point.',
    timeout: 95000,
  }, async () => {
    const { build } = await import('esbuild');
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'groovebox-dlna-live-')));
    const driver = join(temporary, 'driver.mjs');
    const tag = 'groovebox-dlna-' + randomUUID();
    const network = tag + '-network';
    const receiver = tag + '-receiver';
    const controller = tag + '-controller';
    async function docker(args, timeout = 10000) {
      return exec('docker', args, { timeout });
    }
    try {
      await build({
        entryPoints: [fileURLToPath(import.meta.url)], outfile: driver, bundle: true, platform: 'node', format: 'esm',
        external: ['esbuild'], logLevel: 'silent',
      });
      await docker(['network', 'create', '--internal', network]);
      await docker([
        'run', '--detach', '--rm', '--pull=never', '--name', receiver, '--network', network,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        image, '--interface-name=eth0', '--friendly-name=' + rendererName,
        '--gstout-audiopipe=fakesink sync=true', '--gstout-videosink=fakesink', '--logfile=/dev/stdout',
      ]);
      await delay(800);
      try {
        await docker([
          'run', '--rm', '--pull=never', '--name', controller, '--network', network,
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--mount', 'type=bind,source=' + driver + ',target=/fixture.mjs,readonly',
          '--env', 'GROOVEBOX_DLNA_DRIVER=1', process.env.DLNA_TEST_NODE_IMAGE || 'node:24-alpine', 'node', '/fixture.mjs',
        ], 60000);
      } catch (error) {
        const log = await docker(['logs', '--tail=12', receiver]).catch(() => ({}));
        throw new Error([error.stderr || error.message, log.stdout, log.stderr].filter(Boolean).join('\n'));
      }
    } finally {
      await Promise.all([controller, receiver].map(name => docker(['rm', '-f', name]).catch(() => {})));
      await docker(['network', 'rm', network]).catch(() => {});
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
