import { createChromeAdapter } from '../../src/platform/chrome-adapter';
import { createRepos } from '../../src/platform/storage';
import { createTracker } from '../../src/background/tracker';
import { createInventory, type Inventory } from '../../src/background/inventory';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { createFakeChrome, type FakeChrome, type FakeTab } from '../fake-chrome';
import { createFakeStorage, type FakeStorage } from '../fake-storage';

const T0 = 1_000;
const NOW = T0 + 60 * 60_000; // an hour after discovery: old enough for everything

function tab(p: FakeTab & { id: number }): FakeTab {
  return { index: p.id, windowId: 10, groupId: -1, url: 'https://a.test/', title: `t${p.id}`, active: false,
    audible: false, pinned: false, discarded: false, autoDiscardable: true, status: 'complete', ...p };
}

let fake: FakeChrome;
let storage: FakeStorage;
let repos: ReturnType<typeof createRepos>;
let inventory: Inventory;
let origins: () => Promise<readonly number[]>;

function mount() {
  const adapter = createChromeAdapter(fake.api);
  const tracker = createTracker({ adapter, activity: repos.activity });
  inventory = createInventory({ adapter, tracker, session: repos.session, settings: repos.settings, dashboardOrigins: origins });
}
// Discover the tabs long before NOW so timing never masks the behaviour under test.
async function seed(tabs: FakeTab[]) {
  fake.tabs.splice(0, fake.tabs.length, ...tabs);
  await inventory.capture(T0);
}
const group = (id: number, windowId = 10, collapsed = false) =>
  ({ id, windowId, title: `g${id}`, color: 'blue', collapsed }) as const;

beforeEach(() => {
  fake = createFakeChrome([]);
  fake.windows.push({ id: 10, focused: true });
  storage = createFakeStorage();
  repos = createRepos(storage);
  origins = async () => [];
  mount();
});

describe('inventory: counts (A18)', () => {
  it('reconciles total as loaded plus unloaded, counting loading as loaded', async () => {
    await seed([tab({ id: 1 }), tab({ id: 2, status: 'loading' }), tab({ id: 3, discarded: true, status: 'unloaded' })]);
    const s = await inventory.capture(NOW);
    expect(s.counts!.total).toBe(3);
    expect(s.counts!.loaded).toBe(2);
    expect(s.counts!.unloaded).toBe(1);
    expect(s.counts!.total).toBe(s.counts!.loaded + s.counts!.unloaded);
    expect(s.rows.find((r) => r.tabId === 2)!.lifecycle).toBe('loading');
  });
  it('counts protected and eligible as overlapping classifications, not buckets', async () => {
    await seed([tab({ id: 1, active: true }), tab({ id: 2 }), tab({ id: 3, pinned: true })]);
    const s = await inventory.capture(NOW);
    expect(s.counts!.protected).toBe(2);
    expect(s.counts!.eligible).toBe(1);
    expect(s.counts!.loaded).toBe(3);
    expect(s.rows.filter((r) => r.manualBulkDecision.eligible).map((r) => r.tabId)).toEqual([2]);
  });
  it('lets protected overlap total without double counting loaded', async () => {
    await seed([tab({ id: 1, active: true }), tab({ id: 2, audible: true, active: false })]);
    const s = await inventory.capture(NOW);
    expect(s.counts!.protected).toBe(2);
    expect(s.counts!.loaded).toBe(2);
    expect(s.counts!.eligible).toBeLessThanOrEqual(s.counts!.total);
  });
  it('sizes the eligible count by what the bulk button would actually unload', async () => {
    // Fresh discovery: bulk is blocked by the one-minute floor, auto by the threshold; use a
    // threshold long enough that auto says no while bulk says yes.
    await seed([tab({ id: 1 }), tab({ id: 2 })]);
    const s = await inventory.capture(T0 + 5 * 60_000);
    expect(s.rows.every((r) => !r.decision.eligible)).toBe(true);
    expect(s.rows.every((r) => r.manualBulkDecision.eligible)).toBe(true);
    expect(s.counts!.eligible).toBe(2);
    expect(s.counts!.eligible).toBe(s.rows.filter((r) => r.manualBulkDecision.eligible).length);
  });
  it('carries both decisions, in their own modes', async () => {
    await seed([tab({ id: 1 })]);
    const s = await inventory.capture(T0 + 5 * 60_000);
    expect(s.rows[0]!.decision.reasons).toContain('NOT_OLD_ENOUGH');
    expect(s.rows[0]!.manualBulkDecision.reasons).not.toContain('NOT_OLD_ENOUGH');
  });
  it('does not count timing reasons as protection', async () => {
    await seed([tab({ id: 1 })]);
    const s = await inventory.capture(T0 + 10); // USED_RECENTLY under bulk
    expect(s.rows[0]!.manualBulkDecision.reasons).toContain('USED_RECENTLY');
    expect(s.counts!.protected).toBe(0);
    expect(s.counts!.eligible).toBe(0);
  });
  it('counts a dashboard-origin tab as protected and not eligible', async () => {
    origins = async () => [1];
    mount();
    await seed([tab({ id: 1 }), tab({ id: 2 })]);
    const s = await inventory.capture(NOW);
    expect(s.counts!.protected).toBe(1);
    expect(s.counts!.eligible).toBe(1);
  });
  it('reports background time for the row', async () => {
    await seed([tab({ id: 1 })]);
    expect((await inventory.capture(NOW)).rows[0]!.backgroundMs).toBe(NOW - T0);
  });
});

