# Chrome-process memory/CPU reading — feasibility finding

**Context:** a feasibility check, done before considering a per-tab memory/CPU feature.
**Date of this finding:** 2026-11-06.
**Decision: No-go** for this version. Do not implement `processMemory`/`processCpu`
providers now. Keep the reserved `CapabilityKey` slots as-is (unregistered, absent from
any registry), per `docs/design/LLD.md` §4's existing note.

## What this re-checks

The project's original design assumed `chrome.processes` is Dev-channel-only, based on
official docs checked on 2026-10-27. That assumption was nine days old at the time of
this check, so it is re-verified here against current documentation rather than
re-cited. This finding also covers the native-messaging-companion alternative, which
the original design deferred to "a separate discovery project."

## 1. `chrome.processes` — current official documentation

**Source:** https://developer.chrome.com/docs/extensions/reference/api/processes
**Accessed:** 2026-11-06.

- The page's "Availability" section lists exactly one channel: **Dev**. It carries no
  note suggesting partial Stable availability, no deprecation notice, and no pointer to
  a successor/replacement API.
- Permission required: `processes` (a standard, non-optional permission declared in
  `manifest.json`'s `permissions` array — there is no "optional" variant that would let
  the extension request it only from users who opted in).
- Capabilities exposed, for reference: process `id`/`osProcessId`/`type`/`profile`/
  `tasks` (always available); `cpu`, `network`, JS heap and SQLite memory via `onUpdated`/
  `onUpdatedWithMemory`; `privateMemory` via `onUpdatedWithMemory`/`getProcessInfo` with
  `includeMemory`. `getProcessIdForTab(tabId)` maps a tab to its renderer process ID, and
  `TaskInfo.tabId` is the reverse direction. The docs note memory collection "incurs extra
  CPU usage."
- No `ProcessType` value or API shape in the current reference carries a "moved to
  Stable" or "now available outside Dev" note.

**Independent corroboration (web search, 2026-11-06):** every source found — a
third-party API-reference mirror, a permission-tracking site (chrome-stats.com), and
historical Chromium code-review/bug-tracker threads going back to 2013 — describes
`chrome.processes` as Dev/Canary-only, with `chrome.processes` simply `undefined` on
Stable. No source, official or third-party, named a successor or replacement API. A
broader search for "per-tab memory API" alternatives on Stable Chrome
(`performance.measureMemory`, `chrome://discards`, `chrome.system.memory`) turned up
nothing that exposes per-tab or per-process memory/CPU to an extension outside
`chrome.processes`.

**Conclusion:** the project's existing assumption holds. `chrome.processes` is still
Dev-channel-only as of today's official documentation; nothing has superseded it.

## 2. Does Fallow's minimum Chrome version (120) matter here?

No — and this is itself worth recording, because it changes the shape of the
conclusion. This is not a version-gating problem (where some future Chrome version on
Stable would unlock the API and Fallow's `minimum_chrome_version: "120"` in
`fallow/public/manifest.json` would simply need raising). It is a **channel**-gating
problem: `chrome.processes` has been restricted to the Dev channel since at least 2013,
on every Chrome version including whatever ships on Stable today. A user running Stable
Chrome 140+ has no more access to this API than a user on Stable Chrome 120. Raising
Fallow's minimum version would not help; only the user switching to the Dev or Canary
channel would, and requiring that of an extension's users is not a realistic
distribution story for a general-audience tool — it would mean most users could never
use the capability at all, contradicting the product's own goal of working on the
Chrome a normal person already has.

## 3. Native-messaging-companion alternative

Assessed: OS permissions/install burden, security/update model, and whether per-tab
process attribution is even well-defined.

### Install/permission burden

A native messaging host is a separate, non-Store-distributed executable. To use it, the
extension's owner would need to:
- Build and ship a platform-specific binary (macOS, with Windows as an optional
  cross-platform claim, is at least two OS targets, each with a different
  process-introspection API: macOS via `proc_pidinfo`/`task_info`/`sysctl`, Windows via
  the Process Status API/WMI/`toolhelp32`).
- Have the user run a separate installer (outside Chrome Web Store review/update) that
  writes a native-messaging-host manifest to an OS-specific location (a registry key on
  Windows; a JSON file under a fixed directory on macOS/Linux) naming the extension's ID
  as an allowed caller.
- Accept that this is real install friction for the non-technical-owner audience the
  project's own install/update tooling already tries to keep simple — a companion
  binary installer is a strictly bigger ask than "load an unpacked extension."

