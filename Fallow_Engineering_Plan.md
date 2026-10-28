# Fallow — Engineering Handoff

Version: 1.0 · Prepared: 27 October 2026

Status: implementation proposal. Defaults below are recommended product decisions, not existing user preferences.

Product name: **Fallow**. Chosen because fallow land is left unplanted but stays in place and returns when wanted, which is what this extension does to a tab. Confirm the name is free in the Chrome Web Store and clear of trademark conflict before the store listing is prepared. The name must not contain "Chrome": Google's branding guidelines prohibit using Google trademarks, or confusingly similar marks, as an extension or company name without written permission [S9]. Avoid "Suspend" or "Suspender" in the name and copy; it describes the replacement-page mechanism this design rejects (section 11) and carries the reputation of an extension removed from the store for malware.

## 1. Outcome and user context

Build a lightweight Chrome extension for a person who keeps many webpages open across two or three windows, including long-lived tab groups. They want to preserve that organisation and easy access while releasing the resources occupied by unused pages. Primary examples are YouTube, ChatGPT and Google Sheets.

The extension must provide manual unloading, a configurable inactivity timer, a clear dashboard of loaded versus unloaded tabs, protection controls, and access to relevant Chrome performance settings. There is one user-facing interface; no Developer mode toggle in version 1.

The user also wants exact RAM used by untouched tabs. This is an explicitly unmet requirement in the standalone Stable Chrome version. Deliver accurate lifecycle visibility and optional system-level memory observations first; evaluate detailed process monitoring as a separately scoped integration. Do not quietly substitute tab counts for measured RAM.

### Core user journey

1. Install and open the dashboard. Existing windows and groups appear without being rearranged.
2. See which tabs remain loaded, how long background tabs have been unused, and which tabs are protected.
3. Unload selected eligible pages immediately, or enable automatic unloading after a chosen number of minutes.
4. Confirm the result in the dashboard and activity log.
5. Return to the original Chrome tab later. Chrome reloads the webpage in its existing position.

## 2. Scope and technical boundaries

| Requirement | Version 1 commitment |
| --- | --- |
| Preserve tabs, windows, positions and groups | Yes; unload in place rather than closing, replacing or moving tabs. |
| Unload an eligible background tab immediately | Yes, through the supported discard API. |
| Custom inactivity threshold | Yes; extension-owned schedule, separate from Memory Saver. |
| Show actual loaded/discarded state | Yes; re-query browser state to verify actions. |
| Show exact RAM or CPU for each tab | Not available through the normal Stable process API; show a limitation notice. |
| Show total and available device RAM | Optional system-memory permission, clearly labelled as device-wide. |
| Prove exact bytes saved by an unload | No; device-wide changes are observations, not attribution. |
| Read macOS swap or Memory Pressure | Not in version 1. |
| Directly set Chrome Memory Saver | No supported public setting identified; provide a settings shortcut and instructions. |
| Control every browser/background process | No. Controls apply to accessible tabs, not every Chrome service. |

Chrome exposes tab lifecycle and discard operations through `chrome.tabs` [S1]. Its process CPU/memory API is documented as Dev-channel only [S3]. `chrome.system.memory` exposes total and available physical memory, not per-tab allocations [S4]. Do not request unsupported permissions or depend on private APIs, task-manager scraping, command-line flags or debugger attachment in version 1.

Unloading is different from pausing video, muting audio, freezing execution or clearing cache. Do not delete cache, cookies or browsing history. An unloaded document stops its own execution, but tab bookkeeping and separate browser/site services may remain. Do not promise zero RAM, zero CPU for the entire site, or immediate reduction of swap.

## 3. Product defaults

