import { DEFAULT_SETTINGS, parseSettings, applySettingsPatch } from '../../src/domain/settings';
import { normalizeHostname } from '../../src/domain/hostname';
import type { Settings } from '../../src/domain/types';

function expectValidSettings(r: Settings): void {
  expect(r.schemaVersion).toBe(1);
  expect(typeof r.automationEnabled).toBe('boolean');
  expect(Number.isInteger(r.inactivityMinutes)).toBe(true);
  expect(r.inactivityMinutes).toBeGreaterThanOrEqual(1);
  expect(r.inactivityMinutes).toBeLessThanOrEqual(1440);
  expect(typeof r.protectPinned).toBe('boolean');
  expect(Array.isArray(r.protectedSites)).toBe(true);
  expect(typeof r.deviceMemoryMonitoringEnabled).toBe('boolean');
}

describe('settings defaults', () => {
  it('ships the spec defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      schemaVersion: 1, automationEnabled: false, inactivityMinutes: 15, protectPinned: true,
      protectedSites: [
        { hostname: 'chatgpt.com', includeSubdomains: false },
        { hostname: 'docs.google.com', includeSubdomains: false },
        { hostname: 'meet.google.com', includeSubdomains: false },
      ],
      deviceMemoryMonitoringEnabled: false,
    });
  });
});

describe('parseSettings', () => {
  it.each([null, undefined, 42, 'x', [], {}])('falls back to defaults for %p', (raw) => {
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('does not throw on unparseable input', () => {
    expect(() => parseSettings({ protectedSites: 'nope', inactivityMinutes: NaN })).not.toThrow();
  });

  it('keeps good fields when one field is bad', () => {
    const r = parseSettings({ ...DEFAULT_SETTINGS, automationEnabled: true, inactivityMinutes: -5 });
    expect(r.automationEnabled).toBe(true);
    expect(r.inactivityMinutes).toBe(15);
  });

  it.each([[0, 15], [1, 1], [1440, 1440], [1441, 15], [2.5, 15], [NaN, 15]])
    ('clamps threshold %p to %p', (input, expected) => {
      expect(parseSettings({ ...DEFAULT_SETTINGS, inactivityMinutes: input }).inactivityMinutes).toBe(expected);
    });

  it('normalises and dedupes protected hostnames', () => {
    const r = parseSettings({ ...DEFAULT_SETTINGS, protectedSites: [
      { hostname: 'EXAMPLE.com.', includeSubdomains: true },
      { hostname: 'example.com', includeSubdomains: false },
      { hostname: 'https://bad.example/path', includeSubdomains: false },
      { hostname: '', includeSubdomains: false },
    ]});
    expect(r.protectedSites).toEqual([{ hostname: 'example.com', includeSubdomains: true }]);
  });

  it('keeps includeSubdomains true whichever duplicate comes first', () => {
    const broadLast = parseSettings({ protectedSites: [
      { hostname: 'example.com', includeSubdomains: false },
      { hostname: 'example.com', includeSubdomains: true },
    ]});
    const broadFirst = parseSettings({ protectedSites: [
      { hostname: 'example.com', includeSubdomains: true },
      { hostname: 'example.com', includeSubdomains: false },
    ]});
    expect(broadLast.protectedSites).toEqual([{ hostname: 'example.com', includeSubdomains: true }]);
    expect(broadFirst.protectedSites).toEqual([{ hostname: 'example.com', includeSubdomains: true }]);
  });

  it('drops malformed hostnames from protectedSites', () => {
    const r = parseSettings({ protectedSites: [
      { hostname: 'a..b', includeSubdomains: false },
      { hostname: '.com', includeSubdomains: false },
      { hostname: 'host:8080', includeSubdomains: false },
      { hostname: 'exa mple.com', includeSubdomains: false },
      { hostname: 'Sub.Example.COM', includeSubdomains: false },
    ]});
    expect(r.protectedSites).toEqual([{ hostname: 'sub.example.com', includeSubdomains: false }]);
  });

  it('round-trips defaults through JSON storage unchanged', () => {
    expect(parseSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))).toEqual(DEFAULT_SETTINGS);
  });

  it('returns a fresh object that shares no mutable state with DEFAULT_SETTINGS', () => {
    const r = parseSettings(undefined);
    expect(r).not.toBe(DEFAULT_SETTINGS);
    expect(r.protectedSites).not.toBe(DEFAULT_SETTINGS.protectedSites);
    r.automationEnabled = true;
    r.protectedSites.push({ hostname: 'x.test', includeSubdomains: true });
    const first = r.protectedSites[0];
    if (first) first.includeSubdomains = true;
    expect(DEFAULT_SETTINGS.automationEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.protectedSites).toHaveLength(3);
    expect(DEFAULT_SETTINGS.protectedSites[0]).toEqual({ hostname: 'chatgpt.com', includeSubdomains: false });
  });

  it('does not share the protectedSites array with the input object', () => {
    const input = parseSettings(DEFAULT_SETTINGS);
    const raw = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
    const r = parseSettings(raw);
    r.protectedSites.pop();
    expect(raw.protectedSites).toHaveLength(3);
    expect(input.protectedSites).not.toBe(r.protectedSites);
  });

  it('reads a throwing getter as an invalid field without discarding the others', () => {
    const raw = {
      get automationEnabled(): boolean { throw new Error('hostile'); },
      inactivityMinutes: 5,
    };
    const r = parseSettings(raw);
    expect(r.automationEnabled).toBe(false);
    expect(r.inactivityMinutes).toBe(5);
  });

  describe('never throws on hostile input', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 1000; i++) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }
    const throwingProxy = new Proxy({}, {
      get() { throw new Error('get'); },
      has() { throw new Error('has'); },
      ownKeys() { throw new Error('ownKeys'); },
      getOwnPropertyDescriptor() { throw new Error('gopd'); },
    });
    const hostile: unknown[] = [
      null, undefined, 42, NaN, 'x', true, 1n, () => 1,
      [], [1, 2, {}], [{ automationEnabled: true }, {}],
      { __proto__: { polluted: true } },
      JSON.parse('{"__proto__":{"polluted":true},"automationEnabled":true}'),
      deep,
      { [Symbol('secret')]: 1, automationEnabled: true },
      { protectedSites: 'nope', inactivityMinutes: NaN },
      { protectedSites: [null, undefined, 42, {}] },
      { protectedSites: [{ hostname: { toString() { throw new Error('toString'); } } }] },
      { get inactivityMinutes(): number { throw new Error('getter'); } },
      throwingProxy,
    ];

    it.each(hostile.map((value, index) => [index, value] as const))(
      'input #%i returns a valid Settings',
      (_index, raw) => {
        let result: Settings | undefined;
        expect(() => { result = parseSettings(raw); }).not.toThrow();
        expectValidSettings(result as unknown as Settings);
      },
    );

    it('does not pollute Object.prototype', () => {
      parseSettings(JSON.parse('{"__proto__":{"polluted":true}}'));
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });
});

