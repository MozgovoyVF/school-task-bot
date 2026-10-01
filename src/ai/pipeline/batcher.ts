import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { BATCH_BACKOFF_MINUTES, BATCH_MAX_ATTEMPTS, STALE_RUNNING_BATCH_MS } from '../../config/constants.js';
import type { Db } from '../../db/client.js';
import { analysisBatches, chats, messages } from '../../db/schema/index.js';
import { getSettings } from '../../domain/workspaces/repo.js';
import type { Settings } from '../../domain/settings/schema.js';

export type BatchRow = typeof analysisBatches.$inferSelect;

/** SPEC §8's three "put a batch" conditions, summarized per chat over its unbatched `pending` messages. */
export interface PendingStats {
  pendingCount: number;
  lastMessageAt: Date;
  oldestPendingAt: Date;
}

/**
 * SPEC §8: a chat gets a batch once any of quiet-period, size, or max-wait
 * is met. `pendingCount === 0` is always `false` — there is nothing to
 * batch (also guards the two duration checks below against a stale/bogus
 * `PendingStats` for an empty chat).
 */
export function shouldEnqueue(s: PendingStats, cfg: Settings['batch'], now: Date): boolean {
  if (s.pendingCount === 0) return false;
  if (s.pendingCount >= cfg.maxMessages) return true;
  const sinceLastMessageMs = now.getTime() - s.lastMessageAt.getTime();
  if (sinceLastMessageMs >= cfg.quietSeconds * 1000) return true;
  const oldestWaitMs = now.getTime() - s.oldestPendingAt.getTime();
  if (oldestWaitMs >= cfg.maxWaitSeconds * 1000) return true;
  return false;
}

/**
 * SPEC §8's backoff (1, 5, 15 minutes, capped at `BATCH_MAX_ATTEMPTS` = 5
 * attempts total): `failedAttempts` is the batch's `attempts` counter
 * *after* the failure that just happened. Returns `null` once that counter
 * reaches `BATCH_MAX_ATTEMPTS` — the caller's cue to mark the batch
 * `failed` instead of rescheduling it.
 */
export function nextAttemptAt(failedAttempts: number, now: Date): Date | null {
  if (failedAttempts >= BATCH_MAX_ATTEMPTS) return null;
  const lastIndex = BATCH_BACKOFF_MINUTES.length - 1;
  const index = Math.min(Math.max(failedAttempts - 1, 0), lastIndex);
  const minutes = BATCH_BACKOFF_MINUTES[index] ?? BATCH_BACKOFF_MINUTES[lastIndex] ?? 15;
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * SPEC §8 / plan.md Task 2.9: for every chat with `pending`, not-yet-batched
 * messages and no already-open (`queued`/`running`) batch, checks
 * {@link shouldEnqueue} against that chat's workspace `batch.*` settings
 * and, if it fires, creates one `queued`/`auto` batch holding up to
 * `batch.maxMessages` of that chat's oldest pending messages (their
 * `messages.batch_id` is set to the new batch's id, in the same
 * transaction as the batch insert). Returns the ids of every batch created
 * this call, in chat order.
 *
 * A message that is still `pending` and unbatched when this function
 * *returns* was either not old/numerous enough yet, or arrived after this
 * chat's message selection had already run (e.g. mid-transaction, in
 * another chat's iteration) — either way it is simply left for the next
 * call to pick up: never silently dropped, never forced into a batch that
 * has already been sized/selected.
 */
export async function enqueueBatches(db: Db, args: { now: Date }): Promise<number[]> {
  const pendingByChat = await db
    .select({
      chatId: messages.chatId,
      pendingCount: sql<number>`count(*)::int`,
      // postgres.js hands timestamps back as strings when read through a raw
      // `sql` template (no column-level type info to parse against) — the
      // `sql<string>` hint says so honestly; `sql<Date>` would be a
      // compile-time-only lie, since nothing casts the runtime value.
      lastMessageAt: sql<string>`max(${messages.sentAt})`,
      oldestPendingAt: sql<string>`min(${messages.sentAt})`,
    })
    .from(messages)
    .where(and(eq(messages.analysisStatus, 'pending'), isNull(messages.batchId)))
    .groupBy(messages.chatId);

  if (pendingByChat.length === 0) return [];

  const openBatches = await db
    .select({ chatId: analysisBatches.chatId })
    .from(analysisBatches)
    .where(inArray(analysisBatches.status, ['queued', 'running']));
  const openChatIds = new Set(openBatches.map((r) => r.chatId).filter((id): id is number => id !== null));

  const created: number[] = [];
  for (const row of pendingByChat) {
    if (openChatIds.has(row.chatId)) continue;

    const stats: PendingStats = {
      pendingCount: row.pendingCount,
      lastMessageAt: new Date(row.lastMessageAt),
      oldestPendingAt: new Date(row.oldestPendingAt),
    };

    const batchId = await enqueueOneChat(db, row.chatId, stats, args.now);
    if (batchId !== null) created.push(batchId);
  }
  return created;
}

