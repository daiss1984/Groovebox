const prefix = '/api/artwork/';
const musicBrainz = 'https://musicbrainz.org/ws/2/release-group';
const coverArchive = 'https://coverartarchive.org';
// https://musicbrainz.org/relationships/artist-url
const wikidataRelation = '689870a4-a1e4-4912-b17f-7b2664215698';
const wikiAPI = 'https://www.wikidata.org/w/api.php';
const commonsOrigin = 'https://commons.wikimedia.org';
const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const idSyntax = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const mbid = new RegExp('^' + idSyntax + '$', 'i');
const item = 'mbid-' + idSyntax;
const archivePath = new RegExp('^/download/(' + item + ')/([^/]+)$', 'i');
const storagePath = new RegExp('^/(?:[0-9]+/)?items/(' + item + ')/([^/]+)$', 'i');
const archiveHost = /^(?:ia|dn)[0-9]+(?:\.[a-z]{2})?\.archive\.org$/i;
const filePath = /^mbid-[a-f0-9-]+-\d+_thumb500\.(?:jpe?g|png|webp|gif)$/i;
const maxImageBytes = 2 * 1024 * 1024;
const maxSearchBytes = 256 * 1024;
const hitLifetime = 86_400_000;
const missLifetime = 900_000;

class ArtworkError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const providerError = () => new ArtworkError(502, '在线封面服务暂时不可用。');
const rateLimited = seconds => new ArtworkError(429, '在线封面查询过快，请稍后再试。', seconds);

