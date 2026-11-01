# Dashboard/Popup UX — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard and popup self-explanatory and give the owner real control — an editable idle threshold, a findable settings panel, a per-tab unload action, a less repetitive/cramped tab list and filter bar, and a wired-up memory reading — without touching eligibility logic, adding permissions, or changing the message protocol.

**Architecture:** Pure UI-layer change. Every capability this phase needs (the `manual-single` unload mode, the `{ kind: 'tab', tabId }` scope, `summariseBeforeAfter`/`formatDelta`, `THRESHOLD_PRESETS`) already exists in `domain/` and `background/` and is simply unwired. Work stays inside `src/ui/` plus `src/ui/components/theme.css`; `App.tsx` (dashboard) grows two new pieces of state — a per-tab unload path and a before/after memory sample — both following the existing `bulk`/`announcement` state patterns already in that file.

**Tech Stack:** React + TypeScript + Vite, Vitest + @testing-library/react (`fireEvent`, no `user-event` — not a repo dependency), plain CSS via `src/ui/components/theme.css`.

**Spec:** `docs/superpowers/specs/2026-11-01-dashboard-ux-phase1-design.md`

## Global Constraints

- Threshold values are integers in `[THRESHOLD_MIN, THRESHOLD_MAX]` = `[1, 1440]` (`domain/constants.ts`). Anything outside that range, or non-integer, must never be sent in an `UPDATE_SETTINGS` patch.
- `THRESHOLD_PRESETS = [1, 2, 5, 10, 15, 30, 60]` (`domain/constants.ts`) — reuse, do not redefine.
- `MANUAL_BULK_FLOOR_MS = 60_000` applies only to `manual-bulk`. `manual-single` applies **no** threshold, no floor, no grace, and no dashboard-origin exclusion (`domain/eligibility.ts`) — copy must not imply otherwise.
- `manual-single` is only valid with scope `{ kind: 'tab', tabId }`. `shared/validation.ts`'s `parseUnloadTarget` refuses `manual-single` paired with `{ kind: 'tabs', tabIds: [...] }` or any other scope kind.
- No new `chrome.*` permission, no change to `shared/messages.ts`, `domain/eligibility.ts`, or `background/executor.ts`.
- `src/ui/` may only take **type-only** imports from `src/background/`; the pinned test "the ui layer reaches background/ only through type-only imports" enforces this — no new runtime import crosses that line.
- No raw HTML for owner-supplied text (tab/group titles) — plain-text children only.
- Styling stays in `src/ui/components/theme.css`'s existing custom-property/token system; no new styling library.
- Accessibility baseline carries over: visible focus rings, 4.5:1 text contrast, `aria-live` announcements for async results.

## Review Focus

- A threshold typed as `0`, `1441`, `7.5`, or empty must never reach `UPDATE_SETTINGS` — the control clamps/rejects client-side, mirroring `domain/settings.ts`'s `readThreshold` (integer, `THRESHOLD_MIN`–`THRESHOLD_MAX`).
- "Unload now" on a tab that is pinned, selected, audible, or otherwise protected must report that reason back to the owner (via the existing `describeReport`/`announcement` path), not silently no-op or claim success.
- Two rapid clicks on the same row's "Unload now" must not send two `UNLOAD_EXECUTE` requests — needs the same busy-ref double-submit guard already used for the bulk action and `toggleProtection`.
- Opening the dashboard with no `#settings` fragment (a plain "Open dashboard" click, or a direct URL) must render exactly as today — the new settings entry point is additive, never conditional logic that can misfire on absence.
- The memory panel must never show a "freed" figure, zero, or NaN while the capability is unavailable or permission hasn't been granted — before/after sampling is skipped entirely in that state, matching the existing "never shows an unavailable figure as zero" rule.

---

## Task 1: Editable, explained threshold on the dashboard Settings panel

**Files:**
- Create: `fallow/src/ui/components/ThresholdInput.tsx`
- Modify: `fallow/src/ui/dashboard/SettingsPanel.tsx`
- Modify: `fallow/src/ui/components/theme.css`
- Test: `fallow/tests/unit/dashboard.test.tsx`

