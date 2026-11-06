import { useState } from 'react';
// Type-only: platform/storage.ts is not subject to the ui/background layering guard (only
// background/ is), but the component only needs the shape, never a runtime value from there.
import type { HistoryEntry } from '../../platform/storage';
import { Panel } from '../components/Panel';
import { Button } from '../components/Button';
import { sendRequest } from '../client';
import {
  TRIGGER_LABELS, ACTIVITY_OUTCOME_TEXT, ACTIVITY_EXTERNAL_RESULT,
  CLEAR_HISTORY_LABEL, NO_HISTORY_TEXT, UNKNOWN_HOSTNAME_TEXT, DETAILS_LABEL,
  activityReasonText,
} from './chrome-settings-copy';

/**
 * Engineering plan §6/F-list: trigger, result and timestamp per row, with an expandable
 * reason, hostnames only (never a full URL -- HistoryEntry itself never carries one, see
 * platform/storage.ts), and a "Clear history" action. Entries are owned by the caller
 * (App.tsx fetches them via GET_HISTORY); this component only renders what it is given and
 * issues CLEAR_HISTORY itself when asked, then tells the caller via `onCleared` so it can
 * refetch.
 *
 * A12: a row whose trigger is 'external' means Chrome (or something else) unloaded the tab
 * on its own -- Fallow never claims credit for that, so it renders ACTIVITY_EXTERNAL_RESULT
 * regardless of the recorded outcome, instead of the normal confirmed/skipped/etc. wording.
 */
export function ActivityLog({
  entries, onCleared,
}: { entries: HistoryEntry[]; onCleared?: () => void }) {
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());

  function toggle(key: string) {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleClear() {
    void sendRequest({ type: 'CLEAR_HISTORY' }).then(() => onCleared?.()).catch(() => {
      // Best-effort: the owner can simply click it again; nothing else to show for this.
    });
  }

  return (
    <div data-testid="activity-log">
      <Panel title="Recent activity">
        <Button onClick={handleClear}>{CLEAR_HISTORY_LABEL}</Button>
        {entries.length === 0 ? (
          <p>{NO_HISTORY_TEXT}</p>
        ) : (
          <ul>
            {entries.map((entry, index) => {
              const key = `${entry.operationId}-${entry.sessionTabId}-${index}`;
              const resultText = entry.trigger === 'external'
                ? ACTIVITY_EXTERNAL_RESULT
                : ACTIVITY_OUTCOME_TEXT[entry.outcome];
              const isOpen = openKeys.has(key);
              return (
                <li key={key} data-testid="activity-row">
                  <span>{TRIGGER_LABELS[entry.trigger]}</span>
                  {' — '}
                  <span>{resultText}</span>
                  {' — '}
                  <span>{entry.hostname ?? UNKNOWN_HOSTNAME_TEXT}</span>
                  {' — '}
                  <time dateTime={new Date(entry.at).toISOString()}>
                    {new Date(entry.at).toLocaleString()}
                  </time>
                  {entry.reason !== undefined ? (
                    <>
                      {' '}
                      <Button aria-expanded={isOpen} onClick={() => toggle(key)}>{DETAILS_LABEL}</Button>
                      {isOpen ? <p>{activityReasonText(entry.reason)}</p> : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
