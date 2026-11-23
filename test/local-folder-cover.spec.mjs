import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { updateBuffer } from 'music-metadata';

test.use({ serviceWorkers: 'allow' });

async function scanFolder(page, root, update = false) {
  await page.locator('#import-folder').setInputFiles(root);
  if (update) await page.getByRole('dialog').locator('[data-local-import-action="replace"]').press('Enter');
}

async function expectImage(image, bytes) {
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
  const expected = bytes.toString('base64');
  await expect.poll(async () => await image.evaluate(async element => {
    const response = await fetch(element.src);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(blob);
    });
  }).catch(() => '') === expected).toBe(true);
}

test('shows a scanned album folder cover offline and updates only its own tracks', async ({ page, context }) => {
  const root = await mkdtemp(join(tmpdir(), 'groovebox-folder-cover-'));
  try {
    const album = join(root, '唱片');
    const neighbor = join(root, '其他');
    const nested = join(album, '子目录');
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(neighbor)]);
    const [audio, embedded, jpeg] = await Promise.all(['demo-1.m4a', 'cover-1.jpg', 'cover-2.jpg']
      .map(file => readFile(new URL('../public/assets/' + file, import.meta.url))));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII=', 'base64');
    const writeAudio = async (directory, title, release, picture) => writeFile(join(directory, title + '.m4a'),
      Buffer.from(await updateBuffer(audio, { title, artist: 'Folder fixture', album: release,
        ...(picture && { picture: [{ type: 'Cover (front)', format: 'image/jpeg', data: picture }] }) })));
    await Promise.all([
      writeAudio(album, 'One', 'Sea'), writeAudio(album, 'Two', 'Sea'),
      writeAudio(album, 'Embedded', 'Other', embedded), writeAudio(nested, 'Nested', 'Under Sea'),
      writeAudio(neighbor, 'Neighbor', 'Other folder'), writeFile(join(album, 'cover.png'), png),
      writeFile(join(neighbor, 'cover.JPG'), '<svg/>'),
    ]);

    await page.goto('/#offline');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const content = page.locator('#content');
    const track = name => content.getByRole('button', { name: name + ' Folder fixture', exact: true });
    const image = name => track(name).locator('img');
    const scan = update => scanFolder(page, root, update);
    const player = page.locator('#audio');
    await scan();
    await expect(content.locator('tbody tr')).toHaveCount(5);
    await expectImage(image('One'), png);
    await expectImage(image('Two'), png);
    await expectImage(image('Embedded'), embedded);
    await expect(image('Nested')).toHaveCount(0);
    await expect(image('Neighbor')).toHaveCount(0);

    await page.locator('#sidebar [data-nav=albums]').press('Enter');
    const release = content.locator('button.card').filter({ has: page.getByText('Sea', { exact: true }) });
    await expectImage(release.locator('img'), png);
    await release.press('Enter');
    await expectImage(content.locator('.album-detail-cover img'), png);
    await track('One').press('Enter');
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
    const source = await player.evaluate(element => element.currentSrc);

    await unlink(join(album, 'cover.png'));
    await writeFile(join(album, 'cover.jpg'), jpeg);
    await scan(true);
    await expectImage(image('One'), jpeg);
    await expectImage(page.locator('#player-art img'), jpeg);
    expect(await player.evaluate(element => ({ src: element.currentSrc, paused: element.paused }))).toEqual({ src: source, paused: false });

    await context.setOffline(true);
    await page.reload();
    await expectImage(image('One'), jpeg);
    await expectImage(image('Two'), jpeg);
    await track('Two').press('Enter');
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);

    await unlink(join(album, 'cover.jpg'));
    await scan(true);
    await expect(image('One')).toHaveCount(0);
    await expect(image('Two')).toHaveCount(0);
    await expect(page.locator('#player-art img')).toHaveCount(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses the matching artist photo from a scanned source and restores it offline', async ({ page, context }) => {
  const root = await mkdtemp(join(tmpdir(), 'groovebox-artist-photo-'));
  try {
    const artistFolder = join(root, 'artist');
    const otherFolder = join(root, 'release');
    await Promise.all([mkdir(artistFolder), mkdir(otherFolder)]);
    const [audio, portrait, other] = await Promise.all(['demo-1.m4a', 'cover-1.jpg', 'cover-2.jpg']
      .map(file => readFile(new URL('../public/assets/' + file, import.meta.url))));
    const artist = '青禾声部';
    const neighbor = '其他艺人';
    const makeSong = async name => writeFile(join(otherFolder, name + '.m4a'),
      Buffer.from(await updateBuffer(audio, { title: name + '录音', artist: name, album: '原声测试' })));
    const portraitPath = join(artistFolder, artist + '.JPG');
    await Promise.all([makeSong(artist), makeSong(neighbor), writeFile(portraitPath, portrait),
      writeFile(join(otherFolder, neighbor + '.jpg'), other)]);

    await page.goto('/#offline');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const scan = update => scanFolder(page, root, update);
    await scan();
    await expect(page.locator('#content tbody tr')).toHaveCount(2);
    await page.locator('#sidebar [data-nav=artists]').press('Enter');
    const card = name => page.locator('#content button.card').filter({ has: page.getByText(name, { exact: true }) });
    await expectImage(card(artist).locator('img'), portrait);
    await expect(card(neighbor).locator('img')).toHaveCount(0);
    await card(artist).press('Enter');
    const artistImage = page.locator('#content .artist-portrait img');
    await expectImage(artistImage, portrait);

    await context.setOffline(true);
    await page.reload();
    await expectImage(artistImage, portrait);
    await unlink(portraitPath);
    await writeFile(join(artistFolder, artist + '.jpeg'), other);
    await scan(true);
    await expectImage(artistImage, other);
    await unlink(join(artistFolder, artist + '.jpeg'));
    await writeFile(join(artistFolder, artist + '.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await scan(true);
    await expect(artistImage).toHaveCount(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
