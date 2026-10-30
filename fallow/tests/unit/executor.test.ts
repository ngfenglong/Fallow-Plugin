import { createChromeAdapter } from '../../src/platform/chrome-adapter';
import { createRepos, KEYS, type HistoryEntry } from '../../src/platform/storage';
import { createTracker, type Tracker } from '../../src/background/tracker';
import { createInventory, type Inventory } from '../../src/background/inventory';
import {
  blockedNote,
  createExecutor,
  type BatchReport,
  type Executor,
  type InFlightBatch,
  type Scope,
} from '../../src/background/executor';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { DISCARD_CONFIRM_TIMEOUT_MS } from '../../src/domain/constants';
import type { Trigger, UnloadOutcome } from '../../src/domain/types';
import { reasonLabel, type ReasonCode } from '../../src/domain/reason-codes';
import { createFakeChrome, type FakeChrome, type FakeTab } from '../fake-chrome';
import { createFakeStorage, type FakeStorage } from '../fake-storage';

const T0 = 1_000;
const NOW = T0 + 60 * 60_000; // an hour after discovery: old enough for every timing check

function tab(p: FakeTab & { id: number }): FakeTab {
  return {
    index: p.id, windowId: 10, groupId: -1, url: 'https://a.test/', title: `t${p.id}`,
    active: false, audible: false, pinned: false, discarded: false, autoDiscardable: true,
    status: 'complete', ...p,
  };
}

// Tab 1 is selected, 4 is audible, 5 is on the shipped keep-loaded list; 2 and 3 are
// the only two tabs that any mode would unload.
function baseTabs(): FakeTab[] {
  return [
    tab({ id: 1, windowId: 10, index: 0, active: true }),
    tab({ id: 2, windowId: 10, index: 1, groupId: 1 }),
    tab({ id: 3, windowId: 11, index: 0 }),
    tab({ id: 4, windowId: 11, index: 1, audible: true }),
    tab({ id: 5, windowId: 11, index: 2, url: 'https://chatgpt.com/' }),
  ];
}

let fake: FakeChrome;
let storage: FakeStorage;
let repos: ReturnType<typeof createRepos>;
let tracker: Tracker;
let inventory: Inventory;
let executor: Executor;
let origins: () => Promise<readonly number[]>;
let captures: number[];
let clock: number;
let onSleep: ((ms: number) => void) | null;

const now = () => clock;
const sleep = (ms: number): Promise<void> => {
  clock += ms;
  onSleep?.(ms);
  return Promise.resolve();
};
const elapsed = () => clock - NOW;

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
    session: repos.session, storage: storage.session,
    dashboardOrigins: () => origins(), now, sleep,
  });
}

// Discovers the tabs long before NOW so no timing check masks the behaviour under test.
async function seed(tabs: FakeTab[]) {
  fake.setTabs(tabs);
  await inventory.capture(T0);
  captures = [];
}

function inFlight(p: {
  operationId: string; trigger?: Trigger;
  pending?: number[];
  done?: Array<{ tabId: number; outcome: UnloadOutcome; reason?: ReasonCode; historyWritten?: boolean }>;
}): InFlightBatch {
  return {
    operationId: p.operationId, trigger: p.trigger ?? 'manual-bulk', mode: 'manual-bulk',
    startedAt: T0, pending: p.pending ?? [], done: p.done ?? [],
  };
}

// Every result is in exactly one bucket, and `requested` is the total.
function expectCountersSum(r: BatchReport) {
  expect(r.requested).toBe(r.confirmed + r.alreadyUnloaded + r.skipped + r.failed + r.unknown);
  expect(r.requested).toBe(r.results.length);
}

beforeEach(() => {
  clock = NOW;
  onSleep = null;
  fake = createFakeChrome([]);
  fake.windows.push({ id: 10, focused: true }, { id: 11, focused: false });
  fake.groups.push({ id: 1, windowId: 10, title: 'g1', color: 'blue', collapsed: false } as never);
  storage = createFakeStorage();
  repos = createRepos(storage);
  origins = async () => [];
  mount();
});

