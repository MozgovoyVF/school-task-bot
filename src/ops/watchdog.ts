import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { Clock } from '../time/clock.js';
import { getState } from '../domain/system/appState.js';
import { HEARTBEAT_KEY } from '../scheduler/ticker.js';
import { TICKER_GAP_ALERT_MS } from '../config/constants.js';
import { texts } from '../bot/texts/ru.js';
import type { Logger } from './logger.js';
import type { ErrorReporter } from './errorReporter.js';

export interface WatchdogDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  errors: ErrorReporter;
}

/** Shape `src/scheduler/ticker.ts`'s `tickOnce()` writes to `app_state[HEARTBEAT_KEY]` on every tick. */
const heartbeatSchema = z.object({ at: z.string() });

/**
 * Checks `app_state['ticker:heartbeat']` once at startup (SPEC §18's "ticker downtime over 2 minutes
 * is checked at next startup or by a watchdog" rule). Called from `src/app.ts` right after
 * `checkPrivacyMode`/`syncCommands` and — critically — *before* `createTicker`/`ticker.tickOnce()`:
 * that first tick immediately overwrites this same key with the current time, so running this any
 * later would always see a fresh heartbeat and never fire.
 *
 * A missing row (fresh install, the ticker has never ticked before) is not an issue and sends
 * nothing — there is no "previous run" to have gone stale. Otherwise, if the stored heartbeat is
 * more than `TICKER_GAP_ALERT_MS` (2 min) old relative to `deps.clock.now()`, the ticker loop was not
 * running for at least that long before this restart (crash, OOM, deploy downtime, ...): every
 * superadmin is alerted via `errors.alert('ticker_gap', ...)` (throttled hourly by default, same as
 * every other `errors.alert` call) with the observed downtime.
 */
export async function checkTickerGapOnStart(deps: WatchdogDeps): Promise<void> {
  const state = await getState(deps.db, HEARTBEAT_KEY, heartbeatSchema);
  if (!state) return;

  const lastHeartbeatAt = new Date(state.at);
  const gapMs = deps.clock.now().getTime() - lastHeartbeatAt.getTime();
  if (gapMs <= TICKER_GAP_ALERT_MS) return;

  deps.logger.warn({ gapMs }, 'ticker heartbeat was stale at startup — ticker was not running');
  await deps.errors.alert('ticker_gap', texts.errors.tickerGap(gapMs));
}
