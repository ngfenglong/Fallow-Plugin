// Races between what the owner saw and what the browser now reports. Everything here
// is irreversible from the owner's point of view, so each test pins a case where
// acting on a stale decision would take a tab away that should have been left alone.
import { createChromeAdapter } from '../../src/platform/chrome-adapter';
import { createRepos, KEYS } from '../../src/platform/storage';
import { createTracker, type Tracker } from '../../src/background/tracker';
import { createInventory, type Inventory } from '../../src/background/inventory';
import { createExecutor, type BatchReport, type Executor } from '../../src/background/executor';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { AUTO_BATCH_MAX, MANUAL_CHUNK_SIZE } from '../../src/domain/constants';
import type { TabActivity } from '../../src/domain/types';
import { createFakeChrome, type FakeChrome, type FakeTab } from '../fake-chrome';
import { createFakeStorage, type FakeStorage } from '../fake-storage';

const T0 = 1_000;
const NOW = T0 + 60 * 60_000;

function tab(p: FakeTab & { id: number }): FakeTab {
  return {
    index: p.id, windowId: 10, groupId: -1, url: 'https://a.test/', title: `t${p.id}`,
    active: false, audible: false, pinned: false, discarded: false, autoDiscardable: true,
    status: 'complete', ...p,
  };
}

function baseTabs(): FakeTab[] {
  return [
    tab({ id: 1, windowId: 10, index: 0, active: true }),
    tab({ id: 2, windowId: 10, index: 1, groupId: 1 }),
    tab({ id: 3, windowId: 11, index: 0 }),
    tab({ id: 4, windowId: 11, index: 1, audible: true }),
    tab({ id: 5, windowId: 11, index: 2, url: 'https://chatgpt.com/' }),
  ];
}

const manyIdleTabs = (n: number): FakeTab[] =>
  Array.from({ length: n }, (_, i) => tab({ id: 100 + i, windowId: 10, index: i, url: `https://t${i}.test/` }));

let fake: FakeChrome;
let storage: FakeStorage;
let repos: ReturnType<typeof createRepos>;
let tracker: Tracker;
let inventory: Inventory;
let executor: Executor;
let origins: () => Promise<readonly number[]>;
let captures: number[];
let clock: number;
let planted: Record<number, TabActivity>;

const now = () => clock;
const sleep = (ms: number): Promise<void> => { clock += ms; return Promise.resolve(); };

function mount() {
  const adapter = createChromeAdapter(fake.api);
  tracker = createTracker({ adapter, activity: repos.activity });
  const real = createInventory({
    adapter, tracker, session: repos.session, settings: repos.settings,
    dashboardOrigins: () => origins(),
  });
  captures = [];
  inventory = { capture: (at) => { captures.push(at); return real.capture(at); } };
  executor = createExecutor({
    adapter, inventory, tracker, settings: repos.settings, history: repos.history,
    session: repos.session, storage: storage.session, now, sleep,
  });
}

async function seed(tabs: FakeTab[]) {
  fake.setTabs(tabs);
  await inventory.capture(T0);
  captures = [];
}

// A distinct background time per tab, deliberately not in tab-id order, planted straight
// into session storage so reconcile preserves it rather than discovering everything at once.
async function seedBacklog(n: number) {
  const tabs = manyIdleTabs(n);
  fake.setTabs(tabs);
  planted = {};
  tabs.forEach((t, i) => {
    const id = t.id as number;
    planted[id] = { tabId: id, backgroundSince: T0 + ((i * 7) % n) * 1_000, protectedForSession: false };
  });
  await storage.session.set(KEYS.activity, planted);
  captures = [];
}

const oldestFirst = (): number[] =>
  Object.values(planted)
    .slice()
    .sort((a, b) => (a.backgroundSince ?? 0) - (b.backgroundSince ?? 0))
    .map((a) => a.tabId);

function currentOperationId(): string {
  const record = storage.session.data.get(KEYS.batch) as { operationId?: string } | undefined;
  if (!record?.operationId) throw new Error('no in-flight record to cancel');
  return record.operationId;
}

function expectCountersSum(r: BatchReport) {
  expect(r.requested).toBe(r.confirmed + r.alreadyUnloaded + r.skipped + r.failed + r.unknown);
  expect(r.requested).toBe(r.results.length);
}

const discardedIds = () => fake.tabs.filter((t) => t.discarded).map((t) => t.id as number);

