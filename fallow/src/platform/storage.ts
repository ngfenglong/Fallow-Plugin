// Storage repositories over a two-method StorageArea. Every read tolerates any stored
// value: corruption yields the documented empty value, never a throw, so a worker
// initialisation cannot be killed by bad data. Settings are only ever returned after
// parseSettings, which later components rely on as a precondition.
import { DEFAULT_SETTINGS, parseSettings } from '../domain/settings';
import { HISTORY_MAX_AGE_MS, HISTORY_MAX_ENTRIES } from '../domain/constants';
import { REASON_CODES, type ReasonCode } from '../domain/reason-codes';
import type { Settings, TabActivity, Trigger, UnloadOutcome } from '../domain/types';

export const KEYS = {
  settings: 'fallow.settings',
  history: 'fallow.history',
  activity: 'fallow.activity',
  session: 'fallow.session',
  batch: 'fallow.batch',
  memorySamples: 'fallow.memory.samples',
  memoryLock: 'fallow.memory.lock',
  dashboardOrigins: 'fallow.dashboardOrigins',
} as const;

// Privacy: a row holds a hostname and a session tab id, never a page title or a URL.
export type HistoryEntry = {
  at: number; operationId: string; trigger: Trigger;
  sessionTabId: number; hostname: string | null;
  outcome: UnloadOutcome; reason?: ReasonCode;
};
export type SessionState = { discoveredAt: number; graceUntil: number | null };

export interface SettingsRepo { read(): Promise<Settings>; write(s: Settings): Promise<void>; }
export interface ActivityRepo {
  readAll(): Promise<Record<number, TabActivity>>;
  writeAll(map: Record<number, TabActivity>): Promise<void>;
}
export interface SessionRepo { read(): Promise<SessionState | null>; write(s: SessionState): Promise<void>; }
export interface HistoryRepo {
  append(entries: readonly HistoryEntry[], now: number): Promise<void>;
  read(): Promise<HistoryEntry[]>;
  clear(): Promise<void>;
}
export interface StorageArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const TRIGGERS: readonly Trigger[] = ['manual-single', 'manual-bulk', 'automatic', 'external'];
const OUTCOMES: readonly UnloadOutcome[] = ['confirmed', 'already-unloaded', 'skipped', 'failed', 'unknown'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

// Own properties only, so inherited keys never leak into a record. A throwing getter
// propagates to the caller's try/catch and discards only that record.
function own(raw: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;
}

function parseActivityRecord(raw: Record<string, unknown>, key: string): TabActivity | undefined {
  try {
    const value = own(raw, key);
    if (!isPlainObject(value)) return undefined;
    const tabId = own(value, 'tabId');
    const backgroundSince = own(value, 'backgroundSince');
    const protectedForSession = own(value, 'protectedForSession');
    // The record must describe the tab its key names, so a mislabelled record cannot
    // be attributed to another tab. String(tabId) === key also rejects '01' and '1.0'.
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || String(tabId) !== key) return undefined;
    if (!(backgroundSince === null || isFiniteNumber(backgroundSince))) return undefined;
    if (typeof protectedForSession !== 'boolean') return undefined;
    return { tabId, backgroundSince, protectedForSession };
  } catch {
    return undefined;
  }
}

function sanitizeActivity(raw: unknown): Record<number, TabActivity> {
  const out: Record<number, TabActivity> = {};
  try {
    if (!isPlainObject(raw)) return out;
    for (const key of Object.keys(raw)) {
      const record = parseActivityRecord(raw, key);
      if (record) out[record.tabId] = record;
    }
  } catch {
    // Keep whatever was accepted before the failure; the rest is treated as absent.
  }
  return out;
}

function parseSession(raw: unknown): SessionState | null {
  try {
    if (!isPlainObject(raw)) return null;
    const discoveredAt = own(raw, 'discoveredAt');
    const graceUntil = own(raw, 'graceUntil');
    if (!isFiniteNumber(discoveredAt)) return null;
    if (!(graceUntil === null || isFiniteNumber(graceUntil))) return null;
    return { discoveredAt, graceUntil };
  } catch {
    return null;
  }
}

