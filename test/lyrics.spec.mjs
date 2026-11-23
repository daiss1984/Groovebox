import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const currentTime = (page) => page.locator('#audio').evaluate((audio) => audio.currentTime);

async function seekSeconds(page, seconds) {
  const duration = await page.locator('#audio').evaluate((audio) => audio.duration);
  await page.getByRole('slider', { name: '播放进度' }).fill(String(Math.round(seconds * 1000 / duration)));
}

test('highlights enhanced LRC words on forward and backward seeks', async ({ page }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '你的云端唱片室' })).toBeVisible();
  await page.locator('#import-files').setInputFiles([
    { name: '测试艺人 - 逐字录音.m4a', mimeType: 'audio/mp4', buffer: audio },
    {
      name: '测试艺人 - 逐字录音.lrc',
      mimeType: 'text/plain',
      buffer: Buffer.from('[00:02.00]<00:02.00>初春 <00:04.00>清风 <00:07.00>细雨' +
        '\n[00:02.00]Early spring\n[00:02.00]Primavera temprana\n[00:12.00]下一行'),
    },
  ]);
  await page.locator('#sidebar [data-nav="songs"]').press('Enter');
  await page.getByRole('table').getByRole('button', { name: '逐字录音 测试艺人', exact: true }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText('逐字录音');
  await expect.poll(async () => currentTime(page)).toBeGreaterThan(0.1);
  await page.locator('#player-toggle').press('Enter');

  const now = page.locator('#now');
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  const line = now.getByRole('button', { name: '初春 清风 细雨' });
  expect(await line.locator('.lyric-translation').textContent()).toBe('Early spring\nPrimavera temprana');
  const activeWord = line.locator('.current-word');
  await seekSeconds(page, 5);
  await expect(line).toHaveClass(/\bcurrent\b/);
  await expect(activeWord).toBeVisible();
  await expect(activeWord).toHaveText('清风');
  await expect(activeWord).toHaveCSS('text-decoration-line', 'none');
  await expect.poll(() => activeWord.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(.5);
  await expect.poll(() => activeWord.evaluate(element => Number(getComputedStyle(element).opacity))).toBeLessThan(1);

  await seekSeconds(page, 9);
  await expect(activeWord).toHaveText('细雨');
  await expect(line.locator('.played')).toHaveCount(3);

  await seekSeconds(page, 5);
  await expect(activeWord).toHaveText('清风');
  await expect(line.locator('.played')).toHaveCount(2);

  await line.press('Enter');
  await expect.poll(() => currentTime(page)).toBe(2);
  await expect(line).toHaveClass(/\bcurrent\b/);
  await expect(activeWord).toHaveText('初春');
});

test('uses explicit YRC word durations and clears the current word during a silent gap', async ({ page }) => {
  const audio = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.goto('/#songs');
  await page.locator('#import-files').setInputFiles([
    { name: '艺人 - 定时歌词.m4a', mimeType: 'audio/mp4', buffer: audio },
    { name: '艺人 - 定时歌词.yrc', mimeType: 'text/plain', buffer: Buffer.from('[2000,6000](2000,850,0)春 (5000,850,0)夜') },
  ]);
  await page.getByRole('button', { name: '定时歌词 艺人' }).press('Enter');
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.1);
  await page.locator('#player-toggle').press('Enter');
  await page.locator('#now').getByRole('button', { name: '歌词', exact: true }).press('Enter');
  const line = page.locator('#now').getByRole('button', { name: '春 夜' });
  const activeWord = line.locator('.current-word');
  await seekSeconds(page, 2.4);
  await expect(activeWord).toHaveText('春');
  await seekSeconds(page, 4);
  await expect(activeWord).toHaveCount(0);
  await expect(line.locator('.played')).toHaveCount(1);
  await seekSeconds(page, 5.4);
  await expect(activeWord).toHaveText('夜');
  await seekSeconds(page, 6.5);
  await expect(activeWord).toHaveCount(0);
  await expect(line.locator('.played')).toHaveCount(2);
});

