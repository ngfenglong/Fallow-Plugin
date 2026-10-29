import { beforeEach, describe, expect, it } from 'vitest';
import { classifyError, createChromeAdapter, toTabFacts, type ChromeAdapter, type Result } from '../../src/platform/chrome-adapter';
import { createFakeChrome, type FakeChrome } from '../fake-chrome';

let fake: FakeChrome;
let adapter: ChromeAdapter;

beforeEach(() => {
  fake = createFakeChrome([
    { id: 1, windowId: 10, groupId: 5, index: 3, url: 'https://example.com/', active: false, pinned: true, audible: true, autoDiscardable: true, discarded: false, status: 'complete' },
  ]);
  adapter = createChromeAdapter(fake.api);
});

describe('toTabFacts', () => {
  it('defaults every absent field for an id-only tab', () => {
    expect(toTabFacts({ id: 1 } as chrome.tabs.Tab)).toEqual({
      tabId: 1, index: -1, windowId: -1, groupId: -1, url: '', title: '',
      active: false, audible: false, pinned: false, discarded: false,
      autoDiscardable: true, status: 'complete',
    });
  });
  it('carries the browser tab index, and -1 when absent', () => {
    expect(toTabFacts({ id: 1, index: 7 } as chrome.tabs.Tab).index).toBe(7);
    expect(toTabFacts({ id: 1 } as chrome.tabs.Tab).index).toBe(-1);
  });
  it('never yields undefined in any field', () => {
    const facts = toTabFacts({ id: 1 } as chrome.tabs.Tab);
    for (const v of Object.values(facts)) expect(v).not.toBeUndefined();
  });
  it('falls back to pendingUrl when url is absent', () => {
    expect(toTabFacts({ id: 1, pendingUrl: 'https://next.test/' } as chrome.tabs.Tab).url).toBe('https://next.test/');
    expect(toTabFacts({ id: 1, url: 'https://a.test/', pendingUrl: 'https://b.test/' } as chrome.tabs.Tab).url).toBe('https://a.test/');
  });
  it('keeps an explicit autoDiscardable false and unloaded status', () => {
    const f = toTabFacts({ id: 2, autoDiscardable: false, discarded: true, status: 'unloaded' } as chrome.tabs.Tab);
    expect(f.autoDiscardable).toBe(false);
    expect(f.status).toBe('unloaded');
    expect(f.discarded).toBe(true);
  });
});

describe('queryTabs', () => {
  it('maps a chrome tab onto TabFacts with defaults for absent fields', async () => {
    fake.tabs.splice(0, 1, { id: 1, windowId: 10, url: 'https://example.com/' });
    const r = await adapter.queryTabs();
    expect(r.ok && r.value[0]).toEqual({
      tabId: 1, index: -1, windowId: 10, groupId: -1, url: 'https://example.com/', title: '',
      active: false, audible: false, pinned: false, discarded: false,
      autoDiscardable: true, status: 'complete',
    });
  });
  it('returns an empty list, not an error, for an empty browser', async () => {
    fake.tabs.length = 0;
    expect(await adapter.queryTabs()).toEqual({ ok: true, value: [] });
  });
  it('skips tabs that have no id', async () => {
    fake.tabs.push({ url: 'x' });
    const r = await adapter.queryTabs();
    expect(r.ok && r.value.length).toBe(1);
  });
  it('copies rather than aliases: frozen source in, independent facts out', async () => {
    const deepFreeze = (o: object) => { Object.values(o).forEach((v) => typeof v === 'object' && v && deepFreeze(v)); Object.freeze(o); };
    fake.tabs.forEach(deepFreeze);
    const src = fake.tabs[0]!;
    const expected = {
      tabId: src.id, index: src.index ?? -1, windowId: src.windowId, groupId: src.groupId, url: src.url, title: '',
      active: src.active, audible: src.audible, pinned: src.pinned, discarded: src.discarded,
      autoDiscardable: src.autoDiscardable, status: src.status,
    };
    const all = await adapter.queryTabs();
    const one = await adapter.getTab(1);
    expect(all.ok && all.value[0]).toEqual(expected);
    expect(one.ok && one.value).toEqual(expected);
    if (all.ok && one.ok) {
      all.value[0]!.url = 'mutated';
      one.value.pinned = false;
      expect(src.url).toBe('https://example.com/');
      expect(src.pinned).toBe(true);
      expect(all.value[0]).not.toBe(one.value);
    }
    const d = await adapter.discard(1); // discard also reads from a frozen table
    expect(d.ok).toBe(true);
  });
});

