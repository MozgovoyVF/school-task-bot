import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { DEDUP_SIMILARITY, DEDUP_WINDOW_DAYS } from '../../config/constants.js';
import type { DbOrTx } from '../../db/client.js';
import { proposals, tasks } from '../../db/schema/index.js';
import type { AssigneeResolution, ResolvedAction } from './resolve.js';

/** How many trigram-similarity candidates to pull before filtering by assignee in JS (SPEC §9.7.2 checks title similarity AND assignee, and the two engines — SQL columns for tasks, jsonb for proposals — are cheapest to reconcile client-side). */
const CANDIDATE_LIMIT = 20;

export interface DuplicateMatch {
  type: 'task' | 'proposal';
  id: number;
  title: string;
  similarity: number;
}

/**
 * The assignee as persisted inside a `create`-kind proposal's `payload`
 * (mirrors `resolve.ts`'s `AssigneeResolution` verbatim — the shape a
 * future proposal-creation step is expected to store, since it is built
 * directly from a `ResolvedAction`'s `assignee` field). A row whose payload
 * does not match this shape (e.g. an `update`/`complete`/`cancel` proposal,
 * or one from an older/different payload version) is simply skipped by
 * {@link findPossibleDuplicate} rather than treated as an error — CLAUDE.md
 * ranks a missed task above a false positive, and skipping an
 * unparseable candidate only risks a duplicate proposal being shown, never
 * a real task being dropped.
 */
const PayloadAssignee = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: z.number() }),
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('text'), name: z.string() }),
  z.object({ type: z.literal('none') }),
]);

const DedupPayload = z.object({ title: z.string(), assignee: PayloadAssignee });

function normalizeTitle(title: string): string {
  return title.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Case-insensitive, NFC-normalized equality for the assignee's free-text name — not otherwise specified by SPEC §9.7, kept consistent with {@link normalizeTitle}. */
function assigneeEquals(a: AssigneeResolution, b: AssigneeResolution): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'user' && b.type === 'user') return a.userId === b.userId;
  if (a.type === 'text' && b.type === 'text') return normalizeTitle(a.name) === normalizeTitle(b.name);
  return true; // 'all' === 'all', 'none' === 'none' (SPEC §9.7.2 / brief step 1 case 7)
}

function taskAssignee(row: {
  assigneeUserId: number | null;
  assigneeAll: boolean;
  assigneeNameText: string | null;
}): AssigneeResolution {
  if (row.assigneeAll) return { type: 'all' };
  if (row.assigneeUserId !== null) return { type: 'user', userId: row.assigneeUserId };
  if (row.assigneeNameText !== null) return { type: 'text', name: row.assigneeNameText };
  return { type: 'none' };
}

/**
 * Open/in-progress tasks in the workspace, created within the last
 * {@link DEDUP_WINDOW_DAYS} days, whose title trigram-matches `args.title`
 * at >= {@link DEDUP_SIMILARITY} (SPEC §9.7.2 / brief step 3's exact SQL
 * shape) — then, among those, the highest-similarity row that also has the
 * same assignee.
 */
async function findTaskDuplicate(
  db: DbOrTx,
  args: { workspaceId: number; title: string; assignee: AssigneeResolution; now: Date },
): Promise<DuplicateMatch | null> {
  const cutoff = DateTime.fromJSDate(args.now).minus({ days: DEDUP_WINDOW_DAYS }).toJSDate();
  const similarity = sql<number>`similarity(lower(${tasks.title}), lower(${args.title}))`;

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      assigneeUserId: tasks.assigneeUserId,
      assigneeAll: tasks.assigneeAll,
      assigneeNameText: tasks.assigneeNameText,
      similarity,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, args.workspaceId),
        inArray(tasks.status, ['open', 'in_progress']),
        gte(tasks.createdAt, cutoff),
        sql`${similarity} >= ${DEDUP_SIMILARITY}`,
      ),
    )
    .orderBy(sql`${similarity} desc`)
    .limit(CANDIDATE_LIMIT);

  for (const row of rows) {
    if (!assigneeEquals(args.assignee, taskAssignee(row))) continue;
    return { type: 'task', id: row.id, title: row.title, similarity: Number(row.similarity) };
  }
  return null;
}

