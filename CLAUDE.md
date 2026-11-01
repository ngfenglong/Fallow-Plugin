# Fallow — current focus for the next session

## Popup layout fix: VERIFIED OK by the owner

The owner reported the popup looked **"weird and cramped"**; root cause and fix are at
commit `2b092d0` (page-level layout added to `fallow/src/ui/components/theme.css` — a
fixed-width `.popup` container, a flex column with a consistent gap, a `.popup-actions` row
for confirm/cancel, a `.popup-footer` separator above "Open dashboard"). The owner loaded
the real build and confirmed it looks right now — **this is closed, not open work.** Don't
re-litigate it or re-touch that CSS unless the owner raises something new.

## Current priority: open — ask the owner

Nothing specific is queued right now. Ask the owner what they want next: more UI polish
(now that the popup's base layout is confirmed, there may be smaller follow-ups — spacing
inside the preview/skipped-reasons list, dark mode, anything else they notice with more
use), or resuming the parked feature plan below.

If polish continues: files that matter are `fallow/src/ui/components/theme.css` (shared
visual rules), `fallow/src/ui/popup/App.tsx` (the only real page wired up so far),
`fallow/src/ui/popup/main.tsx` (imports `theme.css` — don't let a future page skip this).
No test asserts on `className`, so there's room to adjust markup/classes freely, but always
run `cd fallow && npm test && npm run typecheck && npm run build` before calling a change
done — a green suite doesn't prove visual layout, so get the owner's own eyes on anything
that changes appearance, the same way this fix was confirmed.

Getting a real screenshot without the owner's round-trip is possible but was not completed
this session: browser automation (`claude-in-chrome`) cannot reach `chrome://extensions` or
a native file picker, so "Load unpacked" can't be driven that way. A direct Playwright
script (`@playwright/test` is already a devDependency) using
`--load-extension=<dist>`/`--disable-extensions-except=<dist>` sidesteps the file picker
entirely and got as far as proving the mechanics work, but stopped at a missing Chromium
binary (`npx playwright install`, a few hundred MB) — ask the owner before installing it,
rather than assuming; they declined once already but that was before this round's fix was
confirmed to need zero further iteration, so the calculus may be different next time.

`fallow/src/ui/dashboard/main.tsx` is still a one-line placeholder stub (not the real
dashboard — that's Task 17, parked). It has the identical "theme.css never linked" gap,
deliberately left alone since that whole file gets replaced wholesale when Task 17 is
eventually built. Don't polish it now; it isn't the real page yet.

## Longer history and full context

Every decision, ruling, and review from Tasks 11–18 (the action executor through the popup)
is recorded in `.superpowers/sdd/2026-10-28-fallow/progress.md` — the authoritative ledger
for this project, read by the superpowers SDD workflow. The original 21-task plan is at
`docs/superpowers/plans/2026-10-28-fallow.md`; the design spec at
`docs/superpowers/specs/2026-10-28-fallow-design.md`.

**Parked, not abandoned** — resume only if the owner asks: Task 15 (device memory provider),
Task 17 (the real dashboard), Task 19 (Chrome settings panel + activity log), Task 20 (E2E
tests), Task 21 (acceptance matrix A01–A24, benchmarks, packaging, final review). Several
carry-forwards are already queued for whichever of these resumes first — see the ledger's
most recent entries for the full list (dashboard origin registration, failedReads surfacing,
window-label stability, a narrow tracker race, an unmeasured Chrome event-ordering question).