test('requests online lyrics only on explicit submit and renders matched timed lines', async ({ page }) => {
  const lookups = [];
  await page.route(/^https:\/\/lrclib\.net\/api\/get(?:\?|$)/, async route => {
    const request = route.request();
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Lrclib-Client',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    lookups.push({ method: request.method(), params: Object.fromEntries(new URL(request.url()).searchParams) });
    await route.fulfill({
      headers,
      json: { instrumental: false, syncedLyrics: '[00:01.00]第一行结果\n[00:06.00]第二行结果', plainLyrics: '第三行纯文本' },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '立即播放' }).press('Enter');
  await expect(page.locator('#player-title')).toHaveText('After Hours');
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.1);
  const now = page.locator('#now');
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await expect(now.getByText('暂无歌词')).toBeVisible();
  expect(lookups).toHaveLength(0);

  await now.getByRole('button', { name: '在线匹配' }).press('Enter');
  const dialog = page.locator('#dialog');
  await expect(dialog.getByText(/发送给 LRCLIB/)).toBeVisible();
  await expect(dialog.getByLabel('歌曲名')).toHaveValue('After Hours');
  await expect(dialog.getByLabel('艺人')).toHaveValue('Velvet Atlas');
  await expect(dialog.getByLabel('专辑（可选）')).toHaveValue('Midnight Tape');
  await dialog.getByLabel('歌曲名').fill('晚风 & 雨');
  expect(lookups).toHaveLength(0);

  await dialog.getByRole('button', { name: '查找歌词' }).press('Enter');
  await expect(dialog).toBeHidden();
  await expect(now.getByRole('button', { name: '第一行结果' })).toBeVisible();
  const secondLine = now.getByRole('button', { name: '第二行结果' });
  await secondLine.press('Enter');
  await expect(secondLine).toHaveClass(/\bcurrent\b/);
  await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(6);
  await expect(now.getByText('第三行纯文本')).toHaveCount(0);
  expect(lookups).toEqual([{
    method: 'GET',
    params: { track_name: '晚风 & 雨', artist_name: 'Velvet Atlas', album_name: 'Midnight Tape', duration: '164' },
  }]);

  await page.reload();
  await expect(page.locator('#player-title')).toHaveText('After Hours');
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await expect(now.getByRole('button', { name: '第二行结果' })).toBeVisible();
  expect(lookups).toHaveLength(1);
});

test('displays every server-provided translation on its own row with synchronized words', async ({ page }) => {
  const clip = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.addInitScript(() => {
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      tracks: [{
        id: 'jellyfin-test-song', title: 'Translated track', artist: 'Test artist', provider: 'jellyfin',
        src: '/api/sources/mock/stream?id=track', lyrics: '/api/sources/mock/stream?id=lyrics',
      }],
    }));
  });
  await page.route('**/api/sources/mock/stream?id=track', route => route.fulfill({ body: clip, contentType: 'audio/mp4' }));
  await page.route('**/api/sources/mock/stream?id=lyrics', route => route.fulfill({ json: {
    lines: [{ time: 3, text: 'Good morning', translation: '早上好\nBuenos días\nBonjour',
      words: [{ time: 3, text: 'Good ' }, { time: 4, text: 'morning' }] }],
  } }));
  await page.goto('/#songs');
  await page.getByRole('button', { name: 'Translated track Test artist' }).press('Enter');
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.1);
  const now = page.locator('#now');
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  const translation = now.locator('.lyric-translation');
  await expect(translation).toBeVisible();
  expect(await translation.textContent()).toBe('早上好\nBuenos días\nBonjour');
  const tops = await translation.evaluate(element => {
    const value = element.firstChild.textContent;
    return [0, value.indexOf('Buenos'), value.indexOf('Bonjour')].map(index => {
      const range = document.createRange();
      range.setStart(element.firstChild, index);
      range.setEnd(element.firstChild, index + 1);
      return range.getBoundingClientRect().top;
    });
  });
  expect(tops[0]).toBeLessThan(tops[1]);
  expect(tops[1]).toBeLessThan(tops[2]);
  await now.getByRole('button', { name: /Good morning/ }).press('Enter');
  await expect(now.locator('.current-word')).toHaveText('Good');
});

