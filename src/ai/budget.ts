import { and, gte, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../db/client.js';
import { analysisBatches } from '../db/schema/index.js';

/**
 * Sums `analysis_batches.cost_usd` for every batch (any `kind` — SPEC
 * §9.2/D5: manual and `/reanalyze` calls count toward the cap too, not only
 * `auto` batches) that *finished* — reached `done` or `failed`, so
 * `finished_at` is set — within `now`'s local calendar day in `tz`.
 *
 * `finished_at`, not `created_at`, is the day boundary: `created_at` is set
 * once, at enqueue time, while `cost_usd`/`input_tokens`/`output_tokens`
 * keep accumulating across every retry attempt up to the batch's terminal
 * state (`markDone`/`markFailedOrRetry` in `scheduler/jobs/analyze.ts`) — so
 * counting by creation day would attribute a backlog batch's (or a retried
 * batch's) full, final cost to whatever day it happened to be *first*
 * enqueued, even if most of its spend happened, or its outcome was only
 * decided, on a later day. A batch still `queued`/`running` (`finished_at`
 * IS NULL) does not match either bound and so simply contributes 0 until it
 * reaches a terminal state — at which point its *entire* accumulated cost
 * (every attempt, success or failure) is counted once, on the day it
 * finished.
 */
export async function spentTodayUsd(db: DbOrTx, args: { now: Date; tz: string }): Promise<number> {
  const zoned = DateTime.fromJSDate(args.now).setZone(args.tz);
  const start = zoned.startOf('day').toJSDate();
  const end = zoned.plus({ days: 1 }).startOf('day').toJSDate();

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${analysisBatches.costUsd}), 0)` })
    .from(analysisBatches)
    .where(and(gte(analysisBatches.finishedAt, start), lt(analysisBatches.finishedAt, end)));

  return Number(row?.total ?? 0);
}
