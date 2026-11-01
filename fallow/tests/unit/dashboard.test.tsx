import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, BLOCKED_TEXT, PROTECTION_REASONS } from '../../src/ui/dashboard/App';
import { STATE_CHANGED_MESSAGE } from '../../src/shared/messages';
import { UNAVAILABLE_TEXT } from '../../src/domain/constants';
// VALUE imports, deliberately, and only here: this test file is never shipped, so it is
// exempt from the "no value import from src/background/ under src/ui" guard that App.tsx
// itself must obey. App.tsx keeps BLOCKED_TEXT and PROTECTION_REASONS as hand copies
// precisely because it CANNOT take these imports -- this is the one place each copy can be
// checked against the real thing it was copied from (same pattern as popup.test.tsx's own
// BLOCKED_TEXT parity check).
import { blockedNote, type BlockedReason } from '../../src/background/executor';
import { PROTECTION } from '../../src/background/inventory';

// ---- fake worker + chrome harness -------------------------------------------------
//
// Mirrors tests/unit/popup.test.tsx's harness (a scriptable responder standing in for the
// service worker's reply to chrome.runtime.sendMessage), extended with chrome.permissions
// and chrome.system.memory for the device-memory provider (Task 15), which this page calls
// directly rather than through the worker. fireEvent, not @testing-library/user-event
// (not a dependency of this repo -- see popup.test.tsx's own note), is the interaction
// primitive throughout, adapting the brief's illustrative `user.type`/`user.selectOptions`.
//
// The brief's Step 1 code block is illustrative, not one single literal fixture: several of
// its assertions are mutually inconsistent if read as one continuous scenario (e.g. a
// 3-total-tab count alongside a row-5 elsewhere, and a title-sort result naming an id that
// no other assertion in the same block uses). Each test below builds the specific, minimal
// snapshot that makes its own assertion true and meaningful, the same way popup.test.tsx
// reassigns `snapshot` per test. Judgement calls are called out where they depart from the
// brief's literal numbers; see the task report for the full list.

type Responder = (message: any) => unknown;
let responder: Responder;
let snapshot: any;

const fake = {
  calls: { unloadPreview: 0, unloadExecute: 0, updateSettings: 0, cancelBatch: 0, setTabProtection: 0 },
  lastRequest: null as any,
  permissions: { granted: true },
  system: { memory: { capacity: 16 * 1024 ** 3, availableCapacity: 4 * 1024 ** 3 } },
};

function defaultSettings(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    automationEnabled: false,
    inactivityMinutes: 15,
    protectPinned: true,
    protectedSites: [],
    deviceMemoryMonitoringEnabled: false,
    ...overrides,
  };
}

function windowFixture(windowId: number, overrides: Record<string, unknown> = {}) {
  return { windowId, label: `Window ${windowId}`, focused: false, groups: [], ungroupedTabIds: [], ...overrides };
}

function rowFixture(overrides: Record<string, unknown> = {}) {
  const eligible = { eligible: true, reasons: [], evaluatedAt: 0 };
  return {
    tabId: 1, windowId: 1, groupId: -1, title: 'Tab', hostname: 'example.com',
    url: 'https://example.com/', scheme: 'https', lifecycle: 'loaded', selected: false,
    audible: false, pinned: false, backgroundMs: 0, decision: eligible, manualBulkDecision: eligible,
    ...overrides,
  };
}

function snapshotFixture(overrides: Record<string, unknown> = {}) {
  return {
    capturedAt: 1,
    windows: [windowFixture(1)],
    rows: [],
    counts: { total: 0, loaded: 0, unloaded: 0, eligible: 0, protected: 0 },
    settings: defaultSettings(),
    graceUntil: null,
    automationNote: null,
    tabsAvailable: true,
    failedReads: [],
    startupProblem: null,
    ...overrides,
  };
}

function previewFixture(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'fallow-1-1', mode: 'manual-bulk', scope: { kind: 'all' },
    eligibleTabIds: [1, 2], skipped: [], skippedCountsByReason: {}, blocked: null,
    ...overrides,
  };
}

function reportFixture(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'fallow-1-2', trigger: 'manual-bulk', requested: 2, confirmed: 2,
    alreadyUnloaded: 0, skipped: 0, failed: 0, unknown: 0, results: [], cancelled: false,
    blocked: null, crashSafe: true,
    ...overrides,
  };
}

function ok(requestId: string, data: unknown) {
  return { ok: true, requestId, data };
}

