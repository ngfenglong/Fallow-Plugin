// Shared Playwright fixtures and helpers for Fallow's end-to-end suite. These tests load
// the REAL unpacked build (fallow/dist) into a persistent-context Chromium instance, so
// every action below goes through the real `chrome.tabs`/`chrome.alarms`/`chrome.storage`
// APIs and the real service worker -- nothing here is a fake or a mock.
//
// Two things a black-box e2e suite cannot drive through the UI alone, and how this file
// gets around them without faking the behaviour under test:
//
//  1. Multi-window/group topology and the dashboard-origin popup flow need direct
//     `chrome.windows`/`chrome.tabs.group`/`chrome.tabs.create` calls, which only a
//     privileged extension context (the service worker) can make. `sw` below is that
//     context, reached via Playwright's documented extension-testing recipe
//     (`context.serviceWorkers()` / `waitForEvent('serviceworker')`).
//  2. "Automatic unloading fires after N minutes of real idle time" cannot wait N real
//     minutes in a test suite. `fireAlarmAt` backdates the SAME `chrome.storage.session`
//     records (`fallow.activity`, `fallow.session`) the real tracker/scheduler read, then
//     asks `chrome.alarms` to re-fire the real, already-armed alarm right away. The alarm
//     that fires, the scheduler that reacts to it and the executor that runs are all the
//     real production code; only the *clock the data was written against* is simulated,
//     the same way a server-side test backdates a database row instead of sleeping.
import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS } from '../../src/platform/storage';
import { ALARM_NAME } from '../../src/domain/constants';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DIST_DIR = path.resolve(here, '../../dist');

type Fixtures = { context: BrowserContext; extensionId: string; sw: Worker };

/**
 * A fresh, isolated Chromium profile per test (launchPersistentContext('', ...) always
 * creates a new temp profile when given an empty user-data dir), with Fallow's real build
 * loaded unpacked -- the same two flags the brief's Interfaces section specifies.
 */
export const test = base.extend<Fixtures>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${DIST_DIR}`,
        `--load-extension=${DIST_DIR}`,
      ],
    });
    // Every synthetic test host below is served from here, never the real network: this
    // suite must run with no network access and must never depend on a real site's
    // content, uptime or markup.
    await context.route('http://**/*', async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><title>${url.hostname}</title></head>`
          + `<body>${url.hostname}</body></html>`,
      });
    });
    await use(context);
    await context.close();
  },

  sw: async ({ context }, use) => {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },

  extensionId: async ({ sw }, use) => {
    const id = sw.url().split('/')[2];
    if (id === undefined) throw new Error(`Could not parse an extension id from service worker URL: ${sw.url()}`);
    await use(id);
  },
});

export { expect };

// ---- navigation -----------------------------------------------------------------------

export function dashboardUrl(extensionId: string, query = ''): string {
  return `chrome-extension://${extensionId}/dashboard/index.html${query}`;
}

export function popupUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}/popup/index.html`;
}

/** Opens a plain content tab at `http://<host>/`, served by the context-wide route stub. */
export async function openTab(context: BrowserContext, host: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`http://${host}/`);
  return page;
}

/**
 * Navigates an EXISTING page to the dashboard in place, rather than opening a new tab.
 * A14 aside, opening the dashboard must never itself rearrange or add to the owner's tabs
 * (A01) -- reusing a page the test already has open is what keeps that true here.
 */
export async function openDashboard(page: Page, extensionId: string, query = ''): Promise<void> {
  await page.goto(dashboardUrl(extensionId, query));
}

/**
 * Opens the dashboard in a brand-new window of its own, with no `originTabId`.
 *
 * Plain `openDashboard` above shares whatever window the given page is already in. F2's own
 * ruling (background/origins.ts's `mostRecentlyLeft`) is that a dashboard opened with NO
 * `originTabId` at all protects whichever OTHER tab in that same window was most recently
 * left -- a deliberate product behaviour for "I opened the dashboard directly", not a bug.
 * A test that wants to assert something precise about a specific OTHER tab's eligibility
 * under manual-bulk (not origin exemption itself, which A14 covers on its own) needs a
 * dashboard with no such candidate in its window at all, hence a window of its own.
 */
