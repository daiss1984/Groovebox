import { expect, test } from '@playwright/test';

const fixture = '/assets/cover-1.jpg';
const legacyScope = 'groovebox.state.v1';
const nextScope = 'groovebox.state.restore.84c7bb05-ce32-4eba-bf01-d852fd927039';
const otherScope = 'groovebox.state.restore.947748f8-31f0-45a2-99b8-7d1c6e27f7ba';
const keys = { legacyScope, nextScope, otherScope };
const scopedText = (scope, state) => JSON.stringify({ ...state, _grooveboxStateScope: scope }, null, 2);

test('keeps a candidate byte-exact when another tab saves to its captured legacy scope', async ({ page, context }) => {
  const initial = { settings: { theme: 'copper' }, playlists: [{ id: 'old', name: 'Old playlist', tracks: [] }] };
  const restored = { settings: { theme: 'dark' }, playlists: [{ id: 'new', name: 'New playlist', tracks: ['baidu:2'] }] };
  const candidateText = scopedText(nextScope, restored);
  const unrelatedText = scopedText(otherScope, { settings: { theme: 'copper' } });

  await page.goto(fixture);
  expect(await page.evaluate(async state => (await import('/library.js')).writeState(state), initial)).toBe(true);
  const peer = await context.newPage();
  try {
    await peer.goto(fixture);
    const original = await peer.evaluate(async () => {
      const state = await import('/library.js');
      return { scope: state.currentStateScope(), data: state.readState() };
    });
    expect(original).toEqual({ scope: legacyScope, data: initial });

    const staged = await page.evaluate(async ({ keys, candidateText, unrelatedText }) => {
      const state = await import('/library.js');
      const candidate = state.writeStateTextAtScope(keys.nextScope, candidateText);
      const unrelated = state.writeStateTextAtScope(keys.otherScope, unrelatedText);
      const beforeBind = state.currentStateScope();
      state.bindStateScope(keys.nextScope);
      return { candidate, unrelated, beforeBind, payload: state.readState() };
    }, { keys, candidateText, unrelatedText });
    expect(staged).toEqual({
      candidate: true, unrelated: true, beforeBind: legacyScope,
      payload: { ...restored, _grooveboxStateScope: nextScope },
    });

    const changed = await peer.evaluate(async () => {
      const state = await import('/library.js');
      const data = state.readState();
      data.settings.theme = 'peer-change';
      return { scope: state.currentStateScope(), wrote: state.writeState(data) };
    });
    expect(changed).toEqual({ scope: legacyScope, wrote: true });

    const unchanged = await page.evaluate(async keys => {
      const state = await import('/library.js');
      return {
        candidate: state.readStateTextAtScope(keys.nextScope),
        unrelated: state.readStateTextAtScope(keys.otherScope),
        prior: state.readStateAtScope(keys.legacyScope),
      };
    }, keys);
    expect(unchanged).toEqual({
      candidate: candidateText, unrelated: unrelatedText, prior: { ...initial, settings: { theme: 'peer-change' } },
    });

    const updated = { ...restored, settings: { theme: 'light' } };
    expect(await page.evaluate(async value => (await import('/library.js')).writeState(value), updated)).toBe(true);
    await page.reload();
    const seen = await page.evaluate(async scope => {
      const state = await import('/library.js');
      state.bindStateScope(scope);
      return { scope: state.currentStateScope(), data: state.readState() };
    }, nextScope);
    expect(seen).toEqual({ scope: nextScope, data: { ...updated, _grooveboxStateScope: nextScope } });
    expect(await peer.evaluate(async () => (await import('/library.js')).readState())).toEqual(unchanged.prior);
  } finally {
    await peer.close();
  }
});

