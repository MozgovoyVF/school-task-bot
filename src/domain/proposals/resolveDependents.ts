import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Logger } from '../../ops/logger.js';
import { proposals } from '../../db/schema/index.js';
import { getProposalById, parseProposalPayload, type ProposalRow } from './repo.js';
import { getTaskByProposalId } from '../tasks/repo.js';

/**
 * D44 (plan.md row, resolved for this fix): resolves every still-`pending` `update`/`complete`/`cancel`
 * proposal whose target is *another proposal* (`payload.targetProposalId`, `target_task_id` still `null` —
 * see `src/domain/proposals/repo.ts`'s `ProposalPayload` doc comment) against that target's current
 * status. Called once at the top of `cardsJob.run` (`src/scheduler/jobs/cards.ts`), before it computes this
 * tick's eligible set, so a row this function re-targets is delivered as an ordinary card in the very same
 * tick, and a row it closes never reaches the outbox at all.
 *
 * Three outcomes per candidate, matching the three branches the fix brief asked for:
 *
 * - target `accepted`: a task now exists for it (`tasks.proposal_id`). This proposal is re-targeted onto
 *   that task (`target_task_id` set) so `cardsJob`'s normal update/complete/cancel card flow picks it up
 *   from here on — the dependency is resolved, nothing about this row is "D44" any more.
 * - target `rejected` / `expired` / `superseded` (anything terminal but not `accepted`): no task ever
 *   resulted from it, and none ever will. This proposal is closed too, `status='expired'` — reusing the
 *   status `expireProposalsJob` already uses for a proposal closed by the system rather than an explicit
 *   Owner decision (CLAUDE.md §4: no new enum value for something an existing one already covers) — so it
 *   stops being retried on every single tick (a loop logged forever is exactly the kind of thing D44's bug
 *   report flagged).
 * - target still `pending`: nothing to do yet. Logged once per call at `debug` (not `warn`/`error` —
 *   this is an expected, possibly long wait, not a warning-worthy condition every tick).
 *
 * Every write here is the same `UPDATE … WHERE status='pending' RETURNING`/conditional-`WHERE` idempotency
 * convention used throughout this codebase (CLAUDE.md's idempotency rules, mirrors
 * `src/domain/proposals/decide.ts`'s `claimProposal`): a concurrent decision on the *same* row (the Owner
 * clicking a button on it right as this runs, or two overlapping ticker runs) can never race this into a
 * torn state — whichever write's `WHERE status='pending'` still matches wins, the other affects zero rows.
 * No explicit `FOR UPDATE SKIP LOCKED` is needed for that reason — unlike `claimNextBatch`
 * (`src/ai/pipeline/batcher.ts`), which uses it to pick *one* winner among racing claimants of the *same*
 * row for a *different* purpose, every proposal here is claimed by at most one logical writer (this
 * function or `decide.ts`) acting on that proposal's own id, so the conditional `UPDATE` alone is
 * sufficient.
 *
 * Never throws on one candidate's own trouble (unparsable payload, a `targetProposalId` pointing at a row
 * that no longer exists) — logs and leaves that one row `pending` for a human to notice (via `/inbox` or
 * logs) rather than stopping every other candidate in the same run (CLAUDE.md: a missed task is worse than
 * a false positive).
 */
export async function resolveDependentProposals(
  db: Db,
  args: { workspaceId: number; logger: Logger },
): Promise<void> {
  const candidates = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, args.workspaceId),
        eq(proposals.status, 'pending'),
        isNull(proposals.targetTaskId),
        inArray(proposals.kind, ['update', 'complete', 'cancel']),
      ),
    );

  for (const row of candidates) {
    await resolveOne(db, row, args.logger);
  }
}

async function resolveOne(db: Db, row: ProposalRow, logger: Logger): Promise<void> {
  const payload = parseProposalPayload(row.payload);
  // Not a D44 dependent at all (unparsable payload, or a non-create proposal with neither a target task
  // nor a target proposal) — `cardsJob.buildCardView` already logs and skips these on its own terms.
  if (!payload || payload.targetProposalId === undefined) return;

  const target = await getProposalById(db, payload.targetProposalId);
  // review round 1, M2: a `targetProposalId` pointing at a proposal from a *different* workspace is
  // treated the same as "not found" — it should never happen (`processBatch` only ever writes a same-
  // workspace id), but this id comes from an LLM-authored payload, not a validated foreign key, so it gets
  // the same defensive check `callback_data` ids get elsewhere in this codebase (CLAUDE.md §8).
  if (target === null || target.workspaceId !== row.workspaceId) {
    logger.error(
      { proposalId: row.id, targetProposalId: payload.targetProposalId },
      'resolveDependentProposals: target proposal not found (D44)',
    );
    return;
  }

  if (target.status === 'pending') {
    logger.debug(
      { proposalId: row.id, targetProposalId: target.id },
      'resolveDependentProposals: target proposal still pending (D44) — waiting',
    );
    return;
  }

  if (target.status === 'accepted') {
    const task = await getTaskByProposalId(db, target.id);
    // Genuinely unexpected: acceptProposal creates the task in the same transaction as the status flip
    // and in the same workspace as the proposal it came from, so a missing task — or one somehow in a
    // different workspace (review round 1, M2, same defensive check as the target proposal lookup above)
    // — is an internal-consistency bug, not a normal D44 wait.
    if (task === null || task.workspaceId !== row.workspaceId) {
      logger.error(
        { proposalId: row.id, targetProposalId: target.id },
        'resolveDependentProposals: target proposal accepted but its task was not found (D44)',
      );
      return;
    }
    await db
      .update(proposals)
      .set({ targetTaskId: task.id })
      .where(and(eq(proposals.id, row.id), eq(proposals.status, 'pending'), isNull(proposals.targetTaskId)));
    return;
  }

  // rejected / superseded / expired: the target proposal never became a task and never will — close this
  // dependent too instead of leaving it to loop forever.
  await db
    .update(proposals)
    .set({ status: 'expired' })
    .where(and(eq(proposals.id, row.id), eq(proposals.status, 'pending')));
}
