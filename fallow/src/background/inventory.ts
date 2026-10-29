// Reads and assembles; never acts on a tab. One capture = one tab query, one window
// query, one group query and one tracker reconcile.
//
// Failure policy, read by read. A failed read must never render as a legitimate empty
// result, so every degradation is named in `failedReads`:
//   tabs             -> the snapshot is unavailable (tabsAvailable false, no rows, no
//                       reconcile). An empty inventory would read as "you have no tabs".
//   windows          -> sections are derived from the tabs, in ascending windowId order,
//                       with focused false (unknown).
//   groups           -> groups are derived from the tabs' groupIds with blank metadata.
//                       A group id absent from a successful list is handled the same way.
//   session          -> graceUntil null (no grace known).
//   settings         -> shipped defaults.
//   dashboardOrigins -> treated as none; the owner can see the flag.
//   activity         -> (reconcile or snapshot failed) no tab is trusted to have any
//                       background time, so timing holds every tab. Fails closed.
import type { ChromeAdapter, GroupShape, WindowShape } from '../platform/chrome-adapter';
import type { SessionRepo, SettingsRepo } from '../platform/storage';
import type { Tracker } from './tracker';
import type { Decision, LifecycleState, Settings, TabActivity, TabFacts } from '../domain/types';
import { backgroundElapsedMs, decide, lifecycleOf } from '../domain/eligibility';
import { hostnameOf } from '../domain/hostname';
import { DEFAULT_SETTINGS } from '../domain/settings';
import type { ReasonCode } from '../domain/reason-codes';

export type TabRow = {
  tabId: number; windowId: number; groupId: number;
  title: string; hostname: string | null; url: string;
  /** URL scheme without the colon, for display when hostname is null; null if unparseable. */
  scheme: string | null;
  lifecycle: LifecycleState; selected: boolean; audible: boolean; pinned: boolean;
  backgroundMs: number; decision: Decision; manualBulkDecision: Decision;
};
export type WindowSection = {
  windowId: number; label: string; focused: boolean;
  groups: Array<{ groupId: number; title: string; color: string; collapsed: boolean; tabIds: number[] }>;
  ungroupedTabIds: number[];
};
export type FailedRead = 'tabs' | 'windows' | 'groups' | 'session' | 'settings' | 'dashboardOrigins' | 'activity';
export type Snapshot = {
  capturedAt: number;
  windows: WindowSection[]; rows: TabRow[];
  counts: { total: number; loaded: number; unloaded: number; eligible: number; protected: number };
  settings: Settings; graceUntil: number | null;
  automationNote: string | null;
  /** False when the tab query failed: rows/windows are empty because of a failure, not because there are no tabs. */
  tabsAvailable: boolean;
  /** Every read that failed this capture, in a fixed order. Empty means everything was read. */
  failedReads: FailedRead[];
};
export type Inventory = { capture(now: number): Promise<Snapshot> };

// Reasons that mean "something protects this tab". Timing (USED_RECENTLY, NOT_OLD_ENOUGH,
// STARTUP_GRACE), scope (UNSUPPORTED_URL) and state (ALREADY_UNLOADED) are not protection.
const PROTECTION: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'SELECTED', 'AUDIBLE', 'LOADING', 'TAB_PROTECTED', 'SITE_PROTECTED', 'PINNED',
  'BROWSER_PROTECTED', 'DASHBOARD_ORIGIN',
]);

const AUTOMATION_OFF_NOTE = 'Extension automation is off. Chrome may still unload tabs independently.';
const READ_ORDER: FailedRead[] = ['tabs', 'windows', 'groups', 'session', 'settings', 'dashboardOrigins', 'activity'];

function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol.replace(/:$/, '') || null;
  } catch {
    return null;
  }
}

async function attempt<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

