# Acceptance matrix — A01–A24

Source of the matrix: `Fallow_Engineering_Plan.md` §14. Per §14's own instruction,
"headless tests alone cannot validate physical RAM savings" — this matrix is a
real-browser, real-profile, by-hand pass, and **nothing in this document stands in for
that pass**.

## Honesty note on how this document was produced

This document was written by an agent working in a sandboxed git worktree with no
access to the owner's real Chrome profile, no attached display, and no real hardware's
Task Manager. **Every row below is marked `NOT RUN` — none has been executed against a
real Chrome profile, and no row's PASS/FAIL column has been filled in by this agent.**
Rewording a case's description is not the same as running it; nothing here should be
read as a completed acceptance pass.

Where one of Task 7's already-landed Playwright e2e specs (`fallow/tests/e2e/`)
exercises materially the same behavior as a case below, that is cited as **automated
corroborating evidence** — a real, actually-executed result in this sandboxed
environment, not a simulation of one. The citation's PASS/FAIL and date are genuine:
`npm run e2e` was run from `fallow/` on 2026-11-06 and produced `8 passed, 2 skipped (of
10)`. But an e2e spec runs in a headless, display-less, synthetic-tab Chromium
controlled through a test harness — it is **not** the same thing as the real-profile
manual run this matrix formally requires (real windows, real groups, real tab content,
a real display, the owner's own eyes on the dashboard). Every row, including ones with
a cited automated equivalent, still needs the owner's own confirmation before it can be
marked PASS here.

Per §14 (and the "Record failures as failures" principle the brief points at): if the
owner's manual run finds a FAIL, record it as FAIL with what actually happened — never
drop a case silently to make the matrix look cleaner than it is, and never silently
narrow a case's scope to dodge a finding.

## How to run this, as the owner

For each row below:
1. Build and load Fallow per `../INSTALL.md` (or `../../fallow/README.md`), on the
   Chrome profile you actually use day to day, with your actual windows/tabs/groups
   open (not a clean throwaway profile — the whole point is testing against your real
   layout, per §14's "3 windows, mixed groups, 50+ tabs" framing of A01).
2. Follow "Steps" for that row.
3. Fill in "Observed result" with exactly what happened (not a summary — e.g. "badge
   read 'Unloaded', tab stayed at index 3 in its window, group color unchanged").
4. Fill in "PASS/FAIL" — FAIL if the observed result does not match the pass condition,
   even partially.
5. Note the method if a case needed something contrived to set up (e.g. A09 needs an
   actual browser restart; A16 needs actually sleeping the machine).

| ID | Scenario | Pass condition | Steps | Automated equivalent (informational only) | Observed result | PASS/FAIL | Date / method |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A01 | 3 windows, mixed groups, 50+ tabs | Inventory matches accessible browser tabs without changing order/group metadata. | Open the dashboard with your real multi-window, multi-group layout. Compare its tab list, counts, and group colors/titles against what Chrome itself shows. Confirm no tab moved, no group changed, no new tab was created. | `tests/e2e/dashboard.spec.ts` → `inventory matches the browser without rearranging anything` — **PASS**, run 2026-11-06 (`npm run e2e`). Asserts a before/after tab-order snapshot is unchanged and the dashboard's total count matches. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A02 | Manual unload of a paused background video | Discarded state confirmed; tab stays in place; reopening reloads it. | Open a video, pause it, send it to the background. Click "Unload now" on it. Confirm the badge reads Unloaded and its position/window/group are unchanged. Switch back to the tab and confirm Chrome reloads the page. | `tests/e2e/unload.spec.ts` → `a single unload leaves the tab in place` — **PASS**, run 2026-11-06. Covers discard + in-place only. The reload-on-return half is `test.skip`'d in that same file (sandbox has no real display, so Chrome's reload-on-reactivate never fires there — confirmed by direct experiment per that test's own comment, not assumed) and is explicitly deferred to this manual row. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A03 | 2-minute automatic threshold | Eligible background tab unloads at a later check; no early unload. | Set the threshold to 2 minutes, enable automation, leave a tab idle in the background. Confirm it is still Loaded well before 2 minutes and becomes Unloaded once past it. | `tests/e2e/automation.spec.ts` → `automation unloads an idle tab at a later check and not before` — **PASS**, run 2026-11-06. Uses a simulated clock via the real alarm/executor path, not real elapsed wall-clock time. | NOT RUN — requires the owner's real Chrome profile and real elapsed time | | NOT RUN |
| A04 | Selected tab in an unfocused window | Skipped with Selected reason. | Make a tab the active tab of its window, then switch focus to a different window. Run a bulk unload. Confirm the selected tab is skipped and shows a Selected reason. | `tests/e2e/unload.spec.ts` → `a selected tab in an unfocused window is skipped` — **PASS**, run 2026-11-06. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A05 | Audible tab | Skipped during manual and automatic bulk actions. | Play audio in a background tab (e.g. music/video). Run a bulk unload and let automation run. Confirm the audible tab is skipped both times. | None — not exercised by the Playwright e2e suite (covered only by `tests/unit/eligibility.test.ts`'s policy-matrix tests, which this scope ruling does not treat as a substitute). | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A06 | Pinned/protected tab/site | Settings respected; reasons visible; removing protection permits later eligibility. | Pin a tab and add a protected site. Confirm both are skipped with a visible reason. Remove the protection and confirm the tab becomes eligible again. | None — not exercised by the e2e suite. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A07 | Automation off mid-batch | No further automatic requests after the setting is observed; already-unloaded tabs stay unloaded. | Enable automation with several tabs overdue, then disable it mid-run if possible (or immediately after one tab unloads). Confirm no further automatic unloads happen and already-unloaded tabs are left alone. | None — not exercised by the e2e suite. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A08 | Worker terminates and restarts | Settings and session timers recover; scheduler is not duplicated. | Let the service worker go idle and terminate (Chrome does this automatically; `chrome://extensions` → service worker "Inspect" can help confirm it stopped), then trigger it again. Confirm settings/timers survived and automation did not double-fire. | None cited here — the e2e suite does not specifically exercise a real worker termination (that is covered at the unit/integration level by `tests/integration/worker-lifecycle.test.ts`, outside this scope ruling's e2e-only citation allowance). | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A09 | Browser restart | No stale numeric IDs reused; discovery timers and grace applied. | Quit and reopen Chrome entirely with Fallow's tabs still present (session restore). Confirm the dashboard doesn't misattribute old tab/session state to new tab IDs, and that idle timers restart cleanly. | None — needs an actual browser process restart. | NOT RUN — requires the owner's real Chrome profile and a real browser restart | | NOT RUN |
| A10 | User activates a candidate after preview | Execution revalidation skips it. | Select a tab for bulk unload, then switch to it (make it active) before confirming the bulk action. Confirm it is skipped on execution despite being selected earlier. | None — not exercised by the e2e suite. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A11 | Tab closes, navigates or moves during execution | No wrong tab targeted; result is skipped/error as appropriate. | Start a bulk unload, then quickly close, navigate, or drag one of the targeted tabs to another window before it's processed. Confirm Fallow never acts on the wrong tab and reports skipped/error honestly for the disturbed one. | None cited here — race handling is covered at the integration level (`tests/integration/executor-races.test.ts`), not by the e2e suite. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A12 | Chrome independently unloads a tab | Dashboard refreshes; external source is not falsely attributed. | Let Chrome's own Memory Saver (or any other mechanism) discard a tab Fallow didn't touch. Confirm the dashboard shows it Unloaded with an "observed, source unknown" style note, never claiming Fallow did it. | `tests/e2e/dashboard.spec.ts` → `the dashboard refreshes when chrome unloads a tab independently` — **PASS**, run 2026-11-06. Simulates the independent discard via the same `chrome.tabs.discard` call Chrome itself would make, then asserts the "Observed unload; source unknown" text appears. | NOT RUN — requires the owner's real Chrome profile and Chrome's own Memory Saver (or similar) actually firing | | NOT RUN |
| A13 | Optional memory permission denied/revoked | Core functionality works; unavailable metrics never appear as zero. | Deny (or revoke, if already granted) the `system.memory` optional permission. Confirm the rest of the dashboard still works and the memory panel shows "unavailable" rather than a 0/NaN reading. | `tests/e2e/dashboard.spec.ts` → `core features work with the memory permission denied` — **PASS**, run 2026-11-06. Asserts the memory panel renders the `UNAVAILABLE_TEXT` constant, never `'0'`, and that a bulk unload still works. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A14 | Dashboard opens from a content tab | Immediate bulk action excludes the origin page. | Open the dashboard from the popup while on an ordinary content tab. Immediately run a bulk unload. Confirm the tab you opened the dashboard from is excluded and marked as the recent-origin tab. | `tests/e2e/unload.spec.ts` → `the dashboard origin tab is excluded from an immediate bulk action` — **PASS**, run 2026-11-06. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A15 | Group is collapsed | Dashboard never assumes its tabs are unloaded merely because it is collapsed. | Collapse a tab group with some loaded tabs inside it. Confirm the dashboard still reports those tabs' real loaded/unloaded state, not an assumption based on the group being collapsed. | None — not exercised by the e2e suite. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A16 | Sleep/wake with many overdue tabs | Revalidation and batch limits prevent a burst; timing delay is explained. | Put the machine to sleep with automation on and several tabs about to become overdue, then wake it well past the threshold for all of them. Confirm Fallow doesn't try to unload everything in one burst and that any delay is explained in the UI. | None — needs a real sleep/wake cycle. | NOT RUN — requires the owner's real Chrome profile and a real sleep/wake cycle | | NOT RUN |
| A17 | ChatGPT or Sheets protected by default | Bulk actions skip it; UI explains manual removal of protection. | With a ChatGPT or Google Sheets tab open and idle, run a bulk unload. Confirm it's skipped by default and the UI explains how to remove that default protection if wanted. | None — not exercised by the e2e suite. | NOT RUN — requires the owner's real Chrome profile and a real ChatGPT/Sheets tab | | NOT RUN |
| A18 | Counts and filters | Total = Loaded + Unloaded; Protected/Eligible are overlapping classifications. | With a mixed set of tabs (some protected, some eligible, some loaded, some unloaded), check the dashboard's counts add up and that the filter options behave as overlapping classifications, not mutually exclusive categories. | None cited here — covered at the unit level (`tests/unit/dashboard.test.tsx`), not by the e2e suite. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A19 | Internal/unsupported page and API rejection | Action unavailable or failure displayed; no close/navigation fallback. | Open an internal page (`chrome://settings`, a PDF viewer tab, etc.) and check its row in the dashboard. Confirm "Unload now" is disabled/unavailable rather than attempting and silently falling back to closing or navigating the tab. | `tests/e2e/dashboard.spec.ts` → `an internal page offers no unload action` — **PASS**, run 2026-11-06. Covers the "action unavailable" half (disabled button) for a `chrome://` page specifically; does not exercise a genuine Chrome API rejection path (e.g. a page Chrome actively refuses to discard). | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A20 | Enable/disable without dashboard | Scheduler continues or stops as configured; no dashboard required. | Enable automation, close every Fallow page entirely, wait past the threshold in real time, then reopen the dashboard. Confirm the idle tab shows Unloaded with no Fallow page having been open while it happened. Repeat with automation disabled and confirm nothing unloads. | `tests/e2e/automation.spec.ts` → `automation keeps running with no dashboard open` — **`test.skip`, not run even in this sandboxed environment.** That test's own comment documents why: the same unedited code passed in under 3s on some hand-run attempts and exhausted a ~10s retry budget with no unload at all on others, in this display-less sandbox's service-worker scheduling — a real, investigated flake, not a known-good test that was merely skipped for convenience. This row has **no automated evidence at all**, not even informational. | NOT RUN — requires the owner's real Chrome profile and real elapsed time | | NOT RUN |
| A21 | Large batch interrupted by worker shutdown | Results reconcile without duplicate success counts or automatic manual replay. | Start a large bulk unload (as many tabs as you can) and force the service worker to terminate mid-batch if possible. Reopen the dashboard and confirm the activity log/counts reconcile honestly — no duplicated successes, no silent auto-replay of the interrupted batch. | None cited here — covered at the integration level (`tests/integration/executor-races.test.ts`, `worker-lifecycle.test.ts`), not by the e2e suite. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A22 | Site matching | Exact host and optional subdomains work; `notexample.com` never matches `example.com`. | Add `example.com` as a protected site without subdomains. Confirm `sub.example.com` is NOT protected and `notexample.com` is NOT protected. Turn on "include subdomains" and confirm `sub.example.com` becomes protected while `notexample.com` still isn't. | None cited here — covered at the unit level (`tests/unit/hostname.test.ts`), not by the e2e suite. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A23 | Unprotected unsaved draft demonstration | Reload risk is documented; extension never claims reliable draft detection. | Open a page with an unsaved draft (e.g. a long unsent email or form), leave it idle and unload it (or let automation do so). Confirm Fallow's warning/copy about this risk is shown once per owner and never claims it can reliably detect unsaved drafts. | None — not exercised by the e2e suite. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |
| A24 | Browser settings shortcut | Opens tested settings route or provides copyable fallback; no false status display. | From the dashboard's Chrome settings panel, click "Open Chrome performance settings." Confirm it opens `chrome://settings/performance` in a new tab, and that the copyable-address fallback text is accurate if the click somehow doesn't work. Confirm no row claims a Chrome setting's on/off status that Fallow cannot actually read. | None cited here — the click handler itself is covered at the unit level (`tests/unit/chrome-settings.test.tsx`), not by the e2e suite, and no e2e test actually opens a real `chrome://` settings tab. | NOT RUN — requires the owner's real Chrome profile | | NOT RUN |

## Summary

- **24 of 24 cases: NOT RUN** against the owner's real Chrome profile — this agent has
  no access to one.
- **8 cases (A01, A02, A03, A04, A12, A13, A14, A19)** have a genuinely-executed,
  automated Playwright equivalent in this sandboxed environment, run 2026-11-06,
  **PASS** in all 8 — cited above as corroborating evidence only, each with the exact
  spec/test name so the owner can re-run it themselves (`npm run e2e` from `fallow/`).
  Several of those (A02, A19) only cover part of the scenario; the rest of each is
  flagged in its row.
- **1 case (A20)** has an automated attempt that is explicitly skipped as an
  investigated, non-deterministic sandbox flake — not a pass, not evidence either way.
- **15 cases** have no automated citation at all and are entirely dependent on the
  owner's manual run.
- This document does not close out Task 10's acceptance-matrix requirement by itself —
  it is the ready-to-execute matrix, not a completed one. The owner's own run (filling
  in "Observed result" / "PASS/FAIL" / "Date / method" above) is what actually completes
  it.
