import { decide, backgroundElapsedMs, lifecycleOf } from '../../src/domain/eligibility';
import type { EligibilityInput, EligibilityMode } from '../../src/domain/eligibility';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { REASON_CODES, type ReasonCode } from '../../src/domain/reason-codes';
import type { TabActivity, TabFacts } from '../../src/domain/types';
import { MANUAL_BULK_FLOOR_MS, THRESHOLD_MAX, THRESHOLD_MIN } from '../../src/domain/constants';

const MODES: EligibilityMode[] = ['auto', 'manual-bulk', 'manual-single'];

function facts(overrides: Partial<TabFacts> = {}): TabFacts {
  return {
    tabId: 1, index: 0, windowId: 1, groupId: -1,
    url: 'https://example.com/', title: 'Example',
    active: false, audible: false, pinned: false,
    discarded: false, autoDiscardable: true,
    status: 'complete',
    ...overrides,
  };
}

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    tab: facts(),
    settings: DEFAULT_SETTINGS,
    activity: { tabId: 1, backgroundSince: 0, protectedForSession: false },
    mode: 'auto',
    now: 3_600_000,
    graceUntil: null,
    dashboardOriginTabIds: [],
    ...overrides,
  };
}

describe('decide: baseline', () => {
  it('finds an ordinary long-idle background tab eligible in every mode', () => {
    for (const mode of MODES) {
      expect(decide(input({ mode }))).toMatchObject({ eligible: true, reasons: [] });
    }
  });

  it('stamps every decision with the evaluation time', () => {
    expect(decide(input({ now: 123 })).evaluatedAt).toBe(123);
  });
});

describe('decide: protections that apply in all three modes', () => {
  it.each([
    ['SELECTED', { tab: facts({ active: true }) }],
    ['AUDIBLE', { tab: facts({ audible: true }) }],
    ['LOADING', { tab: facts({ status: 'loading' }) }],
    ['BROWSER_PROTECTED', { tab: facts({ autoDiscardable: false }) }],
    ['UNSUPPORTED_URL', { tab: facts({ url: 'chrome://settings' }) }],
    ['PINNED', { tab: facts({ pinned: true }) }],
    ['TAB_PROTECTED', { activity: { tabId: 1, backgroundSince: 0, protectedForSession: true } }],
    ['SITE_PROTECTED', { tab: facts({ url: 'https://chatgpt.com/c/1' }) }],
    ['ALREADY_UNLOADED', { tab: facts({ discarded: true, status: 'unloaded' }) }],
  ] as Array<[ReasonCode, Partial<EligibilityInput>]>)('reports %s in every mode', (code, over) => {
    for (const mode of MODES) {
      const d = decide(input({ ...over, mode }));
      expect(d.eligible).toBe(false);
      expect(d.reasons).toContain(code);
    }
  });

  it('stops protecting pinned tabs when the setting is off but keeps other protections', () => {
    const settings = { ...DEFAULT_SETTINGS, protectPinned: false };
    expect(decide(input({ settings, tab: facts({ pinned: true }) })).eligible).toBe(true);
    expect(decide(input({ settings, tab: facts({ pinned: true, audible: true }) })).reasons)
      .toEqual(['AUDIBLE']);
  });

  it('collects every applicable reason, not just the first, in canonical order', () => {
    const d = decide(input({ mode: 'manual-bulk', tab: facts({ active: true, audible: true, pinned: true }) }));
    expect(d.reasons).toEqual(['SELECTED', 'AUDIBLE', 'PINNED']);
  });
});

describe('decide: unsupported and internal URLs fail closed', () => {
  it.each([
    ['chrome://settings'],
    ['chrome-extension://abcdefghijklmnop/popup.html'],
    ['file:///Users/zell/notes.html'],
    ['about:blank'],
    [''],
    ['not a url at all'],
  ])('never unloads %j in any mode, with UNSUPPORTED_URL among its reasons', (url) => {
    for (const mode of MODES) {
      const d = decide(input({ mode, tab: facts({ url }) }));
      expect(d.eligible).toBe(false);
      expect(d.reasons).toContain('UNSUPPORTED_URL');
    }
  });
});

