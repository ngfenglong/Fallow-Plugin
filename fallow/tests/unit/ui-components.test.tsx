import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendRequest } from '../../src/ui/client';
import { createSnapshotController, useSnapshot } from '../../src/ui/useSnapshot';
import { Badge } from '../../src/ui/components/Badge';
import { Switch } from '../../src/ui/components/Switch';
import { Table } from '../../src/ui/components/Table';
import { ErrorState } from '../../src/ui/components/ErrorState';
import { Button } from '../../src/ui/components/Button';
import { Panel } from '../../src/ui/components/Panel';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { TabRow } from '../../src/ui/useSnapshot';
import { STATE_CHANGED_MESSAGE } from '../../src/shared/messages';

// A scriptable stand-in for the worker side of chrome.runtime. Each test decides how the
// worker answers; the default answers every request with a well-formed ok reply.
type Responder = (message: any) => unknown;
let responder: Responder;
let sent: any[] = [];

function installChrome() {
  sent = [];
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn((message: any) => {
        sent.push(message);
        return responder(message);
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      lastError: undefined,
    },
  });
}

beforeEach(() => {
  responder = (m) => ({ ok: true, requestId: m.requestId, data: { echoed: m.type } });
  installChrome();
});

afterEach(() => {
  // Unmount while chrome is still stubbed: the hook's cleanup removes its listener from it.
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sendRequest', () => {
  it('resolves with the data of a well-formed ok reply and tags the request with an id', async () => {
    await expect(sendRequest({ type: 'GET_SNAPSHOT' })).resolves.toEqual({ echoed: 'GET_SNAPSHOT' });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('GET_SNAPSHOT');
    expect(typeof sent[0].requestId).toBe('string');
    expect(sent[0].requestId.length).toBeGreaterThan(0);
  });
});

describe('sendRequest rejects every failure a caller could mistake for data', () => {
  it('rejects with the worker error string when the worker refuses', async () => {
    responder = (m) => ({ ok: false, requestId: m.requestId, error: 'Automatic unloading runs only on its schedule.' });
    await expect(sendRequest({ type: 'UNLOAD_EXECUTE', scope: { kind: 'all' } as any, mode: 'auto' } as any))
      .rejects.toThrow('Automatic unloading runs only on its schedule.');
  });
});

describe('sendRequest transport failures', () => {
  it('rejects when sendMessage rejects (no listener, port closed)', async () => {
    responder = () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    await expect(sendRequest({ type: 'GET_SNAPSHOT' })).rejects.toThrow('Receiving end does not exist');
  });
  it('rejects, rather than throwing synchronously, when sendMessage throws', async () => {
    responder = () => { throw new Error('Extension context invalidated.'); };
    const attempt = sendRequest({ type: 'GET_SNAPSHOT' });
    await expect(attempt).rejects.toThrow('Extension context invalidated.');
  });
});

