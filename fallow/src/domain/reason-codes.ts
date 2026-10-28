// Pure domain vocabulary: no browser API access in this file.

// Canonical display order, most explanatory first. Do not re-sort alphabetically.
export const REASON_CODES = [
  'SELECTED',
  'AUDIBLE',
  'LOADING',
  'TAB_PROTECTED',
  'SITE_PROTECTED',
  'PINNED',
  'BROWSER_PROTECTED',
  'DASHBOARD_ORIGIN',
  'USED_RECENTLY',
  'NOT_OLD_ENOUGH',
  'STARTUP_GRACE',
  'UNSUPPORTED_URL',
  'ALREADY_UNLOADED',
  'TAB_GONE',
  'API_REJECTED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

// Record over the union is exhaustive: a missing code is a compile error.
const LABELS: Record<ReasonCode, string> = {
  SELECTED: 'Selected tab in its window',
  AUDIBLE: 'Playing audio',
  LOADING: 'Still loading',
  TAB_PROTECTED: 'Kept loaded by you (this session)',
  SITE_PROTECTED: 'Site is on your keep-loaded list',
  PINNED: 'Pinned tab (protected by your settings)',
  BROWSER_PROTECTED: 'Chrome is keeping this tab loaded',
  DASHBOARD_ORIGIN: 'Recently opened dashboard from this tab',
  USED_RECENTLY: 'Used just now',
  NOT_OLD_ENOUGH: 'Not unused long enough yet',
  STARTUP_GRACE: 'Brief pause after startup or a settings change',
  UNSUPPORTED_URL: 'Not an http or https page',
  ALREADY_UNLOADED: 'Already unloaded',
  TAB_GONE: 'Tab no longer exists',
  API_REJECTED: 'Browser declined the request',
};

export function reasonLabel(code: ReasonCode): string {
  return LABELS[code];
}

// Returns a new array ordered by canonical display rank. Duplicates are kept
// (adjacent). Array.prototype.sort is stable, so the result is deterministic.
export function sortReasons(codes: readonly ReasonCode[]): ReasonCode[] {
  const rank = (code: ReasonCode): number => REASON_CODES.indexOf(code);
  return [...codes].sort((a, b) => rank(a) - rank(b));
}
