import type { Db } from '../db/client.js';
import type { Clock } from '../time/clock.js';
import type { Logger } from '../ops/logger.js';
import type { ErrorReporter } from '../ops/errorReporter.js';
import { setState } from '../domain/system/appState.js';
import { TICK_INTERVAL_MS } from '../config/constants.js';

const HEARTBEAT_KEY = 'ticker:heartbeat';

/**
 * The subset of the eventual `AppDeps` (Task 0.8, `src/deps.ts`) that the
 * ticker/job/health-endpoint code actually needs. `AppDeps` is not built yet
 * (this task runs before 0.8), so `Job`/`createTicker` are typed against this
 * narrower shape for now — see the Task 0.6 report for how 0.8 should
 * reconcile it with the real `AppDeps`.
 */
export interface TickerDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  errors: ErrorReporter;
}

export interface Job {
  name: string;
  run(deps: TickerDeps): Promise<void>;
}

export interface Ticker {
  start(): void;
  stop(): Promise<void>;
  tickOnce(): Promise<void>;
  lastHeartbeat(): Date | null;
}

/**
 * Runs `jobs` in array order once (`tickOnce`), or on a repeating loop
 * (`start`/`stop`). A failing job is reported via `deps.errors.report` and
 * does not stop the remaining jobs. The loop is implemented with `setTimeout`
 * chaining rather than `setInterval`: the next tick is only scheduled once
 * the current one has fully finished, so ticks never overlap.
 */
export function createTicker(deps: TickerDeps, jobs: Job[], opts?: { intervalMs?: number }): Ticker {
  const intervalMs = opts?.intervalMs ?? TICK_INTERVAL_MS;

  let heartbeat: Date | null = null;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentTick: Promise<void> | null = null;

  async function tickOnce(): Promise<void> {
    for (const job of jobs) {
      try {
        await job.run(deps);
      } catch (err) {
        await deps.errors.report(err, { job: job.name });
      }
    }
    const now = deps.clock.now();
    heartbeat = now;
    await setState(deps.db, HEARTBEAT_KEY, { at: now.toISOString() }, now);
  }

  function scheduleNext(): void {
    if (!running) return;
    timer = setTimeout(runLoopTick, intervalMs);
  }

  function runLoopTick(): void {
    currentTick = tickOnce()
      .catch((err: unknown) => deps.errors.report(err, { ticker: 'loop' }))
      .finally(() => {
        currentTick = null;
        scheduleNext();
      });
  }

  return {
    start() {
      if (running) return;
      running = true;
      runLoopTick();
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (currentTick) await currentTick;
    },
    tickOnce,
    lastHeartbeat: () => heartbeat,
  };
}
