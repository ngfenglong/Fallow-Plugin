import type { TabRow } from '../useSnapshot';
import { Badge, type Tone } from './Badge';
import { EmptyState } from './EmptyState';

const LIFECYCLE: Record<TabRow['lifecycle'], { label: string; tone: Tone }> = {
  loaded: { label: 'Loaded', tone: 'ok' },
  loading: { label: 'Loading', tone: 'info' },
  unloaded: { label: 'Unloaded', tone: 'neutral' },
};

/**
 * Draws the rows it is given, in the order given. It neither filters nor sorts: that is
 * policy and presentation owned by the dashboard, not this layer. A tab title is rendered as
 * a text child, so markup in a title stays text (Review Focus 4).
 */
export function Table({ rows }: { rows: readonly TabRow[] }) {
  if (rows.length === 0) return <EmptyState title="No tabs to show." />;
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Tab</th>
          <th scope="col">Site</th>
          <th scope="col">State</th>
          <th scope="col">Flags</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const state = LIFECYCLE[row.lifecycle];
          return (
            <tr key={row.tabId}>
              <td>{row.title || 'Untitled tab'}</td>
              <td>{row.hostname ?? row.scheme ?? 'Unknown site'}</td>
              <td><Badge label={state.label} tone={state.tone} /></td>
              <td>
                {row.audible ? <Badge label="Audible" tone="warn" /> : null}
                {row.pinned ? <Badge label="Pinned" tone="neutral" /> : null}
                {row.selected ? <Badge label="Selected" tone="info" /> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
