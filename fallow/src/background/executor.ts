// The only component that acts on the owner's tabs. Everything it does is irreversible
// from the owner's point of view: an unloaded tab loses unsaved form text, in-flight
// requests and video position. So every rule here is written to fail towards "leave the
// tab alone", and every failed read is recorded rather than read as "nothing there".
//
// Four rules, in the order they bite:
//   1. REVALIDATE. A preview is never permission to act later. Settings, the single tab
//      and its activity record are re-read immediately before each discard and `decide`
//      runs again. Anything unreadable holds the tab.
//   2. CONFIRM BY OBSERVATION. `confirmed` increments only after a read shows the tab
//      unloaded. The read uses the NEW tab id: milestone 0 measured that `tabs.discard`
//      mints a new id on every discard, so re-reading the requested id would report
//      TAB_GONE for a tab that unloaded perfectly. The discard is never re-issued; a
//      second request on a tab the owner just reactivated is a second attempt to take
//      their tab away.
//   3. NO FALLBACK. On any failure the tab is left exactly as it is: never closed, never
//      navigated, never replaced by a substitute page. The adapter exposes no such
//      operation and nothing here reaches around it.
//   4. BOUNDED, SEQUENTIAL WORK. `auto` takes at most AUTO_BATCH_MAX candidates, oldest
//      background time first. Manual batches run in chunks of MANUAL_CHUNK_SIZE and
//      revalidate between chunks. Requests are strictly sequential, and two executions
//      cannot interleave: they queue.
//
// `UnloadResult.tabId` and `HistoryEntry.sessionTabId` always carry the REQUESTED id,
// which is what the owner's action referenced and what the preview showed. The id Chrome
// minted travels separately in `newTabId` so the tracker can migrate its activity record.
import type { ChromeAdapter } from '../platform/chrome-adapter';
import { KEYS, type HistoryEntry, type HistoryRepo, type SessionRepo, type SettingsRepo, type StorageArea } from '../platform/storage';
import type { Inventory, Snapshot, TabRow } from './inventory';
import type { Tracker } from './tracker';
import { decide, type EligibilityMode } from '../domain/eligibility';
import { AUTO_BATCH_MAX, DISCARD_CONFIRM_TIMEOUT_MS, MANUAL_CHUNK_SIZE } from '../domain/constants';
import type { Decision, Settings, TabActivity, TabFacts, Trigger, UnloadOutcome, UnloadResult } from '../domain/types';
import { hostnameOf } from '../domain/hostname';
import { REASON_CODES, type ReasonCode } from '../domain/reason-codes';

export type Scope =
  | { kind: 'tab'; tabId: number }
  | { kind: 'tabs'; tabIds: number[] }
  | { kind: 'window'; windowId: number }
  | { kind: 'group'; groupId: number }
  | { kind: 'all' };

/**
 * Why an operation did nothing, or stopped, for a reason that is not about one tab.
 * A blocked report is the honest alternative to a run that cannot verify its own rules.
 */
export type BlockedReason =
  | 'tabs-unavailable'
  | 'dashboard-origins-unreadable'
  | 'startup-grace-unreadable'
  | 'activity-unreadable'
  | 'automation-off'
  | 'crash-record-unreadable'
  | 'internal-error';

/** What failed, when a tab was held because something could not be read rather than because of policy. */
export type SkipCause = 'settings-unreadable' | 'activity-unreadable' | 'tab-unreadable';

const BLOCKED_NOTES: Record<BlockedReason, string> = {
  'tabs-unavailable': 'Could not read the tab list, so nothing was unloaded.',
  'dashboard-origins-unreadable':
    'Could not confirm which tab this dashboard was opened from, so nothing was unloaded.',
  'startup-grace-unreadable': 'Could not read the startup pause, so no automatic unloading ran.',
  'activity-unreadable': 'Could not read how long these tabs have been unused.',
  'automation-off': 'Automatic unloading is off.',
  'crash-record-unreadable': 'An unfinished operation could not be read, so its result is unknown.',
  'internal-error': 'The operation stopped after an unexpected failure.',
};

