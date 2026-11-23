import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import {
  DlnaError, controlDlna, describeDlnaOffer, discoverDlnaRenderers, isPrivateDlnaAddress, parseDlnaOffer,
} from '../server/dlna.mjs';

const local = { address: '192.168.20.2', netmask: '255.255.255.0' };
const remote = '192.168.20.19';
const serviceType = 'urn:schemas-upnp-org:service:AVTransport:2';
const rootDescriptor = 'http://' + remote + ':1400/device/root.xml';
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });

function reply(location = rootDescriptor, extra = '') {
  return Buffer.from('HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n' +
    'USN: uuid:audio-unit::urn:schemas-upnp-org:device:MediaRenderer:1\r\n' +
    'LOCATION: ' + location + '\r\n' + extra + '\r\n');
}

function descriptor(controlPath, base = '') {
  return '<?xml version="1.0"?>' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0">' + (base ? '<URLBase>' + base + '</URLBase>' : '') +
    '<device><deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType><deviceList>' +
    '<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:2</deviceType><UDN>uuid:audio-unit</UDN>' +
    '<friendlyName>客厅 &amp; 音响</friendlyName><serviceList><service><serviceType>' + serviceType + '</serviceType>' +
    '<controlURL>' + controlPath + '</controlURL></service></serviceList></device>' +
    '</deviceList></device></root>';
}

function renderer() {
  return { address: remote, localAddress: local.address, serviceType, controlUrl: 'http://' + remote + ':1400/controls/avt' };
}

function validOffer() {
  return parseDlnaOffer(reply(), remote, local);
}

test('accepts only scoped IPv4 MediaRenderer or AVTransport responses from the local subnet', () => {
  const offer = validOffer();
  assert.equal(offer.location.href, rootDescriptor);
  assert.equal(offer.address, remote);
  assert.equal(offer.localAddress, local.address);
  assert.equal(isPrivateDlnaAddress('10.0.0.2'), true);
  assert.equal(isPrivateDlnaAddress('172.31.255.1'), true);
  assert.equal(isPrivateDlnaAddress('169.254.20.9'), true);
  assert.equal(isPrivateDlnaAddress('169.254.169.254'), false);
  for (const sender of ['192.168.21.1', '8.8.8.8', '192.168.20.2', '127.0.0.1', '::1']) {
    assert.equal(parseDlnaOffer(reply(), sender, local), null);
  }
  for (const location of [
    'http://8.8.8.8/root.xml', 'http://192.168.20.42/root.xml',
    'http://user:pass@192.168.20.19/root.xml', 'http://192.168.20.19/root.xml#hidden',
    'https://192.168.20.19/root.xml', 'http://lookup.invalid/root.xml',
  ]) assert.equal(parseDlnaOffer(reply(location), remote, local), null);
  assert.equal(parseDlnaOffer(reply(rootDescriptor, 'LOCATION: ' + rootDescriptor + '\r\n'), remote, local), null);
  assert.equal(parseDlnaOffer(Buffer.alloc(8200), remote, local), null);
});

test('describes a nested renderer and runs the SOAP playback and seek round trip over mock HTTP', async t => {
  const actions = [];
  const fixture = createServer(async (req, res) => {
    if (req.url === '/device/root.xml') {
      assert.equal(req.method, 'GET');
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers.cookie, undefined);
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end(descriptor('/controls/avt'));
      return;
    }
    assert.equal(req.url, '/controls/avt');
    assert.equal(req.method, 'POST');
    assert.match(req.headers['content-type'], /^text\/xml/);
    assert.equal(req.headers.authorization, undefined);
    let soap = '';
    for await (const chunk of req) soap += chunk;
    const action = req.headers.soapaction.slice(serviceType.length + 2, -1);
    assert.equal(req.headers.soapaction, '"' + serviceType + '#' + action + '"');
    const args = parser.parse(soap).Envelope.Body[action];
    assert.equal(args.InstanceID, '0');
    actions.push({ action, args });
    const output = {
      GetPositionInfo: '<RelTime>00:01:32.5</RelTime><TrackDuration>00:04:10</TrackDuration>',
      GetTransportInfo: '<CurrentTransportState>PLAYING</CurrentTransportState>',
    }[action] || '';
    res.writeHead(200, { 'Content-Type': 'text/xml' }).end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<s:Body><u:' + action + 'Response xmlns:u="' + serviceType + '">' + output +
      '</u:' + action + 'Response></s:Body></s:Envelope>');
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const request = (target, options) => {
    assert.equal(target.hostname, remote);
    assert.equal(target.origin, 'http://' + remote + ':1400');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    return fetch('http://127.0.0.1:' + fixture.address().port + target.pathname, options);
  };

  const [device] = await describeDlnaOffer(validOffer(), { request });
  assert.deepEqual({ name: device.name, address: device.address, localAddress: device.localAddress, controlUrl: device.controlUrl,
    serviceType: device.serviceType }, { name: '客厅 & 音响', ...renderer() });
  assert.match(device.id, /^[a-f0-9]{32}$/);

  const uri = 'http://' + local.address + ':45671/audio/token?one=1&two=2';
  const title = '雨 & <午后> "录音"';
  await controlDlna(device, 'setUri', { uri, title, mime: 'audio/mpeg', artist: 'A & B' }, { request });
  await controlDlna(device, 'play', {}, { request });
  assert.deepEqual(await controlDlna(device, 'getPosition', {}, { request }), { position: 92.5, duration: 250 });
  assert.deepEqual(await controlDlna(device, 'getTransport', {}, { request }), { state: 'PLAYING' });
  await controlDlna(device, 'seek', { seconds: 3671.95 }, { request });
  await controlDlna(device, 'pause', {}, { request });
  await controlDlna(device, 'stop', {}, { request });

  const [set, play, , , seek] = actions;
  assert.equal(set.args.CurrentURI, uri);
  const metadata = parser.parse(set.args.CurrentURIMetaData)['DIDL-Lite'].item;
  assert.equal(metadata.title, title);
  assert.equal(metadata.artist, 'A & B');
  assert.equal(metadata.res, uri);
  assert.equal(metadata.class, 'object.item.audioItem.musicTrack');
  assert.equal(play.args.Speed, '1');
  assert.equal(seek.args.Unit, 'REL_TIME');
  assert.equal(seek.args.Target, '01:01:11');
  assert.deepEqual(actions.map(({ action }) => action), [
    'SetAVTransportURI', 'Play', 'GetPositionInfo', 'GetTransportInfo', 'Seek', 'Pause', 'Stop',
  ]);
});

