import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

const legacyKey = 'groovebox.state.v1';
const scopedPrefix = 'groovebox.state.restore.';
const fixtureDocument = '/assets/cover-1.jpg';

function generation(number, name, sort, mode) {
  const track = {
    id: 'baidu:' + number, provider: 'baidu', title: name + ' catalog track',
    artist: 'Catalog fixture', album: 'Catalog fixture', src: '/api/baidu/stream?id=' + number,
  };
  const playlist = { id: 'generation-' + number, name: name + ' fixture playlist', tracks: [track.id] };
  const settings = {
    language: 'en', demos: false, onlineCover: false, artistImageEngine: false,
    sort, lyricWordMode: mode,
  };
  return { track, playlist, settings };
}

const oldState = generation(1, 'Original', 'default', 'off');
const newState = generation(2, 'Restored', 'duration', 'slide-accurate');

async function seed(page) {
  await page.goto(fixtureDocument);
  await page.evaluate(async ({ initial, key }) => {
    const { commitCloudCatalog } = await import('/cloud-catalog.js');
    await commitCloudCatalog('baidu', { tracks: [initial.track], snapshots: [] }, { expectedRevision: null });
    localStorage.setItem(key, JSON.stringify({
      tracks: [], playlists: [initial.playlist], favorites: [initial.track.id], settings: initial.settings,
    }));
  }, { initial: oldState, key: legacyKey });
  await page.goto('/#songs');
  await expect(page.locator('#content .track-name')).toHaveText(oldState.track.title);
}

function restoreBackup(page) {
  return page.locator('#restore-file').setInputFiles({
    name: 'groovebox-backup.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1, tracks: [newState.track], playlists: [newState.playlist],
      favorites: [newState.track.id], settings: newState.settings,
    })),
  });
}

async function persisted(page) {
  return page.evaluate(async () => {
    const { readCloudCatalogState } = await import('/cloud-catalog.js');
    const { scope, records, pending } = await readCloudCatalogState();
    return {
      scope,
      ids: records.flatMap(record => record.tracks.map(track => track.id)),
      pending: pending && { id: pending.id, scope: pending.scope, stateText: pending.stateText },
      active: localStorage.getItem(scope),
      candidate: pending && localStorage.getItem(pending.scope),
    };
  });
}

async function expectGeneration(page, generation) {
  await page.goto('/#songs');
  await expect(page.locator('#content .track-name')).toHaveText(generation.track.title);
  await expect(page.locator('#sort')).toHaveValue(generation.settings.sort);
  await expect(page.locator('html')).toHaveAttribute('data-lyric-word-mode', generation.settings.lyricWordMode);
  await expect(page.locator('#content [data-action=favorite]')).toHaveClass(/\bactive\b/);
  const visiblePlaylist = page.locator('#playlist-nav button');
  await expect(visiblePlaylist).toHaveText(generation.playlist.name);
  await visiblePlaylist.press('Enter');
  await expect(page.locator('#content h1')).toHaveText(generation.playlist.name);
  await expect(page.locator('#content tr[data-track]')).toHaveAttribute('data-track', generation.track.id);
  const actual = await persisted(page);
  expect(actual.pending).toBeUndefined();
  expect(actual.ids).toEqual([generation.track.id]);
  const compact = JSON.parse(actual.active);
  if (actual.scope !== legacyKey) expect(compact._grooveboxStateScope).toBe(actual.scope);
  expect(compact.playlists).toEqual([generation.playlist]);
  expect(compact.favorites).toEqual([generation.track.id]);
  expect(compact.settings).toMatchObject({ sort: generation.settings.sort, lyricWordMode: generation.settings.lyricWordMode });
  return actual;
}

async function installCrashCutpoint(page, point) {
  await page.evaluate(({ point, prefix, restoredName }) => {
    const storageSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, data) {
      if (!name.startsWith(prefix) || !data.includes(restoredName)) return storageSet.call(this, name, data);
      window.restoreProbeCandidateKey = name;
      if (point === 'before candidate write') debugger;
      const result = storageSet.call(this, name, data);
      if (point === 'after candidate write') debugger;
      return result;
    };
    if (point !== 'after catalog finalization') return;
    const pointerTransactions = new WeakSet();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (record, key) {
      if (this.name === 'catalogControl' && key === 'head' &&
          record?.scope === window.restoreProbeCandidateKey && !record.pending) pointerTransactions.add(this.transaction);
      return put.apply(this, arguments);
    };
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...complete,
      set(callback) {
        complete.set.call(this, typeof callback !== 'function' ? callback : function (event) {
          if (pointerTransactions.has(this)) debugger;
          return callback.call(this, event);
        });
      },
    });
  }, { point, prefix: scopedPrefix, restoredName: newState.playlist.name });
}

