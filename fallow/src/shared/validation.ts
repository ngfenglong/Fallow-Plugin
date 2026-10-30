// Validates messages arriving from extension pages. This is the boundary between a UI page
// and the only code that can unload a tab, so every rule here refuses rather than coerces.
import type { Request } from './messages';
import type { Scope } from '../background/executor';
import type { EligibilityMode } from '../domain/eligibility';
import type { MemorySample } from '../domain/types';
import { isStorableOperationId } from '../platform/storage';

// Typed, not readonly string[]: an untyped copy of the literals lets the mode list drift
// away from EligibilityMode with the compiler saying nothing. This project has been bitten
// repeatedly by one rule defined twice.
const MODES: readonly EligibilityMode[] = ['auto', 'manual-bulk', 'manual-single'];

/** Longest requestId accepted. It is echoed in every Response, so it is bounded. */
export const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Most tab ids one scope may name. Well above any real tab count; it bounds the work a single
 * message can ask the executor to do.
 */
export const MAX_SCOPE_TAB_IDS = 1000;

/** Thrown internally for any refused field. parseRequest converts it into null. */
const REFUSED = new Error('refused');
function refuse(): never {
  throw REFUSED;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own property's value. A missing property is refused: the message is incomplete. */
function required(obj: object, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) refuse();
  return (obj as Record<string, unknown>)[key];
}

/** Refuses any own key outside the allowed list, symbols included. */
function onlyKeys(obj: object, allowed: readonly string[]): void {
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string' || !allowed.includes(key)) refuse();
  }
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseId(value: unknown): number {
  if (!isId(value)) refuse();
  return value;
}

function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_REQUEST_ID_LENGTH) refuse();
  return value;
}

/** An own property's value, or undefined when it is absent. */
function optional(obj: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * Refused outright, not replaced: the history layer drops every row of a batch whose id it
 * cannot store, so an unstorable id would unload tabs and log nothing.
 */
function parseOperationId(value: unknown): string {
  if (!isStorableOperationId(value)) refuse();
  return value;
}

/**
 * A set of tab ids: at least one, at most the cap, each a tab id, and no id twice. A duplicate
 * is refused rather than deduplicated, because it means the page built the list wrongly.
 */
function parseTabIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCOPE_TAB_IDS) refuse();
  const seen = new Set<number>();
  const tabIds: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const id = parseId(value[i]);
    if (seen.has(id)) refuse();
    seen.add(id);
    tabIds.push(id);
  }
  return tabIds;
}

/**
 * A real measurement: finite numbers, a positive capacity, and available memory that fits in
 * it. Anything else is refused, never coerced to zero, because a zero would read as a figure.
 */
function parseSample(value: unknown): MemorySample {
  if (!isRecord(value)) refuse();
  onlyKeys(value, ['at', 'capacityBytes', 'availableBytes']);
  const at = required(value, 'at');
  const capacityBytes = required(value, 'capacityBytes');
  const availableBytes = required(value, 'availableBytes');
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) refuse();
  if (typeof capacityBytes !== 'number' || !Number.isFinite(capacityBytes) || capacityBytes <= 0) refuse();
  if (typeof availableBytes !== 'number' || !Number.isFinite(availableBytes) || availableBytes < 0) refuse();
  if (availableBytes > capacityBytes) refuse();
  return { at, capacityBytes, availableBytes };
}

function parseScope(raw: unknown): Scope {
  if (!isRecord(raw)) refuse();
  switch (required(raw, 'kind')) {
    case 'tab':
      onlyKeys(raw, ['kind', 'tabId']);
      return { kind: 'tab', tabId: parseId(required(raw, 'tabId')) };
    case 'tabs': {
      onlyKeys(raw, ['kind', 'tabIds']);
      return { kind: 'tabs', tabIds: parseTabIds(required(raw, 'tabIds')) };
    }
    case 'window':
      onlyKeys(raw, ['kind', 'windowId']);
      return { kind: 'window', windowId: parseId(required(raw, 'windowId')) };
    case 'group':
      onlyKeys(raw, ['kind', 'groupId']);
      return { kind: 'group', groupId: parseId(required(raw, 'groupId')) };
    case 'all':
      onlyKeys(raw, ['kind']);
      return { kind: 'all' };
    default:
      return refuse();
  }
}

function isMode(value: string): value is EligibilityMode {
  return (MODES as readonly string[]).includes(value);
}

function parseMode(value: unknown): EligibilityMode {
  if (typeof value !== 'string' || !isMode(value)) refuse();
  return value;
}

