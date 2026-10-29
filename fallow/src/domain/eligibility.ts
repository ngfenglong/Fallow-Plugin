// Pure eligibility policy: no browser API access in this file.
// Decides whether a tab may be unloaded, and if not, every reason why.
import type { Decision, LifecycleState, Settings, TabActivity, TabFacts } from './types';
import type { ReasonCode } from './reason-codes';
import { sortReasons } from './reason-codes';
import { MANUAL_BULK_FLOOR_MS } from './constants';
import { hostnameOf, matchesProtectedSite } from './hostname';

export type EligibilityMode = 'auto' | 'manual-bulk' | 'manual-single';

export type EligibilityInput = {
  tab: TabFacts;
  settings: Settings;
  activity: TabActivity | null;
  mode: EligibilityMode;
  now: number;
  graceUntil: number | null;
  dashboardOriginTabIds: readonly number[];
};

// Milliseconds since the tab left the foreground. A clock that moved backward would
// otherwise make a tab read as used in the future, so a negative difference is 0
// ("just used"), which is the safe direction. A selected tab has no background time.
export function backgroundElapsedMs(activity: TabActivity | null, now: number): number {
  if (activity === null || activity.backgroundSince === null) return 0;
  return Math.max(0, now - activity.backgroundSince);
}

function isUnloaded(tab: TabFacts): boolean {
  return tab.discarded || tab.status === 'unloaded';
}

// A loading page counts as loaded, so Total = Loaded + Unloaded always reconciles.
export function lifecycleOf(tab: TabFacts): LifecycleState {
  if (isUnloaded(tab)) return 'unloaded';
  if (tab.status === 'loading') return 'loading';
  return 'loaded';
}

// Collects every applicable reason. The scope gate (UNSUPPORTED_URL) is evaluated
// first and independently of site protection: a null hostname means "never unload",
// not "no site matched".
export function decide(input: EligibilityInput): Decision {
  const { tab, settings, activity, mode, now, graceUntil, dashboardOriginTabIds } = input;
  const reasons: ReasonCode[] = [];

  const host = hostnameOf(tab.url);
  if (host === null) reasons.push('UNSUPPORTED_URL');

  if (tab.active) reasons.push('SELECTED');
  if (tab.audible) reasons.push('AUDIBLE');
  if (tab.status === 'loading') reasons.push('LOADING');
  if (activity !== null && activity.protectedForSession) reasons.push('TAB_PROTECTED');
  if (host !== null && matchesProtectedSite(host, settings.protectedSites)) reasons.push('SITE_PROTECTED');
  if (tab.pinned && settings.protectPinned) reasons.push('PINNED');
  if (!tab.autoDiscardable) reasons.push('BROWSER_PROTECTED');

  // Under auto the threshold is always >= the floor, so this rule could never change an
  // automatic decision; a single named tab is the owner naming that exact tab.
  if (mode === 'manual-bulk' && dashboardOriginTabIds.includes(tab.tabId)) reasons.push('DASHBOARD_ORIGIN');

  const elapsed = backgroundElapsedMs(activity, now);
  // The floor replaces the threshold's protection in the one mode that ignores it. Under
  // auto the threshold is >= THRESHOLD_MIN, which equals this floor, so the floor could
  // only ever add a redundant second reason there; it is therefore bulk-only.
  if (mode === 'manual-bulk' && elapsed < MANUAL_BULK_FLOOR_MS) reasons.push('USED_RECENTLY');
  if (mode === 'auto' && elapsed < settings.inactivityMinutes * 60_000) reasons.push('NOT_OLD_ENOUGH');

  // Grace stops an automatic cascade only; a manual action is the owner asking directly.
  if (mode === 'auto' && graceUntil !== null && now < graceUntil) reasons.push('STARTUP_GRACE');

  if (isUnloaded(tab)) reasons.push('ALREADY_UNLOADED');

  const ordered = sortReasons(reasons);
  return { eligible: ordered.length === 0, reasons: ordered, evaluatedAt: now };
}