for (const point of ['before candidate write', 'after candidate write', 'after catalog finalization']) {
  test(`recovers the correct generation after a renderer crash ${point}`, async ({ baseURL, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'A real renderer crash requires Chromium CDP.');
    test.setTimeout(60_000);
    const profile = await mkdtemp(join(tmpdir(), 'groovebox-restore-crash-'));
    const options = { baseURL, channel: testInfo.project.use.channel, headless: true, serviceWorkers: 'block' };
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, options);
      const page = context.pages()[0];
      await seed(page);
      await installCrashCutpoint(page, point);
      const session = await context.newCDPSession(page);
      await session.send('Debugger.enable');
      const paused = new Promise(resolve => session.once('Debugger.paused', resolve));
      const submitted = restoreBackup(page).catch(() => {});
      const { callFrames } = await paused;
      const observation = await session.send('Debugger.evaluateOnCallFrame', {
        callFrameId: callFrames[0].callFrameId,
        expression: `({
          scope: window.restoreProbeCandidateKey,
          written: localStorage.getItem(window.restoreProbeCandidateKey) !== null,
          displayed: document.querySelector('#playlist-nav button').textContent.trim(),
        })`,
        returnByValue: true,
      });
      const { scope } = observation.result.value;
      expect(scope.startsWith(scopedPrefix)).toBe(true);
      expect(observation.result.value).toEqual({
        scope, written: point !== 'before candidate write', displayed: oldState.playlist.name,
      });

      const crashed = page.waitForEvent('crash');
      void session.send('Page.crash').catch(() => {});
      await crashed;
      await submitted;
      await context.close();
      context = await chromium.launchPersistentContext(profile, options);
      const recovered = context.pages()[0];
      // Observe the durable cutpoint before starting the app, so bootstrap recovery cannot conceal it.
      await recovered.goto(fixtureDocument);
      const cutpoint = await persisted(recovered);
      if (point === 'after catalog finalization') {
        expect(cutpoint).toMatchObject({ scope, ids: [newState.track.id] });
        expect(cutpoint.pending).toBeUndefined();
      } else {
        expect(cutpoint).toMatchObject({ scope: legacyKey, ids: [oldState.track.id], pending: { scope } });
        expect(Boolean(cutpoint.candidate)).toBe(point === 'after candidate write');
        if (cutpoint.candidate) expect(cutpoint.candidate).toBe(cutpoint.pending.stateText);
      }
      const generation = point === 'before candidate write' ? oldState : newState;
      const active = await expectGeneration(recovered, generation);
      expect(active.scope).toBe(generation === oldState ? legacyKey : scope);
    } finally {
      await context?.close().catch(() => {});
      await rm(profile, { recursive: true, force: true });
    }
  });
}

test('a candidate quota error cancels the exact pending restore and preserves the old generation', async ({ page }) => {
  await seed(page);
  const initial = await persisted(page);
  await page.evaluate(prefix => {
    const store = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, raw) {
      if (key.startsWith(prefix)) {
        window.refusedRestoreScope = key;
        throw new DOMException('Fixture quota', 'QuotaExceededError');
      }
      return store.call(this, key, raw);
    };
  }, scopedPrefix);
  await restoreBackup(page);
  await expect(page.locator('#toast')).toContainText(/Could not save the restored playlists|Check browser storage/);
  expect(await page.evaluate(() => window.refusedRestoreScope?.startsWith('groovebox.state.restore.'))).toBe(true);
  expect(await persisted(page)).toEqual(initial);
  await page.reload();
  expect((await expectGeneration(page, oldState)).scope).toBe(legacyKey);
  await restoreBackup(page);
  await expect(page.locator('#toast')).toHaveText('Backup restored.');
  expect((await expectGeneration(page, newState)).scope).toMatch(/^groovebox\.state\.restore\./);
});