function pushStateChanged() {
  for (const fn of (chrome.runtime.onMessage.addListener as unknown as { mock: { calls: any[][] } }).mock.calls.map(
    (c) => c[0],
  )) {
    fn(STATE_CHANGED_MESSAGE);
  }
}

function rowIds(): number[] {
  return screen.getAllByTestId(/^row-/).map((el) => Number(el.getAttribute('data-testid')!.slice('row-'.length)));
}

function installChrome() {
  fake.calls = { unloadPreview: 0, unloadExecute: 0, updateSettings: 0, cancelBatch: 0, setTabProtection: 0 };
  fake.lastRequest = null;
  fake.permissions = { granted: true };
  fake.system = { memory: { capacity: 16 * 1024 ** 3, availableCapacity: 4 * 1024 ** 3 } };

  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn((message: any) => {
        fake.lastRequest = message;
        if (message.type === 'UNLOAD_PREVIEW') fake.calls.unloadPreview++;
        if (message.type === 'UNLOAD_EXECUTE') fake.calls.unloadExecute++;
        if (message.type === 'UPDATE_SETTINGS') fake.calls.updateSettings++;
        if (message.type === 'CANCEL_BATCH') fake.calls.cancelBatch++;
        if (message.type === 'SET_TAB_PROTECTION') fake.calls.setTabProtection++;
        return responder(message);
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      lastError: undefined,
    },
    permissions: {
      contains: vi.fn(() => Promise.resolve(fake.permissions.granted)),
      request: vi.fn(() => {
        fake.permissions.granted = true;
        return Promise.resolve(true);
      }),
      remove: vi.fn(() => {
        fake.permissions.granted = false;
        return Promise.resolve(undefined);
      }),
    },
    system: {
      memory: {
        getInfo: vi.fn(() =>
          Promise.resolve({ capacity: fake.system.memory.capacity, availableCapacity: fake.system.memory.availableCapacity }),
        ),
      },
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  snapshot = snapshotFixture();
  responder = (m) => {
    switch (m.type) {
      case 'GET_SNAPSHOT':
        return ok(m.requestId, snapshot);
      case 'UNLOAD_PREVIEW':
        return ok(m.requestId, previewFixture());
      case 'UNLOAD_EXECUTE':
        return ok(m.requestId, reportFixture());
      case 'UPDATE_SETTINGS': {
        const patch = m.patch as Record<string, unknown>;
        snapshot = { ...snapshot, settings: { ...snapshot.settings, ...patch } };
        queueMicrotask(() => pushStateChanged());
        return ok(m.requestId, snapshot.settings);
      }
      case 'REGISTER_DASHBOARD_ORIGIN':
        return ok(m.requestId, { originTabId: m.originTabId });
      default:
        return ok(m.requestId, null);
    }
  };
  installChrome();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ---- A18: the four lifecycle counts, and Protected named as overlapping -----------

describe('Summary: counts and scope', () => {
  function countsSnapshot() {
    return snapshotFixture({
      windows: [windowFixture(1, { ungroupedTabIds: [1, 2, 3] })],
      rows: [
        rowFixture({ tabId: 1 }),
        rowFixture({ tabId: 2 }),
        rowFixture({
          tabId: 3, pinned: true,
          manualBulkDecision: { eligible: false, reasons: ['PINNED'], evaluatedAt: 0 },
        }),
      ],
      counts: { total: 3, loaded: 3, unloaded: 0, eligible: 2, protected: 1 },
    });
  }

  it('shows the four lifecycle counts and names protected as overlapping', async () => {
    snapshot = countsSnapshot();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('count-total')).toHaveTextContent('3'));
    const summary = screen.getByLabelText('Tab counts');
    expect(within(summary).getByText(/protected/i).closest('[data-overlapping]')).toBeTruthy();
  });

  it('filters without making the counts lie about their scope', async () => {
    snapshot = countsSnapshot();
    render(<App />);
    await screen.findByTestId('scope-label');
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'eligible' } });
    await waitFor(() => expect(screen.getByTestId('scope-label')).toHaveTextContent(/showing 2 of 3/i));
  });
});

// ---- F1: no RAM sort, search, sort ------------------------------------------------

describe('Filters: sort options', () => {
  it('offers no RAM sort while no measurement provider exists', async () => {
    render(<App />);
    await screen.findByLabelText('Sort');
    expect(screen.queryByRole('option', { name: /ram/i })).toBe(null);
  });
});