describe('applySettingsPatch', () => {
  it('rejects a patch that would change the schema version', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { schemaVersion: 9 }).schemaVersion).toBe(1);
  });

  it('ignores unknown keys in a patch', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { nope: true })).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the current value when a patched field is invalid', () => {
    const current = { ...DEFAULT_SETTINGS, inactivityMinutes: 30 };
    expect(applySettingsPatch(current, { inactivityMinutes: -3 }).inactivityMinutes).toBe(30);
    expect(applySettingsPatch(current, { automationEnabled: 'yes' }).automationEnabled).toBe(false);
  });

  it('applies valid fields and returns a fresh object', () => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, { automationEnabled: true, inactivityMinutes: 60 });
    expect(r.automationEnabled).toBe(true);
    expect(r.inactivityMinutes).toBe(60);
    expect(r).not.toBe(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.automationEnabled).toBe(false);
  });

  it.each([null, undefined, 42, 'x', []])('returns current unchanged for patch %p', (patch) => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, patch)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('normalizeHostname', () => {
  it.each([
    ['', null],
    ['https://bad.example/path', null],
    ['a..b', null],
    ['.com', null],
    ['.', null],
    ['host:443', null],
    ['has space.com', null],
    ['EXAMPLE.com.', 'example.com'],
    ['example.com..', null],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });
});
