# Fallow — Design

Date: 28 October 2026
Status: approved for planning
Companion document: `Fallow_Engineering_Plan.md` (repo root) — the detailed
engineering handoff. This design records *intent* and the decisions taken in
conversation with the product owner. Where the two disagree, this document
wins; where this document is silent, the plan stands.

## 1. Intent and the why

The owner keeps many webpages open across two or three Chrome windows,
including long-lived tab groups. Tabs sit there unused — not finished with,
not ready to be closed — consuming RAM. Chrome's own Memory Saver has not
solved this to their satisfaction: it is opaque, not under their control, and
tells them nothing.

In their words, what they want is "a quick way to see how much is taken up and
do some quick fix, do not waste RAM."

Two desires sit inside that, and they were explicitly ranked:

1. **Clear the waste in a couple of clicks, and see free memory move.** This
   is the priority. Asked to pick only one function, the owner chose this one.
2. **Know the real RAM number per tab.** Wanted, but second. "Best to have
   both."

That ranking is the single most important fact in this document. Chrome's
Stable extension APIs expose device-wide total and available memory and give
nothing per-tab (`Fallow_Engineering_Plan.md` §2, §7). The priority desire is
fully buildable inside a pure extension; the secondary one is not. The product
is therefore split so that the achievable thing ships complete and the
unachievable thing is added later without being faked in the meantime.

## 2. Product shape

### Fallow — the product

A Chrome extension, at `fallow/`. Installed on its own, it is the whole
product as far as ordinary use goes: inventory of every accessible tab grouped
by window and tab group, manual unload of one tab or many, a configurable
inactivity timer, protections, an activity log, and optional device-wide RAM
observation with a before/after sample around a manual batch.

Fallow never closes a tab, never moves it, never replaces it with a
substitute "suspended" page, and never rearranges windows or groups. It
unloads in place through Chrome's supported discard API, and the tab reloads
when the owner returns to it.

Fallow must function completely with no add-on present.

### Fallow Probe — an optional add-on to Fallow

A native helper installed outside Chrome, at `addons/probe/`, with its own
installer and its own README. When present and running, it supplies per-process
memory measurements that let the dashboard fill in RAM columns. When absent,
those cells read "Not available" — never zero, never an estimate.

**Naming is a decided constraint.** "Fallow" is the product. "Probe" is an
add-on *to Fallow*, never called an extension. The word "extension" refers
only to the Chrome extension, in code, docs and UI alike. The owner asked for
this framing specifically to avoid the collision.

Probe reaches the dashboard through the capability-provider boundary the plan
describes (`Fallow_Engineering_Plan.md` §17). Fallow queries "is a memory
provider present?" at runtime. Neither side knows much about the other, and
removing Probe costs Fallow a column and nothing else.

**Honest attribution is a hard requirement for Probe.** Chrome places several
same-site tabs in one renderer process. Probe must therefore report shared
figures as shared — "shares 180 MB with 2 other tabs" — and must never divide
a process total by the number of tabs in it to manufacture a per-tab number.
The owner was told this before accepting the add-on and accepted it on those
terms. A fabricated estimate is worse than an absent measurement.

## 3. Build order

**Fallow first**, working and installed in the owner's own Chrome, before any
Probe work begins. Probe is a separate effort starting after that.

A plan covering Fallow should not plan Probe. It should only preserve the
provider boundary that lets Probe arrive later.

## 4. Goals

- Unused tabs release their memory, on command, in a couple of clicks.
- Tab, window and group organisation survives untouched.
- The owner can see what is loaded, what is unloaded, how long each
  background tab has been idle, and what is protected from unloading.
- Automatic unloading after a chosen idle period, under the owner's control
  and separate from Chrome's Memory Saver.
- Device free-memory movement is observable around a manual batch, labelled as
  a device-wide observation rather than an attributed saving.
- Every limitation is stated in the UI where it would otherwise mislead.

## 5. Non-goals

- Per-tab RAM or CPU inside Fallow alone. Out of reach on Stable Chrome; it is
  Probe's job, later.
- Reading or writing Chrome's Memory Saver state. No supported API exists.
  Fallow offers a settings shortcut and instructions, and never renders a
  fake switch for a setting it cannot read.
- Incognito support. `incognito: "not_allowed"` in v1.
- macOS swap and Memory Pressure.
- Content scripts, host permissions, debugger attachment, task-manager
  scraping, command-line flags, private APIs, remote code, remote analytics.
- Cross-profile visibility.
- A Developer-mode toggle or any developer-only control.

## 6. Anti-goals — failure even if it technically works

- **Showing a number that isn't real.** An unavailable measurement rendering
  as `0`, or a per-tab figure derived by dividing a total, is a product
  failure. "Not available in standalone mode" is the correct output.
