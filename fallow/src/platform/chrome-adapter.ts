// The single boundary between Fallow and the browser API. Every method resolves;
// none rejects. Thrown errors, rejections and chrome.runtime.lastError all become
// { ok: false }. Contains no policy: typed wrappers and error normalisation only.
import type { TabFacts } from '../domain/types';

export type AdapterError = { kind: 'tab-gone' | 'rejected' | 'no-permission' | 'unknown'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: AdapterError };

export type WindowShape = { windowId: number; focused: boolean };
export type GroupShape = { groupId: number; windowId: number; title: string; color: string; collapsed: boolean };
// Chrome mints a NEW tab id on discard (milestone 0): facts.tabId is the new id.
// `observed` is true only when `facts` came from a real re-read of the tab after the
// discard. It is false when the re-read failed and the facts are the object `tabs.discard`
// itself resolved with — which milestone 0 measured as always carrying discarded:true, so
// it is evidence that the call was made, never that the tab unloaded. A caller that counts
// confirmations by observation must not trust `facts` while `observed` is false.
// `mintedTabId` is the id Chrome reported for the post-discard tab, and the ONLY id a
// caller may re-read: the Global Constraints forbid re-reading the id that was asked to be
// discarded. It is null when Chrome resolved without an id, which leaves nothing safe to
// read and no way to confirm; `facts` is null in the case where Chrome resolved with no
// tab at all, because there is nothing to report and inventing it is what would turn an
// unverifiable discard into a confirmed one.
export type DiscardOutcome = {
  requestedTabId: number; facts: TabFacts | null; observed: boolean; mintedTabId: number | null;
};

export interface ChromeAdapter {
  queryTabs(): Promise<Result<TabFacts[]>>;
  getTab(tabId: number): Promise<Result<TabFacts>>;
  queryWindows(): Promise<Result<WindowShape[]>>;
  queryGroups(): Promise<Result<GroupShape[]>>;
  discard(tabId: number): Promise<Result<DiscardOutcome>>;
  focusTab(tabId: number): Promise<Result<void>>;
  openUrlInNewTab(url: string): Promise<Result<number>>;
  getAlarm(name: string): Promise<Result<boolean>>;
  createAlarm(name: string, periodMinutes: number): Promise<Result<void>>;
  clearAlarm(name: string): Promise<Result<void>>;
}

/** Exported for direct testing. Order matters: first match wins. */
export function classifyError(message: string): AdapterError['kind'] {
  if (/no tab with id|No tab with id|Invalid tab ID/i.test(message)) return 'tab-gone';
  if (/permission/i.test(message)) return 'no-permission';
  if (/cannot be discarded|active tab|cannot be edited|dragging a tab/i.test(message)) return 'rejected';
  return 'unknown';
}

function fail(message: string): { ok: false; error: AdapterError } {
  return { ok: false, error: { kind: classifyError(message), message } };
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
    return String(e);
  } catch {
    return 'Unknown error';
  }
}

const STATUSES = ['loading', 'complete', 'unloaded'] as const;

export function toTabFacts(tab: chrome.tabs.Tab): TabFacts {
  const status = STATUSES.find((s) => s === (tab.status as string));
  return {
    tabId: tab.id ?? -1,
    index: tab.index ?? -1,
    windowId: tab.windowId ?? -1,
    groupId: tab.groupId ?? -1,
    url: tab.url ?? tab.pendingUrl ?? '',
    title: tab.title ?? '',
    active: tab.active ?? false,
    audible: tab.audible ?? false,
    pinned: tab.pinned ?? false,
    discarded: tab.discarded ?? false,
    autoDiscardable: tab.autoDiscardable ?? true,
    status: status ?? 'complete',
  };
}

