# Milestone 0 findings

**TEMPLATE: awaiting a run against a real profile. No results below have been measured.**

**Privacy: the probe output logs tab ids and hostnames only. Check anything you paste here before committing.**

- Chrome version:
- macOS version:

## Probe 1: tabs.query({}) - tab count, app/PWA window tabs, their windowId/groupId

Result:

## Probe 2: discard a grouped background tab - discarded flag, index/windowId/groupId and group collapse state

Result:

## Probe 3: discard the active tab - exact rejection (throw vs. silent no-op)

Result:

## Probe 4: tabs that already carry autoDiscardable === false (read-only; no mutation, no discard)

Result:

## Probe 5: tabGroups.query({}) - titles and colours readable with `tabGroups` alone

Result:

## Probe 6: permissions.request system.memory, then system.memory.getInfo() - capacity and availableCapacity

Result:

## Probe 7: availableCapacity before and 10 s after discarding 10 background tabs, x3 (deltas verbatim, even if flat or negative)

Result:

- Control (no discard, 10 s):
- Round 1 (before / after / delta, bytes and GiB; tabs requested and confirmed discarded):
- Round 2:
- Round 3:

## Probe 8: tabs.create chrome://settings/performance - opens or blocked

Result:

## Contradictions with the engineering plan or design

