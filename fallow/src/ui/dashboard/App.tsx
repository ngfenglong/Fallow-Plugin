import { useEffect, useMemo, useRef, useState } from 'react';
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
import { createDeviceMemoryProvider } from '../../platform/memory-provider';
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
  | { step: 'ack' }
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

function setAcknowledgedBulk(): void {
  try {
    window.localStorage.setItem(ACK_KEY, '1');
  } catch {
    // Nothing more to do: the owner will just see the warning again next time, which is
    // the safe direction to fail in.
  }
}

export function App() {
  const { snapshot, state, refresh } = useSnapshot();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('order');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [bulk, setBulk] = useState<Bulk>({ step: 'idle' });
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  // Same unmount/double-submit guards as the popup (App.tsx there); see its comment for why
  // both the busy ref AND the mounted ref are needed.
  const mountedRef = useRef(true);
  const previewBusyRef = useRef(false);
  const executeBusyRef = useRef(false);
  const originRegisteredRef = useRef(false);
  // One provider instance for the page's lifetime: isAvailable()/sample() are cheap reads,
  // but there is no reason to re-create the closure over `chrome` on every render.
  const memoryProviderRef = useRef(createDeviceMemoryProvider(chrome));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      setBulk({ step: 'ack' });
      return;
    }
    void doPreview();
  }

  function handleAcknowledge() {
    setAcknowledgedBulk();
    void doPreview();
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
      const report = await sendRequest<BatchReport>({
        type: 'UNLOAD_EXECUTE', scope: ALL_WINDOWS_SCOPE, mode: 'manual-bulk', operationId: preview.operationId,
      });
      if (mountedRef.current) setAnnouncement(describeReport(report));
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
            <div role="alertdialog" aria-label="Confirm unloading tabs">
              <p>
                Unloading a tab discards its page: unsaved text, active requests and video
                position may be lost. Fallow will ask once more only if you clear its storage.
              </p>
              <div className="popup-actions">
                <Button variant="primary" onClick={handleAcknowledge}>Continue</Button>
                <Button onClick={() => setBulk({ step: 'idle' })}>Cancel</Button>
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
          <MemoryPanel enabled={settings.deviceMemoryMonitoringEnabled} provider={memoryProviderRef.current} />
          <Filters
            search={search} onSearch={setSearch}
            sort={sort} onSort={setSort}
            filter={filter} onFilter={setFilter}
            scopeLabel={`Showing ${sortedVisibleRows.length} of ${counts.total}`}
          />
          <div data-testid="table-scroll" className="scroll-area">
            <TabTable
              mode={tableMode} windows={windows} rows={sortedVisibleRows}
              rowsById={rowsById} visibleIds={visibleIds}
            />
          </div>
          <SettingsPanel settings={settings} />
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
