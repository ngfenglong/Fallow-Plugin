# Fallow — current focus for the next session

## Popup layout fix: VERIFIED OK by the owner

The owner reported the popup looked **"weird and cramped"**; root cause and fix are at
commit `2b092d0` (page-level layout added to `fallow/src/ui/components/theme.css` — a
fixed-width `.popup` container, a flex column with a consistent gap, a `.popup-actions` row
for confirm/cancel, a `.popup-footer` separator above "Open dashboard"). The owner loaded
the real build and confirmed it looks right now — **this is closed, not open work.** Don't
re-litigate it or re-touch that CSS unless the owner raises something new.

## Task 15 (device memory provider) and Task 17 (real dashboard): DONE, VISUALLY UNVERIFIED

The owner asked to resume the parked plan at Task 17; Task 15 was a hard prerequisite
Task 17 consumes (`createDeviceMemoryProvider`, `createCapabilityRegistry`,
`formatBytes`/`formatDelta`/`summariseBeforeAfter`, `createSamplingLock`) and had never
been built, so both were done in order with the owner's confirmation first. Commits
`1f6fd30` (Task 15) and `a81f43d`+`d5e790e` (Task 17, incl. one fix round). Both reviewed
clean — 1058 tests, typecheck clean, build clean.

`fallow/src/ui/dashboard/main.tsx` is now the real dashboard (App, Header, Summary,
MemoryPanel, TabTable, Filters, SettingsPanel), not the placeholder stub. It links
`theme.css` from its first commit (the gap Task 18's popup had to fix after the fact is not
repeated here). `REGISTER_DASHBOARD_ORIGIN` is now actually sent — Task 18's popup
deliberately left this to Task 17; that gap is now closed.

**This has had zero eyes on it, mine or the owner's** — same screenshot constraint as the
popup round (`claude-in-chrome` can't reach `chrome://extensions` or a native file picker;
Playwright's `--load-extension` flag proves out mechanically but needs
`npx playwright install`, which the owner hasn't approved). A green suite and two review
passes are not proof of visual layout. **First move next session: ask the owner what they
saw when they loaded the dashboard**, the same way the popup fix was actually confirmed —
don't assume it's fine, and don't assume more polish is wanted until they've looked.

Two deferred minors worth knowing about if the owner reports something off: `App.tsx` is
336 lines, larger than its sibling components (self-flagged as a future hook-extraction
candidate, not a bug); the "Keep loaded" caption renders statically rather than appearing
only after a click, so if the owner expects it to appear conditionally, that's a real gap,
not a test gap. Full list of deferred minors is in the ledger's Task 17 entries.

## Current priority: open — ask the owner

Ask what they saw loading the dashboard, then what they want next: dashboard polish, or
resuming the still-parked plan (Task 19 Chrome settings panel + activity log, Task 20 E2E
tests, Task 21 acceptance matrix/packaging/final review).

Files that matter for dashboard polish: `fallow/src/ui/dashboard/*.tsx`,
`fallow/src/ui/components/theme.css` (shared visual rules, also used by the popup — check
both pages after any change there). No test asserts on `className`, so markup/classes are
free to adjust, but always run `cd fallow && npm test && npm run typecheck && npm run build`
before calling a change done — a green suite doesn't prove visual layout.

## Longer history and full context

Every decision, ruling, and review from Tasks 11–18 (the action executor through the popup)
and Tasks 15/17 (the device memory provider and dashboard, just completed) is recorded in
`.superpowers/sdd/2026-10-28-fallow/progress.md` — the authoritative ledger for this
project, read by the superpowers SDD workflow. The original 21-task plan is at
`docs/superpowers/plans/2026-10-28-fallow.md`; the design spec at
`docs/superpowers/specs/2026-10-28-fallow-design.md`.

**Parked, not abandoned** — resume only if the owner asks: Task 19 (Chrome settings panel +
activity log), Task 20 (E2E tests), Task 21 (acceptance matrix A01–A24, benchmarks,
packaging, final review). Several carry-forwards are already queued for whichever of these
resumes first — see the ledger's most recent entries for the full list (a narrow tracker
race and an unmeasured Chrome event-ordering question, both carried into Task 21's A12
fault-injection acceptance item; a soft carry-forward about the unused `KEYS.memorySamples`
ring buffer if a future sample-history feature is ever built).
