import { desc } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { errorReports } from '../../db/schema/index.js';
import { errorSampleSchema } from '../../ops/errorReporter.js';

export interface RecentErrorRow {
  fingerprint: string;
  /** Repeats tallied since the last Telegram notification for this fingerprint (`src/ops/errorReporter.ts`'s own counter) — not a lifetime total. */
  count: number;
  lastAt: Date;
  name: string;
  message: string;
}

/**
 * Rows fetched per `limit` requested before the null-sample filter below (fix-round-1 review
 * finding #2): must comfortably cover the mix of `sample`-bearing error-report rows and
 * `sample: null` alert-only rows (`ticker_gap`, `privacy_mode`, `cards:owner-blocked`, LLM
 * failures, daily-budget-paused, ...) that can sit among the most-recently-updated rows, so a
 * burst of alerts right before the window can't push every real error out of consideration.
 */
const FETCH_WINDOW = 50;

/**
 * The `limit` most recently-seen distinct errors (SPEC §12.2's `/admin` row's last-errors column),
 * newest `lastAt` first. `sample` is jsonb and goes through `errorSampleSchema` to parse (CLAUDE.md
 * §8: every jsonb read goes through zod); a row whose `sample` fails that (old/malformed data, or a
 * plain `errors.alert(...)` row which always writes `sample: null`) is skipped rather than throwing,
 * so one bad row never breaks the whole panel.
 *
 * The null-sample filter is applied AFTER fetching a generous window (`FETCH_WINDOW`), not after a
 * DB-side `.limit(limit)`: `errors.alert(...)` rows always have `sample: null`, so limiting at the
 * DB first and filtering after could silently drop every real error below a run of recent alert
 * rows, making `/admin` wrongly report "no errors" (fix-round-1 review finding #2).
 */
export async function listRecentErrors(db: DbOrTx, limit: number): Promise<RecentErrorRow[]> {
  const rows = await db
    .select()
    .from(errorReports)
    .orderBy(desc(errorReports.lastAt))
    .limit(Math.max(limit, FETCH_WINDOW));

  const result: RecentErrorRow[] = [];
  for (const row of rows) {
    if (result.length >= limit) break;
    const parsed = errorSampleSchema.safeParse(row.sample);
    if (!parsed.success) continue;
    result.push({
      fingerprint: row.fingerprint,
      count: row.count,
      lastAt: row.lastAt,
      name: parsed.data.name,
      message: parsed.data.message,
    });
  }
  return result;
}
