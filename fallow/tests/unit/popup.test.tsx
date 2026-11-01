import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/popup/App';
import { STATE_CHANGED_MESSAGE } from '../../src/shared/messages';
// A VALUE import, deliberately, and only here: this test file is never shipped, so it is
// exempt from the "no value import from src/background/ under src/ui" guard that App.tsx
// itself must obey. App.tsx keeps its own hand-copied text (BLOCKED_TEXT) precisely because
// it CANNOT take this import — this is the one place that copy can be checked against the
// real thing it was copied from.
import { blockedNote, type BlockedReason } from '../../src/background/executor';

// ---- fake worker + chrome harness -------------------------------------------------
//
// Mirrors the harness proven in tests/unit/ui-components.test.tsx: a scriptable
// responder stands in for the service worker's reply to chrome.runtime.sendMessage.
// fireEvent (not @testing-library/user-event, which this repo does not depend on) is
// the already-proven interaction primitive here; see the task report for why the
// brief's `user.click`/`user.tab()` examples were adapted rather than copied verbatim.

type Responder = (message: any) => unknown;
let responder: Responder;
let sent: any[] = [];
let snapshot: any;

const fake = {
  calls: { unloadPreview: 0, unloadExecute: 0, updateSettings: 0 },
  lastRequest: null as any,
  lastCreatedUrl: null as string | null,
  tabsQueryResult: [{ id: 7 }] as unknown,
  tabsQueryShouldReject: false,
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

function windowFixture(windowId: number) {
  return { windowId, label: `Window ${windowId}`, focused: false, groups: [], ungroupedTabIds: [] };
}

function snapshotFixture(overrides: Record<string, unknown> = {}) {
  return {
    capturedAt: 1,
    windows: [windowFixture(1), windowFixture(2), windowFixture(3)],
    rows: [],
    counts: { total: 80, loaded: 47, unloaded: 33, eligible: 31, protected: 5 },
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
    operationId: 'fallow-1-1',
    mode: 'manual-bulk',
    scope: { kind: 'all' },
    eligibleTabIds: Array.from({ length: 31 }, (_, i) => i + 1),
    skipped: [],
    skippedCountsByReason: {},
    blocked: null,
    ...overrides,
  };
}

function reportFixture(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'fallow-1-2',
    trigger: 'manual-bulk',
    requested: 31,
    confirmed: 31,
    alreadyUnloaded: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    results: [],
    cancelled: false,
    blocked: null,
    crashSafe: true,
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

function installChrome() {
  sent = [];
  fake.calls = { unloadPreview: 0, unloadExecute: 0, updateSettings: 0 };
  fake.lastRequest = null;
  fake.lastCreatedUrl = null;
  fake.tabsQueryResult = [{ id: 7 }];
  fake.tabsQueryShouldReject = false;

  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn((message: any) => {
        sent.push(message);
        fake.lastRequest = message;
        if (message.type === 'UNLOAD_PREVIEW') fake.calls.unloadPreview++;
        if (message.type === 'UNLOAD_EXECUTE') fake.calls.unloadExecute++;
        if (message.type === 'UPDATE_SETTINGS') fake.calls.updateSettings++;
        return responder(message);
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      getURL: vi.fn((path: string) => `chrome-extension://fallow-test-id/${path}`),
      lastError: undefined,
    },
    tabs: {
      query: vi.fn(() => {
        if (fake.tabsQueryShouldReject) return Promise.reject(new Error('No active tab right now.'));
        return Promise.resolve(fake.tabsQueryResult);
      }),
      create: vi.fn((opts: { url: string }) => {
        fake.lastCreatedUrl = opts.url;
        // Real Chrome: creating (and focusing) the new dashboard tab changes which tab is
        // active. Reading the active tab AFTER this call would therefore see the new tab,
        // never the one the owner was actually on — this is what makes the F2/A14
        // ordering requirement observable in a test at all.
        fake.tabsQueryResult = [{ id: 999 }];
        return Promise.resolve({ id: 999 });
      }),
    },
  });
}

beforeEach(() => {
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
        const patch = m.patch as { automationEnabled?: boolean };
        snapshot = {
          ...snapshot,
          settings: { ...snapshot.settings, ...patch },
          graceUntil: patch.automationEnabled ? Date.now() + 120_000 : null,
        };
        queueMicrotask(() => pushStateChanged());
        return ok(m.requestId, snapshot.settings);
      }
      default:
        return ok(m.requestId, null);
    }
  };
  installChrome();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---- Step 1: the plan's pinned behaviours ------------------------------------------

