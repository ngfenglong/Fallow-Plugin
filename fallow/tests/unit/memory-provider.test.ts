import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCapabilityRegistry,
  createDeviceMemoryProvider,
  formatBytes,
  formatDelta,
  summariseBeforeAfter,
  type CapabilityRegistry,
  type DeviceMemoryProvider,
} from '../../src/platform/memory-provider';
import { UNAVAILABLE_TEXT } from '../../src/domain/constants';
import { createFakeChrome, type FakeChrome } from '../fake-chrome';

let fake: FakeChrome;
let provider: DeviceMemoryProvider;

beforeEach(() => {
  fake = createFakeChrome();
  provider = createDeviceMemoryProvider(fake.api);
});

describe('createDeviceMemoryProvider', () => {
  it('reports unavailable and samples null without the optional permission', async () => {
    fake.permissions.granted = false;
    expect(await provider.isAvailable()).toBe(false);
    expect(await provider.sample()).toBe(null);
  });

  it('returns null rather than a zero sample when getInfo fails', async () => {
    fake.permissions.granted = true;
    fake.system.memory.throwOn = true;
    expect(await provider.sample()).toBe(null);
  });

  it('samples the real capacity and availability when permitted', async () => {
    fake.permissions.granted = true;
    fake.system.memory.capacity = 16_000_000_000;
    fake.system.memory.availableCapacity = 4_200_000_000;
    const sample = await provider.sample();
    expect(sample).toMatchObject({ capacityBytes: 16_000_000_000, availableBytes: 4_200_000_000 });
    expect(sample?.at).toBeTypeOf('number');
  });

  it('reports available once the permission is granted', async () => {
    fake.permissions.granted = true;
    expect(await provider.isAvailable()).toBe(true);
  });

  it('requests the optional permission only when asked, never at construction', () => {
    createDeviceMemoryProvider(fake.api);
    expect(fake.calls.permissionsRequest).toBe(0);
  });

  it('wraps chrome.permissions.request and reflects a granted prompt', async () => {
    fake.permissions.granted = false;
    const granted = await provider.requestPermission();
    expect(granted).toBe(true);
    expect(fake.calls.permissionsRequest).toBe(1);
    expect(await provider.isAvailable()).toBe(true);
  });

  it('wraps chrome.permissions.request and reflects a declined prompt', async () => {
    fake.permissions.granted = false;
    fake.permissions.grantOnRequest = false;
    const granted = await provider.requestPermission();
    expect(granted).toBe(false);
    expect(await provider.isAvailable()).toBe(false);
  });

  it('revokes the permission via chrome.permissions.remove', async () => {
    fake.permissions.granted = true;
    await provider.revoke();
    expect(await provider.isAvailable()).toBe(false);
  });
});

describe('formatBytes', () => {
  it('renders an absent figure as the spec string, never as zero', () => {
    expect(formatBytes(null)).toBe(UNAVAILABLE_TEXT);
    expect(formatBytes(null)).not.toMatch(/0/);
  });

  it('renders a real figure in GiB', () => {
    expect(formatBytes(16 * 1024 ** 3)).toMatch(/16(\.0)? GiB/);
  });
});

describe('formatDelta', () => {
  it('formats a delta with its sign', () => {
    expect(formatDelta(537_000_000)).toMatch(/^\+/);
    expect(formatDelta(-537_000_000)).toMatch(/^-/);
    expect(formatDelta(null)).toBe(UNAVAILABLE_TEXT);
  });
});

describe('summariseBeforeAfter', () => {
  it('reports a flat or negative change as a real measurement', () => {
    const s = summariseBeforeAfter(
      { at: 1, capacityBytes: 16e9, availableBytes: 4.2e9 },
      { at: 2, capacityBytes: 16e9, availableBytes: 4.0e9 },
    );
    expect(s.status).toBe('complete');
    expect(s.deltaBytes).toBeLessThan(0);
  });

  it('says the after sample is unavailable rather than inventing one', () => {
    expect(summariseBeforeAfter({ at: 1, capacityBytes: 16e9, availableBytes: 4.2e9 }, null)).toMatchObject({
      status: 'after-unavailable',
      deltaBytes: null,
    });
  });

  it('reports unavailable, not a delta, when the before sample itself is missing', () => {
    expect(summariseBeforeAfter(null, null)).toMatchObject({ status: 'unavailable', deltaBytes: null });
    expect(
      summariseBeforeAfter(null, { at: 1, capacityBytes: 16e9, availableBytes: 4.2e9 }),
    ).toMatchObject({ status: 'unavailable', deltaBytes: null });
  });
});

describe('createCapabilityRegistry', () => {
  let registry: CapabilityRegistry;
  beforeEach(() => {
    registry = createCapabilityRegistry([provider]);
  });

  it('exposes no process-level capability in this version', () => {
    expect(registry.get('processMemory')).toBeUndefined();
    expect(registry.get('deviceMemory')).toBeDefined();
  });

  it('lists only the registered keys', () => {
    expect(registry.keys()).toEqual(['deviceMemory']);
  });
});
