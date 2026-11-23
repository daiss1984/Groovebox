import { expect, test } from '@playwright/test';

const rows = page => page.locator('#content tr[data-track]');
const started = page => expect.poll(() => page.locator('#audio').evaluate(audio =>
  !audio.paused && audio.currentTime > 0.05)).toBe(true);

async function holdSourceDiscovery(page) {
  const pending = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route('**/api/sources', async route => {
    pending.resolve();
    await release.promise;
    await route.fulfill({ json: { sources: [{ id: 'fixture-webdav', type: 'webdav', name: 'Discovered source' }] } });
  });
  return { pending: pending.promise, release: release.resolve };
}

test('retains the focused track when startup source discovery rebuilds the songs list', async ({ page }) => {
  const { pending, release } = await holdSourceDiscovery(page);
  try {
    await page.goto('/#songs');
    await pending;
    const track = rows(page).filter({ hasText: 'Blue Static' }).locator('.track-main');
    await track.focus();
    await expect(track).toBeFocused();
    await track.evaluate(element => { window.focusedTrackBeforeDiscovery = element; });

    release();
    await expect(page.locator('#source-indicator')).toHaveClass('is-connected');
    expect(await track.evaluate(element => window.focusedTrackBeforeDiscovery !== element)).toBe(true);
    await expect(track).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#player-title')).toHaveText('Blue Static');
    await started(page);
  } finally {
    release();
  }
});

for (const rememberPlaylistPosition of [true, false]) {
  test(`retains duplicate playlist row keyboard focus with occurrence metadata ${rememberPlaylistPosition ? 'enabled' : 'disabled'}`, async ({ page }) => {
    await page.addInitScript(remember => {
      localStorage.setItem('groovebox.state.v1', JSON.stringify({
        settings: { rememberPlaylistPosition: remember },
        playlists: [{ id: 'focus-list', name: 'Duplicate tracks', tracks: ['demo-2', 'demo-1', 'demo-2'] }],
      }));
    }, rememberPlaylistPosition);
    await page.goto('/#playlist%2Ffocus-list');
    await expect(page.locator('#player-title')).toHaveText('After Hours');
    const duplicateRows = rows(page).filter({ hasText: 'Blue Static' });
    await expect(duplicateRows).toHaveCount(2);
    const occurrence = await duplicateRows.last().getAttribute('data-playlist-occurrence');
    expect(Boolean(occurrence)).toBe(rememberPlaylistPosition);
    const duplicate = duplicateRows.last().locator('.track-main');
    await duplicate.focus();
    const favorite = rows(page).filter({ hasText: 'After Hours' }).locator('[data-action=favorite]');
    // Exercise the normal favorite rerender without a physical mouse taking focus first.
    const removed = await favorite.evaluate(button => {
      const focused = document.activeElement;
      button.click();
      return !focused.isConnected;
    });
    expect(removed).toBe(true);
    await expect(favorite).toHaveClass(/\bactive\b/);
    await expect(duplicate).toBeFocused();
    expect(await duplicateRows.last().getAttribute('data-playlist-occurrence')).toBe(occurrence);

    await page.keyboard.press('Enter');
    await expect(page.locator('#now .queue-row.current .track-main')).toHaveAttribute('data-index', '2');
    await expect(page.locator('#player-title')).toHaveText('Blue Static');
    await started(page);
  });
}

test('does not inherit track focus when navigation shows the same track on another route', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      playlists: [{ id: 'focus-destination', name: 'Focus destination', tracks: ['demo-2'] }],
    }));
  });
  await page.goto('/#songs');
  const track = rows(page).filter({ hasText: 'Blue Static' }).locator('.track-main');
  await track.evaluate(button => {
    button.focus();
    // Navigate without a pointer taking the focused track's place before rerendering.
    document.querySelector('#sidebar [data-nav="playlist/focus-destination"]').click();
  });
  await expect(page.getByRole('heading', { name: 'Focus destination', exact: true })).toBeVisible();
  await expect(track).not.toBeFocused();
});

test('leaves the open track menu focused while source discovery rebuilds the rows', async ({ page }) => {
  const { pending, release } = await holdSourceDiscovery(page);
  try {
    await page.goto('/#songs');
    await pending;
    await rows(page).filter({ hasText: 'Blue Static' }).locator('[data-action=track-menu]').press('Enter');
    const menu = page.getByRole('dialog');
    const enqueue = menu.locator('[data-action=enqueue]');
    await enqueue.focus();
    await expect(enqueue).toBeFocused();
    release();
    await expect(page.locator('#source-indicator')).toHaveClass('is-connected');
    await expect(enqueue).toBeFocused();
  } finally {
    release();
  }
});