**Interfaces:**
- Produces: `ThresholdInput({ minutes, onCommit }: { minutes: number; onCommit: (next: number) => void })` in `components/ThresholdInput.tsx`. Renders a `<label>` + `<input type="number" min={THRESHOLD_MIN} max={THRESHOLD_MAX} step={1}>` (`aria-label="Threshold in minutes"`) plus one button per `THRESHOLD_PRESETS` value (`aria-label` e.g. `"Set threshold to 15 minutes"`). Calls `onCommit(next)` only when `next` is an integer with `THRESHOLD_MIN <= next <= THRESHOLD_MAX` — on blur and on preset click, never on every keystroke. An invalid typed value calls `onCommit` with nothing (no call at all).
- Consumes: `THRESHOLD_MIN`, `THRESHOLD_MAX`, `THRESHOLD_PRESETS` from `../../domain/constants`.
- `SettingsPanel` consumes `ThresholdInput` and keeps its existing `sendRequest`/`Switch`/`Panel` usage; its own props (`{ settings: Settings }`) are unchanged, so `App.tsx`'s render call needs no edit in this task.

- [ ] **Step 1: Write the failing test**

```tsx
// in a new describe block, e.g. describe('SettingsPanel: editable threshold', ...)
it('sends a threshold patch when a valid value is committed', async () => {
  snapshot = snapshotFixture({ settings: defaultSettings({ inactivityMinutes: 15 }) });
  render(<App />);
  const input = await screen.findByLabelText(/threshold in minutes/i);
  fireEvent.change(input, { target: { value: '45' } });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(fake.lastRequest).toMatchObject({ type: 'UPDATE_SETTINGS', patch: { inactivityMinutes: 45 } }),
  );
});

it('never sends a patch for an out-of-range or non-integer threshold', async () => {
  snapshot = snapshotFixture({ settings: defaultSettings({ inactivityMinutes: 15 }) });
  render(<App />);
  const input = await screen.findByLabelText(/threshold in minutes/i);
  fireEvent.change(input, { target: { value: '0' } });
  fireEvent.blur(input);
  fireEvent.change(input, { target: { value: '7.5' } });
  fireEvent.blur(input);
  fireEvent.change(input, { target: { value: '1441' } });
  fireEvent.blur(input);
  expect(fake.calls.updateSettings).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- dashboard.test.tsx -t "editable threshold"`
Expected: FAIL — `findByLabelText(/threshold in minutes/i)` finds nothing.

- [ ] **Step 3: Implement `ThresholdInput` in `fallow/src/ui/components/ThresholdInput.tsx`**

One rendering choice left open: preset buttons render as a row of small `btn`-styled buttons (reuse `Button`), each calling `onCommit` directly with its own value (presets always commit immediately, unlike the free-text field which commits on blur).

- [ ] **Step 4: Wire `SettingsPanel` to use it, and add plain-language explanatory copy**

Replace the `<p>Threshold: …</p>` line with `<ThresholdInput minutes={settings.inactivityMinutes} onCommit={(next) => void sendRequest({ type: 'UPDATE_SETTINGS', patch: { inactivityMinutes: next } })} />`. Add, as plain `<p>` text directly below it:

> "Automatic unloading waits this long after you stop using a tab before it unloads it."

Add a "How unloading works" block (three short lines, one per path) directly below the Automatic-unloading switch:

> "**Automatic** — waits until a tab has been idle for the threshold above.
> **Unload eligible tabs** (the button at the top) — waits until a tab has been idle for at least 1 minute.
> **Unload now**, on a single tab — no minimum wait; only a pinned, playing, selected, or protected tab is skipped."

Add one line under the "Automatic unloading" switch itself:

> "Turning this on only means Fallow checks how long tabs have sat idle — it doesn't keep tabs loaded or use extra memory itself."

- [ ] **Step 5: Add `.threshold-input`/`.settings-help` layout rules to `theme.css`**

