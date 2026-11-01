import { beforeEach, describe, expect, it } from 'vitest';
import { createSamplingLock, type SamplingLock } from '../../src/platform/sampling-lock';
import { MEMORY_LOCK_TIMEOUT_MS } from '../../src/domain/constants';
import { createFakeStorage, type FakeStorage } from '../fake-storage';

let fake: FakeStorage;
let lock: SamplingLock;

beforeEach(() => {
  fake = createFakeStorage();
  lock = createSamplingLock(fake.session, MEMORY_LOCK_TIMEOUT_MS);
});

describe('createSamplingLock', () => {
  it('lets only one holder sample at a time', async () => {
    expect(await lock.tryAcquire('a', 0)).toBe(true);
    expect(await lock.tryAcquire('b', 1_000)).toBe(false);
  });

  it('lets another dashboard reclaim a lock whose holder stopped heartbeating', async () => {
    await lock.tryAcquire('a', 0);
    expect(await lock.tryAcquire('b', MEMORY_LOCK_TIMEOUT_MS - 1)).toBe(false);
    expect(await lock.tryAcquire('b', MEMORY_LOCK_TIMEOUT_MS + 1)).toBe(true);
  });

  it('frees the lock immediately on release', async () => {
    await lock.tryAcquire('a', 0);
    await lock.release('a');
    expect(await lock.tryAcquire('b', 1)).toBe(true);
  });

  it('ignores a release from a holder that does not own the lock', async () => {
    await lock.tryAcquire('a', 0);
    await lock.release('b');
    expect(await lock.tryAcquire('b', 1)).toBe(false);
  });

  it('extends the holder lease on heartbeat', async () => {
    await lock.tryAcquire('a', 0);
    await lock.heartbeat('a', MEMORY_LOCK_TIMEOUT_MS - 1);
    expect(await lock.tryAcquire('b', MEMORY_LOCK_TIMEOUT_MS + 1)).toBe(false);
  });

  it('lets the same holder re-acquire its own lock before expiry', async () => {
    await lock.tryAcquire('a', 0);
    expect(await lock.tryAcquire('a', 1)).toBe(true);
  });

  it('ignores a heartbeat from a holder that does not own the lock', async () => {
    await lock.tryAcquire('a', 0);
    await lock.heartbeat('b', 1);
    // 'a' still owns the lock, so it is only reclaimable once 'a's original lease expires.
    expect(await lock.tryAcquire('b', MEMORY_LOCK_TIMEOUT_MS + 1)).toBe(true);
  });

  it('does not acquire or release across different storage areas', async () => {
    const other = createSamplingLock(fake.local, MEMORY_LOCK_TIMEOUT_MS);
    expect(await lock.tryAcquire('a', 0)).toBe(true);
    expect(await other.tryAcquire('b', 0)).toBe(true);
  });
});
