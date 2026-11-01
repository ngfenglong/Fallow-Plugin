import { useState } from 'react';
// Type-only: erased at build time. See App.tsx for the full note on why src/ui/ may only
// take types, never runtime values, from src/background/.
import type { TabRow, WindowSection } from '../../background/inventory';
import { reasonLabel, type ReasonCode } from '../../domain/reason-codes';
import { Badge, type Tone } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { sendRequest } from '../client';

const LIFECYCLE: Record<TabRow['lifecycle'], { label: string; tone: Tone }> = {
  loaded: { label: 'Loaded', tone: 'ok' },
  loading: { label: 'Loading', tone: 'info' },
  unloaded: { label: 'Unloaded', tone: 'neutral' },
};

function isProtectedByFallow(row: TabRow): boolean {
  return row.manualBulkDecision.reasons.includes('TAB_PROTECTED');
}

/**
 * One tab's row. A title or group title can contain hostile text (a script tag, an
 * onerror payload); every piece of owner-supplied text below is a plain text child, never
 * raw markup, so it can never execute (Review Focus 4 / the no-raw-html scan).
 */
function Row({ row, onUnload }: { row: TabRow; onUnload: (tabId: number) => Promise<void> }) {
  const state = LIFECYCLE[row.lifecycle];
  const protectedByFallow = isProtectedByFallow(row);
  const [pending, setPending] = useState(false);
  const [unloading, setUnloading] = useState(false);

  async function toggleProtection() {
    if (pending) return;
    setPending(true);
    try {
      await sendRequest({ type: 'SET_TAB_PROTECTION', tabId: row.tabId, isProtected: !protectedByFallow });
    } catch {
      // Best effort: the next snapshot refresh (pushed by the worker on a real change)
      // shows the true state either way, so nothing here needs to roll back optimistically.
    } finally {
      setPending(false);
    }
  }

  async function handleUnload() {
    if (unloading) return;
    setUnloading(true);
    try {
      await onUnload(row.tabId);
    } finally {
      setUnloading(false);
    }
  }

  return (
    <div className="tab-row" data-testid={`row-${row.tabId}`} tabIndex={-1}>
      <div className="tab-row-main">
        <span className="tab-row-title">{row.title || 'Untitled tab'}</span>
        <span className="tab-row-site">{row.hostname ?? row.scheme ?? 'Unknown site'}</span>
      </div>
      <div className="tab-row-flags">
        <Badge label={state.label} tone={state.tone} />
        {row.selected ? <Badge label="Selected" tone="info" /> : null}
        {row.audible ? <Badge label="Audible" tone="warn" /> : null}
        {row.pinned ? <Badge label="Pinned" tone="neutral" /> : null}
      </div>
      {!row.manualBulkDecision.eligible && row.manualBulkDecision.reasons.length > 0 ? (
        <ul className="tab-row-reasons">
          {row.manualBulkDecision.reasons.map((code: ReasonCode) => (
            <li key={code}>{reasonLabel(code)}</li>
          ))}
        </ul>
      ) : null}
      <div className="tab-row-actions">
        <Button disabled={pending} onClick={toggleProtection}>
          {protectedByFallow ? 'Stop keeping loaded' : 'Keep loaded'}
        </Button>
        <Button disabled={unloading} onClick={handleUnload}>Unload now</Button>
        {/* F4: the owner must never read this as a Chrome-level guarantee. */}
        <p className="tab-row-caption">
          Binds only this Fallow session. Chrome or another extension can still unload this tab.
        </p>
      </div>
    </div>
  );
}

export type TabTableMode = 'grouped' | 'flat';

export type TabTableProps = {
  mode: TabTableMode;
  /** Grouped mode only: the window/group structure to render tabs inside. */
  windows: readonly WindowSection[];
  /** Flat mode: the rows to render, already filtered, searched and sorted. */
  rows: readonly TabRow[];
  /** Grouped mode: every row, keyed by id, so a group can look its tabs up. */
  rowsById: ReadonlyMap<number, TabRow>;
  /** Grouped mode: which tab ids survive the current filter/search. */
  visibleIds: ReadonlySet<number>;
  /** Unloads just this one tab (manual-single, `{ kind: 'tab', tabId }`). */
  onUnload: (tabId: number) => Promise<void>;
};

export function TabTable({ mode, windows, rows, rowsById, visibleIds, onUnload }: TabTableProps) {
  if (mode === 'flat') {
    if (rows.length === 0) return <EmptyState title="No tabs match the current filter and search." />;
    return (
      <div className="tab-table">
        {rows.map((row) => (
          <Row key={row.tabId} row={row} onUnload={onUnload} />
        ))}
      </div>
    );
  }

  const anyVisible = windows.some(
    (w) =>
      w.ungroupedTabIds.some((id) => visibleIds.has(id)) ||
      w.groups.some((g) => g.tabIds.some((id) => visibleIds.has(id))),
  );
  if (!anyVisible) return <EmptyState title="No tabs match the current filter and search." />;

  return (
    <div className="tab-table">
      {windows.map((w) => (
        <div className="tab-window" key={w.windowId}>
          {w.groups.map((g) => {
            const tabIds = g.tabIds.filter((id) => visibleIds.has(id));
            if (tabIds.length === 0) return null;
            return (
              <div className="tab-group" data-testid={`group-${g.groupId}`} key={g.groupId}>
                <p className="tab-group-title">
                  {g.title || 'Group'}
                  {g.collapsed ? ' (collapsed — tabs inside may still be loaded)' : ''}
                </p>
                {tabIds.map((id) => {
                  const row = rowsById.get(id);
                  return row ? <Row key={id} row={row} onUnload={onUnload} /> : null;
                })}
              </div>
            );
          })}
          {w.ungroupedTabIds
            .filter((id) => visibleIds.has(id))
            .map((id) => {
              const row = rowsById.get(id);
              return row ? <Row key={id} row={row} onUnload={onUnload} /> : null;
            })}
        </div>
      ))}
    </div>
  );
}