/**
 * The scope and mode of an unload. manual-single skips the bulk-only reasons, so it is only
 * coherent for one tab. A one-element tab list is still a bulk selection and is refused too:
 * the rule is on the kind of scope, so the boundary never has to count.
 */
function parseUnloadTarget(raw: Record<string, unknown>): { scope: Scope; mode: EligibilityMode } {
  const scope = parseScope(required(raw, 'scope'));
  const mode = parseMode(required(raw, 'mode'));
  if (mode === 'manual-single' && scope.kind !== 'tab') refuse();
  return { scope, mode };
}

function parseInner(raw: unknown): Request {
  if (!isRecord(raw)) refuse();
  const type = required(raw, 'type');
  if (typeof type !== 'string') refuse();
  const requestId = parseRequestId(required(raw, 'requestId'));

  switch (type) {
    case 'GET_SNAPSHOT':
      onlyKeys(raw, ['type', 'requestId']);
      return { type, requestId };
    case 'UNLOAD_PREVIEW': {
      onlyKeys(raw, ['type', 'requestId', 'scope', 'mode']);
      const { scope, mode } = parseUnloadTarget(raw);
      return { type, requestId, scope, mode };
    }
    case 'SET_TAB_PROTECTION': {
      onlyKeys(raw, ['type', 'requestId', 'tabId', 'isProtected']);
      const isProtected = required(raw, 'isProtected');
      if (typeof isProtected !== 'boolean') refuse();
      return { type, requestId, tabId: parseId(required(raw, 'tabId')), isProtected };
    }
    case 'UNLOAD_EXECUTE': {
      onlyKeys(raw, ['type', 'requestId', 'scope', 'mode', 'operationId']);
      const { scope, mode } = parseUnloadTarget(raw);
      const operationId = optional(raw, 'operationId');
      if (operationId === undefined) return { type, requestId, scope, mode };
      return { type, requestId, scope, mode, operationId: parseOperationId(operationId) };
    }
    case 'UPDATE_SETTINGS': {
      onlyKeys(raw, ['type', 'requestId', 'patch']);
      // Presence only: parseSettings is the one validator of settings contents.
      const patch = required(raw, 'patch');
      if (patch === undefined || patch === null) refuse();
      return { type, requestId, patch };
    }
    case 'GET_HISTORY':
      onlyKeys(raw, ['type', 'requestId']);
      return { type, requestId };
    case 'CLEAR_HISTORY':
      onlyKeys(raw, ['type', 'requestId']);
      return { type, requestId };
    case 'REGISTER_DASHBOARD_ORIGIN': {
      onlyKeys(raw, ['type', 'requestId', 'originTabId']);
      // null means the dashboard was opened with no origin tab. A missing field is an
      // incomplete message and is refused, so the two never collapse into each other.
      const originTabId = required(raw, 'originTabId');
      return { type, requestId, originTabId: originTabId === null ? null : parseId(originTabId) };
    }
    case 'RECORD_MEMORY_SAMPLE':
      onlyKeys(raw, ['type', 'requestId', 'sample']);
      return { type, requestId, sample: parseSample(required(raw, 'sample')) };
    case 'CANCEL_BATCH':
      onlyKeys(raw, ['type', 'requestId', 'operationId']);
      return { type, requestId, operationId: parseOperationId(required(raw, 'operationId')) };
    default:
      return refuse();
  }
}

/** Returns the validated request, or null for anything unrecognised or malformed. Never throws. */
export function parseRequest(raw: unknown): Request | null {
  try {
    return parseInner(raw);
  } catch {
    return null;
  }
}

/**
 * Whether a message came from one of this extension's own pages. Both halves must hold: the
 * sender id is this extension's, and its URL sits under this extension's origin.
 */
export function isTrustedSender(sender: { id?: string; url?: string }, selfId: string): boolean {
  try {
    if (typeof selfId !== 'string' || selfId.length === 0 || !isRecord(sender)) return false;
    if (optional(sender, 'id') !== selfId) return false;
    const url = optional(sender, 'url');
    if (typeof url !== 'string' || !url.startsWith(`chrome-extension://${selfId}/`)) return false;
    // Canonical form only. Chrome reports sender URLs already normalised, so any change the
    // WHATWG parser would make (a dot segment, an upper-case scheme or host) is refused rather
    // than quietly corrected, and the origin the parser sees must be this extension's own.
    const parsed = new URL(url);
    return parsed.href === url && parsed.protocol === 'chrome-extension:' && parsed.host === selfId;
  } catch {
    return false;
  }
}
