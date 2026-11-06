# Fallow

Fallow is a Chrome (Manifest V3) extension that frees up memory from tabs you're not
using right now — **in place**. It discards a background tab's page content the same
way Chrome's own Memory Saver does, but it never closes the tab, never moves it to
another window, and never changes which group it belongs to. Go back to the tab later
and Chrome reloads it where you left it.

## Why

If you keep dozens of tabs open across a few windows and some long-lived tab groups
(the shape of browsing this project was built for — YouTube, ChatGPT, Google Sheets,
reference docs, etc.), most of them are idle most of the time but you don't want to
lose your layout by closing them. Fallow gives you:

- **A dashboard** showing every tab, loaded or unloaded, with its group, how long it's
  been idle in the background, and why a tab is or isn't eligible to unload.
- **Manual unload** — a single tab right now, or every eligible tab in bulk.
- **Automatic unloading** after a configurable inactivity threshold, running on an
  alarm so it keeps working even with no dashboard open and without holding the
  extension's service worker artificially awake.
- **Protection** — pinned tabs, and any site you add (with or without subdomains), are
  never touched.
- **An activity log** of what Fallow actually did and how it went — see
  `docs/PRIVACY.md` for exactly what is and isn't recorded.
- **Chrome settings assistance** — one-click shortcuts to the Chrome settings this
  extension doesn't control itself (Memory Saver, Energy Saver, etc.), since Fallow is
  deliberately a separate, narrower tool, not a replacement for them.

What Fallow deliberately does **not** do: it never shows a fabricated memory number
when a measurement isn't available, it never closes or reorders a tab, and it has no
access to exact per-tab RAM/CPU — Chrome doesn't expose that to extensions on Stable
(see `docs/design/findings/2026-11-02-chrome-process-memory-feasibility.md`). The full
product rationale lives in `../Fallow_Engineering_Plan.md`; the as-built architecture is
`../docs/design/HLD.md` (high level) and `../docs/design/LLD.md` (low level).

## Installing it

Fallow isn't on the Chrome Web Store in this version. You build it yourself and load it
as an unpacked extension — **`../docs/INSTALL.md`** walks through this step by step for
someone who doesn't use npm or Vite day to day (first-time install, updating after a
`git pull`, and troubleshooting). The short version, for anyone already comfortable with
Node:

```bash
npm run setup     # npm install && npm run build — produces dist/
```

Then in Chrome: open `chrome://extensions`, turn on **Developer mode** (top-right
toggle), click **Load unpacked**, and select the `dist/` folder this just built (inside
this `fallow/` directory).

### About Chrome's "Developer mode" nag

Because Fallow is loaded unpacked rather than installed from the Chrome Web Store,
Chrome periodically shows a warning banner (and sometimes disables unpacked extensions
until you re-enable them) reminding you that Developer mode is on and listing
unpacked extensions as a safety notice. This is a standard Chrome behavior for *any*
unpacked extension, not something specific to Fallow or a sign that something's wrong —
re-enabling it from `chrome://extensions` is all that's needed.

## Building from source

Everything lives directly under this directory (`fallow/` — `package.json`, `src/`,
`tests/`), not under a nested `fallow/fallow`.

```bash
npm install
npm run build        # vite build: dashboard, popup, service worker -> dist/
npm test             # vitest run
npm run typecheck    # tsc --noEmit, strict
npm run e2e          # playwright test (persistent-context Chromium, --load-extension)
npm run package      # build + zip dist/ -> fallow-<version>.zip
```

## Project layout

See `../docs/design/LLD.md` §1 for the full responsibility breakdown. Briefly:
`src/domain/` is pure policy logic, `src/platform/` wraps Chrome/storage APIs behind
interfaces, `src/background/` is the service worker, `src/ui/` is the dashboard and
popup (React), and `src/shared/` is the message protocol between them. `tests/unit/` is
Vitest + `@testing-library/react`; `tests/e2e/` is Playwright.

## More documentation

- `../docs/INSTALL.md` — install/update steps for a non-technical owner.
- `../docs/PERMISSIONS.md` — every permission Fallow requests, and why.
- `../docs/PRIVACY.md` — what's stored, where, and what's deliberately never recorded.
- `../docs/RELEASE-CHECKLIST.md` — what to re-check before cutting a release.
- `../docs/acceptance/` — the acceptance matrix and performance benchmarks.