describe('decide: threshold, floor, grace and dashboard origin by mode', () => {
  it('holds a tab below the configured threshold under auto only', () => {
    const over = { activity: { tabId: 1, backgroundSince: 3_000_000, protectedForSession: false } }; // 10 min idle
    expect(decide(input({ ...over, mode: 'auto' })).reasons).toEqual(['NOT_OLD_ENOUGH']);
    expect(decide(input({ ...over, mode: 'manual-bulk' })).eligible).toBe(true);
    expect(decide(input({ ...over, mode: 'manual-single' })).eligible).toBe(true);
  });

  it('applies the 60s floor to bulk actions but never to a single named tab', () => {
    const over = { activity: { tabId: 1, backgroundSince: 3_570_000, protectedForSession: false } }; // 30s idle
    expect(decide(input({ ...over, mode: 'manual-bulk' })).reasons).toEqual(['USED_RECENTLY']);
    expect(decide(input({ ...over, mode: 'manual-single' })).eligible).toBe(true);
    expect(decide(input({ ...over, mode: 'auto' })).reasons).toContain('NOT_OLD_ENOUGH');
  });

  it('gives exactly one reason per mode at 30s idle: auto NOT_OLD_ENOUGH only, bulk USED_RECENTLY only', () => {
    const activity = { tabId: 1, backgroundSince: 3_600_000 - 30_000, protectedForSession: false };
    expect(decide(input({ activity, mode: 'auto' })).reasons).toEqual(['NOT_OLD_ENOUGH']);
    expect(decide(input({ activity, mode: 'manual-bulk' })).reasons).toEqual(['USED_RECENTLY']);
    expect(decide(input({ activity, mode: 'manual-single' })).eligible).toBe(true);
  });

  it('makes auto eligible at the threshold minimum exactly equal to the floor', () => {
    // THRESHOLD_MIN minutes must equal MANUAL_BULK_FLOOR_MS, so under auto the threshold
    // already implies the floor. A change to either constant breaks this loudly.
    expect(THRESHOLD_MIN * 60_000).toBe(MANUAL_BULK_FLOOR_MS);
    const settings = { ...DEFAULT_SETTINGS, inactivityMinutes: THRESHOLD_MIN };
    const activity = { tabId: 1, backgroundSince: 3_600_000 - 60_000, protectedForSession: false };
    expect(decide(input({ settings, activity, mode: 'auto' })).eligible).toBe(true);
  });

  it.each([[59_999, false], [60_000, true]])('treats %pms idle as eligible=%p for bulk', (idle, ok) => {
    const activity = { tabId: 1, backgroundSince: 3_600_000 - idle, protectedForSession: false };
    expect(decide(input({ activity, mode: 'manual-bulk' })).eligible).toBe(ok);
  });

  it('treats exactly the bulk floor as eligible, not held', () => {
    const activity = { tabId: 1, backgroundSince: 3_600_000 - MANUAL_BULK_FLOOR_MS, protectedForSession: false };
    expect(decide(input({ activity, mode: 'manual-bulk' })).eligible).toBe(true);
  });

  it('treats exactly the configured threshold as eligible under auto (>=, not >)', () => {
    const thresholdMs = DEFAULT_SETTINGS.inactivityMinutes * 60_000;
    const activity = { tabId: 1, backgroundSince: 3_600_000 - thresholdMs, protectedForSession: false };
    expect(decide(input({ activity, mode: 'auto' })).eligible).toBe(true);
    const justUnder = { tabId: 1, backgroundSince: 3_600_000 - thresholdMs + 1, protectedForSession: false };
    expect(decide(input({ activity: justUnder, mode: 'auto' })).reasons).toContain('NOT_OLD_ENOUGH');
  });

  it('holds automatic runs during startup grace and no others', () => {
    const over = { graceUntil: 3_600_001 };
    expect(decide(input({ ...over, mode: 'auto' })).reasons).toEqual(['STARTUP_GRACE']);
    expect(decide(input({ ...over, mode: 'manual-bulk' })).eligible).toBe(true);
    expect(decide(input({ ...over, mode: 'manual-single' })).eligible).toBe(true);
    expect(decide(input({ graceUntil: 3_599_999, mode: 'auto' })).eligible).toBe(true);
  });

  it('skips the dashboard origin tab for bulk actions only', () => {
    const over = { dashboardOriginTabIds: [1] };
    expect(decide(input({ ...over, mode: 'manual-bulk' })).reasons).toEqual(['DASHBOARD_ORIGIN']);
    expect(decide(input({ ...over, mode: 'manual-single' })).eligible).toBe(true);
    expect(decide(input({ ...over, mode: 'auto' })).eligible).toBe(true);
  });

  it('ignores dashboard origin ids that do not match the tab', () => {
    expect(decide(input({ mode: 'manual-bulk', dashboardOriginTabIds: [2, 3] })).eligible).toBe(true);
  });
});

