# Fallow — Hardening & Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the review-flagged FE gaps from the Phase 1 UX pass first, then build out the remaining pre-release scope — Chrome settings/activity log, E2E coverage, acceptance/packaging/README, and the two still-open roadmap phases (Chrome-process memory, install/update tooling) — each gated by its own feasibility finding where the underlying capability isn't yet proven.

**Architecture:** This plan spans several independent subsystems on purpose, the same way the original core-extension plan did (`docs/TASKS.md` documents that precedent) — splitting it further would scatter closely-related review findings across files for no benefit. Tasks 1–5 are pure `ui/` fixes, no new files, no protocol changes. Tasks 6–7 add two new dashboard panels and a Playwright harness respectively. Tasks 8–9 are feasibility-gated: each starts with a bounded spike and only proceeds to a build step if the spike's own finding says to. Task 10 closes out acceptance, packaging, and the README.

**Tech Stack:** React + TypeScript + Vite, Vitest + `@testing-library/react` (`fireEvent`, no `user-event`), Playwright (new, Task 7), plain CSS via `theme.css`.

**Spec:** `docs/design/HLD.md` and `docs/design/LLD.md` (as-built architecture — read both before Task 1); `Fallow_Engineering_Plan.md` (root product spec — binding for Tasks 6, 8, 9, 10 in particular, which touch product-level constraints those tasks cite directly).

## Global Constraints

- `fallow/src/ui/` may only take **type-only** imports from `fallow/src/background/` — no task below adds a runtime import crossing that line. Pinned test: "the ui layer reaches background/ only through type-only imports."
- No raw HTML for owner-supplied text (tab/group titles, activity-log entries) — plain-text React children only.
- No shipped string says "suspend" or "undo"; a capability that is off or unavailable is skipped entirely, never rendered as a fabricated zero/NaN.
- `domain/eligibility.ts`'s fail-closed rule is not touched by this plan — Tasks 1–5 only change `ui/`; no task here modifies `domain/`, `background/executor.ts`, or any field of `shared/messages.ts` (Task 6 wires up `GET_HISTORY`/`CLEAR_HISTORY`, which already exist there and are currently unused by any `ui/` code — it adds no new message type).
- `chrome.processes` is Dev-channel-only on Stable Chrome (`Fallow_Engineering_Plan.md` §18, [S3]) and is explicitly excluded from "version 1" (`Fallow_Engineering_Plan.md` §2, line 218). Task 8 may not request the `processes` permission or assume it is available; its own spike step is where this gets re-verified against current Chrome documentation, not assumed from this plan.
- No new permission beyond `tabs`, `tabGroups`, `storage`, `alarms`, optional `system.memory` (`fallow/public/manifest.json`) without a spike finding that justifies it and the owner's explicit sign-off — this applies to Tasks 8 and 9 both.
- Test commands (run from `fallow/`): `npm test`, `npm run typecheck`, `npm run build`; Task 7 adds `npm run e2e`, Task 10 adds `npm run package`.

## Review Focus

- A threshold or settings write that fails silently: Task 3 pins the Enter-key commit and a failed `UPDATE_SETTINGS` surfacing to the owner, not a value that quietly reverts with no explanation.
- Two unloads (bulk + a tab, or two tabs) in flight at once producing a memory reading that describes the wrong action, or a busy guard that lets a duplicate request through: Task 1 (memory delta) and Task 4 (busy guard across the ack flow) both pin this directly.
- A visible UI label whose accessible name doesn't match it, silently breaking voice control / screen-reader users who act on what they see: Task 2's whole point.
- A Chrome settings or activity-log row that implies control or knowledge Fallow doesn't actually have (an embedded settings page, a live on/off switch for something unreadable, crediting Fallow for an externally-observed unload): Task 6 pins this with dedicated tests, mirroring the existing copy-rules convention.
- A feasibility task (8 or 9) that quietly turns into a committed build without its own go/no-go finding being written down first: both tasks' Step 1 is explicitly a decision gate, not a formality.

---

## Task 1: Memory panel — an honest "Available" reading and a safe "Freed" figure

**Files:**
- Modify: `fallow/src/ui/dashboard/MemoryPanel.tsx`
- Modify: `fallow/src/ui/dashboard/App.tsx:331-360` (`dispatchUnloadTab`), `:288-327` (`handleConfirm`)
- Test: `fallow/tests/unit/dashboard.test.tsx`