test('only sends missing tracks to the automatic online lyric matcher after opt-in', async ({ page }) => {
  const clip = await readFile(new URL('../public/assets/demo-1.m4a', import.meta.url));
  await page.addInitScript(() => {
    const source = '/api/sources/mock/stream?id=';
    const base = {
      provider: 'jellyfin', artist: 'Fixture Artist', album: 'Fixture Album', albumIsFallback: false, duration: 164,
    };
    localStorage.setItem('groovebox.state.v1', JSON.stringify({
      tracks: [
        { ...base, id: 'provided', title: 'Provided fixture', src: source + 'track1', lyrics: source + 'supplied-lyrics' },
        { ...base, id: 'missing', title: 'Missing fixture', src: source + 'track2', lyrics: source + 'missing-lyrics' },
        { ...base, id: 'plain', title: 'Plain fixture', src: source + 'track3' },
        { ...base, id: 'embedded', title: 'Embedded fixture', src: source + 'track4', lyrics: [{ time: 1, text: 'Embedded lyric' }] },
        { ...base, id: 'fallback', title: 'Fallback fixture', album: 'Private server label', albumIsFallback: true, src: source + 'track5' },
      ],
    }));
  });
  const lookups = [];
  const supplied = [];
  await page.route('**/api/sources/mock/stream?*', route => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (id === 'supplied-lyrics') {
      supplied.push(id);
      return route.fulfill({ contentType: 'text/plain', body: 'Lyrics supplied by the media server' });
    }
    if (id === 'missing-lyrics') {
      supplied.push(id);
      return route.fulfill({ status: 404 });
    }
    return route.fulfill({ body: clip, contentType: 'audio/mp4' });
  });
  await page.route(/^https:\/\/lrclib\.net\/api\/get(?:\?|$)/, route => {
    const request = route.request();
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Lrclib-Client',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const params = Object.fromEntries(new URL(request.url()).searchParams);
    lookups.push(params);
    expect(request.headers().cookie).toBeUndefined();
    return route.fulfill({ headers, json: params.track_name === 'Missing fixture'
      ? { syncedLyrics: '[00:01.00]Automatically synced line', plainLyrics: 'Unused plain line' }
      : { syncedLyrics: null, plainLyrics: 'Automatically matched plain lyrics' } });
  });

  const settings = page.locator('#sidebar [data-nav="settings"]');
  const songs = page.locator('#sidebar [data-nav="songs"]');
  const play = title => page.locator('#content').getByRole('button', { name: new RegExp(title) }).press('Enter');
  const now = page.locator('#now');
  await page.goto('/#songs');
  await play('Plain fixture');
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await expect(now.getByText('暂无歌词')).toBeVisible();
  expect(lookups).toHaveLength(0);

  await play('Embedded fixture');
  await expect(now.getByRole('button', { name: 'Embedded lyric' })).toBeVisible();
  await settings.press('Enter');
  const enable = page.getByLabel('缺少歌词时自动在线匹配');
  await expect(enable).not.toBeChecked();
  await enable.press('Space');
  await songs.press('Enter');
  await play('Provided fixture');
  await expect(now.getByText('Lyrics supplied by the media server')).toBeVisible();
  expect(supplied).toEqual(['supplied-lyrics']);
  expect(lookups).toHaveLength(0);

  await now.getByRole('button', { name: '播放队列' }).press('Enter');
  await play('Missing fixture');
  await expect.poll(() => supplied).toEqual(['supplied-lyrics', 'missing-lyrics']);
  await expect.poll(() => lookups).toHaveLength(1);
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await expect(now.getByRole('button', { name: 'Automatically synced line' })).toBeVisible();
  await play('Plain fixture');
  await expect(now.getByText('Automatically matched plain lyrics')).toBeVisible();
  await play('Missing fixture');
  await expect(now.getByRole('button', { name: 'Automatically synced line' })).toBeVisible();
  expect(lookups).toEqual(['Missing fixture', 'Plain fixture'].map(track_name => ({
    track_name, artist_name: 'Fixture Artist', album_name: 'Fixture Album', duration: '164',
  })));
  await play('Fallback fixture');
  await expect.poll(() => lookups.length).toBe(3);
  expect(lookups.at(-1)).toEqual({ track_name: 'Fallback fixture', artist_name: 'Fixture Artist', duration: '164' });
});

const lyricCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Lrclib-Client',
  'Access-Control-Expose-Headers': 'Retry-After',
};
const wordSync = `version: "1.0"
metadata:
  title: Fixture
  artist: Fixture Artist
lines:
  - text: "初春 清风"
    start_ms: 2000
    words:
      - text: "初春 "
        start_ms: 2000
        end_ms: 2800
      - text: 清风
        start_ms: 4000
        end_ms: 5000
`;