describe('executor: preview', () => {
  beforeEach(() => seed(baseTabs()));

  it('reports eligible and skipped counts with reasons', async () => {
    const p = await executor.preview({ kind: 'all' }, 'manual-bulk', NOW);
    expect(p.eligibleTabIds).toEqual([2, 3]);
    expect(p.skippedCountsByReason).toEqual({ SELECTED: 1, AUDIBLE: 1, SITE_PROTECTED: 1 });
    expect(p.skipped.find((s) => s.tabId === 1)!.reasons).toContain('SELECTED');
  });

  it('does not load any page while previewing', async () => {
    await executor.preview({ kind: 'all' }, 'manual-bulk', NOW);
    expect(fake.calls.focusTab).toBe(0);
    expect(fake.calls.update).toBe(0);
    expect(fake.calls.discard).toBe(0);
  });

  it.each([
    [{ kind: 'window', windowId: 10 }, [2]],
    [{ kind: 'group', groupId: 1 }, [2]],
    [{ kind: 'tabs', tabIds: [2, 3] }, [2, 3]],
    [{ kind: 'tab', tabId: 3 }, [3]],
    [{ kind: 'all' }, [2, 3]],
  ])('restricts scope %p to %p', async (scope, expected) => {
    const p = await executor.preview(scope as Scope, 'manual-bulk', NOW);
    expect(p.eligibleTabIds).toEqual(expected);
  });

  it('names a tab that no longer exists rather than dropping it from the preview', async () => {
    const p = await executor.preview({ kind: 'tabs', tabIds: [2, 404] }, 'manual-bulk', NOW);
    expect(p.eligibleTabIds).toEqual([2]);
    expect(p.skipped).toEqual([{ tabId: 404, reasons: ['TAB_GONE'] }]);
  });

  it('does not claim a named tab is gone when the tab scan itself failed', async () => {
    // The named-scope exemption is justified by "a named tab is re-read directly", which is
    // true of execute and false of preview: preview only looks ids up in the snapshot's rows.
    // An empty row list is a failed scan, never evidence that these tabs stopped existing.
    fake.rejectOn.set('tabs.query', new Error('no tabs for you'));
    const p = await executor.preview({ kind: 'tabs', tabIds: [2, 3] }, 'manual-bulk', NOW);
    expect(p.skipped).toEqual([
      { tabId: 2, reasons: ['VERIFY_FAILED'] },
      { tabId: 3, reasons: ['VERIFY_FAILED'] },
    ]);
    expect(p.skippedCountsByReason).toEqual({ VERIFY_FAILED: 2 });
    expect(p.eligibleTabIds).toEqual([]);
    // Not blocked: execute re-reads a named tab directly, so the action the dashboard would
    // offer for one named tab is still fully verifiable.
    expect(p.blocked).toBeNull();
  });

  it('derives manual-single eligibility by dropping only the bulk-only reasons', async () => {
    // A tab first seen now is held by the bulk floor, and the dashboard origin is a
    // bulk-only exclusion; neither applies when the owner names one tab.
    fake.tabs.push(tab({ id: 6, windowId: 11, index: 3 }));
    origins = async () => [3];

    const bulk = await executor.preview({ kind: 'all' }, 'manual-bulk', NOW);
    expect(bulk.eligibleTabIds).toEqual([2]);
    expect(bulk.skipped.find((s) => s.tabId === 3)!.reasons).toEqual(['DASHBOARD_ORIGIN']);
    expect(bulk.skipped.find((s) => s.tabId === 6)!.reasons).toEqual(['USED_RECENTLY']);

    const single = await executor.preview({ kind: 'all' }, 'manual-single', NOW);
    expect(single.eligibleTabIds).toEqual([2, 3, 6]);
    expect(single.skippedCountsByReason).toEqual({ SELECTED: 1, AUDIBLE: 1, SITE_PROTECTED: 1 });
  });

  it('refuses to preview a bulk action when the dashboard origins could not be read', async () => {
    origins = async () => { throw new Error('session read failed'); };
    const p = await executor.preview({ kind: 'all' }, 'manual-bulk', NOW);
    expect(p.blocked).toBe('dashboard-origins-unreadable');
    expect(p.eligibleTabIds).toEqual([]);
  });
});

