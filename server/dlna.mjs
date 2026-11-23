import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { XMLParser } from 'fast-xml-parser';

const ssdpAddress = '239.255.255.250';
const ssdpPort = 1900;
const servicePrefix = 'urn:schemas-upnp-org:service:AVTransport:';
const targets = ['urn:schemas-upnp-org:device:MediaRenderer:1', servicePrefix + '1'];
const rendererType = /^urn:schemas-upnp-org:device:MediaRenderer:[1-9]\d{0,2}$/;
const serviceType = /^urn:schemas-upnp-org:service:AVTransport:[1-9]\d{0,2}$/;
const maxDatagramBytes = 8192;
const maxXmlBytes = 256 * 1024;
const maxOffers = 24;
const xml = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  processEntities: false,
});

export class DlnaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function isPrivateDlnaAddress(address) {
  if (isIP(address) !== 4 || address === '169.254.169.254') return false;
  const [first, second, third] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || (first === 169 && second === 254 && third > 0 && third < 255);
}

function addressNumber(address) {
  return address.split('.').reduce((result, value) => (result << 8) | Number(value), 0);
}

function sameSubnet(address, network) {
  if (isIP(network.netmask) !== 4) return false;
  const mask = addressNumber(network.netmask);
  return mask !== 0 && (addressNumber(address) & mask) === (addressNumber(network.address) & mask);
}

function boundedHttpUrl(value, address, base) {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value) ||
      !isPrivateDlnaAddress(address)) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' || url.hostname !== address || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

// Parse only solicited SSDP responses from IPv4 peers on the interface's subnet.
export function parseDlnaOffer(datagram, senderAddress, network) {
  if (!Buffer.isBuffer(datagram) || datagram.length > maxDatagramBytes ||
      !isPrivateDlnaAddress(senderAddress) || !isPrivateDlnaAddress(network?.address) ||
      network.address === senderAddress || !sameSubnet(senderAddress, network)) return null;
  const [status, ...lines] = datagram.toString('latin1').split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200(?:[ \t]|$)/.test(status)) return null;
  const headers = new Map();
  for (const line of lines) {
    if (!line) break;
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (headers.has(key) && ['location', 'st', 'usn'].includes(key)) return null;
    headers.set(key, line.slice(colon + 1).trim());
  }
  const target = headers.get('st');
  if (!rendererType.test(target) && !serviceType.test(target)) return null;
  const usn = headers.get('usn');
  if (!/^uuid:[\w.:-]{1,240}(?:::urn:[\w.:-]{1,240})?$/.test(usn || '')) return null;
  const location = boundedHttpUrl(headers.get('location'), senderAddress);
  if (!location) return null;
  return { location, address: senderAddress, localAddress: network.address };
}

function discoverOnInterface(network, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve([]);
    const socket = createSocket('udp4');
    const offers = new Map();
    let finished = false;
    const timeout = setTimeout(finish, 2300);
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', finish);
      try { socket.close(); } catch { /* The socket may not have been bound. */ }
      resolve([...offers.values()]);
    }
    signal?.addEventListener('abort', finish, { once: true });
    socket.on('error', finish);
    socket.on('message', (message, sender) => {
      const offer = parseDlnaOffer(message, sender.address, network);
      if (!offer) return;
      offers.set(offer.location.href, offer);
      if (offers.size >= maxOffers) finish();
    });
    socket.bind(0, network.address, () => {
      if (finished) return;
      try {
        socket.setMulticastInterface(network.address);
        socket.setMulticastTTL(1);
        for (const target of targets) {
          const message = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: ' + ssdpAddress + ':' + ssdpPort +
            '\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ' + target + '\r\n\r\n');
          socket.send(message, ssdpPort, ssdpAddress, error => { if (error) finish(); });
        }
      } catch {
        finish();
      }
    });
  });
}

function scalar(value) {
  if (typeof value !== 'string') return '';
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => entities[entity]);
}

