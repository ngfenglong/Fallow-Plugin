# Fallow — High-Level Design

**Version:** 0.2.0
**Status:** matches the extension version in `fallow/package.json` / `fallow/public/manifest.json`. Bump this doc's version (and add a Version History row) whenever a change ships that alters architecture, capability boundaries, or the message protocol — not for copy/UI-only fixes. See `CLAUDE.md` → "Versioning rule" for the exact policy.

**Origin spec:** `Fallow_Engineering_Plan.md` (the root product spec, v1.0, 2026-10-27). This document and `LLD.md` describe the system as actually built, kept current against that spec; they are not a replacement for it.

## Version History

| Version | Date | What changed |
|---|---|---|
| 0.1.0 | 2026-11-02 | First HLD/LLD write-up. Documents the system as of Tasks 1–18 (core extension) and the Phase 1 dashboard/popup UX pass, both shipped and merged to `feat/fallow-v1`. |
| 0.2.0 | 2026-11-06 | Chrome-process memory feasibility spike concluded **no-go** for this version (`docs/superpowers/specs/2026-11-02-chrome-process-memory-feasibility.md`): `chrome.processes` is still Dev-channel-only on current official docs, has no Stable successor, and the gate is channel-based (not fixed by raising `minimum_chrome_version`); the native-messaging-companion alternative is also rejected (inherits the same tab→PID attribution blocker, plus its own install/security/update burden). No capability-provider code shipped; `processMemory`/`processCpu` stay reserved, unregistered keys. |

## 1. What Fallow is

A Chrome (MV3) extension that unloads idle background tabs in place — using `chrome.tabs.discard`, never closing, moving, or navigating a tab — to free memory while preserving window/group layout. It offers manual single-tab and bulk unload, an inactivity-based automatic mode, a dashboard for inventory/settings/activity, and a popup for quick bulk action. See `Fallow_Engineering_Plan.md` §1–§2 for the full product rationale, scope boundaries, and what it explicitly does not do (no tab closing, no fabricated memory numbers, no per-tab RAM in v1).

## 2. Architecture overview

Four layers, each with a single responsibility, connected by one strict import rule:

```
 ui/  ──(type-only imports)──>  background/
  │                                  │
  │         shared/messages.ts (Request/Response contract)
  │                                  │
  ▼                                  ▼
platform/  <───────────────────  domain/
(chrome API adapters,            (pure policy: eligibility,
 memory providers,                settings validation,
 storage)                         hostname matching, types)
```

- **`domain/`** — pure functions and types, no `chrome.*` access. Eligibility rules, settings validation/defaults, hostname/site-protection matching, reason codes, shared constants. Fully unit-testable without a browser.
- **`platform/`** — the only layer that touches real browser/OS APIs: a typed `chrome.*` adapter with normalised errors, the capability-provider boundary for memory data (see §4), tolerant storage repositories, a sampling lock.
- **`background/`** — the service worker: activity tracker, single-alarm scheduler, action executor (discard + observed confirmation + race revalidation), tab/window inventory, dashboard-origin tracking. Owns all mutable runtime state; talks to `platform/` and `domain/`, never to `ui/`.
- **`ui/`** — the dashboard and popup (React). Talks to `background/` only through `shared/messages.ts`'s typed `Request`/`Response` contract, sent via `ui/client.ts`. **Enforced rule:** `ui/` may only take **type-only** imports from `background/` — no runtime import crosses that boundary, checked by a pinned test (`tests/unit/ui-components.test.tsx`, "the ui layer reaches background/ only through type-only imports"). This keeps the service worker's side effects (constructing listeners) from ever running twice inside a UI page.

Both extension pages (dashboard, popup) and the service worker are separate JS contexts; a page learns about server-side state changes via `STATE_CHANGED_MESSAGE` (a push with no payload) and re-fetches a fresh snapshot — never by reading background state directly.

## 3. Current capability status

**Shipped and merged to `feat/fallow-v1`:**
- Core extension (Tasks 1–18 of the original plan): domain policy engine, typed Chrome adapter, activity tracker, scheduler, executor, inventory, dashboard, popup, device memory provider (whole-device reading, `system.memory` optional permission).
- Phase 1 dashboard/popup UX pass (6 tasks, 2026-11-01/02): editable idle threshold, findable settings entry points, per-tab "Unload now", a single shared tab-list legend, a relabeled/respaced filter bar, and a memory panel "Freed" reading tied to an unload.

**Open, tracked in `docs/TASKS.md` and the active plan under `docs/superpowers/plans/`:**
- Chrome settings panel + activity log (originally "Task 19")
- End-to-end test coverage via Playwright (originally "Task 20")
- Acceptance matrix, benchmarks, packaging, and the project README (originally "Task 21" + "Phase 4")
- Chrome-process-only memory reading — a `processMemory`/`processCpu` capability provider ("Phase 2") is **closed as no-go for this version** per the 2026-11-06 feasibility finding (`docs/superpowers/specs/2026-11-02-chrome-process-memory-feasibility.md`, now folded into `docs/TASKS.md`): `chrome.processes` is still Dev-channel-only against current official docs, has shipped no Stable successor, and the restriction is channel-based so raising `minimum_chrome_version` cannot unlock it; the native-messaging-companion alternative (§17 of the root spec) is also rejected — it cannot itself obtain a tab→process-ID mapping on Stable Chrome either, and per-tab attribution is not well-defined in general (site-isolation process splitting, shared renderer processes, browser/GPU/utility processes belonging to no tab). The capability-provider boundary (`CapabilityKey = 'tabLifecycle' | 'deviceMemory' | 'processCpu' | 'processMemory' | 'osSwap'`, see `LLD.md` §4) keeps the two keys reserved and unregistered; re-open only if Chrome ships a Stable-channel successor or the owner commissions the native-companion path as its own scoped project with explicit sign-off.
- In-repo install/update tooling for a non-technical owner ("Phase 3")
- A backlog of smaller UI findings from code review, some blocked on the owner's own screenshot review of visual/spacing complaints — see `docs/TASKS.md`.

## 4. Message protocol (summary — see `LLD.md` for the full contract)

`ui/` and `background/` exchange a closed set of `Request`/`Response` message types defined in `shared/messages.ts` (`GET_SNAPSHOT`, `UPDATE_SETTINGS`, `SET_TAB_PROTECTION`, `UNLOAD_PREVIEW`, `UNLOAD_EXECUTE`, `CANCEL_BATCH`, `GET_HISTORY`, `CLEAR_HISTORY`, `REGISTER_DASHBOARD_ORIGIN`, `RECORD_MEMORY_SAMPLE`). Every request carries a `requestId`; every response is `{ ok: true, data } | { ok: false, error }`. `UNLOAD_EXECUTE` already carries an optional `operationId`, reserved for correlating a result back to the action that triggered it — relevant to a known open finding about overlapping unloads (`docs/TASKS.md`).

## 5. Testing & quality bar

Vitest + `@testing-library/react` for unit/component tests (fake Chrome adapter, fake storage, no real browser), with a pinned layering-guard test and a copy-rules test family (no forbidden words — "suspend", "undo", etc. — no fabricated zero measurements). `tsc --noEmit` strict. Playwright E2E is planned, not yet built (see `docs/TASKS.md`). Every shipped increment goes through `superpowers:subagent-driven-development` or `superpowers:executing-plans`: fresh implementer → fresh reviewer per task → a final whole-branch review before merge. See `CLAUDE.md` for the full workflow.
