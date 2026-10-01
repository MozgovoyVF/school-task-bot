import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../../db/client.js';
import { analysisBatches, chats, proposals } from '../../db/schema/index.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface AiLast7Stats {
  shown: number;
  suppressed: number;
  accepted: number;
  rejected: number;
}

export interface AiStats {
  costToday: number;
  costMonth: number;
  last7: AiLast7Stats;
  /** `accepted / (accepted + rejected)` over the same 7-day window as {@link AiStats.last7}; `null` when that denominator is zero (SPEC §11.2's "no data yet" case, not a bug). */
  precision: number | null;
  /** Every chat with at least one still-`pending` proposal (SPEC §12.2's `/admin` "queue" line), most-pending-first. A DM-only draft (`chatId === null`) never appears here — it has no chat to group under. */
  pendingByChat: Array<{ chatId: number; title: string; count: number }>;
}

/** Sums `analysis_batches.cost_usd` for every batch that *finished* (`finished_at` set) within `[start, end)` — mirrors `src/ai/budget.ts`'s `spentTodayUsd`, kept local rather than imported/generalized since that module's own single-purpose "today" query isn't in this task's file list to touch. */
async function sumCostBetween(db: DbOrTx, start: Date, end: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${analysisBatches.costUsd}), 0)` })
    .from(analysisBatches)
    .where(and(gte(analysisBatches.finishedAt, start), lt(analysisBatches.finishedAt, end)));
  return Number(row?.total ?? 0);
}

/**
 * `/admin`'s AI-pipeline summary (plan.md Task 2.15): today's and this calendar month's LLM spend (`tz`-
 * local, same day/month-boundary convention as `spentTodayUsd`), the last 7 days' shown/suppressed
 * (`proposals.policy_decision`) and accepted/rejected (`proposals.status`) counts — both counted by
 * `created_at` falling in the trailing 7-day window from `now`, not by when they were later decided — the
 * resulting precision ratio, and every chat still holding at least one `pending` proposal (both `shown`
 * and `suppressed` — the same "everything, not just what was shown" stance `/inbox` takes, so a chat stuck
 * entirely below the auto-show threshold still surfaces here). No `workspaceId` parameter: MVP has exactly
 * one workspace (SPEC §5.2), and `analysis_batches` itself has no `workspace_id` column to filter by
 * (mirrors `spentTodayUsd`'s own signature).
 */
export async function aiStats(db: DbOrTx, args: { now: Date; tz: string }): Promise<AiStats> {
  const zoned = DateTime.fromJSDate(args.now).setZone(args.tz);
  const dayStart = zoned.startOf('day').toJSDate();
  const dayEnd = zoned.plus({ days: 1 }).startOf('day').toJSDate();
  const monthStart = zoned.startOf('month').toJSDate();
  const monthEnd = zoned.plus({ months: 1 }).startOf('month').toJSDate();

  const [costToday, costMonth] = await Promise.all([
    sumCostBetween(db, dayStart, dayEnd),
    sumCostBetween(db, monthStart, monthEnd),
  ]);

  const cutoff7 = new Date(args.now.getTime() - SEVEN_DAYS_MS);
  const [counts] = await db
    .select({
      shown: sql<number>`count(*) filter (where ${proposals.policyDecision} = 'shown')::int`,
      suppressed: sql<number>`count(*) filter (where ${proposals.policyDecision} = 'suppressed')::int`,
      accepted: sql<number>`count(*) filter (where ${proposals.status} = 'accepted')::int`,
      rejected: sql<number>`count(*) filter (where ${proposals.status} = 'rejected')::int`,
    })
    .from(proposals)
    .where(gte(proposals.createdAt, cutoff7));

  const last7: AiLast7Stats = {
    shown: counts?.shown ?? 0,
    suppressed: counts?.suppressed ?? 0,
    accepted: counts?.accepted ?? 0,
    rejected: counts?.rejected ?? 0,
  };
  const decided = last7.accepted + last7.rejected;
  const precision = decided > 0 ? last7.accepted / decided : null;

  const pendingRows = await db
    .select({ chatId: proposals.chatId, title: chats.title, count: sql<number>`count(*)::int` })
    .from(proposals)
    .innerJoin(chats, eq(proposals.chatId, chats.id))
    .where(eq(proposals.status, 'pending'))
    .groupBy(proposals.chatId, chats.title)
    .orderBy(sql`count(*) desc`);

  const pendingByChat = pendingRows
    .filter((r): r is { chatId: number; title: string | null; count: number } => r.chatId !== null)
    .map((r) => ({ chatId: r.chatId, title: r.title ?? '', count: r.count }));

  return { costToday, costMonth, last7, precision, pendingByChat };
}

export interface BatchDebugRow {
  id: number;
  chatId: number | null;
  chatTitle: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  messageCount: number;
  status: (typeof analysisBatches.$inferSelect)['status'];
  model: string | null;
  costUsd: number;
  error: string | null;
  shown: number;
  suppressed: number;
  /** `proposals.policy_reason` breakdown, `suppressed` proposals only (SPEC §9.6: the reason a `shown` proposal cleared the bar is never interesting the way a suppression's is) — order not significant, `/debug`'s view joins them itself. */
  suppressedReasons: Array<{ reason: string; count: number }>;
}

/**
 * `/debug [chat]`'s data (plan.md Task 2.15, SPEC §12.2's row): the most recent `args.limit` batches
 * (optionally restricted to one `args.chatId`), each with its own shown/suppressed proposal counts and a
 * `policy_reason` breakdown of its suppressed ones. Two queries, not a single join with per-row grouping —
 * a batch with zero proposals (e.g. still `queued`, or prefilter-skipped) must still appear with
 * `shown: 0, suppressed: 0`, which a plain `LEFT JOIN … GROUP BY` on the batch row already gives for free,
 * but the *reason* breakdown genuinely needs its own grouped query over just the proposals that exist.
 */
export async function listRecentBatches(
  db: DbOrTx,
  args: { limit: number; chatId?: number },
): Promise<BatchDebugRow[]> {
  const where = args.chatId !== undefined ? eq(analysisBatches.chatId, args.chatId) : undefined;

  const batchRows = await db
    .select({ batch: analysisBatches, chatTitle: chats.title })
    .from(analysisBatches)
    .leftJoin(chats, eq(analysisBatches.chatId, chats.id))
    .where(where)
    .orderBy(desc(analysisBatches.createdAt), desc(analysisBatches.id))
    .limit(args.limit);
  if (batchRows.length === 0) return [];

  const batchIds = batchRows.map((r) => r.batch.id);
  const proposalCounts = await db
    .select({
      batchId: proposals.batchId,
      policyDecision: proposals.policyDecision,
      policyReason: proposals.policyReason,
      count: sql<number>`count(*)::int`,
    })
    .from(proposals)
    .where(inArray(proposals.batchId, batchIds))
    .groupBy(proposals.batchId, proposals.policyDecision, proposals.policyReason);

  const countsByBatch = new Map<number, typeof proposalCounts>();
  for (const row of proposalCounts) {
    if (row.batchId === null) continue;
    const list = countsByBatch.get(row.batchId);
    if (list) list.push(row);
    else countsByBatch.set(row.batchId, [row]);
  }

  return batchRows.map(({ batch, chatTitle }) => {
    const rows = countsByBatch.get(batch.id) ?? [];
    let shown = 0;
    let suppressed = 0;
    const suppressedReasons: Array<{ reason: string; count: number }> = [];
    for (const row of rows) {
      if (row.policyDecision === 'shown') {
        shown += row.count;
      } else {
        suppressed += row.count;
        suppressedReasons.push({ reason: row.policyReason ?? 'unknown', count: row.count });
      }
    }
    return {
      id: batch.id,
      chatId: batch.chatId,
      chatTitle: chatTitle ?? null,
      createdAt: batch.createdAt,
      finishedAt: batch.finishedAt,
      messageCount: batch.messageCount,
      status: batch.status,
      model: batch.model,
      costUsd: Number(batch.costUsd ?? 0),
      error: batch.error,
      shown,
      suppressed,
      suppressedReasons,
    };
  });
}
