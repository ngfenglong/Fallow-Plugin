// The dashboard-held sampling lock — Review Focus 5: "sampling must not stop forever. A
// lock whose heartbeat is older than its timeout is reclaimed by another open dashboard."
// Per the design, the lock (like the ring buffer of samples it guards) lives in
// storage.session, never storage.local: it is a liveness token for this browser session,
// not durable state.
import { KEYS, type StorageArea } from './storage';

export interface SamplingLock {
  tryAcquire(holderId: string, now: number): Promise<boolean>;
  heartbeat(holderId: string, now: number): Promise<void>;
  release(holderId: string): Promise<void>;
}

type LockRecord = { holderId: string; expiresAt: number };

function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.holderId === 'string' && typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt);
}

export function createSamplingLock(area: StorageArea, timeoutMs: number): SamplingLock {
  // A storage failure or corrupt record reads as "no lock held" rather than throwing, so a
  // single bad read cannot wedge sampling forever either.
  async function read(): Promise<LockRecord | null> {
    try {
      const raw = await area.get(KEYS.memoryLock);
      return isLockRecord(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  return {
    async tryAcquire(holderId, now) {
      const current = await read();
      // Held by someone else whose lease has not yet expired: refused. Otherwise — free,
      // already ours, or the previous holder's heartbeat is older than the timeout — the
      // lock is (re)written to this holder. This is the only reclaim path: a dashboard that
      // stopped heartbeating (closed, crashed) never freezes sampling forever.
      if (current !== null && current.holderId !== holderId && current.expiresAt > now) {
        return false;
      }
      await area.set(KEYS.memoryLock, { holderId, expiresAt: now + timeoutMs } satisfies LockRecord);
      return true;
    },
    async heartbeat(holderId, now) {
      const current = await read();
      if (current === null || current.holderId !== holderId) return; // not ours to extend
      await area.set(KEYS.memoryLock, { holderId, expiresAt: now + timeoutMs } satisfies LockRecord);
    },
    async release(holderId) {
      const current = await read();
      if (current === null || current.holderId !== holderId) return; // not ours to free
      await area.remove(KEYS.memoryLock);
    },
  };
}