beforeEach(() => {
  clock = NOW;
  fake = createFakeChrome([]);
  fake.windows.push({ id: 10, focused: true }, { id: 11, focused: false });
  fake.groups.push({ id: 1, windowId: 10, title: 'g1', color: 'blue', collapsed: false } as never);
  storage = createFakeStorage();
  repos = createRepos(storage);
  origins = async () => [];
  planted = {};
  mount();
});

describe('executor: revalidation races', () => {
  beforeEach(() => seed(baseTabs()));

  it('skips a tab the owner activated after the preview (A10)', async () => {
    const p = await executor.preview({ kind: 'all' }, 'manual-bulk', NOW);
    const first = p.eligibleTabIds[0]!;
    fake.setActive(first);
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.results.find((x) => x.tabId === first)).toEqual({ tabId: first, outcome: 'skipped', reason: 'SELECTED' });
    expect(discardedIds()).not.toContain(first);
    expectCountersSum(r);
  });

  it('skips a tab that started playing audio after the preview', async () => {
    await executor.preview({ kind: 'all' }, 'manual-bulk', NOW);
    fake.tabs.find((t) => t.id === 2)!.audible = true;
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.results.find((x) => x.tabId === 2)).toEqual({ tabId: 2, outcome: 'skipped', reason: 'AUDIBLE' });
    expect(fake.calls.discard).toBe(1); // tab 3 only
  });

  it('reports a tab closed mid-batch as gone and targets no other tab (A11)', async () => {
    fake.onBeforeDiscard = (id) => { if (id === 2) fake.removeTab(2); };
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.results.find((x) => x.tabId === 2)!.reason).toBe('TAB_GONE');
    expect(r.results.map((x) => x.tabId)).not.toContain(undefined);
    // The only tab unloaded is the other eligible one; nothing took tab 2's place.
    expect(discardedIds()).toHaveLength(1);
    expect(r.confirmed).toBe(1);
    expectCountersSum(r);
  });

  it('honours a protection added between preview and execution (A06)', async () => {
    const p = await executor.preview({ kind: 'all' }, 'manual-bulk', NOW);
    const first = p.eligibleTabIds[0]!;
    await tracker.setTabProtection(first, true);
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.results.find((x) => x.tabId === first)!.reason).toBe('TAB_PROTECTED');
    expect(discardedIds()).not.toContain(first);
  });

  it('respects Keep loaded in a bulk action over an explicit row selection (F2)', async () => {
    await tracker.setTabProtection(2, true);
    const r = await executor.execute({ kind: 'tabs', tabIds: [2, 3] }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.results.find((x) => x.tabId === 2)).toEqual({ tabId: 2, outcome: 'skipped', reason: 'TAB_PROTECTED' });
    expect(r.confirmed).toBe(1);
  });

  it('stops a tab being discarded when settings cannot be re-read mid-batch', async () => {
    fake.onAfterDiscard = (_id, n) => {
      if (n === 1) storage.local.rejectOn.set(`get:${KEYS.settings}`, new Error('storage unavailable'));
    };
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.confirmed).toBe(1);
    expect(fake.calls.discard).toBe(1);
    const after = r.results.filter((x) => x.cause === 'settings-unreadable');
    expect(after.map((x) => x.tabId)).toEqual([3, 4, 5]);
    expect(after.every((x) => x.outcome === 'skipped' && x.reason !== undefined)).toBe(true);
    expectCountersSum(r);
  });

  it('refuses a bulk action it cannot check the dashboard exclusion for (A14)', async () => {
    origins = async () => { throw new Error('session read failed'); };
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r).toMatchObject({ requested: 0, confirmed: 0, blocked: 'dashboard-origins-unreadable' });
    expect(r.results).toEqual([]);
    expect(fake.calls.discard).toBe(0);
    expect(await repos.history.read()).toEqual([]);
  });

  it('still unloads one named tab when the dashboard exclusion cannot be read (A14)', async () => {
    origins = async () => { throw new Error('session read failed'); };
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r).toMatchObject({ requested: 1, confirmed: 1, blocked: null });
  });

  it('refuses a bulk action when the tab list could not be read at all', async () => {
    fake.rejectOn.set('tabs.query', new Error('no tabs for you'));
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r).toMatchObject({ requested: 0, blocked: 'tabs-unavailable' });
    expect(fake.calls.discard).toBe(0);
  });
});