A flex row for the number input + presets (`gap: 8px; flex-wrap: wrap; align-items: center;`), and muted small text for the explanatory `<p>`s (reuse `var(--color-text-muted)`, `font-size: 12px`), matching the existing `.tab-row-caption` pattern.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- dashboard.test.tsx -t "editable threshold"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add fallow/src/ui/components/ThresholdInput.tsx fallow/src/ui/dashboard/SettingsPanel.tsx fallow/src/ui/components/theme.css fallow/tests/unit/dashboard.test.tsx
git commit -m "feat: make the idle threshold editable and explain how unloading works"
```

---

## Task 2: Findable settings — popup and dashboard entry points

**Files:**
- Modify: `fallow/src/ui/components/Panel.tsx`
- Modify: `fallow/src/ui/dashboard/SettingsPanel.tsx`
- Modify: `fallow/src/ui/dashboard/Header.tsx`
- Modify: `fallow/src/ui/popup/App.tsx`
- Modify: `fallow/src/ui/components/theme.css`
- Test: `fallow/tests/unit/dashboard.test.tsx`, `fallow/tests/unit/popup.test.tsx`

**Interfaces:**
- Modifies: `Panel({ title, children, id }: { title: string; children: ReactNode; id?: string })` — `id`, when given, goes on the `<section>`.
- `SettingsPanel` passes `id="settings"` to its own `Panel`.
- `Header({ automationNote })` gains a plain in-page anchor `<a className="btn" href="#settings">Settings</a>` next to the title — a native browser jump to `id="settings"`, no new JS.
- Popup `App.tsx` gains a second footer button, "Settings," built the same way as the existing `handleOpenDashboard` (same origin-tab lookup) but appending `#settings` to the URL it opens.

- [ ] **Step 1: Write the failing tests**

```tsx
// dashboard.test.tsx
it('links the header to the settings panel by id', async () => {
  render(<App />);
  const link = await screen.findByRole('link', { name: /settings/i });
  expect(link.getAttribute('href')).toBe('#settings');
  expect(document.getElementById('settings')).toBeTruthy();
});
```

```tsx
// popup.test.tsx
it('opens the dashboard scrolled to settings from the Settings button', async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
  await waitFor(() => expect(fake.lastCreatedUrl).toMatch(/dashboard\/index\.html\?originTabId=7#settings$/));
});
```

```tsx
// dashboard.test.tsx — Review Focus: absence of #settings must change nothing
it('renders the same as always when opened with no #settings fragment', async () => {
  snapshot = snapshotFixture({
    windows: [windowFixture(1, { ungroupedTabIds: [1] })],
    rows: [rowFixture({ tabId: 1 })],
    counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
  });
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('count-total')).toHaveTextContent('1'));
  expect(window.location.hash).toBe('');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- dashboard.test.tsx popup.test.tsx -t "settings"`
