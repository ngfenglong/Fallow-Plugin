// The service worker as Chrome runs it: the real module, imported fresh as a worker start,
// against the fake browser installed as the global `chrome`. A "worker restart" is a second
// fresh import against the SAME fake, whose storage and alarms survive, exactly as
// chrome.storage and chrome.alarms survive a worker being stopped.
import { createRepos, createChromeStorageArea, KEYS } from '../../src/platform/storage';
import { createTracker } from '../../src/background/tracker';
import { createOrigins } from '../../src/background/origins';
import { createChromeAdapter } from '../../src/platform/chrome-adapter';
import type { InFlightBatch } from '../../src/background/executor';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { ALARM_NAME, STARTUP_GRACE_MS } from '../../src/domain/constants';
import { createFakeChrome, installChromeGlobal, type FakeChrome, type FakeTab } from '../fake-chrome';

const T0 = 10_000_000;
const MIN = 60_000;

function tab(p: FakeTab & { id: number }): FakeTab {
  return {
    index: p.id, windowId: 10, groupId: -1, url: `https://site${p.id}.test/`, title: `t${p.id}`,
    active: false, audible: false, pinned: false, discarded: false, autoDiscardable: true,
    status: 'complete', ...p,
  };
}

// Tab 1 is selected in window 10, tab 3 in window 11; 2 and 4 are background tabs.
function baseTabs(): FakeTab[] {
  return [
    tab({ id: 1, windowId: 10, index: 0, active: true }),
    tab({ id: 2, windowId: 10, index: 1 }),
    tab({ id: 3, windowId: 11, index: 0, active: true }),
    tab({ id: 4, windowId: 11, index: 1 }),
  ];
}

let fake: FakeChrome;
let uninstall: () => void;
let clock: number;
const nowFake = () => clock;

function repos() {
  return createRepos({
    local: createChromeStorageArea(fake.api.storage.local),
    session: createChromeStorageArea(fake.api.storage.session),
  });
}
// A second tracker over the same storage: the tracker keeps nothing in memory, so this
// reads exactly what the worker's own tracker wrote.
function tracker() {
  return createTracker({ adapter: createChromeAdapter(fake.api), activity: repos().activity });
}

/** A worker start: a fresh copy of the module, its eager initialisation allowed to finish. */
async function startWorker() {
  vi.resetModules();
  const mod = await import('../../src/background/index');
  await mod.initialize();
  await fake.idle();
  return mod;
}

const trustedSender = () => ({ id: fake.runtimeId, url: `chrome-extension://${fake.runtimeId}/dashboard/index.html`, tab: { id: 77 } as chrome.tabs.Tab });
async function fireMessage(message: unknown, sender: chrome.runtime.MessageSender = trustedSender()) {
  const res = await fake.sendMessage(message, sender);
  await fake.idle();
  return res as { ok: boolean; requestId: string; data?: any; error?: string };
}

beforeEach(() => {
  clock = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  fake = createFakeChrome(baseTabs());
  fake.windows.push({ id: 10, focused: true }, { id: 11, focused: false });
  uninstall = installChromeGlobal(fake);
});

afterEach(async () => {
  await fake.idle();
  uninstall();
  vi.restoreAllMocks();
});

