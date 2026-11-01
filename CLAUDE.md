# Fallow

A Chrome (MV3) extension that unloads idle background tabs in place to free memory,
while preserving window/group layout — manual single-tab and bulk unload, an
inactivity-based automatic mode, a dashboard, and a popup. The product spec is
`Fallow_Engineering_Plan.md` at the repo root; the as-built architecture is
`docs/design/HLD.md` (high level) and `docs/design/LLD.md` (low level). Read those
before touching code you haven't worked in before — this file does not repeat them.

This file is intentionally task-agnostic: generic project facts and how to work here,
nothing about what's currently being built. For that, see:

- **`docs/TASKS.md`** — the current backlog. This is where "what's left to do" lives.
- **`docs/superpowers/plans/`** — the active implementation plan(s), if any are in flight.
- **`docs/superpowers/specs/`** — design specs backing an active plan, if any.

## Where things live

- `fallow/` is the actual project root — `package.json`, `src/`, `tests/` all live
  directly under it, not under a nested `fallow/fallow`.
- `fallow/src/domain/`, `platform/`, `background/`, `ui/`, `shared/` — see
  `docs/design/LLD.md` §1 for the responsibility of each.
- `fallow/tests/unit/` — Vitest + `@testing-library/react`. `fallow/tests/e2e/` is
  planned, not yet present (tracked in `docs/TASKS.md`).

## How to work on this project

1. **Brainstorm before designing.** New feature work or behavior changes start with
   `superpowers:brainstorming`, not an implementation plan. Nothing gets built off an
   unapproved design.
2. **Write a plan from an approved design.** Use `superpowers:writing-plans`. The plan's
   `Spec:` line should point at `docs/design/HLD.md`/`LLD.md` (and `Fallow_Engineering_Plan.md`
   for product-level constraints), plus any session-specific spec under
   `docs/superpowers/specs/` the brainstorm produced.
3. **Execute the plan** with `superpowers:subagent-driven-development` (preferred — fresh
   implementer + fresh reviewer per task, then a final whole-branch review) or
   `superpowers:executing-plans` for inline execution. Use `superpowers:using-git-worktrees`
   to isolate the work first.
4. **Finish** with `superpowers:finishing-a-development-branch` — merge, PR, or keep,
   your human partner's call every time.
5. **Plans and specs are disposable.** Once a plan's work is merged, fold any surviving
   open item into `docs/TASKS.md` and delete the plan/spec files under
   `docs/superpowers/` — git history keeps the record; a stale plan sitting in the repo
   is a worse reference than git log. `docs/design/HLD.md`/`LLD.md` are the opposite:
   never delete these, only version them (see below).

## Architecture rules the test suite enforces — don't work around these

- `fallow/src/ui/` may only take **type-only** imports from `fallow/src/background/` —
  no runtime import crosses that boundary. Pinned test: "the ui layer reaches
  background/ only through type-only imports."
- No raw HTML for owner-supplied text (tab/group titles) anywhere — plain-text React
  children only, never `innerHTML`/`dangerouslySetInnerHTML`.
- No shipped string says "suspend" or "undo"; no capability that's off or unavailable
  ever renders a fabricated zero/NaN measurement — it's skipped entirely instead.
- `domain/eligibility.ts` fails closed: an input it can't interpret never produces an
  eligible verdict.

Full detail and the exact file:line pointers for each: `docs/design/LLD.md` §5.

## Commands

Run from `fallow/`:
- `npm test` — full Vitest suite
- `npm run typecheck` — `tsc --noEmit`, strict
- `npm run build` — Vite build (dashboard, popup, service worker)

## Versioning rule

`docs/design/HLD.md` and `docs/design/LLD.md` are living documents with their own
version number at the top, kept in step with each other. Bump both (same new version)
and add a row to each doc's Version History table whenever a shipped change alters
architecture, a capability boundary, or the message protocol — not for a copy-only or
UI-only fix. Keep the HLD/LLD version aligned with `fallow/package.json` /
`fallow/public/manifest.json`'s `version` field when a release-worthy milestone bumps
that number; they don't have to move on every commit, but they must never describe a
shape the shipped code has moved past. `Fallow_Engineering_Plan.md` is the one exception
to "keep current" — it's the original product spec (v1.0) and stays as written; HLD/LLD
are what track drift from it.
