import { expect, test } from '@playwright/test';

const stateKey = 'groovebox.state.v1';
const original = ['After Hours', 'Blue Static', 'Soft Signal', 'Paper Planes', 'Golden Haze', 'Slow Motion', 'Nocturne', 'Last Light'];
const alphabetical = [...original].sort();

test('starts a truly new song library in title order and keeps an explicit manual order after reload', async ({ page }) => {
  await page.goto('/#songs');
  const sort = page.locator('#sort');
  const titles = page.locator('#content tbody .track-name');
  await expect(sort).toHaveValue('title');
  await expect(titles).toHaveText(alphabetical);
  await page.locator('#content').getByRole('button', { name: 'Blue Static Nova Lane', exact: true }).click();
  await expect(page.locator('#now .queue-list .track-name')).toHaveText(alphabetical);
  await sort.selectOption('default');
  await expect(titles).toHaveText(original);
  await page.reload();
  await expect(sort).toHaveValue('default');
  await expect(titles).toHaveText(original);
});

for (const legacy of [
  { settings: {}, playlists: [] },
  { settings: { sort: 'default' } },
  { settings: { sort: 'unsupported-old-order' } },
]) test('retains legacy song order for ' + JSON.stringify(legacy), async ({ page }) => {
  await page.addInitScript(({ key, legacy }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(legacy));
  }, { key: stateKey, legacy });
  await page.goto('/#songs');
  await expect(page.locator('#sort')).toHaveValue('default');
  await expect(page.locator('#content tbody .track-name')).toHaveText(original);
});
