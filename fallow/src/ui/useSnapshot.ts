import { useEffect, useRef, useState } from 'react';
// Type-only: erased at build time (verified against the dist output; see the task report).
import type { Snapshot, TabRow } from '../background/inventory';
import { STATE_CHANGED_MESSAGE } from '../shared/messages';
import { sendRequest } from './client';

export type { TabRow } from '../background/inventory';
export type SnapshotView = Snapshot & { startupProblem: string | null };
export type SnapshotState = 'loading' | 'ready' | 'error';
export type SnapshotResult = { ok: true; snapshot: SnapshotView } | { ok: false };

/**
 * The refresh rules, free of React so each one is testable on its own.
 *
 * - Never polls. Work starts only when refresh() is called.
 * - Nothing is requested while the page is hidden. A refresh asked for then is remembered
 *   and issued once, when the page becomes visible (the hook calls refresh() on that event).
 * - At most one request is in flight. A refresh that arrives during one does not start a
 *   second: it collapses into a single trailing refresh, which starts only after the in-flight
 *   one settles. That trailing read begins after every coalesced notice, so it sees their
 *   changes, and two replies can never race to overwrite each other with an older snapshot.
 * - After dispose(), no result is delivered and nothing new starts.
 */
export function createSnapshotController(deps: {
  fetch: () => Promise<SnapshotView>;
  isVisible: () => boolean;
  onResult: (result: SnapshotResult) => void;
}): { refresh(): void; dispose(): void } {
  let inFlight = false;
  let wanted = false;
  let disposed = false;

  function start(): void {
    inFlight = true;
    wanted = false;
    let request: Promise<SnapshotView>;
    try {
      request = deps.fetch();
    } catch (e) {
      request = Promise.reject(e);
    }
    request.then(
      (snapshot) => settle({ ok: true, snapshot }),
      () => settle({ ok: false }),
    );
  }

  function settle(result: SnapshotResult): void {
    inFlight = false;
    if (disposed) return;
    deps.onResult(result);
    if (wanted && deps.isVisible()) start();
  }

  return {
    refresh() {
      if (disposed) return;
      if (inFlight || !deps.isVisible()) {
        wanted = true;
        return;
      }
      start();
    },
    dispose() {
      disposed = true;
    },
  };
}

function isStateChanged(message: unknown): boolean {
  return typeof message === 'object' && message !== null
    && (message as { type?: unknown }).type === STATE_CHANGED_MESSAGE.type;
}

export function useSnapshot(): {
  snapshot: SnapshotView | null;
  state: SnapshotState;
  refresh(): void;
} {
  const [snapshot, setSnapshot] = useState<SnapshotView | null>(null);
  const [state, setState] = useState<SnapshotState>('loading');
  const controllerRef = useRef<{ refresh(): void } | null>(null);

  useEffect(() => {
    const controller = createSnapshotController({
      fetch: () => sendRequest<SnapshotView>({ type: 'GET_SNAPSHOT' }),
      isVisible: () => document.visibilityState === 'visible',
      onResult: (result) => {
        if (result.ok) {
          setSnapshot(result.snapshot);
          setState('ready');
        } else {
          // A failed read must not leave the last snapshot looking current.
          setSnapshot(null);
          setState('error');
        }
      },
    });
    const onVisibility = () => {
      if (document.visibilityState === 'visible') controller.refresh();
    };
    const onMessage = (message: unknown) => {
      if (isStateChanged(message)) controller.refresh();
      return undefined;
    };
    controllerRef.current = controller;
    document.addEventListener('visibilitychange', onVisibility);
    chrome.runtime.onMessage.addListener(onMessage);
    controller.refresh();
    return () => {
      controller.dispose();
      controllerRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  return { snapshot, state, refresh: () => controllerRef.current?.refresh() };
}
