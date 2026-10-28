// Pure domain settings: no browser API access in this file.
// parseSettings must never throw: it is the only guard between corrupt storage
// and a dead service worker.
import type { Settings } from './types';
import { THRESHOLD_MIN, THRESHOLD_MAX } from './constants';
import { normalizeHostname } from './hostname';

type Site = Settings['protectedSites'][number];

const SHIPPED: Settings = {
  schemaVersion: 1,
  automationEnabled: false,
  inactivityMinutes: 15,
  protectPinned: true,
  protectedSites: [
    { hostname: 'chatgpt.com', includeSubdomains: false },
    { hostname: 'docs.google.com', includeSubdomains: false },
    { hostname: 'meet.google.com', includeSubdomains: false },
  ],
  deviceMemoryMonitoringEnabled: false,
};

// Deep-frozen: this object is exported and imported by other modules and tests, so a
// single push would otherwise poison every later parse. The fallback paths clone it.
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_SETTINGS: Settings = deepFreeze(SHIPPED);

function cloneSites(sites: readonly Site[]): Site[] {
  return sites.map((site) => ({ ...site }));
}

function cloneSettings(s: Settings): Settings {
  return { ...s, protectedSites: cloneSites(s.protectedSites) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reads an own property only, so inherited or prototype-polluted keys are ignored.
// A hostile getter or proxy is contained to its own field.
function readField<T>(
  raw: Record<string, unknown>,
  key: string,
  read: (value: unknown) => T | undefined,
): T | undefined {
  try {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
    return read(raw[key]);
  } catch {
    return undefined;
  }
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readThreshold(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= THRESHOLD_MIN && value <= THRESHOLD_MAX
    ? value
    : undefined;
}

// Invalid entries are dropped one by one. Duplicates collapse to one entry,
// keeping includeSubdomains: true if either copy asked for it, because the
// broader rule is the safer one to keep when the owner's intent is ambiguous.
function readSites(value: unknown): Site[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const merged = new Map<string, boolean>();
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const hostname = readField(entry, 'hostname', (v) => (typeof v === 'string' ? normalizeHostname(v) : null));
    if (hostname === null || hostname === undefined) continue;
    // A non-boolean includeSubdomains states no intention, so it takes the field
    // default (false) like any other invalid field. That does not conflict with the
    // broader-wins rule below, which compares two stated intentions. The result is
    // visible and correctable in the settings UI.
    const includeSubdomains = readField(entry, 'includeSubdomains', readBoolean) === true;
    merged.set(hostname, (merged.get(hostname) ?? false) || includeSubdomains);
  }
  // An empty array is a deliberate "no protections". A non-empty array with no
  // usable entry is corruption, so the caller falls back to the defaults.
  if (merged.size === 0 && value.length > 0) return undefined;
  return [...merged].map(([hostname, includeSubdomains]) => ({ hostname, includeSubdomains }));
}

export function parseSettings(raw: unknown): Settings {
  try {
    if (!isPlainObject(raw)) return cloneSettings(DEFAULT_SETTINGS);
    return {
      schemaVersion: 1,
      automationEnabled: readField(raw, 'automationEnabled', readBoolean) ?? DEFAULT_SETTINGS.automationEnabled,
      inactivityMinutes: readField(raw, 'inactivityMinutes', readThreshold) ?? DEFAULT_SETTINGS.inactivityMinutes,
      protectPinned: readField(raw, 'protectPinned', readBoolean) ?? DEFAULT_SETTINGS.protectPinned,
      protectedSites: readField(raw, 'protectedSites', readSites) ?? cloneSites(DEFAULT_SETTINGS.protectedSites),
      deviceMemoryMonitoringEnabled:
        readField(raw, 'deviceMemoryMonitoringEnabled', readBoolean) ?? DEFAULT_SETTINGS.deviceMemoryMonitoringEnabled,
    };
  } catch {
    return cloneSettings(DEFAULT_SETTINGS);
  }
}

// Applies only valid, known fields from the patch. schemaVersion is never patchable.
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  const next = parseSettings(current);
  try {
    if (!isPlainObject(patch)) return next;
    const automationEnabled = readField(patch, 'automationEnabled', readBoolean);
    if (automationEnabled !== undefined) next.automationEnabled = automationEnabled;
    const inactivityMinutes = readField(patch, 'inactivityMinutes', readThreshold);
    if (inactivityMinutes !== undefined) next.inactivityMinutes = inactivityMinutes;
    const protectPinned = readField(patch, 'protectPinned', readBoolean);
    if (protectPinned !== undefined) next.protectPinned = protectPinned;
    const protectedSites = readField(patch, 'protectedSites', readSites);
    if (protectedSites !== undefined) next.protectedSites = protectedSites;
    const deviceMemory = readField(patch, 'deviceMemoryMonitoringEnabled', readBoolean);
    if (deviceMemory !== undefined) next.deviceMemoryMonitoringEnabled = deviceMemory;
    return next;
  } catch {
    return next;
  }
}