describe('inventory: unsupported and odd URLs', () => {
  it('keeps an unsupported page in the inventory but never eligible (A19)', async () => {
    await seed([tab({ id: 1, url: 'chrome://settings' })]);
    const s = await inventory.capture(NOW);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]!.hostname).toBe(null);
    expect(s.rows[0]!.manualBulkDecision.reasons).toContain('UNSUPPORTED_URL');
    expect(s.counts!.eligible).toBe(0);
    expect(s.counts!.total).toBe(1);
  });
  it('carries the url scheme so a null hostname can still be displayed', async () => {
    await seed([tab({ id: 1, url: 'chrome://settings' }), tab({ id: 2, url: 'file:///tmp/x' }),
      tab({ id: 3, url: '' }), tab({ id: 4, url: 'https://ok.test/' })]);
    const s = await inventory.capture(NOW);
    expect(s.rows.map((r) => r.scheme)).toEqual(['chrome', 'file', null, 'https']);
  });
  it('renders the rest of the inventory when one tab url will not parse', async () => {
    await seed([tab({ id: 1, url: '' }), tab({ id: 2, url: 'https://ok.test/' })]);
    const s = await inventory.capture(NOW);
    expect(s.rows).toHaveLength(2);
    expect(s.rows.find((r) => r.tabId === 2)!.manualBulkDecision.eligible).toBe(true);
    expect(s.rows.find((r) => r.tabId === 1)!.manualBulkDecision.eligible).toBe(false);
  });
});

