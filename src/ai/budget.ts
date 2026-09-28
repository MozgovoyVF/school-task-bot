import { and, gte, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { analysisBatches } from '../db/schema/index.js';

/**
 * Sums `analysis_batches.cost_usd` for every batch (any `status`/`kind` —
 * SPEC §9.2/D5: manual and `/reanalyze` calls count toward the cap too, not
 * only `auto` batches) created within `now`'s local calendar day in `tz`.
 * `cost_usd` is written once a batch finishes (success *or* failure —
 * `LlmExtractionProvider`'s `ExtractionError` carries the summed usage of
 * every attempt, since failed attempts still spend tokens), so a batch still
 * `queued`/`running` simply contributes 0 so far. `created_at` — not
 * `finished_at` — is the day boundary: a batch is attributed to the day it
 * was first enqueued, which also keeps a batch that happens to straddle
 * midnight during backoff retries (max 5 attempts × ≤15 min apart, so this
 * is only ever a few minutes in practice) counted once, on one day, instead
 * of splitting its cost.
 */
export async function spentTodayUsd(db: DbOrTx, args: { now: Date; tz: string }): Promise<number> {
  const zoned = DateTime.fromJSDate(args.now).setZone(args.tz);
  const start = zoned.startOf('day').toJSDate();
  const end = zoned.plus({ days: 1 }).startOf('day').toJSDate();

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${analysisBatches.costUsd}), 0)` })
    .from(analysisBatches)
    .where(and(gte(analysisBatches.createdAt, start), lt(analysisBatches.createdAt, end)));

  return Number(row?.total ?? 0);
}
