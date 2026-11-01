# Fallow — Low-Level Design

**Version:** 0.1.0
**Status:** matches the extension version in `fallow/package.json` / `fallow/public/manifest.json`. Keep this file and `HLD.md` in lockstep — bump both together. See `CLAUDE.md` → "Versioning rule."

**Spec it implements:** `Fallow_Engineering_Plan.md` (root product spec). Argues from `HLD.md` for architecture; this file is the concrete reference beneath it.

## Version History

| Version | Date | What changed |
|---|---|---|
| 0.1.0 | 2026-11-02 | First write-up, covering the system through the Phase 1 dashboard/popup UX merge. |

## 1. Directory map (`fallow/src/`)

| Path | Responsibility |
|---|---|
| `domain/constants.ts` | All tunable numeric/string constants — thresholds, timeouts, batch sizes, retention limits, preset lists. No logic. |
| `domain/types.ts` | `TabFacts`, `Settings`, `TabActivity`, `Decision`, `UnloadOutcome`, `UnloadResult`, `Trigger`, `MemorySample`. The vocabulary every other layer imports. |
| `domain/reason-codes.ts` | `ReasonCode` union + `sortReasons` — why a tab is or isn't eligible, in a stable display order. |
| `domain/eligibility.ts` | Pure policy: `EligibilityMode = 'auto' \| 'manual-bulk' \| 'manual-single'`, `backgroundElapsedMs`, the full decision function. Fails closed on any uninterpretable input (NaN time, unknown mode, non-positive threshold) — never returns an eligible verdict by accident. |
| `domain/settings.ts` | Defaults (`DEFAULT_SETTINGS`), tolerant parsing/validation of persisted or patched settings, `readThreshold` (integer, `THRESHOLD_MIN`–`THRESHOLD_MAX`), clamps `inactivityMinutes`/`protectPinned`/`protectedSites`/`deviceMemoryMonitoringEnabled`. `schemaVersion` is read but never patchable. |
| `domain/hostname.ts` | URL-based hostname parsing and dot-boundary site-protection matching (never substring matching). |
| `platform/chrome-adapter.ts` | Typed wrapper over `chrome.*` with normalised errors — the only file below `background/` allowed to call real Chrome APIs directly. |
| `platform/memory-provider.ts` | Capability-provider boundary (see §4) + `summariseBeforeAfter`/`formatBytes`/`formatDelta` pure helpers. |
| `platform/sampling-lock.ts` | Serializes concurrent memory-sampling attempts. |
| `platform/storage.ts` | Tolerant repositories over `storage.local`/`storage.session` with bounded history. |
| `background/tracker.ts` | Selection-based activity tracking (`backgroundSince` per tab) with discovery recovery after a worker restart. |
| `background/scheduler.ts` | Single `chrome.alarms` alarm (`ALARM_NAME`, `ALARM_PERIOD_MINUTES`), grace intervals, in-flight release tracking. |
| `background/executor.ts` | `Scope` types, the action executor: discard + observed confirmation + race revalidation. Exports `Scope` (type-only import target for `ui/`). |
| `background/inventory.ts` | Builds the dashboard snapshot: reconciling counts, stable window/group labels. |
| `background/origins.ts` | Dashboard-origin tab tracking (the "recently opened dashboard from this tab" exclusion). |
| `background/index.ts` | Service worker entry: wires all `chrome.*` listeners, the message router. Never imported by `ui/` as a runtime value (see HLD §2) — only `executor.ts`'s types cross that line. |
| `shared/messages.ts` | `Request`/`Response` union (type-only), `STATE_CHANGED_MESSAGE` push constant. |
| `shared/validation.ts` | `parseUnloadTarget` and other request-shape guards — e.g. refuses `manual-single` paired with any scope but `{ kind: 'tab', tabId }`. |
| `ui/client.ts` | `sendRequest<T>()` — the only way `ui/` talks to `background/`. |
| `ui/useSnapshot.ts` | Subscribes to `STATE_CHANGED_MESSAGE`, re-fetches `GET_SNAPSHOT`. |
| `ui/components/` | Shared presentational components (`Button`, `Switch`, `Table`, `Panel`, `Badge`, `EmptyState`, `ErrorState`, `ThresholdInput`) + `theme.css` token system. |
| `ui/dashboard/` | `App.tsx` (state/orchestration), `Header`, `Summary`, `MemoryPanel`, `Filters`, `TabTable`, `SettingsPanel`. |
| `ui/popup/` | `App.tsx` — all-windows bulk action, origin capture, links into the dashboard. |

## 2. Message protocol (`shared/messages.ts`)