describe('worker lifecycle: initialisation', () => {
  it('recovers settings and timers after a worker restart without duplicating the alarm', async () => { // A08
    await repos().settings.write({ ...DEFAULT_SETTINGS, automationEnabled: true });
    await startWorker();
    expect([...fake.alarms.values()].filter((a) => a.name === ALARM_NAME)).toHaveLength(1);
    const snapshotBeforeRestart = await tracker().snapshot();
    expect(Object.keys(snapshotBeforeRestart)).toHaveLength(4);

    clock += 5 * MIN;
    const mod = await startWorker();
    await mod.initialize();
    expect([...fake.alarms.values()].filter((a) => a.name === ALARM_NAME)).toHaveLength(1);
    expect(fake.counts['alarms.create']).toBe(1);
    expect(await tracker().snapshot()).toEqual(snapshotBeforeRestart);
  });

  it('does not reset timers on each wake', async () => {                                       // F4
    const mod = await startWorker();
    await mod.initialize();
    const before = await tracker().snapshot();
    await mod.initialize();
    expect(await tracker().snapshot()).toEqual(before);
    // And across a real restart well after discovery: the stored timers stand.
    clock += 30 * MIN;
    await startWorker();
    expect(await tracker().snapshot()).toEqual(before);
    expect(before[2]!.backgroundSince).toBe(T0);
  });

  it('reconciles an unfinished batch on the next wake, without being asked', async () => {     // A21
    const record: InFlightBatch = {
      operationId: 'op1', trigger: 'manual-bulk', mode: 'manual-bulk', startedAt: T0 - MIN,
      pending: [2], done: [],
    };
    fake.storage.session.data.set(KEYS.batch, record);
    // A wake: the module loads. Nothing calls initialize().
    vi.resetModules();
    await import('../../src/background/index');
    await vi.waitFor(async () => {
      expect((await repos().history.read()).some((h) => h.outcome === 'unknown' && h.operationId === 'op1')).toBe(true);
    });
    expect(fake.storage.session.data.has(KEYS.batch)).toBe(false);
    expect(fake.calls.discard).toBe(0); // reconciled, never replayed
  });

  it('runs exactly one initialisation when events arrive before it finishes, and handlers wait for it', async () => {
    // Overdue background tabs, automation on, and no session record: until recovery writes
    // the grace, an alarm that ran early would unload them all at once.
    await repos().settings.write({ ...DEFAULT_SETTINGS, automationEnabled: true });
    await repos().activity.writeAll({
      2: { tabId: 2, backgroundSince: T0 - 60 * MIN, protectedForSession: false },
      4: { tabId: 4, backgroundSince: T0 - 60 * MIN, protectedForSession: false },
    });
    fake.alarms.set(ALARM_NAME, { name: ALARM_NAME, periodInMinutes: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fake.storage.local.onBeforeGet = async (key) => { if (key === KEYS.settings) await gate; };

    vi.resetModules();
    const mod = await import('../../src/background/index');
    const events = [
      fake.fireAlarm(ALARM_NAME),
      fake.activate(2),
      mod.initialize(),
      mod.initialize(),
    ];
    release();
    await Promise.all(events);
    await fake.idle();

    // Nothing ran before the grace was in force...
    expect(fake.calls.discard).toBe(0);
    expect((await repos().session.read())!.graceUntil).toBe(T0 + STARTUP_GRACE_MS);
    // ...and there was one recovery, not one per caller. Only syncAlarm reads the alarm.
    expect(fake.counts['alarms.get']).toBe(1);
  });
});

/** Automation on, grace long over, and tabs 2 and 4 idle for an hour. */
async function overdueAndArmed() {
  await repos().settings.write({ ...DEFAULT_SETTINGS, automationEnabled: true });
  await repos().session.write({ discoveredAt: T0 - 120 * MIN, graceUntil: T0 - 100 * MIN });
  await repos().activity.writeAll({
    1: { tabId: 1, backgroundSince: null, protectedForSession: false },
    2: { tabId: 2, backgroundSince: T0 - 60 * MIN, protectedForSession: false },
    3: { tabId: 3, backgroundSince: null, protectedForSession: false },
    4: { tabId: 4, backgroundSince: T0 - 60 * MIN, protectedForSession: false },
  });
}

describe('worker lifecycle: browser start and extension update', () => {
  async function fireStartup(at: number) {
    clock = at;
    await fake.fireStartup();
    await fake.idle();
  }

  it('applies discovery timestamps and grace on a fresh browser start', async () => {          // A09
    await startWorker();
    // A new browser session: chrome.storage.session starts empty, and no tab id carries over.
    await fake.storage.session.clear();
    await fireStartup(5_000);
    expect((await repos().session.read())!.graceUntil).toBe(5_000 + STARTUP_GRACE_MS);
    const activity = await tracker().snapshot();
    expect(Object.keys(activity)).toHaveLength(4);
    expect(Object.values(activity).every((a) => a.backgroundSince === null || a.backgroundSince === 5_000)).toBe(true);
  });

  it('does the same after an extension update, and does not restart a grace already running', async () => {
    await startWorker();
    await fake.storage.session.clear();
    clock = T0 + MIN;
    await fake.fireInstalled('update');
    await fake.idle();
    expect((await repos().session.read())!.graceUntil).toBe(T0 + MIN + STARTUP_GRACE_MS);
    // A second start signal in the same session finds the session record and leaves it.
    clock = T0 + 2 * MIN;
    await fake.fireStartup();
    await fake.idle();
    expect((await repos().session.read())!.graceUntil).toBe(T0 + MIN + STARTUP_GRACE_MS);
  });
});

describe('worker lifecycle: tabs moving between windows', () => {
  it('does not reset a background tab\'s timer when it moves window', async () => {
    await startWorker();
    clock += 5 * MIN;
    await fake.moveTab(2, 11, 2);
    await fake.idle();
    expect((await tracker().snapshot())[2]!.backgroundSince).toBe(T0);
  });

  it('reconciles selection in the window a tab arrives in', async () => {
    await startWorker();
    clock += 5 * MIN;
    // Tab 4 is dragged into window 10 and arrives there selected. Only the attach says so.
    await fake.fire('tabs.onDetached', 4, { oldWindowId: 11, oldPosition: 1 });
    const t4 = fake.tabs.find((t) => t.id === 4)!;
    t4.windowId = 10;
    t4.index = 2;
    fake.setActive(4);
    await fake.fire('tabs.onAttached', 4, { newWindowId: 10, newPosition: 2 });
    await fake.idle();
    const a = await tracker().snapshot();
    expect(a[4]!.backgroundSince).toBe(null);       // selected where it landed
    expect(a[1]!.backgroundSince).toBe(T0 + 5 * MIN); // the tab it displaced starts its timer
    expect(a[2]!.backgroundSince).toBe(T0);           // an unrelated background tab is untouched
  });

  it('reconciles selection in the window a selected tab leaves', async () => {
    await startWorker();
    clock += 5 * MIN;
    // The selected tab 3 is dragged out of window 11 into a new window 12; window 11
    // selects tab 4 in its place.
    const t3 = fake.tabs.find((t) => t.id === 3)!;
    t3.windowId = 12;
    fake.setActive(4);
    fake.setActive(3);
    await fake.fire('tabs.onDetached', 3, { oldWindowId: 11, oldPosition: 0 });
    await fake.idle();
    expect((await tracker().snapshot())[4]!.backgroundSince).toBe(null);
  });
});

describe('worker lifecycle: a window closing', () => {
  it('drops every record the closed window left behind, and keeps the other timers', async () => {
    await startWorker();
    // A record for a tab no event ever told the worker had gone.
    const before = await tracker().snapshot();
    await repos().activity.writeAll({ ...before, 99: { tabId: 99, backgroundSince: T0, protectedForSession: true } });
    clock += 5 * MIN;
    await fake.closeWindow(11);
    await fake.idle();
    const after = await tracker().snapshot();
    expect(Object.keys(after).map(Number).sort()).toEqual([1, 2]);
    expect(after[2]!.backgroundSince).toBe(T0);
  });
});

describe('worker lifecycle: when initialisation fails', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });

  it('never leaves automation armed when the startup grace could not be recorded', async () => { // carry-forward 5
    await overdueAndArmed();
    // The session record is unreadable as a record (so recovery must write a grace), and the
    // write fails. The alarm survives from before the restart, as chrome.alarms does.
    fake.storage.session.data.set(KEYS.session, 'corrupt');
    fake.storage.session.rejectOn.set(`set:${KEYS.session}`, new Error('quota'));
    fake.alarms.set(ALARM_NAME, { name: ALARM_NAME, periodInMinutes: 1 });

    vi.resetModules();
    const mod = await import('../../src/background/index');
    await expect(mod.initialize()).rejects.toThrow();
    expect(fake.alarms.has(ALARM_NAME)).toBe(false);

    // An alarm Chrome had already queued is still delivered; it must not act either.
    await fake.fireAlarm(ALARM_NAME);
    await fake.idle();
    expect(fake.calls.discard).toBe(0);
  });

  it('stays failed rather than adopting defaults, then recovers on a later event', async () => {
    // The owner turned automation ON. An unreadable settings record must not be replaced by
    // DEFAULT_SETTINGS, whose automationEnabled is false: that would quietly clear the alarm.
    await repos().settings.write({ ...DEFAULT_SETTINGS, automationEnabled: true });
    fake.alarms.set(ALARM_NAME, { name: ALARM_NAME, periodInMinutes: 1 });
    const broken = new Error('storage unavailable');
    fake.storage.local.rejectOn.set(`get:${KEYS.settings}`, broken);
    let settingsReads = 0;
    fake.storage.local.onBeforeGet = (key) => { if (key === KEYS.settings) settingsReads++; };

    vi.resetModules();
    const mod = await import('../../src/background/index');
    await expect(mod.initialize()).rejects.toThrow('storage unavailable');
    expect(fake.alarms.has(ALARM_NAME)).toBe(true);
    expect(fake.counts['alarms.clear'] ?? 0).toBe(0);
    expect(fake.counts['alarms.create'] ?? 0).toBe(0);

    // A burst of events straight after does not hammer storage with recovery attempts.
    const readsAfterFailure = settingsReads;
    await fake.activate(2);
    await fake.updateTab(2, { title: 'a' });
    await expect(mod.initialize()).rejects.toThrow();
    expect(settingsReads).toBe(readsAfterFailure);

    // Storage comes back; the next event after the back-off retries and recovers in full.
    fake.storage.local.rejectOn.clear();
    clock += 60_000;
    await fake.activate(4);
    await fake.idle();
    await expect(mod.initialize()).resolves.toBeUndefined();
    expect((await repos().session.read())!.graceUntil).toBe(T0 + 60_000 + STARTUP_GRACE_MS);
    expect(fake.alarms.has(ALARM_NAME)).toBe(true);
  });

  it('surfaces an alarm that could not be armed, and arms it on a later retry', async () => { // carry-forward 7
    await repos().settings.write({ ...DEFAULT_SETTINGS, automationEnabled: true });
    fake.rejectOn.set('alarms.create', new Error('alarms are unavailable'));

    vi.resetModules();
    const mod = await import('../../src/background/index');
    await expect(mod.initialize()).rejects.toThrow(/alarms are unavailable/);
    expect(console.error).toHaveBeenCalled();
    // Visible to the owner, not only in the worker console.
    const snap = await fireMessage({ type: 'GET_SNAPSHOT', requestId: 's1' });
    expect(snap.ok).toBe(true);
    expect(snap.data.startupProblem).toMatch(/alarms are unavailable/);
    expect(snap.data.rows).toHaveLength(4);

    fake.rejectOn.clear();
    clock += 60_000;
    const again = await fireMessage({ type: 'GET_SNAPSHOT', requestId: 's2' });
    expect(fake.alarms.has(ALARM_NAME)).toBe(true);
    expect(again.data.startupProblem).toBe(null);
  });
});