describe('decide: tabs with no recorded activity', () => {
  it('treats an unknown tab as not old enough under auto and eligible for a single unload', () => {
    expect(decide(input({ activity: null, mode: 'auto' })).reasons).toContain('NOT_OLD_ENOUGH');
    expect(decide(input({ activity: null, mode: 'manual-single' })).eligible).toBe(true);
  });
});

describe('backgroundElapsedMs and the backward clock (Review Focus 2)', () => {
  it('clamps a backward clock jump to zero elapsed', () => {
    expect(backgroundElapsedMs({ tabId: 1, backgroundSince: 5_000, protectedForSession: false }, 1_000)).toBe(0);
  });

  it('never reads a backward clock jump as idle in the future', () => {
    const d = decide(input({ activity: { tabId: 1, backgroundSince: 7_200_000, protectedForSession: false } }));
    expect(d.reasons).toContain('NOT_OLD_ENOUGH');
    expect(d.reasons).not.toContain('USED_RECENTLY');
    expect(d.eligible).toBe(false);
  });

  it('reports a selected tab (null backgroundSince) as having no background time', () => {
    expect(backgroundElapsedMs({ tabId: 1, backgroundSince: null, protectedForSession: false }, 1_000)).toBe(0);
  });

  it('returns the plain elapsed difference when the clock moved forward', () => {
    expect(backgroundElapsedMs({ tabId: 1, backgroundSince: 1_000, protectedForSession: false }, 4_000)).toBe(3_000);
  });

  it('returns zero when there is no activity record', () => {
    expect(backgroundElapsedMs(null, 4_000)).toBe(0);
  });
});

describe('lifecycleOf', () => {
  it('derives lifecycle from discarded and status, counting loading as loaded', () => {
    expect(lifecycleOf(facts({ discarded: true, status: 'unloaded' }))).toBe('unloaded');
    expect(lifecycleOf(facts({ status: 'loading' }))).toBe('loading');
    expect(lifecycleOf(facts())).toBe('loaded');
  });
});

describe('decide: totality, purity and vocabulary', () => {
  const HOSTILE: Array<Partial<TabFacts>> = [
    { url: '' },
    { url: 'http://[::1' },
    { url: 'https://' + 'a'.repeat(10_000) + '.com/' },
    { title: '<script>alert(1)</script>' },
    { groupId: -1 },
    { tabId: -1 },
    { url: 'javascript:alert(1)' },
  ];

  it('never throws for hostile tab facts', () => {
    for (const over of HOSTILE) {
      for (const mode of MODES) {
        expect(() => decide(input({ tab: facts(over), mode }))).not.toThrow();
      }
    }
  });

  it('never throws for null activity', () => {
    for (const mode of MODES) {
      expect(() => decide(input({ activity: null, mode }))).not.toThrow();
    }
  });

  it('never throws for a hostile tab that is also unsupported and unloaded', () => {
    expect(() => decide(input({
      tab: facts({ url: '', tabId: -1, groupId: -1, title: '<script>', discarded: true, status: 'unloaded' }),
      activity: null,
      mode: 'auto',
    }))).not.toThrow();
  });

  it('does not mutate its input', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const tab = facts({ active: true, url: 'https://chatgpt.com/c/1' });
    const activity: TabActivity = { tabId: 1, backgroundSince: 0, protectedForSession: false };
    const dashboard = [1];
    const original = {
      settings: structuredClone(settings), tab: structuredClone(tab),
      activity: structuredClone(activity), dashboard: [...dashboard],
    };
    for (const mode of MODES) {
      decide({ tab, settings, activity, mode, now: 3_600_000, graceUntil: 3_600_001, dashboardOriginTabIds: dashboard });
    }
    expect(settings).toEqual(original.settings);
    expect(tab).toEqual(original.tab);
    expect(activity).toEqual(original.activity);
    expect(dashboard).toEqual(original.dashboard);
  });

  it('only ever emits codes that are members of REASON_CODES', () => {
    const allowed = new Set<string>(REASON_CODES);
    const hostileTabs = [
      facts(), facts({ url: '' }), facts({ url: 'chrome://x' }), facts({ active: true, audible: true, pinned: true }),
      facts({ status: 'loading' }), facts({ autoDiscardable: false }), facts({ discarded: true, status: 'unloaded' }),
      facts({ url: 'https://chatgpt.com/' }),
    ];
    const activities: Array<TabActivity | null> = [
      null,
      { tabId: 1, backgroundSince: 0, protectedForSession: true },
      { tabId: 1, backgroundSince: null, protectedForSession: false },
      { tabId: 1, backgroundSince: 9_999_999, protectedForSession: false },
    ];
    for (const tab of hostileTabs) for (const activity of activities) for (const mode of MODES) {
      for (const graceUntil of [null, 3_600_001]) for (const dash of [[], [1]]) {
        for (const reason of decide({ tab, settings: DEFAULT_SETTINGS, activity, mode, now: 3_600_000, graceUntil, dashboardOriginTabIds: dash }).reasons) {
          expect(allowed.has(reason)).toBe(true);
        }
      }
    }
  });

  it('has eligible exactly equal to reasons.length === 0 across the matrix', () => {
    const tabs = [facts(), facts({ active: true }), facts({ url: 'chrome://x' }), facts({ pinned: true })];
    const activities: Array<TabActivity | null> = [null, { tabId: 1, backgroundSince: 3_599_000, protectedForSession: false }];
    for (const tab of tabs) for (const activity of activities) for (const mode of MODES) {
      for (const graceUntil of [null, 3_600_001]) for (const dash of [[], [1]]) {
        const d = decide({ tab, settings: DEFAULT_SETTINGS, activity, mode, now: 3_600_000, graceUntil, dashboardOriginTabIds: dash });
        expect(d.eligible).toBe(d.reasons.length === 0);
      }
    }
  });

  it('returns reasons: [] and eligible: true for a tab with no applicable reason', () => {
    expect(decide(input({ mode: 'manual-single' }))).toEqual({ eligible: true, reasons: [], evaluatedAt: 3_600_000 });
  });
});

