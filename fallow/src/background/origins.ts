// Dashboard-origin protection (A14, design §11.5).
//
// Opening the dashboard in a new tab sends the page the owner was reading into the
// background, where a bulk "unload eligible tabs" would take it straight away. So the tab a
// dashboard was opened from is an ORIGIN, and an origin is skipped by manual bulk actions
// (DASHBOARD_ORIGIN) until it has been in the background for the configured threshold —
// the same rule as any other tab, then it is ordinary again. No permanent exemption.
//
// Stored: the registered tab ids, in chrome.storage.session under KEYS.dashboardOrigins.
// Not stored: whether each is still an origin. That is recomputed on every read from the
// live tab list and the tracker's timers, so there is no second record to drift.
//
// Failure rule, in one line: an origin is released only on EVIDENCE (the tab is gone, or
// its timer says it has expired), never for want of it. An unreadable registration list is
// a rejection, never an empty list: [] is exactly the A14 hole, and the executor blocks a
// manual-bulk run on a rejected read.
import { KEYS, type SettingsRepo, type StorageArea } from '../platform/storage';
import type { ChromeAdapter } from '../platform/chrome-adapter';
import type { Tracker } from './tracker';
import { hostnameOf } from '../domain/hostname';

export interface Origins {
  /**
   * Registers the tab a dashboard was opened from. `null` means the dashboard was opened
   * directly; it is resolved against the dashboard's own tab (`senderTabId`), never treated
   * as "no origin" by default. Resolves with the tab registered, or null when there is none.
   */
  registerOrigin(tabId: number | null, now: number, senderTabId?: number | null): Promise<number | null>;
  /** The tabs that are origins now. Rejects when the registrations cannot be read. */
  activeOrigins(now: number): Promise<number[]>;
  /** A discard renames a tab; a registered origin keeps its registration under the new id. */
  onReplaced(addedTabId: number, removedTabId: number): Promise<void>;
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The stored record exists but is not a list of tab ids. Distinct from a failed read. */
class UnreadableOriginRecord extends Error {
  constructor() {
    super('The dashboard origin record is unreadable.');
  }
}

/** The stored registrations. Absent is none; anything that is not a list of tab ids is unreadable. */
function parseRegistered(raw: unknown): number[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every(isId)) throw new UnreadableOriginRecord();
  return [...raw];
}

export function createOrigins(deps: {
  adapter: ChromeAdapter; tracker: Tracker; settings: SettingsRepo; storage: StorageArea;
}): Origins {
  const { adapter, tracker, settings, storage } = deps;

  // Every write is read-modify-write, so two at once would lose one: they queue.
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The registrations that are still origins. Everything here can only RELEASE one, so any
   * failed read returns the list unchanged: a superset protects more, never less.
   */
  async function stillOrigins(registered: number[], now: number): Promise<number[]> {
    if (registered.length === 0) return [];
    let threshold: number;
    try {
      threshold = (await settings.read()).inactivityMinutes * 60_000;
    } catch {
      return registered;
    }
    const tabs = await adapter.queryTabs();
    if (!tabs.ok) return registered;
    const present = new Set(tabs.value.map((t) => t.tabId));
    let activity: Awaited<ReturnType<Tracker['snapshot']>>;
    try {
      activity = await tracker.snapshot();
    } catch {
      return registered;
    }
    return registered.filter((id) => {
      if (!present.has(id)) return false;
      // A selected tab (null) or one with no timer yet cannot be shown to have expired.
      const since = activity[id]?.backgroundSince;
      // A clock that moved backwards gives a negative age, which is not expiry either.
      return !(typeof since === 'number' && now - since >= threshold);
    });
  }

  async function activeOrigins(now: number): Promise<number[]> {
    return stillOrigins(parseRegistered(await storage.get(KEYS.dashboardOrigins)), now);
  }

  /**
   * For a dashboard opened directly (F2): the content tab in the dashboard's own window that
   * was most recently selected, i.e. the one with the latest background time. A page Fallow
   * cannot act on (a browser page, another extension page, the dashboard itself) is never
   * chosen, because it was not the page the owner was reading. Every read failure throws:
   * guessing would protect the wrong tab and leave the right one exposed.
   */
  async function mostRecentlyLeft(senderTabId: number): Promise<number | null> {
    const dashboard = await adapter.getTab(senderTabId);
    if (!dashboard.ok) throw new Error(dashboard.error.message);
    const tabs = await adapter.queryTabs();
    if (!tabs.ok) throw new Error(tabs.error.message);
    const activity = await tracker.snapshot();
    let best: { tabId: number; since: number } | null = null;
    for (const t of tabs.value) {
      if (t.windowId !== dashboard.value.windowId || t.tabId === senderTabId) continue;
      if (hostnameOf(t.url) === null) continue;
      const since = activity[t.tabId]?.backgroundSince;
      if (typeof since !== 'number') continue;
      if (best === null || since > best.since) best = { tabId: t.tabId, since };
    }
    return best?.tabId ?? null;
  }

  function registerOrigin(tabId: number | null, now: number, senderTabId: number | null = null): Promise<number | null> {
    return serial(async () => {
      // null is a dashboard opened with no origin tab; it is resolved, not ignored. Without a
      // tab of its own (a popup has none) there is no window to resolve it in.
      const target = tabId !== null ? tabId : senderTabId === null ? null : await mostRecentlyLeft(senderTabId);
      if (target === null) return null;
      let registered: number[];
      try {
        registered = parseRegistered(await storage.get(KEYS.dashboardOrigins));
      } catch (e) {
        // A failed READ fails the registration (the dashboard is told). An unreadable
        // RECORD is replaced: its contents cannot be honoured, and keeping it would block
        // every manual bulk action until the browser restarts.
        if (!(e instanceof UnreadableOriginRecord)) throw e;
        registered = [];
      }
      // Pruned here, on the rare write, so the list stays bounded without the hot read path
      // ever writing.
      const kept = await stillOrigins(registered, now);
      if (!kept.includes(target)) kept.push(target);
      await storage.set(KEYS.dashboardOrigins, kept);
      return target;
    });
  }

  function onReplaced(addedTabId: number, removedTabId: number): Promise<void> {
    return serial(async () => {
      const registered = parseRegistered(await storage.get(KEYS.dashboardOrigins));
      if (!registered.includes(removedTabId)) return;
      const next = registered.filter((id) => id !== removedTabId && id !== addedTabId);
      next.push(addedTabId);
      await storage.set(KEYS.dashboardOrigins, next);
    });
  }

  return { registerOrigin, activeOrigins, onReplaced };
}