// Builds a fresh row from known fields only, so nothing outside the schema is ever
// stored. An invalid row yields undefined and is dropped on its own.
function parseHistoryRow(raw: unknown): HistoryEntry | undefined {
  try {
    if (!isPlainObject(raw)) return undefined;
    const at = own(raw, 'at');
    const operationId = own(raw, 'operationId');
    const trigger = own(raw, 'trigger');
    const sessionTabId = own(raw, 'sessionTabId');
    const hostname = own(raw, 'hostname');
    const outcome = own(raw, 'outcome');
    const reason = own(raw, 'reason');
    if (!isFiniteNumber(at) || typeof operationId !== 'string') return undefined;
    if (!isOneOf(TRIGGERS, trigger) || !isOneOf(OUTCOMES, outcome)) return undefined;
    if (!isFiniteNumber(sessionTabId) || !(hostname === null || typeof hostname === 'string')) return undefined;
    if (reason !== undefined && !isOneOf(REASON_CODES, reason)) return undefined;
    const row: HistoryEntry = { at, operationId, trigger, sessionTabId, hostname, outcome };
    if (reason !== undefined) row.reason = reason;
    return row;
  } catch {
    return undefined;
  }
}

function parseHistory(raw: unknown): HistoryEntry[] {
  try {
    if (!Array.isArray(raw)) return [];
    const rows: HistoryEntry[] = [];
    for (const item of raw) {
      const row = parseHistoryRow(item);
      if (row) rows.push(row);
    }
    return rows.slice(0, HISTORY_MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function createRepos(areas: { local: StorageArea; session: StorageArea }): {
  settings: SettingsRepo; activity: ActivityRepo; session: SessionRepo; history: HistoryRepo;
} {
  const { local, session } = areas;

  const settings: SettingsRepo = {
    async read() {
      let raw: unknown;
      try {
        raw = await local.get(KEYS.settings);
      } catch {
        raw = undefined;
      }
      // The only way settings leave this module. parseSettings never throws and
      // returns normalised, clamped values, or the defaults for anything unusable.
      return parseSettings(raw);
    },
    async write(s) {
      await local.set(KEYS.settings, parseSettings(s));
    },
  };

  const activity: ActivityRepo = {
    async readAll() {
      let raw: unknown;
      try {
        raw = await session.get(KEYS.activity);
      } catch {
        raw = undefined;
      }
      return sanitizeActivity(raw);
    },
    async writeAll(map) {
      await session.set(KEYS.activity, sanitizeActivity(map));
    },
  };

  const sessionRepo: SessionRepo = {
    async read() {
      let raw: unknown;
      try {
        raw = await session.get(KEYS.session);
      } catch {
        raw = undefined;
      }
      return parseSession(raw);
    },
    async write(s) {
      await session.set(KEYS.session, { discoveredAt: s.discoveredAt, graceUntil: s.graceUntil });
    },
  };

  const history: HistoryRepo = {
    // One read and one write per call, whatever the number of entries. Age is applied
    // first, then the newest-first count cap. History is lossy by design, so this never
    // rejects: it runs inside the unload executor, and a log write must not abort the
    // tab operation that triggered it. A failed read skips the write entirely, so
    // existing history is never overwritten with only the new batch.
    async append(entries, now) {
      let kept: HistoryEntry[];
      try {
        if (entries.length === 0) return;
        const existing = parseHistory(await local.get(KEYS.history));
        const incoming = entries.map(parseHistoryRow).filter((row): row is HistoryEntry => row !== undefined);
        // A non-finite now skips the age trim only; the count cap still applies.
        const cutoff = Number.isFinite(now) ? now - HISTORY_MAX_AGE_MS : Number.NEGATIVE_INFINITY;
        kept = [...incoming, ...existing]
          .filter((row) => row.at >= cutoff)
          .sort((a, b) => b.at - a.at)
          .slice(0, HISTORY_MAX_ENTRIES);
      } catch {
        return;
      }
      try {
        await local.set(KEYS.history, kept);
      } catch {
        // Dropping one batch is acceptable; the existing log is untouched.
      }
    },
    async read() {
      let raw: unknown;
      try {
        raw = await local.get(KEYS.history);
      } catch {
        raw = undefined;
      }
      return parseHistory(raw);
    },
    async clear() {
      try {
        await local.set(KEYS.history, []);
      } catch {
        // Never throws into the caller, for the same reason as append.
      }
    },
  };

  return { settings, activity, session: sessionRepo, history };
}

// Bridges a real chrome.storage area to StorageArea. get rejects when Chrome cannot
// read, so the caller can tell "absent" (undefined) from "could not read" and never
// overwrite stored data it could not see. set resolves on failure, because every write
// through the repositories is lossy by design. Note: chrome.storage.session has a
// smaller quota than local, and session activity records are its main consumer.
export function createChromeStorageArea(area: chrome.storage.StorageArea): StorageArea {
  return {
    async get(key) {
      const items: Record<string, unknown> | undefined = await area.get(key);
      return items?.[key];
    },
    async set(key, value) {
      try {
        await area.set({ [key]: value });
      } catch {
        // Lossy by design: the caller is not told, and the stored value is unchanged.
      }
    },
  };
}
