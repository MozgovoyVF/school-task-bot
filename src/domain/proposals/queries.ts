import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { AppDeps } from '../../deps.js';
import type { Db, DbOrTx } from '../../db/client.js';
import { analysisBatches, chats, messages, proposals, tasks } from '../../db/schema/index.js';
import { getChatById } from '../chats/repo.js';
import { parseProposalPayload, type ProposalRow } from './repo.js';

export interface PendingProposalListItem {
  id: number;
  kind: ProposalRow['kind'];
  /** `payload.title` for a `create` proposal, or the target task's own title for `update`/`complete`/`cancel` — `''` when neither could be resolved (an unparsable payload, or a target task that no longer exists). */
  title: string;
  chatTitle: string | null;
  createdAt: Date;
}

export interface PendingProposalsPage {
  items: PendingProposalListItem[];
  total: number;
}

function itemTitle(row: ProposalRow, taskTitleById: ReadonlyMap<number, string>): string {
  if (row.kind === 'create') {
    const payload = parseProposalPayload(row.payload);
    return payload?.title ?? '';
  }
  if (row.targetTaskId !== null) {
    return taskTitleById.get(row.targetTaskId) ?? '';
  }
  return '';
}

/**
 * `/inbox`'s data (plan.md Task 2.15, SPEC §12.2's row, D40 owner-only): every still-`pending` proposal
 * of `workspaceId` — `shown` *and* `suppressed` alike, unlike `cardsJob`'s outbox, which only ever
 * delivers `shown` ones — oldest first, `args.pageSize` per `args.page` (1-indexed). `total` is the full
 * pending count (for the caller's page-count math), independent of `pageSize`/`page`. `db` accepts
 * `DbOrTx` (not just `Db`) — `src/domain/tasks/queries.ts`'s `summarySections` (Task 3.5) calls this from
 * inside `notifyJob`'s own transaction to get the morning summary's `inboxCount`, rather than duplicating
 * this count query.
 */
export async function listPendingProposals(
  db: DbOrTx,
  workspaceId: number,
  args: { page: number; pageSize: number },
): Promise<PendingProposalsPage> {
  const offset = Math.max(0, args.page - 1) * args.pageSize;
  const where = and(eq(proposals.workspaceId, workspaceId), eq(proposals.status, 'pending'));

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(proposals)
    .where(where);
  const total = totalRow?.count ?? 0;

  const rows = await db
    .select()
    .from(proposals)
    .where(where)
    .orderBy(asc(proposals.createdAt), asc(proposals.id))
    .limit(args.pageSize)
    .offset(offset);

  if (rows.length === 0) return { items: [], total };

  const chatIds = [...new Set(rows.map((r) => r.chatId).filter((id): id is number => id !== null))];
  const taskIds = [...new Set(rows.map((r) => r.targetTaskId).filter((id): id is number => id !== null))];

  const chatRows = chatIds.length > 0 ? await db.select().from(chats).where(inArray(chats.id, chatIds)) : [];
  const chatTitleById = new Map(chatRows.map((c) => [c.id, c.title]));

  const taskRows = taskIds.length > 0 ? await db.select().from(tasks).where(inArray(tasks.id, taskIds)) : [];
  const taskTitleById = new Map(taskRows.map((t) => [t.id, t.title]));

  const items: PendingProposalListItem[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: itemTitle(row, taskTitleById),
    chatTitle: row.chatId !== null ? (chatTitleById.get(row.chatId) ?? null) : null,
    createdAt: row.createdAt,
  }));

  return { items, total };
}

export type ReanalyzeResult =
  | { ok: true; mode: 'requeued'; batches: number; messages: number }
  | { ok: true; mode: 'created'; batchId: number; messages: number }
  | { ok: false; reason: 'chat_not_found' | 'no_messages' };

/** The subset of `AppDeps` {@link reanalyze} needs — `db` for every read/write, `clock` per CLAUDE.md's "business-logic 'now' only from `deps.clock.now()`" rule (the `lastN` path stamps the new batch's `created_at` with it, same as `enqueueOneChat`/`claimNextBatch` elsewhere in the AI pipeline). */
export type ReanalyzeDeps = Pick<AppDeps, 'db' | 'clock'>;