describe('worker lifecycle: the message gate', () => {
  it('unloads through a trusted manual-bulk request, logged as manual', async () => {
    await startWorker();
    clock += 2 * MIN; // past the one-minute bulk floor
    const res = await fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'all' }, mode: 'manual-bulk' });
    expect(res).toMatchObject({ ok: true, requestId: 'a' });
    expect(res.data.confirmed).toBe(2);
    expect((await repos().history.read()).every((h) => h.trigger === 'manual-bulk')).toBe(true);
  });

  it('refuses a message from an untrusted sender', async () => {
    await startWorker();
    clock += 2 * MIN;
    const res = await fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'all' }, mode: 'manual-bulk' },
                                  { id: 'other', url: 'https://evil.test/' });
    expect(res).toMatchObject({ ok: false });
    expect(fake.calls.discard).toBe(0);
  });

  it('derives eligibility from worker state, ignoring any the caller supplies', async () => {   // §10
    const mod = await startWorker();
    clock += 2 * MIN;
    // Through the boundary, an extra field is refused outright and nothing happens...
    for (const extra of [{ eligible: true }, { graceUntil: 0 }, { origins: [] }, { trigger: 'automatic' }]) {
      const res = await fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'tabs', tabIds: [1] }, mode: 'manual-bulk', ...extra });
      expect(res).toMatchObject({ ok: false, requestId: 'a' });
    }
    expect(fake.calls.discard).toBe(0);
    // ...and even handed straight to the worker, past the boundary, the fields do nothing:
    // tab 1 is selected, and the worker's own reading of that is what decides.
    const res = await mod.handleRequest({
      type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'tabs', tabIds: [1] }, mode: 'manual-bulk',
      eligible: true, graceUntil: 0, origins: [], trigger: 'automatic',
    } as never, 77);
    expect((res as any).data.results[0]).toMatchObject({ outcome: 'skipped', reason: 'SELECTED' });
    expect(fake.calls.discard).toBe(0);
    expect((await repos().history.read())[0]!.trigger).toBe('manual-bulk');
  });

  it('labels a single named-tab unload manual-single', async () => {
    await startWorker();
    const res = await fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'tab', tabId: 2 }, mode: 'manual-single' });
    expect(res.data.confirmed).toBe(1);
    expect((await repos().history.read())[0]!.trigger).toBe('manual-single');
  });

  it('refuses to execute in auto mode on request: only the alarm runs automation', async () => {
    await overdueAndArmed();
    await startWorker();
    const res = await fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'all' }, mode: 'auto' });
    expect(res).toMatchObject({ ok: false, requestId: 'a' });
    expect(fake.calls.discard).toBe(0);
  });
});