| Setting | Proposed default | Meaning |
| --- | --- | --- |
| Automatic unloading | Off until explicitly enabled | Dashboard and manual controls work immediately. |
| Inactivity threshold | 15 minutes | Presets: 1, 2, 5, 10, 15, 30, 60; custom whole minutes from 1–1,440. |
| Scheduler check | Once per minute while automation is enabled | Approximate scheduling; not a real-time guarantee. |
| Protect selected tab in every window | Always | Includes selected tabs in unfocused windows. |
| Protect audible tabs | Always in version 1 | Muted or silent media may not be identified as active playback. |
| Protect pinned tabs | On | User may turn this off; other protections still apply. |
| Protected sites | Exact hostnames `chatgpt.com`, `docs.google.com`, `meet.google.com` | Conservative defaults shown during onboarding; editable. |
| Restart/recovery grace | 2 minutes | Prevent immediate mass unloading after browser startup. |
| Maximum automatic batch | 10 tabs per scheduler run | Oldest eligible first; prevents an unbounded burst. |
| Activity retention | Latest 500 entries, at most 7 days | Local only, with Clear history. |
| Incognito | Unsupported | Declare `incognito: "not_allowed"` for version 1. |

Keep automatically protected sites understandable: Google Sheets and Google Docs share `docs.google.com`, so protecting that hostname protects both. Users can remove a site protection and accept the associated reload risk.

## 4. Definition of inactivity

Use “time since the tab stopped being selected,” not “time since last mouse movement.” No webpage input monitoring is required.

- A selected tab in any window is ineligible, even when that window is not focused.
- When a tab becomes selected, clear its background timer.
- When it stops being selected, start the timer at that event time.
- A newly created background tab starts its timer at creation.
- On first installation or browser restart, start unknown background timers at discovery. Do not assume tabs are already overdue.
- Worker restarts within a browser session recover timers from session storage; they must not reset every minute.
- Moving a background tab between windows or groups does not reset its timer. Reconcile its selected state after the move.
- Navigating an inactive tab does not reset selection-based inactivity; loading pages are skipped until complete.
- Turning automation off does not erase timers. Turning it back on starts a 2-minute grace interval and shows the pending eligible count.
- Shortening a threshold also starts that grace interval. The user can use Unload now to act sooner.

Sleep may make timers overdue. Resume with a bounded batch and re-check protections. A laptop waking from sleep must not trigger an uncontrolled cascade.

## 5. Functional requirements

### F1 — Inventory

Display all tabs accessible to this extension in the current Chrome profile, organised by window, group and ungrouped tabs. Cross-profile visibility is out of scope. Use browser window IDs internally and stable session labels in the interface, such as Window 1. App-style windows are included only where the supported APIs expose their tabs; verify this during the first milestone.

Search by title or hostname. Filters: All, Loaded, Unloaded, Eligible and Protected. Sort by longest unused, title or existing tab order. Do not offer RAM sorting without a measurement provider.

A collapsed group is an organisational state, not proof of unloading. Preserve its existing metadata. Group IDs are browser-session identifiers [S5].

### F2 — Manual actions

Support Unload for one tab; Unload eligible tabs for a group, a window, selected rows or all windows. Manual actions bypass the inactivity threshold but retain all protections. An explicit Keep loaded protection is respected by both manual and automatic bulk actions; the user removes it before retrying.

Bulk preview must show eligible count and skipped count with reasons. On first use, explain that unsaved text, active requests and video position may be lost; require acknowledgement once. Thereafter use a compact preview for bulk actions. Never describe reloading as an Undo that restores lost state.

If the extension dashboard is opened in a new tab, the formerly selected webpage becomes background. It must not become an accidental candidate for an immediate bulk action: exclude the originating tab for that dashboard session. Capture its ID in the popup before opening the dashboard. For dashboards opened directly, temporarily protect the most recently selected content tab in that window until it has accumulated the configured background duration. Explain this skip as “Recently opened dashboard from this tab.”

### F3 — Automatic rules

One global timer is sufficient for version 1. Apply it across accessible windows and groups. Use one periodic alarm, not one timer per tab. Turning automation off cancels future automated work; it does not reload discarded tabs or disable Chrome's own Memory Saver. Manual unloading remains available.