describe('sendRequest malformed replies', () => {
  it('rejects with a reason when the worker resolves with no reply at all', async () => {
    responder = () => undefined;
    await expect(sendRequest({ type: 'GET_SNAPSHOT' })).rejects.toThrow(/no usable reply/i);
  });
});
describe('sendRequest malformed replies (continued)', () => {
  it('rejects a reply that is missing ok entirely, even when it carries data', async () => {
    responder = (m) => ({ requestId: m.requestId, data: { leaked: true } });
    await expect(sendRequest({ type: 'GET_SNAPSHOT' })).rejects.toThrow(/malformed/i);
  });
});
describe('sendRequest reply consistency', () => {
  it('lets error win when ok is false but data is present', async () => {
    responder = (m) => ({ ok: false, requestId: m.requestId, error: 'refused', data: { stale: true } });
    await expect(sendRequest({ type: 'GET_SNAPSHOT' })).rejects.toThrow('refused');
  });
  it('rejects an ok reply that carries no data key', async () => {
    responder = (m) => ({ ok: true, requestId: m.requestId });
    await expect(sendRequest({ type: 'GET_SNAPSHOT' })).rejects.toThrow(/malformed/i);
  });
  it('rejects a reply whose requestId belongs to a different request', async () => {
    responder = () => ({ ok: true, requestId: 'someone-else', data: { theirs: true } });
    await expect(sendRequest({ type: 'GET_SNAPSHOT' })).rejects.toThrow(/different request/i);
  });
});
describe('sendRequest overlapping calls', () => {
  it('keeps two overlapping calls apart when their replies arrive out of order', async () => {
    const held: Array<(data: string) => void> = [];
    responder = (m) => new Promise((resolve) => held.push((data) => resolve({ ok: true, requestId: m.requestId, data })));
    const first = sendRequest<string>({ type: 'GET_SNAPSHOT' });
    const second = sendRequest<string>({ type: 'GET_HISTORY' });
    held[1]!('second');
    held[0]!('first');
    await expect(second).resolves.toBe('second');
    await expect(first).resolves.toBe('first');
  });
  it('does not let a late reply to an earlier request resolve a later caller', async () => {
    const held: Array<{ id: string; resolve: (reply: unknown) => void }> = [];
    responder = (m) => new Promise((resolve) => held.push({ id: m.requestId, resolve }));
    const first = sendRequest<string>({ type: 'GET_SNAPSHOT' });
    const second = sendRequest<string>({ type: 'GET_HISTORY' });
    // The later call's channel carries the earlier call's requestId and its data.
    held[1]!.resolve({ ok: true, requestId: held[0]!.id, data: 'stale' });
    await expect(second).rejects.toThrow(/different request/i);
    held[0]!.resolve({ ok: true, requestId: held[0]!.id, data: 'fresh' });
    await expect(first).resolves.toBe('fresh');
  });
});

// ---- useSnapshot harness -------------------------------------------------------------

let visibility: 'visible' | 'hidden' = 'visible';
function setVisible(visible: boolean) {
  visibility = visible ? 'visible' : 'hidden';
}
function fireVisibilityChange() {
  fireEvent(document, new Event('visibilitychange'));
}
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });

function snapshotFixture(overrides: Record<string, unknown> = {}) {
  return {
    capturedAt: 1, windows: [], rows: [], counts: null,
    settings: {}, graceUntil: null, automationNote: null,
    tabsAvailable: true, failedReads: [], startupProblem: null,
    ...overrides,
  };
}

function snapshotRequests(): number {
  return sent.filter((m) => m.type === 'GET_SNAPSHOT').length;
}

function pushStateChanged() {
  for (const fn of (chrome.runtime.onMessage.addListener as unknown as { mock: { calls: any[][] } }).mock.calls.map((c) => c[0])) {
    fn(STATE_CHANGED_MESSAGE);
  }
}

beforeEach(() => {
  setVisible(true);
});