export async function openDashboardInNewWindow(
  sw: Worker, context: BrowserContext, extensionId: string, query = '',
): Promise<Page> {
  const url = dashboardUrl(extensionId, query);
  await sw.evaluate((url) => chrome.windows.create({ url, focused: true }), url);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const page = context.pages().find((p) => p.url() === url);
    if (page) {
      await page.waitForLoadState();
      return page;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Dashboard window never appeared for url: ${url}`);
}

/**
 * Faithfully drives the REAL popup code path (Task 18's `handleOpenDashboardTab`), so the
 * dashboard's own REGISTER_DASHBOARD_ORIGIN effect and background/origins.ts resolve the
 * origin exactly as they would from a real click of the action icon:
 *   1. A popup page is opened (becomes the active tab for a moment).
 *   2. `originPage` is brought back to front -- now IT is "the active tab in the current
 *      window", precisely what a real popup (never itself a tab) would see.
 *   3. The popup's own "Open dashboard" button is clicked, which reads that active tab and
 *      creates the dashboard tab with `?originTabId=<id>` -- all real popup/App.tsx code.
 * Returns the new dashboard Page.
 */
export async function openDashboardFromPopup(
  context: BrowserContext, extensionId: string, originPage: Page,
): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(popupUrl(extensionId));
  await originPage.bringToFront();
  const [dashboard] = await Promise.all([
    context.waitForEvent('page'),
    popup.getByRole('button', { name: 'Open dashboard' }).click(),
  ]);
  await dashboard.waitForLoadState();
  await popup.close();
  return dashboard;
}

// ---- layout: N tabs across windows and groups ------------------------------------------

export type TabSpec = {
  host: string;
  /** 1-based window index for this call; tabs sharing a number share a window. */
  window: number;
  /** Tabs sharing a window AND a group label are placed in the same tab group. */
  group?: string;
  /** Whether this tab should end up the active tab in its window. Default: the last one wins. */
  active?: boolean;
};

export type LayoutTab = { host: string; tabId: number; windowId: number };

/**
 * The brief's required helper: opens N tabs across however many windows/groups `specs`
 * describes, using `chrome.windows.create`/`chrome.tabs.create`/`chrome.tabs.group` from
 * the service worker -- the only context with permission to place tabs precisely -- then
 * waits for Playwright to discover the resulting Page objects so callers can drive them.
 */
export async function openLayout(
  sw: Worker, context: BrowserContext, specs: readonly TabSpec[],
): Promise<Map<string, LayoutTab>> {
  const created: LayoutTab[] = await sw.evaluate(async (specs) => {
    const windowIds = new Map<number, number>();
    const groupIds = new Map<string, number>();
    const out: Array<{ host: string; tabId: number; windowId: number }> = [];
    for (const spec of specs) {
      let windowId = windowIds.get(spec.window);
      let tabId: number;
      if (windowId === undefined) {
        const win = await chrome.windows.create({ url: `http://${spec.host}/`, focused: spec.active !== false });
        if (!win || win.id === undefined || !win.tabs || win.tabs[0]?.id === undefined) {
          throw new Error(`chrome.windows.create did not return a usable window for host: ${spec.host}`);
        }
        windowId = win.id;
        tabId = win.tabs[0].id;
        windowIds.set(spec.window, windowId);
      } else {
        const tab = await chrome.tabs.create({ windowId, url: `http://${spec.host}/`, active: spec.active === true });
        tabId = tab.id as number;
      }
      out.push({ host: spec.host, tabId, windowId });
      const groupKey = spec.group !== undefined ? `${windowId}:${spec.group}` : undefined;
      if (groupKey !== undefined) {
        const existing = groupIds.get(groupKey);
        if (existing === undefined) {
          const groupId = await chrome.tabs.group({ tabIds: [tabId] });
          groupIds.set(groupKey, groupId);
        } else {
          await chrome.tabs.group({ tabIds: [tabId], groupId: existing });
        }
      }
    }
    return out;
  }, specs);

  // Playwright discovers new targets asynchronously; give it a moment to attach to every
  // freshly created tab before callers try to use its Page objects.
  const hosts = new Set(created.map((c) => c.host));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const seen = new Set(context.pages().map((p) => p.url()));
    if ([...hosts].every((h) => seen.has(`http://${h}/`))) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const byHost = new Map<string, LayoutTab>();
  for (const item of created) byHost.set(item.host, item);
  return byHost;
}

// ---- reading the real browser state, bypassing the dashboard's own view ---------------

type RawTab = { id?: number; windowId: number; index: number; url?: string; pendingUrl?: string };

function hostOf(tab: RawTab): string | null {
  try {
    return new URL(tab.url || tab.pendingUrl || '').hostname || null;
  } catch {
    return null;
  }
}

/** The browser's own tab order: (windowId, index) pairs per tab id, independent of Fallow. */
export async function tabOrderSnapshot(sw: Worker): Promise<Array<{ tabId: number; windowId: number; index: number }>> {
  const tabs: RawTab[] = await sw.evaluate(() => chrome.tabs.query({}));
  return tabs
    .filter((t): t is RawTab & { id: number } => t.id !== undefined)
    .map((t) => ({ tabId: t.id, windowId: t.windowId, index: t.index }))
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
}