- **Claiming credit it cannot prove.** A device-wide memory change is an
  observation, not proof that Fallow freed those bytes. A tab discarded by
  Chrome or another extension is recorded as "Observed unload; source
  unknown."
- **Losing the owner's work.** Unloading a tab with an unsaved draft,
  an in-flight request or a running generation, because Fallow guessed it was
  idle. Fallow has no content scripts and cannot detect any of that;
  protections and honest warnings are the mitigation, and reloading must never
  be described as an undo.
- **Losing the organisation.** Any closed tab, moved tab, reordered window or
  mutated group is a failure, including as a fallback when discard fails.
- **A startup or wake-from-sleep cascade** that unloads everything at once.
- **Needing the dashboard open** for automation to work.

## 7. Constraints

- Manifest V3, Chrome on macOS Stable the primary target, minimum Chrome 120.
- Permissions: `tabs`, `tabGroups`, `storage`, `alarms`, and optional
  `system.memory` requested only when the owner enables device memory
  monitoring. Nothing else.
- Service workers terminate when idle. No durable state in globals, no
  artificial keepalive, idempotent initialization, listeners registered
  synchronously at module load.
- One periodic alarm, not a timer per tab.
- All settings, timers and history stay on the device.
- The product name must not contain "Chrome", and avoids "Suspend" or
  "Suspender" in name and copy.
- API availability was checked 27 October 2026 and must be rechecked during
  the feasibility spike.

## 8. Decided in conversation (owner's calls)

- Priority is clearing waste over measuring it, if only one can be had.
- A helper installed outside Chrome is acceptable, provided it installs
  separately, in its own folder, as its own thing.
- Fallow is the main product; Probe is an add-on to Fallow, not an extension.
- Fallow ships and works in the owner's Chrome before Probe begins.
- The plan's proposed defaults are adopted as shipped defaults: automation off
  until switched on, 15-minute inactivity threshold, protected hostnames
  `chatgpt.com`, `docs.google.com`, `meet.google.com`, pinned tabs protected,
  2-minute startup grace, batches capped at 10.
- Those defaults are editable in the v1 settings UI. The owner asked for
  "configurable in the future"; since the plan already specs the settings
  surface for v1, it ships in v1 rather than being deferred.