Expected: FAIL — no `link`/`button` named "Settings" yet (the no-fragment test already passes against today's code — it stays green through this task as a guard against the new markup accidentally depending on the hash).

- [ ] **Step 3: Implement the `id` prop on `Panel`, wire it through `SettingsPanel`, add the `Header` anchor**

- [ ] **Step 4: Add the popup's "Settings" button**

Next to the existing `handleOpenDashboard`, add `handleOpenSettings` that performs the same origin-tab lookup and `chrome.tabs.create`, with `#settings` appended to the built URL; render a second `<Button>` in `.popup-footer` calling it.

- [ ] **Step 5: Add a small `.dashboard-header` flex rule in `theme.css`** so the title and the new link sit on one row with space between them, instead of stacking.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- dashboard.test.tsx popup.test.tsx -t "settings"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add fallow/src/ui/components/Panel.tsx fallow/src/ui/dashboard/SettingsPanel.tsx fallow/src/ui/dashboard/Header.tsx fallow/src/ui/popup/App.tsx fallow/src/ui/components/theme.css fallow/tests/unit/dashboard.test.tsx fallow/tests/unit/popup.test.tsx
git commit -m "feat: add a findable settings entry point from the popup and dashboard header"
```

---

## Task 3: Per-tab "Unload now"

**Files:**
- Modify: `fallow/src/ui/dashboard/App.tsx`
- Modify: `fallow/src/ui/dashboard/TabTable.tsx`
- Modify: `fallow/src/ui/components/theme.css`
- Test: `fallow/tests/unit/dashboard.test.tsx`

**Interfaces:**
- `App.tsx` adds `handleUnloadTab(tabId: number): Promise<void>` (parallels `handleConfirm`): if not yet acknowledged (`!hasAcknowledgedBulk()`), sets `bulk` to a generalized ack step that remembers what to run next (see Step 3); otherwise sends `{ type: 'UNLOAD_EXECUTE', scope: { kind: 'tab', tabId }, mode: 'manual-single' }` via `sendRequest<BatchReport>`, then `setAnnouncement(describeReport(report))` — reusing the existing `describeReport` unchanged.
- `Bulk` type's `'ack'` variant changes from `{ step: 'ack' }` to `{ step: 'ack'; then: () => void }`, so both the bulk button and a per-tab button can arm the same one-time consent dialog with their own continuation. `handleAcknowledge` becomes `() => { setAcknowledgedBulk(); if (bulk.step === 'ack') bulk.then(); }`.
- `TabTableProps` gains `onUnload: (tabId: number) => Promise<void>`; `App.tsx` passes `handleUnloadTab`. `Row` gains the same prop, read from a new `onUnload` param.
- `Row` adds local `unloading` state (mirrors `pending` for `toggleProtection`) and a disabled `Button` labeled "Unload now" next to "Keep loaded", calling `onUnload(row.tabId)`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('unloads a single tab on request, using manual-single and a tab scope', async () => {
  localStorage.setItem('fallow.bulkAcknowledged', '1');
  snapshot = snapshotFixture({
    windows: [windowFixture(1, { ungroupedTabIds: [5] })],
    rows: [rowFixture({ tabId: 5 })],
    counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: /unload now/i }));
  await waitFor(() =>
    expect(fake.lastRequest).toMatchObject({
      type: 'UNLOAD_EXECUTE', scope: { kind: 'tab', tabId: 5 }, mode: 'manual-single',
    }),
  );
});

it('asks for the same one-time acknowledgement before a first single-tab unload', async () => {
  snapshot = snapshotFixture({
    windows: [windowFixture(1, { ungroupedTabIds: [5] })],
    rows: [rowFixture({ tabId: 5 })],
    counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: /unload now/i }));
  expect(await screen.findByRole('alertdialog', { name: /confirm unloading tabs/i })).toBeInTheDocument();
  expect(fake.calls.unloadExecute).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- dashboard.test.tsx -t "single-tab"`
Expected: FAIL — no "Unload now" button yet.

- [ ] **Step 3: Implement the generalized ack step and `handleUnloadTab` in `App.tsx`**

- [ ] **Step 4: Thread `onUnload` through `TabTableProps` and add the "Unload now" button + busy guard in `Row`**

Busy guard mirrors `toggleProtection`'s existing `pending` check exactly (read-then-set before any `await`).

- [ ] **Step 5: Add `.tab-row-actions` spacing for the second button in `theme.css`** (the existing rule already stacks children with `gap: 2px`; widen to `gap: 6px` now that there are two buttons, not one, per row).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- dashboard.test.tsx -t "single-tab"`
Expected: PASS

- [ ] **Step 7: Add the Review Focus regression test — an ineligible tab reports its reason, not silent success**

```tsx
it('reports why, not just that nothing happened, when a protected tab is sent to Unload now', async () => {
  localStorage.setItem('fallow.bulkAcknowledged', '1');
  snapshot = snapshotFixture({
    windows: [windowFixture(1, { ungroupedTabIds: [5] })],
    rows: [rowFixture({ tabId: 5, pinned: true })],
    counts: { total: 1, loaded: 1, unloaded: 0, eligible: 0, protected: 1 },
  });
  responder = (m) => m.type === 'UNLOAD_EXECUTE'
    ? ok(m.requestId, reportFixture({ requested: 1, confirmed: 0, skipped: 1 }))
    : (m.type === 'GET_SNAPSHOT' ? ok(m.requestId, snapshot) : ok(m.requestId, null));
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: /unload now/i }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/0 unloaded of 1 requested \(1 skipped\)/i));
});
```

- [ ] **Step 8: Add the Review Focus regression test — two rapid clicks send one request**

```tsx
it('ignores a second Unload now click while the first is still in flight', async () => {
  localStorage.setItem('fallow.bulkAcknowledged', '1');
  snapshot = snapshotFixture({
    windows: [windowFixture(1, { ungroupedTabIds: [5] })],
    rows: [rowFixture({ tabId: 5 })],
    counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
  });
  render(<App />);
  const button = await screen.findByRole('button', { name: /unload now/i });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(fake.calls.unloadExecute).toBe(1));
});
```

- [ ] **Step 9: Run full dashboard suite, then commit**

Run: `npm test -- dashboard.test.tsx`
Expected: PASS

```bash
git add fallow/src/ui/dashboard/App.tsx fallow/src/ui/dashboard/TabTable.tsx fallow/src/ui/components/theme.css fallow/tests/unit/dashboard.test.tsx
git commit -m "feat: add a per-tab Unload now action"
```

---

## Task 4: One shared legend instead of a per-row disclaimer

**Files:**
- Modify: `fallow/src/ui/dashboard/TabTable.tsx`
- Modify: `fallow/src/ui/components/theme.css`
- Test: `fallow/tests/unit/dashboard.test.tsx`

**Interfaces:**
- `TabTable`'s exported component renders one `<p className="tab-table-legend">` above the list (inside the same `<div className="tab-table">` wrapper, before the rows/groups), with the exact text currently repeated per row: "Keep loaded binds only this Fallow session. Chrome or another extension can still unload a tab." `Row` drops its own `<p className="tab-row-caption">` entirely — `tab-row-actions` now holds only the two buttons.
- No prop or type signature changes; `TabTableProps` is unchanged.

- [ ] **Step 1: Write the failing test**

```tsx
it('explains Keep loaded once for the whole list, not once per row', async () => {
  snapshot = snapshotFixture({
    windows: [windowFixture(1, { ungroupedTabIds: [1, 2] })],
    rows: [rowFixture({ tabId: 1 }), rowFixture({ tabId: 2 })],
    counts: { total: 2, loaded: 2, unloaded: 0, eligible: 2, protected: 0 },
  });
  render(<App />);
  await screen.findByTestId('row-1');
  expect(screen.getAllByText(/binds only this Fallow session/i)).toHaveLength(1);
});
```

(This replaces the existing `'explains that Keep loaded binds only Fallow'` test's assumption of per-row text — update that test's own assertion to look for the legend once, not inside a specific row, rather than leaving two tests disagreeing about where the text lives.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dashboard.test.tsx -t "once for the whole list"`
Expected: FAIL — text currently appears twice.

