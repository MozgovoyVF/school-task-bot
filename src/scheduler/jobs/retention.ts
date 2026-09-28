import { runRetention } from '../../domain/chats/retention.js';
import { dailyJob } from '../daily.js';
import type { Job } from '../ticker.js';

/**
 * Daily storage-retention cleanup (SPEC.md line ~647, plan.md Task 1.12):
 * runs {@link runRetention} once per UTC calendar day, no earlier than
 * 03:30 UTC — see `dailyJob` for the once-a-day guard (`app_state` key
 * `daily:retention`), which is what keeps a second same-day tick from
 * re-running the cleanup.
 */
export const retentionJob: Job = dailyJob('retention', '03:30', async (deps) => {
  const result = await runRetention(deps.db, { now: deps.clock.now() });
  deps.logger.info(result, 'retentionJob: cleanup finished');
});
