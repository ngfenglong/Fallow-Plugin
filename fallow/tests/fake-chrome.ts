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

/** Every chrome event the fake can deliver. The worker registers fifteen of these. */
export const FAKE_EVENTS = [
  'alarms.onAlarm', 'runtime.onInstalled', 'runtime.onMessage', 'runtime.onStartup',
  'tabGroups.onRemoved', 'tabGroups.onUpdated',
  'tabs.onActivated', 'tabs.onAttached', 'tabs.onCreated', 'tabs.onDetached',
  'tabs.onRemoved', 'tabs.onReplaced', 'tabs.onUpdated',
  'windows.onFocusChanged', 'windows.onRemoved',
] as const;
export type FakeEventName = (typeof FAKE_EVENTS)[number];

export type FakeListener = {
  event: FakeEventName;
  fn: (...args: unknown[]) => unknown;
  /**
   * True when this addListener ran in the same synchronous turn as the first read of the
   * global `chrome` — i.e. before any `await` in the registering module could have resumed.
   * Measured by the fake, never reported by the module: see installChromeGlobal.
   */
  beforeAnyAwait: boolean;
};

/** A chrome.storage area: `get` resolves an items object, like the real one. */
export type FakeChromeArea = {
  data: Map<string, unknown>;
  /** 'get' | 'set' | 'remove', or 'get:key' to target one key: rejects that call. */
  rejectOn: Map<string, Error>;
  /** Awaited inside get before it answers. Lets a test hold a read open. */
  onBeforeGet?: (keys: unknown) => unknown;
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
};

/** What happened to one message delivered through `sendMessage`. */
export type FakeMessageRecord = {
  message: unknown;
  /** What the listener returned synchronously. Chrome keeps the channel open only for `true`. */
  returned: unknown;
  /** Chrome closed the channel before any response: the sender received undefined. */
  closedWithoutResponse: boolean;
};

