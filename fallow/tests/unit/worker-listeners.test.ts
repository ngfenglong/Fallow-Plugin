// The service worker's listener wiring: what is registered, when, and what each listener does.
// The worker module reads the global `chrome` exactly as a real service worker does, so each
// test installs the fake globally and imports a FRESH copy of the module.
import { createRepos, createChromeStorageArea, KEYS } from '../../src/platform/storage';
import { createFakeChrome, installChromeGlobal, FAKE_EVENTS, type FakeChrome, type FakeTab } from '../fake-chrome';

const T0 = 1_000_000;

function tab(p: FakeTab & { id: number }): FakeTab {
  return {
    index: p.id, windowId: 10, groupId: -1, url: `https://site${p.id}.test/`, title: `t${p.id}`,
    active: false, audible: false, pinned: false, discarded: false, autoDiscardable: true,
    status: 'complete', ...p,
  };
}

let fake: FakeChrome;
let uninstall: () => void;
let clock: number;

function reposOf(f: FakeChrome) {
  return createRepos({
    local: createChromeStorageArea(f.api.storage.local),
    session: createChromeStorageArea(f.api.storage.session),
  });
}

async function loadWorker() {
  return import('../../src/background/index');
}

beforeEach(() => {
  vi.resetModules();
  clock = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  fake = createFakeChrome([
    tab({ id: 1, windowId: 10, index: 0, active: true }),
    tab({ id: 2, windowId: 10, index: 1 }),
    tab({ id: 3, windowId: 11, index: 0, active: true }),
    tab({ id: 4, windowId: 11, index: 1 }),
  ]);
  fake.windows.push({ id: 10, focused: true }, { id: 11, focused: false });
  uninstall = installChromeGlobal(fake);
});

afterEach(async () => {
  await fake.idle();
  uninstall();
  vi.restoreAllMocks();
});

describe('worker: listener registration', () => {
  it('registers every listener synchronously at module load', async () => {
    await loadWorker();
    expect(fake.listeners.map((l) => l.event).sort()).toEqual([
      'alarms.onAlarm', 'runtime.onInstalled', 'runtime.onMessage', 'runtime.onStartup',
      'tabGroups.onRemoved', 'tabGroups.onUpdated',
      'tabs.onActivated', 'tabs.onAttached', 'tabs.onCreated', 'tabs.onDetached',
      'tabs.onRemoved', 'tabs.onReplaced', 'tabs.onUpdated',
      'windows.onFocusChanged', 'windows.onRemoved',
    ]);
    expect(fake.listenersRegisteredBeforeAnyAwait).toBe(true);
  });

  it('installs no interval or keepalive timer, at load or while handling events', async () => {
    const mod = await loadWorker();
    await mod.initialize();
    // Every event once, so a keepalive started lazily by a handler is caught too.
    await fake.fireStartup();
    await fake.fireInstalled('update');
    await fake.fireAlarm('fallow-eligibility-check');
    await fake.activate(2);
    await fake.createTab(tab({ id: 9, windowId: 10, index: 2 }));
    await fake.updateTab(9, { title: 'x' });
    await fake.moveTab(9, 11, 2);
    await fake.closeTab(9);
    await fake.focusWindow(11);
    await fake.updateGroup({ id: 5, windowId: 10 });
    await fake.removeGroup({ id: 5, windowId: 10 });
    await fake.discardExternally(4);
    await fake.sendMessage({ type: 'GET_HISTORY', requestId: 'r' }, { id: fake.runtimeId, url: `chrome-extension://${fake.runtimeId}/dashboard/index.html` });
    await fake.closeWindow(11);
    await fake.idle();
    expect(fake.intervals).toHaveLength(0);
  });
});

const trusted = () => ({ id: fake.runtimeId, url: `chrome-extension://${fake.runtimeId}/dashboard/index.html` });