- Shared-process memory must be reported as shared, never divided.
- **Popup scope is every window.** The toolbar popup's "Unload eligible tabs"
  acts across all Chrome windows, labelled with the window count ("Unload 31
  eligible tabs across 3 windows"). Fewest clicks to free the most memory was
  the point of the feature.
- **Manual bulk actions have a 60-second safety floor.** A tab the owner was
  looking at within the last minute is skipped from any *bulk* action, manual
  or automatic, with the reason "Used just now". This adds reason code
  `USED_RECENTLY` to the set in `Fallow_Engineering_Plan.md` §10 and amends
  §11 step 4: manual actions ignore the *configured threshold* but not the
  floor. A single-tab unload, where the owner has named the tab, has no floor
  and acts immediately. The floor exists because a one-click all-windows
  action otherwise sits directly on the "losing the owner's work" anti-goal.
- **Distribution is load-unpacked, for the owner only.** No Chrome Web Store
  submission in this cycle. The deliverable is a folder the owner drags into
  `chrome://extensions` with Developer mode enabled. Consequences accepted:
  Chrome will periodically prompt to disable Developer mode and the owner
  re-enables it. Therefore out of scope — store listing copy, screenshots,
  privacy policy document, trademark clearance on the name "Fallow", review
  turnaround and an auto-update path. A production ZIP and a written
  permission rationale are still produced, because they are cheap and they
  keep publication a later decision rather than a rewrite; the plan's §16
  store-listing paperwork is not.

## 9. Left to the builder

Everything in `Fallow_Engineering_Plan.md` not contradicted above, in
particular: the architecture and component split (§8), source layout (§8),
message and storage contracts (§10), the eligibility and unload algorithm
(§11), lifecycle and event handling (§12), performance budgets (§13), the
A01–A24 acceptance matrix (§14), and the milestone sequence (§15).

Specifically the builder's call, with the plan's recommendations as the
default: TypeScript, Vite, React for dashboard and popup, Vitest for pure
policy logic, Playwright plus manual Stable Chrome checks. React is a
recommendation, not a requirement; a smaller approach is acceptable if it
meets the accessibility and responsiveness requirements. Avoid heavy chart
libraries for a small sparkline.

Milestone 0, the feasibility spike, runs first and may revise estimates and
surface API gaps. Its findings come back before milestone 1 planning is
treated as final.

## 10. Done, for Fallow

The owner can install Fallow in their own Chrome, see their real windows and
groups unchanged, unload a batch of idle tabs in a couple of clicks, watch
device available memory rise, leave automation running without the dashboard
open, and trust that ChatGPT and Google Docs tabs were skipped. Priority v1
acceptance cases pass on current Stable Chrome for macOS. No unsupported
metric appears as a real number anywhere in the UI.

## 11. Builder-check resolutions (designer's calls)

A builder check raised seven open questions. Three went to the owner and are
recorded in §8. The remaining five are settled here on the designer's
authority, as the plan and this design already constrain them. A builder may
revisit any of them with reasons.

**11.1 — What the memory panel owes the owner when the number doesn't move.**
The panel's job is to *show the observation*, whatever it says. A flat or
negative reading after a successful batch is expected output on macOS, where
memory compression and OS file caching move the same number, and it is
labelled as such — not a bug, and not something to retry until it looks
better. The panel keeps the plan's §7 wording: other applications and OS
caching can affect this.

The owner's "see free memory move" is therefore served by *two* readouts, and
the primary one is not the RAM figure. Primary evidence is the confirmed-unload
count: tabs requested, confirmed discarded, skipped, failed — all of which
Fallow can verify by re-querying browser state. The device RAM panel is
secondary and explicitly an observation. `Fallow_Engineering_Plan.md` §7
already says unloading counts are useful operational evidence; this makes that
the headline rather than a footnote. Milestone 0 measures whether
`availableCapacity` moves usefully on the owner's machine, and that finding
informs how prominent the panel is — it does not gate the release.

**11.2 — Which acceptance cases are the release gate.** All of A01–A24. The
matrix is small enough and the anti-goals in §6 are spread across most of it,
so carving out a weaker subset would mean writing a release criterion the owner
never saw. Two cases are verified by deliberate fault injection rather than by
waiting for natural occurrence, and the method is recorded with the result:
A12 (Chrome independently discards a tab) and A21 (worker shutdown mid-batch).
A16 (sleep/wake with many overdue tabs) is verified on real hardware with a
real sleep cycle. If milestone 0 or 4 shows this is materially more work than
the plan's estimate, that goes back to the owner as a scope conversation
rather than being quietly dropped.

**11.3 — Who verifies, and who adjudicates spike findings.** Acceptance runs
on the owner's own Mac, which is the development machine, against their real
Chrome profile — their actual windows, groups, ChatGPT and Sheets tabs. There
is no synthesised-profile-only sign-off, though synthetic profiles are fine
for building up to 200-tab performance checks. The owner performs a final
hands-on pass: manual unload, custom timer, a protection holding, and recovery
after worker shutdown, per `Fallow_Engineering_Plan.md` §16. Milestone 0
findings and any API gap that contradicts this design go back to the owner as
a decision, not resolved silently — including a finding that Chrome 120 is the
wrong baseline or that discard behaves differently inside tab groups.

**11.4 — Where device-memory sampling lives, given the no-keepalive rule.**
In the dashboard page, not the service worker. Worker-side sampling on a
5-second cadence would itself be a keepalive and is forbidden by §7.

Each open dashboard tries to take a leader lock in `storage.session`, carrying
a holder id and a timestamp; the leader samples every 5 seconds and writes the
bounded 120-sample ring buffer, and followers render from that buffer without
sampling. A stale lock, left by a closed tab, is reclaimable after a short
timeout. Sampling stops when the page is hidden and resumes on visibility.
This is what the plan's "coordinate multiple dashboards through the worker so
sampling is not multiplied" is taken to mean in substance: sampling happens
once regardless of how many dashboards are open.

The worker keeps only the batch-correlation record — the before sample and the
batch's operation id — written when a manual batch starts. The after sample is
taken by whichever dashboard is visible roughly 10 seconds after completion. If
no dashboard is visible then, or the permission has gone, or sampling throws,
the result reads "After sample unavailable". The worker is never kept alive to
wait for it.

All of this sits behind the capability-provider interface, because that
boundary is the one piece of v1 architecture Fallow Probe cannot cheaply
redo later. `deviceMemory` is one provider; Probe's `processMemory` is another
registering against the same interface.

**11.5 — How long dashboard-origin protection lasts, and whether automation
honours it.** It expires, on the same rule as the directly-opened case in
`Fallow_Engineering_Plan.md` F2: the origin tab is protected until it has
accumulated the configured background duration, then becomes ordinary. No
permanent exemption, so a pinned-open dashboard cannot leave one tab
unclearable with a skip reason the owner has no way to remove.

`DASHBOARD_ORIGIN` suppresses *manual bulk* actions only. The automatic
scheduler already requires the full threshold, which is at least as long, so
the rule would never change an automatic decision. A manual single-tab unload
of the origin tab, where the owner has explicitly named it, proceeds. The skip
reason stays worded as "Recently opened dashboard from this tab."
