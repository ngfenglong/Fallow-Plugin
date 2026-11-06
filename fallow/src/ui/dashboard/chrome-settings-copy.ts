// All shipped copy for the Chrome settings assistance panel (ChromeSettingsPanel) and the
// activity log (ActivityLog), as exported constants rather than inline JSX strings, so the
// copy-rules scan (Task 10/21 -- the forbidden-word checks in tests/unit/copy-rules.test.ts)
// can read every shipped string here in one place rather than hunting through component files.
//
// Engineering plan F5: each row is a user-clicked link plus a copyable address, never an
// embedded settings page and never a status switch for a setting Fallow cannot read. Memory
// Saver, "Always keep these sites active", Energy Saver and Preload pages all live on the
// same Chrome page in current Chrome versions, so this ships one shared shortcut rather than
// one per row.
import type { ReasonCode } from '../../domain/reason-codes';
import type { Trigger, UnloadOutcome } from '../../domain/types';

export const CHROME_PERFORMANCE_SETTINGS_URL = 'chrome://settings/performance';

export const SETTINGS_PANEL_TITLE = 'Chrome settings';

export const SETTINGS_PANEL_INTRO =
  'These are Chrome’s own settings, not Fallow’s. Fallow can open the right page for ' +
  'you, but it cannot turn any of these on or off, and it cannot read most of their current ' +
  'state.';

export const OPEN_PERFORMANCE_SETTINGS_LABEL = 'Open Chrome performance settings';

export const COPYABLE_ADDRESS_PREFIX = 'If that did not open, copy this address into a new tab:';

export const MEMORY_SAVER_LABEL = 'Memory Saver';
export const MEMORY_SAVER_DESCRIPTION =
  'Chrome can unload background tabs on its own to save memory; its state is not read by ' +
  'this extension, so Fallow has no way to show whether it is on.';

export const KEEP_ACTIVE_LABEL = 'Always keep these sites active';
export const KEEP_ACTIVE_DESCRIPTION =
  'Chrome keeps its own list of sites that Memory Saver will never unload, on the same ' +
  'settings page above. That list is independent from this extension’s protected sites ' +
  '— adding a site to one does not add it to the other.';

export const ENERGY_SAVER_LABEL = 'Energy Saver';
export const ENERGY_SAVER_DESCRIPTION =
  'Limits background activity and visual effects to extend battery life, from the same ' +
  'settings page above.';

export const PRELOAD_PAGES_LABEL = 'Preload pages';
export const PRELOAD_PAGES_DESCRIPTION =
  'Loads pages before you open them, also from the settings page above, which can make ' +
  'browsing feel faster at the cost of extra network and memory use — worth reviewing ' +
  'for your own tradeoff.';

export const TASK_MANAGER_LABEL = 'Chrome Task Manager';
export const TASK_MANAGER_DESCRIPTION =
  'On macOS, open it from the menu bar: Window > Task Manager. It lists memory and CPU use ' +
  'per tab and extension, separately from this dashboard.';

/** Trigger labels for the activity log, in the same vocabulary as the rest of the dashboard. */
export const TRIGGER_LABELS: Record<Trigger, string> = {
  'manual-single': 'Unload now (single tab)',
  'manual-bulk': 'Unload eligible tabs',
  automatic: 'Automatic',
  external: 'Observed, not requested by Fallow',
};

/**
 * Result copy for a Fallow-requested unload, keyed by outcome. Deliberately NOT used for an
 * externally-triggered row (see ACTIVITY_EXTERNAL_RESULT below): Fallow only confirms what it
 * asked Chrome to do, never claims an unload it did not request as its own doing, and the
 * wording below says "after request" for exactly that reason (A12/§7).
 */
export const ACTIVITY_OUTCOME_TEXT: Record<UnloadOutcome, string> = {
  confirmed: 'Unload confirmed after request.',
  'already-unloaded': 'Already unloaded by the time Fallow asked.',
  skipped: 'Skipped — not unloaded.',
  failed: 'Unload attempt failed.',
  unknown: 'Result unknown — Fallow could not confirm what happened.',
};

/**
 * Shown for any row whose trigger is 'external': Chrome (or something else) unloaded the tab
 * on its own, not Fallow, so the log reports only what was observed, never a cause it cannot
 * verify (A12).
 */
export const ACTIVITY_EXTERNAL_RESULT = 'Observed unload; source unknown';

export const CLEAR_HISTORY_LABEL = 'Clear history';
export const NO_HISTORY_TEXT = 'No activity yet.';
export const UNKNOWN_HOSTNAME_TEXT = 'Unknown site';
export const DETAILS_LABEL = 'Details';
export const NO_REASON_RECORDED_TEXT = 'No reason recorded.';

/**
 * Short, title-cased copy for a reason code in the activity log's expandable detail --
 * deliberately NOT domain/reason-codes.ts's reasonLabel(), which is the longer, more
 * explanatory copy used in the dashboard's main tab table. This one is just the code,
 * title-cased per word (e.g. 'AUDIBLE' -> 'Audible', 'TAB_PROTECTED' -> 'Tab Protected').
 */
export function activityReasonText(code: ReasonCode): string {
  return code
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}
