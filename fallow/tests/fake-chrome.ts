// Scriptable test double for the `chrome` namespace. Not a mock library: a small
// in-memory browser whose behaviour a test steers through plain fields.
export type FakeTab = Partial<chrome.tabs.Tab>;
// 'silent-noop' resolves with undefined; 'resolve-without-id' resolves with a tab object
// that carries no id. Both leave the caller with no minted id to re-read, and neither may
// be answered by re-reading the id that was asked to be discarded.
export type DiscardBehaviour = 'confirm' | 'silent-noop' | 'reject' | 'resolve-without-id';

/** Shorthand call counters, derived from `counts`. Read-only. */
export type FakeCalls = {
  discard: number; get: number; query: number; update: number; windowUpdate: number;
  create: number; groups: number; windows: number;
  /** tabs.remove / tabs.move: operations Fallow must never perform. */
  remove: number; move: number;
  /** tabs.update calls that activated a tab, i.e. an adapter focusTab. */
  focusTab: number;
};

export type FakeChrome = {
  api: typeof chrome;
  tabs: FakeTab[];
  windows: Array<{ id?: number; focused?: boolean }>;
  groups: Array<Partial<chrome.tabGroups.TabGroup>>;
  alarms: Map<string, { name: string; periodInMinutes?: number }>;
  lastError: { message: string } | undefined;
  throwOn: Map<string, Error>;
  rejectOn: Map<string, Error>;
  discardBehaviour: DiscardBehaviour;
  nextDiscardId?: number;
  /** a discard chrome accepts that does not unload the tab: the id changes, the state does not */
  discardedStaysLoaded: boolean;
  /** ids passed to tabs.get, in order */
  getCalls: number[];
  counts: Record<string, number>;
  /** Operations the adapter must never perform. */
  forbidden: { remove: number; move: number };
  /** property bag of every tabs.update call */
  updateCalls: Array<Record<string, unknown>>;
  /** arguments of every windows.update call */
  windowUpdateCalls: Array<{ windowId: number; props: Record<string, unknown> }>;
  nextId: number;
  /** Runs inside tabs.discard before the tab changes. `n` is 1-based. May be async. */
  onBeforeDiscard?: (tabId: number, n: number) => unknown;
  /** Runs inside tabs.discard after the tab changes. `n` is 1-based. May be async. */
  onAfterDiscard?: (tabId: number, n: number) => unknown;
  /** Discards currently inside tabs.discard, and the high-water mark of that number. */
  inFlightDiscards: number;
  maxConcurrentDiscards: number;
  /** Derived counters; see FakeCalls. */
  readonly calls: FakeCalls;
  /** Replaces the whole tab list in place. */
  setTabs: (tabs: FakeTab[]) => void;
  /** Selects one tab and deselects every other tab in its window. */
  setActive: (tabId: number) => void;
  removeTab: (tabId: number) => void;
};