// ---- dashboard origins (A14, design §11.5) ----------------------------------------------

function origins() {
  const adapter = createChromeAdapter(fake.api);
  const r = repos();
  return createOrigins({
    adapter, tracker: createTracker({ adapter, activity: r.activity }), settings: r.settings,
    storage: createChromeStorageArea(fake.api.storage.session),
  });
}

describe('origins', () => {
  it('reports no origins when none was ever registered', async () => {
    expect(await origins().activeOrigins(T0)).toEqual([]);
  });

  // The origin is the page the owner left to open the dashboard, so it went into the
  // background when they did: tab 2, background since T0.
  async function originLeftAt(at: number) {
    await repos().activity.writeAll({ 2: { tabId: 2, backgroundSince: at, protectedForSession: false } });
  }

  it('keeps the origin tab out of bulk actions and then releases it', async () => {            // A14, design §11.5
    await originLeftAt(T0);
    const o = origins();
    await o.registerOrigin(2, T0);
    expect(await o.activeOrigins(T0 + 60_000)).toEqual([2]);
    const threshold = DEFAULT_SETTINGS.inactivityMinutes * 60_000;
    expect(await o.activeOrigins(T0 + threshold - 1)).toEqual([2]);
    expect(await o.activeOrigins(T0 + threshold)).toEqual([]);
  });

  it('drops an origin whose tab has closed', async () => {
    await originLeftAt(T0);
    const o = origins();
    await o.registerOrigin(2, T0);
    fake.removeTab(2);
    expect(await o.activeOrigins(T0 + 1_000)).toEqual([]);
  });

  it('never turns an unreadable origin record into "no origins"', async () => {                // item 11
    const o = origins();
    fake.storage.session.rejectOn.set(`get:${KEYS.dashboardOrigins}`, new Error('io'));
    await expect(o.activeOrigins(T0)).rejects.toThrow();
    fake.storage.session.rejectOn.clear();
    for (const corrupt of ['2', [2, '3'], { 0: 2 }, [2, -1], [2.5], null]) {
      fake.storage.session.data.set(KEYS.dashboardOrigins, corrupt);
      await expect(o.activeOrigins(T0), JSON.stringify(corrupt)).rejects.toThrow();
    }
  });

  it.each([
    ['settings', () => fake.storage.local.rejectOn.set(`get:${KEYS.settings}`, new Error('io'))],
    ['the tab list', () => fake.rejectOn.set('tabs.query', new Error('io'))],
    ['the activity timers', () => fake.storage.session.rejectOn.set(`get:${KEYS.activity}`, new Error('io'))],
  ])('keeps every registered origin when %s cannot be read, rather than releasing any', async (_label, breakIt) => {
    // Tab 2 would have expired and tab 4 would count as closed — but neither can be shown
    // without the failed read, so both stay protected.
    await originLeftAt(T0);
    const o = origins();
    await o.registerOrigin(2, T0);
    await o.registerOrigin(4, T0);
    fake.removeTab(4);
    breakIt();
    expect(await o.activeOrigins(T0 + 60 * MIN)).toEqual([2, 4]);
  });

  it('keeps both origins when two dashboards register different tabs, even at once', async () => { // item 13
    const o = origins();
    await Promise.all([o.registerOrigin(2, T0), o.registerOrigin(4, T0)]);
    await o.registerOrigin(2, T0);
    expect(fake.storage.session.data.get(KEYS.dashboardOrigins)).toEqual([2, 4]);
    expect(await o.activeOrigins(T0)).toEqual([2, 4]);
  });

  it('forgets closed and expired origins when the next one is registered, and only then', async () => {
    await originLeftAt(T0);
    const o = origins();
    await o.registerOrigin(2, T0);
    await o.registerOrigin(3, T0);
    fake.removeTab(3);
    // A failed read is not evidence: nothing is forgotten.
    fake.rejectOn.set('tabs.query', new Error('io'));
    await o.registerOrigin(4, T0);
    expect(fake.storage.session.data.get(KEYS.dashboardOrigins)).toEqual([2, 3, 4]);
    fake.rejectOn.clear();
    await o.registerOrigin(4, T0 + 60 * MIN); // tab 2 has expired by now, tab 3 has closed
    expect(fake.storage.session.data.get(KEYS.dashboardOrigins)).toEqual([4]);
  });

  it('lets a new registration replace an unreadable record, but not survive a failed read', async () => {
    const o = origins();
    fake.storage.session.data.set(KEYS.dashboardOrigins, 'corrupt');
    await expect(o.activeOrigins(T0)).rejects.toThrow(); // bulk actions are blocked...
    expect(await o.registerOrigin(4, T0)).toBe(4);         // ...until a dashboard registers again
    expect(await o.activeOrigins(T0)).toEqual([4]);
    fake.storage.session.rejectOn.set(`get:${KEYS.dashboardOrigins}`, new Error('io'));
    await expect(o.registerOrigin(2, T0)).rejects.toThrow();
  });

  describe('a dashboard opened directly (originTabId null)', () => {                            // item 8
    // Window 10 now holds the dashboard (tab 77, selected), two pages the owner left, and a
    // browser page that is not content.
    beforeEach(async () => {
      fake.setTabs([
        tab({ id: 1, windowId: 10, index: 0 }),
        tab({ id: 2, windowId: 10, index: 1 }),
        tab({ id: 5, windowId: 10, index: 2, url: 'chrome://newtab/' }),
        tab({ id: 77, windowId: 10, index: 3, active: true, url: `chrome-extension://${fake.runtimeId}/dashboard/index.html` }),
        tab({ id: 3, windowId: 11, index: 0, active: true }),
        tab({ id: 4, windowId: 11, index: 1 }),
      ]);
      await repos().activity.writeAll({
        1: { tabId: 1, backgroundSince: T0 - 5 * MIN, protectedForSession: false },
        2: { tabId: 2, backgroundSince: T0 - MIN, protectedForSession: false },
        5: { tabId: 5, backgroundSince: T0 - 10_000, protectedForSession: false },
        77: { tabId: 77, backgroundSince: null, protectedForSession: false },
        3: { tabId: 3, backgroundSince: null, protectedForSession: false },
        4: { tabId: 4, backgroundSince: T0 - 5_000, protectedForSession: false },
      });
    });

    it('registers the content tab most recently left in the dashboard\'s own window', async () => {
      const o = origins();
      expect(await o.registerOrigin(null, T0, 77)).toBe(2);
      expect(await o.activeOrigins(T0)).toEqual([2]);
    });

    it('registers nothing when the dashboard has no tab to place it in a window', async () => {
      const o = origins();
      expect(await o.registerOrigin(null, T0, null)).toBe(null);
      expect(await o.activeOrigins(T0)).toEqual([]);
    });

    it('fails rather than guessing when the window cannot be read', async () => {
      const o = origins();
      fake.rejectOn.set('tabs.get', new Error('io'));
      await expect(o.registerOrigin(null, T0, 77)).rejects.toThrow();
      fake.rejectOn.clear();
      fake.storage.session.rejectOn.set(`get:${KEYS.activity}`, new Error('io'));
      await expect(o.registerOrigin(null, T0, 77)).rejects.toThrow();
    });
  });
});