describe('discard', () => {
  it.each([
    ['No tab with id: 7', 'tab-gone'],
    ['Invalid tab ID: 7', 'tab-gone'],
    ['Tabs cannot be discarded while active', 'rejected'],
    ['Cannot discard the active tab', 'rejected'],
    ['The "system.memory" permission is required', 'no-permission'],
    ['kaboom', 'unknown'],
  ])('maps lastError %p to %p', async (message, kind) => {
    fake.lastError = { message };
    expect(await adapter.discard(1)).toEqual({ ok: false, error: { kind, message } });
  });

  it('treats lastError alongside a successful-looking result as failure', async () => {
    fake.lastError = { message: 'No tab with id: 1' };
    const r = await adapter.discard(1); // fake still resolves with a good tab
    expect(r).toMatchObject({ ok: false, error: { kind: 'tab-gone' } });
  });

  it('never rejects, even when the api throws synchronously', async () => {
    fake.throwOn.set('tabs.discard', new Error('boom'));
    await expect(adapter.discard(1)).resolves.toMatchObject({ ok: false, error: { kind: 'unknown', message: 'boom' } });
  });

  it('reports the post-discard tab state rather than assuming success', async () => {
    fake.discardBehaviour = 'silent-noop';
    const r = await adapter.discard(1);
    expect(r.ok && r.value.facts.discarded).toBe(false);
    expect(r.ok && r.value.facts.tabId).toBe(1); // fallback to requested id
    expect(fake.getCalls).toEqual([1]);
  });

  it('turns a rejected discard into a rejected result', async () => {
    fake.discardBehaviour = 'reject';
    expect(await adapter.discard(1)).toMatchObject({ ok: false, error: { kind: 'rejected' } });
  });

  it('follows the new tab id chrome mints for a discarded tab', async () => {
    fake.nextDiscardId = 99;
    const r = await adapter.discard(1);
    expect(r.ok && r.value).toMatchObject({ requestedTabId: 1 });
    expect(r.ok && r.value.facts.tabId).toBe(99);
    expect(r.ok && r.value.facts.discarded).toBe(true);
    expect(fake.getCalls).toContain(99);
    expect(fake.getCalls).not.toContain(1);
  });

  it('preserves window, group and position across the id change', async () => {
    fake.nextDiscardId = 99;
    const r = await adapter.discard(1);
    expect(r.ok && r.value.facts).toMatchObject({ windowId: 10, groupId: 5, pinned: true, audible: true });
  });

  it('still succeeds with the new id when the re-read fails after a good discard', async () => {
    fake.nextDiscardId = 99;
    fake.rejectOn.set('tabs.get', new Error('No tab with id: 99'));
    const r = await adapter.discard(1);
    expect(r.ok && r.value.requestedTabId).toBe(1);
    expect(r.ok && r.value.facts).toMatchObject({ tabId: 99, discarded: true, windowId: 10 });
  });
  it('reports tab-gone only when chrome gave no tab and the re-read fails', async () => {
    fake.discardBehaviour = 'silent-noop';
    fake.rejectOn.set('tabs.get', new Error('No tab with id: 1'));
    expect(await adapter.discard(1)).toMatchObject({ ok: false, error: { kind: 'tab-gone' } });
  });
  it('reports a same-id discard: requested equals new id and discarded is true', async () => {
    fake.nextDiscardId = 1;
    const r = await adapter.discard(1);
    expect(r.ok && r.value.requestedTabId).toBe(1);
    expect(r.ok && r.value.facts.tabId).toBe(1);
    expect(r.ok && r.value.facts.discarded).toBe(true);
  });

  it('reports tab-gone for an unknown tab', async () => {
    expect(await adapter.discard(42)).toMatchObject({ ok: false, error: { kind: 'tab-gone' } });
  });
});