test('rejects invalid scopes, malformed or foreign candidates, and missing active state without legacy fallback', async ({ page }) => {
  await page.goto(fixture);
  const result = await page.evaluate(async ({ legacyScope, nextScope, otherScope }) => {
    const state = await import('/library.js');
    const fault = action => {
      try { action(); } catch (error) { return [error.name, error.code]; }
      return null;
    };
    const prior = JSON.stringify({ settings: { preserved: true } });
    localStorage.setItem(legacyScope, prior);
    const missingText = state.readStateTextAtScope(nextScope);
    const invalidRead = fault(() => state.readStateAtScope('fixture-unrelated-key'));
    const invalidBind = fault(() => state.bindStateScope('fixture-unrelated-key'));
    const invalidWrite = state.writeStateAtScope('fixture-unrelated-key', {});
    const afterRejectedBind = state.currentStateScope();
    state.bindStateScope(nextScope);
    const missing = fault(state.readState);
    const malformed = ['{', 'null', '[]', '42', '{}', JSON.stringify({ settings: {}, _grooveboxStateScope: otherScope })];
    const rejected = malformed.map(text => {
      localStorage.setItem(nextScope, text);
      const read = fault(state.readState);
      const write = state.writeStateTextAtScope(nextScope, text);
      return { read, write };
    });
    return {
      missingText, invalidRead, invalidBind, invalidWrite, afterRejectedBind, missing, rejected,
      invalidKey: localStorage.getItem('fixture-unrelated-key'),
      conflictingWrite: state.writeStateAtScope(nextScope, { _grooveboxStateScope: otherScope }),
      priorUnchanged: state.readStateTextAtScope(legacyScope) === prior,
      foreignUnchanged: state.readStateTextAtScope(nextScope) === malformed.at(-1),
    };
  }, keys);
  const invalid = ['StateScopeError', 'state-scope-invalid'];
  expect(result).toEqual({
    missingText: null, invalidRead: invalid, invalidBind: invalid, invalidWrite: false,
    afterRejectedBind: legacyScope, missing: invalid,
    rejected: Array.from({ length: 6 }, () => ({ read: invalid, write: false })),
    invalidKey: null, conflictingWrite: false, priorUnchanged: true, foreignUnchanged: true,
  });
});

test('returns typed reads and preserves scope bytes when browser storage denies reads or exhausts quota', async ({ page }) => {
  await page.goto(fixture);
  const observed = await page.evaluate(async ({ legacyScope, nextScope, otherScope }) => {
    const state = await import('/library.js');
    const previous = [legacyScope, nextScope, otherScope].map((scope, index) => {
      state.writeStateAtScope(scope, { settings: { index } });
      return state.readStateTextAtScope(scope);
    });
    const fault = action => {
      try { action(); } catch (error) { return [error.name, error.code, error.cause?.name]; }
      return null;
    };
    state.bindStateScope(nextScope);
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    let denied, directDenied, readTextDenied, activeWrite, candidateWrite;
    try {
      Storage.prototype.getItem = function (key) {
        if (key === nextScope) throw new DOMException('Fixture read denied', 'SecurityError');
        return get.call(this, key);
      };
      denied = fault(state.readState);
      directDenied = fault(() => state.readStateAtScope(nextScope));
      readTextDenied = fault(() => state.readStateTextAtScope(nextScope));
      Storage.prototype.setItem = function (key, text) {
        if (key === nextScope) throw new DOMException('Fixture quota', 'QuotaExceededError');
        return set.call(this, key, text);
      };
      activeWrite = state.writeState({ settings: { neverPersist: true } });
      candidateWrite = state.writeStateTextAtScope(nextScope, JSON.stringify({
        settings: { neverPersist: true }, _grooveboxStateScope: nextScope,
      }));
    } finally {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    }
    const unchanged = [legacyScope, nextScope, otherScope].map((scope, index) =>
      state.readStateTextAtScope(scope) === previous[index]);
    return { denied, directDenied, readTextDenied, activeWrite, candidateWrite, unchanged };
  }, keys);
  const denied = ['StateScopeError', 'state-scope-storage', 'SecurityError'];
  expect(observed).toEqual({
    denied, directDenied: denied, readTextDenied: denied,
    activeWrite: false, candidateWrite: false, unchanged: [true, true, true],
  });
});