describe('worker lifecycle: the remaining requests', () => {
  it('keeps a tab loaded when the owner says so, and lets it go when they stop', async () => {
    await startWorker();
    clock += 2 * MIN;
    expect(await fireMessage({ type: 'SET_TAB_PROTECTION', requestId: 'p', tabId: 2, isProtected: true }))
      .toMatchObject({ ok: true, requestId: 'p' });
    expect((await tracker().snapshot())[2]).toEqual({ tabId: 2, backgroundSince: T0, protectedForSession: true });
    const res = await fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'x', scope: { kind: 'tab', tabId: 2 }, mode: 'manual-single' });
    expect(res.data.results[0]).toMatchObject({ outcome: 'skipped', reason: 'TAB_PROTECTED' });
    await fireMessage({ type: 'SET_TAB_PROTECTION', requestId: 'q', tabId: 2, isProtected: false });
    expect((await tracker().snapshot())[2]!.protectedForSession).toBe(false);
  });

  it('clears the activity log', async () => {
    await startWorker();
    await fake.updateTab(4, { discarded: true });
    await fake.idle();
    expect(await repos().history.read()).toHaveLength(1);
    expect(await fireMessage({ type: 'CLEAR_HISTORY', requestId: 'c' })).toMatchObject({ ok: true, requestId: 'c' });
    expect(await repos().history.read()).toEqual([]);
  });

  it('refuses a memory sample explicitly rather than pretending to store it', async () => {
    await startWorker();
    const res = await fireMessage({
      type: 'RECORD_MEMORY_SAMPLE', requestId: 'm', sample: { at: T0, capacityBytes: 16e9, availableBytes: 4e9 },
    });
    expect(res).toMatchObject({ ok: false, requestId: 'm' });
    expect(fake.storage.session.data.has(KEYS.memorySamples)).toBe(false);
  });
});

describe('worker lifecycle: A14 through the real worker', () => {
  const bulkAll = (requestId: string) =>
    fireMessage({ type: 'UNLOAD_EXECUTE', requestId, scope: { kind: 'all' }, mode: 'manual-bulk' });
  const resultFor = (res: { data?: any }, tabId: number) => res.data.results.find((r: any) => r.tabId === tabId);

  it('keeps the page the dashboard was opened from out of a bulk unload, until it expires', async () => {
    await startWorker(); // tabs 2 and 4 in the background since T0
    clock += 2 * MIN;
    const reg = await fireMessage({ type: 'REGISTER_DASHBOARD_ORIGIN', requestId: 'r', originTabId: 2 });
    expect(reg).toMatchObject({ ok: true, requestId: 'r', data: { originTabId: 2 } });

    const preview = await fireMessage({ type: 'UNLOAD_PREVIEW', requestId: 'p', scope: { kind: 'all' }, mode: 'manual-bulk' });
    expect(preview.data.eligibleTabIds).toEqual([4]);
    expect(preview.data.skipped).toContainEqual({ tabId: 2, reasons: ['DASHBOARD_ORIGIN'] });

    const first = await bulkAll('x1');
    expect(resultFor(first, 2)).toMatchObject({ outcome: 'skipped', reason: 'DASHBOARD_ORIGIN' });
    expect(resultFor(first, 4)).toMatchObject({ outcome: 'confirmed' });

    // Background for the full configured threshold: an ordinary tab again (design §11.5).
    clock = T0 + DEFAULT_SETTINGS.inactivityMinutes * MIN;
    const later = await bulkAll('x2');
    expect(resultFor(later, 2)).toMatchObject({ outcome: 'confirmed' });
  });

  it('unloads nothing in bulk when it cannot read which tab the dashboard was opened from', async () => {
    await startWorker();
    clock += 2 * MIN;
    await fireMessage({ type: 'REGISTER_DASHBOARD_ORIGIN', requestId: 'r', originTabId: 2 });
    fake.storage.session.rejectOn.set(`get:${KEYS.dashboardOrigins}`, new Error('io'));
    const res = await bulkAll('x');
    expect(res).toMatchObject({ ok: true, data: { blocked: 'dashboard-origins-unreadable', confirmed: 0 } });
    expect(fake.calls.discard).toBe(0);
    // A single named tab is the owner's direct request, which DASHBOARD_ORIGIN never blocks.
    const single = await fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'y', scope: { kind: 'tab', tabId: 4 }, mode: 'manual-single' });
    expect(single.data.confirmed).toBe(1);
  });

  it('resolves a directly opened dashboard to the page it was opened over, from the sender\'s own tab', async () => {
    await startWorker(); // tab 1 is selected in window 10; tab 2 has been in the background since T0
    // The owner, reading tab 1, opens the dashboard in a new tab in the same window. Only a
    // worker that recorded that activation knows tab 1, not tab 2, is the page just left.
    clock += 2 * MIN;
    await fake.createTab(tab({ id: 77, windowId: 10, index: 2, url: `chrome-extension://${fake.runtimeId}/dashboard/index.html` }));
    await fake.activate(77);
    await fake.idle();
    const reg = await fireMessage({ type: 'REGISTER_DASHBOARD_ORIGIN', requestId: 'r', originTabId: null });
    expect(reg).toMatchObject({ ok: true, data: { originTabId: 1 } });
    clock += 2 * MIN; // past the bulk floor, well inside the origin's lifetime
    const res = await bulkAll('x');
    expect(resultFor(res, 1)).toMatchObject({ outcome: 'skipped', reason: 'DASHBOARD_ORIGIN' });
    expect(resultFor(res, 2)).toMatchObject({ outcome: 'confirmed' });
  });
});