describe('worker: one clock', () => {                                                        // carry-forward 6
  it('feeds the executor and the scheduler from the same clock', async () => {
    const mod = await loadWorker();
    await mod.initialize();
    await fake.idle();
    // The injected clock is ten hours past Date.now(). By it, the grace is long over and
    // tabs 2 and 4 are long overdue; by Date.now() the grace is still running and they were
    // discovered this instant. A worker whose executor read any other clock than the one
    // the scheduler is handed would plan the batch and then skip every tab.
    const injected = T0 + 10 * 60 * 60_000;
    const r = reposOf(fake);
    await r.settings.write({ ...(await r.settings.read()), automationEnabled: true });
    await r.session.write({ discoveredAt: T0, graceUntil: T0 + 60 * 60_000 });
    await r.activity.writeAll({
      1: { tabId: 1, backgroundSince: null, protectedForSession: false },
      2: { tabId: 2, backgroundSince: T0, protectedForSession: false },
      3: { tabId: 3, backgroundSince: null, protectedForSession: false },
      4: { tabId: 4, backgroundSince: T0, protectedForSession: false },
    });
    const w = mod.createWorker({ api: fake.api, now: () => injected, sleep: async () => undefined });
    await w.initialize();
    await (w.listeners.alarm as (a: unknown) => Promise<void>)({ name: 'fallow-eligibility-check', scheduledTime: injected });
    expect(fake.calls.discard).toBe(2);
    const rows = await r.history.read();
    expect(rows.filter((h) => h.trigger === 'automatic' && h.outcome === 'confirmed')).toHaveLength(2);
    expect(rows.every((h) => h.at === injected)).toBe(true);
  });
});

