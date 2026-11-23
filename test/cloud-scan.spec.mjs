import { expect, test } from '@playwright/test';

async function mockBaiduFolders(page, entries) {
  const calls = [];
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    calls.push(path);
    return entries.has(path)
      ? route.fulfill({ json: { items: entries.get(path) } })
      : route.fulfill({ status: 500, json: { error: 'Unexpected request beyond the scan boundary' } });
  });
  return calls;
}

const baiduFolder = path => ({ id: path, name: path.split('/').at(-1), path, folder: true });
const baiduTrack = (path, id, title) => ({
  id, name: title + '.wav', path: path + '/' + title + '.wav', streamUrl: '/api/baidu/stream?id=' + id,
});
const contentButton = (page, name) => page.locator('#content').getByRole('button', { name, exact: true });

test('scans four levels below the default Baidu root and keeps only deeper entries still confirmed by the boundary', async ({ page }) => {
  const one = '/一层';
  const two = one + '/二层';
  const three = two + '/三层';
  const edge = three + '/四层';
  const retained = edge + '/保留目录';
  const removed = edge + '/已移除目录';
  const calls = await mockBaiduFolders(page, new Map([
    ['/', [baiduFolder(one)]], [one, [baiduFolder(two)]], [two, [baiduFolder(three)]], [three, [baiduFolder(edge)]],
    [edge, [baiduFolder(retained), baiduTrack(edge, '44', '第四层歌曲')]],
  ]));
  await page.addInitScript(({ one, two, three, edge, retained, removed }) => {
    const tracks = ['保留的深层歌曲', '删除的深层歌曲', '边界旧歌曲'].map((title, index) => ({
      id: 'baidu:' + (index + 1), provider: 'baidu', title, artist: '测试艺人', src: '/api/baidu/stream?id=' + (index + 1),
    }));
    const scanSnapshots = { baidu: [
      ['/', [one], []], [one, [two], []], [two, [three], []], [three, [edge], []],
      [edge, [retained, removed], ['baidu:3']], [retained, [], ['baidu:1']], [removed, [], ['baidu:2']],
    ] };
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ tracks, scanSnapshots, settings: { demos: false } }));
  }, { one, two, three, edge, retained, removed });

  await page.goto('/#sources');
  await page.locator('[data-action=baidu-source]').press('Enter');
  await expect(page.locator('[data-cloud-scan-scope]')).toHaveText('从 根目录 扫描并向下读取四层。');
  expect(calls.splice(0)).toEqual(['/']);
  await contentButton(page, '重新扫描目录').press('Enter');
  await expect(page.locator('#toast')).toHaveText('扫描完成，共找到 1 首歌曲，发现 2 首曲目已从来源移除');
  expect(calls).toEqual(['/', one, two, three, edge]);
  await page.locator('#sidebar [data-nav=songs]').press('Enter');
  await expect(page.locator('#content').getByRole('button', { name: /第四层歌曲/ })).toBeVisible();
  await expect(contentButton(page, '保留的深层歌曲 测试艺人')).toBeVisible();
  await expect(contentButton(page, '删除的深层歌曲 测试艺人')).toHaveCount(0);
  await expect(contentButton(page, '边界旧歌曲 测试艺人')).toHaveCount(0);
});

