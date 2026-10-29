import { beforeEach, describe, expect, it } from 'vitest';
import { createChromeStorageArea, createRepos, KEYS, type HistoryEntry } from '../../src/platform/storage';
import { DEFAULT_SETTINGS, parseSettings } from '../../src/domain/settings';
import { HISTORY_MAX_AGE_MS, HISTORY_MAX_ENTRIES, THRESHOLD_MIN } from '../../src/domain/constants';
import { createFakeStorage, type FakeStorage } from '../fake-storage';

let fake: FakeStorage;
let repos: ReturnType<typeof createRepos>;

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    at: 1,
    operationId: 'op-1',
    trigger: 'automatic',
    sessionTabId: 7,
    hostname: 'example.com',
    outcome: 'confirmed',
    ...overrides,
  };
}

// Every non-object raw value a corrupt store could hold.
const NON_OBJECT_VALUES: Array<[string, unknown]> = [
  ['a string', 'not an object'],
  ['a number', 42],
  ['null', null],
  ['an array', [1, 2, 3]],
  ['undefined', undefined],
];

// An object whose every property read throws.
function throwingGetterObject(): Record<string, unknown> {
  const hostile: Record<string, unknown> = {};
  for (const key of ['at', 'operationId', 'tabId', 'automationEnabled', 'backgroundSince', 'discoveredAt', 'trigger']) {
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() {
        throw new Error(`hostile getter: ${key}`);
      },
    });
  }
  return hostile;
}

beforeEach(() => {
  fake = createFakeStorage();
  repos = createRepos({ local: fake.local, session: fake.session });
});

