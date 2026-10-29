import { beforeEach, describe, expect, it } from 'vitest';
import { createChromeAdapter, toTabFacts, type ChromeAdapter, type Result } from '../../src/platform/chrome-adapter';
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
      tabId: 1, windowId: -1, groupId: -1, url: '', title: '',
      active: false, audible: false, pinned: false, discarded: false,
      autoDiscardable: true, status: 'complete',
    });
  });
  it('never yields undefined in any field', () => {
    const facts = toTabFacts({ id: 1 } as chrome.tabs.Tab);
    for (const v of Object.values(facts)) expect(v).not.toBeUndefined();
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
      tabId: 1, windowId: 10, groupId: -1, url: 'https://example.com/', title: '',
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
  it('does not mutate the tab objects it is handed', async () => {
    const before = JSON.stringify(fake.tabs);
    fake.tabs.forEach((t) => Object.freeze(t));
    await adapter.queryTabs();
    await adapter.getTab(1);
    await adapter.discard(1);
    expect(JSON.stringify(fake.tabs.filter((t) => t.id === undefined))).toBe('[]');
    expect(before).toContain('"id":1');
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
    expect(fake.tabs.find((t) => t.id === 99)?.index).toBe(3);
    expect(fake.tabs.indexOf(fake.tabs.find((t) => t.id === 99)!)).toBe(0);
  });

  it('reports tab-gone when the re-read of the new id fails', async () => {
    fake.rejectOn.set('tabs.get', new Error('No tab with id: 1000'));
    expect(await adapter.discard(1)).toMatchObject({ ok: false, error: { kind: 'tab-gone' } });
  });

  it('reports tab-gone for an unknown tab', async () => {
    expect(await adapter.discard(42)).toMatchObject({ ok: false, error: { kind: 'tab-gone' } });
  });
});

describe('no method ever rejects', () => {
  const calls: Array<[string, string, (a: ChromeAdapter) => Promise<Result<unknown>>]> = [
    ['queryTabs', 'tabs.query', (a) => a.queryTabs()],
    ['getTab', 'tabs.get', (a) => a.getTab(1)],
    ['queryWindows', 'windows.getAll', (a) => a.queryWindows()],
    ['queryGroups', 'tabGroups.query', (a) => a.queryGroups()],
    ['discard', 'tabs.discard', (a) => a.discard(1)],
    ['focusTab', 'tabs.highlight', (a) => a.focusTab(1)],
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
  it('focuses a tab without update', async () => {
    expect(await adapter.focusTab(1)).toEqual({ ok: true, value: undefined });
    expect(fake.counts['tabs.highlight']).toBe(1);
    expect(fake.counts['windows.update']).toBe(1);
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
  it('never calls tabs.remove, tabs.move or tabs.update across every operation', async () => {
    await adapter.queryTabs();
    await adapter.getTab(1);
    await adapter.queryWindows();
    await adapter.queryGroups();
    await adapter.discard(1);
    await adapter.focusTab(1000);
    await adapter.openUrlInNewTab('https://a.test/');
    await adapter.getAlarm('a');
    await adapter.createAlarm('a', 1);
    await adapter.clearAlarm('a');
    expect(fake.forbidden).toEqual({ remove: 0, move: 0, update: 0 });
  });
});