describe('decide: fails closed on values it cannot interpret', () => {
  const RECENT_OR_UNKNOWN = { tabId: 1, backgroundSince: 0, protectedForSession: false };

  it('holds a tab when now is NaN, under auto and manual-bulk', () => {
    const auto = decide(input({ now: NaN, mode: 'auto' }));
    expect(auto.eligible).toBe(false);
    expect(auto.reasons).toContain('NOT_OLD_ENOUGH');
    const bulk = decide(input({ now: NaN, mode: 'manual-bulk' }));
    expect(bulk.eligible).toBe(false);
    expect(bulk.reasons).toContain('USED_RECENTLY');
  });

  it('holds automatic runs when now is NaN during grace', () => {
    const d = decide(input({ now: NaN, mode: 'auto', graceUntil: 3_600_001 }));
    expect(d.eligible).toBe(false);
    expect(d.reasons).toContain('STARTUP_GRACE');
  });

  it('holds a tab when backgroundSince is NaN', () => {
    const activity = { tabId: 1, backgroundSince: NaN, protectedForSession: false };
    expect(decide(input({ activity, mode: 'auto' })).eligible).toBe(false);
    expect(decide(input({ activity, mode: 'manual-bulk' })).eligible).toBe(false);
  });

  it('holds a tab when backgroundSince and now are both Infinity (NaN elapsed)', () => {
    const activity = { tabId: 1, backgroundSince: Infinity, protectedForSession: false };
    expect(decide(input({ activity, now: Infinity, mode: 'auto' })).eligible).toBe(false);
    expect(decide(input({ activity, now: Infinity, mode: 'manual-bulk' })).eligible).toBe(false);
  });

  it('holds a tab when now is -Infinity', () => {
    expect(decide(input({ now: -Infinity, activity: RECENT_OR_UNKNOWN, mode: 'auto' })).eligible).toBe(false);
    expect(decide(input({ now: -Infinity, activity: RECENT_OR_UNKNOWN, mode: 'manual-bulk' })).eligible).toBe(false);
  });

  it('keeps a tab idle forever (backgroundSince -Infinity) eligible in every mode', () => {
    const activity = { tabId: 1, backgroundSince: -Infinity, protectedForSession: false };
    for (const mode of MODES) {
      expect(decide(input({ activity, mode })).eligible).toBe(true);
    }
  });

  it('reads NaN elapsed as 0 from backgroundElapsedMs', () => {
    expect(backgroundElapsedMs({ tabId: 1, backgroundSince: NaN, protectedForSession: false }, 1_000)).toBe(0);
    expect(backgroundElapsedMs({ tabId: 1, backgroundSince: Infinity, protectedForSession: false }, Infinity)).toBe(0);
  });

  it('holds a tab under an unknown runtime mode, even though it would otherwise be eligible', () => {
    const d = decide(input({ mode: 'bogus' as never }));
    expect(d.eligible).toBe(false);
    expect(d.reasons).toContain('NOT_OLD_ENOUGH');
  });

  it('holds a tab under an unknown mode for a tab already fully eligible under manual-single', () => {
    expect(decide(input({ mode: 'manual-single' })).eligible).toBe(true);
    expect(decide(input({ mode: undefined as never })).eligible).toBe(false);
  });
});