describe('SettingsRepo', () => {
  it('returns defaults when stored settings are unreadable', async () => {
    fake.local.set(KEYS.settings, '{{{not json');
    await expect(repos.settings.read()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when nothing was ever written', async () => {
    await expect(repos.settings.read()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('normalises and clamps hostile raw settings before returning them', async () => {
    fake.local.set(KEYS.settings, {
      schemaVersion: 1,
      automationEnabled: true,
      inactivityMinutes: 0,
      protectPinned: true,
      protectedSites: [{ hostname: 'Example.com.', includeSubdomains: false }],
      deviceMemoryMonitoringEnabled: false,
    });
    const s = await repos.settings.read();
    expect(s.protectedSites).toEqual([{ hostname: 'example.com', includeSubdomains: false }]);
    // parseSettings rejects an out-of-range threshold to the default rather than
    // clamping it, so the value that reaches decide() is always a legal one.
    expect(s.inactivityMinutes).toBe(DEFAULT_SETTINGS.inactivityMinutes);
    expect(s.inactivityMinutes).toBeGreaterThanOrEqual(THRESHOLD_MIN);
  });

  it('returns exactly what parseSettings produces from the raw stored value', async () => {
    const raw = { automationEnabled: 'yes', inactivityMinutes: 30, protectedSites: [{ hostname: ' A.Test. ' }] };
    fake.local.set(KEYS.settings, raw);
    await expect(repos.settings.read()).resolves.toEqual(parseSettings(raw));
  });

  it.each(NON_OBJECT_VALUES)('resolves to defaults for %s', async (_label, value) => {
    fake.local.set(KEYS.settings, value);
    await expect(repos.settings.read()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('resolves without throwing for an object whose getters throw', async () => {
    fake.local.set(KEYS.settings, throwingGetterObject());
    await expect(repos.settings.read()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid fields beside a getter that throws', async () => {
    const hostile = throwingGetterObject();
    Object.defineProperty(hostile, 'inactivityMinutes', { enumerable: true, value: 30 });
    fake.local.set(KEYS.settings, hostile);
    const s = await repos.settings.read();
    expect(s.inactivityMinutes).toBe(30);
    expect(s.automationEnabled).toBe(DEFAULT_SETTINGS.automationEnabled);
  });

  it('ignores a __proto__ key without polluting the prototype', async () => {
    fake.local.set(KEYS.settings, JSON.parse('{"__proto__": {"polluted": true}, "inactivityMinutes": 5}'));
    const s = await repos.settings.read();
    expect(s.inactivityMinutes).toBe(5);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('resolves to defaults when the storage get throws or rejects', async () => {
    fake.local.throwOn.set(KEYS.settings, new Error('boom'));
    await expect(repos.settings.read()).resolves.toEqual(DEFAULT_SETTINGS);
    fake.local.throwOn.clear();
    fake.local.rejectOn.set(KEYS.settings, new Error('boom'));
    await expect(repos.settings.read()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('exposes no read method other than the parsing one', () => {
    expect(Object.keys(repos.settings).sort()).toEqual(['read', 'write']);
  });

  it('round-trips a written value', async () => {
    const next = { ...DEFAULT_SETTINGS, automationEnabled: true, inactivityMinutes: 45 };
    await repos.settings.write(next);
    await expect(repos.settings.read()).resolves.toEqual(next);
  });

  it('never hands back the deep-frozen defaults, so callers cannot mutate them', async () => {
    const s = await repos.settings.read();
    expect(Object.isFrozen(s)).toBe(false);
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    s.protectedSites.push({ hostname: 'x.test', includeSubdomains: false });
    expect(DEFAULT_SETTINGS.protectedSites).toHaveLength(3);
  });
});

describe('ActivityRepo', () => {
  it('returns an empty activity map rather than throwing on a corrupt value', async () => {
    fake.session.set(KEYS.activity, 42);
    await expect(repos.activity.readAll()).resolves.toEqual({});
  });

  it('returns an empty map for a key that was never written', async () => {
    await expect(repos.activity.readAll()).resolves.toEqual({});
  });

  it.each(NON_OBJECT_VALUES)('returns an empty map for %s', async (_label, value) => {
    fake.session.set(KEYS.activity, value);
    await expect(repos.activity.readAll()).resolves.toEqual({});
  });

  it('drops individual activity records of the wrong shape', async () => {
    fake.session.set(KEYS.activity, { 1: { tabId: 1, backgroundSince: 5, protectedForSession: false }, 2: 'bad' });
    expect(Object.keys(await repos.activity.readAll())).toEqual(['1']);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '5'],
  ])('drops a record whose backgroundSince is %s', async (_label, backgroundSince) => {
    fake.session.set(KEYS.activity, {
      1: { tabId: 1, backgroundSince, protectedForSession: false },
      2: { tabId: 2, backgroundSince: null, protectedForSession: false },
    });
    expect(Object.keys(await repos.activity.readAll())).toEqual(['2']);
  });

  it('drops a record whose key and tabId disagree or whose flag is not boolean', async () => {
    fake.session.set(KEYS.activity, {
      1: { tabId: 9, backgroundSince: null, protectedForSession: false },
      2: { tabId: 2, backgroundSince: null, protectedForSession: 'yes' },
      3: { tabId: 3, backgroundSince: null, protectedForSession: false },
    });
    expect(Object.keys(await repos.activity.readAll())).toEqual(['3']);
  });

  it('skips a record whose getters throw without losing the others', async () => {
    fake.session.set(KEYS.activity, {
      1: throwingGetterObject(),
      2: { tabId: 2, backgroundSince: 10, protectedForSession: true },
    });
    await expect(repos.activity.readAll()).resolves.toEqual({
      2: { tabId: 2, backgroundSince: 10, protectedForSession: true },
    });
  });

  it('ignores a __proto__ key without polluting the prototype', async () => {
    fake.session.set(KEYS.activity, JSON.parse('{"__proto__": {"tabId": 0, "backgroundSince": null, "protectedForSession": false}, "4": {"tabId": 4, "backgroundSince": null, "protectedForSession": false}}'));
    const map = await repos.activity.readAll();
    expect(Object.keys(map)).toEqual(['4']);
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
  });

  it('round-trips a map through writeAll and readAll', async () => {
    const map = { 3: { tabId: 3, backgroundSince: 100, protectedForSession: false } };
    await repos.activity.writeAll(map);
    await expect(repos.activity.readAll()).resolves.toEqual(map);
  });

  it('rejects when the storage get throws, so a failed read is not mistaken for no records', async () => {
    fake.session.throwOn.set(KEYS.activity, new Error('boom'));
    await expect(repos.activity.readAll()).rejects.toThrow('boom');
  });

  it('rejects when the storage get rejects', async () => {
    fake.session.rejectOn.set(`get:${KEYS.activity}`, new Error('unavailable'));
    await expect(repos.activity.readAll()).rejects.toThrow('unavailable');
  });
});

describe('SessionRepo', () => {
  it('returns null for an absent record', async () => {
    await expect(repos.session.read()).resolves.toBeNull();
  });

  it.each(NON_OBJECT_VALUES)('returns null for %s', async (_label, value) => {
    fake.session.set(KEYS.session, value);
    await expect(repos.session.read()).resolves.toBeNull();
  });

  it('returns null for a partial or ill-typed record rather than a partial object', async () => {
    fake.session.set(KEYS.session, { discoveredAt: 5 });
    await expect(repos.session.read()).resolves.toBeNull();
    fake.session.set(KEYS.session, { discoveredAt: 'soon', graceUntil: null });
    await expect(repos.session.read()).resolves.toBeNull();
    fake.session.set(KEYS.session, { discoveredAt: 5, graceUntil: Number.NaN });
    await expect(repos.session.read()).resolves.toBeNull();
  });

  it('returns null for a record whose getters throw', async () => {
    fake.session.set(KEYS.session, throwingGetterObject());
    await expect(repos.session.read()).resolves.toBeNull();
  });

  it('round-trips a record with and without a grace deadline', async () => {
    await repos.session.write({ discoveredAt: 5, graceUntil: null });
    await expect(repos.session.read()).resolves.toEqual({ discoveredAt: 5, graceUntil: null });
    await repos.session.write({ discoveredAt: 5, graceUntil: 125_000 });
    await expect(repos.session.read()).resolves.toEqual({ discoveredAt: 5, graceUntil: 125_000 });
  });
});

describe('HistoryRepo', () => {
  it('keeps only the newest 500 history entries', async () => {
    await repos.history.append(Array.from({ length: 600 }, (_, i) => entry({ at: i })), 600);
    const rows = await repos.history.read();
    expect(rows).toHaveLength(500);
    expect(rows[0]!.at).toBeGreaterThan(rows[rows.length - 1]!.at);  // newest first
    expect(rows[rows.length - 1]!.at).toBe(100);
  });

  it('drops history entries older than seven days', async () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    await repos.history.append([entry({ at: now - HISTORY_MAX_AGE_MS - 1 }), entry({ at: now - 1000 })], now);
    expect(await repos.history.read()).toHaveLength(1);
  });

  it('applies the age cut before the count cap, whatever the input order', async () => {
    // Stale rows come first in the input. Count-before-age would fill the cap with
    // stale rows and leave only 100 fresh ones; age-before-count keeps all 200.
    const now = 10 * 24 * 60 * 60 * 1000;
    const stale = Array.from({ length: 400 }, (_, i) => entry({ at: now - HISTORY_MAX_AGE_MS - 1 - i }));
    const fresh = Array.from({ length: 200 }, (_, i) => entry({ at: now - 1000 - i }));
    await repos.history.append([...stale, ...fresh], now);
    const rows = await repos.history.read();
    expect(rows).toHaveLength(200);
    expect(rows.every((r) => r.at >= now - HISTORY_MAX_AGE_MS)).toBe(true);
  });

  it('never stores a page title or a full url', async () => {
    await repos.history.append([{ ...entry({ hostname: 'example.com' }), url: 'https://private.example/x' } as HistoryEntry], 1);
    const raw = JSON.stringify(await fake.local.get(KEYS.history));
    expect(raw).not.toMatch(/https?:\/\//);
    expect(Object.keys((await repos.history.read())[0]!).sort())
      .toEqual(['at','hostname','operationId','outcome','sessionTabId','trigger']);
  });

  it('strips a smuggled title or url from the blob that is persisted', async () => {
    const smuggled = { ...entry(), title: 'Quarterly Payroll Secret', url: 'https://bank.example/login?token=abc' };
    await repos.history.append([smuggled as HistoryEntry], 1);
    const raw = JSON.stringify(await fake.local.get(KEYS.history));
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toContain('Quarterly Payroll Secret');
    expect(raw).not.toContain('token=abc');
  });

  it('stores a row with a reason under the same key set, and omits reason when absent', async () => {
    await repos.history.append([entry({ at: 1, reason: 'NOT_OLD_ENOUGH' }), entry({ at: 2 })], 3);
    const [without, withReason] = await repos.history.read();
    expect(withReason!.reason).toBe('NOT_OLD_ENOUGH');
    expect(Object.keys(without!)).not.toContain('reason');
    expect(Object.keys(withReason!).sort()).toEqual(['at','hostname','operationId','outcome','reason','sessionTabId','trigger']);
  });

  it('batches an append into a single write', async () => {
    fake.local.writes = 0;
    await repos.history.append([entry(), entry(), entry()], 1);
    expect(fake.local.writes).toBe(1);
  });

  it('does not write at all for an empty append', async () => {
    fake.local.writes = 0;
    await repos.history.append([], 1);
    expect(fake.local.writes).toBe(0);
    await expect(repos.history.read()).resolves.toEqual([]);
  });

  it('applies only the count cap when now is non-finite, and does not throw', async () => {
    await repos.history.append([entry({ at: 5 })], 6);
    await expect(repos.history.append([entry({ at: 1 })], Number.NaN)).resolves.toBeUndefined();
    expect((await repos.history.read()).map((r) => r.at)).toEqual([5, 1]);
    const many = Array.from({ length: 600 }, (_, i) => entry({ at: i }));
    await expect(repos.history.append(many, Number.NaN)).resolves.toBeUndefined();
    expect(await repos.history.read()).toHaveLength(HISTORY_MAX_ENTRIES);
  });

  it('resolves and leaves existing history intact when the read fails', async () => {
    await repos.history.append([entry({ at: 1 })], 2);
    fake.local.writes = 0;
    fake.local.throwOn.set(`get:${KEYS.history}`, new Error('read failed'));
    await expect(repos.history.append([entry({ at: 3 })], 4)).resolves.toBeUndefined();
    expect(fake.local.writes).toBe(0);
    fake.local.throwOn.clear();
    expect((await repos.history.read()).map((r) => r.at)).toEqual([1]);
  });

  it('resolves for a rejected read without writing', async () => {
    await repos.history.append([entry({ at: 1 })], 2);
    fake.local.writes = 0;
    fake.local.rejectOn.set(`get:${KEYS.history}`, new Error('read failed'));
    await expect(repos.history.append([entry({ at: 3 })], 4)).resolves.toBeUndefined();
    expect(fake.local.writes).toBe(0);
    fake.local.rejectOn.clear();
    expect((await repos.history.read()).map((r) => r.at)).toEqual([1]);
  });

  it('resolves and leaves existing history intact when the write fails', async () => {
    await repos.history.append([entry({ at: 1 })], 2);
    fake.local.throwOn.set(`set:${KEYS.history}`, new Error('write failed'));
    await expect(repos.history.append([entry({ at: 3 })], 4)).resolves.toBeUndefined();
    fake.local.throwOn.clear();
    expect((await repos.history.read()).map((r) => r.at)).toEqual([1]);
  });

  it('resolves for a rejected write and leaves existing history intact', async () => {
    await repos.history.append([entry({ at: 1 })], 2);
    fake.local.rejectOn.set(`set:${KEYS.history}`, new Error('write failed'));
    await expect(repos.history.append([entry({ at: 3 })], 4)).resolves.toBeUndefined();
    fake.local.rejectOn.clear();
    expect((await repos.history.read()).map((r) => r.at)).toEqual([1]);
  });

  it('clear resolves and leaves history intact when the write fails', async () => {
    await repos.history.append([entry({ at: 1 })], 2);
    fake.local.throwOn.set(`set:${KEYS.history}`, new Error('write failed'));
    await expect(repos.history.clear()).resolves.toBeUndefined();
    fake.local.throwOn.clear();
    expect((await repos.history.read()).map((r) => r.at)).toEqual([1]);
  });

  it('keeps entries across two sequential appends', async () => {
    await repos.history.append([entry({ at: 1 }), entry({ at: 2 })], 3);
    await repos.history.append([entry({ at: 3 }), entry({ at: 4 }), entry({ at: 5 })], 6);
    const rows = await repos.history.read();
    expect(rows.map((r) => r.at)).toEqual([5, 4, 3, 2, 1]);
  });

  it('clear() leaves a readable empty history rather than an absent key', async () => {
    await repos.history.append([entry()], 1);
    await repos.history.clear();
    expect(fake.local.data.has(KEYS.history)).toBe(true);
    await expect(repos.history.read()).resolves.toEqual([]);
  });

  it('returns an empty array for a key that was never written', async () => {
    await expect(repos.history.read()).resolves.toEqual([]);
  });

  it.each(NON_OBJECT_VALUES)('reads %s as an empty history and recovers on append', async (_label, value) => {
    fake.local.set(KEYS.history, value);
    await expect(repos.history.read()).resolves.toEqual([]);
    await repos.history.append([entry({ at: 1 })], 2);
    await expect(repos.history.read()).resolves.toHaveLength(1);
  });

  it('drops individual rows that are the wrong shape and keeps the valid ones', async () => {
    fake.local.set(KEYS.history, [
      entry({ at: 9 }),
      { ...entry({ at: 8 }), trigger: 'bogus' },
      { ...entry({ at: 7 }), operationId: 42 },
      { ...entry({ at: 6 }), outcome: 'maybe' },
      { ...entry({ at: 5 }), reason: 'NOT_A_CODE' },
      'a string row',
      null,
    ]);
    expect((await repos.history.read()).map((r) => r.at)).toEqual([9]);
  });

  it('skips a row whose getters throw without losing the others', async () => {
    fake.local.set(KEYS.history, [entry({ at: 9 }), throwingGetterObject(), entry({ at: 8 })]);
    expect((await repos.history.read()).map((r) => r.at)).toEqual([9, 8]);
  });

  it('resolves to an empty history when the storage get throws', async () => {
    fake.local.throwOn.set(KEYS.history, new Error('boom'));
    await expect(repos.history.read()).resolves.toEqual([]);
  });
});

describe('createChromeStorageArea', () => {
  type Calls = { gets: string[]; sets: Array<Record<string, unknown>> };
  function fakeChromeArea(store: Record<string, unknown>) {
    const calls: Calls = { gets: [], sets: [] };
    const area = {
      get: async (key: string) => {
        calls.gets.push(key);
        if (store.__failGet) throw new Error('chrome get failed');
        return key in store ? { [key]: store[key] } : {};
      },
      set: async (items: Record<string, unknown>) => {
        calls.sets.push(items);
        if (store.__failSet) throw new Error('chrome set failed');
        Object.assign(store, items);
      },
    };
    return { area: area as unknown as chrome.storage.StorageArea, calls };
  }

  it('get returns the value at the key, and undefined when absent', async () => {
    const { area, calls } = fakeChromeArea({ [KEYS.activity]: { 1: 'x' } });
    const storage = createChromeStorageArea(area);
    await expect(storage.get(KEYS.activity)).resolves.toEqual({ 1: 'x' });
    await expect(storage.get('fallow.missing')).resolves.toBeUndefined();
    expect(calls.gets).toEqual([KEYS.activity, 'fallow.missing']);
  });

  it('set writes the value under its key', async () => {
    const store: Record<string, unknown> = {};
    const { area, calls } = fakeChromeArea(store);
    await createChromeStorageArea(area).set(KEYS.history, [1]);
    expect(calls.sets).toEqual([{ [KEYS.history]: [1] }]);
    expect(store[KEYS.history]).toEqual([1]);
  });

  it('get rejects when Chrome cannot read, so an append cannot mistake that for an empty log', async () => {
    const { area } = fakeChromeArea({ __failGet: true });
    await expect(createChromeStorageArea(area).get(KEYS.history)).rejects.toThrow('chrome get failed');
  });

  it('set rejects when Chrome rejects the write, so a refused settings write is never reported as saved', async () => {
    const { area } = fakeChromeArea({ __failSet: true });
    await expect(createChromeStorageArea(area).set(KEYS.history, [])).rejects.toThrow('chrome set failed');
  });

  it('set rejects when the area throws synchronously', async () => {
    const throwing = { get: async () => ({}), set: () => { throw new Error('sync'); } };
    const storage = createChromeStorageArea(throwing as unknown as chrome.storage.StorageArea);
    await expect(storage.set(KEYS.history, [])).rejects.toThrow('sync');
  });
});

describe('write failure policy', () => {
  // A chrome-backed repository set whose Chrome writes can be refused on demand.
  function chromeBackedRepos() {
    const store: Record<string, unknown> = {};
    const flags = { failSet: false };
    const area = {
      get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
      set: async (items: Record<string, unknown>) => {
        if (flags.failSet) throw new Error('chrome set refused');
        Object.assign(store, items);
      },
    } as unknown as chrome.storage.StorageArea;
    const bridge = createChromeStorageArea(area);
    return { store, flags, repos: createRepos({ local: bridge, session: bridge }) };
  }

  it('settings.write rejects when Chrome refuses the write', async () => {
    const { flags, repos } = chromeBackedRepos();
    flags.failSet = true;
    await expect(repos.settings.write({ ...DEFAULT_SETTINGS, inactivityMinutes: 30 })).rejects.toThrow('chrome set refused');
  });

  it('settings.write resolves and stores the value when Chrome accepts it', async () => {
    const { repos } = chromeBackedRepos();
    await expect(repos.settings.write({ ...DEFAULT_SETTINGS, inactivityMinutes: 30 })).resolves.toBeUndefined();
    await expect(repos.settings.read()).resolves.toMatchObject({ inactivityMinutes: 30 });
  });

  it('history.append resolves and keeps prior rows when Chrome refuses the write', async () => {
    const { flags, repos } = chromeBackedRepos();
    await repos.history.append([entry({ at: 1 })], 2);
    flags.failSet = true;
    await expect(repos.history.append([entry({ at: 3 })], 4)).resolves.toBeUndefined();
    flags.failSet = false;
    expect((await repos.history.read()).map((r) => r.at)).toEqual([1]);
  });

  it('history.clear resolves when Chrome refuses the write', async () => {
    const { flags, repos } = chromeBackedRepos();
    flags.failSet = true;
    await expect(repos.history.clear()).resolves.toBeUndefined();
  });

  it('activity.writeAll rejects when the session write is refused', async () => {
    fake.session.rejectOn.set(`set:${KEYS.activity}`, new Error('quota exceeded'));
    await expect(repos.activity.writeAll({ 1: { tabId: 1, backgroundSince: null, protectedForSession: false } }))
      .rejects.toThrow('quota exceeded');
  });

  it('session.write rejects when the session write is refused', async () => {
    fake.session.throwOn.set(`set:${KEYS.session}`, new Error('quota exceeded'));
    await expect(repos.session.write({ discoveredAt: 1, graceUntil: null })).rejects.toThrow('quota exceeded');
  });
});

describe('boundary, validation, ordering and concurrency', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // A proxy that revokes itself the moment it is read as a thenable. Promise.resolve in
  // the fake reads `then` first, so a plain pre-revoked proxy would fail inside get() and
  // never reach the parser. This one passes the promise step and is revoked by the time
  // the parser calls Array.isArray on it, so it exercises the parse path itself.
  const revokedProxy = (): object => {
    const handle: { proxy: object; revoke: () => void } = Proxy.revocable({}, {
      get: (_target, key) => {
        if (key === 'then') handle.revoke();
        return undefined;
      },
    });
    return handle.proxy;
  };

  it('keeps a row at exactly the age cutoff and drops one a millisecond older', async () => {
    const now = 10 * DAY;
    await repos.history.append([
      entry({ at: now - HISTORY_MAX_AGE_MS }),
      entry({ at: now - HISTORY_MAX_AGE_MS - 1 }),
    ], now);
    expect((await repos.history.read()).map((r) => r.at)).toEqual([now - HISTORY_MAX_AGE_MS]);
  });

  it('a hostname carrying a URL drops to null and keeps the row', async () => {
    fake.local.set(KEYS.history, [{ ...entry({ at: 1 }), hostname: 'https://bank.example/login?token=abc#x' }]);
    const rows = await repos.history.read();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hostname).toBeNull();
  });

  it('a smuggled URL in the hostname never reaches the persisted blob', async () => {
    await repos.history.append([{ ...entry({ at: 1 }), hostname: 'https://bank.example/login?token=abc' }], 2);
    const raw = JSON.stringify(await fake.local.get(KEYS.history));
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toContain('token=abc');
  });

  it('keeps a bracketed IPv6 hostname intact', async () => {
    await repos.history.append([entry({ at: 1, hostname: '[::1]' })], 2);
    expect((await repos.history.read())[0]!.hostname).toBe('[::1]');
  });

  it('drops a row whose operation id looks like a URL', async () => {
    await repos.history.append([entry({ at: 1, operationId: 'https://bank.example/x' }), entry({ at: 2 })], 3);
    expect((await repos.history.read()).map((r) => r.at)).toEqual([2]);
  });

  it('two appends issued without awaiting between them both land', async () => {
    const first = repos.history.append([entry({ at: 1 })], 2);
    const second = repos.history.append([entry({ at: 3 })], 4);
    await Promise.all([first, second]);
    expect((await repos.history.read()).map((r) => r.at)).toEqual([3, 1]);
  });

  it('a clear issued after an unawaited append is ordered after it', async () => {
    const pending = repos.history.append([entry({ at: 1 })], 2);
    const cleared = repos.history.clear();
    await Promise.all([pending, cleared]);
    await expect(repos.history.read()).resolves.toEqual([]);
  });

  it('session.write rejects a non-finite value and stores nothing', async () => {
    await expect(repos.session.write({ discoveredAt: Number.NaN, graceUntil: null })).rejects.toThrow(TypeError);
    await expect(repos.session.read()).resolves.toBeNull();
  });

  it('history.read returns newest first even when the stored array is out of order', async () => {
    fake.local.set(KEYS.history, [entry({ at: 1 }), entry({ at: 3 }), entry({ at: 2 })]);
    expect((await repos.history.read()).map((r) => r.at)).toEqual([3, 2, 1]);
  });

  it('settings.read survives a revoked proxy', async () => {
    fake.local.set(KEYS.settings, revokedProxy());
    await expect(repos.settings.read()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('activity.readAll survives a revoked proxy', async () => {
    fake.session.set(KEYS.activity, revokedProxy());
    await expect(repos.activity.readAll()).resolves.toEqual({});
  });

  it('session.read survives a revoked proxy', async () => {
    fake.session.set(KEYS.session, revokedProxy());
    await expect(repos.session.read()).resolves.toBeNull();
  });

  it('history.read survives a revoked proxy', async () => {
    fake.local.set(KEYS.history, revokedProxy());
    await expect(repos.history.read()).resolves.toEqual([]);
  });
});