The dashboard should say: “Extension automation is off. Chrome may still unload tabs independently.”

### F4 — Protection

Protect selected, audible, loading, explicitly protected, unsupported and dashboard-origin tabs. Protect pinned tabs according to the setting. Conservatively skip browser-declared non-auto-discardable tabs and explain the reason; do not modify their browser flag in version 1.

Use two protection types:

- Tab protection: current browser session only; resets on browser restart.
- Site protection: exact hostname saved locally across sessions. A separately labelled Include subdomains option is permitted; compare parsed hostnames with a dot boundary, never arbitrary substrings.

Fallow's Keep loaded control prevents its own unload actions only. Chrome or another extension can still discard that tab. This limitation must appear in its help text.

Do not claim to detect all unsaved forms, silent video, microphone use, screen sharing or active AI generations. Version 1 has no content scripts and cannot provide that assurance. Protected sites and manual protection are the mitigation. Include “Working on something important? Keep this tab loaded.”

### F5 — Chrome settings assistance

Provide a Chrome settings panel with:

| Item | Version 1 presentation |
| --- | --- |
| Memory Saver | Open Chrome performance settings; explain that its state is not read by this extension. |
| Always keep these sites active | Instructions beside the same settings shortcut; independent from this extension's list. |
| Energy Saver | Settings shortcut with a brief description. |
| Preload pages | Settings shortcut; suggest reviewing the speed/resource tradeoff. |
| Chrome Task Manager | Platform-specific menu instructions for checking memory and CPU. |

Use a user-clicked navigation to `chrome://settings/performance`, with a copyable address if Chrome blocks it in a tested environment. Never embed the Settings page or display a fake on/off switch for an unreadable setting. Chrome documents these performance controls [S6].

An optional later enhancement can control preloading through `chrome.privacy.network.networkPredictionEnabled`, subject to permission, controllability and read-back verification [S8]. Exclude this permission and feature from version 1 to keep the initial surface small.

## 6. Dashboard and popup specification

### Toolbar popup

Show automation toggle, current threshold, loaded/unloaded counts, Unload eligible tabs, and Open dashboard. Keep it usable by keyboard. A manual bulk action first shows the same preview used in the dashboard. Identify the current content tab before popup navigation.

### Dashboard layout

1. Header: product name, automation status, threshold selector and primary Unload eligible tabs button.
2. Summary: Total tabs / Loaded / Unloaded / Eligible. Protected is a secondary overlapping count, not an additional lifecycle bucket.
3. Optional memory panel: Total device RAM, Available device RAM, sample timestamp and a short trend while visible.
4. Main table: window/group, title, hostname, lifecycle state, time unused, protection/skip reason, Open, Unload and Keep loaded actions.
5. Settings and Chrome settings assistance.
6. Recent activity: trigger, result, timestamp and expandable reason.

Use “Loaded,” “Unloaded” and “Loading” for lifecycle. Show “Selected” and “Audible” as separate badges; do not label a loaded page “using CPU now.” Exact unavailable measurements must display “Not available in standalone mode,” never zero.

Counts must reconcile: Loaded includes loading pages; Total = Loaded + Unloaded. Unsupported pages can remain in the inventory but are never eligible. Filter and scope labels must explain whether counts refer to all tabs or the current selection.

### Interaction and accessibility

Preserve scroll, selection and keyboard focus during updates. Render titles as escaped text. Use colour plus labels, clear focus indicators, labelled switches, sufficient contrast, and an accessible bulk-result announcement. Include loading, empty, permission-denied, stale-data and browser-error states. Match system light/dark preference. No developer-only controls.

## 7. Monitoring and measurement contract

### Required, verified signals

Lifecycle state comes from a fresh browser query. A discard success counter increments only after observing discarded state. Maintain separate counts for requested, confirmed, skipped and failed operations. Never treat API invocation alone as proof of unloading.

