import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSnapshot } from '../useSnapshot';
import { sendRequest } from '../client';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Header } from './Header';
import { Summary } from './Summary';
import { MemoryPanel } from './MemoryPanel';
import { TabTable } from './TabTable';
import { Filters, type FilterKey, type SortKey } from './Filters';
import { SettingsPanel } from './SettingsPanel';
import { ChromeSettingsPanel } from './ChromeSettingsPanel';
import { ActivityLog } from './ActivityLog';
import {
  createDeviceMemoryProvider, summariseBeforeAfter,
  type BeforeAfter, type DeviceMemoryProvider,
} from '../../platform/memory-provider';
import { MEMORY_AFTER_DELAY_MS } from '../../domain/constants';
// Type-only, erased at build time. Task 16's layering guard (tests/unit/ui-components.test.tsx,
// "the ui layer reaches background/ only through type-only imports") requires every value a
// UI page takes from the worker's half of the tree to be erased at compile time, never a
// runtime reference, so the worker's own module -- and its chrome.* listener registration --
// never ends up inside a UI bundle. That is why BLOCKED_TEXT and PROTECTION_REASONS just
// below are hand-kept copies of worker-side vocabulary (executor.ts's BLOCKED_NOTES and
// inventory.ts's PROTECTION set) rather than calls to the functions that define them there:
// the popup (Task 18) made the same tradeoff for BLOCKED_TEXT; see the task report for the
// same suggested fix (a side-effect-free shared module in a later task).
import type { BatchReport, BlockedReason, Preview, Scope } from '../../background/executor';
import type { TabRow } from '../../background/inventory';
import type { ReasonCode } from '../../domain/reason-codes';
// Type-only, same as the HistoryEntry note in ActivityLog.tsx: platform/ is not subject to
// the ui/background layering guard, but only the shape is needed here.
import type { HistoryEntry } from '../../platform/storage';
import { STATE_CHANGED_MESSAGE } from '../../shared/messages';

const ALL_WINDOWS_SCOPE: Scope = { kind: 'all' };

/** The one permitted localStorage key in this codebase (brief Step 3), wrapped in try/catch. */
const ACK_KEY = 'fallow.bulkAcknowledged';

/**
 * Verbatim copy of the worker executor's BLOCKED_NOTES. See the layering note above.
 * Exported so tests/unit/dashboard.test.tsx can assert byte-identical parity against the
 * real `blockedNote`/`BLOCKED_NOTES` (test files are exempt from the layering guard), the
 * same way tests/unit/popup.test.tsx already does for the popup's copy.
 */
export const BLOCKED_TEXT: Record<BlockedReason, string> = {
  'tabs-unavailable': 'Could not read the tab list, so nothing was unloaded.',
  'dashboard-origins-unreadable':
    'Could not confirm which tab this dashboard was opened from, so nothing was unloaded.',
  'startup-grace-unreadable': 'Could not read the startup pause, so no automatic unloading ran.',
  'activity-unreadable': 'Could not read how long these tabs have been unused.',
  'automation-off': 'Automatic unloading is off.',
  'crash-record-unreadable': 'An unfinished operation could not be read, so its result is unknown.',
  'internal-error': 'The operation stopped after an unexpected failure.',
};

/**
 * Hand copy of inventory.ts's PROTECTION set, for the "Protected" filter only (see note
 * above). Exported for the same reason as BLOCKED_TEXT above: so the test file can assert
 * this stays identical to the real, now-exported `PROTECTION` set in inventory.ts.
 */
export const PROTECTION_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'SELECTED', 'AUDIBLE', 'LOADING', 'TAB_PROTECTED', 'SITE_PROTECTED', 'PINNED',
  'BROWSER_PROTECTED', 'DASHBOARD_ORIGIN',
]);