describe('popup: plan-pinned behaviours', () => {
  it('states that the bulk action covers every window', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /unload 31 eligible tabs/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/across 3 windows/i)).toBeInTheDocument();
  });

  it('sends an all-windows scope', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^unload 31$/i }));
    await waitFor(() =>
      expect(fake.lastRequest).toMatchObject({ type: 'UNLOAD_EXECUTE', scope: { kind: 'all' }, mode: 'manual-bulk' }),
    );
  });

  it('shows the same preview the dashboard uses before acting', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload/i }));
    await waitFor(() => expect(screen.getByTestId('preview-eligible')).toBeInTheDocument());
    expect(fake.calls.unloadExecute).toBe(0);
  });

  it('captures the current content tab id before opening the dashboard', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /open dashboard/i }));
    await waitFor(() => expect(fake.lastCreatedUrl).toMatch(/dashboard\/index\.html\?originTabId=7$/));
  });

  it('toggles automation and reports the grace interval', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('switch', { name: /automatic unloading/i }));
    await waitFor(() =>
      expect(fake.lastRequest).toMatchObject({ type: 'UPDATE_SETTINGS', patch: { automationEnabled: true } }),
    );
    await waitFor(() => expect(screen.getByText(/2 minutes/i)).toBeInTheDocument());
  });

  it('shows the threshold and the loaded and unloaded counts', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('15 min')).toBeInTheDocument());
    expect(screen.getByTestId('count-loaded')).toHaveTextContent('47');
  });

  it('is operable by keyboard alone: the automation switch is first in tab order', async () => {
    // @testing-library/user-event is not a dependency of this repo (verified: `npm ls
    // @testing-library/user-event` reports nothing installed), so `user.tab()` from the
    // brief's illustrative test is not available. This checks the same real requirement
    // (switch first among focusable controls) without it; see the task report.
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByRole('switch', { name: /automatic unloading/i })).toBeInTheDocument());
    // querySelectorAll returns elements in document order, which is tab order for any
    // element with no explicit (and here, none has one) tabindex.
    const candidates = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const tabbable = candidates.filter((el) => el.tabIndex >= 0 && !el.disabled);
    expect(tabbable[0]).toBe(screen.getByRole('switch', { name: /automatic unloading/i }));
  });
});

// ---- Step 2: risks the plan's own tests do not cover -------------------------------

describe('popup: loading and error states (risk 1)', () => {
  it('shows a visible loading state, not a blank popup, before the first snapshot arrives', () => {
    responder = () => new Promise(() => undefined); // never resolves during this test
    render(<App />);
    expect(screen.getByText(/loading fallow/i)).toBeInTheDocument();
  });

  it('shows ErrorState, with retry wired to refresh, when the worker does not answer', async () => {
    responder = () => Promise.reject(new Error('The message port closed before a response was received.'));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not read/i));
    responder = (m) => ok(m.requestId, snapshot);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /unload 31 eligible tabs/i })).toBeInTheDocument());
  });
});