describe('inventory: structure and order (A01)', () => {
  it('preserves window, group and tab order without rearranging anything', async () => {
    fake.windows.splice(0, fake.windows.length, { id: 30 }, { id: 10, focused: true }, { id: 20 });
    fake.groups.push(group(7, 10), group(5, 10));
    await seed([
      tab({ id: 3, index: 0, windowId: 10, groupId: 7 }), tab({ id: 1, index: 1, windowId: 10, groupId: 7 }), tab({ id: 2, index: 2, windowId: 10, groupId: 7 }),
      tab({ id: 4, index: 3, windowId: 10 }), tab({ id: 5, index: 4, windowId: 10, groupId: 5 }),
      tab({ id: 6, index: 0, windowId: 20 }), tab({ id: 7, index: 0, windowId: 30 }),
    ]);
    const s = await inventory.capture(NOW);
    expect(s.windows.map((w) => w.label)).toEqual(['Window 1', 'Window 2', 'Window 3']);
    expect(s.windows.map((w) => w.windowId)).toEqual([10, 20, 30]);
    expect(s.windows[0]!.groups.map((g) => g.groupId)).toEqual([7, 5]);
    expect(s.windows[0]!.groups[0]!.tabIds).toEqual([3, 1, 2]);
    expect(s.windows[0]!.ungroupedTabIds).toEqual([4]);
    expect(s.windows[0]!.focused).toBe(true);
    expect(s.rows.map((r) => r.tabId)).toEqual([3, 1, 2, 4, 5, 6, 7]);
  });
  it('reports a collapsed group as collapsed without implying its tabs are unloaded (A15)', async () => {
    fake.groups.push(group(1, 10, true));
    await seed([tab({ id: 1, groupId: 1 }), tab({ id: 2, groupId: 1 })]);
    const s = await inventory.capture(NOW);
    expect(s.windows[0]!.groups[0]!.collapsed).toBe(true);
    expect(s.windows[0]!.groups[0]!.title).toBe('g1');
    expect(s.windows[0]!.groups[0]!.color).toBe('blue');
    expect(s.rows.every((r) => r.lifecycle === 'loaded')).toBe(true);
    expect(s.counts!.unloaded).toBe(0);
  });
  it('puts groupId -1 tabs in ungroupedTabIds, never a phantom group', async () => {
    await seed([tab({ id: 1, groupId: -1 })]);
    const s = await inventory.capture(NOW);
    expect(s.windows[0]!.groups).toEqual([]);
    expect(s.windows[0]!.ungroupedTabIds).toEqual([1]);
  });
  it('keeps tabs whose group is missing from the groups list', async () => {
    await seed([tab({ id: 1, groupId: 99 }), tab({ id: 2, groupId: 99 })]);
    const s = await inventory.capture(NOW);
    expect(s.windows[0]!.groups).toHaveLength(1);
    expect(s.windows[0]!.groups[0]!.groupId).toBe(99);
    expect(s.windows[0]!.groups[0]!.tabIds).toEqual([1, 2]);
    expect(s.counts!.total).toBe(2);
  });
  it('still shows a window that holds only unsupported tabs, with its label', async () => {
    fake.windows.push({ id: 20 });
    await seed([tab({ id: 1 }), tab({ id: 2, windowId: 20, url: 'chrome://extensions' })]);
    const s = await inventory.capture(NOW);
    expect(s.windows.map((w) => w.label)).toEqual(['Window 1', 'Window 2']);
    expect(s.windows[1]!.ungroupedTabIds).toEqual([2]);
  });
  it('gives the same window the same label across captures', async () => {
    fake.windows.splice(0, fake.windows.length, { id: 20 }, { id: 10 });
    await seed([tab({ id: 1, windowId: 10 }), tab({ id: 2, windowId: 20 })]);
    const a = await inventory.capture(NOW);
    const b = await inventory.capture(NOW + 1);
    expect(a.windows.map((w) => [w.windowId, w.label])).toEqual([[10, 'Window 1'], [20, 'Window 2']]);
    expect(b.windows.map((w) => [w.windowId, w.label])).toEqual([[10, 'Window 1'], [20, 'Window 2']]);
  });
});

describe('inventory: explicit ordering', () => {
  it('orders by (windowId, index) even when the browser returns tabs scrambled', async () => {
    fake.windows.splice(0, fake.windows.length, { id: 20 }, { id: 10 });
    fake.groups.push(group(1, 10));
    await seed([
      tab({ id: 50, index: 2, windowId: 10, groupId: 1 }), tab({ id: 60, index: 0, windowId: 20 }),
      tab({ id: 30, index: 0, windowId: 10, groupId: 1 }), tab({ id: 70, index: 3, windowId: 10 }),
      tab({ id: 40, index: 1, windowId: 10 }), tab({ id: 61, index: 1, windowId: 20 }),
      tab({ id: 20, index: 4, windowId: 10, groupId: 1 }),
    ]);
    const s = await inventory.capture(NOW);
    expect(s.rows.map((r) => r.tabId)).toEqual([30, 40, 50, 70, 20, 60, 61]);
    expect(s.windows[0]!.groups[0]!.tabIds).toEqual([30, 50, 20]);
    expect(s.windows[0]!.ungroupedTabIds).toEqual([40, 70]);
    expect(s.windows[1]!.ungroupedTabIds).toEqual([60, 61]);
  });
});

describe('inventory: notes, settings and grace', () => {
  it('states the automation note only while automation is off (F3)', async () => {
    expect((await inventory.capture(NOW)).automationNote)
      .toBe('Extension automation is off. Chrome may still unload tabs independently.');
    await repos.settings.write({ ...DEFAULT_SETTINGS, automationEnabled: true });
    expect((await inventory.capture(NOW)).automationNote).toBe(null);
  });
  it('carries the session grace deadline and applies it to the auto decision', async () => {
    await repos.session.write({ discoveredAt: T0, graceUntil: NOW + 1000 });
    await seed([tab({ id: 1 })]);
    const s = await inventory.capture(NOW);
    expect(s.graceUntil).toBe(NOW + 1000);
    expect(s.rows[0]!.decision.reasons).toContain('STARTUP_GRACE');
    expect(s.rows[0]!.manualBulkDecision.reasons).not.toContain('STARTUP_GRACE');
  });
  it('reports a null grace when no session record exists', async () => {
    expect((await inventory.capture(NOW)).graceUntil).toBe(null);
  });
  it('stamps capturedAt', async () => {
    expect((await inventory.capture(NOW)).capturedAt).toBe(NOW);
  });
});