type Bulk =
  | { step: 'idle' }
  // `cancel` is a separate slot from `then`: Cancel must resolve whatever promise the ack
  // dialog's caller is awaiting (final-review fix -- see handleUnloadTab below) without
  // running `then`'s own dispatch. Both close the dialog; only `then` sends a request.
  | { step: 'ack'; then: () => void; cancel: () => void }
  | { step: 'previewing' }
  | { step: 'ready'; preview: Preview }
  | { step: 'executing'; preview: Preview }
  | { step: 'empty' }
  | { step: 'blocked'; reason: BlockedReason }
  | { step: 'error' };

type Announcement = { tone: 'status' | 'alert'; text: string };

/** One deterministic sentence per outcome, read by an aria-live region (plan §6). */
function describeReport(report: BatchReport): Announcement {
  if (report.blocked !== null) return { tone: 'alert', text: BLOCKED_TEXT[report.blocked] };
  if (report.cancelled) {
    return {
      tone: 'alert',
      text: `Stopped before finishing. ${report.confirmed} unloaded, ${report.requested - report.confirmed} not yet acted on.`,
    };
  }
  const problems: string[] = [];
  if (report.alreadyUnloaded > 0) problems.push(`${report.alreadyUnloaded} already unloaded`);
  if (report.skipped > 0) problems.push(`${report.skipped} skipped`);
  if (report.failed > 0) problems.push(`${report.failed} failed`);
  if (report.unknown > 0) problems.push(`${report.unknown} unknown`);
  const tail = problems.length > 0 ? ` (${problems.join(', ')})` : '';
  const tone: Announcement['tone'] = report.failed > 0 || report.unknown > 0 ? 'alert' : 'status';
  return { tone, text: `${report.confirmed} unloaded of ${report.requested} requested${tail}.` };
}

/** The popup passes this via `?originTabId=<id>` (Task 18's ruling); a direct open has none. */
function originTabIdFromLocation(): number | null {
  const raw = new URLSearchParams(window.location.search).get('originTabId');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function hasAcknowledgedBulk(): boolean {
  try {
    return window.localStorage.getItem(ACK_KEY) === '1';
  } catch {
    return false;
  }
}

/** Same shape-check useSnapshot.ts's own isStateChanged uses, duplicated here (not shared
 *  runtime code) so the history refresh below can react to the same broadcast. */
function isStateChangedMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null
    && (message as { type?: unknown }).type === STATE_CHANGED_MESSAGE.type;
}

function setAcknowledgedBulk(): void {
  try {
    window.localStorage.setItem(ACK_KEY, '1');
  } catch {
    // Nothing more to do: the owner will just see the warning again next time, which is
    // the safe direction to fail in.
  }
}

/** Defined once, outside the component, so it is not recreated every render. */
const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A before/after device-memory reading wrapped around an unload action (Task 6). Pure and
 * dependency-injected -- same seam background/executor.ts already uses for its own `sleep`
 * -- so it is tested directly, with no fake timers and no real App render. When monitoring
 * is off, or the capability itself is unavailable, the action still runs but no sampling
 * happens at all: `delta` resolves to `null` immediately, not a `BeforeAfter` with missing
 * fields.
 *
 * `delta` is a *Promise*, not an already-resolved value (final-review fix): the after
 * sample waits MEMORY_AFTER_DELAY_MS (10s) behind `deps.wait`, and a caller that only cares
 * about the unload's own result must never be made to wait on that -- `result` is ready as
 * soon as `action()` itself resolves. Callers `await` the returned object (which carries
 * `result` already settled) and separately attach to `delta` for the memory reading
 * whenever it actually arrives.
 */
