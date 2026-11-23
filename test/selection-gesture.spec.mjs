import { expect, test } from '@playwright/test';

async function verifyHoldSelection(page, pointerType) {
  await page.addInitScript(() => {
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      settings: { demos: false },
      tracks: [
        { id: 'first', title: 'First recording', artist: 'Fixture Artist', genres: ['Jazz'], src: '/api/baidu/stream?id=101' },
        { id: 'second', title: 'Second recording', artist: 'Fixture Artist', genres: ['Jazz'], src: '/api/baidu/stream?id=102' },
      ],
    }));
  });

  await page.goto('/#genres');
  const content = page.locator('#content');
  await content.getByRole('button', { name: /Jazz/ }).press('Enter');
  await expect(content.getByRole('heading', { name: 'Jazz', exact: true })).toBeVisible();
  await page.clock.install();
  const row = content.getByRole('button', { name: 'Second recording Fixture Artist' });
  const pointer = { pointerId: 1, isPrimary: true, pointerType, button: 0, clientX: 45, clientY: 100 };
  await row.dispatchEvent('pointerdown', pointer);
  await row.dispatchEvent('pointermove', { ...pointer, clientY: 140 });
  await page.clock.runFor(600);
  await expect(content.getByRole('button', { name: '结束多选' })).toHaveCount(0);
  await row.dispatchEvent('pointerup', pointer);
  await row.dispatchEvent('pointerdown', pointer);
  await page.clock.runFor(600);

  const selected = content.getByRole('checkbox', { name: '选择 Second recording', exact: true });
  await expect(selected).toBeChecked();
  await expect(selected).toBeFocused();
  await expect(content.getByRole('checkbox', { name: '选择 First recording', exact: true })).not.toBeChecked();
  await row.dispatchEvent('pointerup', pointer);
  await row.dispatchEvent('click', { detail: 1 });
  await expect(selected).toBeChecked();
  await expect(page.locator('#player-title')).toHaveText('选择一首歌曲');
  await row.press('Enter');
  await expect(selected).not.toBeChecked();
  await content.getByRole('button', { name: '结束多选' }).press('Enter');
  await expect(content.getByRole('button', { name: '多选' })).toBeVisible();
}

test('hold and release selects a song without playing it and a drag cancels the gesture', ({ page }) => verifyHoldSelection(page, 'mouse'));
test('a held touch selects from genre results without interfering with a swipe @mobile', ({ page }) => verifyHoldSelection(page, 'touch'));