test('offers related online versions after an exact miss and lets the user replace the match', async ({ page }) => {
  const requests = [];
  await page.route(/^https:\/\/lrclib\.net\/api\/(?:get|search)\?/, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: lyricCors });
    const url = new URL(route.request().url());
    requests.push([url.pathname, Object.fromEntries(url.searchParams)]);
    if (url.pathname === '/api/search' && url.searchParams.get('track_name') === 'Corrected track') {
      return route.fulfill({ headers: lyricCors, json: [{
        trackName: 'Corrected track', artistName: 'Velvet Atlas', albumName: 'Remastered',
        duration: 164, syncedLyrics: '[00:03.00]Replacement online lyric',
      }] });
    }
    if (url.pathname === '/api/search') return route.fulfill({ headers: lyricCors, json: [
      { trackName: 'After Hours', artistName: 'Velvet Atlas', albumName: 'Studio Take', duration: 165, plainLyrics: 'Studio candidate' },
      { trackName: 'After Hours', artistName: 'Velvet Atlas', albumName: 'Live Take', duration: 190, plainLyrics: 'Selected live candidate' },
      { trackName: 'After Hours', artistName: 'Velvet Atlas', albumName: 'Instrumental Take', instrumental: true, duration: 164 },
    ] });
    return route.fulfill({ status: 404, headers: lyricCors });
  });
  await page.goto('/#songs');
  await page.locator('#content').getByRole('button', { name: 'After Hours Velvet Atlas' }).press('Enter');
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.1);
  const now = page.locator('#now');
  const dialog = page.locator('#dialog');
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await now.getByRole('button', { name: '在线匹配' }).press('Enter');
  await dialog.getByRole('button', { name: '查找歌词' }).press('Enter');
  await expect(dialog.getByText('没有完全匹配的结果，请选择一个版本。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Studio Take.*2:45/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Instrumental Take/ })).toHaveCount(0);
  await expect(now.getByText('Selected live candidate')).toHaveCount(0);
  await dialog.getByRole('button', { name: /Live Take.*3:10/ }).press('Enter');
  await expect(dialog).toBeHidden();
  await expect(now.getByText('Selected live candidate')).toBeVisible();
  expect(requests).toEqual([
    ['/api/get', { track_name: 'After Hours', artist_name: 'Velvet Atlas', album_name: 'Midnight Tape', duration: '164' }],
    ['/api/search', { track_name: 'After Hours', artist_name: 'Velvet Atlas' }],
  ]);
  await now.getByRole('button', { name: '浏览其他歌词版本' }).press('Enter');
  await dialog.getByLabel('歌曲名').fill('Corrected track');
  await dialog.getByRole('button', { name: '查找歌词' }).press('Enter');
  await expect(now.getByText('Selected live candidate')).toBeVisible();
  await dialog.getByRole('button', { name: /Remastered/ }).press('Enter');
  await expect(now.getByRole('button', { name: 'Replacement online lyric' })).toBeVisible();
  await expect(now.getByText('Selected live candidate')).toHaveCount(0);
  expect(requests.slice(2)).toEqual([['/api/search', { track_name: 'Corrected track', artist_name: 'Velvet Atlas' }]]);
});

for (const mobile of [false, true]) {
  test('displays and retains the online Lyricsfile word timing' + (mobile ? ' @mobile' : ''), async ({ page }) => {
    let lookups = 0;
    await page.route(/^https:\/\/lrclib\.net\/api\/get\?/, route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: lyricCors });
      lookups++;
      return route.fulfill({ headers: lyricCors, json: {
        hasWordSync: true, lyricsfile: wordSync, syncedLyrics: null, plainLyrics: null,
      } });
    });
    await page.goto('/#songs');
    await page.locator('#content').getByRole('button', { name: 'After Hours Velvet Atlas' }).press('Enter');
    await expect.poll(() => currentTime(page)).toBeGreaterThan(0.1);
    await page.locator('#player-toggle').press('Enter');
    const open = () => page.locator('#player-art').press('Enter');
    await open();
    const immersive = page.locator('.immersive');
    await immersive.getByRole('button', { name: '在线匹配' }).press('Enter');
    await page.locator('#dialog').getByRole('button', { name: '查找歌词' }).press('Enter');
    const line = immersive.getByRole('button', { name: '初春 清风' });
    await expect(line).toBeVisible();
    await expect(line.locator('[data-word-end]')).toHaveCount(2);
    await line.press('Enter');
    await expect(line.locator('.current-word')).toHaveText('初春');
    expect(lookups).toBe(1);
    await page.reload();
    await expect(page.locator('#player-title')).toHaveText('After Hours');
    await open();
    await expect(line).toBeVisible();
    expect(lookups).toBe(1);
  });
}

