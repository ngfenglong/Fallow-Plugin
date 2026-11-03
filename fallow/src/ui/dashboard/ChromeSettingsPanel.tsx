import { Panel } from '../components/Panel';
import { Button } from '../components/Button';
import {
  CHROME_PERFORMANCE_SETTINGS_URL, SETTINGS_PANEL_TITLE, SETTINGS_PANEL_INTRO,
  OPEN_PERFORMANCE_SETTINGS_LABEL, COPYABLE_ADDRESS_PREFIX,
  MEMORY_SAVER_LABEL, MEMORY_SAVER_DESCRIPTION,
  KEEP_ACTIVE_LABEL, KEEP_ACTIVE_DESCRIPTION,
  ENERGY_SAVER_LABEL, ENERGY_SAVER_DESCRIPTION,
  PRELOAD_PAGES_LABEL, PRELOAD_PAGES_DESCRIPTION,
  TASK_MANAGER_LABEL, TASK_MANAGER_DESCRIPTION,
} from './chrome-settings-copy';

/**
 * Engineering plan F5: five rows of Chrome-settings assistance (Memory Saver, "Always keep
 * these sites active", Energy Saver, Preload pages, Chrome Task Manager). Each is a
 * user-clicked link plus a copyable address -- never an embedded settings page (no iframe
 * anywhere here) and never a fake on/off control for a setting this extension cannot read
 * (A24): no Switch, no checkbox, anywhere in this panel.
 *
 * The first four rows share one Chrome settings page (chrome://settings/performance) in
 * current Chrome, so there is one shared "Open" button and one copyable address, not one
 * per row -- Task Manager has no settings-page equivalent, so its row gives menu
 * instructions instead.
 */
export function ChromeSettingsPanel() {
  function handleOpenPerformanceSettings() {
    try {
      void chrome.tabs.create({ url: CHROME_PERFORMANCE_SETTINGS_URL });
    } catch {
      // The copyable address text below is the fallback when this call is unavailable or
      // blocked in the owner's environment.
    }
  }

  return (
    <div data-testid="settings-panel">
      <Panel title={SETTINGS_PANEL_TITLE}>
        <p>{SETTINGS_PANEL_INTRO}</p>
        <div>
          <Button onClick={handleOpenPerformanceSettings}>{OPEN_PERFORMANCE_SETTINGS_LABEL}</Button>
          <p>
            {COPYABLE_ADDRESS_PREFIX} <code>{CHROME_PERFORMANCE_SETTINGS_URL}</code>
          </p>
        </div>
        <div data-testid="settings-row-memory-saver">
          <h3>{MEMORY_SAVER_LABEL}</h3>
          <p>{MEMORY_SAVER_DESCRIPTION}</p>
        </div>
        <div data-testid="settings-row-keep-active">
          <h3>{KEEP_ACTIVE_LABEL}</h3>
          <p>{KEEP_ACTIVE_DESCRIPTION}</p>
        </div>
        <div data-testid="settings-row-energy-saver">
          <h3>{ENERGY_SAVER_LABEL}</h3>
          <p>{ENERGY_SAVER_DESCRIPTION}</p>
        </div>
        <div data-testid="settings-row-preload-pages">
          <h3>{PRELOAD_PAGES_LABEL}</h3>
          <p>{PRELOAD_PAGES_DESCRIPTION}</p>
        </div>
        <div data-testid="settings-row-task-manager">
          <h3>{TASK_MANAGER_LABEL}</h3>
          <p>{TASK_MANAGER_DESCRIPTION}</p>
        </div>
      </Panel>
    </div>
  );
}