describe('executor: confirmation contract (milestone 0)', () => {
  beforeEach(() => seed(baseTabs()));

  it('confirms through the new tab id and reports the requested one', async () => {
    fake.discardBehaviour = 'confirm';
    fake.nextDiscardId = 99;
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r).toMatchObject({ confirmed: 1, failed: 0, unknown: 0 });
    expect(r.results[0]).toMatchObject({ tabId: 2, newTabId: 99, outcome: 'confirmed' });
    expect((await repos.history.read())[0]!.sessionTabId).toBe(2);
    expectCountersSum(r);
  });

  it('does not mistake chrome new tab id for a vanished tab', async () => {
    fake.discardBehaviour = 'confirm';
    fake.nextDiscardId = 99;
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r.results[0]!.reason).not.toBe('TAB_GONE');
    expect(r.results[0]!.outcome).toBe('confirmed');
  });

  it('counts a discard confirmed only after observing the discarded state', async () => {
    fake.discardBehaviour = 'confirm';
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r).toMatchObject({ requested: 1, confirmed: 1, failed: 0, unknown: 0 });
  });

  it('re-reads only the new id while waiting, and confirms when it shows unloaded', async () => {
    fake.discardBehaviour = 'confirm';
    fake.nextDiscardId = 99;
    let readsAtDiscard = 0;
    fake.onAfterDiscard = () => {
      // The replacement exists but has not settled into the unloaded state yet.
      const t = fake.tabs.find((x) => x.id === 99)!;
      t.discarded = false;
      t.status = 'complete';
      readsAtDiscard = fake.getCalls.length;
    };
    let sleeps = 0;
    onSleep = () => {
      if (++sleeps === 2) {
        const t = fake.tabs.find((x) => x.id === 99)!;
        t.discarded = true;
        t.status = 'unloaded';
      }
    };

    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r).toMatchObject({ confirmed: 1, unknown: 0 });
    expect(r.results[0]).toMatchObject({ tabId: 2, newTabId: 99, outcome: 'confirmed' });
    // The requested id is dead the moment the discard resolves: never read again.
    expect(fake.getCalls.slice(readsAtDiscard)).not.toContain(2);
    expect(fake.getCalls.slice(readsAtDiscard)).toContain(99);
    expect(elapsed()).toBe(150); // 50ms then 100ms
    expect(fake.calls.discard).toBe(1);
  });

  it('does not count a discard confirmed from the object chrome resolved with', async () => {
    // milestone 0 measured tabs.discard always resolving with discarded:true. Trusting that
    // object is confirming by invocation, which plan §7 forbids: only a read counts.
    fake.nextDiscardId = 99;
    fake.onBeforeDiscard = () => { fake.rejectOn.set('tabs.get', new Error('No tab with id: 99')); };
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r).toMatchObject({ confirmed: 0, unknown: 1 });
    expect(r.results[0]).toMatchObject({ tabId: 2, outcome: 'unknown', newTabId: 99 });
    expect(fake.calls.discard).toBe(1); // never re-issued
    expectCountersSum(r);
  });

  it('confirms an unobserved discard once a later read observes the tab unloaded', async () => {
    fake.nextDiscardId = 99;
    fake.onBeforeDiscard = () => { fake.rejectOn.set('tabs.get', new Error('No tab with id: 99')); };
    onSleep = () => { fake.rejectOn.delete('tabs.get'); };
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r).toMatchObject({ confirmed: 1, unknown: 0 });
    expect(r.results[0]).toMatchObject({ tabId: 2, outcome: 'confirmed', newTabId: 99 });
    expect(elapsed()).toBe(50); // one backoff step, then the observation
    expect(fake.calls.discard).toBe(1);
  });

  it('records unknown rather than success when the tab stays loaded', async () => {
    fake.discardBehaviour = 'silent-noop';
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r).toMatchObject({ confirmed: 0, unknown: 1 });
    expect(r.results[0]!.outcome).toBe('unknown');
    expect(fake.tabs.find((t) => t.id === 2)!.discarded).toBe(false);
    expectCountersSum(r);
  });

  it('stops re-reading after the confirmation timeout and issues one discard only', async () => {
    // Was driven by 'silent-noop', which now yields no minted id and so correctly enters no
    // loop at all. The behaviour under test — a bounded observation loop and exactly one
    // discard — is driven here by a minted id whose re-reads keep failing.
    fake.nextDiscardId = 99;
    fake.discardedStaysLoaded = true;
    await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(fake.calls.discard).toBe(1);
    expect(elapsed()).toBeLessThanOrEqual(DISCARD_CONFIRM_TIMEOUT_MS);
    expect(elapsed()).toBeGreaterThan(0);
  });

  it('reports unknown without sleeping or reading when chrome mints no id', async () => {
    // No minted id means nothing this code may read: the requested id is forbidden. It must
    // not spend the confirmation window reading the wrong tab to manufacture an answer.
    fake.discardBehaviour = 'silent-noop';
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r.results[0]).toEqual({ tabId: 2, outcome: 'unknown' });
    expect(fake.calls.discard).toBe(1);
    // Exactly one read of tab 2: revalidation's own read BEFORE the discard, which is
    // allowed. Any further read of 2 would be the forbidden post-discard re-read, and the
    // old code made several of them while burning the whole confirmation window.
    expect(fake.getCalls.filter((id) => id === 2)).toHaveLength(1);
    expect(elapsed()).toBe(0);
    expectCountersSum(r);
  });

  it('never closes or navigates a tab when discard is rejected', async () => {
    fake.discardBehaviour = 'reject';
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r.results[0]).toEqual({ tabId: 2, outcome: 'failed', reason: 'API_REJECTED' });
    expect(fake.calls.remove).toBe(0);
    expect(fake.calls.move).toBe(0);
    expect(fake.calls.update).toBe(0);
    expect(fake.calls.create).toBe(0);
    expect(fake.tabs.find((t) => t.id === 2)).toBeDefined();
    expectCountersSum(r);
  });

  it('reports an already-unloaded tab separately from a confirmed unload', async () => {
    await seed([...baseTabs(), tab({ id: 9, windowId: 11, index: 3, discarded: true, status: 'unloaded' })]);
    const r = await executor.execute({ kind: 'tab', tabId: 9 }, 'manual-single', 'manual-single', NOW);
    expect(r).toMatchObject({ alreadyUnloaded: 1, confirmed: 0 });
    expect(r.results[0]).toEqual({ tabId: 9, outcome: 'already-unloaded', reason: 'ALREADY_UNLOADED' });
    expect(fake.calls.discard).toBe(0);
    expectCountersSum(r);
  });

  it('returns a zeroed report for an empty scope without touching a tab', async () => {
    const r = await executor.execute({ kind: 'window', windowId: 999 }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r).toMatchObject({
      requested: 0, confirmed: 0, alreadyUnloaded: 0, skipped: 0, failed: 0, unknown: 0,
      results: [], cancelled: false, blocked: null,
    });
    expect(fake.calls.discard).toBe(0);
    expect(fake.calls.get).toBe(0);
    expect(fake.calls.update).toBe(0);
    expect(storage.session.data.get(KEYS.batch)).toBeUndefined();
    expect(await repos.history.read()).toEqual([]);
  });
});

