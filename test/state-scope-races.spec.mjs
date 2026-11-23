import { expect, test } from '@playwright/test';

const legacyScope = 'groovebox.state.v1';
const fixture = '/assets/cover-1.jpg';
const playlist = name => ({ id: 'qa-list', name, tracks: [] });

async function primeLegacyTab(page, { notifications = true } = {}) {
  await page.addInitScript(({ legacyScope, initial, notifications }) => {
    if (!notifications) Object.defineProperty(globalThis, 'BroadcastChannel', { value: undefined });
    if (!localStorage.getItem(legacyScope)) {
      localStorage.setItem(legacyScope, JSON.stringify({ settings: { language: 'en' }, playlists: [initial] }));
    }
  }, { legacyScope, initial: playlist('Original legacy playlist'), notifications });
}

async function commitFromPeer(peer) {
  await peer.goto(fixture);
  return peer.evaluate(async list => {
    const catalog = await import('/cloud-catalog.js');
    const storage = await import('/library.js');
    const staged = await catalog.prepareCloudCatalogRestore([], {
      expectedRevisions: new Map(), candidateState: {
        settings: { language: 'en' }, tracks: [], favorites: [], playlists: [list],
      },
    });
    if (!storage.writeStateTextAtScope(staged.scope, staged.stateText)) throw new Error('Could not stage fixture');
    const result = await catalog.finalizeCloudCatalogRestore(staged.id, { candidateText: staged.stateText });
    return { scope: result.scope, text: staged.stateText };
  }, playlist('Winning restored playlist'));
}

test('a stale legacy tab cannot report success for a small restore when it missed the scope notification', async ({ page, context }) => {
  await primeLegacyTab(page, { notifications: false });
  await page.goto('/#settings');
  await expect(page.getByRole('button', { name: 'Original legacy playlist', exact: true })).toBeVisible();
  const peer = await context.newPage();
  try {
    const winning = await commitFromPeer(peer);
    await page.locator('#restore-file').setInputFiles({
      name: 'stale-small-restore.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ version: 1, playlists: [playlist('Rejected stale small restore')] })),
    });
    await expect(page.locator('#toast')).toHaveText('Another tab updated the cloud library. Reload this page and try again.');
    await expect(page.getByRole('button', { name: 'Rejected stale small restore', exact: true })).toHaveCount(0);
    const observed = await peer.evaluate(async ({ legacyScope, scope }) => {
      const catalog = await import('/cloud-catalog.js');
      const { readStateAtScope, readStateTextAtScope } = await import('/library.js');
      return { active: (await catalog.readCloudCatalogState()).scope, previous: readStateAtScope(legacyScope).playlists,
        candidate: readStateTextAtScope(scope) };
    }, { legacyScope, scope: winning.scope });
    expect(observed).toEqual({ active: winning.scope, previous: [playlist('Original legacy playlist')], candidate: winning.text });
  } finally {
    await peer.close();
  }
});

test('a pending manual WebDAV upload is stopped if its tab hears a scope change before its old control read resolves', async ({ page, context }) => {
  const source = { id: '2a56250b-259a-44a4-a98c-bbda66185635', name: 'Restore Race DAV', type: 'webdav' };
  const uploads = [];
  await primeLegacyTab(page);
  await page.route('**/api/sources', route => route.fulfill({ json: { sources: [source] } }));
  await page.route('**/api/sources/' + source.id + '/list?**', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/sources/' + source.id + '/backup', route => {
    uploads.push({ method: route.request().method(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/#sources');
  await page.locator('.source-card').filter({ hasText: source.name }).click();
  await page.locator('#content [data-action="cloud-playlists"]').click();
  const dialog = page.getByRole('dialog');
  const peer = await context.newPage();
  try {
    await page.evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction;
      const completion = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
      let captured = false;
      IDBDatabase.prototype.transaction = function (names, mode, ...options) {
        const result = transaction.call(this, names, mode, ...options);
        if (!captured && this.name === 'groovebox.cloud-catalog' && mode === 'readonly' &&
            Array.from(result.objectStoreNames).join(',') === 'catalogControl') {
          captured = true;
          Object.defineProperty(result, 'oncomplete', {
            set(handler) {
              completion.set.call(result, event => {
                window.releaseOldCatalogControl = () => handler.call(result, event);
              });
            },
            get() { return completion.get.call(result); },
          });
        }
        return result;
      };
      window.releaseHeldCatalogControl = () => {
        IDBDatabase.prototype.transaction = transaction;
        window.releaseOldCatalogControl?.();
      };
    });
    await dialog.locator('[data-action="sync-upload"]').click();
    await dialog.locator('[data-action="confirm-sync-upload"]').click();
    await expect.poll(() => page.evaluate(() => typeof window.releaseOldCatalogControl)).toBe('function');
    await commitFromPeer(peer);
    await expect(page.locator('[data-catalog-recovery-notice]')).toContainText('Another tab restored a new version.');
  } finally {
    await page.evaluate(() => window.releaseHeldCatalogControl?.());
    await peer.close();
  }
  await expect(dialog.locator('[data-sync-status]')).toContainText('The settings scope changed while checking');
  expect(uploads).toEqual([]);
});
