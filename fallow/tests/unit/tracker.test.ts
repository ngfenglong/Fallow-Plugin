import { createChromeAdapter } from '../../src/platform/chrome-adapter';
import type { ChromeAdapter } from '../../src/platform/chrome-adapter';
import { createRepos } from '../../src/platform/storage';
import { createTracker, type Tracker } from '../../src/background/tracker';
import type { TabFacts } from '../../src/domain/types';
import { createFakeChrome, type FakeChrome } from '../fake-chrome';
import { createFakeStorage, type FakeStorage } from '../fake-storage';

function facts(p: Partial<TabFacts> & { tabId: number }): TabFacts {
  return {
    windowId: 10, groupId: -1, url: 'https://a.test/', title: '', active: false, audible: false,
    pinned: false, discarded: false, autoDiscardable: true, status: 'complete', ...p,
  };
}

let fake: FakeChrome;
let storage: FakeStorage;
let tracker: Tracker;
let adapter: ChromeAdapter;
let repos: ReturnType<typeof createRepos>;

function mount(a: ChromeAdapter = adapter) {
  tracker = createTracker({ adapter: a, activity: repos.activity, session: repos.session });
}
function seedFake(tabs: Array<{ id: number; windowId: number; active?: boolean }>) {
  fake.tabs.splice(0, fake.tabs.length, ...tabs.map((t) => ({ active: false, ...t })));
}
function setActive(id: number) {
  const t = fake.tabs.find((x) => x.id === id)!;
  for (const o of fake.tabs) if (o.windowId === t.windowId) o.active = o.id === id;
}
const stored = () => storage.session.data.get('fallow.activity') as Record<number, { backgroundSince: number | null }>;

beforeEach(() => {
  fake = createFakeChrome([]);
  storage = createFakeStorage();
  repos = createRepos(storage);
  adapter = createChromeAdapter(fake.api);
  mount();
});

describe('tracker: brief behaviours', () => {
  it('gives a discovered background tab the discovery time, not an earlier one', async () => {
    await tracker.reconcile([facts({ tabId: 1 })], 5_000);
    expect((await tracker.snapshot())[1]!.backgroundSince).toBe(5_000);
  });
  it('leaves selected tabs in any window with no background timer', async () => {
    await tracker.reconcile([facts({ tabId: 1, active: true, windowId: 10 }), facts({ tabId: 2, active: true, windowId: 20 })], 5_000);
    const s = await tracker.snapshot();
    expect([s[1]!.backgroundSince, s[2]!.backgroundSince]).toEqual([null, null]);
  });
  it('starts the timer at the moment a tab stops being selected', async () => {
    seedFake([{ id: 1, windowId: 10, active: true }, { id: 2, windowId: 10 }]);
    await tracker.reconcile([facts({ tabId: 1, active: true }), facts({ tabId: 2 })], 1_000);
    setActive(2);
    await tracker.onActivated(2, 10, 9_000);
    const s = await tracker.snapshot();
    expect(s[1]!.backgroundSince).toBe(9_000);
    expect(s[2]!.backgroundSince).toBe(null);
  });
  it('clears the timer when a tab becomes selected again', async () => {
    seedFake([{ id: 1, windowId: 10 }]);
    await tracker.reconcile([facts({ tabId: 1 })], 1_000);
    setActive(1);
    await tracker.onActivated(1, 10, 9_000);
    expect((await tracker.snapshot())[1]!.backgroundSince).toBe(null);
  });
  it('starts a new background tab at creation', async () => {
    await tracker.onCreated(facts({ tabId: 3 }), 7_000);
    expect((await tracker.snapshot())[3]!.backgroundSince).toBe(7_000);
  });
  it('keeps the timestamp when a background tab moves window or group', async () => {
    await tracker.reconcile([facts({ tabId: 1, windowId: 10, groupId: 1 })], 1_000);
    await tracker.reconcile([facts({ tabId: 1, windowId: 20, groupId: 2 })], 60_000);
    expect((await tracker.snapshot())[1]!.backgroundSince).toBe(1_000);
  });
  it('keeps the timestamp when an inactive tab navigates', async () => {
    await tracker.reconcile([facts({ tabId: 1, url: 'https://a.test/' })], 1_000);
    await tracker.reconcile([facts({ tabId: 1, url: 'https://b.test/' })], 60_000);
    expect((await tracker.snapshot())[1]!.backgroundSince).toBe(1_000);
  });
  it('forgets a removed tab and does not resurrect it', async () => {
    await tracker.reconcile([facts({ tabId: 1 })], 1_000);
    await tracker.onRemoved(1);
    await tracker.reconcile([], 2_000);
    expect(await tracker.snapshot()).toEqual({});
  });
  it('drops records for tabs that no longer exist at reconcile', async () => {
    await tracker.reconcile([facts({ tabId: 1 }), facts({ tabId: 2 })], 1_000);
    await tracker.reconcile([facts({ tabId: 2 })], 2_000);
    expect(Object.keys(await tracker.snapshot())).toEqual(['2']);
  });
  it('migrates the activity record when a discard changes the tab id', async () => {
    await tracker.reconcile([facts({ tabId: 1 })], 1_000);
    await tracker.onReplaced(99, 1, 60_000);
    const s = await tracker.snapshot();
    expect(s[1]).toBeUndefined();
    expect(s[99]!.backgroundSince).toBe(1_000);
  });
  it('carries session protection across a prerender replacement but not stale identity', async () => {
    await tracker.reconcile([facts({ tabId: 1 })], 1_000);
    await tracker.setTabProtection(1, true);
    await tracker.onReplaced(9, 1, 5_000);
    const s = await tracker.snapshot();
    expect(s[1]).toBeUndefined();
    expect(s[9]).toEqual({ tabId: 9, backgroundSince: 1_000, protectedForSession: true });
  });
  it('rewrites a background timestamp that sits in the future', async () => {
    storage.session.data.set('fallow.activity', { 1: { tabId: 1, backgroundSince: 50_000, protectedForSession: false } });
    await tracker.reconcile([facts({ tabId: 1 })], 10_000);
    expect((await tracker.snapshot())[1]!.backgroundSince).toBe(10_000);
  });
  it('writes session activity once per reconcile', async () => {
    storage.session.writes = 0;
    await tracker.reconcile([facts({ tabId: 1 }), facts({ tabId: 2 }), facts({ tabId: 3 })], 1_000);
    expect(storage.session.writes).toBe(1);
  });
});