describe('worker: containment', () => {
  it('lets no failure escape any listener, whatever breaks and whatever the payload', async () => {
    const mod = await loadWorker();
    await mod.initialize();
    await fake.idle();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      // Everything the worker could touch now fails.
      const broken = new Error('broken');
      for (const area of [fake.storage.local, fake.storage.session]) {
        area.rejectOn.set('get', broken);
        area.rejectOn.set('set', broken);
        area.rejectOn.set('remove', broken);
      }
      for (const name of ['tabs.query', 'tabs.get', 'tabs.discard', 'windows.getAll', 'tabGroups.query', 'alarms.get', 'alarms.create', 'alarms.clear', 'runtime.sendMessage']) {
        fake.throwOn.set(name, broken);
      }
      const payloads: unknown[][] = [
        [], [undefined, undefined, undefined], [null, null, null], [{}, {}, {}],
        [{ name: 'fallow-eligibility-check' }], [2, { discarded: true }, { id: 2, url: 'https://x.test/' }],
        [{ tabId: 2, windowId: 10 }], [2, { newWindowId: 11, oldWindowId: 10 }], [1002, 2],
      ];
      for (const l of fake.listeners) {
        for (const args of payloads) {
          if (l.event === 'runtime.onMessage') {
            let answer: unknown = 'none';
            const returned = l.fn(args[0], args[1] ?? {}, (r: unknown) => { answer = r; });
            expect(returned, l.event).toBe(true);
            await fake.idle();
            expect(answer, `${l.event} ${JSON.stringify(args)}`).toMatchObject({ ok: false });
          } else {
            await expect(Promise.resolve(l.fn(...args)), `${l.event} ${JSON.stringify(args)}`).resolves.toBeUndefined();
          }
        }
      }
      await fake.idle();
      await new Promise((r) => setTimeout(r, 300));
      expect(unhandled).toEqual([]);
      expect(console.error).toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('worker: telling open pages that state changed', () => {
  const changed = () => fake.broadcasts.filter((m) => (m as { type?: string })?.type === 'FALLOW_STATE_CHANGED');
  async function settleBroadcasts() {
    await fake.idle();
    await new Promise((r) => setTimeout(r, 300)); // past the coalescing window
  }

  it('sends one coalesced notice for a burst of tab events', async () => {
    fake.pagesOpen = true;
    const mod = await loadWorker();
    await mod.initialize();
    await settleBroadcasts();
    fake.broadcasts.length = 0;
    await fake.activate(2);
    await fake.updateTab(2, { title: 'a' });
    await fake.updateTab(2, { title: 'b' });
    await fake.closeTab(4);
    await settleBroadcasts();
    expect(changed()).toHaveLength(1);
  });

  it.each([
    ['a group changing', () => fake.updateGroup({ id: 5, windowId: 10, title: 'g', collapsed: true })],
    ['a group being removed', () => fake.removeGroup({ id: 5, windowId: 10 })],
    ['window focus moving', () => fake.focusWindow(11)],
  ])('sends a notice for %s, which changes what the dashboard shows and nothing else', async (_label, act) => {
    fake.pagesOpen = true;
    const mod = await loadWorker();
    await mod.initialize();
    await settleBroadcasts();
    fake.broadcasts.length = 0;
    const activityBefore = structuredClone(fake.storage.session.data.get(KEYS.activity));
    await act();
    await settleBroadcasts();
    expect(changed()).toHaveLength(1);
    expect(fake.storage.session.data.get(KEYS.activity)).toEqual(activityBefore);
  });

  it('never sends a notice in answer to a read-only request, so a page refreshing on it cannot loop', async () => {
    fake.pagesOpen = true;
    const mod = await loadWorker();
    await mod.initialize();
    await settleBroadcasts();
    fake.broadcasts.length = 0;
    for (const message of [
      { type: 'GET_SNAPSHOT', requestId: 'a' },
      { type: 'GET_HISTORY', requestId: 'b' },
      { type: 'UNLOAD_PREVIEW', requestId: 'c', scope: { kind: 'all' }, mode: 'manual-bulk' },
    ]) {
      expect(await fake.sendMessage(message, trusted())).toMatchObject({ ok: true });
    }
    await settleBroadcasts();
    expect(changed()).toHaveLength(0);
  });

  it('contains the rejection Chrome gives when no page is open to hear it', async () => {
    fake.pagesOpen = false;
    const mod = await loadWorker();
    await mod.initialize();
    await fake.activate(2);
    await settleBroadcasts();
    // The notice was attempted and refused; nothing escaped (vitest fails a run on an
    // unhandled rejection).
    expect(changed().length).toBeGreaterThan(0);
  });
});

describe('worker: runtime.onMessage', () => {
  it('returns true so Chrome keeps the channel open, then answers with the request id', async () => {
    await loadWorker();
    const res = await fake.sendMessage({ type: 'GET_HISTORY', requestId: 'req-1' }, trusted());
    expect(fake.messages[0]!.returned).toBe(true);
    expect(fake.messages[0]!.closedWithoutResponse).toBe(false);
    expect(res).toEqual({ ok: true, requestId: 'req-1', data: [] });
  });

  it.each([
    ['another extension', { id: 'other', url: 'https://evil.test/' }],
    ['this id but a web page url (a content script)', { id: 'fallowfakeextensionidaaaaaaaaaaa', url: 'https://evil.test/' }],
    ['no sender fields at all', {}],
  ])('refuses %s before reading or acting on anything', async (_label, sender) => {
    await loadWorker();
    await fake.idle();
    let storageReads = 0;
    fake.storage.local.onBeforeGet = () => { storageReads++; };
    fake.storage.session.onBeforeGet = () => { storageReads++; };
    const before = { ...fake.counts };
    const res = await fake.sendMessage({ type: 'GET_HISTORY', requestId: 'req-2' }, sender);
    expect(res).toMatchObject({ ok: false });
    // The refusal is answered without touching tabs or storage on the sender's behalf.
    expect(fake.counts).toEqual(before);
    expect(storageReads).toBe(0);
    expect(fake.messages[0]!.returned).toBe(true);
  });

  it('answers a refused message with its own request id when one can be read safely', async () => {
    await loadWorker();
    // An unknown key: parseRequest refuses it, and gives no reason and no id back.
    const res = await fake.sendMessage({ type: 'GET_HISTORY', requestId: 'abc', eligible: true }, trusted());
    expect(res).toEqual({ ok: false, requestId: 'abc', error: expect.any(String) });
  });

  it.each([
    ['no request id', { type: 'GET_HISTORY' }],
    ['a non-string id', { type: 'GET_HISTORY', requestId: 42 }],
    ['an over-long id', { type: 'GET_HISTORY', requestId: 'x'.repeat(129) }],
    ['an inherited id', Object.create({ requestId: 'inherited' })],
    ['an id behind a throwing getter', Object.defineProperty({ type: 'X' }, 'requestId', { get() { throw new Error('boom'); }, enumerable: true })],
    ['a string message', 'GET_HISTORY'],
    ['null', null],
  ])('answers a refused message carrying %s with an empty request id, never hanging', async (_label, message) => {
    await loadWorker();
    const res = await fake.sendMessage(message, trusted());
    expect(res).toEqual({ ok: false, requestId: '', error: expect.any(String) });
  });
});