test('remembers a configured Baidu start and separately refreshes a deliberately scanned deeper folder', async ({ page }) => {
  const mount = '/收藏资料';
  const start = mount + '/音乐库';
  const descendants = [];
  for (const name of ['第一层', '第二层', '第三层', '第四层', '深层选定目录']) {
    descendants.push((descendants.at(-1) || start) + '/' + name);
  }
  const deeper = descendants.at(-1);
  const other = '/独立目录';
  const entries = new Map([
    ['/', [baiduFolder(mount), baiduFolder(other)]],
    [mount, [baiduFolder(start)]],
    [other, [baiduTrack(other, '50', '独立来源歌曲')]],
    [start, [baiduFolder(descendants[0]), baiduTrack(start, '51', '指定范围歌曲')]],
    ...descendants.slice(0, -1).map((path, index) => [path, [baiduFolder(descendants[index + 1])]]),
    [deeper, [baiduTrack(deeper, '52', '第一次扫描的深层歌曲')]],
  ]);
  const calls = await mockBaiduFolders(page, entries);
  await page.goto('/#sources');
  await page.locator('[data-action=baidu-source]').press('Enter');
  await contentButton(page, '收藏资料').press('Enter');
  await contentButton(page, '音乐库').press('Enter');
  await contentButton(page, '设为扫描起始目录').press('Enter');
  await expect(page.locator('#toast')).toHaveText('扫描起始目录已保存。');

  await page.reload();
  await expect(contentButton(page, '独立目录')).toBeVisible();
  await expect(page.locator('[data-cloud-scan-scope]')).toHaveText('从 /收藏资料/音乐库 扫描并向下读取四层。');
  calls.length = 0;
  await contentButton(page, '扫描并加入曲库').press('Enter');
  await expect(page.locator('#toast')).toHaveText('扫描完成，共找到 1 首歌曲');
  expect(calls).toEqual([start, ...descendants.slice(0, -1)]);

  await contentButton(page, '收藏资料').press('Enter');
  await contentButton(page, '音乐库').press('Enter');
  for (const path of descendants) await contentButton(page, path.split('/').at(-1)).press('Enter');
  calls.length = 0;
  await contentButton(page, '扫描并加入曲库').press('Enter');
  await expect(page.locator('#toast')).toHaveText('扫描完成，共找到 1 首歌曲');
  expect(calls).toEqual([deeper]);

  await page.goto('/#songs');
  await expect(page.locator('#content').getByRole('button', { name: /第一次扫描的深层歌曲/ })).toBeVisible();
  entries.set(deeper, [baiduTrack(deeper, '52', '深层更新歌曲')]);
  calls.length = 0;
  await contentButton(page, '刷新曲库').press('Enter');
  await expect(page.locator('#toast')).toHaveText('曲库已刷新（1 个来源）。');
  expect(calls).toEqual([start, deeper, ...descendants.slice(0, -1)]);
  await expect(page.locator('#content').getByRole('button', { name: /深层更新歌曲/ })).toBeVisible();
  await expect(page.locator('#content').getByRole('button', { name: /独立来源歌曲/ })).toHaveCount(0);

  await page.locator('#sidebar [data-nav=sources]').press('Enter');
  await page.locator('[data-action=baidu-source]').press('Enter');
  await contentButton(page, '恢复从根目录扫描').press('Enter');
  await expect(page.locator('[data-cloud-scan-scope]')).toHaveText('从 根目录 扫描并向下读取四层。');
});

test('scans new cloud folders incrementally and reconciles confirmed deletions on rescan', async ({ page }) => {
  let version = 1;
  const calls = [];
  const folder = (name, id) => ({ id, name, path: '/' + id, folder: true });
  const track = (name, id) => ({ id, name: name + '.wav', path: '/' + name + '.wav', folder: false, streamUrl: '/api/baidu/stream?id=' + id });
  await page.route('**/api/baidu/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/baidu/list?**', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    calls.push(path);
    const subfolders = [folder('旧目录', 'old'), folder('新目录', 'new')];
    const items = path === '/old' ? [track('旧的音频', '41')] :
      path === '/new' ? [track('新的音频', '42')] : version === 1 ? subfolders.slice(0, 1) :
        version === 3 ? subfolders.slice(1) : subfolders;
    return route.fulfill({ json: { items } });
  });
  await page.goto('/#sources');
  await page.locator('[data-action=baidu-source]').press('Enter');
  await page.getByRole('button', { name: '扫描并加入曲库' }).press('Enter');
  await expect(page.getByRole('button', { name: '只扫描新目录' })).toBeVisible();
  expect(calls).toEqual(['/', '/', '/old']);
  version = 2;
  calls.length = 0;
  await page.getByRole('button', { name: '只扫描新目录' }).press('Enter');
  await expect(page.getByRole('button', { name: '只扫描新目录' })).toBeVisible();
  expect(calls).toEqual(['/', '/new']);
  await page.locator('#sidebar [data-nav=songs]').press('Enter');
  await expect(page.getByRole('button', { name: /旧的音频/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /新的音频/ })).toBeVisible();

  version = 3;
  await page.locator('#sidebar [data-nav=sources]').press('Enter');
  await page.locator('[data-action=baidu-source]').press('Enter');
  await page.getByRole('button', { name: '重新扫描目录' }).press('Enter');
  await expect(page.getByRole('button', { name: '重新扫描目录' })).toBeVisible();
  await page.locator('#sidebar [data-nav=songs]').press('Enter');
  await expect(page.getByRole('button', { name: /新的音频/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /旧的音频/ })).toHaveCount(0);
});