describe('Filters: search', () => {
  function searchSnapshot() {
    return snapshotFixture({
      windows: [windowFixture(1, { ungroupedTabIds: [1, 2, 3, 4] })],
      rows: [
        rowFixture({ tabId: 1, title: 'Example dashboard', hostname: 'example.com' }),
        rowFixture({ tabId: 2, title: 'Other tab', hostname: 'other.org' }),
        rowFixture({ tabId: 3, title: 'Third tab', hostname: 'third.net' }),
        rowFixture({ tabId: 4, title: 'Quarterly report', hostname: 'reports.internal' }),
      ],
      counts: { total: 4, loaded: 4, unloaded: 0, eligible: 4, protected: 0 },
    });
  }

  it('searches by title and by hostname', async () => {
    snapshot = searchSnapshot();
    render(<App />);
    const box = await screen.findByRole('searchbox', { name: /search/i });
    fireEvent.change(box, { target: { value: 'example.com' } });
    await waitFor(() => expect(rowIds()).toEqual([1]));
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.change(box, { target: { value: 'Quarterly' } });
    await waitFor(() => expect(screen.getByTestId('row-4')).toBeInTheDocument());
  });
});

describe('Filters: sort', () => {
  // Judgement call: the brief's own "Title" result names an id ("4") not used by either of
  // its other two sorts in the same block, which cannot be one consistent fixture. This
  // fixture is 3 rows (ids 1-3) and keeps the brief's two other results verbatim; the title
  // order below is the fixture's own, chosen so all three sorts give visibly different,
  // individually verifiable orderings. See the task report.
  function sortSnapshot() {
    return snapshotFixture({
      windows: [windowFixture(1, { ungroupedTabIds: [1, 2, 3] })],
      rows: [
        rowFixture({ tabId: 1, title: 'Charlie', backgroundMs: 1_000 }),
        rowFixture({ tabId: 2, title: 'Alpha', backgroundMs: 5_000 }),
        rowFixture({ tabId: 3, title: 'Bravo', backgroundMs: 9_000 }),
      ],
      counts: { total: 3, loaded: 3, unloaded: 0, eligible: 3, protected: 0 },
    });
  }

  it('sorts by longest unused, title and existing tab order', async () => {
    snapshot = sortSnapshot();
    render(<App />);
    await screen.findByTestId('row-1');
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'unused' } });
    await waitFor(() => expect(rowIds()).toEqual([3, 2, 1]));
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'title' } });
    await waitFor(() => expect(rowIds()).toEqual([2, 3, 1]));
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'order' } });
    await waitFor(() => expect(rowIds()).toEqual([1, 2, 3]));
  });
});

// ---- §11: Cancel remaining during a large manual batch ----------------------------

describe('bulk action: cancel remaining', () => {
  it('offers Cancel remaining during a large manual batch', async () => {
    localStorage.setItem('fallow.bulkAcknowledged', '1');
    snapshot = snapshotFixture({ counts: { total: 40, loaded: 40, unloaded: 0, eligible: 40, protected: 0 } });
    responder = (m) => {
      if (m.type === 'GET_SNAPSHOT') return ok(m.requestId, snapshot);
      if (m.type === 'UNLOAD_PREVIEW') {
        return ok(m.requestId, previewFixture({ eligibleTabIds: Array.from({ length: 40 }, (_, i) => i + 1) }));
      }
      if (m.type === 'UNLOAD_EXECUTE') return new Promise(() => undefined); // never resolves in this test
      return ok(m.requestId, null);
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload 40 eligible/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^unload 40$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /cancel remaining/i }));
    await waitFor(() => expect(fake.lastRequest).toMatchObject({ type: 'CANCEL_BATCH' }));
  });
});

// ---- F3: automation-off note -------------------------------------------------------

describe('Header: automation-off note', () => {
  it('shows the automation-off note', async () => {
    snapshot = snapshotFixture({
      automationNote: 'Extension automation is off. Chrome may still unload tabs independently.',
    });
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByText('Extension automation is off. Chrome may still unload tabs independently.'),
      ).toBeInTheDocument(),
    );
  });
});

// ---- skipped-reason rows, collapsed groups, badges --------------------------------