describe('popup: UNLOAD_PREVIEW failure modes (risk 2)', () => {
  it('says the check failed, not an empty result, when UNLOAD_PREVIEW rejects', async () => {
    render(<App />);
    const btn = await screen.findByRole('button', { name: /unload 31 eligible tabs/i });
    responder = () => Promise.reject(new Error('boom'));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not check/i));
    expect(screen.queryByTestId('preview-eligible')).toBeNull();
  });

  it('shows the blocked reason, not an empty "Unload 0", when the preview resolves blocked', async () => {
    render(<App />);
    const btn = await screen.findByRole('button', { name: /unload 31 eligible tabs/i });
    responder = (m) =>
      ok(m.requestId, previewFixture({ blocked: 'tabs-unavailable', eligibleTabIds: [] }));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not read the tab list/i));
    expect(screen.queryByRole('button', { name: /^unload 0$/i })).toBeNull();
    expect(screen.queryByTestId('preview-eligible')).toBeNull();
  });
});

describe('popup: UNLOAD_EXECUTE failure and partial-result modes (risk 3)', () => {
  async function openPreview() {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload 31 eligible tabs/i }));
    await screen.findByTestId('preview-eligible');
  }

  it('announces that the batch did not run when UNLOAD_EXECUTE rejects', async () => {
    await openPreview();
    responder = () => Promise.reject(new Error('port closed'));
    fireEvent.click(screen.getByRole('button', { name: /^unload 31$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not complete the unload/i));
  });

  it('announces the blocked reason when UNLOAD_EXECUTE resolves blocked', async () => {
    await openPreview();
    responder = (m) => ok(m.requestId, reportFixture({ blocked: 'automation-off', confirmed: 0, requested: 0 }));
    fireEvent.click(screen.getByRole('button', { name: /^unload 31$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/automatic unloading is off/i));
  });

  it('announces a cancelled batch as stopped before finishing, not as a success', async () => {
    await openPreview();
    responder = (m) => ok(m.requestId, reportFixture({ cancelled: true, confirmed: 5, requested: 31 }));
    fireEvent.click(screen.getByRole('button', { name: /^unload 31$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/stopped before finishing/i));
    expect(screen.getByRole('alert')).toHaveTextContent('5 of 31');
  });

  it('announces failed and unknown counts in an aria-live region, as an alert, on an otherwise-successful response', async () => {
    await openPreview();
    responder = (m) =>
      ok(m.requestId, reportFixture({ confirmed: 28, failed: 2, unknown: 1, requested: 31 }));
    fireEvent.click(screen.getByRole('button', { name: /^unload 31$/i }));
    const region = await screen.findByRole('alert');
    expect(region).toHaveAttribute('aria-live', 'assertive');
    expect(region).toHaveTextContent(/28 of 31 tabs unloaded/i);
    expect(region).toHaveTextContent(/2 failed/i);
    expect(region).toHaveTextContent(/1 unknown/i);
  });

  it('announces a clean success politely, not as an alert', async () => {
    await openPreview();
    responder = (m) => ok(m.requestId, reportFixture({ confirmed: 31, requested: 31 }));
    fireEvent.click(screen.getByRole('button', { name: /^unload 31$/i }));
    const region = await screen.findByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent(/31 of 31 tabs unloaded/i);
  });
});

describe('popup: zero eligible tabs is a real, different state from blocked (risk 4)', () => {
  it('shows EmptyState, not a disabled "Unload 0" button, when nothing is eligible', async () => {
    render(<App />);
    const btn = await screen.findByRole('button', { name: /unload 31 eligible tabs/i });
    responder = (m) => ok(m.requestId, previewFixture({ eligibleTabIds: [], blocked: null }));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/no eligible tabs to unload right now/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^unload 0$/i })).toBeNull();
  });
});