export function createChromeAdapter(api: typeof chrome): ChromeAdapter {
  // Runs fn, then checks lastError: Chrome may set it and still deliver a value.
  async function guard<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
    try {
      const value = await fn();
      const le = api.runtime?.lastError;
      if (le) return fail(le.message ?? 'Unknown runtime error');
      return { ok: true, value };
    } catch (e) {
      return fail(messageOf(e));
    }
  }

  // Mapping runs inside guard so a null/undefined/odd result becomes { ok: false }, never a throw.
  const getTab = (tabId: number): Promise<Result<TabFacts>> =>
    guard(async () => {
      const t = await api.tabs.get(tabId);
      if (t.id === undefined) throw new Error(`No tab with id: ${tabId}`);
      return toTabFacts(t);
    });

  return {
    queryTabs() {
      // Tabs without an id cannot be acted on, so they are dropped. An inventory
      // built from this can therefore differ from the browser's own tab count.
      return guard(async () =>
        (await api.tabs.query({})).filter((t) => t.id !== undefined).map(toTabFacts),
      );
    },
    getTab,
    queryWindows() {
      return guard(async () =>
        (await api.windows.getAll())
          .filter((w) => w.id !== undefined)
          .map((w) => ({ windowId: w.id as number, focused: w.focused ?? false })),
      );
    },
    queryGroups() {
      return guard(async () =>
        (await api.tabGroups.query({})).map((g) => ({
          groupId: g.id, windowId: g.windowId, title: g.title ?? '', color: g.color, collapsed: g.collapsed,
        })),
      );
    },
    async discard(tabId) {
      const d = await guard(() => api.tabs.discard(tabId));
      if (!d.ok) return d;
      // Chrome mints a NEW tab id on discard (milestone 0), and that id is the only one we
      // may read: re-reading the requested id is forbidden outright, and would report a
      // tab that unloaded perfectly as gone. Without a minted id there is nothing safe to
      // read, so the outcome is unobserved and the caller cannot confirm it.
      const resolved = d.value;
      if (resolved?.id === undefined) {
        const facts = resolved ? toTabFacts(resolved) : null;
        return { ok: true, value: { requestedTabId: tabId, facts, observed: false, mintedTabId: null } };
      }
      const mintedTabId = resolved.id;
      const r = await getTab(mintedTabId);
      if (r.ok) {
        return { ok: true, value: { requestedTabId: tabId, facts: r.value, observed: true, mintedTabId } };
      }
      // The discard succeeded and Chrome handed us the post-discard tab: keep it rather
      // than report a successful unload as a failure and lose the new id. Flagged
      // `observed: false`, because nothing about the tab was actually read — milestone 0
      // measured this object as always carrying discarded:true, so it is evidence the call
      // was made, never that the tab unloaded.
      return {
        ok: true,
        value: { requestedTabId: tabId, facts: toTabFacts(resolved), observed: false, mintedTabId },
      };
    },
    async focusTab(tabId) {
      // Activation only: tabs.update is called with { active: true } and never a url.
      const t = await guard(() => api.tabs.update(tabId, { active: true }));
      if (!t.ok) return t;
      // Window focus is best-effort: the tab is already active, so a failure
      // here must not be reported as a failed focus.
      const windowId = t.value?.windowId;
      if (windowId !== undefined) {
        await guard(() => api.windows.update(windowId, { focused: true }));
      }
      return { ok: true, value: undefined };
    },
    async openUrlInNewTab(url) {
      const r = await guard(() => api.tabs.create({ url }));
      if (!r.ok) return r;
      if (r.value?.id === undefined) return fail('Chrome created a tab without an id');
      return { ok: true, value: r.value.id };
    },
    async getAlarm(name) {
      const r = await guard(() => api.alarms.get(name));
      return r.ok ? { ok: true, value: r.value !== undefined && r.value !== null } : r;
    },
    createAlarm(name, periodMinutes) {
      return guard(async () => {
        await api.alarms.create(name, { periodInMinutes: periodMinutes });
      });
    },
    clearAlarm(name) {
      return guard(async () => {
        await api.alarms.clear(name);
      });
    },
  };
}
