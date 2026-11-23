import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const picture = '/api/metadata/artwork/image?id=55bbb954-8596-493b-a84f-9e12ea25295f';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
const jpeg = await readFile(new URL('../public/assets/cover-1.jpg', import.meta.url));
const privateJpeg = await readFile(new URL('../public/assets/cover-2.jpg', import.meta.url));

async function save(page, track, coverSource, coverIdentity) {
  await page.evaluate(async ({ track, coverSource, coverIdentity }) => {
    const offline = await import('/offline.js');
    const blob = await (await fetch('/assets/demo-1.m4a')).blob();
    await offline.saveOfflineTrack(track, blob, { coverSource, coverIdentity });
  }, { track, coverSource, coverIdentity });
}

async function savedBytes(page, id, source) {
  return page.evaluate(async ({ id, source }) => {
    const offline = await import('/offline.js');
    await offline.hydrateOffline();
    const audio = await offline.readOfflineBlob(id);
    const cover = await new Promise(resolve => {
      const result = offline.offlineFolderCover(id, source, () => resolve(offline.offlineFolderCover(id, source)));
      if (result !== null) resolve(result);
    });
    const hash = async blob => blob && Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
      .map(value => value.toString(16).padStart(2, '0')).join('');
    return { audio: await hash(audio), cover: cover && await hash(await (await fetch(cover)).blob()) };
  }, { id, source });
}

test('stores the exact custom cover beside original audio and retains both through an offline reload', async ({ page, context }) => {
  let requested = 0;
  await page.route('**' + picture, route => {
    requested++;
    return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
  });
  await page.goto('/');
  const track = { id: 'baidu:offline-custom', provider: 'baidu' };
  const identity = 'custom-artwork:22bd0c38-9efd-4cbe-b734-ce2a4800c493:["album","fixture album","fixture artist"]';
  await save(page, track, picture, identity);
  expect(requested).toBe(1);
  expect(await savedBytes(page, track.id, identity)).toEqual({ audio: digest(audio), cover: digest(jpeg) });
  expect((await savedBytes(page, track.id, picture)).cover).toBeUndefined();
  await page.reload();
  await context.setOffline(true);
  expect(await savedBytes(page, track.id, identity)).toEqual({ audio: digest(audio), cover: digest(jpeg) });
  await page.evaluate(async id => (await import('/offline.js')).removeOffline(id), track.id);
  const removed = await page.evaluate(async ({ id, source }) => {
    const offline = await import('/offline.js');
    return { audio: offline.hasOffline(id), cover: offline.offlineFolderCover(id, source) };
  }, { id: track.id, source: identity });
  expect(removed).toEqual({ audio: false, cover: undefined });
  expect(requested).toBe(1);
});

test('keeps the authenticated source cover ahead of the configured cover when saving audio', async ({ page }) => {
  const sourceId = '54c2cd19-aec8-4652-bd38-70d80ff096f7';
  const folder = '/api/sources/' + sourceId + '/cover?id=private-picture';
  const requests = [];
  await page.route('**' + picture, route => { requests.push('custom'); return route.fulfill({ contentType: 'image/jpeg', body: jpeg }); });
  await page.route('**' + folder, route => { requests.push('private'); return route.fulfill({ contentType: 'image/jpeg', body: privateJpeg }); });
  await page.goto('/');
  const track = { id: sourceId + ':song', provider: 'webdav', folderCover: folder };
  await save(page, track, picture);
  expect(requests).toEqual(['private']);
  expect(await savedBytes(page, track.id, folder)).toEqual({ audio: digest(audio), cover: digest(privateJpeg) });
});

test('never fetches an arbitrary optional cover URL and keeps audio when the custom image has an invalid body', async ({ page }) => {
  const invalid = ['https://cover.invalid/secret', '//cover.invalid/secret', '/api/baidu/cover?secret=unapproved', picture + '&extra=1'];
  const rejectedRequests = [];
  await page.route(url => invalid.includes(url.href) || invalid.includes(url.pathname + url.search), route => {
    rejectedRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto('/');
  for (const [index, source] of invalid.entries()) {
    const track = { id: 'baidu:invalid-cover-' + index, provider: 'baidu' };
    await save(page, track, source);
    expect(await savedBytes(page, track.id, source)).toEqual({ audio: digest(audio), cover: undefined });
  }
  expect(rejectedRequests).toEqual([]);
  await page.route('**' + picture, route => route.fulfill({ contentType: 'image/png', body: '<svg xmlns="http://www.w3.org/2000/svg" />' }));
  const track = { id: 'baidu:invalid-raster', provider: 'baidu' };
  await save(page, track, picture);
  expect(await savedBytes(page, track.id, picture)).toEqual({ audio: digest(audio), cover: undefined });
});