describe('executor: history', () => {
  beforeEach(() => seed(baseTabs()));

  it('writes one history row per result, with hostname but never a url', async () => {
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    const rows = await repos.history.read();
    expect(rows).toHaveLength(r.results.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/https?:\/\//);
    expect(rows.find((h) => h.sessionTabId === 5)!.hostname).toBe('chatgpt.com');
    expect(rows.every((h) => h.operationId === r.operationId)).toBe(true);
  });

  it('logs the requested tab id, never the id chrome minted', async () => {
    fake.nextDiscardId = 99;
    await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    const rows = await repos.history.read();
    expect(rows.map((h) => h.sessionTabId)).toEqual([2]);
    expect(rows.map((h) => h.sessionTabId)).not.toContain(99);
  });
});

describe('executor: crash reconciliation (A21)', () => {
  beforeEach(() => seed(baseTabs()));

  it('turns a surviving in-flight record into unknown results without replaying it', async () => {
    await storage.session.set(KEYS.batch, inFlight({ operationId: 'op1', trigger: 'manual-bulk', pending: [2, 3, 4] }));
    const reports = await executor.reconcileUnfinished(NOW);
    expect(reports[0]).toMatchObject({ operationId: 'op1', unknown: 3, confirmed: 0 });
    expect(reports[0]!.results.map((x) => x.outcome)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(fake.calls.discard).toBe(0);
    expectCountersSum(reports[0]!);
  });

  it('does not double-count a result already recorded before the crash', async () => {
    await storage.session.set(KEYS.batch, inFlight({
      operationId: 'op1', pending: [3], done: [{ tabId: 2, outcome: 'confirmed' }],
    }));
    const reports = await executor.reconcileUnfinished(NOW);
    expect(reports[0]).toMatchObject({ confirmed: 1, unknown: 1 });
    expect((await repos.history.read()).filter((h) => h.sessionTabId === 2)).toHaveLength(1);
    expectCountersSum(reports[0]!);
  });

  it('does not write a second history row for a result already logged', async () => {
    await storage.session.set(KEYS.batch, inFlight({
      operationId: 'op1', pending: [], done: [{ tabId: 2, outcome: 'confirmed', historyWritten: true }],
    }));
    const reports = await executor.reconcileUnfinished(NOW);
    expect(reports[0]).toMatchObject({ confirmed: 1, unknown: 0 });
    expect(await repos.history.read()).toEqual([]);
  });

  it('clears the in-flight record once reconciled', async () => {
    await storage.session.set(KEYS.batch, inFlight({ operationId: 'op1', pending: [2] }));
    await executor.reconcileUnfinished(NOW);
    expect(await storage.session.get(KEYS.batch)).toBeUndefined();
  });

  it('REMOVES the in-flight key rather than storing undefined under it', async () => {
    // `get` returning undefined cannot tell "absent" from "present and set to undefined",
    // so the assertion above passes either way — and chrome.storage has no documented
    // behaviour for setting a key to undefined. The key must actually be gone, because
    // chrome.storage.session has a small quota and session records are its main consumer.
    await storage.session.set(KEYS.batch, inFlight({ operationId: 'op1', pending: [2] }));
    await executor.reconcileUnfinished(NOW);
    expect(storage.session.data.has(KEYS.batch)).toBe(false);
  });

  it('REMOVES the in-flight key when a batch finishes normally', async () => {
    await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(storage.session.data.has(KEYS.batch)).toBe(false);
  });

  it('returns no reports and writes nothing when there is no in-flight record', async () => {
    const writesBefore = storage.session.writes;
    const reports = await executor.reconcileUnfinished(NOW);
    expect(reports).toEqual([]);
    expect(storage.session.writes).toBe(writesBefore);
    expect(await repos.history.read()).toEqual([]);
  });

  it('reports an unreadable in-flight record instead of reading it as nothing to do', async () => {
    storage.session.rejectOn.set(`get:${KEYS.batch}`, new Error('session unavailable'));
    const reports = await executor.reconcileUnfinished(NOW);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ blocked: 'crash-record-unreadable', requested: 0, crashSafe: false });
  });

  it('reports a corrupt in-flight record instead of reading it as nothing to do', async () => {
    await storage.session.set(KEYS.batch, { operationId: 42, pending: 'nonsense' });
    const reports = await executor.reconcileUnfinished(NOW);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.blocked).toBe('crash-record-unreadable');
    expect(await storage.session.get(KEYS.batch)).toBeUndefined();
  });

  it('keeps an unfinished record out of a completed batch report', async () => {
    await storage.session.set(KEYS.batch, {
      ...inFlight({ operationId: 'op1', done: [{ tabId: 2, outcome: 'confirmed' }] }),
      completed: true,
    });
    const reports = await executor.reconcileUnfinished(NOW);
    expect(reports).toEqual([]);
    expect(await storage.session.get(KEYS.batch)).toBeUndefined();
  });

  it('reports a crashed batch rather than overwriting its record with a new operation', async () => {
    // KEYS.batch holds exactly one record. An alarm-driven execute that wins the queue race
    // after a restart must not turn the crashed batch into "nothing happened".
    await storage.session.set(KEYS.batch, inFlight({
      operationId: 'op1', pending: [4, 5], done: [{ tabId: 2, outcome: 'confirmed' }],
    }));
    const r = await executor.execute({ kind: 'tab', tabId: 3 }, 'manual-single', 'manual-single', NOW);
    expect(r).toMatchObject({ confirmed: 1, requested: 1 });

    const crashed = (await repos.history.read()).filter((h) => h.operationId === 'op1');
    expect(crashed.map((h) => [h.sessionTabId, h.outcome])).toEqual([
      [2, 'confirmed'], [4, 'unknown'], [5, 'unknown'],
    ]);
    // And this operation's own row is still there, under its own id.
    expect((await repos.history.read()).filter((h) => h.operationId === r.operationId))
      .toMatchObject([{ sessionTabId: 3, outcome: 'confirmed' }]);
    expect(fake.calls.discard).toBe(1); // the crashed batch is reported, never replayed
  });

  it('writes the in-flight record before the first request and clears it after', async () => {
    const seen: Array<InFlightBatch | undefined> = [];
    fake.onBeforeDiscard = () => {
      seen.push(storage.session.data.get(KEYS.batch) as InFlightBatch | undefined);
    };
    const r = await executor.execute({ kind: 'tabs', tabIds: [2, 3] }, 'manual-bulk', 'manual-bulk', NOW);
    expect(seen[0]).toMatchObject({ operationId: r.operationId, trigger: 'manual-bulk', pending: [2, 3] });
    expect(seen[1]).toMatchObject({ pending: [3], done: [{ tabId: 2, outcome: 'confirmed' }] });
    expect(await storage.session.get(KEYS.batch)).toBeUndefined();
    expect(r.crashSafe).toBe(true);
  });

  it('still acts, and says so, when the crash record cannot be written', async () => {
    storage.session.rejectOn.set(`set:${KEYS.batch}`, new Error('quota'));
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r.confirmed).toBe(1);
    expect(r.crashSafe).toBe(false);
  });
});