function displayName(value) {
  if (!value || value.length > 180 || /[\x00-\x1f\x7f-\x9f]/.test(value)) return '';
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

const normalized = value => typeof value === 'string' ? displayName(value).toLowerCase() : '';
const phrase = value => '"' + value.replace(/([\\"])/g, '\\$1') + '"';

function matchReleaseGroup(groups, artist, album) {
  const matches = new Map();
  for (const group of groups.slice(0, 12)) {
    if (!group || typeof group.id !== 'string' || !mbid.test(group.id) ||
        normalized(group.title) !== album || !Array.isArray(group['artist-credit'])) continue;
    const credits = group['artist-credit'];
    const combined = normalized(credits.map(credit =>
      (credit?.name ?? credit?.artist?.name ?? '') + (credit?.joinphrase ?? '')).join(''));
    if (combined !== artist && !(credits.length === 1 && normalized(credits[0]?.artist?.name) === artist)) continue;
    matches.set(group.id.toLowerCase(), group);
  }
  if (matches.size === 1) return releaseIdentity(matches.values().next().value);
  // Prefer a unique album without secondary types when the artist credits match.
  const groupsById = [...matches.entries()];
  const studio = groupsById.filter(([, group]) => group['primary-type'] === 'Album' &&
    Array.isArray(group['secondary-types']) && group['secondary-types'].length === 0);
  const artistIds = groupsById.map(([, group]) => JSON.stringify(group['artist-credit'].map(credit => credit?.artist?.id)));
  if (studio.length === 1 && artistIds.every(value => value === artistIds[0] && !value.includes('null'))) return releaseIdentity(studio[0][1]);
  return null;
}

function releaseIdentity(group) {
  const credits = group['artist-credit'];
  const id = credits.length === 1 && credits[0]?.artist?.id;
  return { id: group.id.toLowerCase(), artistId: typeof id === 'string' && mbid.test(id) ? id.toLowerCase() : null };
}

function artistEntity(artist, id) {
  if (typeof artist?.id !== 'string' || artist.id.toLowerCase() !== id || !Array.isArray(artist.relations)) return null;
  const entities = new Set();
  for (const relation of artist.relations) {
    if (relation?.['type-id'] !== wikidataRelation || relation.ended === true) continue;
    const match = /^https?:\/\/(?:www\.)?wikidata\.org\/(?:wiki|entity)\/(Q[1-9][0-9]{0,13})\/?$/.exec(relation.url?.resource);
    if (match) entities.add(match[1]);
  }
  return entities.size === 1 ? entities.values().next().value : null;
}

function claimValues(claims, property) {
  const list = Array.isArray(claims?.[property]) ? claims[property] : [];
  const ranked = list.filter(claim => claim?.rank === 'preferred' || claim?.rank === 'normal');
  const preferred = ranked.some(claim => claim.rank === 'preferred');
  return ranked.filter(claim => !preferred || claim.rank === 'preferred').flatMap(claim => {
    const snak = claim.mainsnak;
    return snak?.snaktype === 'value' && snak.property === property && typeof snak.datavalue?.value === 'string'
      ? [snak.datavalue.value] : [];
  });
}

const pictureFile = value => typeof value === 'string' && value.length <= 220 &&
  /^[^/\\:|#?<>%\x00-\x1f\x7f]+\.(?:jpe?g|png|webp|gif)$/iu.test(value);
const fileKey = value => value.normalize('NFC').replaceAll('_', ' ');

function commonsThumbnail(value, filename) {
  try {
    const url = new URL(value);
    if (!['https://thumb.wikimedia.org', 'https://upload.wikimedia.org'].includes(url.origin) || url.username || url.password || url.hash) return null;
    const match = /^\/wikipedia\/commons\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/([^/]+)\/([1-9][0-9]{1,3})px-([^/]+)$/.exec(url.pathname);
    if (!match || Number(match[2]) > 1024 || fileKey(decodeURIComponent(match[1])) !== fileKey(filename) ||
        fileKey(decodeURIComponent(match[3])) !== fileKey(filename)) return null;
    url.search = '';
    return url;
  } catch {
    return null;
  }
}

function attributionText(value) {
  if (typeof value !== 'string' || value.length > 4000) return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|quot|apos|nbsp|lt|gt);/g, entity =>
    ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&lt;': '<', '&gt;': '>' })[entity])
    .replace(/[<>\x00-\x1f\x7f-\x9f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function commonsAttribution(metadata, filename) {
  if (!metadata || String(metadata.Restrictions?.value ?? '').trim()) return null;
  const link = metadata.LicenseUrl?.value;
  const license = /^https?:\/\/(?:www\.)?creativecommons\.org\/licenses\/(by|by-sa)\/(1\.0|2\.0|2\.5|3\.0|4\.0)\/?$/.exec(link);
  const ccZero = /^https?:\/\/(?:www\.)?creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/.test(link);
  if (!license && !ccZero) return null;
  const author = attributionText(metadata.Attribution?.value) || attributionText(metadata.Artist?.value);
  if (license && !author) return null;
  return {
    name: 'Wikimedia Commons',
    url: commonsOrigin + '/wiki/File:' + encodeURIComponent(filename.replaceAll(' ', '_')),
    license: license ? 'CC ' + license[1].toUpperCase() + ' ' + license[2] : 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/' + (license ? 'licenses/' + license[1] + '/' + license[2] + '/' : 'publicdomain/zero/1.0/'),
    ...(author && { author }),
  };
}

function artworkLocation(value, current, expected) {
  let next;
  try { next = new URL(value, current); } catch { throw providerError(); }
  if (next.protocol !== 'https:' || next.username || next.password || next.port || next.search || next.hash) throw providerError();
  const match = next.hostname === 'archive.org' ? archivePath.exec(next.pathname) :
    archiveHost.test(next.hostname) ? storagePath.exec(next.pathname) : null;
  if (!match || !filePath.test(match[2]) || !match[2].toLowerCase().startsWith(match[1].toLowerCase() + '-') ||
      (expected && expected !== match[1] + '/' + match[2])) throw providerError();
  return { url: next, asset: match[1] + '/' + match[2] };
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* An unfinished response may already have failed. */ }
}

async function readBounded(response, limit) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await discard(response);
    throw providerError();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw providerError();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

export function imageSignature(bytes, type) {
  if (type === 'image/jpeg') return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (type === 'image/gif') return /^(?:GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6));
  return false;
}

async function imageResponse(response) {
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (response.status !== 200 || !imageTypes.includes(type)) {
    await discard(response);
    throw providerError();
  }
  const bytes = await readBounded(response, maxImageBytes);
  if (!imageSignature(bytes, type)) throw providerError();
  return { bytes, type };
}

function createCache(limit, now) {
  const values = new Map();
  return {
    get(key) {
      const record = values.get(key);
      if (!record) return undefined;
      values.delete(key);
      if (record.expiresAt <= now()) return undefined;
      values.set(key, record);
      return record.value;
    },
    set(key, value) {
      values.delete(key);
      if (values.size >= limit) values.delete(values.keys().next().value);
      values.set(key, { value, expiresAt: now() + (value === null ? missLifetime : hitLifetime) });
    },
  };
}

export function createArtworkHandler({ request = globalThis.fetch, now = Date.now,
  pause = duration => new Promise(resolve => setTimeout(resolve, duration)),
  contact = process.env.GROOVEBOX_ARTWORK_CONTACT } = {}) {
  const safeContact = typeof contact === 'string' && contact.length <= 160 &&
    /^(?:https:\/\/[!-~]+|[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]+)$/i.test(contact) ? contact : '';
  const userAgent = 'Groovebox/1.0.0' + (safeContact ? ' (' + safeContact + ')' : '');
  const albums = createCache(256, now);
  const images = createCache(32, now);
  const releaseGroups = createCache(256, now);
  const artistImages = createCache(16, now);
  const pendingAlbums = new Map();
  const pendingImages = new Map();
  const pendingReleaseGroups = new Map();
  const pendingArtists = new Map();
  let nextSearch = 0;
  let searching = false;

  async function musicBrainzJson(url, followUp = false) {
    const delay = nextSearch - now();
    if (followUp && !searching && delay > 0 && delay <= 1100) await pause(delay);
    const current = now();
    if (searching || current < nextSearch) throw rateLimited(Math.max(1, Math.ceil((nextSearch - current) / 1000)));
    searching = true;
    nextSearch = current + 1100;
    try {
      const response = await request(url, {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        await discard(response);
        if ([429, 503].includes(response.status)) {
          const seconds = Math.max(2, Math.min(60, Number(response.headers.get('retry-after')) || 5));
          nextSearch = Math.max(nextSearch, now() + seconds * 1000);
          throw rateLimited(Math.ceil(seconds));
        }
        throw providerError();
      }
      return JSON.parse((await readBounded(response, maxSearchBytes)).toString('utf8'));
    } finally {
      searching = false;
    }
  }

  async function findReleaseGroup(artist, album) {
    const url = new URL(musicBrainz);
    const artistName = phrase(artist);
    url.search = new URLSearchParams({
      fmt: 'json', limit: '12',
      query: 'releasegroup:' + phrase(album) +
        ' AND (artist:' + artistName + ' OR artistname:' + artistName + ' OR creditname:' + artistName + ')',
    });
    const data = await musicBrainzJson(url);
    if (!Array.isArray(data?.['release-groups'])) throw providerError();
    return matchReleaseGroup(data['release-groups'], normalized(artist), normalized(album));
  }

  const coverKey = (artist, album) => JSON.stringify([normalized(artist), normalized(album)]);

  async function releaseGroup(artist, album) {
    const key = coverKey(artist, album);
    const cached = releaseGroups.get(key);
    if (cached !== undefined) return cached;
    const existing = pendingReleaseGroups.get(key);
    if (existing) return existing;
    const work = findReleaseGroup(artist, album).then(group => {
      releaseGroups.set(key, group);
      return group;
    }).finally(() => pendingReleaseGroups.delete(key));
    pendingReleaseGroups.set(key, work);
    return work;
  }

  async function fetchCover(id) {
    let url = new URL('/release-group/' + id + '/front-500', coverArchive);
    let asset;
    const signal = AbortSignal.timeout(12_000);
    for (let hops = 0; hops <= 3; hops++) {
      const response = await request(url, {
        headers: { 'User-Agent': userAgent, Accept: imageTypes.join(', ') },
        redirect: 'manual', signal,
      });
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await discard(response);
        if (!location || hops === 3) throw providerError();
        ({ url, asset } = artworkLocation(location, url, asset));
        continue;
      }
      return imageResponse(response);
    }
  }

  async function cover(id) {
    const cached = images.get(id);
    if (cached !== undefined) return cached;
    const existing = pendingImages.get(id);
    if (existing) return existing;
    if (pendingImages.size >= 4) throw rateLimited(2);
    const work = fetchCover(id).then(image => {
      images.set(id, image);
      return image;
    }).finally(() => pendingImages.delete(id));
    pendingImages.set(id, work);
    return work;
  }

  async function albumCover(artist, album) {
    const key = coverKey(artist, album);
    const cached = albums.get(key);
    if (cached !== undefined) return cached;
    const existing = pendingAlbums.get(key);
    if (existing) return existing;
    const work = releaseGroup(artist, album).then(async group => {
      const id = group?.id;
      const result = id && await cover(id) ? id : null;
      albums.set(key, result);
      return result;
    }).finally(() => pendingAlbums.delete(key));
    pendingAlbums.set(key, work);
    return work;
  }

  async function wikiJson(endpoint, params, signal, limit = maxSearchBytes) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ ...params, format: 'json' });
    const response = await request(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' }, redirect: 'error', signal,
    });
    if (!response.ok) {
      await discard(response);
      throw providerError();
    }
    const data = JSON.parse((await readBounded(response, limit)).toString('utf8'));
    if (data?.error) throw providerError();
    return data;
  }

  async function fetchArtistCover(id) {
    const artistURL = new URL('https://musicbrainz.org/ws/2/artist/' + id);
    artistURL.search = new URLSearchParams({ fmt: 'json', inc: 'url-rels' });
    const related = artistEntity(await musicBrainzJson(artistURL, true), id);
    if (!related) return null;
    const signal = AbortSignal.timeout(12_000);
    const { entities } = await wikiJson(wikiAPI, { action: 'wbgetentities', ids: related, props: 'claims' }, signal, 512 * 1024);
    const claims = entities?.[related]?.claims;
    const artistIds = claimValues(claims, 'P434').map(value => value.toLowerCase());
    if (!artistIds.includes(id)) return null;
    const filename = claimValues(claims, 'P18').find(pictureFile);
    if (!filename) return null;

    const commons = await wikiJson(commonsOrigin + '/w/api.php', {
      action: 'query', formatversion: '2', titles: 'File:' + filename, prop: 'imageinfo',
      iiprop: 'url|extmetadata', iiurlwidth: '480', iilimit: '1',
      iiextmetadatafilter: 'LicenseUrl|Artist|Attribution|Restrictions',
    }, signal);
    const page = commons.query?.pages;
    if (!Array.isArray(page) || page.length !== 1 || page[0].ns !== 6 || typeof page[0].title !== 'string') return null;
    const canonical = page[0].title.slice('File:'.length);
    if (!page[0].title.startsWith('File:') || !pictureFile(canonical) || fileKey(canonical) !== fileKey(filename)) return null;
    const info = page[0].imageinfo?.[0];
    const attribution = commonsAttribution(info?.extmetadata, canonical);
    const thumbnail = commonsThumbnail(info?.thumburl, canonical);
    if (!attribution || !thumbnail) return null;
    const response = await request(thumbnail, {
      headers: { 'User-Agent': userAgent, Accept: imageTypes.join(', ') }, redirect: 'error', signal,
    });
    return { ...await imageResponse(response), attribution };
  }

  async function artistCover(id) {
    const cached = artistImages.get(id);
    if (cached !== undefined) return cached;
    const existing = pendingArtists.get(id);
    if (existing) return existing;
    if (pendingArtists.size >= 2) throw rateLimited(2);
    const work = fetchArtistCover(id).then(image => {
      artistImages.set(id, image);
      return image;
    }).finally(() => pendingArtists.delete(id));
    pendingArtists.set(id, work);
    return work;
  }

  return async (req, res, url) => {
    if (!url.pathname.startsWith(prefix)) return false;
    const isAlbum = url.pathname === prefix + 'album';
    const isArtist = url.pathname === prefix + 'artist';
    const isArtistCover = url.pathname === prefix + 'artist-cover';
    const isCover = url.pathname === prefix + 'cover' || isArtistCover;
    const json = (status, value, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    };
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      if (!(isAlbum || isArtist || isCover)) throw new ArtworkError(404, '找不到封面接口。');
      if (!(req.method === 'GET' || (isCover && req.method === 'HEAD'))) {
        return json(405, { error: '不支持此请求。' }, { Allow: isCover ? 'GET, HEAD' : 'GET' }), true;
      }
      if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
        throw new ArtworkError(403, '请从播放器内查询封面。');
      }
      if (isAlbum || isArtist) {
        const artist = displayName(url.searchParams.get('artist'));
        const album = displayName(url.searchParams.get('album'));
        if (!artist || !album) throw new ArtworkError(400, '请输入艺人和专辑名称。');
        if (isArtist) {
          const group = await releaseGroup(artist, album);
          const id = group?.artistId;
          const image = id && await artistCover(id);
          if (!image) throw new ArtworkError(404, '没有找到匹配的艺人图片。');
          json(200, { cover: prefix + 'artist-cover?id=' + id, attribution: image.attribution });
        } else {
          const id = await albumCover(artist, album);
          if (!id) throw new ArtworkError(404, '没有找到匹配的专辑封面。');
          json(200, { cover: prefix + 'cover?id=' + id });
        }
      } else {
        const id = url.searchParams.get('id')?.toLowerCase();
        if (!id || !mbid.test(id)) throw new ArtworkError(400, '封面编号无效。');
        const image = isArtistCover ? await artistCover(id) : await cover(id);
        if (!image) throw new ArtworkError(404, isArtistCover ? '没有找到艺人图片。' : '没有找到专辑封面。');
        if (res.destroyed) return true;
        res.writeHead(200, {
          'Content-Type': image.type, 'Content-Length': image.bytes.length,
          'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : image.bytes);
      }
    } catch (error) {
      const failure = error instanceof ArtworkError ? error : providerError();
      json(failure.status, { error: failure.message }, failure.retryAfter ? { 'Retry-After': String(failure.retryAfter) } : {});
    }
    return true;
  };
}