describe('popup: a double click never issues two requests for the same batch (risk 5)', () => {
  it('sends only one UNLOAD_PREVIEW for two rapid clicks on the primary button', async () => {
    render(<App />);
    const btn = await screen.findByRole('button', { name: /unload 31 eligible tabs/i });
    let resolvePreview!: () => void;
    responder = (m) =>
      m.type === 'UNLOAD_PREVIEW'
        ? new Promise((resolve) => {
            resolvePreview = () => resolve(ok(m.requestId, previewFixture()));
          })
        : ok(m.requestId, null);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(fake.calls.unloadPreview).toBe(1);
    resolvePreview();
    await screen.findByTestId('preview-eligible');
  });

  it('sends only one UNLOAD_EXECUTE for two rapid clicks on the confirm button', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload 31 eligible tabs/i }));
    const confirm = await screen.findByRole('button', { name: /^unload 31$/i });
    let resolveExecute!: () => void;
    responder = (m) =>
      m.type === 'UNLOAD_EXECUTE'
        ? new Promise((resolve) => {
            resolveExecute = () => resolve(ok(m.requestId, reportFixture()));
          })
        : ok(m.requestId, null);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(fake.calls.unloadExecute).toBe(1);
    resolveExecute();
    await screen.findByRole('status');
  });
});

describe('popup: chrome.tabs.query({active:true,currentWindow:true}) can genuinely fail (risk 6)', () => {
  it('still opens the dashboard, with no originTabId, when the query returns zero tabs', async () => {
    render(<App />);
    fake.tabsQueryResult = [];
    fireEvent.click(await screen.findByRole('button', { name: /open dashboard/i }));
    await waitFor(() => expect(fake.lastCreatedUrl).not.toBeNull());
    expect(fake.lastCreatedUrl).toBe('chrome-extension://fallow-test-id/dashboard/index.html');
  });

  it('still opens the dashboard, with no originTabId, when the query rejects', async () => {
    render(<App />);
    fake.tabsQueryShouldReject = true;
    fireEvent.click(await screen.findByRole('button', { name: /open dashboard/i }));
    await waitFor(() => expect(fake.lastCreatedUrl).not.toBeNull());
    expect(fake.lastCreatedUrl).toBe('chrome-extension://fallow-test-id/dashboard/index.html');
  });
});

describe('popup: the document can be torn down mid-request (risk 7)', () => {
  it('does not write to state, warn, or throw when UNLOAD_PREVIEW resolves after unmount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(<App />);
    const btn = await screen.findByRole('button', { name: /unload 31 eligible tabs/i });
    let resolvePreview!: () => void;
    responder = (m) =>
      m.type === 'UNLOAD_PREVIEW'
        ? new Promise((resolve) => {
            resolvePreview = () => resolve(ok(m.requestId, previewFixture()));
          })
        : ok(m.requestId, null);
    fireEvent.click(btn);
    unmount();
    expect(() => resolvePreview()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    const stateUpdateWarnings = errorSpy.mock.calls.filter((c) =>
      String(c[0]).includes('unmounted component'),
    );
    expect(stateUpdateWarnings).toEqual([]);
    errorSpy.mockRestore();
  });

  it('does not write to state, warn, or throw when UNLOAD_EXECUTE resolves after unmount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload 31 eligible tabs/i }));
    const confirm = await screen.findByRole('button', { name: /^unload 31$/i });
    let resolveExecute!: () => void;
    responder = (m) =>
      m.type === 'UNLOAD_EXECUTE'
        ? new Promise((resolve) => {
            resolveExecute = () => resolve(ok(m.requestId, reportFixture()));
          })
        : ok(m.requestId, null);
    fireEvent.click(confirm);
    cleanup(); // tears down the whole document, as closing the popup does
    expect(() => resolveExecute()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    const stateUpdateWarnings = errorSpy.mock.calls.filter((c) =>
      String(c[0]).includes('unmounted component'),
    );
    expect(stateUpdateWarnings).toEqual([]);
    errorSpy.mockRestore();
  });
});