for (const damage of ['missing', 'invalid JSON', 'bound to a different scope']) {
  test(`fails closed if the active restore preferences are ${damage}`, async ({ page }) => {
    await seed(page);
    await restoreBackup(page);
    await expect(page.locator('#toast')).toHaveText('Backup restored.');
    // Apply damage with no live app page to overwrite it during a regular pagehide save.
    await page.goto(fixtureDocument);
    const complete = await persisted(page);
    expect(complete.scope.startsWith(scopedPrefix)).toBe(true);
    const damaged = await page.evaluate(({ scope, damage, active }) => {
      if (damage === 'missing') localStorage.removeItem(scope);
      else if (damage === 'invalid JSON') localStorage.setItem(scope, '{');
      else localStorage.setItem(scope, JSON.stringify({
        ...JSON.parse(active), _grooveboxStateScope: 'groovebox.state.v1',
      }));
      return localStorage.getItem(scope);
    }, { scope: complete.scope, damage, active: complete.active });
    await page.goto('/#songs');
    await expect(page.locator('#toast')).toContainText(/Could not save or read|无法保存或读取/);
    await expect(page.locator('#content')).not.toContainText(oldState.track.title);
    await expect(page.locator('#content')).not.toContainText(newState.track.title);
    await expect(page.locator('#playlist-nav')).not.toContainText(oldState.playlist.name);
    await expect(page.locator('#playlist-nav')).not.toContainText(newState.playlist.name);
    expect(await persisted(page)).toEqual({ ...complete, active: damaged });
  });
}

async function stageBackup(page) {
  return page.evaluate(async incoming => {
    const { prepareCloudCatalogRestore, readCloudCatalogState } = await import('/cloud-catalog.js');
    const { scope, records } = await readCloudCatalogState();
    const pending = await prepareCloudCatalogRestore([{ sourceId: 'baidu', tracks: [incoming.track], snapshots: [] }], {
      expectedScope: scope,
      expectedRevisions: new Map(records.map(record => [record.sourceId, record.revision])),
      candidateState: {
        tracks: [], playlists: [incoming.playlist], favorites: [incoming.track.id], settings: incoming.settings,
      },
    });
    localStorage.setItem(pending.scope, pending.stateText);
    return { id: pending.id, scope: pending.scope, stateText: pending.stateText };
  }, newState);
}

async function alterStagedPreferences(page, staged) {
  // Valid JSON and the correct marker are insufficient when the journaled bytes differ.
  const altered = JSON.parse(staged.stateText);
  altered.settings.sort = 'title-desc';
  const candidate = JSON.stringify(altered);
  await page.evaluate(({ scope, candidate }) => localStorage.setItem(scope, candidate), { scope: staged.scope, candidate });
  return candidate;
}

for (const failure of ['candidate bytes were altered', 'storage denies reading the candidate']) {
  test(`keeps the restore pending when ${failure}`, async ({ page }) => {
    await seed(page);
    await page.goto(fixtureDocument);
    const original = await persisted(page);
    const staged = await stageBackup(page);
    let candidate = staged.stateText;
    if (failure === 'candidate bytes were altered') {
      candidate = await alterStagedPreferences(page, staged);
    } else {
      await page.addInitScript(scope => {
        if (location.pathname !== '/') return;
        const read = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
          if (key === scope) throw new DOMException('Fixture blocked storage', 'SecurityError');
          return read.call(this, key);
        };
      }, staged.scope);
    }
    await page.goto('/#songs');
    await expect(page.locator('#toast')).toContainText(/Could not save or read|无法保存或读取/);
    await expect(page.locator('#content .track-name')).toHaveText(oldState.track.title);
    await expect(page.locator('#playlist-nav')).not.toContainText(newState.playlist.name);
    await page.locator('#sort').selectOption('artist');
    await page.goto(fixtureDocument);
    expect(await persisted(page)).toEqual({ ...original, pending: staged, candidate });
  });
}

