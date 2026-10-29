// Pure eligibility policy: no browser API access in this file.
// Decides whether a tab may be unloaded, and if not, every reason why.
//
// Every check here fails closed. A value the engine cannot interpret (NaN time, unknown
// mode, non-positive threshold) produces a holding reason, never an eligible verdict.
import type { Decision, LifecycleState, Settings, TabActivity, TabFacts } from './types';
import type { ReasonCode } from './reason-codes';
import { sortReasons } from './reason-codes';
import { MANUAL_BULK_FLOOR_MS, THRESHOLD_MIN } from './constants';
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
// NaN (from a non-numeric or Infinity-minus-Infinity input) also reads as 0, so it holds.
// Infinity is kept: a tab idle forever is genuinely idle.
export function backgroundElapsedMs(activity: TabActivity | null, now: number): number {
  if (activity === null || activity.backgroundSince === null) return 0;
  const elapsed = now - activity.backgroundSince;
  if (Number.isNaN(elapsed)) return 0;
  return Math.max(0, elapsed);
}

function isUnloaded(tab: TabFacts): boolean {
  return tab.discarded || tab.status === 'unloaded';
}

// Returns 'loading' as its own state so the dashboard can show it. The consumer, not
// this function, reconciles counts: Total = Loaded + Unloaded, so a Task 10 count must
// fold 'loading' into 'loaded'.
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

  // Which mode-specific checks apply. The switch is exhaustive: a new mode is a compile
  // error here, and a runtime value outside the union holds the tab rather than passing it.
  let thresholdApplies = false;
  let floorApplies = false;
  let graceApplies = false;
  let dashboardApplies = false;
  switch (mode) {
    case 'auto':
      thresholdApplies = true;
      graceApplies = true;
      break;
    case 'manual-bulk':
      floorApplies = true;
      dashboardApplies = true;
      break;
    case 'manual-single':
      break;
    default: {
      const unknownMode: never = mode;
      void unknownMode;
      reasons.push('NOT_OLD_ENOUGH');
    }
  }

  // Protects the tab the owner used to open the dashboard from a bulk unload, so the
  // surface they are looking at is not removed under them. Inert under auto, and a
  // single named tab is the owner's direct request, so it is not protected there.
  if (dashboardApplies && dashboardOriginTabIds.includes(tab.tabId)) reasons.push('DASHBOARD_ORIGIN');

  // Written as a negation so a NaN comparison holds the tab instead of passing it.
  const elapsed = backgroundElapsedMs(activity, now);
  // The floor replaces the threshold's protection in the one mode that ignores it. Under
  // auto the threshold is >= THRESHOLD_MIN, which equals this floor, so the floor could
  // only ever add a redundant second reason there; it is therefore bulk-only.
  if (floorApplies && !(elapsed >= MANUAL_BULK_FLOOR_MS)) reasons.push('USED_RECENTLY');
  // Clamped to THRESHOLD_MIN: a zero, negative or non-finite threshold would otherwise
  // make every tab instantly eligible under automation. parseSettings enforces the range
  // too, but decide trusts its input.
  const thresholdMinutes = Number.isFinite(settings.inactivityMinutes)
    ? Math.max(THRESHOLD_MIN, settings.inactivityMinutes)
    : THRESHOLD_MIN;
  if (thresholdApplies && !(elapsed >= thresholdMinutes * 60_000)) reasons.push('NOT_OLD_ENOUGH');

  // Grace stops an automatic cascade only; a manual action is the owner asking directly.
  // Negated so a NaN clock holds the tab rather than letting the cascade through.
  if (graceApplies && graceUntil !== null && !(now >= graceUntil)) reasons.push('STARTUP_GRACE');

  if (isUnloaded(tab)) reasons.push('ALREADY_UNLOADED');

  const ordered = sortReasons(reasons);
  return { eligible: ordered.length === 0, reasons: ordered, evaluatedAt: now };
}
