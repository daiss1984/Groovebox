import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

const key = 'groovebox.state.v1';
const fixtureAsset = '/assets/cover-1.jpg';
const originalPlaylist = 'Original fixture playlist';
const incomingPlaylist = 'Restored fixture playlist';
const track = (id, title) => ({ id: 'baidu:' + id, provider: 'baidu', title, artist: 'Crash fixture',
  album: 'Crash fixture', src: '/api/baidu/stream?id=' + id });

test('catalog and playlist preferences remain in the same generation if the browser closes during a restore', async ({ baseURL, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium' || process.env.GROOVEBOX_CATALOG_CRASH_TEST !== '1',
    'Opt-in Chromium persistent-profile diagnostic with CDP debugger cutpoint.');
  const profile = await mkdtemp(join(tmpdir(), 'groovebox-catalog-crash-profile-'));
  const options = { baseURL, channel: testInfo.project.use.channel, headless: true, serviceWorkers: 'block' };
  const original = track(1, 'Original fixture track');
  const incoming = track(2, 'Restored fixture track');
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, options);
    const page = context.pages()[0];
    await page.goto(fixtureAsset);
    await page.evaluate(async ({ key, original, originalPlaylist }) => {
      localStorage.setItem(key, JSON.stringify({
        tracks: [], playlists: [{ id: 'original', name: originalPlaylist, tracks: [original.id] }],
        settings: { demos: false, onlineCover: false, artistImageEngine: false },
      }));
      const { commitCloudCatalog } = await import('/cloud-catalog.js');
      await commitCloudCatalog('baidu', { tracks: [original], snapshots: [] }, { expectedRevision: null });
    }, { key, original, originalPlaylist });
    await page.goto('/#songs');
    await expect(page.locator('#content')).toContainText(original.title);
    const debuggerSession = await context.newCDPSession(page);
    await debuggerSession.send('Debugger.enable');
    const paused = new Promise(resolve => debuggerSession.once('Debugger.paused', resolve));
    await page.evaluate(({ incomingPlaylist }) => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, raw) {
        if (name.startsWith('groovebox.state.') && JSON.parse(raw).playlists?.[0]?.name === incomingPlaylist) {
          debugger; // Close the isolated browser before this synchronous write or its catch block can run.
        }
        return set.call(this, name, raw);
      };
    }, { incomingPlaylist });
    const payload = Buffer.from(JSON.stringify({
      version: 1, tracks: [incoming], playlists: [{ id: 'incoming', name: incomingPlaylist, tracks: [incoming.id] }],
    }));
    const submitted = page.locator('#restore-file').setInputFiles({ name: 'groovebox-backup.json', mimeType: 'application/json', buffer: payload });
    void submitted.catch(() => {});
    const { callFrames } = await paused;
    const cutpoint = await debuggerSession.send('Debugger.evaluateOnCallFrame', {
      callFrameId: callFrames[0].callFrameId,
      expression: `({ candidate: JSON.parse(raw).playlists[0].name, durable: JSON.parse(localStorage.getItem(${JSON.stringify(key)})).playlists[0].name })`,
      returnByValue: true,
    });
    expect(cutpoint.result.value).toEqual({ candidate: incomingPlaylist, durable: originalPlaylist });
    const crashed = new Promise(resolve => page.once('crash', resolve));
    void debuggerSession.send('Page.crash').catch(() => {});
    await crashed;
    await context.close();
    await submitted.catch(() => {});

    context = await chromium.launchPersistentContext(profile, options);
    const recovered = context.pages()[0];
    await recovered.goto('/#songs');
    await expect(recovered.locator('#content')).toContainText(/fixture track/);
    const durable = await recovered.evaluate(async () => {
      const { readCloudCatalogState } = await import('/cloud-catalog.js');
      const { scope, records: [catalog] } = await readCloudCatalogState();
      const [playlist] = JSON.parse(localStorage.getItem(scope)).playlists;
      return { catalogIds: catalog?.tracks.map(row => row.id), playlistIds: playlist.tracks, playlist: playlist.name };
    });
    const playlistButton = recovered.locator('#sidebar').getByRole('button', { name: /fixture playlist/i });
    await expect(playlistButton).toHaveCount(1);
    const displayedPlaylist = (await playlistButton.innerText()).trim();
    await playlistButton.click();
    await expect(recovered.locator('#content h1')).toHaveText(displayedPlaylist);
    const visibleIds = await recovered.locator('#content tbody [data-track]').evaluateAll(rows => rows.map(row => row.dataset.track));
    console.log('CLOUD_CATALOG_CRASH_CUTPOINT ' + JSON.stringify({ cutpoint: cutpoint.result.value, recovered: { ...durable, displayedPlaylist, visibleIds } }));
    // Either roll back or complete the restore, as long as the reopened playlist resolves its tracks.
    expect(visibleIds).toEqual(durable.catalogIds);
    expect(visibleIds).toEqual(durable.playlistIds);
  } finally {
    await context?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  }
});