**Interfaces:**
- `MemoryPanel`'s props are unchanged (`{ enabled, provider, delta }`). Internally: when a new `delta` with `status === 'complete'` arrives, it also calls `setAvailableBytes(delta.after!.availableBytes)` so "Available" reflects the same reading "Freed" is computed from, instead of only the reading taken on mount/enable.
- When `delta.deltaBytes !== null && delta.deltaBytes < 0`, the "Freed" line renders a muted note instead of a plain negative figure: `Freed: <span data-testid="memory-freed">little or none — device memory moved up slightly during the reading</span>` (exact text; this is the one case `formatDelta` is not called for in the rendered line — still call it for `deltaBytes >= 0`).
- `App.tsx`: `UNLOAD_EXECUTE` requests already carry `operationId` for bulk (`preview.operationId`); `dispatchUnloadTab` gains its own per-call id (`operationId: \`tab-${tabId}-${Date.now()}\``) passed the same way. The `memoryDelta` **state variable** (not `MemoryPanel`'s prop — see above) becomes `{ operationId: string; delta: BeforeAfter } | null` instead of bare `BeforeAfter | null` — both `handleConfirm`'s and `dispatchUnloadTab`'s `delta.then(...)` callbacks tag their own update with the `operationId` they sent. Where `App.tsx` renders `<MemoryPanel delta={memoryDelta} />` today, it changes to `<MemoryPanel delta={memoryDelta?.delta ?? null} />` — `MemoryPanel` itself still only ever sees a bare `BeforeAfter | null`, unaware the tag exists; "most recent wins" semantics are unchanged (the fix is that `App.tsx`'s own state can now say what a reading described, not that overlap is prevented or that the rendered panel changes further). No new prop on `MemoryPanel` — this task's own test only proves the tag travels correctly through `App.tsx`'s state and the right request, not a new visible label.

- [ ] **Step 1: Write the failing tests**

```tsx
it('updates Available to the after-sample once a complete delta arrives', async () => {
  const before = { at: 1, capacityBytes: 16 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 };
  const after = { at: 2, capacityBytes: 16 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 };
  const delta = summariseBeforeAfter(before, after);
  const { rerender } = render(<MemoryPanel enabled provider={stubProvider([])} delta={null} />);
  rerender(<MemoryPanel enabled provider={stubProvider([])} delta={delta} />);
  await waitFor(() => expect(screen.getByTestId('memory-available')).toHaveTextContent('6.0 GiB'));
});

it('shows a reassuring note instead of a negative figure when the device reading moved the wrong way', async () => {
  const before = { at: 1, capacityBytes: 16 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 };
  const after = { at: 2, capacityBytes: 16 * 1024 ** 3, availableBytes: 5 * 1024 ** 3 };
  render(<MemoryPanel enabled provider={stubProvider([])} delta={summariseBeforeAfter(before, after)} />);
  expect(await screen.findByTestId('memory-freed')).toHaveTextContent(/little or none/i);
});
```

```tsx
it('tags a memory delta with the operationId of the action that produced it', async () => {
  localStorage.setItem('fallow.bulkAcknowledged', '1');
  snapshot = snapshotFixture({
    windows: [windowFixture(1, { ungroupedTabIds: [5] })],
    rows: [rowFixture({ tabId: 5 })],
    counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
    settings: defaultSettings({ deviceMemoryMonitoringEnabled: true }),
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: /unload now/i }));
  await waitFor(() => expect(fake.lastRequest).toMatchObject({ type: 'UNLOAD_EXECUTE', scope: { kind: 'tab', tabId: 5 } }));
  expect(fake.lastRequest.operationId).toMatch(/^tab-5-/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- dashboard.test.tsx -t "Available to the after-sample|a negative figure|tags a memory delta"`
Expected: FAIL.

- [ ] **Step 3: Implement the `MemoryPanel` changes**

- [ ] **Step 4: Implement the `operationId`/tagged-`memoryDelta` changes in `App.tsx`**

