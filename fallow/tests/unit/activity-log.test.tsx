import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog } from '../../src/ui/dashboard/ActivityLog';
import type { HistoryEntry } from '../../src/platform/storage';

// Task 6 (originally plan Task 19). fireEvent, not @testing-library/user-event (see
// chrome-settings.test.tsx's own note for why). Own local fake-chrome harness: ActivityLog
// only ever touches chrome.runtime.sendMessage, for its "Clear history" button's
// CLEAR_HISTORY request -- it takes its entries as a prop, it does not fetch them itself
// (that is App.tsx's job, via GET_HISTORY).

type Responder = (message: any) => unknown;
let responder: Responder;

const fake = { lastRequest: null as any };

function ok(requestId: string, data: unknown) {
  return { ok: true, requestId, data };
}

function installChrome() {
  fake.lastRequest = null;
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn((message: any) => {
        fake.lastRequest = message;
        return responder(message);
      }),
      lastError: undefined,
    },
  });
}

beforeEach(() => {
  responder = (m) => ok(m.requestId, null);
  installChrome();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    at: 1_700_000_000_000,
    operationId: 'op-1',
    trigger: 'manual-single',
    sessionTabId: 1,
    hostname: 'example.com',
    outcome: 'confirmed',
    ...overrides,
  };
}

describe('ActivityLog', () => {
  it('shows trigger, result and timestamp with an expandable reason', () => {
    render(<ActivityLog entries={[entry({ trigger: 'manual-bulk', outcome: 'skipped', reason: 'AUDIBLE' })]} />);
    fireEvent.click(screen.getByRole('button', { name: /details/i }));
    expect(screen.getByText('Audible')).toBeInTheDocument();
  });

  it('describes an externally unloaded tab without claiming credit', () => {
    render(<ActivityLog entries={[entry({ trigger: 'external', outcome: 'confirmed' })]} />);
    expect(screen.getByText('Observed unload; source unknown')).toBeInTheDocument();
  });

  it('words a confirmed unload as confirmed after request, not as sole cause', () => {
    render(<ActivityLog entries={[entry({ trigger: 'manual-bulk', outcome: 'confirmed' })]} />);
    expect(screen.getByText(/Unload confirmed after request/i)).toBeInTheDocument();
  });

  it('shows hostnames and never a full url', () => {
    render(<ActivityLog entries={[entry({ hostname: 'example.com' })]} />);
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.queryByText(/https:\/\//)).toBe(null);
  });

  it('clears history on request', () => {
    render(<ActivityLog entries={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /clear history/i }));
    expect(fake.lastRequest).toMatchObject({ type: 'CLEAR_HISTORY' });
  });
});
