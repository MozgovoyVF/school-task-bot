import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { getState, setState } from '../domain/system/appState.js';
import type { Job } from './ticker.js';

const DailyStateSchema = z.object({ lastRunDate: z.string() });

/** `now`'s UTC calendar date as `YYYY-MM-DD`. */
function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whether `"HH:MM"` (UTC) has already passed on `now`'s UTC calendar day. */
function timeHasPassed(now: Date, atUtc: string): boolean {
  const [hoursRaw, minutesRaw] = atUtc.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  const scheduled = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0, 0);
  return now.getTime() >= scheduled;
}

/**
 * Builds a {@link Job} that runs `run` at most once per UTC calendar day, and
 * only once `atUtc` ("HH:MM", UTC) has passed for that day. The last
 * successful run date is tracked in `app_state` under `daily:<name>`, so a
 * failing `run` (which throws, same as any other job) is not marked done and
 * is retried on the next tick — matching the project's recall-first bias
 * (CLAUDE.md §1: a missed job is worse than a late one).
 */
export function dailyJob(name: string, atUtc: string, run: (deps: AppDeps) => Promise<void>): Job {
  const stateKey = `daily:${name}`;
  return {
    name,
    async run(deps: AppDeps) {
      const now = deps.clock.now();
      if (!timeHasPassed(now, atUtc)) return;

      const today = utcDateKey(now);
      const state = await getState(deps.db, stateKey, DailyStateSchema);
      if (state?.lastRunDate === today) return;

      await run(deps);
      await setState(deps.db, stateKey, { lastRunDate: today }, now);
    },
  };
}