test('waits for playback and retries an automatic lyric lookup after the service throttle', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('groovebox.state.v1')) {
      localStorage.setItem('groovebox.state.v1', JSON.stringify({ settings: { autoMatchLyrics: true } }));
    }
  });
  const requests = [];
  await page.route(/^https:\/\/lrclib\.net\/api\/get\?/, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: lyricCors });
    requests.push(Date.now());
    if (requests.length === 1) return route.fulfill({ status: 429, headers: { ...lyricCors, 'Retry-After': '1' } });
    return route.fulfill({ headers: lyricCors, json: { plainLyrics: 'Lyric recovered after the throttle' } });
  });
  await page.goto('/#songs');
  await expect(page.locator('#player-toggle')).toHaveAttribute('aria-label', '播放');
  const now = page.locator('#now');
  await now.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await expect(now.getByText('暂无歌词')).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.locator('#content').getByRole('button', { name: 'After Hours Velvet Atlas' }).press('Enter');
  await expect(now.getByText('Lyric recovered after the throttle')).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1] - requests[0]).toBeGreaterThanOrEqual(1000);
});

test('a manual online match can replace embedded lyrics and switch back without another query', async ({ page }) => {
  await page.addInitScript(() => {
    const key = 'groovebox.state.v1';
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({
      tracks: [{
        id: 'fixture-embedded', title: 'Recorded Version', artist: 'Fixture Ensemble', provider: 'baidu',
        src: '/api/baidu/stream?id=9', duration: 164,
        lyrics: [{ time: 1, text: 'Original embedded lyric' }],
      }],
      settings: { demos: false, autoMatchLyrics: true },
    }));
  });
  await page.route('**/api/baidu/stream?**', async route => {
    const url = new URL('/assets/demo-1.m4a', route.request().url()).href;
    await route.fulfill({ response: await route.fetch({ url }) });
  });
  let lookups = 0;
  await page.route(/^https:\/\/lrclib\.net\/api\/get\?/, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: lyricCors });
    lookups++;
    return route.fulfill({
      headers: lyricCors,
      json: { syncedLyrics: '[00:04.00]Synchronized online replacement' },
    });
  });

  await page.goto('/#songs');
  await page.locator('#content').getByRole('button', { name: 'Recorded Version Fixture Ensemble' }).press('Enter');
  const pane = page.locator('#now');
  const open = () => pane.getByRole('button', { name: '歌词', exact: true }).press('Enter');
  await open();
  await expect(pane.getByRole('button', { name: 'Original embedded lyric' })).toBeVisible();
  expect(lookups).toBe(0);

  await pane.getByRole('button', { name: '在线匹配', exact: true }).press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '查找歌词' }).press('Enter');
  const matched = pane.getByRole('button', { name: 'Synchronized online replacement' });
  await expect(matched).toBeVisible();
  await matched.press('Enter');
  await expect(matched).toHaveClass(/\bcurrent\b/);

  await page.reload();
  await expect(page.locator('#player-title')).toHaveText('Recorded Version');
  await open();
  await expect(matched).toBeVisible();
  await pane.getByRole('button', { name: '使用原歌词' }).press('Enter');
  await expect(pane.getByRole('button', { name: 'Original embedded lyric' })).toBeVisible();
  await page.reload();
  await expect(page.locator('#player-title')).toHaveText('Recorded Version');
  await open();
  await expect(pane.getByRole('button', { name: 'Original embedded lyric' })).toBeVisible();
  await pane.getByRole('button', { name: '使用已匹配歌词' }).press('Enter');
  await expect(matched).toBeVisible();
  expect(lookups).toBe(1);
});