describe('decide: inactivity threshold bounds', () => {
  const MIN_MS = THRESHOLD_MIN * 60_000;
  const MAX_MS = THRESHOLD_MAX * 60_000;
  const idleFor = (ms: number) => ({ tabId: 1, backgroundSince: 3_600_000 - ms, protectedForSession: false });

  it.each([+Infinity, -Infinity, NaN])('holds under auto when inactivityMinutes is %s, even after 25 hours idle', (minutes) => {
    const settings = { ...DEFAULT_SETTINGS, inactivityMinutes: minutes };
    const d = decide(input({ settings, activity: idleFor(25 * 60 * 60_000), mode: 'auto' }));
    expect(d.eligible).toBe(false);
    expect(d.reasons).toEqual(['NOT_OLD_ENOUGH']);
  });

  it.each([0, -5])('clamps inactivityMinutes %s up to the minimum: held at 59s, eligible at 60s', (minutes) => {
    const settings = { ...DEFAULT_SETTINGS, inactivityMinutes: minutes };
    expect(decide(input({ settings, activity: idleFor(MIN_MS - 1_000), mode: 'auto' })).eligible).toBe(false);
    expect(decide(input({ settings, activity: idleFor(MIN_MS), mode: 'auto' })).eligible).toBe(true);
  });

  it('clamps an oversized inactivityMinutes down to the maximum: held at 23h, eligible at 25h', () => {
    const settings = { ...DEFAULT_SETTINGS, inactivityMinutes: 5_000 };
    expect(decide(input({ settings, activity: idleFor(23 * 60 * 60_000), mode: 'auto' })).eligible).toBe(false);
    expect(decide(input({ settings, activity: idleFor(25 * 60 * 60_000), mode: 'auto' })).eligible).toBe(true);
    expect(MAX_MS).toBe(THRESHOLD_MAX * 60_000);
  });

  it('keeps the threshold minimum equal to the bulk floor, which the bulk-only floor ruling depends on', () => {
    expect(THRESHOLD_MIN * 60_000).toBe(MANUAL_BULK_FLOOR_MS);
  });
});

describe('decide: reason ordering is canonical, not push order', () => {
  it('orders UNSUPPORTED_URL after STARTUP_GRACE for a chrome:// tab that is active within grace', () => {
    const d = decide(input({
      tab: facts({ url: 'chrome://x', active: true }),
      mode: 'auto',
      graceUntil: 3_600_001,
    }));
    expect(d.reasons).toEqual(['SELECTED', 'STARTUP_GRACE', 'UNSUPPORTED_URL']);
  });

  it('orders NOT_OLD_ENOUGH before STARTUP_GRACE in a combined case', () => {
    const activity = { tabId: 1, backgroundSince: 3_599_000, protectedForSession: false };
    const d = decide(input({ activity, mode: 'auto', graceUntil: 3_600_001 }));
    expect(d.reasons).toEqual(['NOT_OLD_ENOUGH', 'STARTUP_GRACE']);
  });
});

describe('decide: the URL gate on hostile URLs', () => {
  it('reports UNSUPPORTED_URL for a 10,000-character label and a javascript: URL', () => {
    const longLabel = 'https://' + 'a'.repeat(10_000) + '.com/';
    for (const url of [longLabel, 'javascript:alert(1)']) {
      for (const mode of MODES) {
        const d = decide(input({ tab: facts({ url }), mode }));
        expect(d.eligible).toBe(false);
        expect(d.reasons).toContain('UNSUPPORTED_URL');
      }
    }
  });
});

describe('lifecycleOf: contradictory facts', () => {
  it('treats discarded as unloaded even when status says complete or loading', () => {
    expect(lifecycleOf(facts({ discarded: true, status: 'complete' }))).toBe('unloaded');
    expect(lifecycleOf(facts({ discarded: true, status: 'loading' }))).toBe('unloaded');
  });
});

describe('decide: the mutation snapshot covers every input array', () => {
  it('does not mutate dashboardOriginTabIds', () => {
    const dashboard = [1, 2];
    decide(input({ mode: 'manual-bulk', dashboardOriginTabIds: dashboard }));
    expect(dashboard).toEqual([1, 2]);
  });
});