```ts
type Request =
  | { type: 'GET_SNAPSHOT'; requestId: string }
  | { type: 'UPDATE_SETTINGS'; requestId: string; patch: unknown }
  | { type: 'SET_TAB_PROTECTION'; requestId: string; tabId: number; isProtected: boolean }
  | { type: 'UNLOAD_PREVIEW'; requestId: string; scope: Scope; mode: EligibilityMode }
  | { type: 'UNLOAD_EXECUTE'; requestId: string; scope: Scope; mode: EligibilityMode; operationId?: string }
  | { type: 'CANCEL_BATCH'; requestId: string; operationId: string }
  | { type: 'GET_HISTORY'; requestId: string }
  | { type: 'CLEAR_HISTORY'; requestId: string }
  | { type: 'REGISTER_DASHBOARD_ORIGIN'; requestId: string; originTabId: number | null }
  | { type: 'RECORD_MEMORY_SAMPLE'; requestId: string; sample: MemorySample };

type Response<T> = { ok: true; requestId: string; data: T } | { ok: false; requestId: string; error: string };
```

`UNLOAD_EXECUTE.operationId` already exists but is not yet threaded through by any `ui/` call site to tag a result back to its triggering action — relevant to the known "overlapping unloads can show a Freed figure for the wrong action" finding tracked in `docs/TASKS.md`.

## 3. Eligibility modes (`domain/eligibility.ts`)

| Mode | Threshold/floor applied | Dashboard-origin exclusion | Used by |
|---|---|---|---|
| `auto` | `settings.inactivityMinutes` | Yes | Scheduler |
| `manual-bulk` | `MANUAL_BULK_FLOOR_MS` (60s) only | Yes | Popup/dashboard bulk unload |
| `manual-single` | None — no threshold, no floor, no grace | No | Per-tab "Unload now" |

`manual-single` is valid only with scope `{ kind: 'tab', tabId }`; `shared/validation.ts`'s `parseUnloadTarget` refuses it paired with any other scope shape.

## 4. Capability-provider boundary (`platform/memory-provider.ts`)

```ts
type CapabilityKey = 'tabLifecycle' | 'deviceMemory' | 'processCpu' | 'processMemory' | 'osSwap';
interface CapabilityProvider { readonly key: CapabilityKey; isAvailable(): Promise<boolean>; }
interface DeviceMemoryProvider extends CapabilityProvider {
  readonly key: 'deviceMemory';
  sample(): Promise<MemorySample | null>;
  requestPermission(): Promise<boolean>;
  revoke(): Promise<void>;
}
interface CapabilityRegistry { get(key: CapabilityKey): CapabilityProvider | undefined; }
```

Only `'deviceMemory'` is implemented today (backed by the optional `system.memory` permission — whole-device, never per-tab, per `Fallow_Engineering_Plan.md` §2). `'processCpu'`/`'processMemory'` are reserved keys for the Chrome-process-only reading tracked as an open item — implementing them is gated on a feasibility finding, since `chrome.processes` is Dev-channel-only on Stable Chrome (`Fallow_Engineering_Plan.md` §18, [S3]). `'osSwap'` is unimplemented and out of scope per the root spec §2.

`summariseBeforeAfter(before, after): BeforeAfter` and `formatDelta(deltaBytes): string` are pure helpers used by the dashboard's before/after "Freed" reading (`ui/dashboard/App.tsx`'s `sampleMemoryAround`).

## 5. Layering & safety rules (enforced by tests, not convention alone)

- **Type-only boundary:** `ui/` → `background/` imports must be `import type` only. Pinned test: `tests/unit/ui-components.test.tsx`, `"the ui layer reaches background/ only through type-only imports"`.
- **No raw HTML for owner-supplied text:** tab/group titles render as plain-text children everywhere, never `innerHTML`/`dangerouslySetInnerHTML`.
- **Copy rules:** no "suspend"/"undo" in shipped strings; no measurement shown as a fabricated zero when a capability is unavailable (a capability being off/unavailable always skips the reading entirely rather than rendering a zero/NaN stand-in).
- **Fail-closed policy:** `domain/eligibility.ts` never returns an eligible verdict from an input it cannot interpret.

## 6. Testing conventions

Vitest + `@testing-library/react`, `fireEvent` (not `user-event` — not a repo dependency). `tests/fake-chrome.ts`/`tests/fake-storage.ts` stand in for real browser APIs; no test touches a real browser. `npm run typecheck` runs `tsc --noEmit` in strict mode. Playwright E2E config is planned (`docs/TASKS.md`), not yet present.

## 7. Settings schema (`domain/settings.ts` / `domain/types.ts`)

```ts
type Settings = {
  schemaVersion: 1;
  automationEnabled: boolean;
  inactivityMinutes: number;      // THRESHOLD_MIN..THRESHOLD_MAX (1..1440), integer
  protectPinned: boolean;
  protectedSites: Array<{ hostname: string; includeSubdomains: boolean }>;
  deviceMemoryMonitoringEnabled: boolean;
};
```

`schemaVersion` is persisted but not yet exercised by a real migration (only one schema has ever existed) — any future breaking change to this shape needs a migration path keyed off it, not a silent reinterpretation of old data.