test('device description refuses redirects, XML declarations of entities, and unrelated control targets', async () => {
  assert.deepEqual(await describeDlnaOffer(validOffer(), { request: async () => new Response(null, {
    status: 302, headers: { Location: 'http://8.8.8.8/root.xml' },
  }) }), []);
  for (const value of [
    descriptor('http://192.168.20.42/controls/avt'),
    descriptor('http://' + remote + ':81/other-service'),
    descriptor('http://user:pass@' + remote + ':1400/secret'),
    descriptor('/controls/avt', 'http://other.invalid:1400/'),
  ]) {
    assert.deepEqual(await describeDlnaOffer(validOffer(), { request: async () => new Response(value) }), []);
  }
  await assert.rejects(
    describeDlnaOffer(validOffer(), { request: async () => new Response('<?xml version="1.0"?><!DOCTYPE root [<!ENTITY foo SYSTEM "file:///etc/passwd">]><root>&foo;</root>') }),
    { name: 'Error', status: 502 },
  );
  await assert.rejects(
    describeDlnaOffer(validOffer(), { request: async () => new Response('x'.repeat(300_000)) }),
    { name: 'Error', status: 502 },
  );
});

test('device controls reject unsupported actions, invalid seek and unrelated audio origins, and propagate receiver faults', async () => {
  const device = renderer();
  const unreachable = async () => assert.fail('invalid input must not connect to a device');
  for (const uri of [
    'http://192.168.20.3:4444/audio/token', 'http://' + local.address + '/audio/token',
    'http://user:pass@' + local.address + ':4444/audio/token', 'http://127.0.0.1:4444/audio/token',
    'https://' + local.address + ':4444/audio/token',
  ]) await assert.rejects(controlDlna(device, 'setUri', { uri, mime: 'audio/mpeg' }, { request: unreachable }), { status: 400 });
  await assert.rejects(controlDlna(device, 'seek', { seconds: Infinity }, { request: unreachable }), { status: 400 });
  await assert.rejects(controlDlna(device, 'arbitrary', {}, { request: unreachable }), { status: 400 });
  await assert.rejects(controlDlna({ ...device, controlUrl: 'http://169.254.169.254/control' }, 'play', {}, { request: unreachable }), { status: 400 });
  let attempts = 0;
  await assert.rejects(controlDlna(device, 'play', {}, { request: async () => {
    attempts++;
    return new Response(null, { status: 302, headers: { Location: 'http://' + remote + ':1400/unrelated' } });
  } }), { status: 502 });
  assert.equal(attempts, 1);
  const fault = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail>' +
    '<UPnPError><errorCode>701</errorCode><errorDescription>Transition not available</errorDescription></UPnPError>' +
    '</detail></s:Fault></s:Body></s:Envelope>';
  await assert.rejects(controlDlna(device, 'pause', {}, { request: async () => new Response(fault, { status: 500 }) }), error => {
    assert(error instanceof DlnaError);
    assert.equal(error.status, 502);
    assert.match(error.message, /701/);
    return true;
  });
});

test('a canceled LAN search completes before sending requests', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await discoverDlnaRenderers({ signal: controller.signal }), []);
});
