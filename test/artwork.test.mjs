import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createArtworkHandler } from '../server/artwork.mjs';

const groupId = '48140466-cff6-3222-bd55-63c27e43190d';
const otherGroup = 'c31a5e2b-0bf8-32e0-8aeb-ef4ba9973932';
const releaseId = '76df3287-6cda-33eb-8e9a-044b5e15ffdd';
const artistId = '6128f436-9502-4f32-a329-1ab74954ab87';
const archiveFile = 'mbid-' + releaseId + '/mbid-' + releaseId + '-829521842_thumb500.jpg';
const image = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]);
const lookup = (artist = '艺人', album = '专辑') => '/api/artwork/album?' + new URLSearchParams({ artist, album });
const cover = '/api/artwork/cover?id=' + groupId;
const redirect = location => new Response(null, { status: 307, headers: { Location: location } });
const jpeg = () => new Response(image, { headers: { 'Content-Type': 'image/jpeg' } });
const groups = items => Response.json({ 'release-groups': items });
const group = (id = groupId, title = '专辑', artist = '艺人', artistIdentity = artistId) => ({
  id, title, 'primary-type': 'Album', 'secondary-types': [],
  'artist-credit': [{ name: artist, artist: { id: artistIdentity, name: artist } }],
});

async function fixture(t, request, options = {}) {
  const handle = createArtworkHandler({ request, contact: 'https://example.test/support', ...options });
  const server = createServer(async (req, res) => {
    if (!await handle(req, res, new URL(req.url, 'http://localhost'))) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  return (path, init) => fetch(base + path, init);
}

test('finds exact artist and album and reuses the validated cover across album and image requests', async t => {
  const requests = [];
  const get = await fixture(t, (url, options) => {
    requests.push(url.href);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers['User-Agent'], 'Groovebox/1.0.0 (https://example.test/support)');
    if (url.hostname === 'musicbrainz.org') {
      assert.equal(url.pathname, '/ws/2/release-group');
      assert.equal(url.searchParams.get('limit'), '12');
      assert.equal(url.searchParams.get('query'), 'releasegroup:"专辑" AND (artist:"艺人" OR artistname:"艺人" OR creditname:"艺人")');
      assert.equal(options.redirect, 'error');
      return groups([group(otherGroup, '专辑现场版'), group()]);
    }
    assert.equal(options.redirect, 'manual');
    if (url.hostname === 'coverartarchive.org') {
      assert.equal(url.pathname, '/release-group/' + groupId + '/front-500');
      return redirect('https://archive.org/download/' + archiveFile);
    }
    if (url.hostname === 'archive.org') return redirect('https://dn721805.ca.archive.org/0/items/' + archiveFile);
    assert.equal(url.hostname, 'dn721805.ca.archive.org');
    return jpeg();
  });

  const first = await get(lookup('  艺人 ', '专辑'));
  assert.deepEqual(await first.json(), { cover });
  assert.equal(first.headers.get('cross-origin-resource-policy'), 'same-origin');
  const fromCache = await get(lookup());
  assert.deepEqual(await fromCache.json(), { cover });

  const bytes = await get(cover);
  assert.equal(bytes.headers.get('content-type'), 'image/jpeg');
  assert.equal(bytes.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), image);
  const head = await get(cover, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(image.length));
  assert.equal(await head.text(), '');
  assert.equal(requests.length, 4);
});

test('returns an empty lookup for ambiguous credits and a missing confirmed front cover', async t => {
  let now = 1_000;
  let searchCalls = 0;
  let coverCalls = 0;
  const get = await fixture(t, url => {
    if (url.hostname === 'musicbrainz.org') {
      searchCalls++;
      if (searchCalls === 1) return groups([group(), group(otherGroup, '专辑', '艺人', otherGroup)]);
      return groups([group(groupId, '另一个专辑')]);
    }
    coverCalls++;
    return new Response(null, { status: 404 });
  }, { now: () => now });
  assert.equal((await get(lookup())).status, 404);
  assert.equal((await get(lookup())).status, 404);
  assert.equal(coverCalls, 0);
  now += 1100;
  assert.equal((await get(lookup('艺人', '另一个专辑'))).status, 404);
  assert.equal((await get(cover)).status, 404);
  assert.equal(searchCalls, 2);
  assert.equal(coverCalls, 1);
});