describe('malformed chrome results', () => {
  it.each([
    ['tabs.query undefined', () => { fake.tabs = undefined as never; fake.api.tabs.query = (async () => undefined) as never; }, (a: ChromeAdapter) => a.queryTabs()],
    ['tabs.query with a null element', () => { fake.tabs.push(null as never); }, (a: ChromeAdapter) => a.queryTabs()],
    ['tabs.get undefined', () => { fake.api.tabs.get = (async () => undefined) as never; }, (a: ChromeAdapter) => a.getTab(1)],
    ['windows.getAll undefined', () => { fake.api.windows.getAll = (async () => undefined) as never; }, (a: ChromeAdapter) => a.queryWindows()],
    ['tabGroups.query null', () => { fake.api.tabGroups.query = (async () => null) as never; }, (a: ChromeAdapter) => a.queryGroups()],
  ])('%s resolves to ok:false', async (_n, setup, call) => {
    setup();
    await expect(call(adapter)).resolves.toMatchObject({ ok: false });
  });
  it('getTab reports tab-gone for a tab without an id', async () => {
    fake.tabs.push({ windowId: 3 });
    fake.api.tabs.get = (async () => ({ windowId: 3 })) as never;
    expect(await adapter.getTab(5)).toMatchObject({ ok: false, error: { kind: 'tab-gone' } });
  });
  it('survives a null-prototype error with no message', async () => {
    fake.rejectOn.set('tabs.query', Object.create(null));
    expect(await adapter.queryTabs()).toMatchObject({ ok: false, error: { kind: 'unknown' } });
  });
});

describe('classifyError', () => {
  it.each([
    ['No tab with id: 7', 'tab-gone'],
    ['Invalid tab ID: 7', 'tab-gone'],
    ['Tabs cannot be discarded while active', 'rejected'],
    ['Tabs cannot be edited right now (user may be dragging a tab).', 'rejected'],
    ['The "tabs" permission is required for the active tab', 'no-permission'],
    ['No window with id: 3', 'unknown'],
    ['kaboom', 'unknown'],
  ])('%p -> %p', (message, kind) => {
    expect(classifyError(message)).toBe(kind);
  });
});

describe('no method ever rejects', () => {
  const calls: Array<[string, string, (a: ChromeAdapter) => Promise<Result<unknown>>]> = [
    ['queryTabs', 'tabs.query', (a) => a.queryTabs()],
    ['getTab', 'tabs.get', (a) => a.getTab(1)],
    ['queryWindows', 'windows.getAll', (a) => a.queryWindows()],
    ['queryGroups', 'tabGroups.query', (a) => a.queryGroups()],
    ['discard', 'tabs.discard', (a) => a.discard(1)],
    ['focusTab', 'tabs.update', (a) => a.focusTab(1)],
    ['openUrlInNewTab', 'tabs.create', (a) => a.openUrlInNewTab('https://a.test/')],
    ['getAlarm', 'alarms.get', (a) => a.getAlarm('x')],
    ['createAlarm', 'alarms.create', (a) => a.createAlarm('x', 1)],
    ['clearAlarm', 'alarms.clear', (a) => a.clearAlarm('x')],
  ];

  it.each(calls)('%s survives a synchronous throw', async (_n, key, call) => {
    fake.throwOn.set(key, new Error('sync boom'));
    expect(await call(adapter)).toEqual({ ok: false, error: { kind: 'unknown', message: 'sync boom' } });
  });
  it.each(calls)('%s survives an async rejection', async (_n, key, call) => {
    fake.rejectOn.set(key, new Error('async boom'));
    expect(await call(adapter)).toEqual({ ok: false, error: { kind: 'unknown', message: 'async boom' } });
  });
  it.each(calls)('%s treats lastError as failure', async (_n, _k, call) => {
    fake.lastError = { message: 'The "tabs" permission is required' };
    expect(await call(adapter)).toMatchObject({ ok: false, error: { kind: 'no-permission' } });
  });
  it('survives a non-Error throw', async () => {
    fake.rejectOn.set('tabs.query', 'plain string' as unknown as Error);
    expect(await adapter.queryTabs()).toEqual({ ok: false, error: { kind: 'unknown', message: 'plain string' } });
  });
});

