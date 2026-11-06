# Performance benchmarks

Targets from `Fallow_Engineering_Plan.md` §13: "Proposed performance budgets, measured
on a recorded reference Mac... These are targets to validate, not promises about every
machine." This document records the machine and the measured numbers against those
targets — it does not restate the targets as if they were already-achieved results.

## Honesty note on how this document was produced

This document was written by an agent working in a sandboxed git worktree with **no
attached display, no real Chrome UI to open, and no access to Chrome's own Task
Manager or to any real hardware's CPU/memory counters**. Every metric below is marked
`NOT RUN`. No number in this document was measured, estimated, or invented — §13 itself
warns against exactly that kind of substitution ("Do not quietly substitute tab counts
for measured RAM"), and the controlling scope ruling for this task is explicit that a
fabricated or guessed number here would be worse than leaving the row honestly blank.

Unlike the acceptance matrix, none of these four metrics has an automated equivalent
worth citing: they are specifically about real browser process behavior (CPU scheduler
activity, OS-reported memory) that a headless/simulated test harness does not produce
in a way that means anything close to what Chrome's Task Manager reports. Citing a
synthetic Node-level timing number here, even labeled, would risk being read as
corroborating evidence for a claim it cannot actually support — so this document
doesn't include one.

## How to run this, as the owner

You'll need: Fallow built and loaded per `../INSTALL.md`, Chrome's Task Manager open
(macOS: **Window → Task Manager** from the menu bar; Windows: **Shift+Esc** inside
Chrome, or the three-dot menu → More tools → Task Manager), and — for the 200-tab
metrics — a way to actually open roughly 200 tabs (a bookmark folder's "Open all," a
saved session, or a throwaway browsing session; not the profile you rely on day to day,
since this will be disruptive).

| Metric | Target (§13) | How to measure | Machine | Measured value | Date |
| --- | --- | --- | --- | --- | --- |
| Idle CPU | No sustained extension CPU activity when the dashboard is hidden and no work is due (automation off, or on with nothing overdue). | Close the dashboard/popup. In Chrome's Task Manager, find Fallow's row (listed as its own entry under its name, or under "Extension:" prefix depending on Chrome version) and watch its CPU % column for ~60 seconds of otherwise-idle browsing. A momentary blip when the worker wakes for a scheduled alarm check is expected; sustained non-zero CPU with nothing due is not. | NOT RUN — requires real hardware and Chrome's own Task Manager | NOT RUN — requires real hardware and Chrome's own Task Manager | |
| 200-tab scan/action run | Automatic scan/action run for 200 tabs should generally complete within 5 seconds, excluding browser delays. | Open ~200 tabs, set a short threshold, enable automation (or trigger a manual bulk unload across all 200). Time from the alarm firing (or the bulk-unload click) to the dashboard/activity log showing the run's results as complete. "Excluding browser delays" means: time Fallow's own scan+decide+dispatch work, not however long Chrome itself takes to actually discard 200 tabs' worth of renderer processes. | NOT RUN — requires real hardware, a real 200-tab session, and a stopwatch/profiler | NOT RUN — requires real hardware, a real 200-tab session, and a stopwatch/profiler | |
| 200-tab dashboard control response | Visible dashboard for 200 tabs should respond to controls within 200 ms in typical use. | With ~200 tabs open and the dashboard showing all of them, click a filter, a sort option, or a single row's "Unload now," and time from click to visible UI update (e.g. using the browser's own Performance panel, or simply counting — 200ms is short enough that a stopwatch alone is imprecise; a recorded screen capture or the DevTools Performance panel is more reliable). | NOT RUN — requires real hardware, a real 200-tab session, and timing tooling | NOT RUN — requires real hardware, a real 200-tab session, and timing tooling | |
| Idle memory | Record actual idle memory cost in Chrome Task Manager (no fixed target given in §13 — this is a baseline to record, not a pass/fail number). | With Fallow loaded and nothing else of its own open (no dashboard/popup tabs), find its row in Chrome's Task Manager and record the "Memory footprint" (or "Memory" / "Private memory") column. | NOT RUN — requires real hardware and Chrome's own Task Manager | NOT RUN — requires real hardware and Chrome's own Task Manager | |
| Visible memory | Record actual visible (dashboard open) memory cost in Chrome Task Manager, ideally with the same ~200-tab session as the two metrics above so the figure means something close to a realistic worst case. | With the dashboard open and showing a large tab set, record Fallow's row (and, separately, the dashboard page's own "Tab:" row if Chrome lists it separately from the extension's background entry) in Chrome's Task Manager. | NOT RUN — requires real hardware and Chrome's own Task Manager | NOT RUN — requires real hardware and Chrome's own Task Manager | |

## Recording the machine

When you actually run this, replace the "Machine" column above with something like:
`MacBook Pro M-series, macOS <version>, Chrome <version>, <RAM> installed` — §13's
framing is explicit that these are targets to validate on a specific recorded machine,
not universal guarantees, so the machine identity is as much a part of the result as
the number.

## Summary

All five rows: **NOT RUN**. This document is the ready-to-execute template for the
owner's own benchmark pass, per `Fallow_Engineering_Plan.md` §13 and §16 (the
completion gate calls for "benchmark notes" as a deliverable) — it does not itself
satisfy that deliverable.
