// The single boundary between Fallow and the browser API. Every method resolves;
// none rejects. Thrown errors, rejections and chrome.runtime.lastError all become
// { ok: false }. Contains no policy: typed wrappers and error normalisation only.
import type { TabFacts } from '../domain/types';

export type AdapterError = { kind: 'tab-gone' | 'rejected' | 'no-permission' | 'unknown'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: AdapterError };

export type WindowShape = { windowId: number; focused: boolean };
export type GroupShape = { groupId: number; windowId: number; title: string; color: string; collapsed: boolean };
// Chrome mints a NEW tab id on discard (milestone 0): facts.tabId is the new id.
export type DiscardOutcome = { requestedTabId: number; facts: TabFacts };

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
      // Chrome returns a NEW tab with a different id. Re-read by that id, never
      // the requested one; fall back only when Chrome resolved without a tab.
      const readId = d.value?.id ?? tabId;
      const r = await getTab(readId);
      if (r.ok) return { ok: true, value: { requestedTabId: tabId, facts: r.value } };
      // The discard succeeded and Chrome handed us the post-discard tab: use it
      // rather than report a successful unload as a failure and lose the new id.
      if (d.value) {
        const facts = toTabFacts(d.value);
        if (d.value.id === undefined) facts.tabId = tabId;
        return { ok: true, value: { requestedTabId: tabId, facts } };
      }
      return r;
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
