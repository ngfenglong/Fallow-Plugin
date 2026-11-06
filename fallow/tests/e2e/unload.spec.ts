// Manual unload mechanics: a single tab (A02), a selected tab in a window that is not the
// focused one (A04), and the dashboard's own origin tab under an immediate bulk run (A14).
import {
  backdateIdle, bulkUnload, expect, minutes, openDashboard, openDashboardFromPopup,
  openDashboardInNewWindow, openLayout, openTab, row, tabIndexOf, test, unloadRow,
} from './fixtures';

test('a single unload leaves the tab in place', async ({ context, sw, extensionId }) => {
  await openTab(context, 'example.com');
  const other = await openTab(context, 'other.test');
  await other.bringToFront(); // example.com goes to the background so it has a timer at all

  const originalIndex = await tabIndexOf(sw, 'example.com');

  const dashPage = await context.newPage();
  await openDashboard(dashPage, extensionId);

  await unloadRow(dashPage, 'example.com');

  await expect(row(dashPage, 'example.com').getByText('Unloaded', { exact: true })).toBeVisible();
  expect(await tabIndexOf(sw, 'example.com')).toBe(originalIndex);
});

test.skip('a single unloaded tab reloads when the owner returns to it', async () => {
  // SKIPPED -- cannot run headless in this environment, confirmed by direct experiment, not
  // assumed: `document.visibilityState` stayed 'visible' for every tab in this sandboxed,
  // off-screen Chromium regardless of `page.bringToFront()` or
  // `chrome.tabs.update(id, { active: true })`, and a tab discarded via the real
  // `chrome.tabs.discard` stayed `discarded: true` / `status: 'unloaded'` for 10+ seconds
  // after being made the active tab by both methods. Chrome's reload-on-reactivate for a
  // discarded tab is driven by real OS-level compositor visibility, which this sandbox
  // (no attached display) never produces, so the transition this test needs to observe
  // never fires here regardless of wait time.
  //
  // Move to Task 10's manual acceptance list: open a tab, click "Unload now" on it from a
  // real dashboard, switch back to the tab, and confirm Chrome reloads it (the "Unloaded"
  // badge becomes "Loaded" again with no further action).
});

test('a selected tab in an unfocused window is skipped', async ({ context, sw, extensionId }) => {
  await openLayout(sw, context, [
    { host: 'window-one.test', window: 1, active: true },
    { host: 'bystander.test', window: 1 },
    { host: 'selected-elsewhere.test', window: 2, active: true },
  ]);

  // A dashboard of its own, in a third window: both content windows above end up
  // unfocused once this one takes focus, which is simpler and more deterministic than
  // juggling which of windows 1/2 is "the" focused one, and also sidesteps
  // background/origins.ts's same-window "most recently left tab" heuristic (see
  // openDashboardInNewWindow's doc comment) -- not what this test is about.
  const dashPage = await openDashboardInNewWindow(sw, context, extensionId);
  await backdateIdle(sw, minutes(2), ['bystander.test', 'selected-elsewhere.test']);

  await bulkUnload(dashPage);

  // Excluded for being the active tab of its window -- true regardless of whether that
  // window itself has OS focus, which is exactly A04's point.
  await expect(row(dashPage, 'selected-elsewhere.test').getByText('Selected', { exact: true })).toBeVisible();
  await expect(row(dashPage, 'selected-elsewhere.test').getByText('Loaded', { exact: true })).toBeVisible();
  // The bulk action genuinely ran (not just an empty no-op): an ordinary background tab in
  // the same batch really did get unloaded.
  await expect(row(dashPage, 'bystander.test').getByText('Unloaded', { exact: true })).toBeVisible();
});

test('the dashboard origin tab is excluded from an immediate bulk action', async ({ context, sw, extensionId }) => {
  const originPage = await openTab(context, 'origin.test');
  await openTab(context, 'bystander.test');
  await originPage.bringToFront(); // origin.test is "the tab the owner was reading"

  const dashPage = await openDashboardFromPopup(context, extensionId, originPage);
  await backdateIdle(sw, minutes(2), ['bystander.test']);

  await bulkUnload(dashPage);

  await expect(row(dashPage, 'origin.test').getByText('Recently opened dashboard from this tab')).toBeVisible();
  await expect(row(dashPage, 'origin.test').getByText('Loaded', { exact: true })).toBeVisible();
  await expect(row(dashPage, 'bystander.test').getByText('Unloaded', { exact: true })).toBeVisible();
});
