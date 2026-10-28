// Pure domain types: no browser API access in this file.
import type { ReasonCode } from './reason-codes';

export type LifecycleState = 'loaded' | 'loading' | 'unloaded';

export type TabFacts = {
  tabId: number; windowId: number; groupId: number;
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
export type UnloadResult = { tabId: number; outcome: UnloadOutcome; reason?: ReasonCode };
export type Trigger = 'manual-single' | 'manual-bulk' | 'automatic' | 'external';

// Defined here, not in Task 15, because Task 13's message union references it.
export type MemorySample = { at: number; capacityBytes: number; availableBytes: number };
