import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import type { AppDeps } from '../../deps.js';
import { messages, proposals } from '../../db/schema/index.js';
import { can, type Actor } from '../people/permissions.js';
import { getChatById } from '../chats/repo.js';
import { getSettings } from '../workspaces/repo.js';
import { messageLink } from '../../bot/views/links.js';
import type { AssigneeResolution } from '../../ai/pipeline/resolve.js';
import { createTaskService, type ActorRef, type CreateTaskInput } from '../tasks/service.js';
import { getTaskById, type TaskRow } from '../tasks/repo.js';
import {
  parseProposalPayload,
  type ProposalPayload,
  type ProposalPayloadDue,
  type ProposalRow,
} from './repo.js';

/**
 * The subset of `AppDeps` these decision functions actually need — kept as a `Pick`, not the full
 * `AppDeps` the brief's "Produces" section names, because `src/bot/bot.ts`'s `BotDeps` (plan.md decision
 * D34) is deliberately narrower than `AppDeps` and `tests/helpers/botHarness.ts` builds only `BotDeps`.
 * D34's own reasoning for not widening `BotDeps` all the way to `AppDeps` ("would need to drag `ai`/
 * `taskHooks` in for no benefit") no longer holds for `taskHooks` specifically — this task's
 * `createTaskService` genuinely needs it — so `BotDeps` gains that one field (see `src/bot/bot.ts`), but
 * not `ai`, which nothing under `src/bot/handlers/proposalCallbacks.ts` touches. This `Pick` is exactly
 * what `BotDeps` (once widened) already satisfies structurally, so `registerProposalCallbackHandlers` can
 * pass its `deps` straight through with no adapter.
 */
export type DecideDeps = Pick<
  AppDeps,
  'db' | 'clock' | 'config' | 'messenger' | 'logger' | 'workspace' | 'taskHooks'
>;

export type DecisionResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'already_decided' | 'forbidden' | 'not_found' | 'target_gone' };

export interface ProposalEdits {
  title?: string;
  assignee?: AssigneeResolution;
  due?: { at: Date | null; allDay: boolean; tz: string | null };
  priority?: 'low' | 'normal' | 'high';
  description?: string | null;
}

/**
 * Thrown internally by {@link runDecision} to roll a transaction back when the work inside it produced a
 * `DecisionResult<...>` failure *after* already writing something (most often {@link claimProposal}'s
 * atomic `UPDATE`) — plan.md's review risk-focus #1 (crash mid-work): a proposal must never end up marked
 * accepted/rejected while the task change it was supposed to cause never happened, or vice versa. Ordinary
 * JS errors (a genuine bug — an unparsable payload, a missing insert row) are left to propagate and roll
 * the transaction back the normal way; this class exists only to carry an already-classified
 * `DecisionResult` failure back out through `db.transaction`'s throw-to-rollback mechanism without it being
 * mistaken for one of those.
 */
class DecisionAbort<T> extends Error {
  constructor(readonly result: Extract<DecisionResult<T>, { ok: false }>) {
    super(`decision aborted: ${result.reason}`);
  }
}

/**
 * Runs `fn` inside one transaction, translating a `{ ok: false }` result from `fn` into an automatic
 * rollback (via {@link DecisionAbort}) instead of a commit — so every exported function below gets
 * all-or-nothing atomicity for free: either the proposal's status change and the task mutation it causes
 * both land, or neither does (SPEC/CLAUDE.md: a missed task is worse than a false positive, so a partial
 * write is never acceptable here).
 */
async function runDecision<T>(
  deps: DecideDeps,
  fn: (tx: Tx) => Promise<DecisionResult<T>>,
): Promise<DecisionResult<T>> {
  try {
    return await deps.db.transaction(async (tx) => {
      const result = await fn(tx);
      if (!result.ok) throw new DecisionAbort<T>(result);
      return result;
    });
  } catch (err) {
    if (err instanceof DecisionAbort) return err.result;
    throw err;
  }
}

interface ClaimArgs {
  proposalId: number;
  actor: Actor;
  now: Date;
  nextStatus: 'accepted' | 'rejected';
  allowedKinds: ReadonlyArray<ProposalRow['kind']>;
  rejectReason?: ProposalRow['rejectReason'];
}

