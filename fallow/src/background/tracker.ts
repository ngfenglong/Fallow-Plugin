// Records WHEN things happened, never whether a tab may be unloaded. The activity map
// lives only in storage: every operation reads it, changes it and writes it back, so
// there is no in-memory copy that can disagree with the stored one. A failed write
// rejects to the caller, who can reconcile. Operations run one at a time, so two
// overlapping events cannot each start from the same stored map and lose one change.
import type { ChromeAdapter } from '../platform/chrome-adapter';
import type { ActivityRepo, SessionRepo } from '../platform/storage';
import type { TabActivity, TabFacts } from '../domain/types';

export interface Tracker {
  reconcile(tabs: readonly TabFacts[], now: number): Promise<void>;
  onActivated(tabId: number, windowId: number, now: number): Promise<void>;
  onCreated(tab: TabFacts, now: number): Promise<void>;
  onRemoved(tabId: number): Promise<void>;
  onReplaced(addedTabId: number, removedTabId: number, now: number): Promise<void>;
  setTabProtection(tabId: number, isProtected: boolean): Promise<void>;
  snapshot(): Promise<Record<number, TabActivity>>;
}

type Map_ = Record<number, TabActivity>;

// A timestamp from the future means the clock moved backward: treat it as now.
const clamp = (since: number, now: number): number => (since > now ? now : since);

export function createTracker(deps: { adapter: ChromeAdapter; activity: ActivityRepo; session: SessionRepo }): Tracker {
  const { adapter, activity } = deps;

  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  // Read, mutate, write once. mutate returns false when nothing changed (no write).
  function update(mutate: (map: Map_) => Promise<boolean | void> | boolean | void): Promise<void> {
    return serial(async () => {
      const map = await activity.readAll();
      if ((await mutate(map)) === false) return;
      await activity.writeAll(map);
    });
  }

  return {
    reconcile(tabs, now) {
      return update(async (map) => {
        const next: Map_ = {};
        for (const tab of tabs) {
          const old = map[tab.tabId];
          let backgroundSince: number | null;
          if (tab.active) backgroundSince = null;
          else if (old && old.backgroundSince !== null) backgroundSince = clamp(old.backgroundSince, now);
          else backgroundSince = now; // unknown, or just lost selection: never backdated
          next[tab.tabId] = { tabId: tab.tabId, backgroundSince, protectedForSession: old?.protectedForSession ?? false };
        }
        // Rebuild in place so absent tabs are dropped and the map stays bounded.
        for (const key of Object.keys(map)) delete map[Number(key)];
        Object.assign(map, next);
      });
    },

    onActivated(tabId, windowId, now) {
      return update(async (map) => {
        // The payload names only the new selection; the tab that lost it in this
        // window is found by re-reading that window's tabs. Every other tab in the
        // window is no longer selected, so a still-untimed one starts now.
        const q = await adapter.queryTabs();
        if (q.ok) {
          for (const tab of q.value) {
            if (tab.windowId !== windowId || tab.tabId === tabId) continue;
            const rec = map[tab.tabId];
            if (!rec) map[tab.tabId] = { tabId: tab.tabId, backgroundSince: now, protectedForSession: false };
            else if (rec.backgroundSince === null) rec.backgroundSince = now;
            else rec.backgroundSince = clamp(rec.backgroundSince, now);
          }
        }
        const self = map[tabId];
        map[tabId] = { tabId, backgroundSince: null, protectedForSession: self?.protectedForSession ?? false };
      });
    },

    onCreated(tab, now) {
      return update((map) => {
        const old = map[tab.tabId];
        map[tab.tabId] = {
          tabId: tab.tabId,
          backgroundSince: tab.active ? null : now,
          protectedForSession: old?.protectedForSession ?? false,
        };
      });
    },

    onRemoved(tabId) {
      return update((map) => {
        if (!(tabId in map)) return false;
        delete map[tabId];
      });
    },

    onReplaced(addedTabId, removedTabId, now) {
      return update(async (map) => {
        const old = map[removedTabId];
        let record: TabActivity;
        if (old) {
          // A discard renames the tab; it does not make it fresh. Keep the timer.
          record = {
            tabId: addedTabId,
            backgroundSince: old.backgroundSince === null ? null : clamp(old.backgroundSince, now),
            protectedForSession: old.protectedForSession,
          };
        } else {
          const t = await adapter.getTab(addedTabId);
          record = { tabId: addedTabId, backgroundSince: t.ok && t.value.active ? null : now, protectedForSession: false };
        }
        delete map[removedTabId];
        map[addedTabId] = record;
      });
    },

    setTabProtection(tabId, isProtected) {
      return update((map) => {
        const old = map[tabId];
        map[tabId] = { tabId, backgroundSince: old ? old.backgroundSince : null, protectedForSession: isProtected };
      });
    },

    snapshot() {
      return serial(() => activity.readAll());
    },
  };
}
