// Pure domain types: no browser API access in this file.
import type { ReasonCode } from './reason-codes';

export type LifecycleState = 'loaded' | 'loading' | 'unloaded';

export type TabFacts = {
  tabId: number; windowId: number; groupId: number;
  /** Position within the window, as the browser reports it; -1 when absent. */
  index: number;
  url: string; title: string;
  active: boolean; audible: boolean; pinned: boolean;
  discarded: boolean; autoDiscardable: boolean;
  status: 'loading' | 'complete' | 'unloaded';
};

export type Settings = {
  schemaVersion: 1;
  automationEnabled: boolean;
  inactivityMinutes: number;
  protectPinned: boolean;
  protectedSites: Array<{ hostname: string; includeSubdomains: boolean }>;
  deviceMemoryMonitoringEnabled: boolean;
};

export type TabActivity = { tabId: number; backgroundSince: number | null; protectedForSession: boolean };
export type Decision = { eligible: boolean; reasons: ReasonCode[]; evaluatedAt: number };
// 'unknown' is deliberate: a service worker killed mid-operation reports that it
// does not know what happened to a tab, rather than guessing 'confirmed' or 'failed'.
export type UnloadOutcome = 'confirmed' | 'already-unloaded' | 'skipped' | 'failed' | 'unknown';
// `tabId` is always the REQUESTED id: what the owner's action referenced and what the
// preview showed. A discard mints a new id (milestone 0), so when the browser returned a
// different one it travels separately in `newTabId`, which is absent when the id did not
// change. Never re-read a tab by the id you asked to discard.
export type UnloadResult = {
  tabId: number; outcome: UnloadOutcome; reason?: ReasonCode; newTabId?: number;
};
export type Trigger = 'manual-single' | 'manual-bulk' | 'automatic' | 'external';

// Defined here, not in Task 15, because Task 13's message union references it.
export type MemorySample = { at: number; capacityBytes: number; availableBytes: number };
