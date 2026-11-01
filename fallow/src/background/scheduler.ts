// Owns the one alarm and the decision to run an automatic batch. It never acts on a tab:
// every action goes through executor.execute, and the only adapter calls made here are the
// three alarm operations.
import type { ChromeAdapter } from '../platform/chrome-adapter';
import type { SessionRepo, SessionState, SettingsRepo } from '../platform/storage';
import type { BatchReport, Executor } from './executor';
import type { Inventory } from './inventory';
import type { Settings } from '../domain/types';
import { ALARM_NAME, ALARM_PERIOD_MINUTES, STARTUP_GRACE_MS } from '../domain/constants';

export interface Scheduler {
  syncAlarm(settings: Settings): Promise<void>;
  onAlarm(name: string, now: number): Promise<BatchReport | null>;
  beginGrace(now: number, reason: 'startup' | 'automation-on' | 'threshold-shortened'): Promise<void>;
  pendingEligibleCount(now: number): Promise<number>;
}

export function createScheduler(deps: {
  adapter: ChromeAdapter; executor: Executor; settings: SettingsRepo;
  session: SessionRepo; inventory: Inventory;
}): Scheduler {
  const { adapter, executor, settings, session, inventory } = deps;

  let running: Promise<BatchReport | null> | null = null;

  async function runAlarm(now: number): Promise<BatchReport | null> {
    // A clock that is not a number says nothing about whether the grace has ended, and
    // `now < graceUntil` is false for NaN, so it would read as "grace over". Hold.
    if (!Number.isFinite(now)) return null;
    // Both reads propagate failure. An unreadable record is never read as an empty one:
    // defaults would stand in for the owner's choice, and a missing grace would let the
    // wake-from-sleep cascade the grace exists to stop. Either way the run holds.
    let cfg: Settings;
    let state: SessionState | null;
    try {
      cfg = await settings.read();
      if (!cfg.automationEnabled) return null;
      state = await session.read();
    } catch {
      return null;
    }
    if (state !== null && state.graceUntil !== null && now < state.graceUntil) {
      // A grace never lies further ahead than its own length, so one that does was
      // recorded against a clock that has since moved back. Left alone, automation would
      // stay off until the old time came round again. Re-base it on the corrected clock
      // (still a full grace, never shorter) and hold; if the write fails the stored
      // value is merely too cautious, so the hold stands either way.
      if (state.graceUntil - now > STARTUP_GRACE_MS) {
        try {
          await session.write({ discoveredAt: state.discoveredAt, graceUntil: now + STARTUP_GRACE_MS });
        } catch {
          // Held regardless.
        }
      }
      return null;
    }
    return executor.execute({ kind: 'all' }, 'auto', 'automatic', now);
  }

  return {
    async syncAlarm(next) {
      // Promise<void> cannot carry a Result, so a failed alarm operation REJECTS. Resolving
      // would report an armed scheduler that has no alarm (or a disarmed one that still
      // has one), and nothing downstream could tell. The caller must catch it.
      if (next.automationEnabled) {
        const existing = await adapter.getAlarm(ALARM_NAME);
        // Present: nothing to do, which is what keeps repeated initialisation to one alarm.
        if (existing.ok && existing.value) return;
        // Absent, or the check itself failed. A failed check is NOT read as "absent" for
        // any other purpose, but creating is still safe: alarms.create under an existing
        // name replaces that alarm, so a blind create cannot produce a second one. The
        // cost is a restarted period, at most one minute of delay. Skipping instead would
        // risk no alarm at all, i.e. automation silently never running.
        const created = await adapter.createAlarm(ALARM_NAME, ALARM_PERIOD_MINUTES);
        if (!created.ok) throw new Error(`Could not create the ${ALARM_NAME} alarm: ${created.error.message}`);
      } else {
        const cleared = await adapter.clearAlarm(ALARM_NAME);
        if (!cleared.ok) throw new Error(`Could not clear the ${ALARM_NAME} alarm: ${cleared.error.message}`);
      }
    },
    onAlarm(name, now) {
      if (name !== ALARM_NAME) return Promise.resolve(null);
      // One automatic batch at a time. Without this a second alarm event (a wake storm)
      // would queue a second full batch behind the first and the owner would lose twice
      // AUTO_BATCH_MAX tabs from one tick. The second caller gets the batch already in
      // flight rather than a second batch, or a null that would read as "nothing ran".
      // This flag is the only state held here and it dies with the worker.
      if (running !== null) return running;
      const run = runAlarm(now).finally(() => { running = null; });
      running = run;
      return run;
    },
    async beginGrace(now) {
      const existing = await session.read();
      await session.write({
        discoveredAt: existing?.discoveredAt ?? now,
        graceUntil: now + STARTUP_GRACE_MS,
      });
    },
    async pendingEligibleCount(now) {
      // Rejects rather than answer 0: a count that could not be measured is not "nothing
      // pending", and the Global Constraints forbid rendering an unavailable measurement as 0.
      if (!Number.isFinite(now)) throw new RangeError('pendingEligibleCount needs a finite clock');
      const snapshot = await inventory.capture(now);
      if (!snapshot.tabsAvailable) throw new Error('Could not read the tab list, so the pending count is unavailable.');
      // Each of these makes the per-tab decisions wrong in a direction that moves the count:
      // no activity holds every tab (a false 0), and default settings drop the owner's added
      // protected sites (a false high). Other failed reads do not change the decisions.
      const unreliable = snapshot.failedReads.filter((r) => r === 'activity' || r === 'settings');
      if (unreliable.length > 0) throw new Error(`Could not read ${unreliable.join(' and ')}, so the pending count is unavailable.`);
      // With automation off nothing will be unloaded, which is a measurement, not a gap.
      if (!snapshot.settings.automationEnabled) return 0;
      // Pending = would be unloaded the moment the grace ends: eligible now, or held by the
      // grace alone.
      return snapshot.rows.filter((r) =>
        r.decision.eligible || (r.decision.reasons.length === 1 && r.decision.reasons[0] === 'STARTUP_GRACE'),
      ).length;
    },
  };
}
