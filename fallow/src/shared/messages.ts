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