/**
 * The atomic "claim" every decision starts with (SPEC/plan.md's established idempotency pattern — mirrors
 * `src/ai/pipeline/batcher.ts`'s `claimNextBatch`): `UPDATE proposals SET status=…, decided_by_user_id=…,
 * decided_at=$now WHERE id=$1 AND status='pending' [AND kind IN (...)] RETURNING *`. Two concurrent callers
 * racing the same `proposalId` (`Promise.all`, plan.md's review risk-focus #2) serialize on this row's write lock:
 * whichever transaction's `UPDATE` commits first wins, and the other's `UPDATE` — evaluated against the
 * now-already-decided row — affects zero rows and falls through to the diagnostic read below. `allowedKinds`
 * guards against a forged `callback_data` acting on a proposal of the wrong `kind` (e.g. `acc` sent for an
 * `update`-kind proposal id) — treated as `forbidden`, distinct from the ordinary `already_decided` race.
 */
async function claimProposal(tx: Tx, args: ClaimArgs): Promise<DecisionResult<ProposalRow>> {
  const [claimed] = await tx
    .update(proposals)
    .set({
      status: args.nextStatus,
      decidedByUserId: args.actor.userId,
      decidedAt: args.now,
      ...(args.rejectReason !== undefined ? { rejectReason: args.rejectReason } : {}),
    })
    .where(
      and(
        eq(proposals.id, args.proposalId),
        eq(proposals.status, 'pending'),
        inArray(proposals.kind, args.allowedKinds),
      ),
    )
    .returning();
  if (claimed) return { ok: true, value: claimed };

  const [existing] = await tx.select().from(proposals).where(eq(proposals.id, args.proposalId)).limit(1);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'pending') return { ok: false, reason: 'already_decided' };
  return { ok: false, reason: 'forbidden' };
}

function actorRef(actor: Actor): ActorRef {
  // Callers only reach here after `can(actor, 'proposal.decide') && actor.userId !== null` has already
  // been checked (every exported function below does this first) — this can only throw on a real bug in
  // one of those callers, never in ordinary operation.
  if (actor.userId === null) throw new Error('actorRef: actor.userId is null');
  return { type: 'user', userId: actor.userId };
}

interface Source {
  chatId: number | null;
  tgMessageId: number | null;
  link: string | null;
}

/** The proposal's first source message, resolved for `CreateTaskInput.source` — mirrors
 * `src/scheduler/jobs/cards.ts`'s `buildCardView` loading, simplified to a single proposal (no cross-call
 * cache needed here). `chatId`/`sourceMessageIds` are plain columns on `proposals`, not part of `payload`. */
async function loadSource(tx: Tx, proposal: ProposalRow): Promise<Source> {
  if (proposal.chatId === null) return { chatId: null, tgMessageId: null, link: null };
  const chat = await getChatById(tx, proposal.chatId);
  const firstId = proposal.sourceMessageIds[0];
  if (chat === null || firstId === undefined)
    return { chatId: proposal.chatId, tgMessageId: null, link: null };
  const [message] = await tx.select().from(messages).where(eq(messages.id, firstId)).limit(1);
  if (!message) return { chatId: proposal.chatId, tgMessageId: null, link: null };
  const link = messageLink({ type: chat.type, tgChatId: chat.tgChatId }, message.tgMessageId);
  return { chatId: proposal.chatId, tgMessageId: message.tgMessageId, link };
}

function dueFromPayload(due: ProposalPayloadDue | null | undefined): CreateTaskInput['due'] {
  if (!due || due.dueAt === null) return { at: null, allDay: false, tz: null };
  return { at: new Date(due.dueAt), allDay: due.allDay, tz: due.tz };
}

function buildCreateInput(
  proposal: ProposalRow,
  payload: ProposalPayload,
  edits: ProposalEdits | undefined,
  source: Source,
): CreateTaskInput {
  return {
    workspaceId: proposal.workspaceId,
    title: edits?.title ?? payload.title ?? '',
    description: edits?.description !== undefined ? edits.description : (payload.description ?? null),
    assignee: edits?.assignee ?? payload.assignee ?? { type: 'none' },
    due: edits?.due ?? dueFromPayload(payload.due),
    priority: edits?.priority ?? payload.priority ?? 'normal',
    origin: payload.origin,
    proposalId: proposal.id,
    source: {
      chatId: source.chatId,
      tgMessageId: source.tgMessageId,
      link: source.link,
      quote: payload.quote,
    },
  };
}

