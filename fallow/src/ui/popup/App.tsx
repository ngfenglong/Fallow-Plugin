import { useEffect, useRef, useState } from 'react';
import { useSnapshot } from '../useSnapshot';
import { sendRequest } from '../client';
import { Switch } from '../components/Switch';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
// Type-only, erased at build time. Task 16's layering guard (tests/unit/ui-components.test.tsx,
// "the ui layer reaches background/ only through type-only imports") requires every value a
// UI page takes from the worker's half of the tree to be erased at compile time, never a
// runtime reference, so the worker's own module -- and its chrome.* listener registration --
// never ends up inside a UI bundle. That rule is why BLOCKED_TEXT just below is a hand-kept
// copy of the worker executor's BLOCKED_NOTES text rather than a call to the function that
// formats it there: see the task report for this tension and a suggested fix (move the text
// to a side-effect-free shared module in a later task).
import type { BatchReport, BlockedReason, Preview, Scope } from '../../background/executor';
import type { ReasonCode } from '../../domain/reason-codes';
import { reasonLabel } from '../../domain/reason-codes';

const ALL_WINDOWS_SCOPE: Scope = { kind: 'all' };

/** Verbatim copy of the worker executor's BLOCKED_NOTES. See the layering note above. */
const BLOCKED_TEXT: Record<BlockedReason, string> = {
  'tabs-unavailable': 'Could not read the tab list, so nothing was unloaded.',
  'dashboard-origins-unreadable':
    'Could not confirm which tab this dashboard was opened from, so nothing was unloaded.',
  'startup-grace-unreadable': 'Could not read the startup pause, so no automatic unloading ran.',
  'activity-unreadable': 'Could not read how long these tabs have been unused.',
  'automation-off': 'Automatic unloading is off.',
  'crash-record-unreadable': 'An unfinished operation could not be read, so its result is unknown.',
  'internal-error': 'The operation stopped after an unexpected failure.',
};

type Bulk =
  | { step: 'idle' }
  | { step: 'previewing' }
  | { step: 'ready'; preview: Preview; executing: boolean }
  | { step: 'empty' }
  | { step: 'blocked'; reason: BlockedReason }
  | { step: 'error' };

type Announcement = { tone: 'status' | 'alert'; text: string };

/**
 * One deterministic sentence per outcome, read by an aria-live region so a screen-reader
 * owner learns what a bulk action did without having to inspect the UI (plan §6,
 * "an accessible bulk-result announcement"). Judgement call (brief Step 2 #3): the exact
 * wording is this task's to choose; see the task report for the reasoning.
 */
function describeReport(report: BatchReport): Announcement {
  if (report.blocked !== null) return { tone: 'alert', text: BLOCKED_TEXT[report.blocked] };
  if (report.cancelled) {
    return {
      tone: 'alert',
      text: `Unload stopped before finishing. ${report.confirmed} of ${report.requested} tabs were unloaded.`,
    };
  }
  const problems: string[] = [];
  if (report.alreadyUnloaded > 0) problems.push(`${report.alreadyUnloaded} already unloaded`);
  if (report.skipped > 0) problems.push(`${report.skipped} skipped`);
  if (report.failed > 0) problems.push(`${report.failed} failed`);
  if (report.unknown > 0) problems.push(`${report.unknown} unknown`);
  const tail = problems.length > 0 ? ` (${problems.join(', ')})` : '';
  const tone: Announcement['tone'] = report.failed > 0 || report.unknown > 0 ? 'alert' : 'status';
  return { tone, text: `Unload finished: ${report.confirmed} of ${report.requested} tabs unloaded${tail}.` };
}

