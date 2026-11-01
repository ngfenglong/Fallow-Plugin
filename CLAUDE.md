# Fallow — current focus for the next session

**Read this first.** The owner restarted the session specifically to work on UI polish.
Do not resume the feature plan (Tasks 15/17/19/20/21 below) unless the owner says to switch
back — that is a separate, parked piece of work.

## Current priority: UI polish on the popup

The owner's own words: the popup looked **"weird and cramped."** Root cause found and a
first fix shipped at commit `2b092d0`: Task 16 built component-level CSS
(`fallow/src/ui/components/theme.css` — badges, buttons, switches, tables, panels) but no
*page-level* layout, and Task 18's popup consumed those components without adding any of
its own. `<main className="popup">` had zero matching CSS rule. Result: plain stacked `<p>`
and `<button>` tags at browser-default spacing, no width set, so Chrome shrink-wrapped the
window to its narrowest line of content.

**What `2b092d0` added** (in `theme.css`, bottom of file): a fixed 340px width with padding
on `.popup`, a flex column with a consistent gap replacing uneven default `<p>` margins, a
`.popup-actions` row so confirm/cancel buttons sit side by side, and a `.popup-footer` with
a top border separating "Open dashboard" from the unload workflow above it.

**This fix is UNVERIFIED VISUALLY.** Browser automation (`claude-in-chrome`) cannot reach
`chrome://extensions` or a native file picker, so "Load unpacked" cannot be driven by the
automation tools. Playwright (`@playwright/test`, already a devDependency) can load the
extension directly via `--load-extension=<dist>`/`--disable-extensions-except=<dist>` CLI
args, sidestepping the file picker entirely — but its Chromium binary isn't installed in
this environment, and installing it (`npx playwright install`, a few hundred MB download)
was something to ask the owner first. Asked; the owner chose to verify by loading it
themselves instead, so this fix still needs the owner's own eyes before anyone calls it done.

### Starting the next session's work

1. **Ask the owner what they saw** after loading `fallow/dist` unpacked themselves — still
   cramped, or something else now (wrong button order, missing spacing somewhere specific,
   dark mode not kicking in, anything else). Don't assume the one fix already shipped was
   sufficient; get their actual reaction before touching more CSS.
2. If a real screenshot would help iterate faster than owner-round-trips, ask again whether
   to run `npx playwright install` — the owner declined once already in this session, but
   that was before knowing how many iterations this might take. A short Playwright script
   that loads the extension and screenshots `popup/index.html` is already proven to work
   mechanically (it got as far as the missing Chromium binary before stopping); see git
   history around `2b092d0` for the exact approach if reconstructing it.
3. Files that matter: `fallow/src/ui/components/theme.css` (all shared visual rules),
   `fallow/src/ui/popup/App.tsx` (the only page wired up so far), `fallow/src/ui/popup/main.tsx`
   (imports `theme.css` — don't let a future page skip this the way the popup originally did).
   **No test asserts on `className`**, so there is room to adjust markup/classes freely —
   but always run `cd fallow && npm test && npm run typecheck && npm run build` before
   calling a change done, and don't let a CSS-only change regress any of the 1004 existing
   tests.
4. `fallow/src/ui/dashboard/main.tsx` is still a one-line placeholder stub (not the real
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