export function createFakeChrome(initial: FakeTab[] = []): FakeChrome {
  const f: FakeChrome = {
    api: undefined as unknown as typeof chrome,
    tabs: initial,
    windows: [],
    groups: [],
    alarms: new Map(),
    lastError: undefined,
    throwOn: new Map(),
    rejectOn: new Map(),
    discardBehaviour: 'confirm',
    nextDiscardId: undefined,
    discardedStaysLoaded: false,
    getCalls: [],
    counts: {},
    forbidden: { remove: 0, move: 0 },
    updateCalls: [],
    windowUpdateCalls: [],
    nextId: 1000,
    inFlightDiscards: 0,
    maxConcurrentDiscards: 0,
    get calls(): FakeCalls {
      const n = (key: string) => f.counts[key] ?? 0;
      return {
        discard: n('tabs.discard'), get: n('tabs.get'), query: n('tabs.query'),
        update: n('tabs.update'), windowUpdate: n('windows.update'), create: n('tabs.create'),
        groups: n('tabGroups.query'), windows: n('windows.getAll'),
        remove: f.forbidden.remove, move: f.forbidden.move,
        focusTab: f.updateCalls.filter((p) => p.active === true).length,
      };
    },
    setTabs(tabs: FakeTab[]) {
      f.tabs.splice(0, f.tabs.length, ...tabs);
    },
    setActive(tabId: number) {
      const target = f.tabs.find((t) => t.id === tabId);
      if (!target) throw new Error(`setActive: no tab with id ${tabId}`);
      for (const t of f.tabs) if (t.windowId === target.windowId) t.active = false;
      target.active = true;
    },
    removeTab(tabId: number) {
      const i = f.tabs.findIndex((t) => t.id === tabId);
      if (i >= 0) f.tabs.splice(i, 1);
    },
  };

  // Every scripted method funnels through here: count, maybe throw, maybe reject.
  const run = async <T>(name: string, fn: () => T): Promise<T> => {
    f.counts[name] = (f.counts[name] ?? 0) + 1;
    return fn();
  };
  const wrap = <A extends unknown[], T>(name: string, impl: (...a: A) => T) =>
    (...args: A): Promise<Awaited<T>> => {
      f.counts[name] = (f.counts[name] ?? 0) + 1;
      const thrown = f.throwOn.get(name);
      if (thrown) throw thrown; // synchronous throw, before any promise exists
      const rejected = f.rejectOn.get(name);
      if (rejected) return Promise.reject(rejected);
      try {
        return Promise.resolve(impl(...args)) as Promise<Awaited<T>>;
      } catch (e) {
        return Promise.reject(e);
      }
    };
  void run;

  const find = (id: number) => f.tabs.find((t) => t.id === id);
  const noTab = (id: number) => new Error(`No tab with id: ${id}`);

  const api = {
    runtime: {
      get lastError() {
        return f.lastError;
      },
    },
    tabs: {
      query: wrap('tabs.query', () => f.tabs),
      get: wrap('tabs.get', (id: number) => {
        f.getCalls.push(id);
        const t = find(id);
        if (!t) throw noTab(id);
        return t;
      }),
      // Async so a test can script what happens *during* a request, and so overlapping
      // requests are observable through maxConcurrentDiscards.
      discard: wrap('tabs.discard', async (id: number) => {
        const n = f.counts['tabs.discard'] ?? 0; // wrap already counted this call
        f.inFlightDiscards++;
        f.maxConcurrentDiscards = Math.max(f.maxConcurrentDiscards, f.inFlightDiscards);
        try {
          await f.onBeforeDiscard?.(id, n);
          const t = find(id);
          if (!t) throw noTab(id);
          if (f.discardBehaviour === 'reject') throw new Error('Tabs cannot be discarded while active');
          if (f.discardBehaviour === 'silent-noop') {
            await f.onAfterDiscard?.(id, n);
            return undefined;
          }
          const newId = f.nextDiscardId ?? f.nextId++;
          // discardedStaysLoaded models a discard chrome accepted that did not take effect:
          // the id changes but the tab is still loaded, so nothing may be confirmed.
          const replacement: FakeTab = f.discardedStaysLoaded
            ? { ...t, id: newId }
            : { ...t, id: newId, discarded: true, status: 'unloaded' };
          f.tabs.splice(f.tabs.indexOf(t), 1, replacement);
          await f.onAfterDiscard?.(id, n);
          if (f.discardBehaviour === 'resolve-without-id') {
            return { ...replacement, id: undefined };
          }
          return replacement;
        } finally {
          f.inFlightDiscards--;
        }
      }),
      create: wrap('tabs.create', (p: chrome.tabs.CreateProperties) => {
        const t: FakeTab = { id: f.nextId++, url: p.url, windowId: 1, index: f.tabs.length };
        f.tabs.push(t);
        return t;
      }),
      remove: () => { f.forbidden.remove++; return Promise.resolve(); },
      move: () => { f.forbidden.move++; return Promise.resolve([]); },
      update: wrap('tabs.update', (id: number, props: Record<string, unknown>) => {
        f.updateCalls.push({ ...props });
        const t = find(id);
        if (!t) throw noTab(id);
        return t;
      }),
    },
    windows: {
      getAll: wrap('windows.getAll', () => f.windows),
      update: wrap('windows.update', (windowId: number, props: chrome.windows.UpdateInfo) => {
        f.windowUpdateCalls.push({ windowId, props: { ...props } });
      }),
    },
    tabGroups: {
      query: wrap('tabGroups.query', () => f.groups),
    },
    alarms: {
      get: wrap('alarms.get', (name: string) => f.alarms.get(name)),
      create: wrap('alarms.create', (name: string, info: chrome.alarms.AlarmCreateInfo) => {
        f.alarms.set(name, { name, periodInMinutes: info.periodInMinutes });
      }),
      clear: wrap('alarms.clear', (name: string) => f.alarms.delete(name)),
    },
  };
  f.api = api as unknown as typeof chrome;
  return f;
}