describe('TabTable: reasons, groups and badges', () => {
  it('shows each skipped tab its reason', async () => {
    snapshot = snapshotFixture({
      windows: [windowFixture(1, { ungroupedTabIds: [1, 5] })],
      rows: [
        rowFixture({ tabId: 1, selected: true, manualBulkDecision: { eligible: false, reasons: ['SELECTED'], evaluatedAt: 0 } }),
        rowFixture({ tabId: 5, manualBulkDecision: { eligible: false, reasons: ['DASHBOARD_ORIGIN'], evaluatedAt: 0 } }),
      ],
      counts: { total: 2, loaded: 2, unloaded: 0, eligible: 0, protected: 0 },
    });
    render(<App />);
    const row1 = await screen.findByTestId('row-1');
    expect(within(row1).getByText('Selected')).toBeInTheDocument();
    expect(within(screen.getByTestId('row-5')).getByText('Recently opened dashboard from this tab')).toBeInTheDocument();
  });

  it('labels a collapsed group without implying its tabs are unloaded', async () => {
    snapshot = snapshotFixture({
      windows: [windowFixture(1, {
        groups: [{ groupId: 1, title: 'Work', color: 'blue', collapsed: true, tabIds: [2] }],
        ungroupedTabIds: [],
      })],
      rows: [rowFixture({ tabId: 2, groupId: 1 })],
      counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
    });
    render(<App />);
    const group = await screen.findByTestId('group-1');
    expect(group).toHaveTextContent(/collapsed/i);
    expect(within(screen.getByTestId('row-2')).getByText('Loaded')).toBeInTheDocument();
  });

  it('shows Selected and Audible as badges and never claims cpu use', async () => {
    snapshot = snapshotFixture({
      windows: [windowFixture(1, { ungroupedTabIds: [1] })],
      rows: [rowFixture({ tabId: 1, selected: true, audible: true })],
      counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
    });
    render(<App />);
    await screen.findByTestId('row-1');
    expect(screen.getByText('Selected')).toBeInTheDocument();
    expect(screen.getByText('Audible')).toBeInTheDocument();
    expect(screen.queryByText(/using cpu/i)).toBe(null);
  });
});

// ---- F2/A23: one-time acknowledgement, then a compact preview ---------------------

describe('bulk action: one-time acknowledgement', () => {
  it('requires a one-time acknowledgement before the first bulk unload', async () => {
    snapshot = snapshotFixture({ counts: { total: 5, loaded: 5, unloaded: 0, eligible: 5, protected: 0 } });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload 5 eligible/i }));
    expect(
      screen.getByText(/unsaved text, active requests and video position may be lost/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/undo/i)).toBe(null);
    expect(fake.calls.unloadExecute).toBe(0);
  });

  it('shows a compact preview with eligible and skipped counts on later bulk actions', async () => {
    localStorage.setItem('fallow.bulkAcknowledged', '1');
    snapshot = snapshotFixture({ counts: { total: 5, loaded: 5, unloaded: 0, eligible: 5, protected: 0 } });
    responder = (m) => {
      if (m.type === 'GET_SNAPSHOT') return ok(m.requestId, snapshot);
      if (m.type === 'UNLOAD_PREVIEW') {
        return ok(m.requestId, previewFixture({
          eligibleTabIds: [1, 2],
          skipped: [
            { tabId: 3, reasons: ['USED_RECENTLY'] },
            { tabId: 4, reasons: ['USED_RECENTLY'] },
            { tabId: 5, reasons: ['USED_RECENTLY'] },
          ],
        }));
      }
      return ok(m.requestId, null);
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload 5 eligible/i }));
    await waitFor(() => expect(screen.getByTestId('preview-eligible')).toHaveTextContent('2'));
    expect(screen.getByTestId('preview-skipped')).toHaveTextContent('3');
  });

  it('announces a bulk result accessibly', async () => {
    localStorage.setItem('fallow.bulkAcknowledged', '1');
    snapshot = snapshotFixture({ counts: { total: 2, loaded: 2, unloaded: 0, eligible: 2, protected: 0 } });
    responder = (m) => {
      if (m.type === 'GET_SNAPSHOT') return ok(m.requestId, snapshot);
      if (m.type === 'UNLOAD_PREVIEW') return ok(m.requestId, previewFixture({ eligibleTabIds: [1, 2], skipped: [] }));
      if (m.type === 'UNLOAD_EXECUTE') return ok(m.requestId, reportFixture({ confirmed: 2, requested: 2 }));
      return ok(m.requestId, null);
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload 2 eligible/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^unload 2$/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/2 unloaded/i));
  });
});

// ---- F4: Keep loaded binds only Fallow ---------------------------------------------

