import { createChromeAdapter, type ChromeAdapter } from '../../src/platform/chrome-adapter';
import { createRepos } from '../../src/platform/storage';
import { createTracker, type Tracker } from '../../src/background/tracker';
import { createInventory, type Inventory } from '../../src/background/inventory';
import { createExecutor, type Executor } from '../../src/background/executor';
import { createScheduler, type Scheduler } from '../../src/background/scheduler';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import type { Settings } from '../../src/domain/types';
import { ALARM_NAME, AUTO_BATCH_MAX, STARTUP_GRACE_MS } from '../../src/domain/constants';
import { createFakeChrome, type FakeChrome, type FakeTab } from '../fake-chrome';
import { createFakeStorage, type FakeStorage } from '../fake-storage';

const T0 = 1_000;
const NOW = T0 + 60 * 60_000; // an hour after discovery: old enough for every timing check

const ON: Settings = { ...DEFAULT_SETTINGS, automationEnabled: true, inactivityMinutes: 1 };
const OFF: Settings = { ...DEFAULT_SETTINGS, automationEnabled: false, inactivityMinutes: 1 };

function tab(p: FakeTab & { id: number }): FakeTab {
  return {
    index: p.id, windowId: 10, groupId: -1, url: `https://h${p.id}.test/`, title: `t${p.id}`,
    active: false, audible: false, pinned: false, discarded: false, autoDiscardable: true,
    status: 'complete', ...p,
  };
}

// Tab 1 is selected; 2 and 3 are loaded and idle: the only tabs automation may unload.
function baseTabs(): FakeTab[] {
  return [
    tab({ id: 1, index: 0, active: true }),
    tab({ id: 2, index: 1 }),
    tab({ id: 3, windowId: 11, index: 0 }),
  ];
}

function manyIdleTabs(n: number): FakeTab[] {
  const tabs: FakeTab[] = [tab({ id: 1, index: 0, active: true })];
  for (let i = 0; i < n; i++) tabs.push(tab({ id: 100 + i, index: i + 1 }));
  return tabs;
}

let fake: FakeChrome;
let storage: FakeStorage;
let repos: ReturnType<typeof createRepos>;
let adapter: ChromeAdapter;
let tracker: Tracker;
let inventory: Inventory;
let executor: Executor;
let scheduler: Scheduler;
let adapterCalls: string[];
let clock: number;

const alarms = () => [...fake.alarms.values()];

