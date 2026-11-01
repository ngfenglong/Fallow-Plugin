// The service worker. Chrome may stop it whenever it is idle and start it again for any
// event, so three rules govern this file:
//   1. Every listener is registered synchronously at module top level, before anything
//      awaits. A listener added later misses the event that woke the worker.
//   2. Nothing that must survive the worker lives in a variable here. Settings, timers,
//      grace, origins, the crash record and history all live in chrome.storage; what is
//      held in memory below dies with the operations it describes.
//   3. Every listener contains its own failures. A rejection escaping a listener is an
//      uncaught error in the worker; a reply that never comes is a UI page waiting forever.
import { createChromeAdapter, toTabFacts, type ChromeAdapter } from '../platform/chrome-adapter';
import { createChromeStorageArea, createRepos, type StorageArea } from '../platform/storage';
import { createTracker, type Tracker } from './tracker';
import { createInventory, type Inventory } from './inventory';
import { createExecutor, type BatchReport, type Executor } from './executor';
import { createScheduler, type Scheduler } from './scheduler';
import { createOrigins, type Origins } from './origins';
import { hostnameOf } from '../domain/hostname';
import { applySettingsPatch } from '../domain/settings';
import type { Settings } from '../domain/types';
import { STATE_CHANGED_MESSAGE, type Request, type Response } from '../shared/messages';
import { isTrustedSender, MAX_REQUEST_ID_LENGTH, parseRequest } from '../shared/validation';

/**
 * The operation id of a history row for an unload Fallow did not request (A12). The plan
 * asked for '', but storage's OPERATION_ID rule (/^[^/?#\s]{1,128}$/) drops any row whose id
 * is empty, so '' could never be stored or read back. Reserved: a caller may not use it.
 */
export const EXTERNAL_OPERATION_ID = 'external';

/**
 * How long, after an operation settles, an id it acted on still counts as Fallow's when
 * Chrome reports that tab unloaded. Chrome delivers those events within milliseconds; the
 * window only has to outlast that, and must stay short because a claim that outlives the
 * operation would hide a genuinely external unload of the same tab later on.
 */
export const CLAIM_TTL_MS = 30_000;

/** A burst of events (a window of tabs closing, a page loading) becomes one notice. */
export const NOTIFY_DELAY_MS = 100;

/** How long a failed initialisation stands before the next caller may try again. */
export const INIT_RETRY_MS = 10_000;

export type WorkerDeps = {
  api: typeof chrome;
  /** The ONE clock. The executor, the scheduler and every handler read time from here. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

type Handler = (...args: never[]) => unknown;

export type FallowWorker = {
  initialize(): Promise<void>;
  /** Acts on a request that has ALREADY passed the sender check and parseRequest. Never rejects. */
  handleRequest(req: Request, senderTabId: number | null): Promise<Response<unknown>>;
  /** The listener for each event, keyed by the chrome event's name. */
  listeners: {
    alarm: Handler; installed: Handler; message: Handler; startup: Handler;
    groupRemoved: Handler; groupUpdated: Handler;
    activated: Handler; attached: Handler; created: Handler; detached: Handler;
    removed: Handler; replaced: Handler; updated: Handler;
    focusChanged: Handler; windowRemoved: Handler;
  };
  services: {
    adapter: ChromeAdapter; tracker: Tracker; inventory: Inventory; executor: Executor;
    scheduler: Scheduler; origins: Origins; storage: { local: StorageArea; session: StorageArea };
  };
};