test('library refresh keeps a failed source intact, refreshes the next source and can be canceled', async ({ page }) => {
  const sources = [{ id: 'fixture-a', type: 'webdav', name: 'Fixture A' }, { id: 'fixture-b', type: 'webdav', name: 'Fixture B' }];
  await page.addInitScript(sources => {
    const tracks = sources.map(source => ({ id: `${source.id}:old`, provider: source.type, title: `Prior ${source.name}`, artist: 'Fixture Artist' }));
    const scanSnapshots = Object.fromEntries(sources.map(source => [source.id, [['/', [], [`${source.id}:old`]]]]));
    localStorage.setItem('groovebox.state.v1', JSON.stringify({ tracks, scanSnapshots, settings: { demos: false } }));
  }, sources);
  await page.route('**/api/sources', route => route.fulfill({ json: { sources } }));
  const calls = [];
  let pending;
  let begin;
  const held = new Promise(resolve => { begin = resolve; });
  let mode = 'failure';
  await page.route(/\/api\/sources\/[^/]+\/list\?/, async route => {
    const url = new URL(route.request().url());
    const source = url.pathname.split('/')[3];
    const path = url.searchParams.get('path');
    calls.push([source, path]);
    if (mode === 'cancel') {
      pending = route;
      begin();
      return;
    }
    if (path === 'partial') return route.fulfill({ status: 503, json: { error: 'Fixture source unavailable' } });
    const name = source === 'fixture-a' ? 'Discarded Fixture A' : 'Current Fixture B';
    const items = [{ id: 'new', name: name + '.m4a', title: name, artist: 'Fixture Artist', path: name, streamUrl: `/api/sources/${source}/stream?id=new` }];
    if (source === 'fixture-a') items.push({ id: 'partial', path: 'partial', name: 'Partial directory', folder: true });
    return route.fulfill({ json: { items } });
  });
  await page.goto('/#songs');
  const refresh = page.getByRole('button', { name: '刷新曲库', exact: true });
  await expect(refresh).toBeVisible();
  expect(calls).toEqual([]);
  await refresh.press('Enter');
  await expect(page.locator('#toast')).toHaveText('已刷新 1 个来源。以下来源保留现有索引：Fixture A');
  expect(calls).toEqual([['fixture-a', '/'], ['fixture-a', 'partial'], ['fixture-b', '/']]);
  await expect(page.getByRole('button', { name: 'Prior Fixture A Fixture Artist' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discarded Fixture A Fixture Artist' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Current Fixture B Fixture Artist' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prior Fixture B Fixture Artist' })).toHaveCount(0);

  mode = 'cancel';
  calls.length = 0;
  await refresh.press('Enter');
  await held;
  await page.getByRole('button', { name: '取消刷新曲库', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toHaveText('已取消曲库刷新。');
  await pending.abort().catch(() => {});
  expect(calls).toEqual([['fixture-a', '/']]);
  await expect(page.getByRole('button', { name: 'Prior Fixture A Fixture Artist' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Current Fixture B Fixture Artist' })).toBeVisible();
});