function array(value) {
  return Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
}

function parseXml(value) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(value)) throw new DlnaError(502, '投屏设备返回了无效的 XML。');
  try {
    return xml.parse(value, true);
  } catch {
    throw new DlnaError(502, '投屏设备返回了无效的 XML。');
  }
}

function rendererDevices(device, depth = 0) {
  if (!device || depth > 8) return [];
  return array(device).flatMap(item => [
    ...(rendererType.test(scalar(item.deviceType)) ? [item] : []),
    ...rendererDevices(item.deviceList?.device, depth + 1),
  ]);
}

function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function boundedText(response) {
  const body = response.body;
  if (!body) return '';
  if (Number(response.headers.get('content-length')) > maxXmlBytes) {
    await body.cancel();
    throw new DlnaError(502, '投屏设备响应过大。');
  }
  const pieces = [];
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(pieces, size).toString('utf8');
      size += value.byteLength;
      if (size > maxXmlBytes) {
        await reader.cancel();
        throw new DlnaError(502, '投屏设备响应过大。');
      }
      pieces.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

export async function describeDlnaOffer(offer, { signal, request = globalThis.fetch } = {}) {
  const location = boundedHttpUrl(String(offer?.location || ''), offer?.address);
  if (!location || !isPrivateDlnaAddress(offer?.localAddress) || offer.address === offer.localAddress) return [];
  const response = await request(location, {
    method: 'GET', redirect: 'manual', credentials: 'omit', signal: withTimeout(signal, 2400),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return [];
  }
  const { root } = parseXml(await boundedText(response));
  const declaredBase = scalar(root?.URLBase);
  const base = declaredBase ? boundedHttpUrl(declaredBase, offer.address, location) : location;
  if (!base || base.origin !== location.origin) return [];
  return rendererDevices(root?.device).flatMap(device => {
    const service = array(device.serviceList?.service).find(entry => serviceType.test(scalar(entry.serviceType)));
    const controlUrl = boundedHttpUrl(scalar(service?.controlURL), offer.address, base);
    if (!service || !scalar(service.controlURL) || !controlUrl || controlUrl.origin !== location.origin) return [];
    const identity = scalar(device.UDN).slice(0, 256) || controlUrl.href;
    const id = createHash('sha256').update(offer.address + '\0' + identity).digest('hex').slice(0, 32);
    return [{
      id,
      name: cleanText(scalar(device.friendlyName), 120) || 'DLNA 设备',
      address: offer.address,
      localAddress: offer.localAddress,
      controlUrl: controlUrl.href,
      serviceType: scalar(service.serviceType),
    }];
  });
}

export async function discoverDlnaRenderers({ signal } = {}) {
  const interfaces = Object.values(networkInterfaces()).flat()
    .filter(entry => entry && !entry.internal && isPrivateDlnaAddress(entry.address))
    .slice(0, 6);
  const found = (await Promise.all(interfaces.map(entry => discoverOnInterface(entry, signal)))).flat();
  if (signal?.aborted) return [];
  const offers = [...new Map(found.map(offer => [offer.location.href, offer])).values()].slice(0, maxOffers);
  const results = await Promise.allSettled(offers.map(offer => describeDlnaOffer(offer, { signal })));
  const renderers = results.filter(result => result.status === 'fulfilled').flatMap(result => result.value);
  return [...new Map(renderers.map(renderer => [renderer.id, renderer])).values()];
}

function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit).toWellFormed().replace(/[\x00-\x1f\x7f\ufffe\uffff]/g, '');
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function inputMedia(renderer, { uri, title, mime, artist, album }) {
  const url = boundedHttpUrl(uri, renderer.localAddress);
  if (!url || Number(url.port) < 1024 || !/^(?:audio\/[\w.+-]+|application\/octet-stream)$/i.test(mime || '')) {
    throw new DlnaError(400, '投屏音频地址或格式无效。');
  }
  const titleText = cleanText(title, 256) || 'Groovebox';
  const artistText = cleanText(artist, 256);
  const albumText = cleanText(album, 256);
  const metadata = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="groovebox" parentID="0" restricted="1"><dc:title>' + escapeXml(titleText) + '</dc:title>' +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    (artistText ? '<upnp:artist>' + escapeXml(artistText) + '</upnp:artist>' : '') +
    (albumText ? '<upnp:album>' + escapeXml(albumText) + '</upnp:album>' : '') +
    '<res protocolInfo="http-get:*:' + escapeXml(mime) + ':*">' + escapeXml(url.href) + '</res></item></DIDL-Lite>';
  return { CurrentURI: url.href, CurrentURIMetaData: metadata };
}

function relativeTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 360000) throw new DlnaError(400, '投屏播放进度无效。');
  const position = Math.floor(seconds);
  const parts = [Math.floor(position / 3600), Math.floor(position / 60) % 60, position % 60];
  return parts.map(value => String(value).padStart(2, '0')).join(':');
}

