# Milestone 0 findings

Run against the owner's real Chrome profile on 28 October 2026. Probes 6 and 7 were
run; probes 1-5 and 8 were not (see "Not run" at the end, with a ruling for each).

Environment: Google Chrome 156.0.8078.48, macOS Darwin 25.6.0, 36 GiB device RAM.

## Headline: device-wide available memory is a strong signal on this machine

Probe 7 compared a control round (sample, wait 10 s, sample again, **discard nothing**)
against three rounds that each discarded 10 background tabs and re-sampled 10 s later.

| Round | Delta in available memory | Tabs confirmed discarded |
| --- | --- | --- |
| Control (nothing discarded) | **-28.3 MiB** | 0 |
| 1 (mixed hosts) | **+2.073 GiB** | 10 |
| 2 (almost all `www.youtube.com`) | **+0.953 GiB** | 10 |
| 3 (almost all `www.youtube.com`) | **+3.067 GiB** | 10 |
| Total across 30 tabs | **+6.093 GiB** | 30 |

Device available memory went from **4.94 GiB** to **11.01 GiB** of 36 GiB.

The smallest discard round beat the control's noise floor by **35x**; the largest by
**111x**. The control was slightly *negative*, which is the expected shape of background
drift and confirms the instrument was not biased upward.

**Consequence for the product.** Design §11.1 left the memory panel's prominence open
pending this measurement, and this result settles it the optimistic way: the panel earns
top billing rather than demotion. The owner's stated want — "a quick way to see how much
is taken up" — is answerable on this hardware with a device-wide before/after reading.

The caveats in `Fallow_Engineering_Plan.md` §7 still hold and still ship: the figure is
device-wide, other applications and OS caching move it, and it is an observation rather
than an attribution. Round 2 freeing a third of what round 3 freed, on a near-identical
same-site tab set, is direct evidence of why no per-tab figure can be derived from it.

**Not a per-tab number.** 6.093 GiB over 30 tabs must never be divided into a per-tab
figure. Chrome shares renderer processes between same-site tabs, which is visible above:
rounds 2 and 3 were both almost entirely `www.youtube.com` yet differed by 2.1 GiB.

## Probe 6: system.memory permission and getInfo

`permissions.request({permissions:['system.memory']})` returned `granted=true`,
`lastError=null`, requested from a click handler. Two separate calls both succeeded, so
a repeat request on an already-granted permission did not need a fresh gesture here.

`getInfo` returns exactly `{availableCapacity, capacity}`:
- `capacity` = 38,654,705,664 B (36.00 GiB), stable across calls.
- `availableCapacity` = 11,419,811,840 B then 8,671,444,992 B minutes apart — it moves
  fast as discarded tabs reload and other applications run.

No per-process or per-tab field exists, exactly as §2 of the design states.

## Discovery: `tabs.discard` mints a NEW tab id

Not a probe question, but the most consequential thing in the run. **Every one of the 30
discards returned a tab object with a different `id` than the one requested:**

```
discard(610948997) -> returned {"id":610957847, ... "discarded":true,"status":"unloaded"}
NOTE: returned tab id 610957847 differs from requested 610948997
```

New ids were allocated sequentially during the operation (…847, …850, …853, stepping by 3).

**Preserved across the discard:** `windowId` (610947159 throughout), `groupId`
(1800074689, 1642264424, 157762737 all intact), `pinned`, `audible`, `autoDiscardable`,
and the tab's position. So tab organisation survives a discard, which is what A01 and
A02 require.

**Not preserved:** the numeric `tabId`.

This is a plan defect, not a surprise about the product's goals, and it is corrected in
the implementation plan before Tasks 9-11 run. See the ledger rulings M0-1 … M0-5.

## Probes not run, with a ruling for each

None of these is a blocker: each either cannot change an implementation decision, or is
already handled defensively by a task the plan specifies.

- **Probe 1 (app/PWA window tab visibility).** Not run. Ruling: Fallow displays whatever
  `tabs.query` and `windows.getAll` return and never asserts a window exists that the API
  does not report. If app-window tabs are absent they are simply not in the inventory;
  nothing breaks. Verified for real in Task 21 acceptance against this same profile.
- **Probe 2 (grouped-tab discard, group collapse state).** Not run, but probe 7
  incidentally answered the substance: `groupId` and `windowId` survived all 30 discards.
  Collapse state is a property of the group, not of a tab, so a tab discard cannot change
  it. A15 covers it at acceptance.
- **Probe 3 (discarding the active tab).** Not run. Ruling: Task 6 classifies a selected
  tab `SELECTED` and Fallow never requests a discard on one, so Chrome's rejection shape
  cannot change any decision. Task 7's adapter normalises either a throw or a no-op.
- **Probe 4 (tabs already `autoDiscardable === false`).** Not run. Ruling: Task 6
  classifies these `BROWSER_PROTECTED` and Fallow never requests a discard on one.
- **Probe 5 (`tabGroups.query` with only the `tabGroups` permission).** Not run. Ruling:
  Task 10 already routes a failed `queryGroups` through a `Result`, so the dashboard
  degrades to ungrouped rows rather than failing. Group ids were readable via `tabs.query`
  in probe 7 regardless.
- **Probe 8 (`chrome://settings/performance` opens).** Not run. Ruling: Task 19 already
  ships a copyable address as the fallback for exactly this case and never displays a
  status it cannot read.

## Contradictions with the engineering plan or design

1. `tabs.discard` changing the tab id contradicts the plan's implicit assumption that a
   requested tab id can be re-read to confirm the discard. Corrected in Tasks 7 and 11.
2. Nothing else. `chrome.system.memory` exposed only device-wide totals as documented, and
   tab organisation survived every discard.
