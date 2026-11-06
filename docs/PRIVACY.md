# Privacy

Short version: Fallow doesn't talk to anything but your own browser. Everything it
reads, stores and shows stays on your device.

## No analytics, no network calls, no remote code

Fallow makes no network requests of its own — no analytics, no telemetry, no crash
reporting, no update-check ping, no remote config, and no favicon or thumbnail fetches.
Its code is bundled at build time (`npm run build`); nothing is downloaded or evaluated
at runtime. The only "network" traffic Fallow is party to is Chrome's own navigation of
tabs you already asked it to open — Fallow never opens or fetches a URL on your behalf
except the two deliberate actions you take: clicking "Open Chrome performance settings"
(opens `chrome://settings/performance` in a new tab) and opening the dashboard/popup
pages that ship inside the extension itself.

## What's stored, and where

Everything lives in `chrome.storage.local` / `chrome.storage.session` on your machine —
Chrome's own per-extension storage, not a server Fallow controls (because there isn't
one):

- **Settings** (automation on/off, threshold minutes, protected sites, pinned-tab
  protection, the device-memory toggle) — `storage.local`, until you change them again.
- **Session tab timers and protections** (how long a tab has been in the background,
  which tabs you've asked to keep loaded for this session) — `storage.session`, cleared
  automatically when the browser session ends; never written to `storage.local`.
- **Activity history** (a bounded, newest-first log of unload attempts and their
  outcomes) — `storage.local`, capped in both age and entry count (see
  `fallow/src/domain/constants.ts`'s `HISTORY_MAX_AGE_MS` / `HISTORY_MAX_ENTRIES`), and
  clearable any time from the dashboard's "Clear history" control.

## No titles or URLs retained in history

The activity log's `HistoryEntry` shape (`fallow/src/platform/storage.ts`) is:

```ts
type HistoryEntry = {
  at: number; operationId: string; trigger: Trigger;
  sessionTabId: number; hostname: string | null;
  outcome: UnloadOutcome; reason?: ReasonCode;
};
```

There is no `title` or `url` field — only `hostname`, and only in normalised form
(lowercased, punycode for international domains; `null` when the tab's URL has no
hostname to report, e.g. an internal `chrome://` page). A tab's full title and full URL
are read live from the Tabs API while Fallow is actually scanning or acting on it (that's
what the `tabs` permission is for — see `docs/PERMISSIONS.md`), shown transiently in the
dashboard's own DOM as you're looking at it, and never written to storage. Closing the
dashboard or clearing history leaves nothing behind about what any tab was or where it
pointed — only that *a* tab at *some hostname* was unloaded, when, and how it went.

Protected sites you add are stored the same way: as a hostname (plus an
include-subdomains flag), never a full URL or page title.

## Optional device-memory panel

If you turn on the device-memory setting, Fallow requests the optional `system.memory`
permission and reads *whole-device* available/total RAM — never a per-tab or per-process
figure (Chrome doesn't expose that to extensions on Stable; see
`docs/superpowers/specs/2026-11-02-chrome-process-memory-feasibility.md`). That reading
is shown live and is not persisted into history. If you deny the permission request, or
revoke `system.memory` later from `chrome://extensions`, the memory panel disappears —
Fallow never shows a stale, zero, or fabricated number in its place.

## Uninstalling

Uninstalling Fallow from `chrome://extensions` removes its entire `chrome.storage.local`
and `chrome.storage.session` data — settings, protected sites, and activity history all
go with it, the same as any other Chrome extension's storage. Fallow does not write
anything outside its own extension storage: it does not touch Chrome's own preference
files, does not change any `chrome://settings` value, and does not leave anything behind
for you to clean up by hand.
