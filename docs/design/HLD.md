# Fallow — High-Level Design

**Version:** 0.3.0
**Status:** versioned independently of the extension itself — this file's version is not a claim of parity with `fallow/package.json` / `fallow/public/manifest.json`'s `version` field. The two converge only at an actual release milestone, not on every doc update. Bump this doc's version (and add a Version History row) whenever a change ships that alters architecture, capability boundaries, or the message protocol — not for copy/UI-only fixes.

**Origin spec:** `Fallow_Engineering_Plan.md` (the root product spec, v1.0, 2026-10-27). This document and `LLD.md` describe the system as actually built, kept current against that spec; they are not a replacement for it.

## Version History

| Version | Date | What changed |
|---|---|---|
| 0.1.0 | 2026-11-02 | First HLD/LLD write-up. Documents the system as of Tasks 1–18 (core extension) and the Phase 1 dashboard/popup UX pass. |
| 0.2.0 | 2026-11-06 | Full "hardening and expansion" plan landed: `UNLOAD_EXECUTE.operationId` threaded through every `ui/` call site; the Chrome settings assistance panel and activity log shipped (`ChromeSettingsPanel.tsx`, `ActivityLog.tsx`, `chrome-settings-copy.ts`); Chrome-process memory feasibility spike concluded **no-go** for this version (`docs/design/findings/2026-11-02-chrome-process-memory-feasibility.md`): `chrome.processes` is still Dev-channel-only on current official docs, has no Stable successor, and the gate is channel-based (not fixed by raising `minimum_chrome_version`); the native-messaging-companion alternative is also rejected. No capability-provider code shipped; `processMemory`/`processCpu` stay reserved, unregistered keys. |
| 0.3.0 | 2026-11-07 | Prepared for public release: removed the internal development-process references and the automated test suite from this public copy of the project (see §5 below) and removed finished-task tracking docs that don't carry useful product information. No architecture, capability, or protocol change. |

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
- **`ui/`** — the dashboard and popup (React). Talks to `background/` only through `shared/messages.ts`'s typed `Request`/`Response` contract, sent via `ui/client.ts`. **Rule to keep:** `ui/` may only take **type-only** imports from `background/` — no runtime import should cross that boundary. This keeps the service worker's side effects (constructing listeners) from ever running twice inside a UI page.

Both extension pages (dashboard, popup) and the service worker are separate JS contexts; a page learns about server-side state changes via `STATE_CHANGED_MESSAGE` (a push with no payload) and re-fetches a fresh snapshot — never by reading background state directly.

## 3. Current capability status

**Shipped:**
- Core extension: domain policy engine, typed Chrome adapter, activity tracker, scheduler, executor, inventory, dashboard, popup, device memory provider (whole-device reading, `system.memory` optional permission).
- Dashboard/popup UX: editable idle threshold, findable settings entry points, per-tab "Unload now", a shared tab-list legend, a filter bar, and a memory panel "Freed" reading tied to an unload.
- Chrome settings panel + activity log, in-repo install/update tooling.

**Not shipped, and why:**
- Chrome-process-only memory reading — a `processMemory`/`processCpu` capability provider is **closed as no-go for this version** per the 2026-11-06 feasibility finding (`docs/design/findings/2026-11-02-chrome-process-memory-feasibility.md`): `chrome.processes` is still Dev-channel-only against current official docs, has shipped no Stable successor, and the restriction is channel-based so raising `minimum_chrome_version` cannot unlock it; the native-messaging-companion alternative (§17 of the root spec) is also rejected — it cannot itself obtain a tab→process-ID mapping on Stable Chrome either, and per-tab attribution is not well-defined in general (site-isolation process splitting, shared renderer processes, browser/GPU/utility processes belonging to no tab). The capability-provider boundary (`CapabilityKey = 'tabLifecycle' | 'deviceMemory' | 'processCpu' | 'processMemory' | 'osSwap'`, see `LLD.md` §4) keeps the two keys reserved and unregistered; re-open only if Chrome ships a Stable-channel successor or someone commissions the native-companion path as its own scoped project.

## 4. Message protocol (summary — see `LLD.md` for the full contract)

`ui/` and `background/` exchange a closed set of `Request`/`Response` message types defined in `shared/messages.ts` (`GET_SNAPSHOT`, `UPDATE_SETTINGS`, `SET_TAB_PROTECTION`, `UNLOAD_PREVIEW`, `UNLOAD_EXECUTE`, `CANCEL_BATCH`, `GET_HISTORY`, `CLEAR_HISTORY`, `REGISTER_DASHBOARD_ORIGIN`, `RECORD_MEMORY_SAMPLE`). Every request carries a `requestId`; every response is `{ ok: true, data } | { ok: false, error }`. `UNLOAD_EXECUTE` carries an optional `operationId`, used to tag a result (and its before/after memory reading) back to the action that triggered it — though nothing in the UI displays that tag yet, so two near-simultaneous unloads can still show a "Freed" figure for the wrong one ("most recent wins").

## 5. Verifying a change

This public copy of the project ships without its internal automated test suite. `npm run typecheck` (strict `tsc --noEmit`) still runs and catches a real class of mistakes. Beyond that, verify a change by reading the affected files against this document and `LLD.md`, then trying it for real in Chrome: load the built `dist/` as an unpacked extension and exercise the behavior you changed. See `docs/RELEASE-CHECKLIST.md` for a short pre-release pass.