export async function tabIndexOf(sw: Worker, host: string): Promise<number> {
  const tabs: RawTab[] = await sw.evaluate(() => chrome.tabs.query({}));
  const tab = tabs.find((t) => hostOf(t) === host);
  if (!tab) throw new Error(`No open tab for host: ${host}`);
  return tab.index;
}

/**
 * Switches real browser focus to the tab for `host`, by tab id (never by a Playwright Page
 * handle -- a discard mints a NEW tab id/target, so any Page captured before the discard is
 * already closed by the time this runs). This is the same thing a person does by clicking a
 * tab: Chrome alone decides whether/when that reloads a discarded tab.
 */
export async function focusTab(sw: Worker, host: string): Promise<void> {
  await sw.evaluate(async (host) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => {
      try {
        return new URL(t.url || t.pendingUrl || '').hostname === host;
      } catch {
        return false;
      }
    });
    if (!tab || tab.id === undefined) throw new Error(`No open tab for host: ${host}`);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }, host);
}

/** Discards a tab directly via the real `chrome.tabs.discard`, outside any Fallow request --
 *  i.e. "Chrome unloaded this on its own", from Fallow's point of view (A12). */
export async function discardViaApi(sw: Worker, host: string): Promise<void> {
  await sw.evaluate(async (host) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => {
      try {
        return new URL(t.url || t.pendingUrl || '').hostname === host;
      } catch {
        return false;
      }
    });
    if (!tab || tab.id === undefined) throw new Error(`No open tab for host: ${host}`);
    await chrome.tabs.discard(tab.id);
  }, host);
}

// ---- row/action helpers on an already-open dashboard page -------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The `.tab-row` whose displayed site text is exactly `host` (TabTable.tsx's Row). */
export function row(page: Page, host: string) {
  return page.locator('.tab-row').filter({
    has: page.locator('.tab-row-site', { hasText: new RegExp(`^${escapeRegExp(host)}$`) }),
  });
}