export function createWorker(deps: WorkerDeps): FallowWorker {
  const { api, now, sleep } = deps;
  const adapter = createChromeAdapter(api);
  const storage = {
    local: createChromeStorageArea(api.storage.local),
    session: createChromeStorageArea(api.storage.session),
  };
  const repos = createRepos(storage);
  const tracker = createTracker({ adapter, activity: repos.activity });
  const origins = createOrigins({ adapter, tracker, settings: repos.settings, storage: storage.session });
  const dashboardOrigins = () => origins.activeOrigins(now());
  const inventory = createInventory({
    adapter, tracker, session: repos.session, settings: repos.settings, dashboardOrigins,
  });
  const executor = createExecutor({
    adapter, inventory, tracker, settings: repos.settings, history: repos.history,
    session: repos.session, storage: storage.session, dashboardOrigins, now, sleep,
  });
  const scheduler = createScheduler({
    adapter, executor, settings: repos.settings, session: repos.session, inventory,
  });

  // ---- what this worker has in flight ---------------------------------------------
  //
  // A12 needs to know which unloads are Fallow's own. That is held here, in memory, and
  // that is deliberate rather than a lapse of the no-durable-globals rule: it describes
  // operations that exist only inside this worker. If the worker dies, they die with it, and
  // the next wake's crash-record reconcile — read from session storage — re-establishes the
  // claim for anything still unaccounted for. Nothing that must outlive the worker lives here.

  const inFlight = new Set<Promise<unknown>>();
  const claimedUntil = new Map<number, number>();
  /** New id -> the id Chrome renamed, from onReplaced. Lets a claim follow a rename. */
  const renamedFrom = new Map<number, { from: number; at: number }>();

  // An outcome where Fallow asked Chrome to unload (or may have, for a crashed batch).
  const REQUESTED: ReadonlySet<string> = new Set(['confirmed', 'unknown', 'failed']);

  function claimReports(reports: ReadonlyArray<BatchReport | null>): void {
    const at = now();
    const until = at + CLAIM_TTL_MS;
    for (const report of reports) {
      if (report === null) continue;
      for (const result of report.results) {
        if (!REQUESTED.has(result.outcome)) continue;
        claimedUntil.set(result.tabId, until);
        if (result.newTabId !== undefined) claimedUntil.set(result.newTabId, until);
      }
      if (report.reconciled) claimReports(report.reconciled);
    }
    // A rename's own dispatch time is the wrong clock to age it by: the operation it
    // belongs to may still be mid-flight when onReplaced fires, and can settle well over
    // CLAIM_TTL_MS later for a large or slow batch. isFallows only reaches renamedFrom
    // at all once every in-flight operation (including whichever one is settling right
    // now) has resolved, so "a batch just settled" is the one signal that whatever
    // rename it produced is about to be checked. Refreshing every rename's age here ties
    // its survival to that signal instead of to the rename's own, unrelated clock.
    // Harmless for an unrelated rename this settlement had nothing to do with: the
    // CLAIMED id at the end of its chain still expires on its own schedule regardless.
    for (const r of renamedFrom.values()) r.at = at;
  }

  /** Every operation that can issue a discard goes through here. */
  function track<T extends BatchReport | null>(op: Promise<T>): Promise<T> {
    inFlight.add(op);
    // Registered first, so the claims exist before anyone waiting on `op` resumes.
    const forget = () => { inFlight.delete(op); };
    op.then((batch) => claimReports([batch]), () => undefined).then(forget, forget);
    return op;
  }

  function forgetExpired(at: number): void {
    for (const [id, until] of claimedUntil) if (until < at) claimedUntil.delete(id);
    // A rename's own clock, from its OWN dispatch, is the wrong clock to expire it by: the
    // operation that requested it may still be running. onReplaced for an early tab in a
    // large manual-bulk batch can fire well over CLAIM_TTL_MS before that batch's own
    // discard confirmations finish and claimReports runs — and until the batch settles,
    // isFallows has nothing else to check the rename against. So a rename record is held
    // for the whole time any operation is in flight, and only starts aging once none is.
    for (const [id, r] of renamedFrom) if (at - r.at > CLAIM_TTL_MS || r.at > at) renamedFrom.delete(id);
  }

  /** Whether this tab, or a tab it was renamed from, is one a Fallow operation acted on. */
  function isFallows(tabId: number): boolean {
    const at = now();
    forgetExpired(at);
    let id = tabId;
    // Bounded: a discard renames once, and a chain longer than this is not one operation.
    for (let hop = 0; hop < 8; hop++) {
      const until = claimedUntil.get(id);
      if (until !== undefined && until >= at) return true;
      const prev = renamedFrom.get(id);
      if (prev === undefined) return false;
      id = prev.from;
    }
    return false;
  }

  // ---- initialisation -------------------------------------------------------------

  /**
   * Recovery after any worker start. Idempotent: nothing here resets a timer that already
   * exists, starts a second grace or creates a second alarm.
   *   settings -> session (seeding discovery and grace only when absent) -> tracker
   *   reconcile against a fresh tab query -> crashed-batch reconcile -> alarm.
   */
  async function recover(at: number): Promise<void> {
    const cfg = await repos.settings.read();
    const state = await repos.session.read();
    if (state === null) {
      try {
        await scheduler.beginGrace(at, 'startup');
      } catch (e) {
        // Carry-forward 5. No grace is recorded, and the scheduler reads a missing record as
        // "no grace": an alarm surviving from before this start would unload every overdue
        // tab at once. Disarm it — best effort, the failure is reported either way — and let
        // the retry arm it again once a grace can be written.
        await scheduler.syncAlarm({ ...cfg, automationEnabled: false }).catch(() => undefined);
        throw e;
      }
    }
    const tabs = await adapter.queryTabs();
    if (tabs.ok) await tracker.reconcile(tabs.value, at);
    // A batch a stopped worker left unfinished is Fallow's: Chrome may still be delivering its
    // unload events to this new worker, and they must not be logged as external.
    claimReports(await executor.reconcileUnfinished(at));
    await scheduler.syncAlarm(cfg);
  }

  // The shared initialisation. One attempt at a time: every caller during an attempt gets
  // the same promise, so two events arriving together cause one recovery, not two racing.
  // A failed attempt is NOT final — a worker whose init rejected forever would be dead until
  // reinstalled (Review Focus 3) — and it is never papered over with defaults. It is kept
  // for INIT_RETRY_MS, so a burst of tab events cannot hammer failing storage, and the next
  // caller after that tries again. This record dies with the worker, which retries anyway.
  type Attempt = { promise: Promise<void>; failedAt: number | null; problem: string | null };
  let attempt: Attempt | null = null;

  function initialize(): Promise<void> {
    if (attempt !== null) {
      const { failedAt } = attempt;
      if (failedAt === null) return attempt.promise; // in progress, or done
      const since = now() - failedAt;
      // A clock that moved backwards also allows a retry: waiting for it would stall recovery.
      if (since >= 0 && since < INIT_RETRY_MS) return attempt.promise;
    }
    const current: Attempt = { promise: Promise.resolve(), failedAt: null, problem: null };
    current.promise = recover(now()).catch((e: unknown) => {
      current.failedAt = now();
      current.problem = e instanceof Error ? e.message : String(e);
      report('initialisation', e);
      throw e;
    });
    attempt = current;
    return current.promise;
  }

  /**
   * runtime.onStartup and runtime.onInstalled: a new browser session or a new extension
   * version, either of which empties chrome.storage.session. Recovery runs once more, after
   * any attempt already running and as the new shared attempt, so the two never overlap.
   * Because recovery is idempotent, this changes nothing when the session record survived.
   */
  async function reinitialize(): Promise<void> {
    await initialized();
    attempt = null;
    await initialize();
    notifyChanged();
  }

  /** Why the last recovery failed, for the owner to see; null once one has succeeded. */
  function startupProblem(): string | null {
    return attempt !== null && attempt.failedAt !== null ? attempt.problem : null;
  }

  /** Waits for initialisation and reports whether it succeeded. Never rejects. */
  async function initialized(): Promise<boolean> {
    try {
      await initialize();
      return true;
    } catch {
      return false;
    }
  }

  // ---- containment ----------------------------------------------------------------

  /**
   * Runs one listener's work so that nothing escapes it: a synchronous throw or a rejection
   * is logged to the worker console and the returned promise always resolves. Chrome ignores
   * a listener's return value (onMessage aside); tests await it.
   */
  function contain(event: string, work: () => Promise<unknown>): Promise<void> {
    let run: Promise<unknown>;
    try {
      run = work();
    } catch (e) {
      run = Promise.reject(e);
    }
    return run.then(() => undefined, (e: unknown) => { report(event, e); });
  }

  function report(where: string, e: unknown): void {
    try {
      console.error(`Fallow: ${where} failed:`, e);
    } catch {
      // A console that throws has nowhere further to report to.
    }
  }

  // ---- telling open pages ---------------------------------------------------------

  // One pending notice at most; a timer, never an interval, and nothing re-arms it.
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  function notifyChanged(): void {
    if (noticeTimer !== null) return;
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      try {
        // Chrome rejects this when no extension page is open to receive it. That is the
        // normal case, not an error.
        Promise.resolve(api.runtime.sendMessage(STATE_CHANGED_MESSAGE)).catch(() => undefined);
      } catch {
        // As above, for a synchronous throw.
      }
    }, NOTIFY_DELAY_MS);
  }

  /** The tail of a listener whose only meaning here is "what the owner sees changed". */
  function onDisplayChanged(event: string): () => Promise<void> {
    return () => contain(event, async () => {
      await initialized();
      notifyChanged();
    });
  }

  // ---- alarm ------------------------------------------------------------------------

  function onAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
    return contain('alarms.onAlarm', async () => {
      // Automation runs only on a completed recovery: until it has finished, the startup
      // grace may not be recorded, and an alarm acting then is the cascade it exists to stop.
      await initialize();
      const batch = await track(scheduler.onAlarm(alarm.name, now()));
      if (batch !== null) notifyChanged();
    });
  }

  function onStartup(): Promise<void> {
    return contain('runtime.onStartup', reinitialize);
  }

  function onInstalled(): Promise<void> {
    return contain('runtime.onInstalled', reinitialize);
  }

  // ---- tab events -----------------------------------------------------------------
  //
  // The tracker call is ENQUEUED AT DISPATCH, before anything awaits. The tracker runs its
  // operations one at a time in the order they were enqueued and needs nothing from
  // initialisation, so enqueuing here keeps its queue in Chrome's own event order —
  // including relative to the reconcile inside initialisation, which a wake-up event would
  // otherwise race (see onReplaced). Initialisation is still awaited afterwards: an event is
  // also the trigger that retries a failed one.

  /** The tail every tab event shares: let initialisation (or its retry) run. */
  async function settle(tracked: Promise<void>): Promise<void> {
    await Promise.all([tracked, initialized()]);
    notifyChanged();
  }

  function onActivated(info: chrome.tabs.OnActivatedInfo): Promise<void> {
    const at = now();
    return settle(contain('tabs.onActivated', () => tracker.onActivated(info.tabId, info.windowId, at)));
  }

  function onCreated(tab: chrome.tabs.Tab): Promise<void> {
    const at = now();
    return settle(contain('tabs.onCreated', async () => {
      // A tab without an id cannot be acted on, and the adapter drops such tabs too.
      if (tab.id === undefined) return;
      await tracker.onCreated(toTabFacts(tab), at);
    }));
  }

  function onRemoved(tabId: number): Promise<void> {
    return settle(contain('tabs.onRemoved', () => tracker.onRemoved(tabId)));
  }

  /**
   * A tab moved between windows keeps its timer (plan §4); what can change is which tab is
   * selected in the window it left or arrived in. That window's selection is re-read and
   * handed to tracker.onActivated, which clears the selected tab's timer and starts the one
   * it displaced, and only clamps every other tab's. One tab query, on a rare user action —
   * never a full reconcile.
   */
  async function refreshSelection(windowId: number, at: number): Promise<void> {
    const tabs = await adapter.queryTabs();
    if (!tabs.ok) return; // the next activation or reconcile corrects it; guessing would not
    const selected = tabs.value.find((t) => t.windowId === windowId && t.active);
    if (selected !== undefined) await tracker.onActivated(selected.tabId, windowId, at);
  }

  function onAttached(_tabId: number, info: chrome.tabs.OnAttachedInfo): Promise<void> {
    const at = now();
    return settle(contain('tabs.onAttached', () => refreshSelection(info.newWindowId, at)));
  }

  function onDetached(_tabId: number, info: chrome.tabs.OnDetachedInfo): Promise<void> {
    const at = now();
    return settle(contain('tabs.onDetached', () => refreshSelection(info.oldWindowId, at)));
  }

  /**
   * Chrome sends tabs.onRemoved for each tab of a closing window, so the window event is
   * where the records the per-tab events cannot guarantee are cleared: one reconcile against
   * a fresh query drops any record for a tab that no longer exists, keeping session storage
   * bounded. Window closes are rare; this is not a reconcile per update. The tracker itself
   * ignores an empty tab list (the last window closing), so it cannot erase every timer.
   */
  function onWindowRemoved(): Promise<void> {
    const at = now();
    return settle(contain('windows.onRemoved', async () => {
      const tabs = await adapter.queryTabs();
      if (tabs.ok) await tracker.reconcile(tabs.value, at);
    }));
  }

  /**
   * A discard renames a tab (milestone 0: every discard mints a new id), and this is the
   * ONLY place a record follows a tab to its new id — the executor deliberately does not
   * migrate, because a second migration would make this one find nothing to move.
   *
   * Carry-forward 2: tracker.onReplaced writes a FRESH record (timer reset, "Keep loaded"
   * lost) when the old record is already gone, and the old record goes when any reconcile
   * runs after Chrome renamed the tab but before the migration runs. The commonest such
   * reconcile is this worker's own recovery: a discard is exactly the kind of event that
   * wakes a stopped worker, and recovery queries the tabs (already renamed) while the event
   * waits. Enqueuing the migration at dispatch puts it ahead of any reconcile enqueued after
   * the event arrived, which closes that case. A reconcile enqueued BEFORE the event was
   * delivered can still win; only the tracker can close that, and it is reported.
   */
  function onReplaced(addedTabId: number, removedTabId: number): Promise<void> {
    const at = now();
    // Recorded at dispatch, ahead of the onUpdated(discarded) Chrome sends for the new id.
    renamedFrom.set(addedTabId, { from: removedTabId, at });
    const migrated = contain('tabs.onReplaced', () => tracker.onReplaced(addedTabId, removedTabId, at));
    // A discarded origin is the same page under a new id, and stays an origin (item 12).
    // Enqueued at dispatch for the same reason: a registration that ran first would prune
    // the old id as closed, leaving nothing to migrate.
    const originMoved = contain('tabs.onReplaced (origins)', () => origins.onReplaced(addedTabId, removedTabId));
    return settle(Promise.all([migrated, originMoved]).then(() => undefined));
  }

  // ---- A12: unloads Fallow did not request ----------------------------------------
  //
  // Residual, deferred (review of Task 14): `renamedFrom.set(...)` is the first, synchronous
  // line of `onReplaced` below, so a rename is on record before that handler does anything
  // else. This chain is still blind to one ordering Chrome's own dispatch has never been
  // measured against: `onUpdated(newId, {discarded:true})`'s LISTENER invocation arriving
  // before `onReplaced`'s. If Chrome ever calls them in that order, `renamedFrom` has
  // nothing to find yet and a Fallow discard that resolved with no minted id would be
  // misattributed as external. Closing this needs either a measured guarantee of Chrome's
  // dispatch order, or buffering every check — carried into Task 21's A12 fault injection.

  function onUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab?: chrome.tabs.Tab): Promise<void> {
    if (changeInfo?.discarded !== true) return settle(Promise.resolve());
    return settle(contain('tabs.onUpdated', () => recordExternalUnload(tabId, tab)));
  }

  async function recordExternalUnload(tabId: number, tab: chrome.tabs.Tab | undefined): Promise<void> {
    await initialized();
    // An unload of a tab Fallow is acting on right now is Fallow's, and its own batch logs it.
    // Which tabs those are is only known once the operation reports, so wait for every
    // operation in flight, then ask. Chrome may deliver this before or after the discard call
    // itself answers; waiting makes the answer the same either way.
    await Promise.allSettled([...inFlight]);
    if (isFallows(tabId)) return;
    const at = now();
    // Only the hostname is kept: a history row never carries a title or a URL.
    const hostname = hostnameOf(tab?.url ?? tab?.pendingUrl ?? '');
    await repos.history.append([{
      at, operationId: EXTERNAL_OPERATION_ID, trigger: 'external',
      sessionTabId: tabId, hostname, outcome: 'confirmed',
    }], at);
  }

  // ---- settings -------------------------------------------------------------------

  /**
   * A plain copy of the patch's own string-keyed fields. The boundary checks only that a
   * patch is present (parseSettings is the one settings validator), so anything can arrive
   * here when the worker is called directly; a getter that throws makes this throw, and the
   * caller refuses the whole change rather than applying part of it.
   */
  function copyPatch(patch: unknown): Record<string, unknown> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new TypeError('A settings change must be an object.');
    }
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(patch)) {
      if (typeof key === 'string') copy[key] = (patch as Record<string, unknown>)[key];
    }
    return copy;
  }

  async function updateSettings(requestId: string, patch: unknown): Promise<Response<unknown>> {
    let current: Settings;
    try {
      current = await repos.settings.read();
    } catch {
      // Never patch the defaults instead: saving them would overwrite the owner's settings,
      // and their automationEnabled (false) would read as the owner turning automation off.
      return refused(requestId, 'Could not read the current settings, so nothing was changed.');
    }
    let copy: Record<string, unknown>;
    try {
      copy = copyPatch(patch);
    } catch {
      return refused(requestId, 'The settings change could not be read, so nothing was changed.');
    }
    const next = applySettingsPatch(current, copy);
    const at = now();

    // Plan §4: switching automation on, or shortening the threshold while it is on, starts
    // a grace interval, so a change cannot itself unload a backlog at once.
    const graceReason = !next.automationEnabled ? null
      : !current.automationEnabled ? 'automation-on'
      : next.inactivityMinutes < current.inactivityMinutes ? 'threshold-shortened'
      : null;
    if (graceReason !== null) {
      try {
        // Carry-forward 5: the grace is recorded BEFORE anything can arm automation, and a
        // grace that could not be recorded stops the change entirely.
        await scheduler.beginGrace(at, graceReason);
      } catch {
        return refused(requestId, 'Could not record the pause before automatic unloading, so nothing was changed.');
      }
    }
    try {
      await repos.settings.write(next);
    } catch {
      return refused(requestId, 'Could not save the settings.');
    }
    try {
      await scheduler.syncAlarm(next);
    } catch (e) {
      // Carry-forward 7: a rejected syncAlarm is the only report of an unarmed (or still
      // armed) alarm. Saved, but the owner is told the schedule did not follow.
      report('UPDATE_SETTINGS alarm', e);
      return refused(requestId, `Settings were saved, but the automatic check could not be ${next.automationEnabled ? 'scheduled' : 'stopped'}.`);
    }
    return ok(requestId, next);
  }

  // ---- messages -------------------------------------------------------------------

  const READ_ONLY: ReadonlySet<Request['type']> = new Set<Request['type']>(['GET_SNAPSHOT', 'GET_HISTORY', 'UNLOAD_PREVIEW']);

  const ok = (requestId: string, data: unknown): Response<unknown> => ({ ok: true, requestId, data });
  const refused = (requestId: string, error: string): Response<unknown> => ({ ok: false, requestId, error });

  async function handleRequest(req: Request, senderTabId: number | null): Promise<Response<unknown>> {
    try {
      switch (req.type) {
        case 'GET_SNAPSHOT': {
          // Init's outcome is reported alongside, not instead: a failed recovery is exactly
          // when the owner needs to see the tabs and why automation may not be running.
          const snapshot = await inventory.capture(now());
          return ok(req.requestId, { ...snapshot, startupProblem: startupProblem() });
        }
        case 'UNLOAD_PREVIEW':
          // Reads only. Any mode may be previewed, including what automation would take.
          return ok(req.requestId, await executor.preview(req.scope, req.mode, now()));
        case 'UNLOAD_EXECUTE': {
          // The trigger comes from the message type: this is the owner's command, never the
          // schedule's. Automation runs only from the alarm, so a request to execute in auto
          // mode is the incoherent pairing (auto rules logged as a manual trigger) refused
          // here, since the boundary checks only that manual-single names one tab.
          if (req.mode === 'auto') return refused(req.requestId, 'Automatic unloading runs only on its schedule.');
          // Reserved for unloads Fallow did not request; a batch logged under it would read
          // as belonging to no Fallow operation.
          if (req.operationId === EXTERNAL_OPERATION_ID) return refused(req.requestId, 'That operation id is reserved.');
          const trigger = req.mode === 'manual-single' ? 'manual-single' : 'manual-bulk';
          // Built from named fields only: nothing else the caller sent reaches the executor.
          const batch = await track(executor.execute(req.scope, req.mode, trigger, now(), req.operationId));
          return ok(req.requestId, batch);
        }
        case 'UPDATE_SETTINGS':
          return await updateSettings(req.requestId, req.patch);
        case 'CANCEL_BATCH':
          executor.cancel(req.operationId);
          return ok(req.requestId, null);
        case 'REGISTER_DASHBOARD_ORIGIN': {
          // null is a dashboard opened directly: resolved against the sender's own tab.
          const originTabId = await origins.registerOrigin(req.originTabId, now(), senderTabId);
          return ok(req.requestId, { originTabId });
        }
        case 'GET_HISTORY':
          return ok(req.requestId, await repos.history.read());
        case 'SET_TAB_PROTECTION':
          await tracker.setTabProtection(req.tabId, req.isProtected);
          return ok(req.requestId, { tabId: req.tabId, isProtected: req.isProtected });
        case 'CLEAR_HISTORY':
          await repos.history.clear();
          return ok(req.requestId, null);
        case 'RECORD_MEMORY_SAMPLE':
          // No worker-side role is specified yet: per design §11.4 the dashboard holding the
          // sampling lock writes samples itself (Task 15). Refused, so no caller is ever told
          // a sample was kept when it was not.
          return refused(req.requestId, 'Memory samples are not recorded by the service worker.');
        default: {
          const unhandled: never = req;
          void unhandled;
          return refused('', 'This request is not supported.');
        }
      }
    } catch {
      return refused(req.requestId, 'The request failed unexpectedly.');
    }
  }

  /**
   * The id to echo on a refusal. parseRequest returns null with no reason, so it gives no id
   * back; without one the page cannot tell which of its requests failed. Only an own string
   * within the boundary's own length limit is echoed, and nothing else from a refused
   * message ever is. Anything else gets '' — still an answer, so nothing waits forever.
   */
  function salvageRequestId(message: unknown): string {
    try {
      if (typeof message !== 'object' || message === null) return '';
      if (!Object.prototype.hasOwnProperty.call(message, 'requestId')) return '';
      const id: unknown = (message as Record<string, unknown>).requestId;
      return typeof id === 'string' && id.length >= 1 && id.length <= MAX_REQUEST_ID_LENGTH ? id : '';
    } catch {
      return '';
    }
  }

  // Chrome closes the reply channel as soon as this listener returns, unless it returns
  // literally `true`. Every path below therefore answers exactly once, later.
  function onMessage(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void): true {
    void (async () => {
      let response: Response<unknown>;
      try {
        // The gate, before anything else: who sent it, then what it says. A refused message
        // causes no read and no action.
        const req = isTrustedSender(sender, api.runtime.id) ? parseRequest(message) : null;
        if (req === null) {
          response = refused(salvageRequestId(message), 'The request was refused.');
        } else {
          // Every request path re-reads what it needs and reports its own failures, so the
          // owner's command is answered whether or not recovery succeeded; waiting for it
          // first keeps a request from racing the crashed-batch reconcile, and is a retry.
          await initialized();
          response = await handleRequest(req, sender.tab?.id ?? null);
          // Only a request that can change state. A page refreshes on this notice with a
          // read-only request, which must never send another: that would loop forever.
          if (!READ_ONLY.has(req.type)) notifyChanged();
        }
      } catch {
        response = refused('', 'The request failed unexpectedly.');
      }
      try {
        sendResponse(response);
      } catch {
        // The page that asked has gone away; there is nobody left to answer.
      }
    })();
    return true;
  }

  return {
    initialize,
    handleRequest,
    listeners: {
      alarm: onAlarm, installed: onInstalled, message: onMessage, startup: onStartup,
      groupRemoved: onDisplayChanged('tabGroups.onRemoved'), groupUpdated: onDisplayChanged('tabGroups.onUpdated'),
      activated: onActivated, attached: onAttached, created: onCreated, detached: onDetached,
      removed: onRemoved, replaced: onReplaced, updated: onUpdated,
      focusChanged: onDisplayChanged('windows.onFocusChanged'), windowRemoved: onWindowRemoved,
    },
    services: { adapter, tracker, inventory, executor, scheduler, origins, storage },
  };
}