/**
 * No `N`: re-queues `chatId`'s `failed` batches for a normal retry, by clearing `batch_id` on their
 * messages (SPEC §8: after 5 failed attempts a batch becomes `failed`, and `/reanalyze` is how it gets
 * retried) — those messages are already `pending` (a failed batch never touches its messages' own
 * status, see `src/scheduler/jobs/analyze.ts`'s `markFailedOrRetry`), so clearing `batch_id` alone is
 * enough to make `enqueueBatches` (`src/ai/pipeline/batcher.ts`) pick them straight back up on its next
 * tick. The `failed` batch rows themselves are left as-is (still visible in `/debug`'s history) —
 * idempotent by construction: a repeat call only matches messages whose `batch_id` still points at one of
 * `chatId`'s `failed` batches, which is already false once the first call has run.
 */
async function requeueFailedBatches(
  db: Db,
  chatId: number,
): Promise<Extract<ReanalyzeResult, { mode: 'requeued' }>> {
  const failed = await db
    .select({ id: analysisBatches.id })
    .from(analysisBatches)
    .where(and(eq(analysisBatches.chatId, chatId), eq(analysisBatches.status, 'failed')));
  if (failed.length === 0) return { ok: true, mode: 'requeued', batches: 0, messages: 0 };

  const failedIds = failed.map((b) => b.id);
  const updated = await db
    .update(messages)
    .set({ batchId: null })
    .where(inArray(messages.batchId, failedIds))
    .returning({ id: messages.id });

  return { ok: true, mode: 'requeued', batches: failed.length, messages: updated.length };
}

/**
 * `N` given: builds a fresh `kind='reanalyze'` batch over `chatId`'s last `lastN` text messages
 * (`text IS NOT NULL`, newest-first then reversed to chronological order — same convention as
 * `enqueueOneChat`'s own message selection), regardless of their current `analysis_status` — a message
 * already `analyzed` is deliberately re-queued too, since "reanalyze" means running the pipeline again,
 * not just catching up on what it missed. `src/scheduler/jobs/analyze.ts`'s `runOneBatch` reads
 * `batch.kind === 'reanalyze'` to pass `noReaction: true` into `processBatch` — this function only ever
 * creates the `queued` batch row; the actual LLM call and any resulting proposals still wait for the
 * ticker's own schedule, same as an `auto` batch.
 */
async function createReanalyzeBatch(
  db: Db,
  chatId: number,
  lastN: number,
  now: Date,
): Promise<ReanalyzeResult> {
  const picked = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), isNotNull(messages.text)))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(lastN);
  if (picked.length === 0) return { ok: false, reason: 'no_messages' };

  const ids = picked.map((m) => m.id).reverse();

  return db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(analysisBatches)
      .values({
        chatId,
        status: 'queued',
        kind: 'reanalyze',
        firstMessageId: ids[0],
        lastMessageId: ids[ids.length - 1],
        messageCount: ids.length,
        createdAt: now,
      })
      .returning();
    if (!batch) throw new Error('createReanalyzeBatch: insert into analysis_batches returned no row');

    await tx
      .update(messages)
      .set({ analysisStatus: 'pending', batchId: batch.id })
      .where(inArray(messages.id, ids));

    return { ok: true, mode: 'created', batchId: batch.id, messages: ids.length };
  });
}

/**
 * `/reanalyze <chatId> [lastN]` (plan.md Task 2.15, SPEC §12.2's row — superadmin-only, see this task's
 * final report for why: SPEC's own command table and the pre-existing `src/bot/commands.ts` both scope it
 * to superadmin, not Owner). `chatId` is `chats.id` (the internal id `/debug`'s output exposes), not the
 * raw Telegram chat id.
 */
export async function reanalyze(
  deps: ReanalyzeDeps,
  args: { chatId: number; lastN?: number },
): Promise<ReanalyzeResult> {
  const chat = await getChatById(deps.db, args.chatId);
  if (!chat) return { ok: false, reason: 'chat_not_found' };

  if (args.lastN === undefined) {
    return requeueFailedBatches(deps.db, args.chatId);
  }
  return createReanalyzeBatch(deps.db, args.chatId, args.lastN, deps.clock.now());
}
