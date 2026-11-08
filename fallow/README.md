# Fallow

Fallow is a Chrome extension. It frees up memory from tabs you are not using. It does
this **without closing them.**

## The problem

Many open tabs use a lot of memory. Most people do not want to close those tabs. A tab
holds your place — a form you filled in, a video queue, a long scroll position. Closing
it loses that.

Chrome has its own Memory Saver feature. It helps, but you cannot control it well, and
it does not tell you much about what it did.

## What Fallow does

Fallow unloads a background tab the same way Chrome's own Memory Saver does. The tab's
page content is removed from memory. The tab itself stays exactly where it was — same
window, same position, same group. Go back to it, and Chrome reloads it for you.

- **See every tab** in one dashboard: which window, which group, how long it has sat
  idle, and why it can or cannot be unloaded right now.
- **Unload one tab, or many**, right now, on demand.
- **Unload tabs automatically** after a time you choose, running in the background even
  with no Fallow window open.
- **Protect tabs you care about** — pin them, or add a site to a never-touch list.
- **See a short history** of what Fallow did and when.

What Fallow does **not** do: it never closes a tab, never moves it, and never changes
its group. It never shows a made-up number — if it cannot measure something, it says so
instead of guessing.

## Screenshots

**Dashboard** — every tab, grouped and searchable, with a reason shown for every one
that is skipped:

![Fallow dashboard](docs/images/dashboard.png)

**Popup** — a quick summary and one-click bulk unload from the toolbar:

![Fallow popup](docs/images/popup.png)

## Getting it

1. Go to this project's [Releases page](../../releases) and download the latest
   `fallow-<version>.zip`.
2. Unzip it.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked**, and select the folder you just unzipped.

Chrome is not on the Chrome Web Store, so it will show a reminder that Developer mode is
on. This is normal for any extension installed this way, not a sign of a problem.

### Building it yourself instead

If you would rather build from source:

```bash
git clone <this repository>
cd fallow
npm run setup   # installs dependencies and builds dist/
```

Then load the `dist/` folder the same way as above (step 3 onward).

## Using it

- Click the Fallow icon in your toolbar to open the **popup**. It shows a quick count
  and a one-click bulk unload.
- Click **Open dashboard** in the popup for the full view: every tab, search, filters,
  and settings.
- Click **Unload now** on any tab to free it right away.
- Turn on **Automatic unloading** and set a time, and Fallow will unload idle tabs for
  you without any action on your part.
- Add a site under protected sites, or click **Keep loaded** on a tab, to make sure
  Fallow never touches it.

## Permissions

Fallow asks for a small, fixed set of permissions. It does not ask for access to the
content of any page, and it does not run code on any page you visit.

| Permission | Why Fallow needs it |
| --- | --- |
| `tabs` | To read each tab's title and web address, so the dashboard can show it and decide if it is safe to unload. |
| `tabGroups` | To read each tab's group name and color, so the dashboard matches what you see in Chrome. |
| `storage` | To save your settings and the short activity history on your own device. |
| `alarms` | To check for idle tabs on a timer, even when no Fallow window is open. |
| `system.memory` (optional, off by default) | Only if you turn on the device-memory panel. Shows your device's free memory. Never turned on without you asking. |

## Privacy

- Fallow makes **no network requests**. It does not call home, track you, or check for
  updates over the network.
- Everything it stores stays on your device, in Chrome's own extension storage.
- Fallow never stores a tab's full web address or page title — only the site name (for
  example `example.com`), and only in its short activity history.
- Uninstalling Fallow removes everything it stored. Nothing is left behind.

## Project docs

- [`docs/design/HLD.md`](../docs/design/HLD.md) — how the project is put together
  (high level).
- [`docs/design/LLD.md`](../docs/design/LLD.md) — the same, in detail (low level): file
  layout, message formats, rules the code follows.
- [`Fallow_Engineering_Plan.md`](../Fallow_Engineering_Plan.md) — the original product
  plan this project was built from.

If you want to change or improve Fallow, start with the two design docs above — they
describe the project as it is actually built, not as it was originally planned.