Keep `handleConfirm` and `dispatchUnloadTab` otherwise unchanged (no new behavior beyond the tag).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- dashboard.test.tsx -t "Available to the after-sample|a negative figure|tags a memory delta"`
Expected: PASS.

- [ ] **Step 6: Run the full dashboard suite, then commit**

Run: `npm test -- dashboard.test.tsx`

```bash
git add fallow/src/ui/dashboard/MemoryPanel.tsx fallow/src/ui/dashboard/App.tsx fallow/tests/unit/dashboard.test.tsx
git commit -m "fix: keep Available in step with Freed, and tag memory deltas by operation"
```

---

## Task 2: Accessible names match their visible labels

**Files:**
- Modify: `fallow/src/ui/dashboard/Filters.tsx`
- Modify: `fallow/src/ui/components/ThresholdInput.tsx`
- Test: `fallow/tests/unit/dashboard.test.tsx`

**Interfaces:** No prop or type changes anywhere in this task. Each control already sits inside a `<label>` whose child `<span>`/text is the real visible label ("Search", "Sort by", "Show", "Threshold (minutes)"); each also carries a standalone `aria-label` that currently overrides that implicit accessible name with different text ("Search tabs", "Sort", "Filter", "Threshold in minutes") — a WCAG 2.5.3 violation (a person who speaks what they see won't hit the control). Fix: remove the four standalone `aria-label` attributes. The accessible name then comes from the wrapping `<label>` alone and exactly matches the visible text.

- [ ] **Step 1: Update the tests that currently query by the old aria-labels**

In `fallow/tests/unit/dashboard.test.tsx`, change:
- `screen.getByLabelText('Filter')` → `screen.getByLabelText('Show')` (both occurrences)
- `screen.getByLabelText('Sort')` → `screen.getByLabelText('Sort by')` (all occurrences)
- `screen.findByLabelText(/threshold in minutes/i)` → `screen.findByLabelText(/threshold \(minutes\)/i)` (both occurrences)
- `screen.findByLabelText('Search tabs')` → `screen.findByLabelText('Search')`

- [ ] **Step 2: Run the updated tests to verify they now fail against the OLD markup**

Run: `npm test -- dashboard.test.tsx`
Expected: FAIL — the new queries don't match the aria-labels still in place.

- [ ] **Step 3: Remove the four `aria-label` attributes in `Filters.tsx` and `ThresholdInput.tsx`**

- [ ] **Step 4: Run the full dashboard suite to verify it passes**

Run: `npm test -- dashboard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fallow/src/ui/dashboard/Filters.tsx fallow/src/ui/components/ThresholdInput.tsx fallow/tests/unit/dashboard.test.tsx
git commit -m "fix: stop aria-label from overriding the visible label text on filter and threshold controls"
```

---

## Task 3: Threshold input — commit on Enter, and surface a failed save

**Files:**
- Modify: `fallow/src/ui/components/ThresholdInput.tsx`
- Modify: `fallow/src/ui/dashboard/SettingsPanel.tsx`
- Modify: `fallow/src/ui/dashboard/App.tsx` (one line: pass the new `onSaveFailed` prop to `<SettingsPanel>`)
- Test: `fallow/tests/unit/dashboard.test.tsx`

**Interfaces:**
- `ThresholdInput` gains an `onKeyDown` handler on the `<input>`: pressing `Enter` calls the same commit path the existing `onBlur` uses (extract the current `onBlur` body into a named `commitDraft()` closure, called from both `onBlur` and a `key === 'Enter'` check in `onKeyDown`).
- **`onCommit`'s own type changes** from `(next: number) => void` to `(next: number) => Promise<void>`, because reverting the input's displayed value on a failed save is `ThresholdInput`'s own job (it owns `draft`), not something a parent can do by changing `minutes` — the `minutes` prop never changes on a failed save, so the existing `useEffect(() => setDraft(String(minutes)), [minutes])` would never re-fire and the input would keep showing the rejected value forever. Fix: `commit()` becomes `async`, `await`s `onCommit(next)`, and on a thrown/rejected call does `setDraft(String(minutes))` itself:
  ```ts
  const commit = async (next: number) => {
    if (next !== minutes && isValidThreshold(next)) {
      try {
        await onCommit(next);
      } catch {
        setDraft(String(minutes));
      }
    }
  };
  ```
  Both call sites (`onBlur`, the preset `onClick`, and the new `onKeyDown`) call `void commit(next)` — fire-and-forget, matching the codebase's existing `void sendRequest(...)` convention; no caller needs to await it.
- `SettingsPanel`'s `onCommit` prop passed to `ThresholdInput` becomes an `async` function that `await`s `sendRequest`, and on failure both reports it upward AND rethrows so `ThresholdInput`'s `catch` above actually runs:
  ```ts
  onCommit={async (next) => {
    try {
      await sendRequest({ type: 'UPDATE_SETTINGS', patch: { inactivityMinutes: next } });
    } catch {
      onSaveFailed('Fallow could not save the new threshold. It still shows the old value.');
      throw new Error('revert'); // rethrown so ThresholdInput's commit() reverts its draft
    }
  }}
  ```
  `SettingsPanel`'s own props grow to `{ settings: Settings; onSaveFailed: (message: string) => void }`; `App.tsx`'s render call passes `onSaveFailed={(message) => setAnnouncement({ tone: 'alert', text: message })}` (reusing the existing `announcement`/`setAnnouncement` mechanism, no new state).

- [ ] **Step 1: Write the failing tests**

```tsx
it('commits a valid threshold on Enter, not just on blur', async () => {
  snapshot = snapshotFixture({ settings: defaultSettings({ inactivityMinutes: 15 }) });
  render(<App />);
  const input = await screen.findByLabelText(/threshold \(minutes\)/i);
  fireEvent.change(input, { target: { value: '45' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(fake.lastRequest).toMatchObject({ type: 'UPDATE_SETTINGS', patch: { inactivityMinutes: 45 } }));
});

it('tells the owner when a threshold save fails, and keeps showing the old value', async () => {
  snapshot = snapshotFixture({ settings: defaultSettings({ inactivityMinutes: 15 }) });
  responder = (m) => m.type === 'UPDATE_SETTINGS'
    ? { ok: false, requestId: m.requestId, error: 'boom' }
    : (m.type === 'GET_SNAPSHOT' ? ok(m.requestId, snapshot) : ok(m.requestId, null));
  render(<App />);
  const input = await screen.findByLabelText(/threshold \(minutes\)/i);
  fireEvent.change(input, { target: { value: '45' } });
  fireEvent.blur(input);
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not save the new threshold/i);
  expect(input).toHaveValue(15);
});
```

(No `err()` helper exists yet in this file — only `ok()`. The literal `{ ok: false, requestId, error }` object above is enough; don't add a new helper for one use.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- dashboard.test.tsx -t "Enter, not just on blur|threshold save fails"`
Expected: FAIL.

- [ ] **Step 3: Implement the Enter-key commit in `ThresholdInput.tsx`, and the failure path through `SettingsPanel.tsx`/`App.tsx`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- dashboard.test.tsx -t "Enter, not just on blur|threshold save fails"`
Expected: PASS.

- [ ] **Step 5: Run the full dashboard suite, then commit**

```bash
git add fallow/src/ui/components/ThresholdInput.tsx fallow/src/ui/dashboard/SettingsPanel.tsx fallow/src/ui/dashboard/App.tsx fallow/tests/unit/dashboard.test.tsx
git commit -m "fix: commit the threshold on Enter and tell the owner when a save fails"
```

---

## Task 4: Per-tab unload — busy guard covers the whole ack flow, and the dialog is reachable

**Files:**
- Modify: `fallow/src/ui/dashboard/App.tsx`
- Test: `fallow/tests/unit/dashboard.test.tsx`

**Interfaces:**
- `handleUnloadTab(tabId)`'s not-yet-acknowledged branch currently arms the ack dialog and returns immediately — `Row`'s `unloading` guard (in `TabTable.tsx`, unchanged by this task) therefore releases before the real request is ever sent, since it only wraps the call to `onUnload`. Fix: `handleUnloadTab` becomes `async` and, on that branch, returns a `Promise<void>` that resolves only once `dispatchUnloadTab` actually settles:
  ```ts
  async function handleUnloadTab(tabId: number) {
    if (!hasAcknowledgedBulk()) {
      await new Promise<void>((resolve) => {
        setBulk({
          step: 'ack',
          then: () => {
            if (mountedRef.current) setBulk({ step: 'idle' });
            void dispatchUnloadTab(tabId).finally(resolve);
          },
        });
      });
      return;
    }
    await dispatchUnloadTab(tabId);
  }
  ```
  This keeps `Row`'s existing `unloading` guard meaningful across the whole dialog-open period, with no change needed in `TabTable.tsx`.
- A new `ackDialogRef = useRef<HTMLDivElement>(null)` is attached to the `role="alertdialog"` div (currently unreferenced). A `useEffect` keyed on `bulk.step` calls `ackDialogRef.current?.scrollIntoView({ block: 'center' })` and focuses the dialog's "Continue" button (give that `Button` its own `continueButtonRef` and call `.focus()`) whenever `bulk.step` transitions to `'ack'`. The `div` gains `tabIndex={-1}` so it's a valid focus/scroll target even though it's not itself a form control.

- [ ] **Step 1: Write the failing tests**

```tsx
it('keeps Unload now disabled for the whole ack-dialog round trip, not just until the dialog opens', async () => {
  snapshot = snapshotFixture({
    windows: [windowFixture(1, { ungroupedTabIds: [5] })],
    rows: [rowFixture({ tabId: 5 })],
    counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
  });
  render(<App />);
  const button = await screen.findByRole('button', { name: /unload now/i });
  fireEvent.click(button);
  await screen.findByRole('alertdialog', { name: /confirm unloading tabs/i });
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
  await waitFor(() => expect(button).not.toBeDisabled());
});

it('scrolls to and focuses the ack dialog when it opens', async () => {
  // Reuse the module-scope `scrollIntoViewSpy` (set up in this file's existing
  // beforeEach/afterEach, spying on Element.prototype.scrollIntoView) — do not
  // re-stub it here.
  snapshot = snapshotFixture({
    windows: [windowFixture(1, { ungroupedTabIds: [5] })],
    rows: [rowFixture({ tabId: 5 })],
    counts: { total: 1, loaded: 1, unloaded: 0, eligible: 1, protected: 0 },
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: /unload now/i }));
  await screen.findByRole('alertdialog', { name: /confirm unloading tabs/i });
  expect(scrollIntoViewSpy).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /^continue$/i })).toHaveFocus();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- dashboard.test.tsx -t "whole ack-dialog round trip|scrolls to and focuses"`
Expected: FAIL.

- [ ] **Step 3: Implement the awaited-continuation change to `handleUnloadTab`**

- [ ] **Step 4: Implement the scroll/focus effect and the two new refs**

- [ ] **Step 5: Run tests to verify they pass, then run the full dashboard suite**

Run: `npm test -- dashboard.test.tsx`
Expected: PASS, including the existing Task 3 ack-dialog-closes-correctly tests (this task must not regress them — they exercise the same `bulk.step === 'ack'` transition).

- [ ] **Step 6: Commit**

```bash
git add fallow/src/ui/dashboard/App.tsx fallow/tests/unit/dashboard.test.tsx
git commit -m "fix: keep Unload now disabled through the whole ack dialog, and make the dialog reachable"
```

---

## Task 5: Copy accuracy and small cleanup batch

A batch of four small, independent fixes — one dispatch, one review, per this plan's own "batch small same-shape work" convention.

**Files:**
- Modify: `fallow/src/ui/dashboard/SettingsPanel.tsx` (two copy fixes)
- Modify: `fallow/src/ui/popup/App.tsx` (dedup)
- Modify: `fallow/src/ui/components/theme.css` (selector)
- Test: `fallow/tests/unit/dashboard.test.tsx`, `fallow/tests/unit/popup.test.tsx`

**Changes:**
1. `SettingsPanel.tsx`'s "Unload now" line currently reads "no minimum wait; only a pinned, playing, selected, or protected tab is skipped." — inaccurate per `domain/eligibility.ts` (also skips an unsupported/internal page, a still-loading tab, an already-unloaded tab, and one Chrome itself marked non-discardable). Replace with: "**Unload now**, on a single tab — no minimum wait; skipped only if the tab is pinned, playing audio, currently selected, kept loaded, site-protected, already unloaded, still loading, or one Chrome itself protects."
2. The "Automatic unloading" help line currently reads "Turning this on only means Fallow checks how long tabs have sat idle — it doesn't keep tabs loaded or use extra memory itself." Replace with: "Turning this on only means Fallow keeps track of how long each tab has been idle; it doesn't use extra memory itself."
3. `popup/App.tsx`'s `handleOpenDashboard` and `handleOpenSettings` are near-identical. Extract `async function openDashboardTab(fragment?: string): Promise<void>` that does the origin-tab lookup, builds the URL (appending `fragment` when given), and calls `chrome.tabs.create` inside the same try/catch both currently use. `handleOpenDashboard` becomes `() => openDashboardTab()`; `handleOpenSettings` becomes `() => openDashboardTab('#settings')`.
4. `theme.css` lines 103–105: replace the `section[aria-label="Filters"]` selector with `.filters` in all three rules; `Filters.tsx`'s `<section>` gains `className="panel filters"` (keep the existing `panel` class alongside it).

- [ ] **Step 1: Write/update the failing tests**

```tsx
// dashboard.test.tsx
it('explains Unload now covers every real skip reason, not a shortened list', async () => {
  render(<App />);
  expect(await screen.findByText(/skipped only if the tab is pinned, playing audio/i)).toBeInTheDocument();
});
```

```tsx
// popup.test.tsx — no new test needed if the existing "Settings" button test
// (added in Task 2 of the prior phase) already asserts the resulting URL; confirm
// it still passes unchanged after the extraction (it should — same URLs, same behavior).
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npm test -- dashboard.test.tsx -t "every real skip reason"`
Expected: FAIL.

- [ ] **Step 3: Make all four changes**

- [ ] **Step 4: Run the full dashboard and popup suites to verify everything passes**

Run: `npm test -- dashboard.test.tsx popup.test.tsx`
Expected: PASS, with the pre-existing popup "Settings" URL test still green (proves the dedup didn't change behavior).

- [ ] **Step 5: Commit**

```bash
git add fallow/src/ui/dashboard/SettingsPanel.tsx fallow/src/ui/popup/App.tsx fallow/src/ui/components/theme.css fallow/tests/unit/dashboard.test.tsx fallow/tests/unit/popup.test.tsx
git commit -m "fix: correct Unload now's skip-reason copy, clarify the automation note, dedup popup URL building, decouple filter CSS from aria-label"
```

---

## Task 6: Chrome settings panel and activity log

Carried forward unchanged in substance from the original plan's "Task 19." Before Step 1, run `git show 5aab3be~1:docs/superpowers/plans/2026-10-28-fallow.md | sed -n '2106,2192p'` to read that task's full original text (file structure, exact test bodies, step-by-step) — nothing about this task's scope changed when the old plan file was deleted; only its location did. Five settings rows per `Fallow_Engineering_Plan.md` F5 (Memory Saver, Always keep these sites active, Energy Saver, Preload pages, Chrome Task Manager) — each a user-clicked link plus a copyable address, never an embedded settings page and never a status switch for a setting Fallow cannot read — plus an activity log (trigger/result/timestamp with an expandable reason, hostnames only, never a full URL, "Observed unload; source unknown" for an externally-triggered entry, "Clear history").

**Files:**
- Create: `fallow/src/ui/dashboard/ChromeSettingsPanel.tsx`, `fallow/src/ui/dashboard/ActivityLog.tsx`
- Create: `fallow/src/ui/dashboard/chrome-settings-copy.ts`
- Test: `fallow/tests/unit/chrome-settings.test.tsx`, `fallow/tests/unit/activity-log.test.tsx`
- Modify: `fallow/src/ui/dashboard/App.tsx` (render both new panels; `ActivityLog` needs its entries from a new `GET_HISTORY` call — `shared/messages.ts` already defines this request type and `CLEAR_HISTORY`, unused by any `ui/` code today)

- [ ] **Step 1: Write the failing tests**

```ts
it('lists all five settings rows', () => { expect(screen.getAllByTestId(/^settings-row-/)).toHaveLength(5); });
it('shows no on/off control for any chrome setting', () => {
  expect(within(screen.getByTestId('settings-panel')).queryAllByRole('switch')).toEqual([]);
  expect(within(screen.getByTestId('settings-panel')).queryAllByRole('checkbox')).toEqual([]);
});
it('says plainly that Fallow cannot read Memory Saver', () => {
  expect(screen.getByText(/its state is not read by this extension/i)).toBeInTheDocument();
});
it('embeds no settings page', () => { expect(document.querySelector('iframe')).toBe(null); });
it('opens the performance settings route on a click and offers a copyable address', async () => {
  fireEvent.click(screen.getByRole('button', { name: /open chrome performance settings/i }));
  expect(fake.lastCreatedUrl).toBe('chrome://settings/performance');
  expect(screen.getByText('chrome://settings/performance')).toBeInTheDocument();
});
it('separates Fallow protected sites from Chrome own list', () => {
  expect(screen.getByText(/independent from this extension/i)).toBeInTheDocument();
});

