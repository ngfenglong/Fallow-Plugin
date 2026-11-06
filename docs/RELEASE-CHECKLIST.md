# Release checklist

Work through this before cutting a release (tagging a version, handing the owner a
build, or — if that day comes — submitting to the Chrome Web Store). It's a generic,
reusable checklist: re-run every item each time, don't assume last release's answers
still hold. Record the date and findings of each run at the bottom of this file or in a
dated note under `docs/` (see Task 8's
`docs/design/findings/2026-11-02-chrome-process-memory-feasibility.md` for the
freshness bar this is meant to match — a dated, sourced finding, not a re-asserted
assumption).

## 1. Automated checks

From `fallow/`:

```bash
npm test && npm run typecheck && npm run build && npm run e2e
```

All four must pass before anything else on this list matters. `npm run e2e` needs a
Chromium binary (`npx playwright install chromium` once per machine) and fails outright
rather than silently skipping if the extension's own `dist/` is stale — run `npm run
build` first if in doubt.

## 2. Re-verify `Fallow_Engineering_Plan.md` §18's API references

§18 lists the official Chrome extension docs (S1–S9) its design leans on, checked
against official documentation on a specific date — not "once, forever." APIs this
project depends on can change channel availability, get deprecated, or gain a Stable
successor between releases. Before each release:

- Re-fetch each of S1 (Tabs), S2 (Alarms), S3 (Processes), S4 (System memory), S5 (Tab
  groups), S6 (Chrome performance settings), S7 (Service worker lifecycle), S8 (Privacy
  API), S9 (branding guidelines) against current official docs and note the date you
  checked.
- Specifically re-confirm S3: is `chrome.processes` still Dev-channel-only? (Last
  independently re-verified **2026-11-06** by Task 8 of the 2026-11-02 hardening plan —
  see `docs/design/findings/2026-11-02-chrome-process-memory-feasibility.md`. Still
  Dev-only as of that date, with no Stable successor found. That finding is specific to
  S3 only — S1/S2/S4–S9 have not been independently re-checked since the engineering
  plan's original 2026-10-27 date as of this writing, and are the first thing the next
  release should actually re-fetch.)
- If anything changed, do not edit `Fallow_Engineering_Plan.md` — it is explicitly the
  one exception to "keep current" (see `CLAUDE.md` → "Versioning rule"). Instead,
  record the drift in `docs/design/HLD.md`/`LLD.md` (bump both versions per
  `CLAUDE.md`'s rule) and, if it unlocks or breaks a capability, in `docs/TASKS.md`.

## 3. Re-verify the Chrome version range

- Confirm `fallow/public/manifest.json`'s `minimum_chrome_version` (currently `"120"`)
  is still accurate: every API Fallow actually calls (`tabs`, `tabGroups`, `storage`,
  `alarms`, optional `system.memory`) must be available at that floor. Check the
  "Availability" section of each API's current official reference page.
  `tests/unit/manifest.test.ts` pins the floor value itself but cannot verify that
  Chrome still supports it — that's a manual doc check, not something a unit test can
  do.
- Note the current Stable Chrome version on the machine(s) used for Step 4 below (the
  engineering plan's §16 completion gate requires "a documented supported-version
  range," not just a floor).
- If raising the floor, grep the codebase for any feature-detection or fallback code
  written for the old floor that a higher minimum would make dead code, and consider
  removing it in a separate, reviewed change — not as part of the release itself.

## 4. Acceptance matrix and benchmarks

Run through `docs/acceptance/2026-11-02-acceptance-results.md` (A01–A24) and
`docs/acceptance/2026-11-02-benchmarks.md` end to end on the owner's real Chrome
profile/hardware before any release the owner will actually use day to day. Those two
documents are templates with every case and metric spelled out; re-run them fresh each
release rather than assuming an old PASS still holds — a prior release's results do not
carry forward automatically. `tests/e2e/` gives automated corroboration for some cases
(cited row by row in the acceptance doc) but is explicitly not a substitute for the
real-profile manual pass per `Fallow_Engineering_Plan.md` §14's own instruction that
"headless tests alone cannot validate physical RAM savings."

## 5. Packaging

```bash
npm run package     # -> fallow/fallow-<version>.zip, built fresh from dist/
```

Confirm the version inside the zip's `manifest.json` matches `fallow/package.json`'s
`version` field, and that both match whatever tag/release name is being cut. Per
`CLAUDE.md`'s versioning rule, if this is a release-worthy milestone, `package.json`,
`public/manifest.json`, and `docs/design/HLD.md`/`LLD.md`'s version numbers should all
move together — check this before packaging, not after.

## 6. Completion gate (`Fallow_Engineering_Plan.md` §16)

- All priority version-1 acceptance cases pass on current Stable Chrome for macOS
  (Windows only if cross-platform support is being claimed for this release).
- A documented supported-version range exists (Step 3 above).
- No unsupported metric is ever shown as real (covered by
  `tests/unit/copy-rules.test.ts` and `tests/unit/manifest.test.ts` at the code level;
  confirm by eye during the acceptance pass too, since those tests scan source text,
  not rendered output).
- No automatic tab closure, no change to existing tab organisation — covered by the
  acceptance matrix's A01/A11/A14/A15 and the e2e suite's "nothing closed/moved/
  navigated" assertions.

## 7. Docs sanity

- `README.md`, `docs/PERMISSIONS.md`, `docs/PRIVACY.md` still match the current
  manifest and `HistoryEntry` shape — these are hand-written docs that drift silently
  if `public/manifest.json` or `src/platform/storage.ts` change without anyone
  updating the prose. Diff them against the current source, don't just re-read them.
- `docs/TASKS.md` has no stale "in the active plan" row for work that already shipped.

## Run log

| Date | Run by | Result |
| --- | --- | --- |
| _(none yet — first real run is the owner's, on their own machine/profile)_ | | |
