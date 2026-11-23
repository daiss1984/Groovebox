import { expect, test } from '@playwright/test';

const fixture = '/assets/cover-1.jpg';
const stateKey = 'groovebox.state.v1';

function track(id, title) {
  return { id: 'baidu:' + id, provider: 'baidu', title, artist: 'Catalog Fixture', album: 'Catalog Fixture Album',
    src: '/api/baidu/stream?id=' + id };
}

async function seed(page, original) {
  await page.goto(fixture);
  return page.evaluate(async ({ original, stateKey }) => {
    localStorage.setItem(stateKey, JSON.stringify({
      settings: { demos: false, onlineCover: false, artistImageEngine: false },
      tracks: [original],
      playlists: [{ id: 'existing', name: 'Original playlist', tracks: [original.id] }],
    }));
    const { commitCloudCatalog } = await import('/cloud-catalog.js');
    return commitCloudCatalog('baidu', { tracks: [original], snapshots: [['/', [], [original.id]]] }, { expectedRevision: null });
  }, { original, stateKey });
}

const currentCatalog = page => page.evaluate(async () => (await (await import('/cloud-catalog.js')).readCloudCatalogState()).records[0]);

function wavWithTitle(title) {
  const chunk = (label, value) => {
    const header = Buffer.alloc(8);
    header.write(label);
    header.writeUInt32LE(value.length, 4);
    return Buffer.concat([header, value, Buffer.alloc(value.length % 2)]);
  };
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(8_000, 4);
  format.writeUInt32LE(8_000, 8);
  format.writeUInt16LE(1, 12);
  format.writeUInt16LE(8, 14);
  return chunk('RIFF', Buffer.concat([
    Buffer.from('WAVE'), chunk('fmt ', format),
    chunk('LIST', Buffer.concat([Buffer.from('INFO'), chunk('INAM', Buffer.from(title + '\0'))])),
    chunk('data', Buffer.alloc(8000, 128)),
  ]));
}

test('rolls back an IndexedDB catalog restore when the compact playlist state cannot be saved', async ({ page }) => {
  const original = track(1, 'Original catalog row');
  const replacement = track(2, 'Replacement catalog row');
  const initial = await seed(page, original);
  await page.goto('/#songs');
  await expect(page.locator('#content')).toContainText(original.title);
  await page.evaluate(key => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, raw) {
      if ((name === key || name.startsWith('groovebox.state.restore.')) && JSON.parse(raw).playlists.some(item => item.name === 'Quota denied playlist')) {
        throw new DOMException('Fixture quota', 'QuotaExceededError');
      }
      return setItem.call(this, name, raw);
    };
  }, stateKey);
  const portable = { version: 1, tracks: [replacement], playlists: [{ id: 'replacement', name: 'Quota denied playlist', tracks: [replacement.id] }] };
  await page.locator('#restore-file').setInputFiles({
    name: 'groovebox-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(portable)),
  });
  await expect(page.locator('#toast')).toContainText('无法保存恢复的歌单');
  const restored = await currentCatalog(page);
  expect(restored).toMatchObject({ sourceId: 'baidu', tracks: initial.tracks, snapshots: initial.snapshots });
  await page.reload();
  await expect(page.locator('#content')).toContainText(original.title);
  await expect(page.locator('#content')).not.toContainText(replacement.title);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).playlists[0].name, stateKey)).toBe('Original playlist');
});

test('a stale tab can save its sort preference without restoring an older source or losing its new revision', async ({ page, context }) => {
  const original = track(1, 'Original catalog row');
  const replacement = track(2, 'Replacement catalog row');
  const initial = await seed(page, original);
  const peer = await context.newPage();
  try {
    await page.goto('/#songs');
    await expect(page.locator('#content')).toContainText(original.title);
    await peer.goto(fixture);
    const latest = await peer.evaluate(async ({ initial, replacement }) => {
      const { commitCloudCatalog } = await import('/cloud-catalog.js');
      return commitCloudCatalog('baidu', { tracks: [replacement], snapshots: [['/', [], [replacement.id]]] }, {
        expectedRevision: initial.revision,
      });
    }, { initial, replacement });
    await expect(page.locator('#toast')).toContainText('另一标签页更新了云端曲库');
    await page.locator('#sort').selectOption('title-desc');
    const saved = await page.evaluate(key => {
      const state = JSON.parse(localStorage.getItem(key));
      return { sort: state.settings.sort, tracks: state.tracks, snapshots: state.scanSnapshots };
    }, stateKey);
    expect(saved).toEqual({ sort: 'title-desc', tracks: [], snapshots: {} });
    expect(await currentCatalog(peer)).toEqual(latest);
    await page.reload();
    await expect(page.locator('#content')).toContainText(replacement.title);
    await expect(page.locator('#content')).not.toContainText(original.title);
    await expect(page.locator('#sort')).toHaveValue('title-desc');
  } finally {
    await peer.close();
  }
});