async function enqueueOneChat(
  db: Db,
  chatId: number,
  stats: PendingStats,
  now: Date,
): Promise<number | null> {
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat || chat.workspaceId === null) return null;

  const settings = await getSettings(db, chat.workspaceId);
  if (!shouldEnqueue(stats, settings.batch, now)) return null;

  return db.transaction(async (tx) => {
    const picked = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(eq(messages.chatId, chatId), eq(messages.analysisStatus, 'pending'), isNull(messages.batchId)),
      )
      .orderBy(asc(messages.sentAt))
      .limit(settings.batch.maxMessages);
    if (picked.length === 0) return null;

    const ids = picked.map((m) => m.id);
    const [batch] = await tx
      .insert(analysisBatches)
      .values({
        chatId,
        status: 'queued',
        kind: 'auto',
        firstMessageId: ids[0],
        lastMessageId: ids[ids.length - 1],
        messageCount: ids.length,
        // CLAUDE.md: business-logic "now" comes only from the injected
        // clock, never SQL `now()` — without this, `createdAt` would fall
        // back to the column's `defaultNow()` and diverge from the caller's
        // clock (fixed under tests, and generally a hair behind SQL `now()`
        // in production too).
        createdAt: now,
      })
      .returning();
    if (!batch) throw new Error('enqueueBatches: insert into analysis_batches returned no row');

    // `AND batch_id IS NULL` is a belt-and-braces guard, not load-bearing:
    // `ids` was just selected under this same transaction with that same
    // filter, so it should already be true — but a message never being
    // silently reassigned away from whatever batch it is already in is
    // worth the extra clause.
    await tx
      .update(messages)
      .set({ batchId: batch.id })
      .where(and(inArray(messages.id, ids), isNull(messages.batchId)));
    return batch.id;
  });
}

/**
 * `SELECT … FOR UPDATE SKIP LOCKED` (SPEC §8): atomically picks the oldest
 * `queued` batch whose backoff has elapsed (`next_attempt_at` is `null` or
 * `<= now`) and flips it to `running`, skipping any row another connection
 * already has locked (so two callers racing this never claim the same
 * batch). While `running`, `next_attempt_at` is repurposed from "backoff
 * deadline" to "stale-claim deadline": it is set to `now +
 * STALE_RUNNING_BATCH_MS`, which is what {@link recoverStaleBatches} later
 * compares against to reclaim a batch whose worker died mid-processing.
 * Orders by `createdAt` then `id` — `createdAt` is now set from the
 * injected clock (see `enqueueOneChat`), so a single `enqueueBatches` call
 * can create several batches with the exact same timestamp; `id` breaks
 * that tie deterministically instead of leaving Postgres to pick an
 * arbitrary row order. Returns `null` when nothing is claimable right now.
 *
 * `args.kinds`, when given, restricts the claim to those `batch_kind`
 * values — used by `analyzeJob` (SPEC.md:260, review round M2) to keep
 * claiming manual batches (`/reanalyze`'s `kind='reanalyze'`,
 * `parseDateText`'s `kind='manual'`) while the daily budget is paused,
 * without also claiming `kind='auto'` ones.
 */
export async function claimNextBatch(
  db: Db,
  args: { now: Date; kinds?: readonly BatchRow['kind'][] },
): Promise<BatchRow | null> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(analysisBatches)
      .where(
        and(
          eq(analysisBatches.status, 'queued'),
          or(isNull(analysisBatches.nextAttemptAt), lte(analysisBatches.nextAttemptAt, args.now)),
          args.kinds ? inArray(analysisBatches.kind, args.kinds) : undefined,
        ),
      )
      .orderBy(asc(analysisBatches.createdAt), asc(analysisBatches.id))
      .limit(1)
      .for('update', { skipLocked: true });

    const candidate = candidates[0];
    if (!candidate) return null;

    const staleDeadline = new Date(args.now.getTime() + STALE_RUNNING_BATCH_MS);
    const [claimed] = await tx
      .update(analysisBatches)
      .set({ status: 'running', nextAttemptAt: staleDeadline })
      .where(and(eq(analysisBatches.id, candidate.id), eq(analysisBatches.status, 'queued')))
      .returning();
    return claimed ?? null;
  });
}

/**
 * Reclaims any batch stuck `running` past its stale-claim deadline (SPEC
 * §8's crash-recovery case — see {@link claimNextBatch}'s doc comment for
 * why `next_attempt_at` is the field compared here): flips it back to
 * `queued` with `next_attempt_at` cleared, so the very next
 * {@link claimNextBatch} call can pick it straight back up with no extra
 * backoff wait (this is recovery from a dead worker, not a real failure).
 * Returns how many batches were recovered.
 */
export async function recoverStaleBatches(db: Db, args: { now: Date }): Promise<number> {
  const recovered = await db
    .update(analysisBatches)
    .set({ status: 'queued', nextAttemptAt: null })
    .where(and(eq(analysisBatches.status, 'running'), lte(analysisBatches.nextAttemptAt, args.now)))
    .returning({ id: analysisBatches.id });
  return recovered.length;
}