/** Owner-facing copy for a blocked report. */
export function blockedNote(reason: BlockedReason): string {
  return BLOCKED_NOTES[reason];
}

/**
 * A result, plus the two things the domain type cannot carry:
 * `newTabId` is present only when Chrome actually minted a different id, and `cause`
 * only when the tab was held because a read failed rather than because of policy.
 */
export type ExecutedResult = UnloadResult & { newTabId?: number; cause?: SkipCause };

export type Preview = {
  operationId: string; mode: EligibilityMode; scope: Scope;
  eligibleTabIds: number[];
  skipped: Array<{ tabId: number; reasons: ReasonCode[] }>;
  /** Counted by each tab's primary (first, canonically ordered) reason, so the counts sum to `skipped.length`. */
  skippedCountsByReason: Partial<Record<ReasonCode, number>>;
  /** Non-null when this preview could not be computed safely; nothing is offered for unloading. */
  blocked: BlockedReason | null;
};

export type BatchReport = {
  operationId: string; trigger: Trigger;
  /** Tabs this operation took responsibility for. Equals `results.length`, not the number of discards issued. */
  requested: number;
  confirmed: number; alreadyUnloaded: number;
  skipped: number; failed: number; unknown: number;
  results: ExecutedResult[]; cancelled: boolean;
  blocked: BlockedReason | null;
  /** False when the crash-safety record could not be written or read in full: this report may be incomplete. */
  crashSafe: boolean;
};

/** The crash-safety record. One per operation, in session storage under KEYS.batch. */
export type InFlightBatch = {
  operationId: string; trigger: Trigger; mode: EligibilityMode;
  startedAt: number;
  /** Requested ids not yet resolved. Reconciliation turns each into `unknown`. */
  pending: number[];
  /** Results already resolved. `historyWritten` stops reconciliation logging a row twice. */
  done: Array<ExecutedResult & { historyWritten?: boolean }>;
  /** Set just before the batch logs its history, so a surviving record is not reported again. */
  completed?: boolean;
};

export interface Executor {
  preview(scope: Scope, mode: EligibilityMode, now: number): Promise<Preview>;
  execute(scope: Scope, mode: EligibilityMode, trigger: Trigger, now: number): Promise<BatchReport>;
  cancel(operationId: string): void;
  reconcileUnfinished(now: number): Promise<BatchReport[]>;
}

// 50, 100, 200, 400, 800 sums to 1550ms, inside DISCARD_CONFIRM_TIMEOUT_MS (2000ms); the
// next step would overrun it and is therefore never taken. Five observations are enough:
// Chrome either reports the tab unloaded within a frame or two, or we genuinely do not know.
const CONFIRM_BACKOFF_MS = [50, 100, 200, 400, 800] as const;

// Reasons that only a bulk action applies: the one-minute floor and the dashboard-origin
// exclusion. Removing them from a bulk decision yields the manual-single decision exactly,
// because manual-single applies no mode-specific check at all (see eligibility.ts).
const BULK_ONLY: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['USED_RECENTLY', 'DASHBOARD_ORIGIN']);

const TRIGGERS: readonly Trigger[] = ['manual-single', 'manual-bulk', 'automatic', 'external'];
const MODES: readonly EligibilityMode[] = ['auto', 'manual-bulk', 'manual-single'];
const OUTCOMES: readonly UnloadOutcome[] = ['confirmed', 'already-unloaded', 'skipped', 'failed', 'unknown'];