/** When a successful tabs.discard delivers Chrome's onReplaced + onUpdated(discarded) events. */
export type DiscardEventTiming = 'none' | 'before-resolve' | 'after-resolve';

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

  // ---- events ---------------------------------------------------------------------
  /** Every addListener call, in order. */
  listeners: FakeListener[];
  /**
   * True only if at least one listener was registered and every addListener ran in the same
   * synchronous turn as the first read of the global `chrome`. Requires installChromeGlobal.
   */
  readonly listenersRegisteredBeforeAnyAwait: boolean;
  /** Every setInterval call made while installChromeGlobal is active. None of them runs. */
  intervals: Array<{ fn: unknown; ms: unknown }>;
  /** chrome.runtime.id */
  runtimeId: string;
  storage: { local: FakeChromeArea; session: FakeChromeArea };
  /** Messages the worker broadcast with runtime.sendMessage. */
  broadcasts: unknown[];
  /** With no extension page open, Chrome rejects runtime.sendMessage. Default false. */
  pagesOpen: boolean;
  /** Messages delivered through sendMessage, and what the listener did with each. */
  messages: FakeMessageRecord[];
  discardEventTiming: DiscardEventTiming;
  /** Listener return values that are still settling. `idle()` waits for them. */
  pending: Set<Promise<unknown>>;
  /** Calls every listener of `event`; resolves when each returned promise settles. */
  fire: (event: FakeEventName, ...args: unknown[]) => Promise<unknown[]>;
  /** Waits until no listener's returned promise is still pending. */
  idle: () => Promise<void>;
  /** Delivers a message the way runtime.onMessage does; resolves with the response. */
  sendMessage: (message: unknown, sender: chrome.runtime.MessageSender) => Promise<unknown>;

  // Realistic event helpers: change the fake's state the way Chrome would, then fire.
  activate: (tabId: number) => Promise<void>;
  createTab: (tab: FakeTab) => Promise<void>;
  closeTab: (tabId: number, isWindowClosing?: boolean) => Promise<void>;
  /** Changes the tab's fields, then fires onUpdated with exactly those as changeInfo. */
  updateTab: (tabId: number, changeInfo: Record<string, unknown>) => Promise<void>;
  /** An unload Fallow did not request: a new id, onReplaced, then onUpdated(discarded). */
  discardExternally: (tabId: number, newTabId?: number) => Promise<number>;
  /** onDetached from the tab's window, then onAttached to `newWindowId`. */
  moveTab: (tabId: number, newWindowId: number, newPosition: number) => Promise<void>;
  closeWindow: (windowId: number) => Promise<void>;
  focusWindow: (windowId: number) => Promise<void>;
  updateGroup: (group: Partial<chrome.tabGroups.TabGroup>) => Promise<void>;
  removeGroup: (group: Partial<chrome.tabGroups.TabGroup>) => Promise<void>;
  fireAlarm: (name: string) => Promise<void>;
  fireStartup: () => Promise<void>;
  fireInstalled: (reason?: string) => Promise<void>;
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

    listeners: [],
    get listenersRegisteredBeforeAnyAwait(): boolean {
      return f.listeners.length > 0 && f.listeners.every((l) => l.beforeAnyAwait);
    },
    intervals: [],
    runtimeId: 'fallowfakeextensionidaaaaaaaaaaa',
    storage: { local: createChromeArea(), session: createChromeArea() },
    broadcasts: [],
    pagesOpen: false,
    messages: [],
    discardEventTiming: 'none',
    pending: new Set(),

    fire(event, ...args) {
      const results: Array<Promise<unknown>> = [];
      for (const l of f.listeners.filter((x) => x.event === event)) {
        const p = Promise.resolve(l.fn(...args));
        f.pending.add(p);
        const done = () => { f.pending.delete(p); };
        p.then(done, done);
        results.push(p);
      }
      return Promise.all(results);
    },
    async idle() {
      // A handler can start another (an event fired from inside a discard), so loop until
      // nothing is left, then let any trailing microtasks run.
      for (let i = 0; i < 100 && f.pending.size > 0; i++) {
        await Promise.allSettled([...f.pending]);
      }
      await new Promise((r) => setTimeout(r, 0));
    },
    sendMessage(message, sender) {
      // Chrome's contract: a listener that wants to answer later must return literally true;
      // otherwise the channel closes once the listener returns and the sender gets undefined.
      return new Promise((resolve) => {
        const record: FakeMessageRecord = { message, returned: undefined, closedWithoutResponse: false };
        f.messages.push(record);
        let open = true;
        let answered = false;
        const sendResponse = (response: unknown) => {
          if (!open || answered) return;
          answered = true;
          resolve(response);
        };
        const ls = f.listeners.filter((x) => x.event === 'runtime.onMessage');
        let keepOpen = false;
        for (const l of ls) {
          const returned = l.fn(message, sender, sendResponse);
          record.returned = returned;
          if (returned === true) keepOpen = true;
        }
        if (!keepOpen && !answered) {
          open = false;
          record.closedWithoutResponse = true;
          resolve(undefined);
        }
      });
    },

    async activate(tabId) {
      f.setActive(tabId);
      const t = find(tabId)!;
      await f.fire('tabs.onActivated', { tabId, windowId: t.windowId });
    },
    async createTab(tab) {
      f.tabs.push(tab);
      await f.fire('tabs.onCreated', { ...tab });
    },
    async closeTab(tabId, isWindowClosing = false) {
      const t = find(tabId);
      f.removeTab(tabId);
      await f.fire('tabs.onRemoved', tabId, { windowId: t?.windowId ?? -1, isWindowClosing });
    },
    async updateTab(tabId, changeInfo) {
      const t = find(tabId);
      if (!t) throw new Error(`updateTab: no tab with id ${tabId}`);
      Object.assign(t, changeInfo);
      await f.fire('tabs.onUpdated', tabId, { ...changeInfo }, { ...t });
    },
    async discardExternally(tabId, newTabId) {
      const t = find(tabId);
      if (!t) throw new Error(`discardExternally: no tab with id ${tabId}`);
      const id = newTabId ?? f.nextId++;
      const replacement: FakeTab = { ...t, id, discarded: true, status: 'unloaded' };
      f.tabs.splice(f.tabs.indexOf(t), 1, replacement);
      await fireDiscardEvents(id, tabId, replacement);
      return id;
    },
    async moveTab(tabId, newWindowId, newPosition) {
      const t = find(tabId);
      if (!t) throw new Error(`moveTab: no tab with id ${tabId}`);
      const oldWindowId = t.windowId;
      const oldPosition = t.index;
      await f.fire('tabs.onDetached', tabId, { oldWindowId, oldPosition });
      t.windowId = newWindowId;
      t.index = newPosition;
      await f.fire('tabs.onAttached', tabId, { newWindowId, newPosition });
    },
    async closeWindow(windowId) {
      for (const t of f.tabs.filter((x) => x.windowId === windowId)) await f.closeTab(t.id!, true);
      const i = f.windows.findIndex((w) => w.id === windowId);
      if (i >= 0) f.windows.splice(i, 1);
      await f.fire('windows.onRemoved', windowId);
    },
    async focusWindow(windowId) {
      for (const w of f.windows) w.focused = w.id === windowId;
      await f.fire('windows.onFocusChanged', windowId);
    },
    async updateGroup(group) {
      await f.fire('tabGroups.onUpdated', { ...group });
    },
    async removeGroup(group) {
      await f.fire('tabGroups.onRemoved', { ...group });
    },
    async fireAlarm(name) {
      const a = f.alarms.get(name);
      await f.fire('alarms.onAlarm', { name, scheduledTime: Date.now(), periodInMinutes: a?.periodInMinutes });
    },
    async fireStartup() {
      await f.fire('runtime.onStartup');
    },
    async fireInstalled(reason = 'install') {
      await f.fire('runtime.onInstalled', { reason });
    },
  };

  // Chrome's order on a discard: the tab is renamed (onReplaced), then the renamed tab
  // reports its new state (onUpdated with discarded: true).
  async function fireDiscardEvents(addedTabId: number, removedTabId: number, tab: FakeTab): Promise<void> {
    await Promise.all([
      f.fire('tabs.onReplaced', addedTabId, removedTabId),
      f.fire('tabs.onUpdated', addedTabId, { discarded: true }, { ...tab }),
    ]);
  }

  // Set when the module under test first reads the global `chrome`; see installChromeGlobal.
  let chromeTouched = false;
  let firstTurnOver = false;
  const touch = () => {
    if (chromeTouched) return;
    chromeTouched = true;
    // FIFO microtasks: this runs before the continuation of ANY await the module starts
    // after this point, so a listener added once it has run was added after an await resumed.
    queueMicrotask(() => { firstTurnOver = true; });
  };
  const event = (name: FakeEventName) => ({
    addListener(fn: (...args: unknown[]) => unknown) {
      f.listeners.push({ event: name, fn, beforeAnyAwait: chromeTouched && !firstTurnOver });
    },
    removeListener(fn: (...args: unknown[]) => unknown) {
      const i = f.listeners.findIndex((l) => l.event === name && l.fn === fn);
      if (i >= 0) f.listeners.splice(i, 1);
    },
    hasListener(fn: (...args: unknown[]) => unknown) {
      return f.listeners.some((l) => l.event === name && l.fn === fn);
    },
  });
  touchHooks.set(f, touch);

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
      get id() {
        return f.runtimeId;
      },
      onInstalled: event('runtime.onInstalled'),
      onMessage: event('runtime.onMessage'),
      onStartup: event('runtime.onStartup'),
      sendMessage: wrap('runtime.sendMessage', (message: unknown) => {
        f.broadcasts.push(message);
        if (!f.pagesOpen) throw new Error('Could not establish connection. Receiving end does not exist.');
        return undefined;
      }),
    },
    storage: { local: f.storage.local, session: f.storage.session },
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
          // Chrome delivers the rename and the new state as events, separately from this
          // call's own answer, so either may reach the worker first.
          if (f.discardEventTiming === 'before-resolve') {
            // Dispatched before this call answers, but never awaited: Chrome does not wait
            // for a listener to finish before it answers the extension's own request.
            void fireDiscardEvents(newId, id, replacement);
          } else if (f.discardEventTiming === 'after-resolve') {
            const later = new Promise<void>((r) => setTimeout(r, 0)).then(() => fireDiscardEvents(newId, id, replacement));
            f.pending.add(later);
            later.then(() => f.pending.delete(later), () => f.pending.delete(later));
          }
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
      onActivated: event('tabs.onActivated'),
      onAttached: event('tabs.onAttached'),
      onCreated: event('tabs.onCreated'),
      onDetached: event('tabs.onDetached'),
      onRemoved: event('tabs.onRemoved'),
      onReplaced: event('tabs.onReplaced'),
      onUpdated: event('tabs.onUpdated'),
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
      WINDOW_ID_NONE: -1,
      onFocusChanged: event('windows.onFocusChanged'),
      onRemoved: event('windows.onRemoved'),
    },
    tabGroups: {
      query: wrap('tabGroups.query', () => f.groups),
      onRemoved: event('tabGroups.onRemoved'),
      onUpdated: event('tabGroups.onUpdated'),
    },
    alarms: {
      get: wrap('alarms.get', (name: string) => f.alarms.get(name)),
      create: wrap('alarms.create', (name: string, info: chrome.alarms.AlarmCreateInfo) => {
        f.alarms.set(name, { name, periodInMinutes: info.periodInMinutes });
      }),
      clear: wrap('alarms.clear', (name: string) => f.alarms.delete(name)),
      onAlarm: event('alarms.onAlarm'),
    },
  };
  f.api = api as unknown as typeof chrome;
  return f;
}