describe('worker lifecycle: tabs.onReplaced', () => {
  it('migrates the timer and "Keep loaded" when a discard is what wakes the worker', async () => { // carry-forward 2
    // Mid-session: the owner marked tab 4 "Keep loaded" half an hour after it went idle.
    await repos().session.write({ discoveredAt: T0 - 120 * MIN, graceUntil: T0 - 100 * MIN });
    await repos().activity.writeAll({
      1: { tabId: 1, backgroundSince: null, protectedForSession: false },
      4: { tabId: 4, backgroundSince: T0 - 30 * MIN, protectedForSession: true },
    });
    // Chrome has already renamed tab 4 to 1004 when it wakes the worker to tell it so. The
    // worker's own recovery queries the tabs (seeing only 1004) while that event is pending.
    fake.setTabs(baseTabs().map((t) => (t.id === 4 ? { ...t, id: 1004, discarded: true, status: 'unloaded' } : t)));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fake.storage.local.onBeforeGet = async (key) => { if (key === KEYS.settings) await gate; };

    vi.resetModules();
    const mod = await import('../../src/background/index');
    const event = fake.fire('tabs.onReplaced', 1004, 4);
    release();
    await Promise.all([event, mod.initialize()]);
    await fake.idle();

    const activity = await tracker().snapshot();
    expect(activity[1004]).toEqual({ tabId: 1004, backgroundSince: T0 - 30 * MIN, protectedForSession: true });
    expect(activity[4]).toBeUndefined();
  });

  it('keeps a discarded origin tab an origin under its new id', async () => {                    // item 12
    await startWorker();
    clock += 2 * MIN;
    await fireMessage({ type: 'REGISTER_DASHBOARD_ORIGIN', requestId: 'r', originTabId: 2 });
    const newId = await fake.discardExternally(2);
    await fake.idle();
    const o = origins();
    expect(await o.activeOrigins(clock)).toEqual([newId]);
    // Still on the original timer: it expires when tab 2 would have, not later.
    expect(await o.activeOrigins(T0 + DEFAULT_SETTINGS.inactivityMinutes * MIN)).toEqual([]);
  });
});

