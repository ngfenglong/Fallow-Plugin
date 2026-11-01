// Type-only: erased at build time. See App.tsx for the full layering note.
import type { Settings } from '../../domain/types';
import { Switch } from '../components/Switch';
import { Panel } from '../components/Panel';
import { sendRequest } from '../client';

/** Same defensive formatting as the popup's: a fractional or boundary value must still render. */
function formatThresholdMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return 'Unknown';
  const rounded = Math.round(minutes * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} min`;
}

/**
 * Fallow's OWN settings (automation, threshold, protected sites, device-memory
 * monitoring) — not Chrome's settings and not an activity log. Those belong to Task 19,
 * parked, and are deliberately absent here.
 */
export function SettingsPanel({ settings }: { settings: Settings }) {
  return (
    <Panel title="Settings">
      <Switch
        label="Automatic unloading"
        checked={settings.automationEnabled}
        onChange={(next) => {
          void sendRequest({ type: 'UPDATE_SETTINGS', patch: { automationEnabled: next } });
        }}
      />
      <p>Threshold: {formatThresholdMinutes(settings.inactivityMinutes)}</p>
      <Switch
        label="Monitor device memory"
        checked={settings.deviceMemoryMonitoringEnabled}
        onChange={(next) => {
          void sendRequest({ type: 'UPDATE_SETTINGS', patch: { deviceMemoryMonitoringEnabled: next } });
        }}
      />
      {settings.protectedSites.length > 0 ? (
        <ul>
          {settings.protectedSites.map((site) => (
            // CARRY-FORWARD (Task 4): hostnames are stored punycode-normalised; showing the
            // stored form is acceptable here, not a defect (no pinned test asks for Unicode).
            <li key={site.hostname}>
              {site.hostname}
              {site.includeSubdomains ? ' (+ subdomains)' : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