If a tab is discarded outside an extension action, record “Observed unload; source unknown.” If an extension request overlaps another actor, say “Unload confirmed after request,” not that the extension uniquely caused it.

### Optional system RAM observations

Request optional `system.memory` permission only when the user enables device memory monitoring. Failure or denial must not affect core features. Sample every 5 seconds while a dashboard is visible; stop periodic sampling when hidden/closed. Maintain at most 120 samples in session storage. Coordinate multiple dashboards through the worker so sampling is not multiplied.

For a manual batch, capture an available-memory sample immediately before it and approximately 10 seconds after completion while a dashboard remains visible. If the browser suspends the UI, permission disappears or sampling fails, show “After sample unavailable.” Do not keep the worker alive just for this feature.

Example wording: “Device available RAM: 4.2 GiB before, 4.7 GiB after. Change: +0.5 GiB. Other applications and OS caching can affect this.” Values are illustrative, not predicted savings.

The panel must never call total-minus-available “Chrome RAM,” equate available RAM with macOS Memory Pressure, or estimate per-tab allocations by dividing a total. Unloading counts are useful operational evidence but do not answer the exact per-tab RAM request.

## 8. Implementation architecture

Recommended stack: TypeScript, Manifest V3, Vite, React for dashboard/popup, a small shared component set, Vitest for pure policy logic, and Playwright/Chromium plus manual Stable Chrome checks. React is a proposed choice; avoid large chart libraries for a tiny sparkline. No backend or account system is needed.

Components:

- Browser adapter: typed wrappers around tabs, windows, groups, storage and alarms; normalises errors.
- Inventory service: reconciles current browser state and cached display data.
- Policy engine: pure eligibility decisions with explicit reason codes.
- Activity tracker: selection changes and background timestamps.
- Scheduler: one named alarm and startup recovery.
- Action executor: revalidates and processes bounded unload batches.
- Settings repository: versioned local settings and migrations.
- Telemetry repository: bounded local action log; no remote analytics.
- Memory provider: optional device-wide samples behind a capability interface.
- UI messaging layer: validated requests and event-driven state updates.

Suggested source layout:

```text
src/background/{index,inventory,tracker,scheduler,executor}.ts
src/domain/{types,eligibility,settings,reason-codes}.ts
src/platform/{chrome-adapter,storage,memory-provider}.ts
src/ui/popup/
src/ui/dashboard/
src/ui/components/
src/shared/{messages,validation}.ts
tests/{unit,integration,e2e}/
public/{icons,manifest.json}
```

Service workers can terminate while idle; global variables are not durable state. Persist what is needed and make initialization idempotent [S7]. Register event listeners synchronously at module startup; handlers await a shared initialization promise.

## 9. Manifest and permissions

Proposed minimum Chrome version: 120. Verify all used fields against that baseline; omit newer fields or feature-detect them. Use a one-minute alarm compatible with the baseline rather than depending on recently introduced alarm-persistence options.

| Permission | Purpose |
| --- | --- |
| `tabs` | Tab titles, URLs and inventory needed for the dashboard and site rules. |
| `tabGroups` | Read group titles/colours for the inventory. |
| `storage` | Settings, session activity, protections and bounded history. |
| `alarms` | Background eligibility checks. |
| Optional `system.memory` | Device-wide RAM observations. |

No host permissions, content scripts, debugger, webRequest, nativeMessaging or processes permission in version 1. Use a toolbar action, module service worker, dashboard extension page and `incognito: "not_allowed"`. Bundle all code and dependencies; no remote executable code.

## 10. Data and message contracts

Persist versioned settings in `storage.local`. Store current-session tab timers/protections and bounded operation state in `storage.session`. Never carry numeric tab IDs or group IDs into another browser session as durable identity.