describe('popup: threshold formatting at boundaries and off-grid values (risk 8)', () => {
  it('renders the 1-minute floor without crashing', async () => {
    snapshot = snapshotFixture({ settings: defaultSettings({ inactivityMinutes: 1 }) });
    render(<App />);
    await waitFor(() => expect(screen.getByText('1 min')).toBeInTheDocument());
  });

  it('renders the 1440-minute ceiling without crashing', async () => {
    snapshot = snapshotFixture({ settings: defaultSettings({ inactivityMinutes: 1440 }) });
    render(<App />);
    await waitFor(() => expect(screen.getByText('1440 min')).toBeInTheDocument());
  });

  it('renders a non-integer threshold without crashing', async () => {
    snapshot = snapshotFixture({ settings: defaultSettings({ inactivityMinutes: 7.25 }) });
    render(<App />);
    await waitFor(() => expect(screen.getByText('7.3 min')).toBeInTheDocument());
  });
});

describe('popup: toggling automation OFF (risk 9)', () => {
  it('sends automationEnabled:false and shows no grace interval, clearing any prior "2 minutes"', async () => {
    snapshot = snapshotFixture({
      settings: defaultSettings({ automationEnabled: true }),
      graceUntil: Date.now() + 120_000,
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/2 minutes/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('switch', { name: /automatic unloading/i }));
    await waitFor(() =>
      expect(fake.lastRequest).toMatchObject({ type: 'UPDATE_SETTINGS', patch: { automationEnabled: false } }),
    );
    await waitFor(() => expect(screen.queryByText(/2 minutes/i)).toBeNull());
  });
});

describe('popup: startupProblem (risk 10 — judgement call: surfaced here, not deferred)', () => {
  it('shows the startup problem text when the worker reports one', async () => {
    snapshot = snapshotFixture({ startupProblem: 'Could not resume automatic unloading after startup.' });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText('Could not resume automatic unloading after startup.')).toBeInTheDocument(),
    );
  });

  it('shows nothing extra when startupProblem is null', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /unload 31 eligible tabs/i });
    expect(screen.queryAllByRole('alert')).toEqual([]);
  });
});

describe('popup: a failed tab scan (counts null) is never shown as zero (found, not in the brief\'s list)', () => {
  it('shows an error notice instead of fabricating 0/0/0 counts when tabsAvailable is false', async () => {
    snapshot = snapshotFixture({ counts: null, tabsAvailable: false, rows: [], windows: [] });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not read/i));
    expect(screen.queryByTestId('count-loaded')).toBeNull();
    expect(screen.queryByText(/eligible tabs across/i)).toBeNull();
  });
});

describe('popup: BLOCKED_TEXT stays byte-identical to the worker executor it was copied from', () => {
  // App.tsx cannot import blockedNote as a value (the src/ui/ -> src/background/ layering
  // guard forbids it), so it keeps a hand copy instead. Nothing stops that copy drifting
  // from the real text the next time someone edits BLOCKED_NOTES in executor.ts and forgets
  // this file exists — exactly the "one rule, two definitions" pattern this project has been
  // bitten by more than once (Task 11's operationId check, Task 13's MODES list). This test
  // is the parity check that makes drift loud instead of silent.
  const REASONS: BlockedReason[] = [
    'tabs-unavailable', 'dashboard-origins-unreadable', 'startup-grace-unreadable',
    'activity-unreadable', 'automation-off', 'crash-record-unreadable', 'internal-error',
  ];

  it.each(REASONS)('renders the real worker text for "%s" via the preview-blocked path', async (reason) => {
    render(<App />);
    const btn = await screen.findByRole('button', { name: /unload 31 eligible tabs/i });
    responder = (m) => ok(m.requestId, previewFixture({ blocked: reason, eligibleTabIds: [] }));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(blockedNote(reason)));
  });

  it.each(REASONS)('renders the real worker text for "%s" via the execute-blocked path', async (reason) => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /unload 31 eligible tabs/i }));
    await screen.findByTestId('preview-eligible');
    responder = (m) => ok(m.requestId, reportFixture({ blocked: reason, confirmed: 0, requested: 0 }));
    fireEvent.click(screen.getByRole('button', { name: /^unload 31$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(blockedNote(reason)));
  });
});
