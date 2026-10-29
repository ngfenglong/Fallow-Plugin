// Scriptable test double for the `chrome` namespace. Not a mock library: a small
// in-memory browser whose behaviour a test steers through plain fields.
export type FakeTab = Partial<chrome.tabs.Tab>;
export type DiscardBehaviour = 'confirm' | 'silent-noop' | 'reject';

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
  /** ids passed to tabs.get, in order */
  getCalls: number[];
  counts: Record<string, number>;
  /** Operations the adapter must never perform. */
  forbidden: { remove: number; move: number; update: number };
  nextId: number;
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
    getCalls: [],
    counts: {},
    forbidden: { remove: 0, move: 0, update: 0 },
    nextId: 1000,
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
      discard: wrap('tabs.discard', (id: number) => {
        const t = find(id);
        if (!t) throw noTab(id);
        if (f.discardBehaviour === 'reject') throw new Error('Tabs cannot be discarded while active');
        if (f.discardBehaviour === 'silent-noop') return undefined;
        const newId = f.nextDiscardId ?? f.nextId++;
        const replacement: FakeTab = { ...t, id: newId, discarded: true, status: 'unloaded' };
        f.tabs.splice(f.tabs.indexOf(t), 1, replacement);
        return replacement;
      }),
      highlight: wrap('tabs.highlight', (_: chrome.tabs.HighlightInfo) => undefined),
      create: wrap('tabs.create', (p: chrome.tabs.CreateProperties) => {
        const t: FakeTab = { id: f.nextId++, url: p.url, windowId: 1, index: f.tabs.length };
        f.tabs.push(t);
        return t;
      }),
      remove: () => { f.forbidden.remove++; return Promise.resolve(); },
      move: () => { f.forbidden.move++; return Promise.resolve([]); },
      update: () => { f.forbidden.update++; return Promise.resolve(undefined); },
    },
    windows: {
      getAll: wrap('windows.getAll', () => f.windows),
      update: wrap('windows.update', (_id: number, _p: chrome.windows.UpdateInfo) => undefined),
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