```ts
type Settings = {
  schemaVersion: 1;
  automationEnabled: boolean;
  inactivityMinutes: number;
  protectPinned: boolean;
  protectedSites: Array<{ hostname: string; includeSubdomains: boolean }>;
  deviceMemoryMonitoringEnabled: boolean;
};

type TabActivity = {
  tabId: number;
  backgroundSince: number | null;
  protectedForSession: boolean;
};

type Decision = {
  eligible: boolean;
  reasons: string[];
  evaluatedAt: number;
};

type UnloadResult = {
  tabId: number;
  outcome: 'confirmed' | 'already-unloaded' | 'skipped' | 'failed';
  reason?: string;
};
```

Reason codes include SELECTED, AUDIBLE, PINNED, TAB_PROTECTED, SITE_PROTECTED, DASHBOARD_ORIGIN, LOADING, UNSUPPORTED_URL, BROWSER_PROTECTED, NOT_OLD_ENOUGH, STARTUP_GRACE, ALREADY_UNLOADED, TAB_GONE and API_REJECTED. Multiple protections may coexist.

Requests: GET_SNAPSHOT, UPDATE_SETTINGS, SET_TAB_PROTECTION, UNLOAD_PREVIEW, UNLOAD_EXECUTE, GET_HISTORY and CLEAR_HISTORY. Add schema validation and request IDs. Derive results from current worker/browser state; the UI must not dictate eligibility. Accept privileged messages only from this extension's pages and validate sender URL/origin and payload shape.

For history, store timestamps, trigger, reason, operation ID, session tab ID and hostname. Avoid persistent page titles or full URLs, which may contain personal information or tokens. Tab inventory can hold those in memory for display.

## 11. Eligibility and unload algorithm

1. Load settings and fresh tab state. If the automatic trigger is disabled or in grace, exit before issuing new actions.
2. Restrict to requested scope. Allow only ordinary HTTP/HTTPS pages in version 1. Skip extension and browser-internal pages, local files and other schemes.
3. Skip already unloaded tabs and apply all protection rules.
4. For automatic actions, require background duration at least the configured threshold. Manual actions ignore duration only.
5. Sort automatic candidates by oldest background timestamp. Preview manual candidates without loading pages.
6. Before each request, re-read settings and that tab. Re-check protections, scope membership and current lifecycle. Preview eligibility is not a permission to bypass later changes.
7. Request discard. Never close a tab or navigate to a replacement suspension page as a fallback.
8. Re-query and confirm discarded state. If still loaded, recheck briefly with bounded retries; after at most 2 seconds, report unconfirmed/failed rather than guaranteed success. Do not aggressively repeat the discard request.
9. Record result and publish updated dashboard state.

Use a single executor with bounded work: sequential requests, automatic batches capped at 10; manual batches processed in chunks of 10 and revalidated between chunks. Offer Cancel remaining for large manual batches. Turning automation off stops remaining automatic requests; an already-issued browser request may complete.

If Chrome terminates the worker mid-operation, reconcile unfinished records on the next wake. Mark unknown results honestly, do not double-count, and do not blindly replay manual commands. An auto-check may evaluate still-loaded tabs again from fresh state. Handle tab closure, activation, navigation and group moves without uncaught errors.

## 12. Lifecycle and event handling

Listen to tab creation, activation, updates, removal, replacement, attachment/detachment and relevant window/group changes. Rebuild a browser snapshot when recovering from uncertain state. Remove obsolete session records and refresh the previous/new selected tab states on activation.

On worker initialization, validate/migrate settings, recover session state, reconcile inventory and ensure the named alarm exists if automation is enabled. Remove it otherwise. Do not recreate duplicates. On a full browser restart or extension update, missing session activity receives the discovery timestamp and grace interval.

Use alarms rather than a long-lived background setInterval. Scheduled execution can be delayed, and missed alarms are handled after wake [S2]. UI live updates should use messages/events; refresh when the dashboard becomes visible. Closed dashboards must not keep polling.

## 13. Performance, privacy and security