/** "15 min", defensively: a fractional or boundary value (1, 1440) must still render, never crash. */
function formatThresholdMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return 'Unknown';
  const rounded = Math.round(minutes * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} min`;
}

/** "2 minutes" while graceUntil is still in the future; null once it has passed or does not apply. */
function graceLabel(graceUntil: number | null): string | null {
  if (graceUntil === null) return null;
  const remainingMs = graceUntil - Date.now();
  if (remainingMs <= 0) return null;
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export function App() {
  const { snapshot, state, refresh } = useSnapshot();
  const [bulk, setBulk] = useState<Bulk>({ step: 'idle' });
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  // A popup's whole document is torn down on close, but a request issued just before
  // that can still resolve while this component is already unmounted in a test (or, in
  // principle, in a dev reload); neither handler below writes to state after that.
  const mountedRef = useRef(true);
  const previewBusyRef = useRef(false);
  const executeBusyRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handlePrimaryClick() {
    // Synchronous guard, checked and set before any await: two clicks in the same tick
    // both reach this line before React's state update is visible to either, so the
    // state alone (`bulk.step !== 'idle'`) is not enough to stop a second request.
    if (previewBusyRef.current) return;
    previewBusyRef.current = true;
    setBulk({ step: 'previewing' });
    try {
      const preview = await sendRequest<Preview>({
        type: 'UNLOAD_PREVIEW',
        scope: ALL_WINDOWS_SCOPE,
        mode: 'manual-bulk',
      });
      if (!mountedRef.current) return;
      if (preview.blocked !== null) setBulk({ step: 'blocked', reason: preview.blocked });
      else if (preview.eligibleTabIds.length === 0) setBulk({ step: 'empty' });
      else setBulk({ step: 'ready', preview, executing: false });
    } catch {
      if (!mountedRef.current) return;
      setBulk({ step: 'error' });
    } finally {
      previewBusyRef.current = false;
    }
  }

  async function handleConfirm() {
    if (executeBusyRef.current) return;
    executeBusyRef.current = true;
    setBulk((prev) => (prev.step === 'ready' ? { ...prev, executing: true } : prev));
    try {
      const report = await sendRequest<BatchReport>({
        type: 'UNLOAD_EXECUTE',
        scope: ALL_WINDOWS_SCOPE,
        mode: 'manual-bulk',
      });
      if (!mountedRef.current) return;
      setAnnouncement(describeReport(report));
    } catch {
      if (!mountedRef.current) return;
      setAnnouncement({
        tone: 'alert',
        text: 'Fallow could not complete the unload. Nothing further happened. Try again.',
      });
    } finally {
      executeBusyRef.current = false;
      if (mountedRef.current) setBulk({ step: 'idle' });
    }
  }

  async function handleOpenDashboard() {
    // F2/A14: the active tab must be read BEFORE chrome.tabs.create, because creating and
    // focusing the new dashboard tab changes which tab is active. A query that rejects or
    // returns nothing still lets the dashboard open, just without an origin id — this task
    // does not send REGISTER_DASHBOARD_ORIGIN at all (see the task report).
    let originTabId: number | null = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const id = tabs[0]?.id;
      if (typeof id === 'number') originTabId = id;
    } catch {
      originTabId = null;
    }
    const base = chrome.runtime.getURL('dashboard/index.html');
    const url = originTabId !== null ? `${base}?originTabId=${originTabId}` : base;
    try {
      chrome.tabs.create({ url });
    } catch {
      // Nothing more this popup can do if Chrome refuses to open a tab; no tab of the
      // owner's was touched, so there is nothing to roll back.
    }
  }

  // Same origin-tab lookup as handleOpenDashboard, just landing on the dashboard's settings
  // panel instead of its top (Task 2: the settings panel had no findable entry point).
  async function handleOpenSettings() {
    let originTabId: number | null = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const id = tabs[0]?.id;
      if (typeof id === 'number') originTabId = id;
    } catch {
      originTabId = null;
    }
    const base = chrome.runtime.getURL('dashboard/index.html');
    const url = originTabId !== null ? `${base}?originTabId=${originTabId}#settings` : `${base}#settings`;
    try {
      chrome.tabs.create({ url });
    } catch {
      // Nothing more this popup can do if Chrome refuses to open a tab; no tab of the
      // owner's was touched, so there is nothing to roll back.
    }
  }

  if (state === 'loading') {
    return (
      <main className="popup">
        <p role="status">Loading Fallow…</p>
      </main>
    );
  }

  if (state === 'error' || snapshot === null) {
    return (
      <main className="popup">
        <ErrorState onRetry={refresh} />
      </main>
    );
  }

  const { settings, counts, windows, startupProblem } = snapshot;
  const grace = settings.automationEnabled ? graceLabel(snapshot.graceUntil) : null;

  return (
    <main className="popup">
      {startupProblem !== null ? (
        // Judgement call (brief Step 2 #10): surfaced here, briefly, rather than deferred
        // to the dashboard. See the task report for the reasoning.
        <p role="alert">{startupProblem}</p>
      ) : null}
      <Switch
        label="Automatic unloading"
        checked={settings.automationEnabled}
        onChange={(next) => {
          void sendRequest({ type: 'UPDATE_SETTINGS', patch: { automationEnabled: next } });
        }}
      />
      <p>
        Threshold: <span>{formatThresholdMinutes(settings.inactivityMinutes)}</span>
      </p>
      {grace !== null ? <p>Starts after a {grace} pause.</p> : null}
      {counts === null ? (
        // The tab scan failed; counts is null for exactly that reason (never "zero tabs").
        // Showing 0/0/0 here would be the anti-goal this project keeps failing on.
        <ErrorState onRetry={refresh} />
      ) : (
        <>
          <p>
            Loaded: <span data-testid="count-loaded">{counts.loaded}</span>
          </p>
          <p>
            Unloaded: <span data-testid="count-unloaded">{counts.unloaded}</span>
          </p>
          {bulk.step === 'idle' || bulk.step === 'previewing' || bulk.step === 'error' ? (
            <Button
              variant="primary"
              disabled={bulk.step === 'previewing'}
              onClick={handlePrimaryClick}
            >
              {`Unload ${counts.eligible} eligible tabs across ${windows.length} windows`}
            </Button>
          ) : null}
          {bulk.step === 'error' ? <p role="alert">Could not check which tabs are eligible. Try again.</p> : null}
          {bulk.step === 'blocked' ? <p role="alert">{BLOCKED_TEXT[bulk.reason]}</p> : null}
          {bulk.step === 'empty' ? (
            <EmptyState title="No eligible tabs to unload right now.">
              <Button onClick={() => setBulk({ step: 'idle' })}>Dismiss</Button>
            </EmptyState>
          ) : null}
          {bulk.step === 'ready' ? (
            <div data-testid="preview-eligible">
              <p>{bulk.preview.eligibleTabIds.length} tab(s) eligible to unload now.</p>
              {Object.entries(bulk.preview.skippedCountsByReason).length > 0 ? (
                <ul>
                  {Object.entries(bulk.preview.skippedCountsByReason).map(([code, count]) => (
                    <li key={code}>
                      {reasonLabel(code as ReasonCode)}: {count}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="popup-actions">
                <Button variant="primary" disabled={bulk.executing} onClick={handleConfirm}>
                  {`Unload ${bulk.preview.eligibleTabIds.length}`}
                </Button>
                <Button disabled={bulk.executing} onClick={() => setBulk({ step: 'idle' })}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
      <div className="popup-footer">
        <Button onClick={handleOpenDashboard}>Open dashboard</Button>
        <Button onClick={handleOpenSettings}>Settings</Button>
      </div>
      {announcement !== null ? (
        <p role={announcement.tone === 'alert' ? 'alert' : 'status'} aria-live={announcement.tone === 'alert' ? 'assertive' : 'polite'}>
          {announcement.text}
        </p>
      ) : null}
    </main>
  );
}
