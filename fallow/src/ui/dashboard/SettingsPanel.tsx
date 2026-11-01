// Type-only: erased at build time. See App.tsx for the full layering note.
import type { Settings } from '../../domain/types';
import { Switch } from '../components/Switch';
import { Panel } from '../components/Panel';
import { ThresholdInput } from '../components/ThresholdInput';
import { sendRequest } from '../client';

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
      <p className="settings-help">
        Turning this on only means Fallow checks how long tabs have sat idle — it doesn't keep tabs loaded or use extra memory itself.
      </p>
      <ThresholdInput
        minutes={settings.inactivityMinutes}
        onCommit={(next) => {
          void sendRequest({ type: 'UPDATE_SETTINGS', patch: { inactivityMinutes: next } });
        }}
      />
      <p className="settings-help">
        Automatic unloading waits this long after you stop using a tab before it unloads it.
      </p>
      <div className="settings-help">
        <p><strong>How unloading works</strong></p>
        <p><strong>Automatic</strong> — waits until a tab has been idle for the threshold above.</p>
        <p><strong>Unload eligible tabs</strong> (the button at the top) — waits until a tab has been idle for at least 1 minute.</p>
        <p><strong>Unload now</strong>, on a single tab — no minimum wait; only a pinned, playing, selected, or protected tab is skipped.</p>
      </div>
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