describe('TabTable: Keep loaded', () => {
  it('explains that Keep loaded binds only Fallow', async () => {
    snapshot = snapshotFixture({
      windows: [windowFixture(1, { ungroupedTabIds: [1] })],
      rows: [rowFixture({ tabId: 1 })],
      counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
    });
    render(<App />);
    const btn = await screen.findByRole('button', { name: /keep loaded/i });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(screen.getByText(/Chrome or another extension can still unload/i)).toBeInTheDocument(),
    );
  });
});

// ---- device memory panel -----------------------------------------------------------

describe('MemoryPanel: gated on the owner enabling it', () => {
  it('shows the device memory panel only once the owner enables it', async () => {
    render(<App />);
    await screen.findByTestId('scope-label');
    expect(screen.queryByTestId('memory-panel')).toBe(null);
  });
});

describe('MemoryPanel: once enabled', () => {
  it('never shows an unavailable memory figure as zero', async () => {
    fake.permissions.granted = false;
    snapshot = snapshotFixture({ settings: defaultSettings({ deviceMemoryMonitoringEnabled: true }) });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('memory-available')).toHaveTextContent(UNAVAILABLE_TEXT));
  });

  it('labels memory as device-wide and warns other apps affect it', async () => {
    fake.permissions.granted = true;
    snapshot = snapshotFixture({ settings: defaultSettings({ deviceMemoryMonitoringEnabled: true }) });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('memory-panel')).toHaveTextContent(/device/i));
    expect(screen.getByText(/Other applications and OS caching can affect this/i)).toBeInTheDocument();
    expect(screen.queryByText(/chrome ram/i)).toBe(null);
  });
});

// ---- scroll position and focus across a refresh (plan §6, milestone 0) -----------

describe('scroll and focus stability across a refresh', () => {
  function richSnapshot(extraRow?: Record<string, unknown>) {
    const rows = [
      rowFixture({ tabId: 1, title: 'One' }),
      rowFixture({ tabId: 2, title: 'Two' }),
      rowFixture({ tabId: 3, title: 'Three' }),
    ];
    const ungroupedTabIds = [1, 2, 3];
    if (extraRow) {
      rows.push(rowFixture(extraRow));
      ungroupedTabIds.push(extraRow.tabId as number);
    }
    return snapshotFixture({
      windows: [windowFixture(1, { ungroupedTabIds })],
      rows,
      counts: { total: rows.length, loaded: rows.length, unloaded: 0, eligible: rows.length, protected: 0 },
    });
  }

  it('keeps scroll position and focus across a snapshot refresh', async () => {
    snapshot = richSnapshot();
    render(<App />);
    const row3 = await screen.findByTestId('row-3');
    row3.focus();
    const scrollEl = screen.getByTestId('table-scroll');
    scrollEl.scrollTop = 400;

    snapshot = richSnapshot({ tabId: 10, title: 'Ten' }); // proves a real refresh happened
    act(() => pushStateChanged());
    await waitFor(() => expect(screen.getByTestId('count-total')).toHaveTextContent('4'));

    expect(document.activeElement).toBe(screen.getByTestId('row-3'));
    expect(screen.getByTestId('table-scroll').scrollTop).toBe(400);
  });

  it('keeps scroll position when an unloaded row arrives under a new tab id', async () => {
    // A discard mints a new tabId, so that row's React key changes and it must remount
    // without throwing away the viewport the owner was reading (milestone 0).
    snapshot = richSnapshot();
    render(<App />);
    await screen.findByTestId('row-3');
    const scrollEl = screen.getByTestId('table-scroll');
    scrollEl.scrollTop = 400;

    const rekeyed: any = richSnapshot();
    rekeyed.rows = rekeyed.rows.map((r: any) =>
      r.tabId === 3 ? { ...r, tabId: 99, lifecycle: 'unloaded', manualBulkDecision: { eligible: false, reasons: ['ALREADY_UNLOADED'], evaluatedAt: 0 } } : r,
    );
    rekeyed.windows = rekeyed.windows.map((w: any) => ({
      ...w, ungroupedTabIds: w.ungroupedTabIds.map((id: number) => (id === 3 ? 99 : id)),
    }));
    snapshot = rekeyed;
    act(() => pushStateChanged());

    await waitFor(() => expect(screen.queryByTestId('row-3')).toBe(null));
    expect(screen.getByTestId('row-99')).toHaveTextContent('Unloaded');
    expect(screen.getByTestId('table-scroll').scrollTop).toBe(400);
  });
});