describe('inventory: one scan per capture', () => {
  it('issues exactly one tab, window and group query and one reconcile', async () => {
    await seed([tab({ id: 1 })]);
    fake.counts = {};
    await inventory.capture(NOW);
    expect(fake.counts['tabs.query']).toBe(1);
    expect(fake.counts['windows.getAll']).toBe(1);
    expect(fake.counts['tabGroups.query']).toBe(1);
    expect(fake.getCalls).toEqual([]);
  });
  it('calls the tracker reconcile once per capture', async () => {
    const adapter = createChromeAdapter(fake.api);
    const real = createTracker({ adapter, activity: repos.activity });
    let reconciles = 0;
    const tracker = { ...real, reconcile: (...a: Parameters<typeof real.reconcile>) => { reconciles++; return real.reconcile(...a); } };
    inventory = createInventory({ adapter, tracker, session: repos.session, settings: repos.settings, dashboardOrigins: origins });
    fake.tabs.push(tab({ id: 1 }));
    await inventory.capture(NOW);
    expect(reconciles).toBe(1);
  });
  it('reconciles counts for 200 tabs over 3 windows with one scan', async () => {
    fake.windows.splice(0, fake.windows.length, { id: 10 }, { id: 20 }, { id: 30 });
    const tabs: FakeTab[] = [];
    for (let i = 1; i <= 200; i++) {
      tabs.push(tab({
        id: i, windowId: [10, 20, 30][i % 3]!, active: i % 50 === 0,
        status: i % 7 === 0 ? 'loading' : i % 5 === 0 ? 'unloaded' : 'complete',
        discarded: i % 5 === 0 && i % 7 !== 0, pinned: i % 11 === 0, groupId: i % 4 === 0 ? 3 : -1,
      }));
    }
    fake.groups.push(group(3, 10));
    await seed(tabs);
    fake.counts = {};
    const s = await inventory.capture(NOW);
    expect(s.rows).toHaveLength(200);
    expect(s.counts!.total).toBe(200);
    expect(s.counts!.total).toBe(s.counts!.loaded + s.counts!.unloaded);
    expect(s.counts!.eligible).toBe(s.rows.filter((r) => r.manualBulkDecision.eligible).length);
    expect(s.counts!.protected).toBe(s.rows.filter((r) => r.manualBulkDecision.reasons.some((c) =>
      ['SELECTED', 'AUDIBLE', 'LOADING', 'TAB_PROTECTED', 'SITE_PROTECTED', 'PINNED', 'BROWSER_PROTECTED', 'DASHBOARD_ORIGIN'].includes(c))).length);
    expect(s.windows.reduce((n, w) => n + w.ungroupedTabIds.length + w.groups.reduce((m, g) => m + g.tabIds.length, 0), 0)).toBe(200);
    expect([fake.counts['tabs.query'], fake.counts['windows.getAll'], fake.counts['tabGroups.query']]).toEqual([1, 1, 1]);
  });
});

describe('inventory: protection set', () => {
  it('counts one row per protection code, once per row, and nothing else', async () => {
    await repos.settings.write({ ...DEFAULT_SETTINGS, protectedSites: [{ hostname: 'kept.test', includeSubdomains: false }] });
    origins = async () => [8];
    mount();
    const tabs = [
      tab({ id: 1, url: 'https://kept.test/' }),            // SITE_PROTECTED
      tab({ id: 2 }),                                        // TAB_PROTECTED (below)
      tab({ id: 3, autoDiscardable: false }),                // BROWSER_PROTECTED
      tab({ id: 4, active: true, windowId: 11 }),            // SELECTED
      tab({ id: 5, audible: true }),                         // AUDIBLE
      tab({ id: 6, pinned: true }),                          // PINNED
      tab({ id: 7, status: 'loading' }),                     // LOADING
      tab({ id: 8 }),                                        // DASHBOARD_ORIGIN
      tab({ id: 9, url: 'chrome://settings' }),              // unsupported: not protection
      tab({ id: 10, discarded: true, status: 'unloaded' }),  // already unloaded: not protection
      tab({ id: 11 }),                                       // plain
      tab({ id: 12, active: true, audible: true, pinned: true, windowId: 12 }), // three at once
    ];
    await seed(tabs);
    const t = createTracker({ adapter: createChromeAdapter(fake.api), activity: repos.activity });
    await t.setTabProtection(2, true);
    const s = await inventory.capture(NOW);
    expect(s.counts!.protected).toBe(9);
    expect(s.counts!.eligible).toBe(1);
    expect(s.rows.find((r) => r.tabId === 12)!.manualBulkDecision.reasons).toEqual(
      expect.arrayContaining(['SELECTED', 'AUDIBLE', 'PINNED']));
  });
});

