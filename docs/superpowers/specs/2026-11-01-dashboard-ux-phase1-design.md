# Fallow dashboard/popup UX — Phase 1 design

Phase 1 of a four-phase roadmap the owner set on 2026-11-01:
1. **This phase** — dashboard and popup UX fixes (no new browser permissions).
2. Chrome-process memory capability (real "Chrome only" RAM, not whole-device).
3. In-repo install/update tooling for non-technical users.
4. README plus a versioned HLD/LLD history doc. Current build is versioned 0.1 until
   the owner calls it "released."

Phases 2–4 are context only — not designed or built here. This document covers Phase 1
only.

## 1. Intent and the why

The owner is a non-developer user of their own extension and hit real friction running
it day to day: they couldn't find or change the idle threshold, didn't know why a
manually-unloaded tab behaved differently from an automatically-unloaded one, had no way
to unload a single tab without running the whole bulk action, and found the dashboard's
filter bar and tab list visually cramped. Confirmed against the code (not guesses) in
`CLAUDE.md` and in this conversation. The fix is a UX pass, not new product behavior —
every capability involved already exists in the domain/background layers; this phase is
about exposing it clearly.

## 2. Goals

- An editable threshold control, in minutes, enforcing `THRESHOLD_MIN`–`THRESHOLD_MAX`
  (1–1440), reachable from the UI — not just a read-only `<p>`.
- A visible settings entry point from both the popup and the dashboard.
- Plain-language explanation, near the controls themselves, of: the auto threshold, the
  60s manual-bulk floor (`MANUAL_BULK_FLOOR_MS`), and what "Automatic unloading" actually
  costs — it watches tab activity, it does not hold tabs in memory.
- A per-tab "Unload now" action, in addition to the existing bulk action and the
  "Keep loaded" toggle.
- The memory panel wired to show a current reading and, after any unload, how much was
  freed — using `summariseBeforeAfter`/`formatDelta`, already built and unused. Still
  whole-device (Phase 1 has no new permission), but now showing both "available" and "a
  reading tied to what you just did," not available-only.
- A redone filter bar (search box, sort, filter) with real spacing and visible labels,
  and a tab list that doesn't repeat a full disclaimer sentence on every row.
- Wording throughout assumes a reader who does not know what "eligible," "bulk," or
  "discard" mean internally.

## 3. Non-goals

- No new browser permission and no Chrome-process-only memory reading — that is Phase 2.
- No install/update tooling, no README, no versioning doc — Phases 3–4.
- No Task 19 (Chrome's own settings panel / activity log) — still parked, unrelated to
  this.
- No new sort key, no new filter category, no change to eligibility/unload logic itself.

## 4. Anti-goals

- A settings UI that re-introduces developer vocabulary ("eligibility," "bulk mode,"
  "discard") where plain language would do.
- A per-tab unload control that silently reuses bulk-unload's rules — it must use the
  existing `manual-single` mode, which already excludes the 60s floor and dashboard-origin
  protection by design; reusing `manual-bulk` here would be a behavior regression.
- Claiming a memory number is "Chrome's usage" when it is still whole-device. The
  Phase-1 copy must keep saying so.

## 5. Constraints

- Stays inside the existing stack: React + TypeScript + Vite, the existing
  `src/ui/components/theme.css` token system — no new styling framework or CSS-in-JS.
- Respects the existing type-only import boundary between `src/ui/` and
  `src/background/`/`src/platform/` (see the layering comment in `ui/popup/App.tsx` and
  the pinned test "the ui layer reaches background/ only through type-only imports"). The
  new per-tab unload action goes through `sendRequest`/`shared/messages.ts`, exactly like
  the existing bulk action — no direct import of background internals.
- No raw HTML injection anywhere a tab title or group title is rendered (existing
  XSS-safety rule) — all new text nodes stay plain-text children.
- Keeps the existing accessibility baseline: 4.5:1 text contrast, visible focus rings,
  `aria-live` announcements for async results.
- No change to `domain/`, `background/executor.ts`, or `shared/messages.ts` request
  shapes — `manual-single` mode and the `{ kind: 'tab', tabId }` scope already exist and
  already support everything this phase needs. `shared/validation.ts`'s
  `parseUnloadTarget` refuses `manual-single` with any other scope kind (including
  `{ kind: 'tabs', tabIds: [id] }`), so the per-tab action must send `{ kind: 'tab',
  tabId }` specifically.

## 6. Decided in conversation (owner's calls)

- Settings must give the user real access and understanding of what each control does,
  not just display state.
- Memory: scoped to "just Chrome," not the whole computer — confirmed not achievable
  without a new capability, so deferred whole to Phase 2; Phase 1 stays honest about
  being whole-device.
- All three unload paths are wanted: per-tab manual unload, the existing bulk button, and
  auto-unload by threshold — with the auto-mode toggle explained in terms of what it
  actually does ("observes/monitors" tab activity) versus what it doesn't ("use memory").
- Squeeze complaints are specifically: the filter bar (search box + two dropdowns) and
  the scrolling tab list, not the page as a whole.
- Four-phase roadmap and ordering, above, confirmed by the owner.
- The owner opted out of further design review for this phase ("just do what you need to
  do") — this document proceeds on sensible defaults, each marked below, rather than
  round-tripping every detail.

## 7. Left to the builder (my calls, Phase 1)

- **Settings entry point**: a small link/icon in the popup footer next to "Open
  dashboard," and a lightweight header-level link in the dashboard, rather than
  restructuring page navigation. Both jump to/expand the existing settings panel; no new
  page.
- **Threshold control split by surface**: the dashboard's `SettingsPanel` gets the full
  editable control — a numeric input (bounded 1–1440) plus quick-pick buttons built from
  the already-defined but unused `THRESHOLD_PRESETS` (`[1, 2, 5, 10, 15, 30, 60]`). The
  popup keeps a condensed, read-only threshold line with a "Change" link into the
  dashboard's settings, rather than duplicating a full edit form in a 340px popup.
- **Explanatory copy placement**: short, permanent microcopy next to each control (not a
  hover-only tooltip), since the owner the UI serves does not know to look for a tooltip.
- **Tab row redesign**: the per-row "Binds only this Fallow session…" caption, which
  currently repeats on every row and is the main driver of the cramped feel, becomes one
  shared explanation shown once (e.g. above the tab list), not per-row. The new "Unload
  now" button sits next to "Keep loaded" in the row's action area.
- **Filter bar redesign**: search box, sort dropdown, and filter dropdown get a proper
  flex row with spacing and visible text labels above or beside each control (current
  markup only has `aria-label`s, nothing a sighted non-dev user can read).
- **Memory panel copy**: adds a "Freed: +X GiB" line using `formatDelta` after any
  unload completes, alongside the existing "Available" reading; disclaimer stays, plus
  one line noting a Chrome-only reading is coming.

## 8. Done, for this phase

Not yet — this document is the design; next is a written plan (`superpowers:writing-plans`)
covering the specific component/file changes, then implementation.
