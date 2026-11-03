// Dashboard display and observability: the inventory itself, independent-unload
// observation (A12), degraded-capability behaviour (A13), and action availability on a
// tab Fallow can never act on (A19). See fixtures.ts for what each helper actually drives
// in the real browser.
import { UNAVAILABLE_TEXT } from '../../src/domain/constants';
import {
  backdateIdle, bulkUnload, denyOptionalPermission, discardViaApi, expect, minutes,
  openDashboard, openDashboardInNewWindow, openTab, row, tabOrderSnapshot, test,
} from './fixtures';

test('inventory matches the browser without rearranging anything', async ({ context, sw, extensionId }) => {
  await openTab(context, 'example.com');
  const page = await openTab(context, 'other.test');

  const before = await tabOrderSnapshot(sw);
  // Reuses this existing tab in place -- opening the dashboard must never itself create a
  // tab or otherwise change the window/group layout it is about to report on.
  await openDashboard(page, extensionId);

  await expect(page.getByTestId('count-total')).toHaveText(String(before.length));
  expect(await tabOrderSnapshot(sw)).toEqual(before);
});

test('the dashboard refreshes when chrome unloads a tab independently', async ({ context, sw, extensionId }) => {
  await openTab(context, 'other.test');
  const dashPage = await context.newPage();
  await openDashboard(dashPage, extensionId);
  await expect(row(dashPage, 'other.test').getByText('Loaded', { exact: true })).toBeVisible();

  // Chrome (or something else) discards the tab with no Fallow request in flight at all --
  // from the worker's point of view this is indistinguishable from a real independent
  // unload, which is exactly what A12 is about.
  await discardViaApi(sw, 'other.test');

  await expect(row(dashPage, 'other.test').getByText('Unloaded', { exact: true })).toBeVisible();
  await expect(dashPage.getByText('Observed unload; source unknown')).toBeVisible();
});

test('core features work with the memory permission denied', async ({ context, sw, extensionId }) => {
  await denyOptionalPermission(sw);
  await openTab(context, 'bystander.test');
  // A second tab in the same window, opened last, so bystander.test is not trivially "the
  // active tab of its window" by being the only one in it (a single-tab window's one tab
  // is always its active tab, which would read as SELECTED and never be eligible either).
  await openTab(context, 'decoy.test');
  // A window of its own for the dashboard: see openDashboardInNewWindow's doc comment -- a
  // plain same-window open here would make background/origins.ts protect whichever of the
  // two tabs above was most recently left as "the tab the dashboard was opened from" (F2),
  // a different rule than the one this test cares about, and would leave nothing eligible
  // for the bulk action below.
  const dashPage = await openDashboardInNewWindow(sw, context, extensionId);

  // The memory panel only renders once the owner turns monitoring on; it must still
  // degrade honestly (never a fabricated 0/NaN reading) when the permission is missing.
  await dashPage.getByRole('switch', { name: 'Monitor device memory' }).click();
  await expect(dashPage.getByTestId('memory-panel')).toBeVisible();

  await backdateIdle(sw, minutes(2), ['bystander.test']);
  await bulkUnload(dashPage);

  await expect(dashPage.getByTestId('count-unloaded')).not.toHaveText('0');
  await expect(dashPage.getByTestId('memory-available')).toHaveText(UNAVAILABLE_TEXT);
});

test('an internal page offers no unload action', async ({ context, extensionId }) => {
  const internalPage = await context.newPage();
  await internalPage.goto('chrome://settings/');
  const dashPage = await context.newPage();
  await openDashboard(dashPage, extensionId);

  // chrome://settings has no hostname (hostnameOf only recognises http/https), so its row's
  // ".tab-row-site" falls back to the URL scheme ("chrome"), never a host -- there is
  // categorically nothing Fallow can ever do with it, which is exactly what this asserts.
  await expect(row(dashPage, 'chrome').getByRole('button', { name: 'Unload now' })).toBeDisabled();
});
