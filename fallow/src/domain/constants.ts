// Pure domain constants: no browser API access in this file.

export const MANUAL_BULK_FLOOR_MS = 60_000;      // design §8
export const STARTUP_GRACE_MS = 120_000;
export const AUTO_BATCH_MAX = 10;
export const MANUAL_CHUNK_SIZE = 10;
export const ALARM_NAME = 'fallow-eligibility-check';
export const ALARM_PERIOD_MINUTES = 1;
export const DISCARD_CONFIRM_TIMEOUT_MS = 2_000;
export const HISTORY_MAX_ENTRIES = 500;
export const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const MEMORY_SAMPLE_INTERVAL_MS = 5_000;
export const MEMORY_SAMPLE_MAX = 120;
export const MEMORY_AFTER_DELAY_MS = 10_000;
export const MEMORY_LOCK_TIMEOUT_MS = 15_000;
export const THRESHOLD_PRESETS = [1, 2, 5, 10, 15, 30, 60] as const;
export const THRESHOLD_MIN = 1;
export const THRESHOLD_MAX = 1_440;
export const UNAVAILABLE_TEXT = 'Not available in standalone mode';