// ---- loading, empty and error states -----------------------------------------------

describe('App: loading, empty and error states', () => {
  it('renders loading, empty and error states', async () => {
    // loading: the worker never answers during this render.
    responder = () => new Promise(() => undefined);
    const first = render(<App />);
    expect(screen.getByText(/loading fallow/i)).toBeInTheDocument();
    first.unmount();

    // empty: a real, successful scan that simply found nothing.
    snapshot = snapshotFixture({ rows: [], windows: [], counts: { total: 0, loaded: 0, unloaded: 0, eligible: 0, protected: 0 } });
    responder = (m) => (m.type === 'GET_SNAPSHOT' ? ok(m.requestId, snapshot) : ok(m.requestId, null));
    const second = render(<App />);
    await waitFor(() => expect(screen.getByText(/no tabs match/i)).toBeInTheDocument());
    second.unmount();

    // error: the worker never answers successfully.
    responder = () => Promise.reject(new Error('The message port closed before a response was received.'));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not read/i));
  });
});

// ---- additional coverage beyond the brief's list (Step 3's own requirement) -------

describe('REGISTER_DASHBOARD_ORIGIN: sent once on mount (brief Step 3, not in the pinned list)', () => {
  it('registers the dashboard origin on mount, parsed from the query string', async () => {
    const original = window.location.search;
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?originTabId=42' },
      writable: true,
    });
    render(<App />);
    await waitFor(() =>
      expect(fake.lastRequest).toMatchObject({ type: 'REGISTER_DASHBOARD_ORIGIN', originTabId: 42 }),
    );
    Object.defineProperty(window, 'location', { value: { ...window.location, search: original }, writable: true });
  });

  it('registers null when opened directly, with no query string', async () => {
    render(<App />);
    await waitFor(() =>
      expect(fake.lastRequest).toMatchObject({ type: 'REGISTER_DASHBOARD_ORIGIN', originTabId: null }),
    );
  });
});

// ---- parity checks for the two hand-kept copies of worker/domain vocabulary -------
//
// App.tsx cannot import `blockedNote` or `PROTECTION` as VALUES (the src/ui/ ->
// src/background/ layering guard forbids it), so it keeps hand copies instead
// (BLOCKED_TEXT, PROTECTION_REASONS). Nothing stops either copy drifting from the real
// thing the next time someone edits BLOCKED_NOTES or PROTECTION in src/background/ and
// forgets these dashboard copies exist -- exactly the "one rule, two definitions" pattern
// this project has been bitten by before (Task 11's operationId check, Task 13's MODES
// list, and the popup's own BLOCKED_TEXT, which tests/unit/popup.test.tsx already guards
// the same way). These tests make that drift loud instead of silent.

describe('BLOCKED_TEXT stays byte-identical to the worker executor it was copied from', () => {
  const REASONS = Object.keys(BLOCKED_TEXT) as BlockedReason[];

  it.each(REASONS)('matches blockedNote("%s")', (reason) => {
    expect(BLOCKED_TEXT[reason]).toBe(blockedNote(reason));
  });
});

describe('PROTECTION_REASONS stays identical to inventory.ts\'s real PROTECTION set', () => {
  it('has exactly the same reason codes as the real PROTECTION set', () => {
    expect([...PROTECTION_REASONS].sort()).toEqual([...PROTECTION].sort());
  });
});

// ---- recovery from a blocked bulk action (reviewer finding) -----------------------

describe('bulk action: recovering from a blocked preview', () => {
  it('offers a way back to idle when a preview comes back blocked, like empty already does', async () => {
    localStorage.setItem('fallow.bulkAcknowledged', '1');
    snapshot = snapshotFixture({ counts: { total: 3, loaded: 3, unloaded: 0, eligible: 3, protected: 0 } });
    responder = (m) => {
      if (m.type === 'GET_SNAPSHOT') return ok(m.requestId, snapshot);
      if (m.type === 'UNLOAD_PREVIEW') {
        return ok(m.requestId, previewFixture({ blocked: 'tabs-unavailable', eligibleTabIds: [] }));
      }
      return ok(m.requestId, null);
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload 3 eligible/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not read the tab list/i));

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    // Back to idle: the primary button is offered again, with no page reload needed.
    await waitFor(() => expect(screen.getByRole('button', { name: /unload 3 eligible/i })).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