/** F2/A23's one-time warning: clicks "Continue" if (and only if) it is already open. */
async function maybeAcknowledge(page: Page): Promise<void> {
  const ack = page.getByRole('alertdialog', { name: 'Confirm unloading tabs' });
  try {
    await ack.waitFor({ state: 'visible', timeout: 1_000 });
  } catch {
    return; // never appeared -- already acknowledged on this profile
  }
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** Clicks a single row's "Unload now", handling the ack dialog on a fresh profile. */
export async function unloadRow(page: Page, host: string): Promise<void> {
  await row(page, host).getByRole('button', { name: 'Unload now' }).click();
  await maybeAcknowledge(page);
}

/**
 * Drives the dashboard's bulk "Unload N eligible tabs" button through to completion:
 * initial click -> one-time ack (if needed) -> the preview's own "Unload N" confirm.
 *
 * Reloads first so the snapshot this click previews from is guaranteed fresh. Without
 * this, a caller that just wrote `chrome.storage.session` directly (`backdateIdle`,
 * `fireAlarmAt`) races the tracker's own serialised reconcile cycle: `tracker.reconcile`
 * does a full read-modify-write of the whole activity map on every GET_SNAPSHOT, which can
 * read a map from BEFORE that direct write and then write it back, clobbering it, if the
 * two happen to overlap. A reload's GET_SNAPSHOT has nothing else in flight to race.
 */
export async function bulkUnload(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole('button', { name: /^Unload \d+ eligible tabs$/ }).click();
  await maybeAcknowledge(page);
  const confirm = page.getByRole('button', { name: /^Unload \d+$/ });
  await confirm.waitFor({ state: 'visible' });
  await confirm.click();
}

// ---- settings -----------------------------------------------------------------------

export async function enableAutomation(page: Page): Promise<void> {
  const toggle = page.getByRole('switch', { name: 'Automatic unloading' });
  await toggle.click();
  // The switch does not flip optimistically: it re-renders only once the UPDATE_SETTINGS
  // round-trip completes and a fresh snapshot comes back, so waiting for aria-checked is
  // what actually confirms the setting landed before a caller acts on that (e.g. closing
  // the page, which could otherwise race the request).
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
}

export async function setThreshold(page: Page, minutesValue: number): Promise<void> {
  const input = page.locator('.threshold-input input[type="number"]');
  await input.fill(String(minutesValue));
  await input.press('Enter');
  // UPDATE_SETTINGS round-trips to the worker and back; give it a moment to land before a
  // caller fires a second settings change (e.g. enabling automation), since the two are
  // independent requests with no ordering guarantee between them otherwise.
  await page.waitForTimeout(300);
}

export function minutes(n: number): number {
  return n * 60_000;
}

/**
 * Simulates `elapsedMs` of real idle time, then forces the real, already-armed alarm to
 * fire immediately. See the file header for why this is the one deliberate "fake" in this
 * suite, and why it is a seeded-clock technique rather than a stub of the code under test.
 *
 * Re-arms the alarm up to a few times, not once: a worker with no page open at all (A20)
 * can be slow to wake for `when: Date.now() + 10`, under real OS scheduling this suite has
 * no control over, and a single attempt occasionally slipped past with nothing run at all.
 * Each attempt's success signal is a REAL history row logged with `trigger: 'automatic'`
 * (`KEYS.history`) -- not just a `discarded` tab, which milestone 0's own notes on this
 * codebase record as not a safe signal of a *completed, confirmed* unload, and not the UI,
 * which is a separate, slower hop (broadcast -> re-fetch -> re-render) this helper has no
 * need to wait through.
 */
export async function fireAlarmAt(sw: Worker, elapsedMs: number): Promise<void> {
  await sw.evaluate(async ({ elapsedMs, activityKey, sessionKey }) => {
    const now = Date.now();
    const activityWrap = (await chrome.storage.session.get(activityKey)) as Record<string, unknown>;
    const activity = (activityWrap[activityKey] ?? {}) as Record<string, { backgroundSince: number | null }>;
    for (const key of Object.keys(activity)) {
      if (activity[key]!.backgroundSince !== null) activity[key]!.backgroundSince = now - elapsedMs;
    }
    await chrome.storage.session.set({ [activityKey]: activity });

    const sessionWrap = (await chrome.storage.session.get(sessionKey)) as Record<string, unknown>;
    const session = sessionWrap[sessionKey] as { graceUntil: number | null } | undefined;
    if (session && typeof session.graceUntil === 'number') {
      session.graceUntil = session.graceUntil - elapsedMs;
      await chrome.storage.session.set({ [sessionKey]: session });
    }
  }, { elapsedMs, activityKey: KEYS.activity, sessionKey: KEYS.session });

  for (let attempt = 0; attempt < 15; attempt++) {
    const ran: boolean = await sw.evaluate(async ({ alarmName, historyKey }) => {
      await chrome.alarms.create(alarmName, { when: Date.now() + 10, periodInMinutes: 1 });
      await new Promise((r) => setTimeout(r, 700));
      const wrap = (await chrome.storage.local.get(historyKey)) as Record<string, unknown>;
      const rows = (wrap[historyKey] ?? []) as Array<{ trigger: string }>;
      return Array.isArray(rows) && rows.some((row) => row.trigger === 'automatic');
    }, { alarmName: ALARM_NAME, historyKey: KEYS.history });
    if (ran) return;
  }
  throw new Error(
    'fireAlarmAt: no automatic-trigger history row appeared after repeated alarm fires; '
    + 'automation never ran (see the comment above this function).',
  );
}

/**
 * Backdates just the named hosts' idle time, independent of automation/alarms (for
 * manual-bulk's one-minute floor, which has nothing to do with the automatic schedule).
 *
 * Writes each matching tab's record directly by its CURRENT tab id, rather than only
 * patching whatever the tracker already happens to have stored: the tracker only assigns a
 * tab a `backgroundSince` once it has observed that tab lose selection (an `onActivated`
 * for whatever tab took its place), which is an async event the caller has no reliable way
 * to wait for from outside the worker. A test choosing to backdate a host is asserting "for
 * this test, treat this tab as idle this long" outright, not racing the tracker's own timing.
 */
export async function backdateIdle(sw: Worker, elapsedMs: number, hosts: readonly string[]): Promise<void> {
  await sw.evaluate(async ({ elapsedMs, hosts, activityKey }) => {
    const tabs = await chrome.tabs.query({});
    const now = Date.now();
    const wrap = (await chrome.storage.session.get(activityKey)) as Record<string, unknown>;
    const activity = (wrap[activityKey] ?? {}) as
      Record<string, { tabId: number; backgroundSince: number | null; protectedForSession: boolean }>;
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      let host: string | null;
      try {
        host = new URL(tab.url || tab.pendingUrl || '').hostname || null;
      } catch {
        host = null;
      }
      if (host === null || !hosts.includes(host)) continue;
      const existing = activity[String(tab.id)];
      activity[String(tab.id)] = {
        tabId: tab.id,
        backgroundSince: now - elapsedMs,
        protectedForSession: existing?.protectedForSession ?? false,
      };
    }
    await chrome.storage.session.set({ [activityKey]: activity });
  }, { elapsedMs, hosts, activityKey: KEYS.activity });
}

/** Ensures the optional `system.memory` permission is NOT granted (A13). This is also the
 *  default state of a fresh profile; called explicitly so the test says so, not implies it. */
export async function denyOptionalPermission(sw: Worker): Promise<void> {
  await sw.evaluate(() => chrome.permissions.remove({ permissions: ['system.memory'] }));
}