// ---- installing the fake as the global `chrome` ------------------------------------------

const touchHooks = new WeakMap<FakeChrome, () => void>();

/**
 * Makes `fake.api` the global `chrome`, for code that reads the global as a real service
 * worker does, and replaces `setInterval` with a recorder so a keepalive interval is
 * mechanically visible in `fake.intervals` and never runs. Returns the uninstaller.
 *
 * How `listenersRegisteredBeforeAnyAwait` is measured, without the module's cooperation:
 * the first read of the global `chrome` queues one microtask that marks the first turn
 * over. Microtasks run first-in first-out, so the continuation of any `await` the module
 * starts after that read (an awaited promise, a resolved value, `await null`) is queued
 * behind the marker and runs after it. A listener added by such a continuation is
 * therefore recorded with beforeAnyAwait false. The module never sees the marker and
 * cannot set it.
 * The one thing this cannot see is an `await` placed before the module's first read of
 * `chrome`; a service-worker module cannot contain a top-level await at all.
 */
export function installChromeGlobal(fake: FakeChrome): () => void {
  const g = globalThis as Record<string, unknown>;
  const hadChrome = Object.prototype.hasOwnProperty.call(g, 'chrome');
  const previousChrome = g.chrome;
  const previousSetInterval = globalThis.setInterval;
  const touch = touchHooks.get(fake)!;
  Object.defineProperty(g, 'chrome', {
    configurable: true,
    get() {
      touch();
      return fake.api;
    },
  });
  globalThis.setInterval = ((fn: unknown, ms?: unknown) => {
    fake.intervals.push({ fn, ms });
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  return () => {
    if (hadChrome) Object.defineProperty(g, 'chrome', { configurable: true, writable: true, value: previousChrome });
    else delete g.chrome;
    globalThis.setInterval = previousSetInterval;
  };
}

function pickKeys(data: Map<string, unknown>, keys: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = keys === null || keys === undefined ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
  for (const k of list) if (data.has(k as string)) out[k as string] = data.get(k as string);
  return out;
}

function createChromeArea(): FakeChromeArea {
  const area: FakeChromeArea = {
    data: new Map(),
    rejectOn: new Map(),
    onBeforeGet: undefined,
    async get(keys) {
      await area.onBeforeGet?.(keys);
      const failure = area.rejectOn.get('get') ?? (typeof keys === 'string' ? area.rejectOn.get(`get:${keys}`) : undefined);
      if (failure) throw failure;
      return pickKeys(area.data, keys);
    },
    async set(items) {
      for (const key of Object.keys(items)) {
        const failure = area.rejectOn.get('set') ?? area.rejectOn.get(`set:${key}`);
        if (failure) throw failure;
      }
      for (const [k, v] of Object.entries(items)) area.data.set(k, v);
    },
    async remove(keys) {
      const failure = area.rejectOn.get('remove');
      if (failure) throw failure;
      for (const k of Array.isArray(keys) ? keys : [keys]) area.data.delete(k);
    },
    async clear() {
      area.data.clear();
    },
  };
  return area;
}