describe('tracker: beyond the brief', () => {
  it('reconcile issues no queryTabs call of its own (the caller supplies the tabs)', async () => {
    await tracker.reconcile([facts({ tabId: 1 })], 1_000);
    expect(fake.counts['tabs.query'] ?? 0).toBe(0);
  });
  it('onActivated issues exactly one queryTabs call', async () => {
    seedFake([{ id: 1, windowId: 10, active: true }, { id: 2, windowId: 10 }]);
    await tracker.onActivated(1, 10, 1_000);
    expect(fake.counts['tabs.query']).toBe(1);
  });
  it('keeps two tabs selected in two windows both untimed at once', async () => {
    seedFake([{ id: 1, windowId: 10, active: true }, { id: 2, windowId: 20, active: true }, { id: 3, windowId: 20 }]);
    await tracker.reconcile([facts({ tabId: 1, windowId: 10, active: true }), facts({ tabId: 2, windowId: 20, active: true }), facts({ tabId: 3, windowId: 20 })], 1_000);
    await tracker.onActivated(1, 10, 2_000);
    const s = await tracker.snapshot();
    expect([s[1]!.backgroundSince, s[2]!.backgroundSince, s[3]!.backgroundSince]).toEqual([null, null, 1_000]);
  });
  it('onActivated only touches the activated window', async () => {
    seedFake([{ id: 1, windowId: 10, active: true }, { id: 2, windowId: 10 }, { id: 3, windowId: 20, active: true }]);
    await tracker.reconcile([facts({ tabId: 1, active: true }), facts({ tabId: 2 }), facts({ tabId: 3, windowId: 20, active: true })], 1_000);
    setActive(2);
    await tracker.onActivated(2, 10, 9_000);
    expect((await tracker.snapshot())[3]!.backgroundSince).toBe(null);
  });
  it('onActivated in a one-tab window does not crash and leaves no stray record', async () => {
    seedFake([{ id: 1, windowId: 10, active: true }]);
    await tracker.onActivated(1, 10, 1_000);
    expect(await tracker.snapshot()).toEqual({ 1: { tabId: 1, backgroundSince: null, protectedForSession: false } });
  });
  it('onActivated with a failing queryTabs still clears the activated tab and leaves others alone', async () => {
    await tracker.reconcile([facts({ tabId: 1 }), facts({ tabId: 2 })], 1_000);
    fake.rejectOn.set('tabs.query', new Error('boom'));
    await tracker.onActivated(2, 10, 9_000);
    const s = await tracker.snapshot();
    expect([s[1]!.backgroundSince, s[2]!.backgroundSince]).toEqual([1_000, null]);
  });
  it('onRemoved for an unknown tab is a no-op', async () => {
    await tracker.reconcile([facts({ tabId: 1 })], 1_000);
    storage.session.writes = 0;
    await expect(tracker.onRemoved(77)).resolves.toBeUndefined();
    expect(Object.keys(await tracker.snapshot())).toEqual(['1']);
    expect(storage.session.writes).toBe(0);
  });
  it('onRemoved deletes immediately from storage', async () => {
    await tracker.reconcile([facts({ tabId: 1 }), facts({ tabId: 2 })], 1_000);
    await tracker.onRemoved(1);
    expect(Object.keys(stored())).toEqual(['2']);
  });
  it('onReplaced with no record for the removed id gives the new id a fresh timer', async () => {
    await tracker.onReplaced(5, 4, 8_000);
    expect(await tracker.snapshot()).toEqual({ 5: { tabId: 5, backgroundSince: 8_000, protectedForSession: false } });
  });
  it('onReplaced of a selected tab stays untimed', async () => {
    await tracker.reconcile([facts({ tabId: 1, active: true })], 1_000);
    await tracker.onReplaced(9, 1, 5_000);
    expect((await tracker.snapshot())[9]!.backgroundSince).toBe(null);
  });
  it('setTabProtection creates a record when none exists', async () => {
    await tracker.setTabProtection(4, true);
    expect((await tracker.snapshot())[4]).toEqual({ tabId: 4, backgroundSince: null, protectedForSession: true });
  });
  it('setTabProtection does not clobber backgroundSince', async () => {
    await tracker.reconcile([facts({ tabId: 1 })], 1_000);
    await tracker.setTabProtection(1, true);
    await tracker.setTabProtection(1, false);
    expect((await tracker.snapshot())[1]).toEqual({ tabId: 1, backgroundSince: 1_000, protectedForSession: false });
  });
  it('a reconcile keeps session protection', async () => {
    await tracker.reconcile([facts({ tabId: 1 })], 1_000);
    await tracker.setTabProtection(1, true);
    await tracker.reconcile([facts({ tabId: 1 })], 2_000);
    expect((await tracker.snapshot())[1]!.protectedForSession).toBe(true);
  });
  it('a tab that loses selection between reconciles starts at the reconcile time', async () => {
    await tracker.reconcile([facts({ tabId: 1, active: true })], 1_000);
    await tracker.reconcile([facts({ tabId: 1, active: false })], 4_000);
    expect((await tracker.snapshot())[1]!.backgroundSince).toBe(4_000);
  });
  it('onCreated of an active tab is untimed', async () => {
    await tracker.onCreated(facts({ tabId: 3, active: true }), 7_000);
    expect((await tracker.snapshot())[3]!.backgroundSince).toBe(null);
  });
  it('a failed write propagates and nothing is cached in memory', async () => {
    await tracker.reconcile([facts({ tabId: 1 })], 1_000);
    storage.session.rejectOn.set('set:fallow.activity', new Error('quota'));
    await expect(tracker.onCreated(facts({ tabId: 2 }), 2_000)).rejects.toThrow('quota');
    storage.session.rejectOn.clear();
    // The stored view is the only view: the failed tab 2 is not remembered.
    expect(Object.keys(await tracker.snapshot())).toEqual(['1']);
    await tracker.onCreated(facts({ tabId: 3 }), 3_000);
    expect(Object.keys(await tracker.snapshot())).toEqual(['1', '3']);
  });
  it('serialises overlapping events so none is lost', async () => {
    await Promise.all([
      tracker.onCreated(facts({ tabId: 1 }), 1_000),
      tracker.onCreated(facts({ tabId: 2 }), 1_000),
      tracker.onCreated(facts({ tabId: 3 }), 1_000),
    ]);
    expect(Object.keys(await tracker.snapshot())).toEqual(['1', '2', '3']);
  });
  it('a failed operation does not wedge the queue', async () => {
    storage.session.rejectOn.set('set:fallow.activity', new Error('quota'));
    await expect(tracker.onCreated(facts({ tabId: 1 }), 1_000)).rejects.toThrow();
    storage.session.rejectOn.clear();
    await tracker.onCreated(facts({ tabId: 2 }), 2_000);
    expect(Object.keys(await tracker.snapshot())).toEqual(['2']);
  });
  it('with an adapter whose every method fails, onActivated still resolves', async () => {
    const dead = new Proxy({}, { get: () => async () => ({ ok: false, error: { kind: 'unknown', message: 'x' } }) }) as ChromeAdapter;
    mount(dead);
    await expect(tracker.onActivated(1, 10, 1_000)).resolves.toBeUndefined();
    await expect(tracker.onReplaced(2, 1, 1_000)).resolves.toBeUndefined();
    await expect(tracker.onCreated(facts({ tabId: 3 }), 1_000)).resolves.toBeUndefined();
  });
});