- Keep the core event-driven. No repeated injection or hidden dashboards.
- Use one inventory scan per automatic run and bounded verification queries; debounce event bursts and batch storage writes.
- Maintain bounded logs and history; no unbounded per-tab time series.
- Do not bypass worker sleep through artificial keepalive traffic.
- Render page-supplied strings as text; restrict URLs used for actions to validated schemes.
- Settings and logs stay on device. No remote analytics, external favicon fetches or uploaded browsing history.
- Show clear permission explanations; revoking optional memory permission removes that panel gracefully.
- Uninstalling removes extension-managed data; no browser performance preference should have been silently changed.

Proposed performance budgets, measured on a recorded reference Mac: hidden dashboard and no due work should produce no sustained extension CPU activity; automatic scan/action run for 200 tabs should generally complete within 5 seconds excluding browser delays; visible dashboard for 200 tabs should respond to controls within 200 ms in typical use. Record actual idle/visible memory and CPU costs in Chrome Task Manager. These are targets to validate, not promises about every machine.

## 14. Acceptance tests

| ID | Scenario | Pass condition |
| --- | --- | --- |
| A01 | 3 windows, mixed groups, 50+ tabs | Inventory matches accessible browser tabs without changing order/group metadata. |
| A02 | Manual unload of a paused background video | Discarded state confirmed; tab stays in place; reopening reloads it. |
| A03 | 2-minute automatic threshold | Eligible background tab unloads at a later check; no early unload. |
| A04 | Selected tab in an unfocused window | Skipped with Selected reason. |
| A05 | Audible tab | Skipped during manual and automatic bulk actions. |
| A06 | Pinned/protected tab/site | Settings respected; reasons visible; removing protection permits later eligibility. |
| A07 | Automation off mid-batch | No further automatic requests after the setting is observed; already-unloaded tabs stay unloaded. |
| A08 | Worker terminates and restarts | Settings and session timers recover; scheduler is not duplicated. |
| A09 | Browser restart | No stale numeric IDs reused; discovery timers and grace applied. |
| A10 | User activates a candidate after preview | Execution revalidation skips it. |
| A11 | Tab closes, navigates or moves during execution | No wrong tab targeted; result is skipped/error as appropriate. |
| A12 | Chrome independently unloads a tab | Dashboard refreshes; external source is not falsely attributed. |
| A13 | Optional memory permission denied/revoked | Core functionality works; unavailable metrics never appear as zero. |
| A14 | Dashboard opens from a content tab | Immediate bulk action excludes the origin page. |
| A15 | Group is collapsed | Dashboard never assumes its tabs are unloaded merely because it is collapsed. |
| A16 | Sleep/wake with many overdue tabs | Revalidation and batch limits prevent a burst; timing delay is explained. |
| A17 | ChatGPT or Sheets protected by default | Bulk actions skip it; UI explains manual removal of protection. |
| A18 | Counts and filters | Total = Loaded + Unloaded; Protected/Eligible are overlapping classifications. |
| A19 | Internal/unsupported page and API rejection | Action unavailable or failure displayed; no close/navigation fallback. |
| A20 | Enable/disable without dashboard | Scheduler continues or stops as configured; no dashboard required. |
| A21 | Large batch interrupted by worker shutdown | Results reconcile without duplicate success counts or automatic manual replay. |
| A22 | Site matching | Exact host and optional subdomains work; `notexample.com` never matches `example.com`. |
| A23 | Unprotected unsaved draft demonstration | Reload risk is documented; extension never claims reliable draft detection. |
| A24 | Browser settings shortcut | Opens tested settings route or provides copyable fallback; no false status display. |

Unit-test the policy matrix, timer boundaries, protection precedence, settings validation/migrations, URL matching and aggregate counts. Integration-test the adapter/executor races, message validation, alarm recovery and optional permissions. Use E2E tests for the principal UI paths and manual checks on real Stable Chrome for actual memory effects, media and lifecycle behaviour. Headless tests alone cannot validate physical RAM savings.

## 15. Delivery milestones

Indicative effort for one experienced extension engineer: 12–18 working days, including validation and packaging, excluding store review and native monitoring. Refine after milestone 0.