function isUnloaded(tab: TabFacts): boolean {
  return tab.discarded || tab.status === 'unloaded';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function own(raw: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;
}

export function createExecutor(deps: {
  adapter: ChromeAdapter; inventory: Inventory; tracker: Tracker;
  settings: SettingsRepo; history: HistoryRepo; session: SessionRepo; storage: StorageArea;
  now: () => number; sleep: (ms: number) => Promise<void>;
}): Executor {
  const { adapter, inventory, tracker, settings, history, storage, now, sleep } = deps;
  // `session` is deliberately unused: the startup grace window comes from the snapshot the
  // operation planned from, so the executor can never disagree with what the preview showed.
  void deps.session;

  const cancelledOps = new Set<string>();
  let sequence = 0;
  const nextOperationId = (at: number): string => `fallow-${at}-${++sequence}`;

  // Every operation that can issue a request runs alone. Two overlapping batches would
  // otherwise interleave their discards and each act on the other's stale plan.
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  // ---- reading ------------------------------------------------------------------

  // A capture that rejects is indistinguishable from an empty profile unless it is named,
  // so it becomes null and the caller reports 'tabs-unavailable'.
  async function captureSafe(at: number): Promise<Snapshot | null> {
    try {
      return await inventory.capture(at);
    } catch {
      return null;
    }
  }

  /**
   * Whether this operation may run at all. Each case is a rule the operation could not
   * verify, and an action that cannot verify its own exclusions must not run.
   */
  function blockedFor(
    mode: EligibilityMode, snapshot: Snapshot, scope: Scope, phase: 'preview' | 'execute',
  ): BlockedReason | null {
    const failed = snapshot.failedReads;
    // A named tab is re-read directly, so it does not need the tab list; a scope that must
    // be enumerated does.
    const needsTabList = scope.kind !== 'tab' && scope.kind !== 'tabs';
    if (!snapshot.tabsAvailable && needsTabList) return 'tabs-unavailable';
    // A14: the dashboard-origin exclusion is what stops a bulk action eating the page the
    // owner was reading when they opened the dashboard. The inventory fails OPEN here
    // (treats it as none), so refusing the run is this component's job.
    if (mode === 'manual-bulk' && failed.includes('dashboardOrigins')) return 'dashboard-origins-unreadable';
    // Grace stops an automatic cascade; an unreadable session record fails open in the
    // inventory, so automation holds off instead.
    if (mode === 'auto' && failed.includes('session')) return 'startup-grace-unreadable';
    // Only the preview needs this: it presents the snapshot's own decisions, and without
    // activity those decisions cannot see "Keep loaded". Execution revalidates each tab
    // against a freshly read activity record, so it holds the tab there instead.
    if (phase === 'preview' && mode === 'manual-single' && failed.includes('activity')) return 'activity-unreadable';
    return null;
  }

  function rowsInScope(rows: readonly TabRow[], scope: Scope): TabRow[] {
    switch (scope.kind) {
      case 'tab': return rows.filter((r) => r.tabId === scope.tabId);
      case 'tabs': return rows.filter((r) => scope.tabIds.includes(r.tabId));
      case 'window': return rows.filter((r) => r.windowId === scope.windowId);
      case 'group': return rows.filter((r) => r.groupId === scope.groupId);
      case 'all': return [...rows];
      default: {
        const unknownScope: never = scope;
        void unknownScope;
        return [];
      }
    }
  }

  /** The ids an explicit scope names, or null for a scope that must be enumerated. */
  function namedIds(scope: Scope): number[] | null {
    if (scope.kind === 'tab') return [scope.tabId];
    if (scope.kind === 'tabs') return [...new Set(scope.tabIds)]; // one request per tab, never two
    return null;
  }

  // The snapshot carries a decision per mode, except manual-single, which is the bulk
  // decision minus the bulk-only reasons. Derived rather than recomputed because a TabRow
  // is not a TabFacts, and reading every tab again to preview is work the owner did not ask for.
  function previewDecision(row: TabRow, mode: EligibilityMode): Decision {
    if (mode === 'auto') return row.decision;
    if (mode === 'manual-bulk') return row.manualBulkDecision;
    const reasons = row.manualBulkDecision.reasons.filter((r) => !BULK_ONLY.has(r));
    return { eligible: reasons.length === 0, reasons, evaluatedAt: row.manualBulkDecision.evaluatedAt };
  }

  // Oldest background time first, then by id so the order is total and reproducible.
  function autoOrder(rows: readonly TabRow[]): TabRow[] {
    return [...rows].sort((a, b) => b.backgroundMs - a.backgroundMs || a.tabId - b.tabId);
  }

  /** The dashboard origins and grace window this operation plans against. */
  function contextOf(snapshot: Snapshot): { graceUntil: number | null; origins: number[] } {
    return {
      graceUntil: snapshot.graceUntil,
      // The snapshot does not carry the origin list, but the tabs it protected are exactly
      // those whose bulk decision names DASHBOARD_ORIGIN. A failed read is blocked above,
      // so this is never an empty stand-in for a list that could not be read.
      origins: snapshot.rows
        .filter((r) => r.manualBulkDecision.reasons.includes('DASHBOARD_ORIGIN'))
        .map((r) => r.tabId),
    };
  }

  // ---- preview ------------------------------------------------------------------

  async function preview(scope: Scope, mode: EligibilityMode, at: number): Promise<Preview> {
    const base: Preview = {
      operationId: nextOperationId(at), mode, scope,
      eligibleTabIds: [], skipped: [], skippedCountsByReason: {}, blocked: null,
    };
    const snapshot = await captureSafe(at);
    if (snapshot === null) return { ...base, blocked: 'tabs-unavailable' };
    const blocked = blockedFor(mode, snapshot, scope, 'preview');
    if (blocked !== null) return { ...base, blocked };

    const byId = new Map(snapshot.rows.map((r) => [r.tabId, r]));
    const named = namedIds(scope);
    const rows = named === null
      ? rowsInScope(snapshot.rows, scope)
      : named.flatMap((id) => { const row = byId.get(id); return row ? [row] : []; });

    const eligible: TabRow[] = [];
    const skipped: Array<{ tabId: number; reasons: ReasonCode[] }> = [];
    for (const row of rows) {
      const decision = previewDecision(row, mode);
      if (decision.eligible) eligible.push(row);
      else skipped.push({ tabId: row.tabId, reasons: [...decision.reasons] });
    }
    // A named tab the scan does not know about is reported, not dropped: an id that is not
    // there is a fact about that tab, not an absence of one.
    if (named !== null) {
      for (const id of named) if (!byId.has(id)) skipped.push({ tabId: id, reasons: ['TAB_GONE'] });
    }

    // Under auto the preview must promise no more than execution would take.
    const chosen = mode === 'auto' ? autoOrder(eligible).slice(0, AUTO_BATCH_MAX) : eligible;
    const counts: Partial<Record<ReasonCode, number>> = {};
    for (const entry of skipped) {
      const primary = entry.reasons[0];
      if (primary !== undefined) counts[primary] = (counts[primary] ?? 0) + 1;
    }
    return { ...base, eligibleTabIds: chosen.map((r) => r.tabId), skipped, skippedCountsByReason: counts };
  }

  // ---- execution ----------------------------------------------------------------

  function emptyReport(operationId: string, trigger: Trigger): BatchReport {
    return {
      operationId, trigger, requested: 0, confirmed: 0, alreadyUnloaded: 0,
      skipped: 0, failed: 0, unknown: 0, results: [], cancelled: false,
      blocked: null, crashSafe: true,
    };
  }

  function addResult(report: BatchReport, result: ExecutedResult): void {
    report.results.push(result);
    report.requested++;
    switch (result.outcome) {
      case 'confirmed': report.confirmed++; return;
      case 'already-unloaded': report.alreadyUnloaded++; return;
      case 'skipped': report.skipped++; return;
      case 'failed': report.failed++; return;
      case 'unknown': report.unknown++; return;
      default: {
        const unknownOutcome: never = result.outcome;
        void unknownOutcome;
      }
    }
  }

  /**
   * What this operation will take responsibility for.
   * A manual scope takes every tab it covers and lets revalidation decide each one, so the
   * owner gets an answer for each. Auto takes only tabs the scan already found overdue,
   * oldest first, capped: a wake-from-sleep backlog of sixty must produce ten requests.
   */
  function planCandidates(scope: Scope, mode: EligibilityMode, snapshot: Snapshot): number[] {
    const named = namedIds(scope);
    const ids = named ?? rowsInScope(snapshot.rows, scope).map((r) => r.tabId);
    if (mode !== 'auto') return ids;
    const byId = new Map(snapshot.rows.map((r) => [r.tabId, r]));
    // A tab the scan cannot see cannot be shown to be overdue, so automation leaves it alone.
    const rows = ids.flatMap((id) => {
      const row = byId.get(id);
      return row && row.decision.eligible ? [row] : [];
    });
    return autoOrder(rows).slice(0, AUTO_BATCH_MAX).map((r) => r.tabId);
  }

  type Step = { kind: 'result'; result: ExecutedResult } | { kind: 'automation-off' };
  const asResult = (result: ExecutedResult): Step => ({ kind: 'result', result });

  /**
   * Rule 1. Re-reads settings, the tab itself and its activity record, then re-runs
   * `decide`. Anything that cannot be read holds the tab: acting on settings we failed to
   * read could unload a site the owner protected.
   */
  async function revalidate(
    tabId: number, mode: EligibilityMode, trigger: Trigger,
    ctx: { graceUntil: number | null; origins: number[] },
    hostnames: Map<number, string | null>,
  ): Promise<{ kind: 'go'; tab: TabFacts } | Step> {
    let config: Settings;
    try {
      config = await settings.read();
    } catch {
      // Cannot verify, so do not act. STARTUP_GRACE is the vocabulary's holding reason;
      // `cause` carries what actually failed so this is never read as a policy decision.
      return asResult({ tabId, outcome: 'skipped', reason: 'STARTUP_GRACE', cause: 'settings-unreadable' });
    }
    if (trigger === 'automatic' && !config.automationEnabled) return { kind: 'automation-off' };

    const read = await adapter.getTab(tabId);
    if (!read.ok) {
      if (read.error.kind === 'tab-gone') return asResult({ tabId, outcome: 'skipped', reason: 'TAB_GONE' });
      return asResult({ tabId, outcome: 'failed', reason: 'API_REJECTED', cause: 'tab-unreadable' });
    }
    // Only the hostname is ever kept: a history row must never carry a URL.
    hostnames.set(tabId, hostnameOf(read.value.url));

    let activity: TabActivity | null;
    try {
      activity = (await tracker.snapshot())[tabId] ?? null;
    } catch {
      return asResult({ tabId, outcome: 'skipped', reason: 'STARTUP_GRACE', cause: 'activity-unreadable' });
    }

    const decision = decide({
      tab: read.value, settings: config, activity, mode, now: now(),
      graceUntil: ctx.graceUntil, dashboardOriginTabIds: ctx.origins,
    });
    if (decision.eligible) return { kind: 'go', tab: read.value };
    // State before policy: an already-unloaded tab is not a refusal, and nothing is requested.
    if (decision.reasons.includes('ALREADY_UNLOADED')) {
      return asResult({ tabId, outcome: 'already-unloaded', reason: 'ALREADY_UNLOADED' });
    }
    const primary = decision.reasons[0];
    return asResult(primary === undefined
      ? { tabId, outcome: 'skipped' } // unreachable: no reasons means eligible
      : { tabId, outcome: 'skipped', reason: primary });
  }

  /**
   * Rules 2 and 3. One request, then observation only. The confirmation read uses the id
   * Chrome returned, never the requested one. A failure leaves the tab exactly as it is.
   */
  async function requestAndConfirm(requestedTabId: number): Promise<ExecutedResult> {
    const startedAt = now();
    const requested = await adapter.discard(requestedTabId);
    if (!requested.ok) {
      if (requested.error.kind === 'tab-gone') {
        return { tabId: requestedTabId, outcome: 'skipped', reason: 'TAB_GONE' };
      }
      return { tabId: requestedTabId, outcome: 'failed', reason: 'API_REJECTED' };
    }

    const facts = requested.value.facts;
    const minted = facts.tabId !== requestedTabId ? facts.tabId : undefined;
    const confirmed = (newTabId: number | undefined): ExecutedResult =>
      newTabId === undefined
        ? { tabId: requestedTabId, outcome: 'confirmed' }
        : { tabId: requestedTabId, outcome: 'confirmed', newTabId };

    if (isUnloaded(facts)) return confirmed(minted);

    // Not confirmed yet. Re-read the new id with bounded backoff inside the confirmation
    // window; never re-issue the discard.
    const deadline = startedAt + DISCARD_CONFIRM_TIMEOUT_MS;
    let lastReadWasGone = false;
    for (const delay of CONFIRM_BACKOFF_MS) {
      if (now() + delay > deadline) break;
      await sleep(delay);
      const again = await adapter.getTab(facts.tabId);
      if (again.ok) {
        if (isUnloaded(again.value)) return confirmed(minted);
        lastReadWasGone = false;
      } else {
        lastReadWasGone = again.error.kind === 'tab-gone';
      }
    }
    // Never observed unloaded. 'unknown' is the honest record: the request was accepted and
    // what became of the tab was not observed within the window.
    const result: ExecutedResult = minted === undefined
      ? { tabId: requestedTabId, outcome: 'unknown' }
      : { tabId: requestedTabId, outcome: 'unknown', newTabId: minted };
    if (lastReadWasGone) result.reason = 'TAB_GONE';
    return result;
  }

  async function runOne(
    tabId: number, mode: EligibilityMode, trigger: Trigger,
    ctx: { graceUntil: number | null; origins: number[] },
    hostnames: Map<number, string | null>,
  ): Promise<Step> {
    const gate = await revalidate(tabId, mode, trigger, ctx, hostnames);
    if (gate.kind !== 'go') return gate;
    return asResult(await requestAndConfirm(tabId));
  }

  // ---- crash safety -------------------------------------------------------------

  async function writeRecord(report: BatchReport, record: InFlightBatch): Promise<void> {
    try {
      // Stored as a copy: the live record keeps changing, and a store that holds values by
      // reference would otherwise show a future state of the batch.
      await storage.set(KEYS.batch, {
        ...record, pending: [...record.pending], done: record.done.map((d) => ({ ...d })),
      });
    } catch {
      // The record only protects this report's accuracy, not the tabs, so the owner's
      // action still proceeds; the report says the result may be lost to a crash.
      report.crashSafe = false;
    }
  }

  function historyRow(
    report: BatchReport, result: ExecutedResult, hostnames: Map<number, string | null>, at: number,
  ): HistoryEntry {
    const row: HistoryEntry = {
      at, operationId: report.operationId, trigger: report.trigger,
      // The requested id, which is what the owner's action referenced. Never the minted one.
      sessionTabId: result.tabId,
      hostname: hostnames.get(result.tabId) ?? null,
      outcome: result.outcome,
    };
    if (result.reason !== undefined) row.reason = result.reason;
    return row;
  }

  async function finish(
    report: BatchReport, record: InFlightBatch, hostnames: Map<number, string | null>,
  ): Promise<void> {
    const at = now();
    const entries = report.results.map((r) => historyRow(report, r, hostnames, at));
    // Marked complete BEFORE the history write and the clear. If the worker dies between
    // the two, reconciliation finds a completed record and writes nothing: a lost row is
    // acceptable (history is lossy by design), a duplicated row is not.
    record.completed = true;
    await writeRecord(report, record);
    try {
      await history.append(entries, at);
    } catch {
      // history.append swallows its own failures; this is belt and braces.
    }
    try {
      await storage.set(KEYS.batch, undefined);
    } catch {
      report.crashSafe = false;
    }
  }

  function parseDoneEntry(raw: unknown): InFlightBatch['done'][number] | null {
    if (!isPlainObject(raw)) return null;
    const tabId = own(raw, 'tabId');
    const outcome = own(raw, 'outcome');
    const reason = own(raw, 'reason');
    const newTabId = own(raw, 'newTabId');
    if (!isIndex(tabId) || !isOneOf(OUTCOMES, outcome)) return null;
    if (reason !== undefined && !isOneOf(REASON_CODES, reason)) return null;
    const entry: InFlightBatch['done'][number] = { tabId, outcome };
    if (reason !== undefined) entry.reason = reason;
    if (isIndex(newTabId)) entry.newTabId = newTabId;
    if (own(raw, 'historyWritten') === true) entry.historyWritten = true;
    return entry;
  }

  /** A record that cannot be parsed is reported as unreadable, never as nothing to do. */
  function parseInFlight(raw: unknown): { record: InFlightBatch; lossy: boolean } | null {
    if (!isPlainObject(raw)) return null;
    const operationId = own(raw, 'operationId');
    const trigger = own(raw, 'trigger');
    const mode = own(raw, 'mode');
    const startedAt = own(raw, 'startedAt');
    const pendingRaw = own(raw, 'pending');
    const doneRaw = own(raw, 'done');
    if (typeof operationId !== 'string' || operationId === '' || /[/?#\s]/.test(operationId)) return null;
    if (!isOneOf(TRIGGERS, trigger)) return null;
    if (!Array.isArray(pendingRaw) || !Array.isArray(doneRaw)) return null;

    const pending = pendingRaw.filter(isIndex);
    const done: InFlightBatch['done'] = [];
    for (const item of doneRaw) {
      const entry = parseDoneEntry(item);
      if (entry !== null) done.push(entry);
    }
    // Something was in the record that could not be read back: the report built from it is
    // incomplete, and says so rather than looking whole.
    const lossy = pending.length !== pendingRaw.length || done.length !== doneRaw.length;
    const record: InFlightBatch = {
      operationId, trigger,
      mode: isOneOf(MODES, mode) ? mode : 'manual-bulk',
      startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : 0,
      pending, done,
    };
    if (own(raw, 'completed') === true) record.completed = true;
    return { record, lossy };
  }

  function blockedReport(operationId: string, reason: BlockedReason): BatchReport {
    const report = emptyReport(operationId, 'external');
    report.blocked = reason;
    report.crashSafe = false;
    return report;
  }

  /**
   * A21. A record that survived a worker death becomes `unknown` results. It is never
   * replayed: the owner clicked once, and a replay would act twice. A result already
   * recorded before the crash is counted once and logged once.
   */
  async function runReconcile(at: number): Promise<BatchReport[]> {
    let raw: unknown;
    try {
      raw = await storage.get(KEYS.batch);
    } catch {
      // A failed read is not an empty store: say so instead of returning "nothing to do".
      return [blockedReport(nextOperationId(at), 'crash-record-unreadable')];
    }
    if (raw === undefined || raw === null) return [];

    const items = Array.isArray(raw) ? raw : [raw];
    const reports: BatchReport[] = [];
    const entries: HistoryEntry[] = [];
    const hostnames = new Map<number, string | null>(); // a crashed batch left no hostnames behind

    for (const item of items) {
      const parsed = parseInFlight(item);
      if (parsed === null) {
        reports.push(blockedReport(nextOperationId(at), 'crash-record-unreadable'));
        continue;
      }
      const { record, lossy } = parsed;
      // It had already logged its history and was only waiting to be cleared.
      if (record.completed === true) continue;

      const report = emptyReport(record.operationId, record.trigger);
      report.crashSafe = !lossy;
      for (const entry of record.done) {
        const { historyWritten, ...result } = entry;
        addResult(report, result);
        if (historyWritten !== true) entries.push(historyRow(report, result, hostnames, at));
      }
      for (const tabId of record.pending) {
        const result: ExecutedResult = { tabId, outcome: 'unknown' };
        addResult(report, result);
        entries.push(historyRow(report, result, hostnames, at));
      }
      reports.push(report);
    }

    try {
      await history.append(entries, at);
    } catch {
      // See finish().
    }
    try {
      await storage.set(KEYS.batch, undefined);
    } catch {
      for (const report of reports) report.crashSafe = false;
    }
    return reports;
  }

  // ---- the batch ----------------------------------------------------------------

  async function runExecute(
    scope: Scope, mode: EligibilityMode, trigger: Trigger, at: number,
  ): Promise<BatchReport> {
    const operationId = nextOperationId(at);
    const report = emptyReport(operationId, trigger);
    const hostnames = new Map<number, string | null>();
    let record: InFlightBatch | null = null;

    try {
      let snapshot = await captureSafe(at);
      if (snapshot === null) {
        report.blocked = 'tabs-unavailable';
        return report;
      }
      const blocked = blockedFor(mode, snapshot, scope, 'execute');
      if (blocked !== null) {
        report.blocked = blocked;
        return report;
      }
      for (const row of snapshot.rows) hostnames.set(row.tabId, row.hostname);

      const plan = planCandidates(scope, mode, snapshot);
      // Nothing to do: no record, no request, no history.
      if (plan.length === 0) return report;

      record = { operationId, trigger, mode, startedAt: now(), pending: [...plan], done: [] };
      await writeRecord(report, record);

      const chunkSize = mode === 'auto' ? AUTO_BATCH_MAX : MANUAL_CHUNK_SIZE;
      outer: for (let start = 0; start < plan.length; start += chunkSize) {
        if (start > 0) {
          // Rule 4: revalidate the batch's context between chunks, not just each tab.
          const next = await captureSafe(now());
          if (next === null) {
            report.blocked = 'tabs-unavailable';
            break;
          }
          const stillBlocked = blockedFor(mode, next, scope, 'execute');
          if (stillBlocked !== null) {
            report.blocked = stillBlocked;
            break;
          }
          snapshot = next;
          for (const row of snapshot.rows) if (!hostnames.has(row.tabId)) hostnames.set(row.tabId, row.hostname);
        }
        const ctx = contextOf(snapshot);
        for (const tabId of plan.slice(start, start + chunkSize)) {
          // Checked between tabs and between chunks; a request already issued is allowed
          // to finish, because cancelling it would not give the tab back.
          if (cancelledOps.has(operationId)) {
            report.cancelled = true;
            break outer;
          }
          const step = await runOne(tabId, mode, trigger, ctx, hostnames);
          if (step.kind === 'automation-off') {
            report.cancelled = true;
            report.blocked = 'automation-off';
            break outer;
          }
          record.pending = record.pending.filter((id) => id !== tabId);
          record.done.push({ ...step.result, historyWritten: false });
          addResult(report, step.result);
          await writeRecord(report, record);
        }
      }
      return report;
    } catch {
      // The report is the contract: nothing rejects out of execute.
      if (report.blocked === null) report.blocked = 'internal-error';
      report.crashSafe = false;
      return report;
    } finally {
      cancelledOps.delete(operationId);
      if (record !== null) await finish(report, record, hostnames);
    }
  }

  return {
    preview(scope, mode, at) {
      // Reads only, so it does not queue behind a batch; it issues no request of any kind.
      return preview(scope, mode, at);
    },
    execute(scope, mode, trigger, at) {
      return serial(() => runExecute(scope, mode, trigger, at));
    },
    cancel(operationId) {
      cancelledOps.add(operationId);
    },
    reconcileUnfinished(at) {
      return serial(() => runReconcile(at));
    },
  };
}