test('discards only the incomplete restore the user confirmed', async ({ page, context }) => {
  const notice = page.locator('[data-catalog-recovery-notice]');
  async function openDiscard() {
    await page.goto('/#songs');
    await expect(notice).toContainText('Your previous data is kept.');
    await expect(page.locator('#content .track-name')).toHaveText(oldState.track.title);
    await notice.getByRole('button', { name: 'Discard Incomplete Restore' }).press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('keep the previous library and settings?');
    return dialog.getByRole('button', { name: 'Confirm', exact: true });
  }

  await seed(page);
  await page.goto(fixtureDocument);
  const staged = await stageBackup(page);
  const damaged = await alterStagedPreferences(page, staged);
  const confirm = await openDiscard();
  expect(await persisted(page)).toMatchObject({ scope: legacyKey, pending: staged, candidate: damaged });
  const reloaded = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
  await confirm.press('Enter');
  await reloaded;
  await expect(notice).toHaveCount(0);
  expect((await expectGeneration(page, oldState)).scope).toBe(legacyKey);
  expect(await page.evaluate(scope => localStorage.getItem(scope), staged.scope)).toBeNull();

  await page.goto(fixtureDocument);
  const newer = await stageBackup(page);
  await alterStagedPreferences(page, newer);
  const staleConfirm = await openDiscard();
  const peer = await context.newPage();
  await peer.goto(fixtureDocument);
  await peer.evaluate(async ({ staged, oldScope }) => {
    const { finalizeCloudCatalogRestore } = await import('/cloud-catalog.js');
    localStorage.setItem(staged.scope, staged.stateText);
    await finalizeCloudCatalogRestore(staged.id, { expectedScope: oldScope, candidateText: localStorage.getItem(staged.scope) });
  }, { staged: newer, oldScope: legacyKey });
  const conflict = page.locator('#toast');
  const changedInOtherTab = 'Another tab updated the cloud library.';
  await expect(conflict).toContainText(changedInOtherTab);
  // Clear the earlier change notification so the next notice must follow the stale confirmation.
  await conflict.evaluate(element => { element.textContent = ''; });
  await staleConfirm.press('Enter');
  await expect(conflict).toContainText(changedInOtherTab);
  const winner = await persisted(peer);
  expect(winner).toMatchObject({ scope: newer.scope, ids: [newState.track.id], active: newer.stateText });
  expect(winner.pending).toBeUndefined();
  await page.reload();
  expect((await expectGeneration(page, newState)).scope).toBe(newer.scope);
});

test('sort and playback position writes in an older tab cannot cross the committed scope', async ({ page, context }) => {
  await seed(page);
  const oldTab = await context.newPage();
  await oldTab.route('**/api/baidu/stream?id=1', route => {
    const localAudio = new URL('/assets/demo-1.m4a', route.request().url());
    return route.continue({ url: localAudio.href });
  });
  await oldTab.goto('/#songs');
  const oldRow = oldTab.locator('#content [data-action=play-row]');
  await expect(oldRow).toContainText(oldState.track.title);
  await restoreBackup(page);
  await expect(page.locator('#toast')).toHaveText('Backup restored.');
  const committed = await persisted(page);
  expect(committed.scope.startsWith(scopedPrefix)).toBe(true);

  await oldRow.press('Enter');
  const audio = oldTab.locator('#audio');
  await expect.poll(() => audio.evaluate(element => !element.paused && element.currentTime > 0.05)).toBe(true);
  await oldTab.locator('#player-toggle').press('Enter');
  await audio.evaluate(element => { element.currentTime = 12; });
  await expect.poll(() => audio.evaluate(element => element.seeking ? -1 : element.currentTime)).toBeCloseTo(12, 1);
  await oldTab.locator('#sort').selectOption('title-desc');

  const stale = await oldTab.evaluate(key => JSON.parse(localStorage.getItem(key)), legacyKey);
  expect(stale.settings.sort).toBe('title-desc');
  expect(stale.position).toBeCloseTo(12, 1);
  expect(stale.playlists).toEqual([oldState.playlist]);
  expect(await persisted(page)).toEqual(committed);
  await oldTab.reload();
  await expect(oldTab.locator('#content .track-name')).toHaveText(newState.track.title);
  await expect(oldTab.locator('#sort')).toHaveValue(newState.settings.sort);
  await expect(oldTab.locator('#playlist-nav button')).toHaveText(newState.playlist.name);
});