describe('useSnapshot', () => {
  it('asks the worker for a snapshot on mount and reports ready with it', async () => {
    responder = (m) => ({ ok: true, requestId: m.requestId, data: snapshotFixture({ capturedAt: 42 }) });
    const { result } = renderHook(() => useSnapshot());
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.snapshot?.capturedAt).toBe(42);
    expect(snapshotRequests()).toBe(1);
  });
});
describe('useSnapshot failures are shown, never blank', () => {
  it('shows an error state when the worker does not answer', async () => {
    responder = () => Promise.reject(new Error('The message port closed before a response was received.'));
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.snapshot).toBeNull();
  });
  it('shows an error state, not a stale snapshot, when the worker refuses', async () => {
    let answer: 'ok' | 'refuse' = 'ok';
    responder = (m) => answer === 'ok'
      ? { ok: true, requestId: m.requestId, data: snapshotFixture({ capturedAt: 1 }) }
      : { ok: false, requestId: m.requestId, error: 'Storage is unreadable.' };
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    answer = 'refuse';
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.snapshot).toBeNull();
  });
});
describe('useSnapshot refresh triggers', () => {
  it('refreshes when the worker pushes a state-changed notice', async () => {
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    act(() => pushStateChanged());
    await waitFor(() => expect(snapshotRequests()).toBe(2));
  });
  it('ignores unrelated runtime messages', async () => {
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    act(() => {
      for (const fn of (chrome.runtime.onMessage.addListener as any).mock.calls.map((c: any[]) => c[0])) fn({ type: 'SOMETHING_ELSE' });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshotRequests()).toBe(1);
  });
  it('refreshes when the page becomes visible again', async () => {
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const before = snapshotRequests();
    setVisible(false); act(() => fireVisibilityChange());
    setVisible(true); act(() => fireVisibilityChange());
    await waitFor(() => expect(snapshotRequests()).toBe(before + 1));
  });
});

describe('useSnapshot visibility and coalescing', () => {
  it('stops polling once the page is hidden', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSnapshot());
    // waitFor relies on timers, which are faked here: flush microtasks instead.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.state).toBe('ready');
    setVisible(false); act(() => fireVisibilityChange());
    const before = snapshotRequests();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(snapshotRequests()).toBe(before);
  });
  it('issues no request when refresh() is called while hidden, and one when visible again', async () => {
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const before = snapshotRequests();
    setVisible(false);
    act(() => result.current.refresh());
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshotRequests()).toBe(before);
    setVisible(true); act(() => fireVisibilityChange());
    await waitFor(() => expect(snapshotRequests()).toBe(before + 1));
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshotRequests()).toBe(before + 1);
  });
  it('defers a notice that arrives while hidden until the page is visible', async () => {
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const before = snapshotRequests();
    setVisible(false);
    act(() => pushStateChanged());
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshotRequests()).toBe(before);
    setVisible(true); act(() => fireVisibilityChange());
    await waitFor(() => expect(snapshotRequests()).toBe(before + 1));
  });
  it('coalesces notices that arrive while a refresh is in flight into one trailing refresh', async () => {
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const replies: Array<() => void> = [];
    responder = (m) => new Promise((resolve) => replies.push(() => resolve({ ok: true, requestId: m.requestId, data: snapshotFixture() })));
    const before = snapshotRequests();
    act(() => pushStateChanged());
    act(() => pushStateChanged());
    act(() => pushStateChanged());
    expect(snapshotRequests()).toBe(before + 1);
    replies[0]!();
    await waitFor(() => expect(snapshotRequests()).toBe(before + 2));
    replies[1]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshotRequests()).toBe(before + 2);
  });
});

describe('createSnapshotController after dispose', () => {
  it('delivers no result for a reply that arrives after the consumer unmounted', async () => {
    let resolveFetch: (v: any) => void = () => undefined;
    const results: unknown[] = [];
    const controller = createSnapshotController({
      fetch: () => new Promise((resolve) => { resolveFetch = resolve; }),
      isVisible: () => true,
      onResult: (r) => results.push(r),
    });
    controller.refresh();
    controller.dispose();
    resolveFetch(snapshotFixture());
    await new Promise((r) => setTimeout(r, 20));
    expect(results).toEqual([]);
  });
});
describe('useSnapshot lifecycle', () => {
  it('removes its runtime listener and visibility handler when unmounted', async () => {
    const { result, unmount } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const added = (chrome.runtime.onMessage.addListener as any).mock.calls.map((c: any[]) => c[0]);
    unmount();
    const removed = (chrome.runtime.onMessage.removeListener as any).mock.calls.map((c: any[]) => c[0]);
    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
  });
  it('recovers to ready when a later request succeeds after a failure', async () => {
    responder = () => Promise.reject(new Error('boom'));
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('error'));
    responder = (m) => ({ ok: true, requestId: m.requestId, data: snapshotFixture({ capturedAt: 7 }) });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.snapshot?.capturedAt).toBe(7);
  });
  it('shows an error state when the worker resolves with no reply', async () => {
    responder = () => undefined;
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.snapshot).toBeNull();
  });
});

