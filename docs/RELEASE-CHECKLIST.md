# Release checklist

A short list to work through before cutting a new release. Re-check every item each
time — don't assume a past answer still holds.

## 1. Build it clean

From `fallow/`:

```bash
npm run setup       # install + build
npm run typecheck   # tsc --noEmit, strict
```

Both must succeed.

## 2. Try it for real

Load the fresh `dist/` folder as an unpacked extension (or build the release zip, below,
and load that). Open a few tabs across a couple of windows and groups, then check:

- Unloading a tab (single and bulk) leaves it in place — same window, same group — and
  it reloads normally when you switch back to it.
- The dashboard's counts and filters match what's actually open.
- Settings (threshold, protected sites, automation) save and stick after a reload.
- Turning on the device-memory panel shows a real number, or disappears cleanly if you
  decline the permission — never a fake or zero reading.

## 3. Re-check the Chrome API notes once in a while

`Fallow_Engineering_Plan.md` §18 lists the official Chrome docs this project's design
leans on. Chrome's platform changes over time — worth a quick glance at those references
every so often, especially `chrome.processes` (still Dev-channel-only as of the last
check; see `docs/design/findings/`). If anything changed, update `docs/design/HLD.md`/
`LLD.md`, not the original engineering plan.

## 4. Package and ship

```bash
npm run package     # -> fallow/fallow-<version>.zip
```

Confirm the version inside the zip's `manifest.json` matches `fallow/package.json`.
Attach the zip to a GitHub Release so people can download it without building anything
themselves.

## 5. Docs still accurate?

A quick skim of `fallow/README.md` against the current `manifest.json` — permissions and
behavior described there should still match reality.
