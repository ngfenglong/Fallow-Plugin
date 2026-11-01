import { DEFAULT_SETTINGS, parseSettings, applySettingsPatch } from '../../src/domain/settings';
import { normalizeHostname } from '../../src/domain/hostname';
import type { Settings } from '../../src/domain/types';

// A fresh literal of the shipped defaults, for comparisons that must not depend on DEFAULT_SETTINGS.
function shippedDefaults(): Settings {
  return {
    schemaVersion: 1, automationEnabled: false, inactivityMinutes: 15, protectPinned: true,
    protectedSites: [
      { hostname: 'chatgpt.com', includeSubdomains: false },
      { hostname: 'docs.google.com', includeSubdomains: false },
      { hostname: 'meet.google.com', includeSubdomains: false },
    ],
    deviceMemoryMonitoringEnabled: false,
  };
}

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

  it('deep-freezes the object, its protectedSites array and each site', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.protectedSites)).toBe(true);
    for (const site of DEFAULT_SETTINGS.protectedSites) expect(Object.isFrozen(site)).toBe(true);
  });

  it('a mutation attempt on the defaults does not change later parses', () => {
    try {
      (DEFAULT_SETTINGS.protectedSites as unknown as unknown[]).push({ hostname: 'evil.test', includeSubdomains: true });
    } catch { /* frozen: the write is rejected */ }
    try {
      (DEFAULT_SETTINGS as { automationEnabled: boolean }).automationEnabled = true;
    } catch { /* frozen: the write is rejected */ }
    expect(parseSettings(undefined)).toEqual(shippedDefaults());
    expect(parseSettings({ protectedSites: [] }).protectedSites).toEqual([]);
    expect(DEFAULT_SETTINGS).toEqual(shippedDefaults());
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

  it.each([
    [0, 15], [1, 1], [1440, 1440], [1441, 15], [2.5, 15], [NaN, 15],
    [Infinity, 15], [-Infinity, 15], [-0, 15], [-5, 15], ['15', 15], ['5', 15],
  ])('falls back to the default 15 for inactivityMinutes %p (result %p)', (input, expected) => {
    expect(parseSettings({ ...DEFAULT_SETTINGS, inactivityMinutes: input }).inactivityMinutes).toBe(expected);
  });

  it('keeps protectPinned and deviceMemoryMonitoringEnabled when sibling fields are bad', () => {
    const r = parseSettings({
      protectPinned: false, deviceMemoryMonitoringEnabled: true, automationEnabled: 'yes', inactivityMinutes: 'x',
    });
    expect(r.protectPinned).toBe(false);
    expect(r.deviceMemoryMonitoringEnabled).toBe(true);
    expect(r.automationEnabled).toBe(false);
    expect(r.inactivityMinutes).toBe(15);
  });

  it('falls back to each boolean default when it is non-boolean', () => {
    const r = parseSettings({ protectPinned: 0, deviceMemoryMonitoringEnabled: 'true' });
    expect(r.protectPinned).toBe(true);
    expect(r.deviceMemoryMonitoringEnabled).toBe(false);
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

  it('collapses three entries for one host to a single broad entry', () => {
    const r = parseSettings({ protectedSites: [
      { hostname: 'EXAMPLE.com', includeSubdomains: false },
      { hostname: 'example.com.', includeSubdomains: true },
      { hostname: 'example.com', includeSubdomains: false },
    ]});
    expect(r.protectedSites).toEqual([{ hostname: 'example.com', includeSubdomains: true }]);
  });

  it('treats different raw spellings of one host as duplicates', () => {
    const r = parseSettings({ protectedSites: [
      { hostname: 'EXAMPLE.com', includeSubdomains: false },
      { hostname: 'example.com.', includeSubdomains: false },
    ]});
    expect(r.protectedSites).toEqual([{ hostname: 'example.com', includeSubdomains: false }]);
  });

  it('trims whitespace-padded hostnames and keeps them', () => {
    const r = parseSettings({ protectedSites: [{ hostname: '  example.com \t', includeSubdomains: false }] });
    expect(r.protectedSites).toEqual([{ hostname: 'example.com', includeSubdomains: false }]);
  });

  it('drops malformed hostnames from protectedSites', () => {
    const r = parseSettings({ protectedSites: [
      { hostname: 'a..b', includeSubdomains: false },
      { hostname: '.com', includeSubdomains: false },
      { hostname: 'host:8080', includeSubdomains: false },
      { hostname: 'exa mple.com', includeSubdomains: false },
      { hostname: '*.example.com', includeSubdomains: false },
      { hostname: 'Sub.Example.COM', includeSubdomains: false },
    ]});
    expect(r.protectedSites).toEqual([{ hostname: 'sub.example.com', includeSubdomains: false }]);
  });

  it('keeps an empty protectedSites list empty (deliberate: the owner removed every protection)', () => {
    expect(parseSettings({ protectedSites: [] }).protectedSites).toEqual([]);
  });

  it('falls back to the default sites when a non-empty list has no valid entry', () => {
    expect(parseSettings({ protectedSites: [{ hostname: '', includeSubdomains: false }, null, 42] }).protectedSites)
      .toEqual(shippedDefaults().protectedSites);
    expect(parseSettings({ protectedSites: 'nope' }).protectedSites).toEqual(shippedDefaults().protectedSites);
  });

  it('treats a non-boolean includeSubdomains as false, the field default', () => {
    const r = parseSettings({ protectedSites: [{ hostname: 'example.com', includeSubdomains: 'yes' }] });
    expect(r.protectedSites).toEqual([{ hostname: 'example.com', includeSubdomains: false }]);
  });

  it('does not let an invalid includeSubdomains weaken a broader duplicate', () => {
    const r = parseSettings({ protectedSites: [
      { hostname: 'example.com', includeSubdomains: 'yes' },
      { hostname: 'example.com', includeSubdomains: true },
    ]});
    expect(r.protectedSites).toEqual([{ hostname: 'example.com', includeSubdomains: true }]);
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
    const raw = JSON.parse(JSON.stringify(shippedDefaults())) as Settings;
    const r = parseSettings(raw);
    r.protectedSites.pop();
    expect(raw.protectedSites).toHaveLength(3);
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
    const hostile: unknown[] = [
      null, undefined, 42, NaN, 'x', true, 1n, () => 1,
      [], [1, 2, {}], [{ automationEnabled: true }, {}],
      { __proto__: { polluted: true } },
      JSON.parse('{"__proto__":{"polluted":true},"automationEnabled":true}'),
      { [Symbol('secret')]: 1, automationEnabled: true },
      { protectedSites: 'nope', inactivityMinutes: NaN },
      { protectedSites: [null, undefined, 42, {}] },
      { get inactivityMinutes(): number { throw new Error('getter'); } },
      (() => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; })(),
      (() => {
        const arr: unknown[] = [{ hostname: 'example.com', includeSubdomains: true }];
        Object.defineProperty(arr, 0, { get() { throw new Error('index'); }, enumerable: true, configurable: true });
        return { automationEnabled: true, protectedSites: arr };
      })(),
      (() => {
        const arr: unknown[] = [{ hostname: 'example.com', includeSubdomains: true }];
        (arr as unknown as Record<symbol, unknown>)[Symbol.iterator] = () => { throw new Error('iterator'); };
        return { protectedSites: arr };
      })(),
    ];

    it.each(hostile.map((value, index) => [index, value] as const))(
      'input #%i returns a valid Settings',
      (_index, raw) => {
        let result: Settings | undefined;
        expect(() => { result = parseSettings(raw); }).not.toThrow();
        expectValidSettings(result as unknown as Settings);
      },
    );

    it('a revoked Proxy yields the defaults', () => {
      const r = Proxy.revocable({}, {});
      r.revoke();
      expect(parseSettings(r.proxy)).toEqual(shippedDefaults());
    });

    it('a throwing getter on inactivityMinutes keeps the other fields and defaults the threshold', () => {
      const r = parseSettings({
        automationEnabled: true,
        get inactivityMinutes(): number { throw new Error('getter'); },
      });
      expect(r.automationEnabled).toBe(true);
      expect(r.inactivityMinutes).toBe(15);
    });

    it('a protectedSites array with a throwing index getter falls back to the default sites', () => {
      const arr: unknown[] = [{ hostname: 'example.com', includeSubdomains: true }];
      Object.defineProperty(arr, 0, { get() { throw new Error('index'); }, enumerable: true, configurable: true });
      const r = parseSettings({ automationEnabled: true, protectedSites: arr });
      expect(r.automationEnabled).toBe(true);
      expect(r.protectedSites).toEqual(shippedDefaults().protectedSites);
    });

    it('a protectedSites array with a throwing Symbol.iterator falls back to the default sites', () => {
      const arr: unknown[] = [{ hostname: 'example.com', includeSubdomains: true }];
      (arr as unknown as Record<symbol, unknown>)[Symbol.iterator] = () => { throw new Error('iterator'); };
      expect(parseSettings({ protectedSites: arr }).protectedSites).toEqual(shippedDefaults().protectedSites);
    });

    it('a throwing getter on includeSubdomains keeps the entry with the field default', () => {
      const r = parseSettings({ protectedSites: [{
        hostname: 'example.com',
        get includeSubdomains(): boolean { throw new Error('getter'); },
      }] });
      expect(r.protectedSites).toEqual([{ hostname: 'example.com', includeSubdomains: false }]);
    });

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

  it('replaces protectedSites with a valid patch', () => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, { protectedSites: [{ hostname: 'Example.org.', includeSubdomains: true }] });
    expect(r.protectedSites).toEqual([{ hostname: 'example.org', includeSubdomains: true }]);
  });

  it('clears protectedSites with an empty patch array', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { protectedSites: [] }).protectedSites).toEqual([]);
  });

  it('keeps current protectedSites when the patch list is non-empty but entirely invalid', () => {
    const current = { ...DEFAULT_SETTINGS, protectedSites: [{ hostname: 'a.test', includeSubdomains: false }] };
    expect(applySettingsPatch(current, { protectedSites: [{ hostname: '' }, 42] }).protectedSites)
      .toEqual([{ hostname: 'a.test', includeSubdomains: false }]);
  });

  it('keeps current protectedSites when the patch is not an array', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { protectedSites: 'nope' }).protectedSites)
      .toEqual(shippedDefaults().protectedSites);
  });

  it.each([null, undefined, 42, 'x', []])('returns current unchanged for patch %p', (patch) => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, patch)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('normalizeHostname', () => {
  it.each([
    ['EXAMPLE.com.', 'example.com'],
    ['com.', 'com'],
    ['localhost', 'localhost'],
    ['  example.com  ', 'example.com'],
    ['[::1]', '[::1]'],
    ['[2001:db8::1]', '[2001:db8::1]'],
    ['[::1]@evil.test', null],
    ['[::1]/p', null],
    ['[::1]?x', null],
    ['[::1]:80', null],
    ['[::1]#f', null],
    ['[::1', null],
    ['münchen.de', 'xn--mnchen-3ya.de'],
    ['a'.repeat(63) + '.com', 'a'.repeat(63) + '.com'],
    ['', null],
    ['   ', null],
    ['.', null],
    ['..', null],
    ['.com', null],
    ['a..b', null],
    ['example.com..', null],
    ['https://bad.example/path', null],
    ['host:443', null],
    ['exa mple.com', null],
    ['*.example.com', null],
    ['user@example.com', null],
    ['example.com?x', null],
    ['example.com#f', null],
    ['a\\b', null],
    ['exa%mple.com', null],
    ['a'.repeat(64) + '.com', null],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });
});