// ---- module top level: build, register, then start -----------------------------------
// Nothing above this line runs at load. Below it: one read of the global, one synchronous
// construction, fifteen synchronous registrations, and only then the first await.

const api = chrome;
const worker = createWorker({
  api,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
const on = worker.listeners;

api.alarms.onAlarm.addListener(on.alarm as never);
api.runtime.onInstalled.addListener(on.installed as never);
api.runtime.onMessage.addListener(on.message as never);
api.runtime.onStartup.addListener(on.startup as never);
api.tabGroups.onRemoved.addListener(on.groupRemoved as never);
api.tabGroups.onUpdated.addListener(on.groupUpdated as never);
api.tabs.onActivated.addListener(on.activated as never);
api.tabs.onAttached.addListener(on.attached as never);
api.tabs.onCreated.addListener(on.created as never);
api.tabs.onDetached.addListener(on.detached as never);
api.tabs.onRemoved.addListener(on.removed as never);
api.tabs.onReplaced.addListener(on.replaced as never);
api.tabs.onUpdated.addListener(on.updated as never);
api.windows.onFocusChanged.addListener(on.focusChanged as never);
api.windows.onRemoved.addListener(on.windowRemoved as never);

// Only now, with every listener in place, does anything await. Recovery starts at once
// rather than on the first event, so a crashed batch is reconciled on any wake. A failure
// is contained here and retried by the next event (see initialize).
worker.initialize().catch(() => undefined);

export const initialize = worker.initialize;
export const handleRequest = worker.handleRequest;