/**
 * Pending `create` proposals in the workspace whose `payload.title`
 * trigram-matches `args.title` at >= {@link DEDUP_SIMILARITY} (brief step
 * 3), filtered to the highest-similarity one that also has the same
 * assignee (payload parsed via {@link DedupPayload}; a row that fails to
 * parse is skipped, not an error — see that schema's doc comment).
 */
async function findProposalDuplicate(
  db: DbOrTx,
  args: { workspaceId: number; title: string; assignee: AssigneeResolution; now: Date },
): Promise<DuplicateMatch | null> {
  const similarity = sql<number>`similarity(lower(${proposals.payload}->>'title'), lower(${args.title}))`;

  const rows = await db
    .select({ id: proposals.id, payload: proposals.payload, similarity })
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, args.workspaceId),
        eq(proposals.kind, 'create'),
        eq(proposals.status, 'pending'),
        sql`${similarity} >= ${DEDUP_SIMILARITY}`,
      ),
    )
    .orderBy(sql`${similarity} desc`)
    .limit(CANDIDATE_LIMIT);

  for (const row of rows) {
    const parsed = DedupPayload.safeParse(row.payload);
    if (!parsed.success) continue;
    if (!assigneeEquals(args.assignee, parsed.data.assignee)) continue;
    return { type: 'proposal', id: row.id, title: parsed.data.title, similarity: Number(row.similarity) };
  }
  return null;
}

/**
 * SPEC §9.7.2: flags a resolved `create` candidate as a possible duplicate
 * of an existing open task or pending proposal — same workspace, title
 * trigram-similarity >= {@link DEDUP_SIMILARITY}, and the same assignee.
 * Tasks additionally require `status IN ('open','in_progress')` and
 * `created_at` within the last {@link DEDUP_WINDOW_DAYS} days; proposals
 * require `status='pending'`. When both a task and a proposal match, the
 * higher-similarity one wins (ties favor the task, arbitrarily but
 * deterministically). This only ever flags a possible duplicate for the
 * caller to surface (e.g. SPEC §9.7.2's "possible duplicate of T12" button) — it never itself
 * suppresses or merges a proposal, per CLAUDE.md's recall-over-precision
 * rule.
 */
export async function findPossibleDuplicate(
  db: DbOrTx,
  args: { workspaceId: number; title: string; assignee: AssigneeResolution; now: Date },
): Promise<DuplicateMatch | null> {
  const [taskMatch, proposalMatch] = await Promise.all([
    findTaskDuplicate(db, args),
    findProposalDuplicate(db, args),
  ]);
  if (taskMatch === null) return proposalMatch;
  if (proposalMatch === null) return taskMatch;
  return proposalMatch.similarity > taskMatch.similarity ? proposalMatch : taskMatch;
}

function sameIdSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((id) => bSet.has(id));
}

/**
 * SPEC §9.7.3: true when `candidate` (a `create` action about to become a
 * new proposal) is a repeat, within the same batch, of an action already in
 * `existing` — the same set of `sourceMessageIds` (order-independent) and
 * the same title once normalized (NFC, case, surrounding/collapsed
 * whitespace). Only `create` actions can repeat this way: `update`/
 * `complete`/`cancel` already target a specific existing task/proposal id,
 * so there is no title to compare and no risk of the same duplicate this
 * check guards against (brief step 1 case 8 / SPEC §9.7 point 3's
 * `(batch_id, source_message_ids, title)` idempotency key).
 */
export function isRepeatInBatch(existing: ResolvedAction[], candidate: ResolvedAction): boolean {
  if (candidate.kind !== 'create') return false;
  const candidateTitle = normalizeTitle(candidate.title);
  return existing.some(
    (action) =>
      action.kind === 'create' &&
      sameIdSet(action.sourceMessageIds, candidate.sourceMessageIds) &&
      normalizeTitle(action.title) === candidateTitle,
  );
}