- [ ] **Step 3: Move the caption out of `Row` and into one legend line in `TabTable`**

- [ ] **Step 4: Tighten `.tab-row` vertical padding in `theme.css`** now that each row is one line shorter (`padding: 6px 12px` in place of `8px 12px` is enough; do not change `.scroll-area`'s `max-height`).

- [ ] **Step 5: Run the full dashboard suite to verify it passes, including the updated existing test**

Run: `npm test -- dashboard.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add fallow/src/ui/dashboard/TabTable.tsx fallow/src/ui/components/theme.css fallow/tests/unit/dashboard.test.tsx
git commit -m "fix: stop repeating the Keep loaded disclaimer on every tab row"
```

---

## Task 5: Filter bar — visible labels, real spacing, friendlier empty state

**Files:**
- Modify: `fallow/src/ui/dashboard/Filters.tsx`
- Modify: `fallow/src/ui/dashboard/TabTable.tsx`
- Modify: `fallow/src/ui/components/theme.css`
- Test: `fallow/tests/unit/dashboard.test.tsx`

**Interfaces:**
- `Filters`'s props and exported `SortKey`/`FilterKey` types are unchanged. Each control gets a visible `<label>` wrapping it (text "Search," "Sort by," "Show"), in addition to the `aria-label`s already there (kept for parity, visible label makes `aria-label` redundant but harmless — keep both rather than risk an accessible-name regression).
- `TabTable`'s two `<EmptyState title="No tabs match the current filter and search." />` call sites both change their `title` string to: `"No tabs match your search or filter. Try clearing one of them."`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('labels each filter control for a sighted non-developer reader', async () => {
  render(<App />);
  expect(await screen.findByText('Search')).toBeInTheDocument();
  expect(screen.getByText('Sort by')).toBeInTheDocument();
  expect(screen.getByText('Show')).toBeInTheDocument();
});