describe('executor: history rows are never a full url', () => {
  it('keeps a hostname-less tab as null rather than inventing one', async () => {
    await seed([
      tab({ id: 1, windowId: 10, index: 0, active: true }),
      tab({ id: 7, windowId: 10, index: 1, url: 'chrome://settings/' }),
    ]);
    const r = await executor.execute({ kind: 'tab', tabId: 7 }, 'manual-single', 'manual-single', NOW);
    expect(r.results[0]).toEqual({ tabId: 7, outcome: 'skipped', reason: 'UNSUPPORTED_URL' });
    const rows: HistoryEntry[] = await repos.history.read();
    expect(rows[0]!.hostname).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/settings/);
  });
});

describe('executor: blocked reports carry copy the dashboard can show', () => {
  const REASONS = [
    'tabs-unavailable', 'dashboard-origins-unreadable', 'startup-grace-unreadable',
    'activity-unreadable', 'automation-off', 'crash-record-unreadable', 'internal-error',
  ] as const;

  it.each(REASONS)('%s has a sentence, and it obeys the copy rules', (reason) => {
    const note = blockedNote(reason);
    expect(note.length).toBeGreaterThan(10);
    expect(note).toMatch(/\.$/);
    expect(note).not.toMatch(/chrome/i);
    expect(note).not.toMatch(/suspend/i);
  });

  it('gives a blocked report a reason the owner can be shown, not just a zeroed count', async () => {
    await seed(baseTabs());
    origins = async () => { throw new Error('session read failed'); };
    const r = await executor.execute({ kind: 'all' }, 'manual-bulk', 'manual-bulk', NOW);
    expect(r.blocked).not.toBeNull();
    expect(blockedNote(r.blocked!)).toContain('nothing was unloaded');
  });
});