test('bounds MusicBrainz requests and shares in-flight lookups for the same metadata', async t => {
  let now = 1_000;
  let searches = 0;
  const entered = Promise.withResolvers();
  const stop = Promise.withResolvers();
  const get = await fixture(t, async url => {
    if (url.hostname !== 'musicbrainz.org') return jpeg();
    searches++;
    if (searches === 1) {
      entered.resolve();
      await stop.promise;
      return groups([group()]);
    }
    return new Response(null, { status: 503, headers: { 'Retry-After': '8' } });
  }, { now: () => now });
  const first = get(lookup());
  try {
    await entered.promise;
    const second = get(lookup());
    const denied = await get(lookup('别的艺人'));
    assert.equal(denied.status, 429);
    assert.ok(denied.headers.get('retry-after'));
    stop.resolve();
    assert.deepEqual(await (await first).json(), { cover });
    assert.deepEqual(await (await second).json(), { cover });
    now += 1200;
    const rate = await get(lookup('别的艺人'));
    assert.equal(rate.status, 429);
    assert.equal(rate.headers.get('retry-after'), '8');
    now += 6000;
    assert.equal((await get(lookup('另一个艺人'))).status, 429);
    assert.equal(searches, 2);
  } finally {
    stop.resolve();
  }
});

test('declines foreign, cross-asset and unauthentic image responses', async t => {
  let mode = 'foreign';
  let upstream = [];
  const get = await fixture(t, url => {
    upstream.push(url.href);
    if (mode === 'foreign') return redirect('https://archive.org.evil.invalid/download/' + archiveFile);
    if (mode === 'svg') return new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
    if (mode === 'claimed-image') return new Response('<html/>', { headers: { 'Content-Type': 'image/jpeg' } });
    if (mode === 'large') return new Response(image, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '2097153' } });
    if (url.hostname === 'coverartarchive.org') return redirect('https://archive.org/download/' + archiveFile);
    return redirect('https://ia601604.us.archive.org/28/items/' + archiveFile.replace('829521842', '1'));
  });

  for (const variant of ['foreign', 'svg', 'claimed-image', 'large', 'cross-asset']) {
    mode = variant;
    upstream = [];
    const response = await get(cover);
    assert.equal(response.status, 502);
    assert.equal(upstream.length, variant === 'cross-asset' ? 2 : 1);
    assert.ok(upstream.every(url => /^https:\/\/(?:archive\.org|coverartarchive\.org)\//.test(url)));
  }
  assert.equal((await get(cover, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await get('/api/artwork/cover?id=https%3A%2F%2Fexample.test')).status, 400);
  assert.equal((await get(lookup('', '专辑'))).status, 400);
});

test('escapes quoted search values and requires full credits for collaborations', async t => {
  const collaboration = { ...group(groupId, '夜 "航"'),
    'artist-credit': [{ name: '飞鸟', joinphrase: ' & ', artist: { id: artistId, name: '飞鸟' } },
      { name: '微风', artist: { id: otherGroup, name: '微风' } }] };
  let now = 1000;
  const get = await fixture(t, url => {
    if (url.hostname !== 'musicbrainz.org') return jpeg();
    assert.ok(url.searchParams.get('query').startsWith('releasegroup:"夜 \\"航\\"" AND '));
    return groups([collaboration]);
  }, { now: () => now });
  assert.equal((await get(lookup('飞鸟', '夜 "航"'))).status, 404);
  now += 1200;
  assert.deepEqual(await (await get(lookup('飞鸟 & 微风', '夜 "航"'))).json(), { cover });
});

const artistLookup = '/api/artwork/artist?' + new URLSearchParams({ artist: '艺人', album: '专辑' });
const artistImageURL = '/api/artwork/artist-cover?id=' + artistId;
const artistRelationId = '689870a4-a1e4-4912-b17f-7b2664215698';
const qid = 'Q185821';
const photo = 'Artist photo.jpg';
const thumbnail = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/d/db/Artist_photo.jpg/500px-Artist_photo.jpg';

const statement = (property, value, rank = 'normal') => ({
  rank, mainsnak: { property, snaktype: 'value', datavalue: { value } },
});
const relatedArtist = (resource = 'https://www.wikidata.org/wiki/' + qid) => Response.json({
  id: artistId, relations: [{ 'type-id': artistRelationId, ended: false, url: { resource } }],
});
const artistClaims = (id = artistId) => Response.json({ entities: { [qid]: { claims: {
  P434: [statement('P434', id)],
  P18: [statement('P18', 'Older photo.png', 'deprecated'), statement('P18', photo, 'preferred')],
} } } });
const commonsPhoto = (overrides = {}) => Response.json({ query: { pages: [{
  ns: 6, title: 'File:' + photo, imageinfo: [{
    thumburl: thumbnail + '?utm_source=commons.wikimedia.org',
    extmetadata: {
      LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
      Artist: { value: '<a href="https://example.test/">Photo &amp; Studio</a>' },
      Restrictions: { value: '' },
    },
    ...overrides,
  }],
}] } });

test('uses the exact artist’s verified Wikidata photograph and returns attribution and same-origin bytes', async t => {
  let time = 10_000;
  const requests = [];
  const get = await fixture(t, (url, options) => {
    requests.push([url.href, time]);
    assert.ok(options.signal instanceof AbortSignal);
    if (url.pathname === '/ws/2/release-group') return groups([group()]);
    if (url.hostname === 'musicbrainz.org') {
      assert.equal(url.pathname, '/ws/2/artist/' + artistId);
      assert.equal(url.searchParams.get('inc'), 'url-rels');
      return relatedArtist();
    }
    if (url.hostname === 'www.wikidata.org') {
      assert.equal(url.searchParams.get('action'), 'wbgetentities');
      assert.equal(url.searchParams.get('ids'), qid);
      return artistClaims();
    }
    if (url.hostname === 'commons.wikimedia.org') {
      assert.equal(url.searchParams.get('titles'), 'File:' + photo);
      return commonsPhoto();
    }
    assert.equal(url.href, thumbnail);
    assert.equal(options.redirect, 'error');
    return jpeg();
  }, { now: () => time, pause: async delay => { time += delay; } });
  const result = await get(artistLookup);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    cover: artistImageURL,
    attribution: {
      name: 'Wikimedia Commons', url: 'https://commons.wikimedia.org/wiki/File:Artist_photo.jpg',
      license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      author: 'Photo & Studio',
    },
  });
  assert.equal(requests.length, 5);
  assert.ok(requests[1][1] - requests[0][1] >= 1100);
  const response = await get(artistImageURL);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  assert.equal((await get(artistImageURL, { method: 'HEAD' })).headers.get('content-length'), String(image.length));
  assert.equal((await get(artistLookup)).status, 200);
  assert.equal(requests.length, 5);
});