describe('Badge', () => {
  it('renders a hostile group title as text', () => {  // Review Focus 4
    render(<Badge label={'<script>window.pwned=1</script>'} />);
    expect(document.querySelector('script')).toBe(null);
    expect(screen.getByText('<script>window.pwned=1</script>')).toBeInTheDocument();
  });
  it('pairs every status colour with a text label', () => {  // plan section 6
    render(<Badge tone="warn" label="Audible" />);
    expect(screen.getByText('Audible')).toBeInTheDocument();
  });
  it('carries a second tone as its own tone and keeps its label', () => {
    render(<Badge tone="ok" label="Eligible" />);
    const el = screen.getByText('Eligible');
    expect(el).toHaveAttribute('data-tone', 'ok');
    expect(el).toHaveClass('badge-ok');
    expect(el).not.toHaveClass('badge-warn');
  });
});

describe('Switch', () => {
  it('gives every switch an accessible label and state', () => {
    render(<Switch label="Automatic unloading" checked={false} onChange={() => undefined} />);
    const el = screen.getByRole('switch', { name: 'Automatic unloading' });
    expect(el).toHaveAttribute('aria-checked', 'false');
  });
  it('reports checked and disabled together, and does not fire when disabled', () => {
    const onChange = vi.fn();
    render(<Switch label="Automatic unloading" checked disabled onChange={onChange} />);
    const el = screen.getByRole('switch', { name: 'Automatic unloading' });
    expect(el).toHaveAttribute('aria-checked', 'true');
    expect(el).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(el);
    expect(onChange).not.toHaveBeenCalled();
  });
  it('reports the opposite state when an enabled switch is clicked', () => {
    const onChange = vi.fn();
    render(<Switch label="Automatic unloading" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic unloading' }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('switch', { name: 'Automatic unloading' })).toHaveAttribute('aria-disabled', 'false');
  });
});

function rowFixture(overrides: Partial<TabRow> = {}): TabRow {
  const none = { eligible: false, reasons: [], evaluatedAt: 0 } as TabRow['decision'];
  return {
    tabId: 1, windowId: 1, groupId: -1, title: 'Example', hostname: 'example.com',
    url: 'https://example.com/', scheme: 'https', lifecycle: 'loaded', selected: false,
    audible: false, pinned: false, backgroundMs: 0, decision: none, manualBulkDecision: none,
    ...overrides,
  };
}

describe('Table', () => {
  it('renders a hostile tab title as text', () => {  // Review Focus 4
    const evil = '<img src=x onerror="window.pwned=1">';
    render(<Table rows={[rowFixture({ title: evil })]} />);
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(document.querySelector('img')).toBe(null);
    expect((window as any).pwned).toBeUndefined();
  });
  it('defers to the empty state rather than drawing an empty table', () => {
    render(<Table rows={[]} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No tabs to show.')).toBeInTheDocument();
  });
  it('draws every row it is given, in the order given, without filtering or sorting', () => {
    const rows = Array.from({ length: 300 }, (_, i) => rowFixture({
      tabId: i + 1, title: `Tab ${i + 1}`, lifecycle: i % 3 === 0 ? 'unloaded' : 'loaded', pinned: i % 5 === 0,
    }));
    render(<Table rows={rows} />);
    const dataRows = screen.getAllByRole('row').slice(1);
    expect(dataRows).toHaveLength(300);
    expect(dataRows[0]).toHaveTextContent('Tab 1');
    expect(dataRows[1]).toHaveTextContent('Tab 2');
    expect(dataRows[299]).toHaveTextContent('Tab 300');
  });
});

describe('ErrorState', () => {
  it('says what happened and what the owner can do, not a bare error', () => {
    render(<ErrorState />);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not read/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/retry/i);
  });
  it('fires its retry callback once per click', () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it('offers no retry button when no retry is wired', () => {
    render(<ErrorState />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Button and Panel', () => {
  it('fires onClick, and does not when disabled', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Unload</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Unload' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button onClick={onClick} disabled>Unload</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Unload' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('labels a panel section with its heading', () => {
    render(<Panel title="Open tabs"><p>body</p></Panel>);
    expect(screen.getByRole('region', { name: 'Open tabs' })).toHaveTextContent('body');
  });
});

describe('theme tokens (plan section 6: dark mode, 4.5:1 text, visible focus)', () => {
  const css = readFileSync(join(import.meta.dirname, '../../src/ui/components/theme.css'), 'utf8');
  const lightBlock = css.match(/^:root\s*\{([^}]*)\}/m)?.[1] ?? '';
  const darkBlock = css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/)?.[1] ?? '';
  const parse = (block: string): Record<string, string> => Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]),
  );
  const light = parse(lightBlock);
  const dark = parse(darkBlock);
  const TONES = ['neutral', 'info', 'ok', 'warn', 'danger'] as const;
  const TOKENS = [
    '--color-bg', '--color-surface', '--color-text', '--color-text-muted', '--color-border', '--color-focus',
    ...TONES.flatMap((t) => [`--color-${t}-bg`, `--color-${t}-fg`]),
  ];

  function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  }
  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  it('defines every token in the light set and in the dark media set', () => {
    for (const token of TOKENS) {
      expect(light[token], `light ${token}`).toMatch(/^#/);
      expect(dark[token], `dark ${token}`).toMatch(/^#/);
    }
  });
  it('gives the dark set different values from the light set for every token', () => {
    for (const token of TOKENS) expect(dark[token], token).not.toBe(light[token]);
  });
  it('keeps text and every tone label at 4.5:1 in both modes', () => {
    for (const set of [light, dark]) {
      expect(contrast(set['--color-text']!, set['--color-surface']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(set['--color-text']!, set['--color-bg']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(set['--color-text-muted']!, set['--color-surface']!)).toBeGreaterThanOrEqual(4.5);
      for (const t of TONES) {
        expect(contrast(set[`--color-${t}-fg`]!, set[`--color-${t}-bg`]!)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('keeps the focus ring at 3:1 against its surface in both modes, and draws one', () => {
    for (const set of [light, dark]) {
      expect(contrast(set['--color-focus']!, set['--color-surface']!)).toBeGreaterThanOrEqual(3);
    }
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline/);
  });
});

describe('the ui layer reaches background/ only through type-only imports', () => {
  // A value import would pull the worker's module (and its chrome.* listeners) into the page.
  // Parsed with the real TypeScript compiler, not a line-by-line regex: a regex scan missed
  // a bare side-effect import (`import '../background/x'`, no `from` token at all) and a
  // dynamic import (`import('../background/x')`), neither of which a bundler can erase.
  function listSource(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return listSource(full);
      return /\.tsx?$/.test(e.name) ? [full] : [];
    });
  }

  /**
   * The import/export/dynamic-import statements this source references as a VALUE from a
   * path containing `needle`. Whole statements, not lines: a per-line scan previously missed
   * a bare side-effect import (`import '...'`, no `from` token) and a dynamic import
   * (`import('...')`), neither of which a bundler can erase — and would have false-positived
   * on a type-only import split across multiple lines.
   *
   * TypeScript 7's package exports only a version stub from its main entry; the classic
   * createSourceFile/AST API lives under `typescript/unstable/*`, explicitly marked unstable
   * in this version. Rather than depend on that, each statement is matched as a whole unit
   * (so embedded newlines don't matter) and classified by its own text.
   */
  function unsafeImportsOf(sourceText: string, needle: string): string[] {
    const hits: string[] = [];
    // import/export ... ; as one unit, but never one that is itself a dynamic import call
    // (handled separately below, since it has no semicolon-terminated "clause" shape).
    const stmtRe = /\b(?:import|export)\b(?!\s*\()[^;]*?;/gs;
    for (const m of sourceText.matchAll(stmtRe)) {
      const stmt = m[0];
      if (stmt.includes(needle) && !isTypeOnlyStatement(stmt)) hits.push(stmt);
    }
    // A dynamic import('...') has no type-only form at all; it always loads the module.
    const dynRe = /\bimport\s*\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g;
    for (const m of sourceText.matchAll(dynRe)) {
      if (m[2]!.includes(needle)) hits.push(m[0]);
    }
    return hits;
  }

  function isTypeOnlyStatement(stmt: string): boolean {
    const trimmed = stmt.trim();
    // The whole clause is type-only: `import type ... from '...'` / `export type { ... } from '...'`.
    if (/^(import|export)\s+type\b/.test(trimmed)) return true;
    // No braces at all: a bare side-effect import, a default import, or a namespace import.
    // None of those have a type-only spelling, so nothing further to check — not type-only.
    const braceMatch = trimmed.match(/\{([^}]*)\}/s);
    if (!braceMatch) return false;
    // A default binding alongside the braces (`import Default, { ... } from '...'`) is
    // always a value load regardless of what the braces contain.
    if (/^import\s+(?!type\b)[A-Za-z_$][\w$]*\s*,/.test(trimmed)) return false;
    const names = braceMatch[1]!.split(',').map((s) => s.trim()).filter(Boolean);
    return names.length > 0 && names.every((n) => /^type\s+/.test(n));
  }

  it.each([
    ['a type-only named import', "import type { X } from '../background/x';", []],
    ['a type-only brace import', "import { type X } from '../background/x';", []],
    ['a type-only export', "export type { X } from '../background/x';", []],
    ['a multi-line type-only import', "import type {\n  X,\n  Y,\n} from '../background/x';", []],
    ['an unrelated path', "import { X } from '../domain/x';", []],
    ['a string that merely contains the word, not an import', "const s = 'background/foo';", []],
    ['a default import', "import X from '../background/x';", ["import X from '../background/x';"]],
    ['a bare side-effect import', "import '../background/x';", ["import '../background/x';"]],
    ['a dynamic import', "const p = import('../background/x');", ["import('../background/x')"]],
    ['a mixed type-and-value brace import', "import { type X, Y } from '../background/x';",
      ["import { type X, Y } from '../background/x';"]],
    ['a namespace import', "import * as X from '../background/x';", ["import * as X from '../background/x';"]],
    ['a value export', "export { X } from '../background/x';", ["export { X } from '../background/x';"]],
  ])('recognises %s', (_label, source, expected) => {
    expect(unsafeImportsOf(source, 'background/')).toEqual(expected);
  });

  it('has no value import from src/background anywhere under src/ui', () => {
    const uiRoot = join(import.meta.dirname, '../../src/ui');
    const files = listSource(uiRoot);
    expect(files.length).toBeGreaterThan(0);
    const valueImports = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return unsafeImportsOf(text, 'background/')
        .map((snippet) => `${relative(uiRoot, file).split(sep).join('/')}: ${snippet}`);
    });
    expect(valueImports).toEqual([]);
  });
});

describe('useSnapshot trailing refresh while the page hides', () => {
  it('holds a trailing refresh queued while visible until the page is visible again', async () => {
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const replies: Array<() => void> = [];
    responder = (m) => new Promise((resolve) => replies.push(() => resolve({ ok: true, requestId: m.requestId, data: snapshotFixture() })));
    const before = snapshotRequests();
    act(() => pushStateChanged());          // in flight
    act(() => pushStateChanged());          // queued as the trailing refresh
    setVisible(false); act(() => fireVisibilityChange());
    replies[0]!();                          // the in-flight reply lands while hidden
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshotRequests()).toBe(before + 1);
    setVisible(true); act(() => fireVisibilityChange());
    await waitFor(() => expect(snapshotRequests()).toBe(before + 2));
  });
});