describe('worker lifecycle: A12 external attribution', () => {
  it('records an unload it did not request as source unknown', async () => {                   // A12
    const mod = await startWorker();
    await fake.updateTab(4, { discarded: true, status: 'unloaded' });
    await fake.idle();
    const rows = await repos().history.read();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.trigger).toBe('external');
    expect(row.outcome).toBe('confirmed');
    // Belongs to no Fallow operation. NOT '' as the plan wrote it: storage's OPERATION_ID
    // rule drops a row whose id is empty, so '' could never be stored or read back.
    expect(row.operationId).toBe(mod.EXTERNAL_OPERATION_ID);
    expect(row.sessionTabId).toBe(4);
    expect(row.hostname).toBe('site4.test');
    expect(fake.calls.discard).toBe(0); // Fallow issued nothing
  });

  it('records Chrome\'s own discard, which renames the tab first, once and under the new id', async () => {
    await startWorker();
    const newId = await fake.discardExternally(4);
    await fake.idle();
    const rows = await repos().history.read();
    expect(rows.map((r) => [r.trigger, r.sessionTabId, r.outcome])).toEqual([['external', newId, 'confirmed']]);
    // And the tracker followed the tab to its new id.
    expect((await tracker().snapshot())[newId]!.backgroundSince).toBe(T0);
  });

  const externalRows = async () => (await repos().history.read()).filter((r) => r.trigger === 'external');

  it.each(['before-resolve', 'after-resolve'] as const)(
    'does not log Fallow\'s own manual unload as external (events delivered %s)', async (timing) => {
      await startWorker();
      fake.discardEventTiming = timing;
      clock += 2 * MIN;
      const res = await fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'all' }, mode: 'manual-bulk' });
      await fake.idle();
      expect(res.data.confirmed).toBe(2);
      expect(await externalRows()).toEqual([]);
      // Fallow's own rows for those two unloads, and no second row for either.
      const rows = await repos().history.read();
      expect(rows.filter((r) => r.trigger === 'manual-bulk' && r.outcome === 'confirmed').map((r) => r.sessionTabId).sort()).toEqual([2, 4]);
    });

  it.each(['before-resolve', 'after-resolve'] as const)(
    'does not log Fallow\'s own automatic unload as external (events delivered %s)', async (timing) => {
      await overdueAndArmed();
      await startWorker();
      fake.discardEventTiming = timing;
      await fake.fireAlarm(ALARM_NAME);
      await fake.idle();
      expect(fake.calls.discard).toBe(2);
      expect(await externalRows()).toEqual([]);
    });

  it('follows the rename when Chrome answers a discard without the new id', async () => {
    await startWorker();
    fake.discardBehaviour = 'resolve-without-id';
    fake.discardEventTiming = 'after-resolve';
    const res = await fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'tab', tabId: 2 }, mode: 'manual-single' });
    await fake.idle();
    // The report cannot name the new id (it is 'unknown' with no newTabId) — only Chrome's
    // onReplaced links it back to tab 2, which the batch did act on.
    expect(res.data.results[0]).toEqual({ tabId: 2, outcome: 'unknown' });
    expect(await externalRows()).toEqual([]);
  });

  it('does not misattribute a renamed tab once CLAIM_TTL_MS has passed before its OWN batch settles', async () => {
    // The rename record for an early tab in a slow multi-tab batch is timestamped when
    // onReplaced fires for THAT tab, not when the batch as a whole finishes. If the batch
    // takes longer than CLAIM_TTL_MS to settle — plausible for an uncapped manual-bulk
    // scope with several tabs, each confirmed in its own backoff loop — the early tab's
    // rename record must not be pruned before recordExternalUnload finally gets to check
    // it, which only happens once every in-flight operation has resolved.
    const mod = await startWorker();
    clock += 2 * MIN; // past the one-minute bulk floor
    fake.discardBehaviour = 'resolve-without-id';
    // 'before-resolve': tab 2's onReplaced/onUpdated pair fires synchronously, right as its
    // own discard call resolves — well BEFORE tab 4 is even attempted — so renamedFrom for
    // tab 2's new id is written at the clock's ORIGINAL value, not the jumped one.
    fake.discardEventTiming = 'before-resolve';
    // Suspend tab 4's discard call entirely: the whole operation cannot settle until this
    // resolves, which is exactly the window a slow/large batch would occupy in production.
    let releaseTab4: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { releaseTab4 = resolve; });
    fake.onBeforeDiscard = (_id, n) => (n === 2 ? held : undefined);

    const fired = fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'tabs', tabIds: [2, 4] }, mode: 'manual-bulk' });
    // Give tab 2's synchronous rename+event pair, and tab 4's suspension, time to land.
    await new Promise((r) => setTimeout(r, 0));
    // Only now, with tab 2 already renamed and its externally-looking onUpdated already
    // queued behind Promise.allSettled(inFlight), does CLAIM_TTL_MS elapse.
    clock += mod.CLAIM_TTL_MS + 1_000;
    releaseTab4();
    const res = await fired;
    await fake.idle();

    expect(res.data.confirmed + res.data.unknown).toBe(2);
    expect(await externalRows()).toEqual([]);
    const rows = await repos().history.read();
    expect(rows.filter((r) => r.operationId === mod.EXTERNAL_OPERATION_ID)).toEqual([]);
    expect(rows.map((r) => r.sessionTabId).sort()).toEqual([2, 4]);
  });

  it('logs a tab Chrome unloads while a Fallow batch is running on other tabs', async () => {
    await startWorker();
    fake.discardEventTiming = 'before-resolve';
    let externalId = -1;
    // While Fallow unloads tab 2, Chrome independently unloads tab 4, outside this batch.
    fake.onBeforeDiscard = (_id, n) => {
      if (n === 1) {
        externalId = fake.nextId++;
        void fake.discardExternally(4, externalId);
      }
    };
    await fireMessage({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'tab', tabId: 2 }, mode: 'manual-single' });
    await fake.idle();
    expect((await externalRows()).map((r) => r.sessionTabId)).toEqual([externalId]);
    expect(fake.calls.discard).toBe(1);
  });

  it('does not log a stopped worker\'s unfinished batch as external when its events reach the next worker', async () => {
    const record: InFlightBatch = {
      operationId: 'op1', trigger: 'manual-bulk', mode: 'manual-bulk', startedAt: T0 - 1_000,
      pending: [2], done: [],
    };
    fake.storage.session.data.set(KEYS.batch, record);
    // The discard of tab 2 went through just before the old worker stopped.
    fake.setTabs(baseTabs().map((t) => (t.id === 2 ? { ...t, id: 1002, discarded: true, status: 'unloaded' } : t)));
    vi.resetModules();
    await import('../../src/background/index');
    await Promise.all([
      fake.fire('tabs.onReplaced', 1002, 2),
      fake.fire('tabs.onUpdated', 1002, { discarded: true }, { ...fake.tabs.find((t) => t.id === 1002) }),
    ]);
    await fake.idle();
    const rows = await repos().history.read();
    expect(rows.map((r) => [r.trigger, r.sessionTabId, r.outcome])).toEqual([['manual-bulk', 2, 'unknown']]);
  });

  it('refuses a batch that names the reserved external operation id', async () => {
    const mod = await startWorker();
    const res = await fireMessage({
      type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'tab', tabId: 2 }, mode: 'manual-single',
      operationId: mod.EXTERNAL_OPERATION_ID,
    });
    expect(res).toMatchObject({ ok: false, requestId: 'a' });
    expect(fake.calls.discard).toBe(0);
  });

  it('ignores updates that are not an unload', async () => {
    await startWorker();
    await fake.updateTab(4, { title: 'changed', status: 'loading' });
    await fake.updateTab(4, { discarded: false });
    await fake.idle();
    expect(await repos().history.read()).toEqual([]);
  });
});