test('refuses unverified identities, unrelated CDN paths, and images without reusable licenses', async t => {
  for (const variation of ['relationship', 'reverse', 'foreign', 'wrong-file', 'license', 'no-author']) {
    let time = 10_000;
    let thumbRequests = 0;
    const get = await fixture(t, url => {
      if (url.pathname === '/ws/2/release-group') return groups([group()]);
      if (url.hostname === 'musicbrainz.org') return variation === 'relationship'
        ? relatedArtist('https://www.wikidata.org.example.test/wiki/' + qid) : relatedArtist();
      if (url.hostname === 'www.wikidata.org') return artistClaims(variation === 'reverse' ? otherGroup : artistId);
      if (url.hostname === 'commons.wikimedia.org') {
        if (variation === 'foreign') return commonsPhoto({ thumburl: 'https://example.test/Artist_photo.jpg' });
        if (variation === 'wrong-file') return commonsPhoto({ thumburl: thumbnail.replaceAll('Artist_photo', 'Other_photo') });
        if (variation === 'license') return commonsPhoto({ extmetadata: {
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-nc/4.0/' },
        } });
        if (variation === 'no-author') return commonsPhoto({ extmetadata: {
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' },
        } });
      }
      thumbRequests++;
      return jpeg();
    }, { now: () => time, pause: async delay => { time += delay; } });
    assert.equal((await get(artistLookup)).status, 404, variation);
    assert.equal(thumbRequests, 0);
  }
});