### Security/update model

- The companion runs as an ordinary OS process with the user's own privileges — it is
  not sandboxed the way the extension is, and Chrome's own security boundary does not
  extend to it.
- It needs its own code-signing and update mechanism; Chrome Web Store auto-update does
  not cover native binaries. The owner becomes responsible for shipping, signing, and
  patching it indefinitely — a standing maintenance surface this project does not
  currently have (no distribution pipeline, no signing identity, no update-check
  mechanism), and one this project's "no remote executable code, bundle everything"
  approach was written to avoid for the extension itself.
- macOS additionally restricts some process-level introspection (e.g., full `task_info`
  memory figures for other processes) without extra entitlements/hardened-runtime
  configuration that a locally-built, unsigned companion would not have — so even the
  OS-level reading is not guaranteed to be as complete as "read `/proc` on Linux" might
  suggest.

### Per-tab attribution — the harder problem, and why it isn't solved by going native

Even granting a working, installed companion that can enumerate OS processes and their
memory/CPU, it still only sees **PIDs**, not tabs. To attribute a PID to a specific tab,
something has to supply the tab→PID mapping. On Stable Chrome, nothing does:
`chrome.processes.getProcessIdForTab()` is the only documented way to get that mapping,
and it is exactly the Dev-channel-only API this finding is about (confirmed by search in
§1 above — no Stable alternative API exposes a tab's renderer PID). So a native
companion does not sidestep the Stable-channel restriction; it inherits the identical
blocker one layer down; the extension side still cannot tell the companion which PID
belongs to which tab.

Even if that mapping were available, attribution is not well-defined in general:
- Site isolation can split a single tab across multiple renderer processes (e.g.
  cross-origin iframes), so "one tab = one process" does not hold.
- A single renderer process can host multiple tabs (Chrome reuses/shares renderer
  processes under some circumstances), so "one process = one tab" does not hold either.
- Chrome runs shared browser, GPU, network, and utility service processes that belong to
  no tab at all; their memory has to be shown as unmapped/shared rather than folded into
  any one tab's figure, or the UI would misrepresent a shared cost as tab-specific.
- Comparing an OS-reported figure (e.g. RSS from the companion) against Chrome's own
  internal accounting (e.g. `chrome://discards` or Chrome Task Manager) is not an
  apples-to-apples exercise — the two tools define "memory used by a process" somewhat
  differently (private/shared/working-set choices differ), so even a successful
  implementation could show numbers that don't match either Chrome's own task manager or
  Activity Monitor/Task Manager, which would read as a bug to a user even though it is a
  definitional difference. (The same caution was raised when this alternative was first
  scoped: avoid claiming that differently defined OS and Chrome metrics must match
  exactly.)

## Recommendation

**No-go**, for both paths, for this version:

1. `chrome.processes` (and any extension-API path to per-tab process memory/CPU) remains
   Dev-channel-only on today's official documentation, with no successor shipped.
   Fallow's `minimum_chrome_version` is irrelevant to this gate — it is a channel
   restriction, not a version one — so there is no version bump that unlocks it.
2. The native-messaging-companion alternative is not a smaller or safer substitute: it
   adds real install burden and a standing security/update-maintenance surface the
   project does not have today, and — more fundamentally — it cannot even solve tab→PID
   attribution on Stable Chrome, because that mapping itself has no Stable-channel
   source. Even disregarding that blocker, attribution is not well-defined in the
   presence of site-isolation process splitting, shared renderer processes, and
   browser/GPU/utility processes that belong to no tab.

A native-companion build is large enough, and crosses enough security/distribution
boundaries, that it would need its own separate scoping exercise and the owner's
**explicit sign-off** before any code gets written — this finding does not authorize
that path; it only assesses it.

**Action taken as a result:** no source changes to `fallow/src/platform/memory-provider.ts`.
The reserved `'processMemory'`/`'processCpu'` `CapabilityKey` slots stay exactly as they
are — present in the type union, unregistered in any built registry — unchanged from
before this check. `docs/design/HLD.md` §3's open-items entry for this item points at
this finding instead of restating the open question, and both `HLD.md`/`LLD.md` carry a
version bump recording it.

## Re-check trigger

Re-run this check if: Chrome ships a successor extensions API for per-process
memory/CPU on Stable, `chrome.processes` itself moves off Dev channel, or someone
commissions the native-companion path as its own scoped project with sign-off on the
install/security burden described above.
