# Permissions Fallow asks for, and why

Verified against `fallow/public/manifest.json` on 2026-11-06. If this list and the
manifest ever disagree, the manifest is correct and this file is stale — update it.

```json
"permissions": ["tabs", "tabGroups", "storage", "alarms"],
"optional_permissions": ["system.memory"]
```

There are no `host_permissions`, no `content_scripts`, and no `debugger`, `webRequest`,
`nativeMessaging` or `processes` permission. Fallow never asks to read the content of any
page, and it never runs code on a page you visit.

| Permission | What Fallow uses it for |
| --- | --- |
| `tabs` | Build the inventory (title, URL's hostname, pinned/audible/discarded state, window) for the dashboard and the eligibility rules, and carry out a discard (`chrome.tabs.discard`) when you or the automatic scheduler ask for one. |
| `tabGroups` | Read each tab's group title and colour so the dashboard can show the same groups you see in Chrome, without changing them. |
| `storage` | Keep your settings (threshold, protected sites, automation on/off), the bounded activity history, and in-session tab timers on this device. |
| `alarms` | Run the automatic-unload check on a periodic timer, so Fallow can do its job with no dashboard open and without a page kept artificially awake (the thing a `setInterval` in a dropped-and-respawned service worker cannot do reliably). |
| `system.memory` (optional, off until you turn it on) | Show the whole-device memory panel. Fallow only requests this when you enable the device-memory setting, and the panel disappears cleanly if you deny or later revoke it — see `docs/PRIVACY.md`. |

## What Fallow deliberately does not ask for

- **No `processes` permission** — it is Dev-channel-only on Chrome today (see
  `docs/superpowers/specs/2026-11-02-chrome-process-memory-feasibility.md` for the
  re-verified finding) and is not in this version's manifest at all.
- **No `host_permissions` / `content_scripts`** — Fallow never injects anything into a
  page or reads a page's content; `tabs` already gives it the metadata (title, URL,
  pinned/audible/discarded state) it needs.
- **No `webRequest` / `debugger` / `nativeMessaging`** — not used anywhere in the
  codebase; nothing in Fallow's design needs them.

## A note on `tabs` and full URLs

`tabs` does hand Fallow each tab's full URL, which is more than the hostname-only data
Fallow actually stores (see `docs/PRIVACY.md`). Chrome's manifest model does not offer a
narrower grant that still allows reading title/pinned/audible state and calling
`tabs.discard` — "full `tabs`" is the only permission shape that exposes those fields —
so the URL is read into memory during a scan and then reduced to a hostname (or dropped
entirely) before anything is written to storage or shown in the activity log. See
`fallow/src/platform/storage.ts`'s `HistoryEntry` type and `fallow/src/domain/hostname.ts`.