it('shows trigger, result and timestamp with an expandable reason', async () => {
  render(<ActivityLog entries={[entry({ trigger: 'manual-bulk', outcome: 'skipped', reason: 'AUDIBLE' })]} />);
  fireEvent.click(screen.getByRole('button', { name: /details/i }));
  expect(screen.getByText('Audible')).toBeInTheDocument();
});
it('describes an externally unloaded tab without claiming credit', () => {
  render(<ActivityLog entries={[entry({ trigger: 'external', outcome: 'confirmed' })]} />);
  expect(screen.getByText('Observed unload; source unknown')).toBeInTheDocument();
});
it('shows hostnames and never a full url', () => {
  expect(screen.getByText('example.com')).toBeInTheDocument();
  expect(screen.queryByText(/https:\/\//)).toBe(null);
});
it('clears history on request', async () => {
  fireEvent.click(screen.getByRole('button', { name: /clear history/i }));
  expect(fake.lastRequest).toMatchObject({ type: 'CLEAR_HISTORY' });
});
```

All copy lives in `chrome-settings-copy.ts` as exported constants, so a future copy-rules scan (Task 10) can check it alongside the rest of the shipped strings.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- chrome-settings activity-log`
Expected: FAIL.

- [ ] **Step 3: Implement both panels and wire `ActivityLog` to `GET_HISTORY`/`CLEAR_HISTORY` in `App.tsx`**

- [ ] **Step 4: Run tests to verify they pass, then the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fallow/src/ui/dashboard fallow/tests/unit/chrome-settings.test.tsx fallow/tests/unit/activity-log.test.tsx
git commit -m "feat: add chrome settings assistance and an activity log"
```

---

## Task 7: End-to-end tests

Carried forward from the original plan's "Task 20." Before Step 1, run `git show 5aab3be~1:docs/superpowers/plans/2026-10-28-fallow.md | sed -n '2195,2280p'` to read the full original spec and test bodies verbatim — nothing about these cases changed. Exercises the real unpacked build in persistent-context Chromium, catching integration defects across Tasks 1–6 and the original core extension that no unit test can see (real `chrome.tabs.discard`, real multi-window/group layout, real alarm firing).

**Files:**
- Create: `fallow/playwright.config.ts`, `fallow/tests/e2e/{fixtures,dashboard,unload,automation}.spec.ts`
- Modify: `fallow/package.json` — add `"e2e": "playwright test"`

**Interfaces:**
- `fixtures.ts` produces a Playwright fixture launching persistent-context Chromium with `--disable-extensions-except=<dist>` and `--load-extension=<dist>`, exposing the extension id and a helper that opens N tabs across 3 windows with 2 groups.

- [ ] **Step 1: Write the failing specs**

```ts
test('inventory matches the browser without rearranging anything', async () => { /* A01 */ });
test('a single unload leaves the tab in place and reloads it on return', async () => { /* A02 */ });
test('a selected tab in an unfocused window is skipped', async () => { /* A04 */ });
test('the dashboard origin tab is excluded from an immediate bulk action', async () => { /* A14 */ });
test('an internal page offers no unload action', async () => { /* A19 */ });
test('automation unloads an idle tab at a later check and not before', async () => { /* A03 */ });
test('automation keeps running with no dashboard open', async () => { /* A20 */ });
test('the dashboard refreshes when chrome unloads a tab independently', async () => { /* A12 */ });
test('core features work with the memory permission denied', async () => { /* A13 */ });
```

(Full assertion bodies for each are in the git-show output from the note above this task's Files block; nothing about these cases has changed.)

- [ ] **Step 2: Run the specs to verify they fail**

Run: `npm run build && npm run e2e`
Expected: FAIL.

- [ ] **Step 3: Fix whatever the specs expose**

These specs exercise wiring across the core extension and Task 6's new panels, so failures here are integration defects in that existing code, not new features to add.

- [ ] **Step 4: Run the specs to verify they pass**

Run: `npm run e2e`
Expected: PASS. Note in the commit message any spec that cannot run headless and must move to Task 10's manual acceptance list.

- [ ] **Step 5: Commit**

```bash
git add fallow/playwright.config.ts fallow/tests/e2e fallow/package.json
git commit -m "test: add playwright coverage for the principal ui paths"
```

---

## Task 8: Chrome-process memory — feasibility spike

This is "Phase 2" of the roadmap. **Not a committed build** — `chrome.processes` is Dev-channel-only on Stable Chrome today (`Fallow_Engineering_Plan.md` §18, [S3]), and the root spec itself frames per-tab process monitoring as "a separate discovery project" (§17). This task produces a finding and a go/no-go recommendation; it builds a `processMemory`/`processCpu` `CapabilityProvider` (the slot already reserved in `platform/memory-provider.ts`, see `docs/design/LLD.md` §4) **only if** the spike's own finding says Stable-channel support exists today.

**Files:**
- Create: `docs/superpowers/specs/2026-11-02-chrome-process-memory-feasibility.md`
- Conditionally create (only if Step 1 says to): `fallow/src/platform/memory-provider.ts` additions for a `processMemory`/`processCpu` provider, its own test file.

- [ ] **Step 1: Re-verify `chrome.processes` availability against current Chrome documentation**

Check `https://developer.chrome.com/docs/extensions/reference/api/processes` (and any successor/replacement API Chrome has since shipped) against the Stable channel, the project's minimum Chrome version (120, `Fallow_Engineering_Plan.md` §15), and whether a `processes` permission is still restricted to a non-Stable channel. Also assess the native-messaging-companion alternative the root spec names (§17) — OS permissions/install burden, security/update model, and whether per-tab process attribution is even well-defined (tabs can share a process; shared browser/GPU services exist outside any tab).

Write the finding to `docs/superpowers/specs/2026-11-02-chrome-process-memory-feasibility.md`: what was checked, the dated sources, and an explicit **Go** (Stable-channel path exists — proceed to Step 2) or **No-go** (doesn't exist, or only exists via a native companion big enough to need its own separate scoping and the owner's explicit sign-off before any code is written) recommendation.

- [ ] **Step 2 (Go path only): Write the failing test for the new provider**

```ts
it('reports unavailable, not a fabricated number, when the underlying API is absent', async () => {
  const provider = createProcessMemoryProvider(/* fake chrome with no matching API */);
  expect(await provider.isAvailable()).toBe(false);
});
```

- [ ] **Step 3 (Go path only): Implement `createProcessMemoryProvider`/`createProcessCpuProvider`** matching the existing `CapabilityProvider` shape (`platform/memory-provider.ts`), registered under the `'processMemory'`/`'processCpu'` keys already reserved in `CapabilityKey`.

- [ ] **Step 4 (Go path only): Run tests, typecheck, then commit**

```bash
git add docs/superpowers/specs fallow/src/platform/memory-provider.ts fallow/tests
git commit -m "feat: add a Chrome-process memory capability provider" # only if Step 1 said Go
```

- [ ] **Step 5 (No-go path): commit the finding alone, and stop here**

```bash
git add docs/superpowers/specs
git commit -m "docs: record the chrome-process memory feasibility finding (no-go for this version)"
```

Either way, update `docs/design/HLD.md` §3's open-items list and bump its version per `CLAUDE.md`'s versioning rule — this is exactly the kind of design-affecting change that rule exists for.

---

## Task 9: Install/update tooling for a non-technical owner

This is "Phase 3." The roadmap only ever described this as one line ("in-repo install/update tooling for non-technical users") — this task's first step is pinning down what that concretely means before building anything, the same discipline Task 8 applies to feasibility.

- [ ] **Step 1: Define the concrete scope, in writing, before any code**

The extension is loaded unpacked (`chrome://extensions`, Developer mode) — there is no Chrome Web Store listing in this version (`Fallow_Engineering_Plan.md` doesn't commit to one). "Install/update tooling for a non-technical owner" most plausibly means: a single script or short guide that (a) builds `dist/` from a clean checkout, (b) tells the owner exactly how to point `chrome://extensions`'s "Load unpacked" at it, and (c) gives a one-command way to rebuild after a `git pull` without needing to know `npm`/Vite at all. Write this scope decision into `docs/superpowers/specs/2026-11-02-install-update-tooling-design.md` (even three short paragraphs is enough) before Step 2 — if the owner's actual intent turns out to be something larger (an installer `.app`, an auto-update checker), that is a scope conversation to have explicitly, not something to infer and build silently.

- [ ] **Step 2: Write the failing test for the build/package script**

```ts
it('produces a dist/ the manifest points at, from a clean build', () => {
  // scripted smoke test: run the build command, assert dist/manifest.json exists
  // and its version matches fallow/package.json
});
```

- [ ] **Step 3: Implement the install/update script per the Step 1 scope** (e.g. `fallow/scripts/install-or-update.sh` or an `npm run setup` alias — exact mechanism is the Step 1 decision, not re-decided here)

- [ ] **Step 4: Run the test, then write the short owner-facing instructions** (a few paragraphs — can live in the eventual README from Task 10, or its own `docs/INSTALL.md` if Task 10 hasn't landed yet)

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs fallow/scripts docs/INSTALL.md
git commit -m "feat: add install/update tooling for a non-technical owner"
```

---

## Task 10: Acceptance matrix, benchmarks, packaging, and the README

Closes out the remainder of the original plan's "Task 21" and roadmap "Phase 4" (the HLD/LLD portion of Phase 4 is already done — `docs/design/`).

**Files:**
- Create: `fallow/tests/unit/copy-rules.test.ts`
- Create: `docs/acceptance/2026-11-02-acceptance-results.md`, `docs/acceptance/2026-11-02-benchmarks.md`
- Create: `fallow/README.md`, `docs/PRIVACY.md`, `docs/PERMISSIONS.md`, `docs/RELEASE-CHECKLIST.md`
- Modify: `fallow/package.json` — add `"package": "<build + zip command>"`

- [ ] **Step 1: Write the failing copy-rules test**

```ts
it('keeps forbidden words out of every shipped string', () => {
  expect(matches(/suspend/i)).toEqual([]);
  expect(matches(/\bchrome\b/i, { only: 'extension name and description' })).toEqual([]);
});
it('never ships a zero where a measurement is unavailable', () => { expect(matches(/0 (MB|GB|GiB|bytes)/)).toEqual([]); });
it('calls the add-on an add-on, never an extension', () => { expect(matches(/Probe extension/i)).toEqual([]); });
it('describes reloading as a reload, never an undo', () => { expect(matches(/undo/i)).toEqual([]); });
it('declares no permission beyond the agreed set', () => {
  expect(manifest.permissions).toEqual(['tabs', 'tabGroups', 'storage', 'alarms']);
});
```

Scans `src/**/*.{ts,tsx,css,html}` and `public/manifest.json` — include Task 6's `chrome-settings-copy.ts` and Task 8/9's new copy, if any, in the scan path.

- [ ] **Step 2: Run the full suite, build, and e2e**

Run: `npm test && npm run typecheck && npm run build && npm run e2e`
Expected: all PASS — fix anything that fails before continuing.

- [ ] **Step 3: Run the acceptance matrix on the owner's real Chrome profile**

Per `Fallow_Engineering_Plan.md` §11.3, work through A01–A24 (§14) against real windows/groups/tabs. Record each case's steps, observed result, PASS/FAIL, and method where contrived. Record failures as failures (§11.2 forbids dropping a case quietly) — a materially larger matrix than estimated goes back to the owner as a scope conversation, not a silent cut.

- [ ] **Step 4: Record benchmarks**

Per `Fallow_Engineering_Plan.md` §13: idle CPU, a 200-tab scan/action run (target <5s excluding browser delays), 200-tab dashboard control response (target <200ms), idle/visible memory from Chrome's own Task Manager. Record measured numbers and the machine, not the targets.

- [ ] **Step 5: Write the README and handoff docs**

`README.md`: what Fallow does, why, build-from-source, "Load unpacked" steps (point to Task 9's install tooling), Chrome's periodic Developer-mode nag. `PERMISSIONS.md`: one line per permission and why. `PRIVACY.md`: everything stays on-device, no analytics, no titles/URLs retained in history, uninstall behavior. `RELEASE-CHECKLIST.md`: the recheck list, including re-verifying `Fallow_Engineering_Plan.md` §18's API references and the Chrome version range.

`npm run package` produces `fallow-<version>.zip` from `dist/`.

- [ ] **Step 6: Commit**

```bash
git add fallow docs
git commit -m "chore: acceptance results, benchmarks, packaging, and the project README"
```

- [ ] **Step 7: Hand to a fresh, most-capable-model reviewer for a whole-plan pass**

Per the same convention this plan's own execution process already uses (`superpowers:subagent-driven-development`'s final whole-branch review) — particular attention to: no measurement shown as zero/estimated, no tab closed/moved/navigated on any path, confirmation by observation rather than API invocation, no keepalive, no permission beyond the agreed set, the capability-provider boundary intact, and `docs/design/HLD.md`/`LLD.md` versions bumped to match whatever shipped in this plan.