describe('inventory: a failed read never looks like an empty result', () => {
  it('flags the snapshot unavailable when the tab query fails, and does not reconcile', async () => {
    await seed([tab({ id: 1 })]);
    const before = JSON.stringify(storage.session.data.get('fallow.activity'));
    fake.rejectOn.set('tabs.query', new Error('boom'));
    const s = await inventory.capture(NOW);
    expect(s.tabsAvailable).toBe(false);
    expect(s.failedReads).toContain('tabs');
    expect(s.rows).toEqual([]);
    expect(s.counts).toBeNull();
    expect(JSON.stringify(storage.session.data.get('fallow.activity'))).toBe(before);
  });
  it('reports tabsAvailable true with an empty list when the browser really has no tabs', async () => {
    const s = await inventory.capture(NOW);
    expect(s.tabsAvailable).toBe(true);
    expect(s.failedReads).toEqual([]);
    expect(s.rows).toEqual([]);
  });
  it('keeps the rows and flags windows when the window query fails', async () => {
    await seed([tab({ id: 1 }), tab({ id: 2, windowId: 20 })]);
    fake.rejectOn.set('windows.getAll', new Error('boom'));
    const s = await inventory.capture(NOW);
    expect(s.failedReads).toEqual(['windows']);
    expect(s.windows.map((w) => w.label)).toEqual(['Window 1', 'Window 2']);
    expect(s.counts!.total).toBe(2);
  });
  it('keeps grouping tabs and flags groups when the group query fails', async () => {
    fake.groups.push(group(1));
    await seed([tab({ id: 1, groupId: 1 })]);
    fake.rejectOn.set('tabGroups.query', new Error('boom'));
    const s = await inventory.capture(NOW);
    expect(s.failedReads).toEqual(['groups']);
    expect(s.windows[0]!.groups[0]!.tabIds).toEqual([1]);
  });
  it('flags session when the session read rejects, and the auto decision does not pass on a null grace silently', async () => {
    await seed([tab({ id: 1 })]);
    const session = { read: () => Promise.reject(new Error('boom')), write: repos.session.write };
    const adapter = createChromeAdapter(fake.api);
    inventory = createInventory({ adapter, tracker: createTracker({ adapter, activity: repos.activity }), session, settings: repos.settings, dashboardOrigins: origins });
    const s = await inventory.capture(NOW);
    expect(s.failedReads).toEqual(['session']);
    expect(s.graceUntil).toBe(null);
  });
  it('flags settings and falls back to defaults when the settings read rejects', async () => {
    await seed([tab({ id: 1 })]);
    const settings = { read: () => Promise.reject(new Error('boom')), write: repos.settings.write };
    const adapter = createChromeAdapter(fake.api);
    inventory = createInventory({ adapter, tracker: createTracker({ adapter, activity: repos.activity }), session: repos.session, settings, dashboardOrigins: origins });
    const s = await inventory.capture(NOW);
    expect(s.failedReads).toEqual(['settings']);
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
  });
  it('flags settings and session when real storage rejects, so defaults are never presented as the owner\'s', async () => {
    await seed([tab({ id: 1 })]);
    storage.local.rejectOn.set('get:fallow.settings', new Error('unavailable'));
    storage.session.rejectOn.set('get:fallow.session', new Error('unavailable'));
    const s = await inventory.capture(NOW);
    expect(s.failedReads).toEqual(['session', 'settings']);
  });
  it('flags dashboard origins when that read rejects', async () => {
    await seed([tab({ id: 1 })]);
    origins = () => Promise.reject(new Error('boom'));
    mount();
    const s = await inventory.capture(NOW);
    expect(s.failedReads).toEqual(['dashboardOrigins']);
    expect(s.counts!.total).toBe(1);
  });
  it('flags activity and holds every tab when the tracker cannot reconcile', async () => {
    await seed([tab({ id: 1 })]);
    const adapter = createChromeAdapter(fake.api);
    const real = createTracker({ adapter, activity: repos.activity });
    const tracker = { ...real, reconcile: () => Promise.reject(new Error('boom')) };
    inventory = createInventory({ adapter, tracker, session: repos.session, settings: repos.settings, dashboardOrigins: origins });
    const s = await inventory.capture(NOW);
    expect(s.failedReads).toContain('activity');
    expect(s.counts!.eligible).toBe(0);
  });
});
