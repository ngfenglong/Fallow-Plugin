# Fallow — Low-Level Design

**Version:** 0.3.0
**Status:** versioned independently of the extension itself — this file's version is not a claim of parity with `fallow/package.json` / `fallow/public/manifest.json`'s `version` field. The two converge only at an actual release milestone, not on every doc update. Keep this file and `HLD.md` in lockstep — bump both together.

**Spec it implements:** `Fallow_Engineering_Plan.md` (root product spec). Argues from `HLD.md` for architecture; this file is the concrete reference beneath it.

## Version History

| Version | Date | What changed |
|---|---|---|
| 0.1.0 | 2026-11-02 | First write-up, covering the system through the Phase 1 dashboard/popup UX merge. |
| 0.2.0 | 2026-11-06 | §1's `ui/dashboard/` row now lists `ActivityLog.tsx`, `ChromeSettingsPanel.tsx`, and `chrome-settings-copy.ts`. §2 updated: `UNLOAD_EXECUTE.operationId` is now threaded through every `ui/` call site. §4 updated: the Chrome-process memory/CPU capability-provider item is closed no-go for this version per the feasibility finding in `docs/design/findings/2026-11-02-chrome-process-memory-feasibility.md`. |
| 0.3.0 | 2026-11-07 | Prepared for public release: removed the automated test suite from this public copy and rewrote §6 accordingly; removed internal development-process references. No architecture, capability, or protocol change. |

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
| `ui/dashboard/` | `App.tsx` (state/orchestration), `Header`, `Summary`, `MemoryPanel`, `Filters`, `TabTable`, `SettingsPanel`, `ChromeSettingsPanel` (Chrome's own performance-settings assistance, F5), `chrome-settings-copy.ts` (its shipped copy + the activity log's copy), `ActivityLog` (the bounded history view, Task 6/19). |
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

`UNLOAD_EXECUTE.operationId` is threaded through both `ui/` call sites that send it (`ui/dashboard/App.tsx`'s `handleConfirm` and `dispatchUnloadTab`), tagging a result — and the before/after memory reading sampled around it — back to its triggering action. The tag is attached but not yet surfaced anywhere in the UI, so two near-simultaneous unloads can still show a "Freed" figure for the wrong one ("most recent wins"). A future change could either surface the tag in the UI or decide it isn't worth it.

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

Only `'deviceMemory'` is implemented today (backed by the optional `system.memory` permission — whole-device, never per-tab, per `Fallow_Engineering_Plan.md` §2). `'processCpu'`/`'processMemory'` are reserved, unregistered keys for the Chrome-process-only reading item, **closed no-go for this version** by the 2026-11-06 feasibility finding (`docs/design/findings/2026-11-02-chrome-process-memory-feasibility.md`): `chrome.processes` is still Dev-channel-only against current official docs with no Stable successor shipped, the restriction is channel-based (unaffected by Fallow's `minimum_chrome_version`), and the native-messaging-companion alternative was assessed and also rejected — it cannot obtain a tab→process-ID mapping on Stable Chrome either, and per-tab attribution is not well-defined in general (site-isolation process splitting, shared renderer processes, browser/GPU/utility processes belonging to no tab). Re-open only on a Chrome platform change or an owner-sponsored, separately scoped native-companion effort. `'osSwap'` is unimplemented and out of scope per the root spec §2.

`summariseBeforeAfter(before, after): BeforeAfter` and `formatDelta(deltaBytes): string` are pure helpers used by the dashboard's before/after "Freed" reading (`ui/dashboard/App.tsx`'s `sampleMemoryAround`).

## 5. Layering & safety rules (rules to keep, not enforced by tests in this copy)

- **Type-only boundary:** `ui/` → `background/` imports must be `import type` only.
- **No raw HTML for owner-supplied text:** tab/group titles render as plain-text children everywhere, never `innerHTML`/`dangerouslySetInnerHTML`.
- **Copy rules:** no "suspend"/"undo" in shipped strings; no measurement shown as a fabricated zero when a capability is unavailable (a capability being off/unavailable always skips the reading entirely rather than rendering a zero/NaN stand-in).
- **Fail-closed policy:** `domain/eligibility.ts` never returns an eligible verdict from an input it cannot interpret.

## 6. Verifying a change

This public copy of the project ships without its internal automated test suite.
`npm run typecheck` (strict `tsc --noEmit`) still catches a real class of mistakes.
Beyond that: read the affected code against this document, then load the built `dist/`
as an unpacked extension in Chrome and try the behavior for real.

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