function buildUpdatePatch(
  changes: NonNullable<ProposalPayload['changes']>,
): Partial<Pick<CreateTaskInput, 'title' | 'assignee' | 'due'>> {
  const patch: Partial<Pick<CreateTaskInput, 'title' | 'assignee' | 'due'>> = {};
  if (changes.title !== undefined) patch.title = changes.title;
  if (changes.assignee !== undefined) patch.assignee = changes.assignee;
  if (changes.due !== undefined) patch.due = dueFromPayload(changes.due);
  return patch;
}

/** Best-effort `reactions.onAccept` (SPEC §11.1) on the proposal's original source message — mirrors
 * `src/scheduler/jobs/cards.ts`'s `reactToSource` (never throws, never blocks the caller: a reaction
 * failing is not a reason to treat `acceptProposal` itself as failed — the task was already created). */
async function reactOnAccept(deps: DecideDeps, proposal: ProposalRow): Promise<void> {
  if (proposal.chatId === null) return;
  const firstId = proposal.sourceMessageIds[0];
  if (firstId === undefined) return;
  try {
    const settings = await getSettings(deps.db, deps.workspace.id);
    if (settings.reactions.onAccept === null) return;
    const chat = await getChatById(deps.db, proposal.chatId);
    if (chat === null || !chat.reactionsEnabled) return;
    const [message] = await deps.db.select().from(messages).where(eq(messages.id, firstId)).limit(1);
    if (!message) return;
    await deps.messenger.react(chat.tgChatId, message.tgMessageId, settings.reactions.onAccept);
  } catch (err) {
    deps.logger.error(
      { err, proposalId: proposal.id },
      'acceptProposal: failed to react to the source message',
    );
  }
}

/**
 * The accept button (SPEC §11.2, `create`-kind proposals only): claims the proposal, creates the task in
 * the same transaction (`TaskService.create`, `origin='ai'`/`'manual_group'`/`'manual_dm'`/`'forward'` per
 * the payload), then — once committed — best-effort reacts `reactions.onAccept` on the source message.
 * `edits` (from the future edit dialog, plan.md Task 2.14) override the payload's own fields field-by-
 * field; omitted entirely for a plain accept click.
 */
export async function acceptProposal(
  deps: DecideDeps,
  a: { proposalId: number; actor: Actor; edits?: ProposalEdits },
): Promise<DecisionResult<TaskRow>> {
  if (!can(a.actor, 'proposal.decide') || a.actor.userId === null) return { ok: false, reason: 'forbidden' };

  const taskService = createTaskService(deps);
  let accepted: ProposalRow | null = null;

  const result = await runDecision<TaskRow>(deps, async (tx) => {
    const now = deps.clock.now();
    const claim = await claimProposal(tx, {
      proposalId: a.proposalId,
      actor: a.actor,
      now,
      nextStatus: 'accepted',
      allowedKinds: ['create'],
    });
    if (!claim.ok) return claim;
    accepted = claim.value;

    const payload = parseProposalPayload(claim.value.payload);
    if (!payload) {
      throw new Error(`acceptProposal: unparsable payload for proposal ${String(claim.value.id)}`);
    }

    const source = await loadSource(tx, claim.value);
    const input = buildCreateInput(claim.value, payload, a.edits, source);
    const task = await taskService.create(tx, input, actorRef(a.actor));
    return { ok: true, value: task };
  });

  if (result.ok && accepted) await reactOnAccept(deps, accepted);
  return result;
}

/**
 * The decline button (SPEC §11.2) — declines a proposal of any kind. `reason` is `null` for
 * `update`/`complete`/`cancel`'s plain decline (no reason submenu for those — only `create`'s decline
 * button opens one, `src/bot/handlers/proposalCallbacks.ts`) and one of the four `proposal_reject_reason`
 * values for `create`'s submenu.
 */
export async function rejectProposal(
  deps: DecideDeps,
  a: { proposalId: number; actor: Actor; reason: 'not_task' | 'duplicate' | 'already_done' | 'other' | null },
): Promise<DecisionResult<ProposalRow>> {
  if (!can(a.actor, 'proposal.decide') || a.actor.userId === null) return { ok: false, reason: 'forbidden' };

  return runDecision<ProposalRow>(deps, async (tx) => {
    const now = deps.clock.now();
    return claimProposal(tx, {
      proposalId: a.proposalId,
      actor: a.actor,
      now,
      nextStatus: 'rejected',
      allowedKinds: ['create', 'update', 'complete', 'cancel'],
      rejectReason: a.reason,
    });
  });
}

