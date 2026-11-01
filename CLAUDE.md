# Fallow — current focus for the next session

## UI/UX fixes: brainstorming in progress, resume with screenshots

The owner has real UI complaints about the dashboard. Confirmed against the actual
code below — these are real gaps, not misunderstandings. **This is a live
superpowers:brainstorming thread.** Don't jump to implementation: the owner is
attaching screenshots in this new session specifically so you can see what they mean.
Look at those first, then resume the conversation, before proposing any design.

### Confirmed, not yet designed-out

- **No editable threshold control anywhere in the UI.** `fallow/src/ui/dashboard/SettingsPanel.tsx:30`
  and `fallow/src/ui/popup/App.tsx:210` both only DISPLAY `inactivityMinutes` as plain
  text (`<p>Threshold: 15 min</p>`) — there is no input field. The owner cannot change
  the idle threshold through the UI at all right now.
- **Settings has no visible entry point.** It's a `<Panel title="Settings">` at the very
  bottom of the dashboard page, after Summary, the optional Memory panel, Filters, and
  the whole tab table. No nav link, no icon, nothing in the popup points at it. This is
  likely why the owner said "I am not able to find the setting."
- **The 1-minute manual-bulk floor is never explained anywhere in the UI.**
  `MANUAL_BULK_FLOOR_MS = 60_000` (`fallow/src/domain/constants.ts:3`) governs manual
  bulk unload; the owner's own "Threshold" setting governs automatic unload only. A tab
  can be eligible one way but not the other with zero on-screen explanation of why —
  this is the "not very self-explanatory" complaint.
- **The memory panel only shows "Available," never "Used."**
  `fallow/src/ui/dashboard/MemoryPanel.tsx` reads `availableBytes` only. Task 15 already
  built `summariseBeforeAfter`/`formatDelta` (`fallow/src/platform/memory-provider.ts`)
  specifically for a before/after reading, but the dashboard never wires it up — it's
  sitting unused. This is the groundwork for the owner's "how do we know how to clear"
  ask.
- Owner describes the dashboard as **"squeezy"** in places — not yet pinned to a
  specific element. Get this from the screenshots in this session, don't guess.

### Open design question — asked, not yet answered

Asked the owner: for "monitor the RAM currently used," do they want a live number
visible at any time, or a before/after reading tied to an unload action (which
`summariseBeforeAfter` already supports)? **Pick this back up first.**

### Hard gate — nothing here is approved yet

Per superpowers:brainstorming, no code changes until the owner has seen and approved an
actual plan. Reading/exploring is fine; writing product code is not.

## README.md: deferred until the UI fixes land

The owner wants a README (what it does, why, how it works, maybe screenshots) for
other people to read. **Explicitly later — after the UI issues above are fixed, not
now.** Don't start it early, even if it feels like a natural next step.

## Everything else: shipped, working, verified

Tasks 1–18, plus Task 15 (device memory provider) and Task 17 (real dashboard), are
complete, reviewed, and pushed to `origin/feat/fallow-v1` (through commit `ea1178f`).
Verified against a real unpacked build via Playwright (`--load-extension`) — no
structural defects found in that pass. The popup's own earlier "cramped" complaint was
fixed and owner-confirmed; don't re-touch that without a new, specific complaint.

Full history, every ruling and review: `.superpowers/sdd/2026-10-28-fallow/progress.md`.
Still parked, resume only if the owner asks: Task 19 (Chrome settings panel + activity
log), Task 20 (E2E tests), Task 21 (acceptance matrix/packaging/final review). None of
these are related to the UI complaints above — don't conflate them.