describe('other operations', () => {
  it('queries windows and groups', async () => {
    fake.windows.push({ id: 10, focused: true }, { id: 11 });
    fake.groups.push({ id: 5, windowId: 10, title: 'g', color: 'blue', collapsed: true });
    expect(await adapter.queryWindows()).toEqual({ ok: true, value: [{ windowId: 10, focused: true }, { windowId: 11, focused: false }] });
    expect(await adapter.queryGroups()).toEqual({ ok: true, value: [{ groupId: 5, windowId: 10, title: 'g', color: 'blue', collapsed: true }] });
  });
  it('getTab maps a tab and reports tab-gone for a missing one', async () => {
    const r = await adapter.getTab(1);
    expect(r.ok && r.value.tabId).toBe(1);
    expect(await adapter.getTab(77)).toMatchObject({ ok: false, error: { kind: 'tab-gone' } });
  });
  it('focuses a tab by activating it and focusing its window', async () => {
    expect(await adapter.focusTab(1)).toEqual({ ok: true, value: undefined });
    expect(fake.updateCalls).toEqual([{ active: true }]);
    expect(fake.counts['windows.update']).toBe(1);
  });
  it('asks windows.update only to focus the window', async () => {
    await adapter.focusTab(1);
    expect(fake.windowUpdateCalls).toEqual([{ windowId: 10, props: { focused: true } }]);
  });
  it('still reports ok when the window focus fails after the tab was activated', async () => {
    fake.rejectOn.set('windows.update', new Error('window boom'));
    expect(await adapter.focusTab(1)).toEqual({ ok: true, value: undefined });
    expect(fake.updateCalls).toEqual([{ active: true }]);
  });
  it('reports tab-gone when focusing a missing tab', async () => {
    expect(await adapter.focusTab(77)).toMatchObject({ ok: false, error: { kind: 'tab-gone' } });
  });
  it('opens a url in a new tab and returns its id', async () => {
    const r = await adapter.openUrlInNewTab('https://a.test/');
    expect(r.ok && typeof r.value).toBe('number');
  });
  it('creates, reads and clears an alarm', async () => {
    expect(await adapter.getAlarm('a')).toEqual({ ok: true, value: false });
    expect(await adapter.createAlarm('a', 1)).toEqual({ ok: true, value: undefined });
    expect(fake.alarms.get('a')?.periodInMinutes).toBe(1);
    expect(await adapter.getAlarm('a')).toEqual({ ok: true, value: true });
    expect(await adapter.clearAlarm('a')).toEqual({ ok: true, value: undefined });
    expect(await adapter.getAlarm('a')).toEqual({ ok: true, value: false });
  });
});

describe('surface', () => {
  it('exposes no method that closes, moves or navigates a tab', () => {
    expect(Object.keys(adapter).sort()).toEqual([
      'clearAlarm', 'createAlarm', 'discard', 'focusTab', 'getAlarm', 'getTab',
      'openUrlInNewTab', 'queryGroups', 'queryTabs', 'queryWindows',
    ]);
  });
  it('never removes or moves a tab, and tabs.update only ever carries { active }', async () => {
    await adapter.queryTabs();
    await adapter.getTab(1);
    await adapter.queryWindows();
    await adapter.queryGroups();
    await adapter.discard(1);
    await adapter.focusTab(1000); // 1000 exists only because discard(1) above minted it
    await adapter.openUrlInNewTab('https://a.test/');
    await adapter.getAlarm('a');
    await adapter.createAlarm('a', 1);
    await adapter.clearAlarm('a');
    expect(fake.forbidden).toEqual({ remove: 0, move: 0 });
    expect(fake.updateCalls.length).toBeGreaterThan(0);
    for (const bag of fake.updateCalls) {
      expect(Object.keys(bag).every((k) => k === 'active')).toBe(true);
      expect(bag).not.toHaveProperty('url');
      expect(bag).not.toHaveProperty('pendingUrl');
    }
  });
});