/**
 * The "mark as duplicate" submenu's two buttons (SPEC §11.1/§11.2 — "mark only" vs. "mark and append"):
 * rejects the `create`-kind proposal with `reject_reason='duplicate'` and, only when the owner explicitly
 * chose the "mark and append" button (`appendToDescription: true` — never implied by the initial "mark as
 * duplicate" click alone, which only opens the submenu, `src/bot/handlers/proposalCallbacks.ts`), appends the
 * proposal's quote (or, lacking one, its title) onto `taskId`'s existing description. `taskId` comes from
 * the submenu's own `v1:p:dpm|dpa:<id>:<taskId>` `callback_data` (the duplicate target shown on the card,
 * `payload.duplicateOf.id` at render time) — independent of `proposals.target_task_id`, which stays `null`
 * for `create`-kind rows. `callback_data` is never trusted (CLAUDE.md §8): `taskId` is re-validated against
 * `proposal.workspaceId` below, not just assumed to belong to the same workspace as the proposal.
 */
export async function markDuplicate(
  deps: DecideDeps,
  a: { proposalId: number; taskId: number; actor: Actor; appendToDescription: boolean },
): Promise<DecisionResult<TaskRow>> {
  if (!can(a.actor, 'proposal.decide') || a.actor.userId === null) return { ok: false, reason: 'forbidden' };

  const taskService = createTaskService(deps);

  return runDecision<TaskRow>(deps, async (tx) => {
    const now = deps.clock.now();
    const claim = await claimProposal(tx, {
      proposalId: a.proposalId,
      actor: a.actor,
      now,
      nextStatus: 'rejected',
      allowedKinds: ['create'],
      rejectReason: 'duplicate',
    });
    if (!claim.ok) return claim;

    const task = await getTaskById(tx, a.taskId);
    if (!task || task.workspaceId !== claim.value.workspaceId) return { ok: false, reason: 'target_gone' };
    if (!a.appendToDescription) return { ok: true, value: task };

    const payload = parseProposalPayload(claim.value.payload);
    const appendText = payload ? (payload.quote ?? payload.title ?? null) : null;
    if (appendText === null) return { ok: true, value: task };

    const description = task.description === null ? appendText : `${task.description}\n\n${appendText}`;
    const updated = await taskService.update(tx, task.id, { description }, actorRef(a.actor));
    return { ok: true, value: updated };
  });
}

/**
 * The apply/complete/cancel buttons (SPEC §11.2) — the one handler for `update`/
 * `complete`/`cancel`-kind proposals, matching `src/bot/views/proposalCard.ts`'s single shared `apl` button
 * across all three: `update` applies every field in `payload.changes` (not just the one field the card
 * displayed — `src/bot/views/proposalCard.ts`'s `ProposalCardView.target` only shows one at a time, a
 * display limitation that must not constrain what actually gets applied), `complete`/`cancel` set the
 * target task's status.
 */
export async function applyModification(
  deps: DecideDeps,
  a: { proposalId: number; actor: Actor },
): Promise<DecisionResult<TaskRow>> {
  if (!can(a.actor, 'proposal.decide') || a.actor.userId === null) return { ok: false, reason: 'forbidden' };

  const taskService = createTaskService(deps);

  return runDecision<TaskRow>(deps, async (tx) => {
    const now = deps.clock.now();
    const claim = await claimProposal(tx, {
      proposalId: a.proposalId,
      actor: a.actor,
      now,
      nextStatus: 'accepted',
      allowedKinds: ['update', 'complete', 'cancel'],
    });
    if (!claim.ok) return claim;
    const proposal = claim.value;

    if (proposal.targetTaskId === null) return { ok: false, reason: 'target_gone' };
    const task = await getTaskById(tx, proposal.targetTaskId);
    if (!task) return { ok: false, reason: 'target_gone' };

    const ref = actorRef(a.actor);

    if (proposal.kind === 'update') {
      const payload = parseProposalPayload(proposal.payload);
      if (!payload)
        throw new Error(`applyModification: unparsable payload for proposal ${String(proposal.id)}`);
      const patch = buildUpdatePatch(payload.changes ?? {});
      const updated = await taskService.update(tx, task.id, patch, ref);
      return { ok: true, value: updated };
    }

    const status = proposal.kind === 'complete' ? 'done' : 'cancelled';
    const updated = await taskService.setStatus(tx, task.id, status, ref);
    return { ok: true, value: updated };
  });
}