describe('executor: settings defaults are never mistaken for the owner settings', () => {
  it('skips rather than acts when settings cannot be read at revalidation', async () => {
    await seed(baseTabs());
    storage.local.rejectOn.set(`get:${KEYS.settings}`, new Error('storage unavailable'));
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    // The owner is told Fallow could not check, not something untrue about the tab.
    expect(r.results[0]).toEqual({
      tabId: 2, outcome: 'skipped', reason: 'VERIFY_FAILED', cause: 'settings-unreadable',
    });
    expect(reasonLabel('VERIFY_FAILED')).toBe('Could not check this tab just now');
    expect(fake.calls.discard).toBe(0);
    // And the code survives a round trip through history, which drops any reason it
    // does not recognise: a dropped reason would make the row read as "no reason given".
    expect((await repos.history.read())[0]).toMatchObject({ sessionTabId: 2, reason: 'VERIFY_FAILED' });
    expectCountersSum(r);
  });

  it('does not claim the browser refused a request it never made when the tab cannot be re-read', async () => {
    await seed(baseTabs());
    fake.rejectOn.set('tabs.get', new Error('kaboom'));
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    // No discard was issued, so this is not API_REJECTED: nothing was rejected.
    expect(r.results[0]).toEqual({
      tabId: 2, outcome: 'skipped', reason: 'VERIFY_FAILED', cause: 'tab-unreadable',
    });
    expect(r).toMatchObject({ skipped: 1, failed: 0 });
    expect(fake.calls.discard).toBe(0);
    expect(fake.tabs.find((t) => t.id === 2)!.discarded).toBe(false);
    expectCountersSum(r);
  });

  it('skips rather than acts when the activity record cannot be read at revalidation', async () => {
    await seed(baseTabs());
    storage.session.rejectOn.set(`get:${KEYS.activity}`, new Error('storage unavailable'));
    const r = await executor.execute({ kind: 'tab', tabId: 2 }, 'manual-single', 'manual-single', NOW);
    expect(r.results[0]).toEqual({
      tabId: 2, outcome: 'skipped', reason: 'VERIFY_FAILED', cause: 'activity-unreadable',
    });
    expect(fake.calls.discard).toBe(0);
  });
});
