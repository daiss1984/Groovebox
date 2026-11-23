import { expect, test } from '@playwright/test';

const initialIndex = 36;
const nowPanel = page => page.locator('#now');
const currentRow = page => nowPanel(page).locator('.queue-row.current');
const toggleQueue = page => page.locator('.player [data-action=queue-panel]');

async function loadLongQueue(page) {
  await page.addInitScript(index => {
    const queue = Array.from({ length: 52 }, (_, offset) => offset % 2 === 0 ? 'demo-1' : 'demo-2');
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ queue, index, position: 7 }));
  }, initialIndex);
  await page.goto('/');
  await expect(nowPanel(page).locator('.queue-row')).toHaveCount(52);
}

async function expectCurrentQueueOccurrence(page, index, inViewport = true) {
  const row = currentRow(page);
  await expect(row.locator('.track-main')).toHaveAttribute('data-index', String(index));
  await expect(row.locator('.track-main')).toHaveAttribute('aria-current', 'true');
  if (inViewport) await expect(row).toBeInViewport({ ratio: 0.9 });
}

test('reveals the current duplicate when opening the queue and preserves manually browsed rows', async ({ page }) => {
  await loadLongQueue(page);
  const panel = nowPanel(page);
  const list = panel.getByRole('region', { name: '播放队列', exact: true });
  const trackNames = panel.locator('.queue-row .track-name');
  await expect(trackNames.first()).toHaveText('After Hours');
  await expectCurrentQueueOccurrence(page, initialIndex);
  await expect(currentRow(page).locator('.track-name')).toHaveText('After Hours');
  await expect(panel.getByRole('button', { name: '放大封面', exact: true })).toBeInViewport();
  const order = await trackNames.allTextContents();

  await list.evaluate(element => { element.scrollTop = 110; });
  await expect(currentRow(page)).not.toBeInViewport();
  await page.locator('.player [data-action=next]').press('Enter');
  await expectCurrentQueueOccurrence(page, initialIndex + 1, false);
  await expect(currentRow(page)).not.toBeInViewport();
  expect(await list.evaluate(element => element.scrollTop)).toBe(110);
  const browsedRow = list.locator('.queue-row').nth(4).locator('.track-main');
  await browsedRow.focus();
  await expect(browsedRow).toBeFocused();
  await page.locator('#player-toggle').evaluate(button => button.click());
  await expect(page.locator('#player-toggle')).toHaveAttribute('aria-label', '播放');
  await expect(browsedRow).toBeFocused();

  await toggleQueue(page).press('Enter');
  await expect(panel).toBeHidden();
  await toggleQueue(page).press('Enter');
  await expectCurrentQueueOccurrence(page, initialIndex + 1);
  await page.locator('.player [data-action=next]').press('Enter');
  await expectCurrentQueueOccurrence(page, initialIndex + 2);
  await expect(trackNames).toHaveText(order);

  await panel.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await panel.getByRole('button', { name: '播放队列', exact: true }).press('Enter');
  await expectCurrentQueueOccurrence(page, initialIndex + 2);

  await expect(page.locator('#player-toggle')).toHaveAttribute('aria-label', '暂停');
  await list.focus();
  await list.press('Home');
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0);
  await list.press('Space');
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(50);
  await expect(page.locator('#player-toggle')).toHaveAttribute('aria-label', '暂停');
});

test('reveals the current occurrence when opening the mobile queue @mobile', async ({ page }) => {
  await loadLongQueue(page);
  await expect(nowPanel(page)).toBeHidden();
  await toggleQueue(page).tap();
  await expectCurrentQueueOccurrence(page, initialIndex);
  await expect(currentRow(page).locator('.track-name')).toHaveText('After Hours');
});
