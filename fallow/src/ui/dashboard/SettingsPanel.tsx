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
export function SettingsPanel({
  settings, onSaveFailed, onSaveSucceeded,
}: {
  settings: Settings;
  onSaveFailed: (message: string) => void;
  /** Final-review fix: a prior failed commit's alert must not outlive a later successful
   *  one -- called right after a threshold commit actually saves, so App.tsx can clear it. */
  onSaveSucceeded: () => void;
}) {
  return (
    <Panel title="Settings" id="settings">
      <Switch
        label="Automatic unloading"
        checked={settings.automationEnabled}
        onChange={(next) => {
          void sendRequest({ type: 'UPDATE_SETTINGS', patch: { automationEnabled: next } });
        }}
      />
      <p className="settings-help">
        Turning this on only means Fallow keeps track of how long each tab has been idle; it doesn't use extra memory itself.
      </p>
      <ThresholdInput
        minutes={settings.inactivityMinutes}
        onCommit={async (next) => {
          try {
            await sendRequest({ type: 'UPDATE_SETTINGS', patch: { inactivityMinutes: next } });
            onSaveSucceeded();
          } catch {
            onSaveFailed('Fallow could not save the new threshold. It still shows the old value.');
            throw new Error('revert'); // rethrown so ThresholdInput's commit() reverts its draft
          }
        }}
      />
      <p className="settings-help">
        Automatic unloading waits this long after you stop using a tab before it unloads it.
      </p>
      <div className="settings-help">
        <p><strong>How unloading works</strong></p>
        <p><strong>Automatic</strong> — waits until a tab has been idle for the threshold above.</p>
        <p><strong>Unload eligible tabs</strong> (the button at the top) — waits until a tab has been idle for at least 1 minute.</p>
        <p><strong>Unload now</strong>, on a single tab — no minimum wait; skipped only if the tab is pinned, playing audio, currently selected, kept loaded, site-protected, already unloaded, still loading, or one Chrome itself protects.</p>
      </div>
      <Switch
        label="Monitor device memory"
        checked={settings.deviceMemoryMonitoringEnabled}
        onChange={(next) => {
          void sendRequest({ type: 'UPDATE_SETTINGS', patch: { deviceMemoryMonitoringEnabled: next } });
        }}
      />
      {settings.protectedSites.length > 0 ? (
        <>
          <p className="settings-help"><strong>Protected sites</strong> — Fallow never unloads a tab on these sites.</p>
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
        </>
      ) : null}
    </Panel>
  );
}