function mount() {
  const real = createChromeAdapter(fake.api);
  adapterCalls = [];
  // Records every adapter method the scheduler itself touches, so a test can prove the
  // scheduler never reaches a tab operation directly.
  adapter = new Proxy(real, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => { adapterCalls.push(String(prop)); return (v as (...x: unknown[]) => unknown)(...a); };
    },
  });
  tracker = createTracker({ adapter: real, activity: repos.activity });
  inventory = createInventory({
    adapter: real, tracker, session: repos.session, settings: repos.settings,
    dashboardOrigins: async () => [],
  });
  executor = createExecutor({
    adapter: real, inventory, tracker, settings: repos.settings, history: repos.history,
    session: repos.session, storage: storage.session,
    dashboardOrigins: async () => [], now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  scheduler = createScheduler({ adapter, executor, settings: repos.settings, session: repos.session, inventory });
}

// Discovers the tabs long before NOW so no timing check masks the behaviour under test.
async function seed(tabs: FakeTab[]) {
  fake.setTabs(tabs);
  await inventory.capture(T0);
}

beforeEach(async () => {
  clock = NOW;
  fake = createFakeChrome([]);
  fake.windows.push({ id: 10, focused: true }, { id: 11, focused: false });
  storage = createFakeStorage();
  repos = createRepos(storage);
  mount();
  await repos.settings.write(ON);
});

describe('scheduler: alarm', () => {
  it('creates exactly one alarm when automation is enabled', async () => {                  // A08
    await scheduler.syncAlarm(ON);
    await scheduler.syncAlarm(ON);
    expect(alarms().filter((a) => a.name === ALARM_NAME)).toHaveLength(1);
    expect(alarms()[0]?.periodInMinutes).toBe(1);
  });

  it('removes the alarm when automation is disabled', async () => {                         // A20
    await scheduler.syncAlarm(ON);
    await scheduler.syncAlarm(OFF);
    expect(alarms()).toHaveLength(0);
  });
});

describe('scheduler: onAlarm gating', () => {
  beforeEach(() => seed(baseTabs()));

  it('ignores an alarm that is not ours', async () => {
    const queriesBefore = fake.calls.query;
    expect(await scheduler.onAlarm('someone-elses-alarm', NOW)).toBe(null);
    expect(fake.calls.discard).toBe(0);
    expect(fake.calls.query).toBe(queriesBefore);
  });

  it('does nothing on an alarm while automation is off', async () => {                      // F3
    await repos.settings.write(OFF);
    expect(await scheduler.onAlarm(ALARM_NAME, NOW)).toBe(null);
    expect(fake.calls.discard).toBe(0);
  });
});

describe('scheduler: an automatic run', () => {
  beforeEach(() => seed(baseTabs()));

  it('runs an automatic batch through the executor when automation is on', async () => {
    const r = await scheduler.onAlarm(ALARM_NAME, NOW);
    expect(r).not.toBeNull();
    expect(r!.trigger).toBe('automatic');
    expect(r!.requested).toBe(2);
    expect(r!.confirmed).toBe(2);
    expect(fake.calls.discard).toBe(2);
  });
});

describe('scheduler: unreadable state holds', () => {
  beforeEach(() => seed(baseTabs()));

  it('holds when settings cannot be read, and does not fall back to defaults', async () => {   // case 1
    storage.local.rejectOn.set('get:fallow.settings', new Error('storage down'));
    expect(await scheduler.onAlarm(ALARM_NAME, NOW)).toBeNull();
    expect(fake.calls.discard).toBe(0);
  });

  it('holds when settings throw synchronously', async () => {
    storage.local.throwOn.set('get:fallow.settings', new Error('sync boom'));
    expect(await scheduler.onAlarm(ALARM_NAME, NOW)).toBeNull();
    expect(fake.calls.discard).toBe(0);
  });

  it('holds when the grace record cannot be read: unreadable is not "no grace"', async () => {  // case 2
    storage.session.rejectOn.set('get:fallow.session', new Error('session down'));
    expect(await scheduler.onAlarm(ALARM_NAME, NOW)).toBeNull();
    expect(fake.calls.discard).toBe(0);
  });
});

describe('scheduler: grace', () => {
  beforeEach(() => seed(baseTabs()));

  it('issues no requests during grace and resumes after it', async () => {                   // A16
    clock = 1_000;
    await scheduler.beginGrace(1_000, 'startup');
    expect(await scheduler.onAlarm(ALARM_NAME, 1_000 + 60_000)).toBe(null);
    expect(fake.calls.discard).toBe(0);
    clock = 1_000 + STARTUP_GRACE_MS + 1;       // the executor reads its own clock as well
    const r = await scheduler.onAlarm(ALARM_NAME, clock);
    expect(r!.requested).toBeGreaterThan(0);
    expect(r!.confirmed).toBe(2);
  });

  it('starts a two-minute grace when automation is switched on', async () => {              // F4
    await scheduler.beginGrace(1_000, 'automation-on');
    expect((await repos.session.read())!.graceUntil).toBe(1_000 + STARTUP_GRACE_MS);
  });
});

describe('scheduler: beginGrace failures', () => {
  it('keeps the recorded discovery time when it starts a grace', async () => {
    await repos.session.write({ discoveredAt: 42, graceUntil: null });
    await scheduler.beginGrace(1_000, 'threshold-shortened');
    expect(await repos.session.read()).toEqual({ discoveredAt: 42, graceUntil: 1_000 + STARTUP_GRACE_MS });
  });

  it('rejects when the grace cannot be recorded, so the caller knows it is not in force', async () => {  // case 3
    storage.session.rejectOn.set('set:fallow.session', new Error('quota'));
    await expect(scheduler.beginGrace(1_000, 'automation-on')).rejects.toThrow('quota');
    expect(await repos.session.read()).toBeNull();
  });

  it('writes nothing when the existing record cannot be read: it will not invent a discovery time', async () => {
    storage.session.rejectOn.set('get:fallow.session', new Error('session down'));
    await expect(scheduler.beginGrace(1_000, 'startup')).rejects.toThrow('session down');
    expect(storage.session.writes).toBe(0);
  });

  it('rejects a non-finite clock instead of recording a grace that never ends or never starts', async () => {  // case 6
    await expect(scheduler.beginGrace(Number.NaN, 'startup')).rejects.toThrow(/finite/);
    await expect(scheduler.beginGrace(Infinity, 'startup')).rejects.toThrow(/finite/);
    expect(storage.session.writes).toBe(0);
  });
});

describe('scheduler: the clock', () => {
  beforeEach(() => seed(baseTabs()));

  it.each([Number.NaN, Infinity, -Infinity])('holds on a non-finite clock (%p)', async (bad) => {   // case 6
    expect(await scheduler.onAlarm(ALARM_NAME, bad)).toBeNull();
    expect(fake.calls.discard).toBe(0);
  });

  it('re-bases a grace that lies further ahead than a grace can, and holds meanwhile', async () => { // case 6
    // The clock was set back (NTP, sleep): graceUntil is an hour ahead of a 2 minute window.
    await repos.session.write({ discoveredAt: T0, graceUntil: NOW + 60 * 60_000 });
    expect(await scheduler.onAlarm(ALARM_NAME, NOW)).toBeNull();
    expect(fake.calls.discard).toBe(0);
    expect((await repos.session.read())!.graceUntil).toBe(NOW + STARTUP_GRACE_MS);
    // It does not wait out the hour: a grace measured from the corrected clock ends normally.
    const r = await scheduler.onAlarm(ALARM_NAME, NOW + STARTUP_GRACE_MS + 1);
    expect(r!.requested).toBe(2);
  });

  it('does not rewrite a grace that is genuinely in force', async () => {
    await repos.session.write({ discoveredAt: T0, graceUntil: NOW + 30_000 });
    const writes = storage.session.writes;
    expect(await scheduler.onAlarm(ALARM_NAME, NOW)).toBeNull();
    expect(storage.session.writes).toBe(writes);
    expect((await repos.session.read())!.graceUntil).toBe(NOW + 30_000);
  });

  it('still holds if the corrected grace cannot be written', async () => {
    await repos.session.write({ discoveredAt: T0, graceUntil: NOW + 60 * 60_000 });
    storage.session.rejectOn.set('set:fallow.session', new Error('quota'));
    expect(await scheduler.onAlarm(ALARM_NAME, NOW)).toBeNull();
    expect(fake.calls.discard).toBe(0);
  });
});

describe('scheduler: batch size and concurrency', () => {
  it('caps a wake-from-sleep backlog at the automatic batch limit', async () => {           // A16
    await seed(manyIdleTabs(60));
    const r = await scheduler.onAlarm(ALARM_NAME, NOW);
    expect(r!.requested).toBe(AUTO_BATCH_MAX);
    // The number the owner gets, not just the number the report claims.
    expect(fake.calls.discard).toBe(AUTO_BATCH_MAX);
    expect(fake.tabs.filter((t) => t.discarded)).toHaveLength(AUTO_BATCH_MAX);
  });

  it('runs one batch when two alarms fire at once', async () => {                            // case 9
    await seed(manyIdleTabs(60));
    const [a, b] = await Promise.all([
      scheduler.onAlarm(ALARM_NAME, NOW), scheduler.onAlarm(ALARM_NAME, NOW),
    ]);
    expect(fake.calls.discard).toBe(AUTO_BATCH_MAX);
    expect(fake.maxConcurrentDiscards).toBe(1);
    expect(a!.requested).toBe(AUTO_BATCH_MAX);
    // The second event is answered with the batch already in flight, not a second batch.
    expect(b).toBe(a);
  });

  it('allows the next alarm to run once the previous batch has finished', async () => {
    await seed(manyIdleTabs(60));
    await scheduler.onAlarm(ALARM_NAME, NOW);
    await scheduler.onAlarm(ALARM_NAME, NOW + 60_000);
    expect(fake.calls.discard).toBe(2 * AUTO_BATCH_MAX);
  });

  it('allows the next alarm after a failed run', async () => {
    await seed(manyIdleTabs(5));
    storage.local.rejectOn.set('get:fallow.settings', new Error('down'));
    expect(await scheduler.onAlarm(ALARM_NAME, NOW)).toBeNull();
    storage.local.rejectOn.clear();
    expect((await scheduler.onAlarm(ALARM_NAME, NOW + 60_000))!.requested).toBe(5);
  });
});

describe('scheduler: while a manual batch is running', () => {            // case 7
  function idle(n: number): FakeTab[] {
    return [tab({ id: 1, index: 0, active: true }), ...Array.from({ length: n }, (_, i) => tab({ id: 10 + i, index: i + 1 }))];
  }

  it('queues behind the manual batch and plans from what is left, never from the old plan', async () => {
    await seed(idle(6));
    let auto: Promise<unknown> | null = null;
    fake.onBeforeDiscard = (_id, n) => {
      if (n === 1) auto = scheduler.onAlarm(ALARM_NAME, NOW);
    };
    const manual = await executor.execute({ kind: 'tabs', tabIds: [10, 11] }, 'manual-bulk', 'manual-bulk', NOW);
    const report = (await auto) as Awaited<ReturnType<Scheduler['onAlarm']>>;
    expect(manual.requested).toBe(2);
    expect(fake.maxConcurrentDiscards).toBe(1);
    // Each of the six tabs was asked for exactly once, by exactly one of the two batches.
    const asked = [...manual.results, ...report!.results].map((r) => r.tabId).sort((a, b) => a - b);
    expect(asked).toEqual([10, 11, 12, 13, 14, 15]);
    expect(fake.calls.discard).toBe(6);
    expect(report!.trigger).toBe('automatic');
  });

  it('does not act on a settings read taken before it queued: switching automation off wins', async () => {
    await seed(idle(6));
    let auto: Promise<unknown> | null = null;
    fake.onBeforeDiscard = async (_id, n) => {
      if (n !== 1) return;
      auto = scheduler.onAlarm(ALARM_NAME, NOW);          // reads settings: automation is on
      await Promise.resolve(); await Promise.resolve();
      await repos.settings.write(OFF);                      // then the owner turns it off
    };
    const manual = await executor.execute({ kind: 'tabs', tabIds: [10, 11] }, 'manual-bulk', 'manual-bulk', NOW);
    const report = (await auto) as Awaited<ReturnType<Scheduler['onAlarm']>>;
    expect(manual.confirmed).toBe(2);
    expect(fake.calls.discard).toBe(2);   // the manual pair only; automation requested nothing
    expect(report!.blocked).toBe('automation-off');
    expect(report!.requested).toBe(0);
  });
});

describe('scheduler: alarm failures', () => {
  it('creates the alarm anyway when it cannot tell whether one exists, and still ends with one', async () => {  // case 4
    await scheduler.syncAlarm(ON);                              // an alarm already exists
    fake.rejectOn.set('alarms.get', new Error('get failed'));
    await scheduler.syncAlarm(ON);
    expect(fake.counts['alarms.create']).toBe(2);               // it did re-create, blind
    expect(alarms().filter((a) => a.name === ALARM_NAME)).toHaveLength(1);
    expect(alarms()[0]?.periodInMinutes).toBe(1);
  });

  it('does not create a second alarm when the existence check works', async () => {
    await scheduler.syncAlarm(ON);
    await scheduler.syncAlarm(ON);
    expect(fake.counts['alarms.create']).toBe(1);
  });

  it('rejects when the alarm cannot be created: automation would otherwise be armed and dead', async () => {  // case 5
    fake.rejectOn.set('alarms.create', new Error('create failed'));
    await expect(scheduler.syncAlarm(ON)).rejects.toThrow(/create failed/);
    expect(alarms()).toHaveLength(0);
  });

  it('rejects when the alarm cannot be cleared', async () => {                                // case 5
    await scheduler.syncAlarm(ON);
    fake.rejectOn.set('alarms.clear', new Error('clear failed'));
    await expect(scheduler.syncAlarm(OFF)).rejects.toThrow(/clear failed/);
  });

  it('a stray alarm that outlives a failed clear does nothing, because onAlarm re-reads settings', async () => {
    await seed(baseTabs());
    await scheduler.syncAlarm(ON);
    await repos.settings.write(OFF);
    fake.rejectOn.set('alarms.clear', new Error('clear failed'));
    await expect(scheduler.syncAlarm(OFF)).rejects.toThrow();
    expect(await scheduler.onAlarm(ALARM_NAME, NOW)).toBeNull();
    expect(fake.calls.discard).toBe(0);
  });
});

describe('scheduler: pending count', () => {
  beforeEach(() => seed(baseTabs()));

  it('starts a grace when the threshold is shortened and reports the pending count', async () => {
    await scheduler.beginGrace(NOW, 'threshold-shortened');
    expect(await scheduler.pendingEligibleCount(NOW)).toBe(2);
    expect(fake.calls.discard).toBe(0);
  });

  it('counts only tabs that would be unloaded once the grace ends', async () => {
    fake.tabs.push(tab({ id: 4, index: 5, audible: true }), tab({ id: 5, index: 6, pinned: true }));
    await scheduler.beginGrace(NOW, 'threshold-shortened');
    expect(await scheduler.pendingEligibleCount(NOW)).toBe(2);   // not the audible or pinned tab
  });

  it('is zero because of a measurement, not a failure, when automation is off', async () => {
    await repos.settings.write(OFF);
    expect(await scheduler.pendingEligibleCount(NOW)).toBe(0);
  });

  it('rejects when the tab scan failed: no count is not a count of zero', async () => {      // case 8
    fake.rejectOn.set('tabs.query', new Error('no tabs'));
    await expect(scheduler.pendingEligibleCount(NOW)).rejects.toThrow(/tab list/);
  });

  it('rejects when the capture itself rejects', async () => {                                // case 8
    const failing: Inventory = { capture: () => Promise.reject(new Error('capture down')) };
    const s = createScheduler({ adapter, executor, settings: repos.settings, session: repos.session, inventory: failing });
    await expect(s.pendingEligibleCount(NOW)).rejects.toThrow(/capture down/);
  });

  it('rejects when activity could not be read, which would make every tab look held', async () => {
    storage.session.rejectOn.set('get:fallow.activity', new Error('activity down'));
    await expect(scheduler.pendingEligibleCount(NOW)).rejects.toThrow(/activity/);
  });

  it('rejects when settings could not be read, which would hide the owner\'s protected sites', async () => {
    storage.local.rejectOn.set('get:fallow.settings', new Error('settings down'));
    await expect(scheduler.pendingEligibleCount(NOW)).rejects.toThrow(/settings/);
  });

  it('rejects on a non-finite clock', async () => {
    await expect(scheduler.pendingEligibleCount(Number.NaN)).rejects.toThrow(/finite/);
  });
});

describe('scheduler: turning automation off, and what it never touches', () => {
  beforeEach(async () => {
    await seed([...baseTabs(), tab({ id: 9, index: 9, discarded: true, status: 'unloaded' })]);
  });

  it('does not erase timers when automation is turned off', async () => {                   // F3
    await scheduler.syncAlarm(ON);
    const before = await tracker.snapshot();
    expect(Object.keys(before).length).toBeGreaterThan(0);
    await scheduler.syncAlarm(OFF);
    expect(await tracker.snapshot()).toEqual(before);
    expect(storage.session.removes).toBe(0);
    expect(storage.local.removes).toBe(0);
  });

  it('never reloads a discarded tab when automation is turned off', async () => {
    await scheduler.syncAlarm(ON);
    await scheduler.syncAlarm(OFF);
    expect(fake.calls.update).toBe(0);
    expect(fake.calls.get).toBe(0);
    expect(fake.calls.create).toBe(0);
    expect(fake.tabs.filter((t) => t.discarded)).toHaveLength(1);
  });

  it('reaches no tab operation of its own across every entry point', async () => {
    await scheduler.syncAlarm(ON);
    await scheduler.beginGrace(NOW, 'automation-on');
    await scheduler.pendingEligibleCount(NOW);
    await scheduler.onAlarm(ALARM_NAME, NOW);                     // held by the grace
    clock = NOW + STARTUP_GRACE_MS + 1;                           // the executor reads its own clock too
    await scheduler.onAlarm(ALARM_NAME, clock);                   // runs, via the executor
    await scheduler.syncAlarm(OFF);
    expect(fake.calls.discard).toBeGreaterThan(0);                // the executor did act
    // ...but every adapter call the scheduler itself made was an alarm call.
    expect(new Set(adapterCalls)).toEqual(new Set(['getAlarm', 'createAlarm', 'clearAlarm']));
    expect(fake.calls.remove).toBe(0);
    expect(fake.calls.move).toBe(0);
    expect(fake.calls.create).toBe(0);
    expect(fake.calls.update).toBe(0);
    expect(fake.calls.focusTab).toBe(0);
  });

  it('runs an automatic batch as mode auto, trigger automatic, with no operation id of its own', async () => {
    const spy = vi.spyOn(executor, 'execute');
    await scheduler.onAlarm(ALARM_NAME, NOW);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.length).toBe(4);
    expect(spy.mock.calls[0]?.slice(0, 3)).toEqual([{ kind: 'all' }, 'auto', 'automatic']);
  });
});
