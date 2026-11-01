// Message contracts between the extension's UI pages and the service worker. Types only:
// this file carries no runtime code and touches no browser API.
import type { Scope } from '../background/executor';
import type { EligibilityMode } from '../domain/eligibility';
import type { MemorySample } from '../domain/types';

export type Request =
  | { type: 'GET_SNAPSHOT'; requestId: string }
  | { type: 'UPDATE_SETTINGS'; requestId: string; patch: unknown }
  | { type: 'SET_TAB_PROTECTION'; requestId: string; tabId: number; isProtected: boolean }
  | { type: 'UNLOAD_PREVIEW'; requestId: string; scope: Scope; mode: EligibilityMode }
  | { type: 'UNLOAD_EXECUTE'; requestId: string; scope: Scope; mode: EligibilityMode; operationId?: string }
  | { type: 'CANCEL_BATCH'; requestId: string; operationId: string }
  | { type: 'GET_HISTORY'; requestId: string }
  | { type: 'CLEAR_HISTORY'; requestId: string }
  | { type: 'REGISTER_DASHBOARD_ORIGIN'; requestId: string; originTabId: number | null }
  | { type: 'RECORD_MEMORY_SAMPLE'; requestId: string; sample: MemorySample };

export type Response<T> =
  | { ok: true; requestId: string; data: T }
  | { ok: false; requestId: string; error: string };

/**
 * Pushed to open extension pages when what they show may have changed; a page refreshes
 * by asking for a snapshot. Carries no data. Lives here, not in background/index.ts: a UI
 * page may import a type from there, erased at build time, but importing a runtime VALUE
 * would pull in that module's side effects — constructing the worker and registering all
 * 15 chrome.* listeners a second time, inside the page.
 */
export const STATE_CHANGED_MESSAGE = { type: 'FALLOW_STATE_CHANGED' } as const;
