# Fallow — Task List

Running backlog of open work. This file is the single place to look for "what's left" — `CLAUDE.md` stays generic and does not describe any specific task. When an item moves into an active implementation plan, its row says so; when a plan finishes, fold any surviving follow-up back into this file and delete the plan file (see `CLAUDE.md` → "Plans and specs are disposable").

## In the active plan

Everything below is scoped into `docs/superpowers/plans/2026-11-02-fallow-hardening-and-expansion.md` (FE fixes first, then the rest in plan order). Do not duplicate work on these items outside that plan.

| Item | Origin | Notes |
|---|---|---|
| Memory panel "Available" goes stale next to a new "Freed" figure; show `delta.after.availableBytes` once a delta exists | Final review, Phase 1 UX | |
| Negative "Freed" delta reads oddly to a non-developer (whole-device reading can dip over the 10s sample window) | Final review, Phase 1 UX | |
| Overlapping unloads can show a "Freed" reading for the wrong action (`memoryDelta` is untagged shared state) | Final review, Phase 1 UX | `UNLOAD_EXECUTE.operationId` already exists in the protocol and is unused — see `docs/design/LLD.md` §2 |
| Visible label text doesn't match the underlying `aria-label` (WCAG 2.5.3) — `Filters.tsx` ("Sort by"/"Show" vs "Sort"/"Filter"), `ThresholdInput.tsx` ("Threshold (minutes)" vs "Threshold in minutes") | Final review, Phase 1 UX | |
| Threshold field only commits on blur — no Enter-key commit, no feedback if `UPDATE_SETTINGS` fails | Final review, Phase 1 UX | |
| `Row`'s busy guard doesn't cover the first-time ack path — "Unload now" re-enables while `dispatchUnloadTab` is still in flight | Final review, Phase 1 UX | |
| First-time ack dialog may render off-screen if the page is scrolled; no focus management when it opens | Final review, Phase 1 UX | |
| "Unload now" copy oversimplifies which tabs get skipped (omits loading/already-unloaded/browser-protected cases) | Final review, Phase 1 UX | |
| "Automatic unloading" help line wording is muddled/self-evident | Final review, Phase 1 UX | |
| `handleOpenSettings` (popup) duplicates `handleOpenDashboard` almost verbatim | Task 2 review, Phase 1 UX | brief-sanctioned at the time; small dedup opportunity |
| Filter-bar CSS keyed off `section[aria-label="Filters"]` — couples layout to an accessibility attribute; a `.filters` class would be safer | Task 5 review, Phase 1 UX | |
| Chrome settings panel + activity log (5 settings rows, link-out only, never an embedded page or a status switch; activity log with trigger/result/timestamp, hostnames only, clear-history) | Original plan "Task 19" | never started (no brief was ever generated for it); full original spec recoverable from git history of the now-deleted `docs/superpowers/plans/2026-10-28-fallow.md` (any commit up to and including `ea1178f`) |
| End-to-end tests via Playwright (persistent-context Chromium, `--load-extension`, covering inventory/unload/automation/recovery paths) | Original plan "Task 20" | same history note as above |
| Acceptance matrix (A01–A24 against `Fallow_Engineering_Plan.md` §14), benchmarks, packaging (`npm run package`), `PRIVACY.md`/`PERMISSIONS.md`/`RELEASE-CHECKLIST.md`, README, final Opus review | Original plan "Task 21" + "Phase 4" | HLD/LLD portion of the old "Phase 4" is already done (this file's siblings); only the README + acceptance/packaging remain |
| Chrome-process-only memory reading (`processMemory`/`processCpu` capability provider) | "Phase 2" | **Closed, no-go for this version** — Task 8's 2026-11-06 feasibility finding (`docs/superpowers/specs/2026-11-02-chrome-process-memory-feasibility.md`) re-verified `chrome.processes` against current official docs: still Dev-channel-only, no Stable successor, channel-gated (not fixed by raising `minimum_chrome_version`); native-messaging-companion alternative also rejected (same tab→PID attribution blocker, plus its own install/security burden). No implementation done. Re-open only on a Chrome platform change or explicit owner sign-off to scope the native-companion path separately. |
| In-repo install/update tooling for a non-technical owner | "Phase 3" | scope was never more than a one-line phase description; the plan's task for this starts by pinning down what "install/update" concretely needs to do before building it |

## Deferred — not in the active plan (needs the owner first)

| Item | Why deferred |
|---|---|
| "Squeezy" visual/spacing complaints, exact placement of the "How unloading works" block, the threshold number input's width | All need the owner's screenshot review before any further design decision — this has been an open `superpowers:brainstorming` thread since 2026-11-01. Pick it back up only when the owner brings screenshots. |
| `ThresholdInput`'s no-op suppression when a committed value equals the saved value; draft text not renormalized on a same-value commit (e.g. "015") | Harmless, cosmetic, not worth a dedicated task |
| Duplicated alert text/tone between `handleConfirm`'s and `dispatchUnloadTab`'s catch blocks; duplicated `sampleMemoryAround` deps literal in the same two functions | Small DRY opportunities, no behavior risk |
| `App.tsx` has grown to ~470+ lines across the Phase 1 UX tasks | Noted for a future refactor (e.g. extracting a `useUnloadActions` hook) if it keeps growing; nothing broken today |
| Two overlapping "Keep loaded" tests in `dashboard.test.tsx`; the shared tab-list legend's hidden-on-empty-filter behavior is untested (though structurally guaranteed) | Test hygiene, not a product defect |
| "Unload now" renders unconditionally even on an already-unloaded tab (harmless — the executor reports nothing-to-do honestly) | Cosmetic; worth a disabled state as a nice-to-have, not urgent |
| Plan deviation, documented not fixed: the original design called for a popup threshold line with a "Change" link; the shipped version uses a footer "Settings" button instead | Intent was met; flagged for awareness, no action needed |
