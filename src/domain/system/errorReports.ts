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
 * The `limit` most recently-seen distinct errors (SPEC §12.2's `/admin` row's last-errors column),
 * newest `lastAt` first. `sample` is jsonb and goes through `errorSampleSchema` to parse (CLAUDE.md
 * §8: every jsonb read goes through zod); a row whose `sample` fails that (old/malformed data, or a
 * plain `errors.alert(...)` row which always writes `sample: null`) is skipped rather than throwing,
 * so one bad row never breaks the whole panel.
 */
export async function listRecentErrors(db: DbOrTx, limit: number): Promise<RecentErrorRow[]> {
  const rows = await db.select().from(errorReports).orderBy(desc(errorReports.lastAt)).limit(limit);

  const result: RecentErrorRow[] = [];
  for (const row of rows) {
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