export function createInventory(deps: {
  adapter: ChromeAdapter; tracker: Tracker; session: SessionRepo; settings: SettingsRepo;
  dashboardOrigins: () => Promise<readonly number[]>;
}): Inventory {
  const { adapter, tracker, session, settings, dashboardOrigins } = deps;

  async function capture(now: number): Promise<Snapshot> {
    const failed = new Set<FailedRead>();
    const [tabsR, windowsR, groupsR, sessionR, settingsR, originsR] = await Promise.all([
      adapter.queryTabs(), adapter.queryWindows(), adapter.queryGroups(),
      attempt(() => session.read()), attempt(() => settings.read()), attempt(() => dashboardOrigins()),
    ]);

    if (!windowsR.ok) failed.add('windows');
    if (!groupsR.ok) failed.add('groups');
    if (!sessionR.ok) failed.add('session');
    if (!settingsR.ok) failed.add('settings');
    if (!originsR.ok) failed.add('dashboardOrigins');

    const cfg: Settings = settingsR.ok ? settingsR.value : DEFAULT_SETTINGS;
    const graceUntil = sessionR.ok ? (sessionR.value?.graceUntil ?? null) : null;
    const automationNote = cfg.automationEnabled ? null : AUTOMATION_OFF_NOTE;
    const origins = originsR.ok ? originsR.value : [];

    if (!tabsR.ok) {
      failed.add('tabs');
      return {
        capturedAt: now, windows: [], rows: [],
        counts: { total: 0, loaded: 0, unloaded: 0, eligible: 0, protected: 0 },
        settings: cfg, graceUntil, automationNote,
        tabsAvailable: false, failedReads: READ_ORDER.filter((r) => failed.has(r)),
      };
    }
    const tabs: TabFacts[] = tabsR.value;

    // Activity: a failure leaves every tab with no known background time, which holds it.
    let activity: Record<number, TabActivity> = {};
    try {
      await tracker.reconcile(tabs, now);
      activity = await tracker.snapshot();
    } catch {
      failed.add('activity');
      activity = {};
    }

    const rows: TabRow[] = tabs.map((tab) => {
      const act = activity[tab.tabId] ?? null;
      const base = { tab, settings: cfg, activity: act, now, graceUntil, dashboardOriginTabIds: origins };
      return {
        tabId: tab.tabId, windowId: tab.windowId, groupId: tab.groupId,
        title: tab.title, hostname: hostnameOf(tab.url), url: tab.url, scheme: schemeOf(tab.url),
        lifecycle: lifecycleOf(tab), selected: tab.active, audible: tab.audible, pinned: tab.pinned,
        backgroundMs: backgroundElapsedMs(act, now),
        decision: decide({ ...base, mode: 'auto' }),
        manualBulkDecision: decide({ ...base, mode: 'manual-bulk' }),
      };
    });

    const windows = buildWindows(
      rows,
      windowsR.ok ? windowsR.value : [],
      groupsR.ok ? groupsR.value : [],
    );

    const unloaded = rows.filter((r) => r.lifecycle === 'unloaded').length;
    return {
      capturedAt: now, windows, rows,
      counts: {
        total: rows.length,
        loaded: rows.length - unloaded, // loading counts as loaded
        unloaded,
        eligible: rows.filter((r) => r.manualBulkDecision.eligible).length,
        protected: rows.filter((r) => r.manualBulkDecision.reasons.some((c) => PROTECTION.has(c))).length,
      },
      settings: cfg, graceUntil, automationNote,
      tabsAvailable: true, failedReads: READ_ORDER.filter((r) => failed.has(r)),
    };
  }

  return { capture };
}

// Order is the browser's: tabs arrive in browser order and are never sorted. Windows are
// listed by ascending id, which is also how the session labels are assigned.
function buildWindows(
  rows: readonly TabRow[], windows: readonly WindowShape[], groups: readonly GroupShape[],
): WindowSection[] {
  const focused = new Map(windows.map((w) => [w.windowId, w.focused]));
  const ids = new Set<number>([...windows.map((w) => w.windowId), ...rows.map((r) => r.windowId)]);
  const groupInfo = new Map(groups.map((g) => [g.groupId, g]));

  return [...ids].sort((a, b) => a - b).map((windowId, i) => {
    const section: WindowSection = {
      windowId, label: `Window ${i + 1}`, focused: focused.get(windowId) ?? false,
      groups: [], ungroupedTabIds: [],
    };
    const byGroup = new Map<number, WindowSection['groups'][number]>();
    for (const row of rows) {
      if (row.windowId !== windowId) continue;
      if (row.groupId === -1) {
        section.ungroupedTabIds.push(row.tabId);
        continue;
      }
      let g = byGroup.get(row.groupId);
      if (!g) {
        const info = groupInfo.get(row.groupId);
        g = { groupId: row.groupId, title: info?.title ?? '', color: info?.color ?? 'grey', collapsed: info?.collapsed ?? false, tabIds: [] };
        byGroup.set(row.groupId, g);
        section.groups.push(g); // first appearance in tab order = group order
      }
      g.tabIds.push(row.tabId);
    }
    return section;
  });
}
