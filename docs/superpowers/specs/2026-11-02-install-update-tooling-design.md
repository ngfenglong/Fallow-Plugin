# Install/update tooling for a non-technical owner — scope decision

**Task:** Task 9 of the 2026-11-02 hardening-and-expansion plan.
**Date of this decision:** 2026-11-06.
**Decision:** build the narrow scope the brief itself proposes — a one-command
build/rebuild alias plus a short owner-facing doc — not an installer `.app` or an
auto-update checker.

## Why this scope, not a larger one

Fallow ships only as an unpacked extension in this version: there is no Chrome Web
Store listing, and `Fallow_Engineering_Plan.md` never commits to one. The owner's actual
job, today and after every `git pull`, is always the same three-step shape: get a
current `dist/` built from source, and point (or re-point) `chrome://extensions`'s
"Load unpacked" at it. Nothing in the engineering plan, `docs/TASKS.md`'s one-line
"Phase 3" entry, or the LLD/HLD describes a packaged installer, a signed `.app`, or any
in-extension auto-update mechanism (Chrome Web Store auto-update does not apply to an
unpacked load; building an equivalent would mean writing and maintaining a second,
separate update channel the product doesn't have today). Searching the task brief,
`Fallow_Engineering_Plan.md`, and `docs/design/HLD.md`/`LLD.md` for any mention of a
desktop installer, packaging pipeline, or version-check network call turned up nothing —
the roadmap line really is just "don't make the owner learn npm/Vite to rebuild after a
pull." Building more than that (an installer app, an auto-updater that phones out to
check for new releases) would be inventing a requirement, not reading one, and is
exactly the kind of thing the brief says to flag rather than build silently. No such
signal exists here, so the narrow scope stands.

## What "install/update tooling" concretely means for this task

One command, run from the `fallow/` project root, that works unchanged whether it's the
owner's first time (`git clone` then run it) or a routine update (`git pull` then run
it again): `npm run setup`, defined as `npm install && npm run build`. It is an npm
script alias rather than a shell script so it works identically on macOS, Linux, and
Windows (a `.sh` script would need Git Bash/WSL on Windows and a chmod step everywhere
else) — the owner only needs npm already on their machine, which they need regardless
of mechanism since this is still a from-source build. Running it always leaves a fresh,
consistent `dist/` behind, matching `fallow/package.json`'s version, whether or not
dependencies changed since the last run (`npm install` is a no-op when the lockfile is
already satisfied). The owner-facing half of this task is a short `docs/INSTALL.md`
(Task 10 hasn't landed `fallow/README.md` yet, per this plan's ordering) covering: the
one-time prerequisite (Node.js/npm installed), first clone + `npm run setup`, pointing
`chrome://extensions` Developer-mode "Load unpacked" at `fallow/dist`, and the update
flow (`git pull` + `npm run setup` again, then hitting the reload icon on the extension's
card — no re-pointing "Load unpacked" needed since the `dist/` path doesn't move).
`INSTALL.md` stays install/update-only; feature and architecture material stays out of
scope for this task and belongs in Task 10's eventual README.

## What this does not cover (explicitly out of scope)

No packaged `.app`/`.exe` installer, no Chrome Web Store submission or listening for its
auto-update, no network call that checks for a newer release, and no change to how the
extension itself loads or runs. If the owner's actual intent turns out to be one of
those, that is a separate, larger scoped project needing explicit sign-off — this task
does not infer or build toward it.