| Milestone | Effort | Deliverable and exit gate |
| --- | --- | --- |
| 0 — Feasibility spike | 1–2 days | Prove manual discard across grouped/multi-window tabs, active-tab restrictions, optional system memory, app-style visibility and settings navigation. Record Stable/macOS versions and API gaps. |
| 1 — Working manual tool | 2–3 days | Installable unpacked extension with inventory, single/bulk unload, verified results, protections and clear limitations. A01/A02/A04/A10/A19 pass. |
| 2 — Reliable automation | 3–4 days | Custom threshold, one alarm, tracking, disable/cancel behaviour, recovery and race handling. Scheduler/restart tests pass. |
| 3 — User-facing dashboard | 3–4 days | Search, grouping, filters, settings, popup, activity log, optional RAM observations, accessibility and permission states. |
| 4 — Hardening and handoff | 3–5 days | Full acceptance matrix, benchmark report, packaged extension, reproducible build instructions and release checklist. |

Each milestone must leave an installable extension with its implemented features usable. Exact per-tab metrics are not a blocker for the lifecycle-control milestones, but they must remain explicitly marked unsupported rather than silently omitted.

## 16. Engineer deliverables and completion gate

Deliver source repository, lockfile, build scripts, production bundle/ZIP, manifest, assets, automated tests, acceptance results, benchmark notes, architecture notes, permission rationale, privacy text and user installation instructions. Provide a short walkthrough demonstrating manual unload, custom timer, protection and recovery after worker shutdown.

Completion requires all priority version-1 acceptance cases passing on current Stable Chrome for macOS, a documented supported-version range, no unsupported metrics shown as real, no automatic tab closure, and no change to existing tab organisation. Check an additional Windows environment if claiming cross-platform support.

Prepare store listing material only if publication is requested. A listing may describe the product as "for Google Chrome™" but must not carry "Chrome" in the extension name [S9]. This handoff authorises planning and implementation; it does not itself request publishing or collection of user data.

## 17. Later phase: detailed resource monitoring

Treat this as a separate discovery project if the user requires exact CPU/RAM reporting. A local companion can expose OS process measurements and platform-specific swap data through native messaging, but it does not automatically solve accurate per-tab attribution. Tabs can share processes, use several processes, and depend on shared browser/GPU services. Define the metric and attribution rules before designing the UI.

Discovery deliverables: a documented Stable-compatible collection approach, process-to-tab mapping proof, OS permissions/install requirements, security and update model, overhead benchmark and comparison with Chrome Task Manager and Activity Monitor. Unmapped/shared resources must remain visible as such. Avoid claiming that differently defined OS and Chrome metrics must match exactly.

Keep a provider boundary in version 1 so later resource data can be added without replacing tab controls. Possible capability keys: tabLifecycle, deviceMemory, processCpu, processMemory and osSwap. Unsupported values remain absent. No fabricated estimates as a fallback.

## 18. Official references

API availability checked against official Chrome documentation on 27 October 2026. Recheck during the feasibility spike and before release.

- [S1 — Tabs API: lifecycle and discard](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [S2 — Alarms API: scheduling and sleep](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [S3 — Processes API: Dev-channel availability](https://developer.chrome.com/docs/extensions/reference/api/processes)
- [S4 — System memory API: total/available device memory](https://developer.chrome.com/docs/extensions/reference/api/system/memory)
- [S5 — Tab groups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)
- [S6 — Chrome performance settings](https://support.google.com/chrome/answer/12929150)
- [S7 — Extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [S8 — Privacy API and controllability of supported settings](https://developer.chrome.com/docs/extensions/reference/api/privacy)
- [S9 — Chrome Web Store branding guidelines: trademarks in extension names](https://developer.chrome.com/docs/webstore/branding)

The scope, defaults, architecture, estimates and acceptance criteria in this document are engineering recommendations. The linked documentation supports the API constraints; it does not prescribe this product design.