it('gives a friendlier empty-search message than a bare technical sentence', async () => {
  snapshot = snapshotFixture({
    windows: [windowFixture(1, { ungroupedTabIds: [1] })],
    rows: [rowFixture({ tabId: 1, title: 'Example' })],
    counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
  });
  render(<App />);
  fireEvent.change(await screen.findByLabelText('Search tabs'), { target: { value: 'nothing matches this' } });
  expect(await screen.findByText(/try clearing one of them/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- dashboard.test.tsx -t "filter control"`
Expected: FAIL

- [ ] **Step 3: Add visible `<label>` text to each control in `Filters.tsx`**

- [ ] **Step 4: Update both `EmptyState` call sites in `TabTable.tsx`**

- [ ] **Step 5: Add a `.filters` flex-row rule to `theme.css`**: `display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end;` on the `section[aria-label="Filters"]`, each label+control pair as its own `flex-direction: column` group, so the row wraps cleanly instead of the controls running together.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- dashboard.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add fallow/src/ui/dashboard/Filters.tsx fallow/src/ui/dashboard/TabTable.tsx fallow/src/ui/components/theme.css fallow/tests/unit/dashboard.test.tsx
git commit -m "fix: give the filter bar real spacing, visible labels, and a friendlier empty state"
```

---

## Task 6: Memory panel — a before/after reading tied to an actual unload

Tested as two independently-testable pieces, not through the full `App` with real or
fake timers: `sampleMemoryAround` as a pure, dependency-injected function (same seam
`background/executor.ts` already uses for its own `sleep`), and `MemoryPanel`'s new line
rendered directly off a `delta` prop. `App.tsx`'s own wiring of the two together is thin
enough (one new `useState`, two call sites changed from `await sendRequest(...)` to
`await sampleMemoryAround(..., () => sendRequest(...))`) that it does not need its own
end-to-end test on top of those two.

**Files:**
- Modify: `fallow/src/ui/dashboard/App.tsx`
- Modify: `fallow/src/ui/dashboard/MemoryPanel.tsx`
- Test: `fallow/tests/unit/dashboard.test.tsx`

**Interfaces:**
- `App.tsx` exports `export async function sampleMemoryAround<T>(deps: { enabled: boolean; provider: DeviceMemoryProvider; wait: (ms: number) => Promise<void> }, action: () => Promise<T>): Promise<{ result: T; delta: BeforeAfter | null }>`. When `!deps.enabled`, or when `await deps.provider.isAvailable()` is `false`, returns `{ result: await action(), delta: null }` with no sampling at all. Otherwise: `before = await deps.provider.sample()`, `result = await action()`, `await deps.wait(MEMORY_AFTER_DELAY_MS)`, `after = await deps.provider.sample()`, returns `{ result, delta: summariseBeforeAfter(before, after) }`. Exported the same way `BLOCKED_TEXT`/`PROTECTION_REASONS` already are, for the test file to import directly.
- `App`'s component body adds `const [memoryDelta, setMemoryDelta] = useState<BeforeAfter | null>(null)` and a module-level `const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));` (defined once, outside the component, so it is not recreated every render). `handleConfirm` and `handleUnloadTab` each replace their `const report = await sendRequest<BatchReport>({ ... })` with:
  ```ts
  const { result: report, delta } = await sampleMemoryAround(
    { enabled: settings.deviceMemoryMonitoringEnabled, provider: memoryProviderRef.current, wait: realWait },
    () => sendRequest<BatchReport>({ ... }), // unchanged request body
  );
  setMemoryDelta(delta);
  ```
- `MemoryPanel`'s props grow to `{ enabled: boolean; provider: DeviceMemoryProvider; delta: BeforeAfter | null }` (`BeforeAfter` from `../../platform/memory-provider`). When `delta !== null && delta.status === 'complete'`, render a second line: `Freed: <span data-testid="memory-freed">{formatDelta(delta.deltaBytes)}</span>`. Any other `delta` value renders nothing extra. Below the existing "whole device, not just Chrome" disclaimer, add one more static line, shown whenever `enabled`, regardless of `delta`: "A reading for just Chrome's own usage is planned for a later update."
- `App.tsx` passes `delta={memoryDelta}` into its `<MemoryPanel>` call.
- Consumes: `summariseBeforeAfter`, `formatDelta`, `type BeforeAfter` from `../../platform/memory-provider` (already exported); `MEMORY_AFTER_DELAY_MS` from `../../domain/constants`.

- [ ] **Step 1: Write the failing tests for `sampleMemoryAround`, as a pure function**

Add the imports below to the top of `dashboard.test.tsx`, and define `stubProvider` once at file (module) scope, alongside the other fixtures near the top of the file — not nested inside either `describe` block — since Step 2 reuses it.

```tsx
import { sampleMemoryAround } from '../../src/ui/dashboard/App';
import type { DeviceMemoryProvider } from '../../src/platform/memory-provider';
import { MEMORY_AFTER_DELAY_MS } from '../../src/domain/constants';

function stubProvider(samples: ReadonlyArray<{ availableBytes: number } | null>): DeviceMemoryProvider {
  let i = 0;
  return {
    key: 'deviceMemory',
    isAvailable: async () => true,
    sample: async () => {
      const s = samples[i++] ?? null;
      return s === null ? null : { at: i, capacityBytes: 16 * 1024 ** 3, availableBytes: s.availableBytes };
    },
    requestPermission: async () => true,
    revoke: async () => {},
  };
}

describe('sampleMemoryAround: a before/after reading around an action', () => {
  it('samples before and after the action, waiting MEMORY_AFTER_DELAY_MS between them', async () => {
    const waited: number[] = [];
    const provider = stubProvider([{ availableBytes: 4 * 1024 ** 3 }, { availableBytes: 5 * 1024 ** 3 }]);
    const { result, delta } = await sampleMemoryAround(
      { enabled: true, provider, wait: async (ms) => { waited.push(ms); } },
      async () => 'done',
    );
    expect(result).toBe('done');
    expect(waited).toEqual([MEMORY_AFTER_DELAY_MS]);
    expect(delta).toMatchObject({ status: 'complete', deltaBytes: 1 * 1024 ** 3 });
  });

  it('skips sampling entirely when monitoring is disabled', async () => {
    const provider = stubProvider([]);
    const sampleSpy = vi.spyOn(provider, 'sample');
    const { result, delta } = await sampleMemoryAround(
      { enabled: false, provider, wait: async () => {} }, async () => 'done',
    );
    expect(result).toBe('done');
    expect(delta).toBeNull();
    expect(sampleSpy).not.toHaveBeenCalled();
  });

  it('skips sampling when the capability is unavailable, even if enabled', async () => {
    const provider = stubProvider([]);
    provider.isAvailable = async () => false;
    const sampleSpy = vi.spyOn(provider, 'sample');
    const { delta } = await sampleMemoryAround({ enabled: true, provider, wait: async () => {} }, async () => 'done');
    expect(delta).toBeNull();
    expect(sampleSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing test for `MemoryPanel`'s new line, rendered directly**

```tsx
import { MemoryPanel } from '../../src/ui/dashboard/MemoryPanel';
import { summariseBeforeAfter } from '../../src/platform/memory-provider';

describe('MemoryPanel: a freed reading', () => {
  it('shows how much was freed once a complete before/after delta is given', async () => {
    const before = { at: 1, capacityBytes: 16 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 };
    const after = { at: 2, capacityBytes: 16 * 1024 ** 3, availableBytes: 5 * 1024 ** 3 };
    render(<MemoryPanel enabled provider={stubProvider([])} delta={summariseBeforeAfter(before, after)} />);
    expect(await screen.findByTestId('memory-freed')).toHaveTextContent('+1.0 GiB');
  });

  it('shows no freed figure when there is no delta yet', async () => {
    render(<MemoryPanel enabled provider={stubProvider([])} delta={null} />);
    await screen.findByTestId('memory-panel');
    expect(screen.queryByTestId('memory-freed')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- dashboard.test.tsx -t "before/after reading around an action|a freed reading"`
Expected: FAIL — `sampleMemoryAround` is not exported yet; `MemoryPanel` takes no `delta` prop yet.

- [ ] **Step 4: Implement `sampleMemoryAround` as an exported function in `App.tsx`**

- [ ] **Step 5: Implement the "Freed" line and the static "Chrome-only reading is planned" line in `MemoryPanel.tsx`**

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- dashboard.test.tsx -t "before/after reading around an action|a freed reading"`
Expected: PASS

- [ ] **Step 7: Wire `App.tsx`'s `handleConfirm` and `handleUnloadTab` through `sampleMemoryAround`, and pass `delta={memoryDelta}` into `<MemoryPanel>`**

- [ ] **Step 8: Run the full dashboard suite, then commit**

Run: `npm test -- dashboard.test.tsx`
Expected: PASS — including the pre-existing `MemoryPanel: once enabled` tests, which now render through `App` with `memoryDelta` starting `null`.

```bash
git add fallow/src/ui/dashboard/App.tsx fallow/src/ui/dashboard/MemoryPanel.tsx fallow/tests/unit/dashboard.test.tsx
git commit -m "feat: show how much memory an unload actually freed"
```

---

## Final check

- [ ] Run the whole suite once: `npm test` (from `fallow/`)
- [ ] Run the type checker: `npm run typecheck`
- [ ] Confirm the layering guard test (`tests/unit/ui-components.test.tsx`, "the ui layer reaches background/ only through type-only imports") still passes — nothing in this plan adds a runtime import from `src/background/`.