describe('worker lifecycle: settings changes that must start a grace interval (plan §4)', () => {
  const update = (requestId: string, patch: unknown) => fireMessage({ type: 'UPDATE_SETTINGS', requestId, patch });

  it('starts a grace interval when automation is switched on', async () => {
    await startWorker();
    clock += 10 * MIN;
    const res = await update('a', { automationEnabled: true });
    expect(res).toMatchObject({ ok: true, requestId: 'a', data: { automationEnabled: true } });
    expect((await repos().session.read())!.graceUntil).toBe(nowFake() + STARTUP_GRACE_MS);
    expect(fake.alarms.has(ALARM_NAME)).toBe(true);
    expect((await repos().settings.read()).automationEnabled).toBe(true);
  });

  it('starts a grace interval when the threshold is shortened, but not when lengthened', async () => {
    await repos().settings.write({ ...DEFAULT_SETTINGS, automationEnabled: true, inactivityMinutes: 30 });
    await startWorker();
    clock += 10 * MIN;
    await update('a', { inactivityMinutes: 5 });
    expect((await repos().session.read())!.graceUntil).toBe(nowFake() + STARTUP_GRACE_MS);
    await repos().session.write({ discoveredAt: 0, graceUntil: null });
    await update('b', { inactivityMinutes: 60 });
    expect((await repos().session.read())!.graceUntil).toBe(null);
    expect((await repos().settings.read()).inactivityMinutes).toBe(60);
  });

  it('changes nothing and arms nothing when the grace cannot be recorded', async () => {     // carry-forward 5
    await startWorker();
    fake.storage.session.rejectOn.set(`set:${KEYS.session}`, new Error('quota'));
    const res = await update('a', { automationEnabled: true });
    expect(res).toMatchObject({ ok: false, requestId: 'a' });
    expect((await repos().settings.read()).automationEnabled).toBe(false);
    expect(fake.alarms.has(ALARM_NAME)).toBe(false);
    expect(fake.counts['alarms.create'] ?? 0).toBe(0);
  });

  it('refuses rather than patching defaults when the current settings cannot be read', async () => {
    await repos().settings.write({ ...DEFAULT_SETTINGS, automationEnabled: true, inactivityMinutes: 30, protectedSites: [] });
    await startWorker();
    fake.storage.local.rejectOn.set(`get:${KEYS.settings}`, new Error('io'));
    const res = await update('a', { protectPinned: false });
    expect(res).toMatchObject({ ok: false, requestId: 'a' });
    fake.storage.local.rejectOn.clear();
    // The owner's settings are exactly as they were, not defaults plus the patch.
    expect(await repos().settings.read()).toEqual({ ...DEFAULT_SETTINGS, automationEnabled: true, inactivityMinutes: 30, protectedSites: [] });
    expect(fake.alarms.has(ALARM_NAME)).toBe(true);
  });

  it('treats a patch whose getter throws as a refusal, not a crash and not a partial change', async () => { // carry-forward 9
    const mod = await startWorker();
    const hostile = { automationEnabled: true, get inactivityMinutes(): number { throw new Error('boom'); } };
    const res = await mod.handleRequest({ type: 'UPDATE_SETTINGS', requestId: 'a', patch: hostile }, 77);
    expect(res).toMatchObject({ ok: false, requestId: 'a' });
    expect((await repos().settings.read()).automationEnabled).toBe(false);
    expect((await repos().session.read())!.graceUntil).toBe(T0 + STARTUP_GRACE_MS); // only the startup grace
    // A patch that is not an object at all is refused the same way.
    for (const patch of ['automationEnabled', 42, true, ['x']]) {
      const r = await fireMessage({ type: 'UPDATE_SETTINGS', requestId: 'b', patch });
      expect(r, JSON.stringify(patch)).toMatchObject({ ok: false, requestId: 'b' });
    }
  });

  it('reports a schedule that did not follow the saved settings', async () => {              // carry-forward 7
    await startWorker();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fake.rejectOn.set('alarms.create', new Error('alarms are unavailable'));
    const res = await update('a', { automationEnabled: true });
    expect(res).toMatchObject({ ok: false, requestId: 'a', error: expect.stringMatching(/saved/i) });
    expect((await repos().settings.read()).automationEnabled).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it('stops the schedule, without a grace, when automation is switched off', async () => {
    await repos().settings.write({ ...DEFAULT_SETTINGS, automationEnabled: true });
    await startWorker();
    await repos().session.write({ discoveredAt: 0, graceUntil: null });
    const res = await update('a', { automationEnabled: false });
    expect(res).toMatchObject({ ok: true, data: { automationEnabled: false } });
    expect(fake.alarms.has(ALARM_NAME)).toBe(false);
    expect((await repos().session.read())!.graceUntil).toBe(null);
  });
});

describe('worker lifecycle: the alarm', () => {
  it('runs one automatic batch when the alarm fires', async () => {
    await overdueAndArmed();
    await startWorker();
    await fake.fireAlarm(ALARM_NAME);
    await fake.idle();
    expect(fake.calls.discard).toBe(2);
    const rows = await repos().history.read();
    expect(rows.map((r) => [r.sessionTabId, r.trigger, r.outcome]).sort()).toEqual([
      [2, 'automatic', 'confirmed'], [4, 'automatic', 'confirmed'],
    ]);
  });

  it('ignores an alarm that is not Fallow\'s', async () => {
    await overdueAndArmed();
    await startWorker();
    await fake.fire('alarms.onAlarm', { name: 'something-else', scheduledTime: clock });
    await fake.idle();
    expect(fake.calls.discard).toBe(0);
  });
});