describe('executor: bounded work (A16)', () => {
  beforeEach(async () => {
    await repos.settings.write({ ...DEFAULT_SETTINGS, automationEnabled: true });
  });

  it('caps an automatic run at ten tabs, oldest first', async () => {
    await seedBacklog(40);
    const r = await executor.execute({ kind: 'all' }, 'auto', 'automatic', NOW);
    expect(r.requested).toBe(AUTO_BATCH_MAX);
    expect(r.results.map((x) => x.tabId)).toEqual(oldestFirst().slice(0, AUTO_BATCH_MAX));
    expect(r.confirmed).toBe(AUTO_BATCH_MAX);
    expectCountersSum(r);
  });

  it('turns a wake-from-sleep backlog of sixty overdue tabs into ten requests, not sixty', async () => {
    await seedBacklog(60);
    const r = await executor.execute({ kind: 'all' }, 'auto', 'automatic', NOW);
    expect(fake.calls.discard).toBe(10);
    expect(r.requested).toBe(10);
    expect(discardedIds()).toHaveLength(10);
  });

  it('never requests a discard while automation is off', async () => {
    await repos.settings.write({ ...DEFAULT_SETTINGS, automationEnabled: false });
    await seedBacklog(40);
    const r = await executor.execute({ kind: 'all' }, 'auto', 'automatic', NOW);
    expect(r).toMatchObject({ requested: 0, cancelled: true, blocked: 'automation-off' });
    expect(fake.calls.discard).toBe(0);
  });

  it('stops an automatic batch once automation has been switched off (A07)', async () => {
    await seedBacklog(40);
    fake.onAfterDiscard = async (_id, n) => {
      if (n === 1) await repos.settings.write({ ...DEFAULT_SETTINGS, automationEnabled: false });
    };
    const r = await executor.execute({ kind: 'all' }, 'auto', 'automatic', NOW);
    expect(r.cancelled).toBe(true);
    expect(r.confirmed).toBeLessThan(AUTO_BATCH_MAX);
    expect(r.confirmed).toBe(1);
    expect(discardedIds()).toHaveLength(r.confirmed); // already-unloaded tabs stay unloaded
    expectCountersSum(r);
  });

  it('processes a large manual batch in chunks, revalidating between each', async () => {
    await seedBacklog(40);
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.requested).toBe(40);
    expect(r.confirmed).toBe(40);
    expect(40 / MANUAL_CHUNK_SIZE).toBe(4);
    // One capture to plan, then one before each later chunk.
    expect(captures).toHaveLength(4);
    expect(fake.calls.discard).toBe(40);
    expectCountersSum(r);
  });
});

describe('executor: cancellation', () => {
  beforeEach(() => seedBacklog(40));

  it('cancels the remaining chunks of a large manual batch on request', async () => {
    fake.onAfterDiscard = (_id, n) => { if (n === 3) executor.cancel(currentOperationId()); };
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.cancelled).toBe(true);
    expect(r.requested).toBeLessThan(40);
    expect(r.requested).toBe(3);
  });

  it('leaves the later chunks unrequested when cancelled during chunk two', async () => {
    const plan = (await executor.preview({ kind: 'all' }, 'manual-bulk', NOW)).eligibleTabIds;
    const laterChunks = plan.slice(2 * MANUAL_CHUNK_SIZE);
    expect(laterChunks).toHaveLength(20);

    fake.onAfterDiscard = (_id, n) => { if (n === 12) executor.cancel(currentOperationId()); };
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);

    expect(r.cancelled).toBe(true);
    expect(fake.calls.discard).toBe(12);
    expect(r.confirmed).toBe(12);
    // The tabs already unloaded stay unloaded; nothing in chunks three and four was touched.
    expect(discardedIds()).toHaveLength(12);
    for (const id of laterChunks) expect(fake.tabs.find((t) => t.id === id)!.discarded).toBe(false);
    expectCountersSum(r);
  });

  it('ignores a cancel aimed at another operation', async () => {
    fake.onAfterDiscard = (_id, n) => { if (n === 1) executor.cancel('some-other-operation'); };
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.cancelled).toBe(false);
    expect(r.confirmed).toBe(40);
  });
});

describe('executor: sequencing', () => {
  it('issues discards sequentially, never in parallel', async () => {
    await seedBacklog(20);
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.confirmed).toBe(20);
    expect(fake.maxConcurrentDiscards).toBe(1);
  });

  it('does not interleave the requests of two overlapping executions', async () => {
    await seedBacklog(20);
    const [a, b] = await Promise.all([
      executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW),
      executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW),
    ]);
    expect(fake.maxConcurrentDiscards).toBe(1);
    expect(fake.calls.discard).toBe(20);
    // The second run sees the work of the first rather than repeating it.
    expect(a.confirmed + b.confirmed).toBe(20);
    expect(a.alreadyUnloaded + b.alreadyUnloaded).toBe(20);
    expect(a.operationId).not.toBe(b.operationId);
  });
});
