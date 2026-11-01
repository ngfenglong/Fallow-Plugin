import { useEffect, useState } from 'react';
import type { BeforeAfter, DeviceMemoryProvider } from '../../platform/memory-provider';
import { formatBytes, formatDelta } from '../../platform/memory-provider';
import { Panel } from '../components/Panel';
import { Button } from '../components/Button';

type Status = 'checking' | 'unavailable' | 'available';

/**
 * Milestone 0 (design §11.1): measured discard deltas beat the control's noise floor by
 * 35-111x, so this is a primary panel, not a collapsed curiosity — shown whenever the
 * owner has turned device-memory monitoring on, never shown otherwise (brief: "only once
 * the owner enables it").
 *
 * `isAvailable()`/`sample()` are read-only checks and run automatically on mount/enable.
 * `requestPermission()` is the one call that triggers a real OS/browser permission prompt,
 * so it fires ONLY from this component's own button click, never from an effect (Task 15's
 * own rule, restated in the brief).
 */
export function MemoryPanel({
  enabled, provider, delta,
}: { enabled: boolean; provider: DeviceMemoryProvider; delta: BeforeAfter | null }) {
  const [status, setStatus] = useState<Status>('checking');
  const [availableBytes, setAvailableBytes] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setStatus('checking');
    void (async () => {
      const available = await provider.isAvailable();
      if (cancelled) return;
      if (!available) {
        setStatus('unavailable');
        return;
      }
      const sample = await provider.sample();
      if (cancelled) return;
      if (sample === null) {
        setStatus('unavailable');
      } else {
        setAvailableBytes(sample.availableBytes);
        setStatus('available');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, provider]);

  // "Available" follows the same reading "Freed" is computed from, so a new complete delta
  // moves it on, not just the reading taken on mount/enable.
  useEffect(() => {
    if (delta !== null && delta.status === 'complete') {
      setAvailableBytes(delta.after!.availableBytes);
    }
  }, [delta]);

  if (!enabled) return null;

  async function handleEnablePermission() {
    const granted = await provider.requestPermission();
    if (!granted) return;
    const sample = await provider.sample();
    if (sample === null) {
      setStatus('unavailable');
    } else {
      setAvailableBytes(sample.availableBytes);
      setStatus('available');
    }
  }

  return (
    <div data-testid="memory-panel">
      <Panel title="Device memory">
        <p>
          This reflects your whole device&apos;s available memory, not just Chrome. Other
          applications and OS caching can affect this measurement.
        </p>
        <p>
          Available: <span data-testid="memory-available">{formatBytes(availableBytes)}</span>
        </p>
        {delta !== null && delta.status === 'complete' ? (
          <p>
            Freed:{' '}
            {delta.deltaBytes !== null && delta.deltaBytes < 0 ? (
              <span data-testid="memory-freed">
                little or none — device memory moved up slightly during the reading
              </span>
            ) : (
              <span data-testid="memory-freed">{formatDelta(delta.deltaBytes)}</span>
            )}
          </p>
        ) : null}
        <p>A reading for just Chrome&apos;s own usage is planned for a later update.</p>
        {status === 'unavailable' ? (
          <Button onClick={handleEnablePermission}>Enable device memory</Button>
        ) : null}
      </Panel>
    </div>
  );
}