export async function sampleMemoryAround<T>(
  deps: { enabled: boolean; provider: DeviceMemoryProvider; wait: (ms: number) => Promise<void> },
  action: () => Promise<T>,
): Promise<{ result: T; delta: Promise<BeforeAfter | null> }> {
  if (!deps.enabled || !(await deps.provider.isAvailable())) {
    return { result: await action(), delta: Promise.resolve(null) };
  }
  const before = await deps.provider.sample();
  const result = await action();
  // Deliberately not awaited: this is what lets `result` above reach the caller without
  // sitting through the 10s after-sample. Neither `deps.wait` nor `provider.sample` ever
  // throws in the real implementation (realWait never rejects; the provider swallows its
  // own failures into `null`), so this promise is never left to reject unobserved.
  const delta = (async (): Promise<BeforeAfter | null> => {
    await deps.wait(MEMORY_AFTER_DELAY_MS);
    const after = await deps.provider.sample();
    return summariseBeforeAfter(before, after);
  })();
  return { result, delta };
}

/**
 * `wait` defaults to the real timer and is only ever overridden by a test (final-review
 * fix's own App-level test for the no-10s-stall behaviour below): production always gets
 * `realWait`, since `main.tsx` renders `<App />` with no props.
 */
export function App({ wait = realWait }: { wait?: (ms: number) => Promise<void> } = {}) {
  const { snapshot, state, refresh } = useSnapshot();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('order');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [bulk, setBulk] = useState<Bulk>({ step: 'idle' });
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  // Tagged with the operationId of the request that produced it, so a reading always says
  // which action it describes when unloads overlap (most recent still wins).
  const [memoryDelta, setMemoryDelta] = useState<{ operationId: string; delta: BeforeAfter } | null>(null);
  // ActivityLog's entries (Task 6/19): fetched here via GET_HISTORY, not inside ActivityLog
  // itself, which only renders what it is given and issues CLEAR_HISTORY on its own button.
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Same unmount/double-submit guards as the popup (App.tsx there); see its comment for why
  // both the busy ref AND the mounted ref are needed.
  const mountedRef = useRef(true);
  const previewBusyRef = useRef(false);
  const executeBusyRef = useRef(false);
  const originRegisteredRef = useRef(false);
  // One provider instance for the page's lifetime: isAvailable()/sample() are cheap reads,
  // but there is no reason to re-create the closure over `chrome` on every render.
  const memoryProviderRef = useRef(createDeviceMemoryProvider(chrome));
  // Final-review fix: guards the #settings scroll-into-view below so it fires at most
  // once per page load, never again once it has found and scrolled to the element.
  const scrolledToSettingsRef = useRef(false);
  // Makes the ack dialog (below) reachable for keyboard/screen-reader users: scrolled into
  // view and focused (on its "Continue" button) the moment it opens, rather than silently
  // appearing wherever it lands in the DOM.
  const ackDialogRef = useRef<HTMLDivElement>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Task 6/19: ActivityLog's data source. Fetched once on mount and again on every
  // STATE_CHANGED_MESSAGE broadcast (the background worker sends this after the same
  // operations that append history rows, per worker-listeners.ts/executor.ts), the same
  // signal useSnapshot.ts already refreshes the tab snapshot on. A reply that is not an
  // array (e.g. a test harness's generic `data: null` stub for an unhandled request type)
  // falls back to the previous list rather than crashing ActivityLog's render.
  //
  // Declared, and its effect run, BEFORE the REGISTER_DASHBOARD_ORIGIN effect below: React
  // runs a component's effects in declaration order, and dashboard.test.tsx's own
  // "registers ... on mount" tests read `fake.lastRequest` (the single most-recently-sent
  // message) right after mount expecting REGISTER_DASHBOARD_ORIGIN -- so that call must be
  // the last one sent on mount, not this one.
  const refreshHistory = useCallback(() => {
    void sendRequest<HistoryEntry[]>({ type: 'GET_HISTORY' })
      .then((entries) => {
        if (mountedRef.current && Array.isArray(entries)) setHistory(entries);
      })
      .catch(() => {
        // Leave the previous list showing; a transient read failure here does not warrant
        // its own error state.
      });
  }, []);

  useEffect(() => {
    refreshHistory();
    const onMessage = (message: unknown) => {
      if (isStateChangedMessage(message)) refreshHistory();
      return undefined;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [refreshHistory]);

  // Brief Step 3: on mount, register this dashboard's origin tab. The popup deliberately
  // does NOT send this itself (Task 18's ruling) -- it only passes the id along in the URL.
  useEffect(() => {
    if (originRegisteredRef.current) return;
    originRegisteredRef.current = true;
    void sendRequest({ type: 'REGISTER_DASHBOARD_ORIGIN', originTabId: originTabIdFromLocation() }).catch(() => {
      // Nothing to show for this: a failed registration means a later bulk run may be
      // blocked (dashboard-origins-unreadable) or, if it is not, may include this tab -- the
      // executor's own revalidation is what actually protects the owner, not this call.
    });
  }, []);

  // Final-review fix: the popup's "Settings" button (Task 2) opens this page at
  // `#settings`, but the browser's native fragment scroll only works if the target
  // element already exists at load time -- it doesn't, since SettingsPanel (and its
  // `id="settings"`) only renders after the GET_SNAPSHOT round-trip resolves (the
  // 'loading' state above renders no settings element at all). No dependency array: this
  // effect re-checks on every render, cheaply, until the element exists, then the ref
  // guard above makes every later run a no-op -- so it runs once, not on every re-render,
  // and never re-fires on a later refresh.
  useEffect(() => {
    if (scrolledToSettingsRef.current) return;
    if (window.location.hash !== '#settings') return;
    const settingsEl = document.getElementById('settings');
    if (settingsEl === null) return;
    scrolledToSettingsRef.current = true;
    settingsEl.scrollIntoView();
  });

  // The ack dialog can open from either the bulk button or a per-tab "Unload now" click,
  // wherever the owner's focus happens to be -- without this it can render off-screen or
  // simply never receive focus, leaving keyboard/screen-reader users with no way to find it.
  useEffect(() => {
    if (bulk.step !== 'ack') return;
    ackDialogRef.current?.scrollIntoView({ block: 'center' });
    continueButtonRef.current?.focus();
  }, [bulk.step]);

  function matchesFilter(row: TabRow): boolean {
    switch (filter) {
      case 'loaded': return row.lifecycle !== 'unloaded';
      case 'unloaded': return row.lifecycle === 'unloaded';
      case 'eligible': return row.manualBulkDecision.eligible;
      case 'protected': return row.manualBulkDecision.reasons.some((r) => PROTECTION_REASONS.has(r));
      default: return true;
    }
  }

  function matchesSearch(row: TabRow): boolean {
    const q = search.trim().toLowerCase();
    if (q === '') return true;
    return row.title.toLowerCase().includes(q) || (row.hostname ?? '').toLowerCase().includes(q);
  }

  const allRows = snapshot?.rows ?? [];
  const rowsById = useMemo(() => new Map(allRows.map((r) => [r.tabId, r])), [allRows]);
  const visibleIds = useMemo(
    () => new Set(allRows.filter((r) => matchesFilter(r) && matchesSearch(r)).map((r) => r.tabId)),
    [allRows, filter, search],
  );
  const sortedVisibleRows = useMemo(() => {
    const rows = allRows.filter((r) => visibleIds.has(r.tabId));
    if (sort === 'unused') return [...rows].sort((a, b) => b.backgroundMs - a.backgroundMs);
    if (sort === 'title') return [...rows].sort((a, b) => a.title.localeCompare(b.title));
    return rows; // 'order': the snapshot's own (windowId, index) order -- do not re-sort.
  }, [allRows, visibleIds, sort]);
  // Grouped-by-window-and-group view mirrors what Chrome itself shows (A15's collapsed-group
  // labelling only makes sense there); any other sort necessarily cuts across groups, so it
  // falls back to one flat list. A search or filter still narrows the grouped view too.
  const tableMode = sort === 'order' ? 'grouped' : 'flat';

  async function doPreview() {
    if (previewBusyRef.current) return;
    previewBusyRef.current = true;
    setBulk({ step: 'previewing' });
    try {
      const preview = await sendRequest<Preview>({
        type: 'UNLOAD_PREVIEW', scope: ALL_WINDOWS_SCOPE, mode: 'manual-bulk',
      });
      if (!mountedRef.current) return;
      if (preview.blocked !== null) setBulk({ step: 'blocked', reason: preview.blocked });
      else if (preview.eligibleTabIds.length === 0) setBulk({ step: 'empty' });
      else setBulk({ step: 'ready', preview });
    } catch {
      if (mountedRef.current) setBulk({ step: 'error' });
    } finally {
      previewBusyRef.current = false;
    }
  }

  function handleBulkClick() {
    // F2/A23: the warning is shown once per owner, ever (until they clear extension
    // storage), never an "undo" offer -- there is no undo for a discard.
    if (!hasAcknowledgedBulk()) {
      // This path (unlike handleUnloadTab's below) never awaits a promise around arming the
      // dialog, so `cancel` has nothing to resolve -- it only needs to close the dialog, same
      // as `then` already does for its own continuation.
      setBulk({ step: 'ack', then: () => void doPreview(), cancel: () => setBulk({ step: 'idle' }) });
      return;
    }
    void doPreview();
  }

  function handleAcknowledge() {
    setAcknowledgedBulk();
    if (bulk.step === 'ack') bulk.then();
  }

  /** Cancel's own handler for the ack dialog (final-review fix): distinct from Continue's
   *  `handleAcknowledge` above, and from a bare `setBulk({ step: 'idle' })`, because closing
   *  the dialog is not enough on its own -- whichever call armed it may be awaiting a promise
   *  that only `bulk.cancel()` knows how to resolve (see handleUnloadTab below). */
  function handleCancelAck() {
    if (bulk.step === 'ack') bulk.cancel();
  }

  async function handleConfirm() {
    if (bulk.step !== 'ready') return;
    if (executeBusyRef.current) return;
    executeBusyRef.current = true;
    const { preview } = bulk;
    // Carries its own operationId so "Cancel remaining" (sent separately, by this same id)
    // has something to name -- the executor has no other way to reach a running batch.
    setBulk({ step: 'executing', preview });
    try {
      const { result: report, delta } = await sampleMemoryAround(
        {
          enabled: snapshot?.settings.deviceMemoryMonitoringEnabled ?? false,
          provider: memoryProviderRef.current,
          wait,
        },
        () => sendRequest<BatchReport>({
          type: 'UNLOAD_EXECUTE', scope: ALL_WINDOWS_SCOPE, mode: 'manual-bulk', operationId: preview.operationId,
        }),
      );
      if (mountedRef.current) {
        setAnnouncement(describeReport(report));
      }
      // Fire-and-forget: the announcement and the busy-release below (this try's own
      // `finally`) must never wait on the 10s after-sample. The "Freed" line simply
      // updates whenever this settles, same as any other async UI update.
      const operationId = preview.operationId;
      void delta.then((d) => {
        if (mountedRef.current) setMemoryDelta(d === null ? null : { operationId, delta: d });
      });
    } catch {
      if (mountedRef.current) {
        setAnnouncement({
          tone: 'alert',
          text: 'Fallow could not complete the unload. Nothing further happened. Try again.',
        });
      }
    } finally {
      executeBusyRef.current = false;
      if (mountedRef.current) setBulk({ step: 'idle' });
    }
  }

  /** The actual per-tab request, shared by the already-acknowledged path and the ack
   *  continuation below -- neither one touches `bulk` itself; only the caller does. */
  async function dispatchUnloadTab(tabId: number) {
    const operationId = `tab-${tabId}-${Date.now()}`;
    try {
      const { result: report, delta } = await sampleMemoryAround(
        {
          enabled: snapshot?.settings.deviceMemoryMonitoringEnabled ?? false,
          provider: memoryProviderRef.current,
          wait,
        },
        () => sendRequest<BatchReport>({
          type: 'UNLOAD_EXECUTE', scope: { kind: 'tab', tabId }, mode: 'manual-single', operationId,
        }),
      );
      if (mountedRef.current) {
        setAnnouncement(describeReport(report));
      }
      // Same decoupling as handleConfirm above: dispatchUnloadTab's own caller (Row's
      // `unloading` guard, via handleUnloadTab) must be released as soon as `report` is
      // ready, not after the after-sample.
      void delta.then((d) => {
        if (mountedRef.current) setMemoryDelta(d === null ? null : { operationId, delta: d });
      });
    } catch {
      if (mountedRef.current) {
        setAnnouncement({
          tone: 'alert',
          text: 'Fallow could not complete the unload. Nothing further happened. Try again.',
        });
      }
    }
  }

  async function handleUnloadTab(tabId: number) {
    // Same one-time warning as the bulk button (F2/A23), armed with this call's own
    // continuation so acknowledging resumes whichever action triggered it.
    if (!hasAcknowledgedBulk()) {
      // `bulk.then` is a single slot: a second "Unload now" click (a different tab's row)
      // while this dialog is still open would silently clobber this call's continuation
      // (and the `resolve` captured inside it), permanently losing this tab's request and
      // leaving this row's busy-guard stuck forever (its promise would never resolve). The
      // dialog already belongs to whichever call armed it first -- treat this click as a
      // no-op: no second request, no stuck button, nothing overwritten.
      if (bulk.step === 'ack') return;
      // Row's `unloading` busy-guard only wraps this call, so it must not resolve until
      // the real request has actually settled -- otherwise it releases the moment the
      // dialog is armed, well before "Continue" is even clicked.
      await new Promise<void>((resolve) => {
        setBulk({
          step: 'ack',
          then: () => {
            // Dismiss the ack dialog *before* dispatching, not after: without this, the
            // dialog (gated on bulk.step === 'ack') stays rendered indefinitely once the
            // request settles, and a second stray "Continue" click would re-invoke this
            // same closure and re-send UNLOAD_EXECUTE for the same tab. Resetting to idle
            // synchronously, inside the same click, means there is nothing left in the DOM
            // for a second click to hit.
            if (mountedRef.current) setBulk({ step: 'idle' });
            void dispatchUnloadTab(tabId).finally(resolve);
          },
          // Final-review fix: Cancel used to go through a bare `setBulk({ step: 'idle' })`
          // on the dialog's own button, which discarded this whole object -- `then` along
          // with the `resolve` it closes over -- without ever calling `resolve`. That left
          // this `await` permanently pending, so Row's `unloading` busy-guard (its `finally`
          // never ran) kept "Unload now" disabled for the rest of the page's life. `cancel`
          // dispatches nothing, unlike `then`, but still has to resolve this same promise so
          // the caller (and the row's busy-guard) is released either way.
          cancel: () => {
            if (mountedRef.current) setBulk({ step: 'idle' });
            resolve();
          },
        });
      });
      return;
    }
    await dispatchUnloadTab(tabId);
  }

  function handleCancelRemaining() {
    if (bulk.step !== 'executing') return;
    void sendRequest({ type: 'CANCEL_BATCH', operationId: bulk.preview.operationId }).catch(() => {
      // The batch keeps running either way; this is a best-effort stop, not a guarantee.
    });
  }

  if (state === 'loading') {
    return (
      <main className="dashboard">
        <p role="status">Loading Fallow…</p>
      </main>
    );
  }

  if (state === 'error' || snapshot === null) {
    return (
      <main className="dashboard">
        <ErrorState onRetry={refresh} />
      </main>
    );
  }

  const { settings, counts, windows, automationNote } = snapshot;

  return (
    <main className="dashboard">
      <Header automationNote={automationNote} />
      {counts === null ? (
        // A failed tab scan has no counts; never render 0/0/0 in its place.
        <ErrorState onRetry={refresh} />
      ) : (
        <>
          <Summary counts={counts} />
          {bulk.step === 'idle' || bulk.step === 'previewing' || bulk.step === 'error' ? (
            <Button variant="primary" disabled={bulk.step === 'previewing'} onClick={handleBulkClick}>
              {`Unload ${counts.eligible} eligible tabs`}
            </Button>
          ) : null}
          {bulk.step === 'error' ? <p role="alert">Could not check which tabs are eligible. Try again.</p> : null}
          {bulk.step === 'blocked' ? (
            <div>
              <p role="alert">{BLOCKED_TEXT[bulk.reason]}</p>
              {/* Without this, a blocked preview/execute leaves no way back to 'idle'
                  except reloading the page -- 'empty' already gets a Dismiss button for
                  the same reason; 'blocked' needs the same recovery affordance. */}
              <Button onClick={() => setBulk({ step: 'idle' })}>Dismiss</Button>
            </div>
          ) : null}
          {bulk.step === 'empty' ? (
            <EmptyState title="No eligible tabs to unload right now.">
              <Button onClick={() => setBulk({ step: 'idle' })}>Dismiss</Button>
            </EmptyState>
          ) : null}
          {bulk.step === 'ack' ? (
            <div role="alertdialog" aria-label="Confirm unloading tabs" ref={ackDialogRef} tabIndex={-1}>
              <p>
                Unloading a tab discards its page: unsaved text, active requests and video
                position may be lost. Fallow will ask once more only if you clear its storage.
              </p>
              <div className="popup-actions">
                <Button variant="primary" onClick={handleAcknowledge} ref={continueButtonRef}>Continue</Button>
                <Button onClick={handleCancelAck}>Cancel</Button>
              </div>
            </div>
          ) : null}
          {bulk.step === 'ready' ? (
            <div>
              <p data-testid="preview-eligible">{bulk.preview.eligibleTabIds.length} eligible tab(s) now</p>
              <p data-testid="preview-skipped">{bulk.preview.skipped.length} skipped</p>
              <div className="popup-actions">
                <Button variant="primary" onClick={handleConfirm}>{`Unload ${bulk.preview.eligibleTabIds.length}`}</Button>
                <Button onClick={() => setBulk({ step: 'idle' })}>Cancel</Button>
              </div>
            </div>
          ) : null}
          {bulk.step === 'executing' ? (
            <div>
              <p>Unloading…</p>
              <Button onClick={handleCancelRemaining}>Cancel remaining</Button>
            </div>
          ) : null}
          <MemoryPanel
            enabled={settings.deviceMemoryMonitoringEnabled} provider={memoryProviderRef.current} delta={memoryDelta?.delta ?? null}
          />
          <Filters
            search={search} onSearch={setSearch}
            sort={sort} onSort={setSort}
            filter={filter} onFilter={setFilter}
            scopeLabel={`Showing ${sortedVisibleRows.length} of ${counts.total}`}
          />
          <div data-testid="table-scroll" className="scroll-area">
            <TabTable
              mode={tableMode} windows={windows} rows={sortedVisibleRows}
              rowsById={rowsById} visibleIds={visibleIds} onUnload={handleUnloadTab}
            />
          </div>
          <SettingsPanel
            settings={settings}
            onSaveFailed={(message) => setAnnouncement({ tone: 'alert', text: message })}
            // Final-review fix: without this, a failed save's alert sticks around forever,
            // even past a later commit that succeeds -- there was previously nothing that
            // ever cleared it on the success path.
            onSaveSucceeded={() => setAnnouncement(null)}
          />
          <ChromeSettingsPanel />
          <ActivityLog entries={history} onCleared={refreshHistory} />
        </>
      )}
      {announcement !== null ? (
        <p
          role={announcement.tone === 'alert' ? 'alert' : 'status'}
          aria-live={announcement.tone === 'alert' ? 'assertive' : 'polite'}
        >
          {announcement.text}
        </p>
      ) : null}
    </main>
  );
}