test('manual ranged audio tag reading writes an IndexedDB revision and renders the new title after reload', async ({ page }) => {
  const original = track(1, 'Original catalog row');
  const title = 'Ranged embedded title';
  const audio = wavWithTitle(title);
  let requests = 0;
  await page.route('**/api/baidu/stream?id=1', route => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range || '');
    if (!match) return route.fulfill({ status: 416 });
    requests++;
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), audio.length - 1);
    return route.fulfill({ status: 206, contentType: 'audio/wav', body: audio.subarray(start, end + 1),
      headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + audio.length, ETag: '"catalog-audio"' } });
  });
  const initial = await seed(page, original);
  await page.goto('/#songs');
  await page.locator('#content [data-action=track-menu]').click();
  await page.locator('[data-action=read-tags]').click();
  await expect(page.locator('#toast')).toContainText('已更新歌曲标签');
  const edited = await currentCatalog(page);
  expect(requests).toBeGreaterThan(0);
  expect(edited.revision).not.toBe(initial.revision);
  expect(edited.tracks[0]).toMatchObject({ id: original.id, title, embeddedTags: { title } });
  await page.reload();
  await expect(page.locator('#content')).toContainText(title);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).tracks, stateKey)).toEqual([]);
});

test('migrates a large existing inline index and compacts it on the next settings write', async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(key => {
    const sourceId = '3a51f96f-bf22-8877-86a6-4588472b927b';
    const starter = Array.from({ length: 1800 }, (_, index) => ({
      id: sourceId + ':' + index, provider: 'webdav', title: 'Legacy indexed song ' + index,
      src: '/api/sources/' + sourceId + '/stream?id=' + index,
      artist: 'An older library', album: 'Older album', notes: 'Catalog fields. '.repeat(39),
    }));
    localStorage.setItem(key, JSON.stringify({
      settings: { demos: false, onlineCover: false, artistImageEngine: false },
      scanSnapshots: { [sourceId]: [['/', [], starter.map(track => track.id)]] }, tracks: starter,
    }));
  }, stateKey);
  await page.goto('/#songs');
  await expect(page.locator('#content')).toContainText('1800 首歌曲');
  expect((await currentCatalog(page)).tracks).toHaveLength(1800);
  await page.locator('#sort').selectOption('title-desc');
  expect(await page.evaluate(key => localStorage.getItem(key).length, stateKey)).toBeLessThan(10_000);
  await page.reload();
  await expect(page.locator('#content')).toContainText('1800 首歌曲');
  await expect(page.locator('#sort')).toHaveValue('title-desc');
});

test('leaves unreadable catalog data intact while refusing a misleading successful restore', async ({ page }) => {
  const original = track(1, 'Inline fallback song');
  await seed(page, original);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('groovebox.cloud-catalog');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const writing = database.transaction('sourceCatalogs', 'readwrite');
      writing.objectStore('sourceCatalogs').put({ sourceId: 'baidu', revision: 'corrupt-fixture', tracks: [], snapshots: [] });
      writing.oncomplete = () => { database.close(); resolve(); };
      writing.onabort = () => { database.close(); reject(writing.error); };
    };
  }));
  await page.goto('/#songs');
  await expect(page.locator('#toast')).toContainText('无法保存或读取云端曲库');
  await expect(page.locator('#content')).toContainText(original.title);
  await page.locator('#toast').evaluate(element => { element.textContent = ''; });
  await page.locator('#restore-file').setInputFiles({
    name: 'groovebox-backup.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, tracks: [], playlists: [] })),
  });
  await expect(page.locator('#toast')).toContainText('无法保存或读取云端曲库');
  await expect(page.locator('#content')).toContainText(original.title);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).playlists[0].name, stateKey)).toBe('Original playlist');
  expect(await currentCatalog(page).catch(error => error.message)).toContain('CloudCatalogError');
});
