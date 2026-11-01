// The device-memory capability boundary. Runs in the dashboard page, never the service
// worker — per design §11.4 the dashboard holding the sampling lock samples itself
// (Task 15); the worker explicitly refuses RECORD_MEMORY_SAMPLE. Like chrome-adapter.ts,
// this is a carve-out from "nothing outside src/ui/ touches the chrome namespace"
// (Ruling P3): it may reference chrome.permissions and chrome.system.memory, injected the
// same way as createChromeAdapter.
import type { MemorySample } from '../domain/types';
import { UNAVAILABLE_TEXT } from '../domain/constants';

export type CapabilityKey = 'tabLifecycle' | 'deviceMemory' | 'processCpu' | 'processMemory' | 'osSwap';
// MemorySample is imported from domain/types (Task 3), not redefined here.

export interface CapabilityProvider {
  readonly key: CapabilityKey;
  isAvailable(): Promise<boolean>;
}

export interface DeviceMemoryProvider extends CapabilityProvider {
  readonly key: 'deviceMemory';
  sample(): Promise<MemorySample | null>;
  requestPermission(): Promise<boolean>;
  revoke(): Promise<void>;
}

// "system.memory" is declared in manifest.json's optional_permissions, never permissions,
// so it starts ungranted and must be asked for via requestPermission().
const SYSTEM_MEMORY_PERMISSION = { permissions: ['system.memory'] } as chrome.permissions.Permissions;

export function createDeviceMemoryProvider(api: typeof chrome): DeviceMemoryProvider {
  // Never throws: a failed contains() check means the capability is unavailable, not that
  // the caller sees an exception.
  async function hasPermission(): Promise<boolean> {
    try {
      return await api.permissions.contains(SYSTEM_MEMORY_PERMISSION);
    } catch {
      return false;
    }
  }

  return {
    key: 'deviceMemory',
    isAvailable() {
      return hasPermission();
    },
    // Never returns a zero sample: missing permission or a failed call both yield null, so
    // nothing downstream can mistake "unmeasured" for "zero bytes free".
    async sample() {
      if (!(await hasPermission())) return null;
      try {
        const info = await api.system.memory.getInfo();
        return { at: Date.now(), capacityBytes: info.capacity, availableBytes: info.availableCapacity };
      } catch {
        return null;
      }
    },
    // Wraps chrome.permissions.request and nothing else. Must only be invoked from a
    // user-gesture handler (Chrome itself enforces this); this provider never calls it
    // except in direct response to that call, never at construction.
    async requestPermission() {
      try {
        return await api.permissions.request(SYSTEM_MEMORY_PERMISSION);
      } catch {
        return false;
      }
    },
    async revoke() {
      try {
        await api.permissions.remove(SYSTEM_MEMORY_PERMISSION);
      } catch {
        // Nothing to report: the capability is still gated by isAvailable() either way.
      }
    },
  };
}

export interface CapabilityRegistry {
  get(key: CapabilityKey): CapabilityProvider | undefined;
  keys(): CapabilityKey[];
}

// processMemory has no implementation in this version: it is simply absent from any
// registry built here, never registered with a stub, so design §2 can add it later
// without a prior "registered but broken" entry to clean up.
export function createCapabilityRegistry(providers: readonly CapabilityProvider[]): CapabilityRegistry {
  const byKey = new Map<CapabilityKey, CapabilityProvider>();
  for (const provider of providers) byKey.set(provider.key, provider);
  return {
    get(key) {
      return byKey.get(key);
    },
    keys() {
      return [...byKey.keys()];
    },
  };
}

export type BeforeAfter = {
  before: MemorySample | null;
  after: MemorySample | null;
  deltaBytes: number | null;
  status: 'complete' | 'after-unavailable' | 'unavailable';
};

// A flat or negative delta is a real measurement, not a missing one (design §11.1): only
// an absent sample yields status !== 'complete'. `before` missing makes the whole
// comparison unavailable; `after` missing alone is reported as its own status so a caller
// does not invent a result for the half it does not have (design §7).
export function summariseBeforeAfter(before: MemorySample | null, after: MemorySample | null): BeforeAfter {
  if (before === null) return { before, after, deltaBytes: null, status: 'unavailable' };
  if (after === null) return { before, after, deltaBytes: null, status: 'after-unavailable' };
  return { before, after, deltaBytes: after.availableBytes - before.availableBytes, status: 'complete' };
}

const BYTES_PER_GIB = 1024 ** 3;

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return UNAVAILABLE_TEXT;
  return `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`;
}

export function formatDelta(deltaBytes: number | null): string {
  if (deltaBytes === null) return UNAVAILABLE_TEXT;
  const sign = deltaBytes >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(deltaBytes) / BYTES_PER_GIB).toFixed(1)} GiB`;
}