const actions = {
  setUri: 'SetAVTransportURI',
  play: 'Play',
  pause: 'Pause',
  stop: 'Stop',
  seek: 'Seek',
  getPosition: 'GetPositionInfo',
  getTransport: 'GetTransportInfo',
};

function requestFields(renderer, action, params) {
  switch (action) {
    case 'setUri': return inputMedia(renderer, params);
    case 'play': return { Speed: '1' };
    case 'seek': return { Unit: 'REL_TIME', Target: relativeTime(params.seconds) };
    default: return {};
  }
}

function seconds(value) {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(scalar(value));
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

export async function controlDlna(renderer, action, params = {}, { signal, request = globalThis.fetch } = {}) {
  const target = boundedHttpUrl(renderer?.controlUrl, renderer?.address);
  if (!target || !serviceType.test(renderer.serviceType) || renderer.address === renderer.localAddress ||
      !isPrivateDlnaAddress(renderer.localAddress)) throw new DlnaError(400, '投屏设备无效，请重新搜索设备。');
  const soapAction = Object.hasOwn(actions, action) ? actions[action] : null;
  if (!soapAction) throw new DlnaError(400, '不支持该投屏操作。');
  const fields = { InstanceID: '0', ...requestFields(renderer, action, params) };
  const args = Object.entries(fields).map(([key, value]) => '<' + key + '>' + escapeXml(value) + '</' + key + '>').join('');
  const envelope = '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    '<u:' + soapAction + ' xmlns:u="' + renderer.serviceType + '">' + args + '</u:' + soapAction + '></s:Body></s:Envelope>';

  const timeout = withTimeout(signal, 5000);
  let response;
  let body;
  try {
    response = await request(target, {
      method: 'POST', redirect: 'manual', credentials: 'omit', signal: timeout,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"' + renderer.serviceType + '#' + soapAction + '"' },
      body: envelope,
    });
    // A renderer refuses redirects and cannot transfer a control request to another destination.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new DlnaError(502, '投屏设备返回了重定向。');
    }
    body = await boundedText(response);
  } catch (error) {
    if (error instanceof DlnaError) throw error;
    if (timeout.aborted) throw new DlnaError(504, '连接投屏设备超时。');
    throw new DlnaError(502, '无法连接投屏设备。');
  }
  const result = body ? parseXml(body)?.Envelope?.Body : null;
  if (!response.ok || result?.Fault) {
    const code = scalar(result?.Fault?.detail?.UPnPError?.errorCode);
    throw new DlnaError(502, '投屏设备拒绝了该操作' + (/^\d{3}$/.test(code) ? '（' + code + '）。' : '。'));
  }

  const data = result?.[soapAction + 'Response'];
  if (action === 'getPosition') return { position: seconds(data?.RelTime), duration: seconds(data?.TrackDuration) };
  if (action === 'getTransport') return { state: scalar(data?.CurrentTransportState) };
  return {};
}
