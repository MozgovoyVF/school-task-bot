import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  CONTEXT_MESSAGES,
  EXTRACTOR_PROMPT_VERSION,
  PROMPT_MAX_OPEN_PROPOSALS,
  PROMPT_MAX_OPEN_TASKS,
  QUOTE_MAX_CHARS,
} from '../../config/constants.js';
import type { AppDeps } from '../../deps.js';
import { analysisBatches, messages, proposals, tasks } from '../../db/schema/index.js';
import { getSettings } from '../../domain/workspaces/repo.js';
import { getOwner, listMembersWithUsers, type UserRow } from '../../domain/people/repo.js';
import type { MessageRow } from '../../domain/chats/messages.js';
import {
  insertProposal,
  type NewProposal,
  type ProposalPayload,
  type ProposalPayloadDue,
} from '../../domain/proposals/repo.js';
import type { ParticipantForLlm } from '../pseudonymize.js';
import { loadPrompt } from '../prompts.js';
import type { Usage } from '../providers/types.js';
import type { ResolvedDue } from '../../time/resolveDue.js';
import type { BatchRow } from './batcher.js';
import {
  buildExtractionInput,
  type AssigneeResolution as PromptAssignee,
  type MessageForLlm,
  type OpenProposalForLlm,
  type OpenTaskForLlm,
} from './buildInput.js';
import { resolveActions, type ResolveContext, type ResolvedAction } from './resolve.js';
import { applyPolicy, type PolicyMode } from './policy.js';
import { findPossibleDuplicate, isRepeatInBatch } from './dedup.js';

export interface ProcessBatchResult {
  shown: number;
  suppressed: number;
}

export interface ProcessBatchOptions {
  mode?: PolicyMode;
  noReaction?: boolean;
}

/** Mirrors `src/scheduler/jobs/analyze.ts`'s `accumulateUsage` — kept local (not imported) since `ai/pipeline` must not depend on `scheduler/` (CLAUDE.md's module boundaries). Adds this call's usage on top of whatever `batch` already carried in from an earlier failed attempt (SPEC §9.2). */
function accumulateUsage(
  batch: BatchRow,
  usage: Usage,
): { inputTokens: number; outputTokens: number; costUsd: string } {
  return {
    inputTokens: (batch.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (batch.outputTokens ?? 0) + usage.outputTokens,
    costUsd: String(Number(batch.costUsd ?? 0) + usage.costUsd),
  };
}

/**
 * SPEC §9.3's participant projection, built from every current workspace
 * member. Duplicated from `src/scheduler/jobs/analyze.ts`'s private
 * `toParticipants` rather than imported (same module-boundary reason as
 * {@link accumulateUsage}).
 */
function toParticipants(
  members: Array<{ user: UserRow; membership: { role: string; displayName: string; aliases: string[] } }>,
): ParticipantForLlm[] {
  return members.map((m, index) => ({
    code: `P${String(index + 1)}`,
    userId: m.user.id,
    displayName: m.membership.displayName,
    aliases: m.membership.aliases,
    username: m.user.username,
    lastName: m.user.lastName,
    isOwner: m.membership.role === 'owner',
  }));
}

function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join('')}…`;
}

/**
 * A DB message row -> `buildExtractionInput`'s `MessageForLlm`, with real
 * reply-target resolution (unlike `analyze.ts`'s prefilter-only version,
 * which always sends `replyToMessageId: null` — its own doc comment names
 * this task, `processBatch`'s "fuller input assembly", as the one meant to
 * do it): `tgIdToDbId` covers every message loaded for this call (both the
 * batch's own and the skipped-context window), so a reply to either
 * resolves to a real ref.
 */
function toMessageForLlm(
  row: MessageRow,
  usersById: ReadonlyMap<number, UserRow>,
  tgIdToDbId: ReadonlyMap<number, number>,
): MessageForLlm {
  if (row.authorUserId === null) {
    // Should not happen — `saveIncomingMessage` always writes a real author.
    throw new Error(`processBatch: message ${String(row.id)} has no author`);
  }
  const author = usersById.get(row.authorUserId);
  return {
    id: row.id,
    sentAt: row.sentAt,
    authorUserId: row.authorUserId,
    authorTz: author?.timezone ?? null,
    text: row.text ?? '',
    replyToMessageId:
      row.replyToTgMessageId !== null ? (tgIdToDbId.get(row.replyToTgMessageId) ?? null) : null,
    replyQuote: row.replyToQuote,
    isForward: row.isForward,
    forwardOriginName: row.forwardOriginName,
    // `messages` has no column for the forward author's internal id (only
    // `forward_origin_name`, a freeform string) — always `null`, not a gap.
    forwardOriginUserId: null,
  };
}

async function loadBatchMessages(db: AppDeps['db'], batchId: number): Promise<MessageRow[]> {
  return db.select().from(messages).where(eq(messages.batchId, batchId)).orderBy(asc(messages.sentAt));
}

/**
 * Brief step 7: `skipped` messages in the same chat, within the batch's own
 * time window (its earliest to its latest message, inclusive), are fed in
 * as *context* — never as new, actionable input. Returns `[]` when the
 * batch has no chat (a manual/reanalyze batch not tied to one, D5) or no
 * messages of its own to anchor a window against.
 */
async function loadSkippedContext(
  db: AppDeps['db'],
  chatId: number | null,
  batchMessages: readonly MessageRow[],
): Promise<MessageRow[]> {
  if (chatId === null || batchMessages.length === 0) return [];
  const sentTimes = batchMessages.map((m) => m.sentAt.getTime());
  const from = new Date(Math.min(...sentTimes));
  const to = new Date(Math.max(...sentTimes));
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.analysisStatus, 'skipped'),
        gte(messages.sentAt, from),
        lte(messages.sentAt, to),
      ),
    )
    .orderBy(asc(messages.sentAt))
    .limit(CONTEXT_MESSAGES);
}

function toPromptAssignee(
  row: { assigneeUserId: number | null; assigneeAll: boolean },
  participants: readonly ParticipantForLlm[],
  ownerUserId: number,
): PromptAssignee {
  if (row.assigneeAll) return { kind: 'all' };
  if (row.assigneeUserId === null) return { kind: 'none' };
  if (row.assigneeUserId === ownerUserId) return { kind: 'owner' };
  const found = participants.find((p) => p.userId === row.assigneeUserId);
  return found ? { kind: 'participant', code: found.code } : { kind: 'none' };
}

async function loadOpenTasks(
  db: AppDeps['db'],
  workspaceId: number,
  participants: readonly ParticipantForLlm[],
  ownerUserId: number,
): Promise<OpenTaskForLlm[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, ['open', 'in_progress'])))
    .orderBy(asc(tasks.id))
    .limit(PROMPT_MAX_OPEN_TASKS);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    assignee: toPromptAssignee(row, participants, ownerUserId),
    dueAt: row.dueAt,
    dueAllDay: row.dueAllDay,
  }));
}

const OpenProposalPayload = z.object({ title: z.string() });

async function loadOpenProposals(db: AppDeps['db'], workspaceId: number): Promise<OpenProposalForLlm[]> {
  const rows = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.workspaceId, workspaceId), eq(proposals.status, 'pending')))
    .orderBy(asc(proposals.id))
    .limit(PROMPT_MAX_OPEN_PROPOSALS);

  const result: OpenProposalForLlm[] = [];
  for (const row of rows) {
    // A row whose payload doesn't (yet) carry a `title` is skipped rather
    // than thrown on — CLAUDE.md ranks a missed task above a false
    // positive, and dropping it from *context* only risks a duplicate
    // proposal later, never a real task being lost.
    const parsed = OpenProposalPayload.safeParse(row.payload);
    if (!parsed.success) continue;
    result.push({ id: row.id, title: parsed.data.title, kind: row.kind, targetTaskId: row.targetTaskId });
  }
  return result;
}

function serializeDue(due: ResolvedDue): ProposalPayloadDue {
  return {
    dueAt: due.dueAt !== null ? due.dueAt.toISOString() : null,
    allDay: due.allDay,
    tz: due.tz,
    inPast: due.inPast,
    invalid: due.invalid,
  };
}

function targetTaskIdOf(action: ResolvedAction): number | null {
  if (action.kind === 'create') return null;
  return 'taskId' in action.target ? action.target.taskId : null;
}

function targetProposalIdOf(action: ResolvedAction): number | undefined {
  if (action.kind === 'create') return undefined;
  return 'proposalId' in action.target ? action.target.proposalId : undefined;
}

interface QuoteInfo {
  quote: string | null;
  quoteAuthorName: string | null;
}

function buildQuote(
  action: ResolvedAction,
  messagesById: ReadonlyMap<number, MessageRow>,
  displayNameByUserId: ReadonlyMap<number, string>,
): QuoteInfo {
  const firstId = action.sourceMessageIds[0];
  const row = firstId !== undefined ? messagesById.get(firstId) : undefined;
  if (!row) return { quote: null, quoteAuthorName: null };
  const quote = row.text !== null ? truncate(row.text, QUOTE_MAX_CHARS) : null;
  const quoteAuthorName =
    row.authorUserId !== null ? (displayNameByUserId.get(row.authorUserId) ?? null) : null;
  return { quote, quoteAuthorName };
}

function buildPayload(
  action: ResolvedAction,
  quote: QuoteInfo,
  duplicateOf: ProposalPayload['duplicateOf'],
  noReaction: boolean | undefined,
): ProposalPayload {
  const base: ProposalPayload = {
    reasoning: action.reasoning,
    origin: 'ai',
    quote: quote.quote,
    quoteAuthorName: quote.quoteAuthorName,
  };
  if (noReaction === true) base.noReaction = true;

  const targetProposalId = targetProposalIdOf(action);
  if (targetProposalId !== undefined) base.targetProposalId = targetProposalId;

  if (action.kind === 'create') {
    base.title = action.title;
    base.description = action.description;
    base.category = action.category;
    base.assignee = action.assignee;
    base.due = serializeDue(action.due);
    base.dueText = action.due.dueText;
    base.priority = action.priority;
    if (duplicateOf) base.duplicateOf = duplicateOf;
    return base;
  }

  if (action.kind === 'update') {
    const changes: NonNullable<ProposalPayload['changes']> = {};
    if (action.changes.due !== undefined) changes.due = serializeDue(action.changes.due);
    if (action.changes.assignee !== undefined) changes.assignee = action.changes.assignee;
    if (action.changes.title !== undefined) changes.title = action.changes.title;
    base.changes = changes;
    return base;
  }

  return base;
}

/**
 * Turns one claimed batch into proposals (plan.md Task 2.10, SPEC
 * §9.3-9.7): assembles the extractor's full input (participants, open
 * tasks/proposals, `skipped`-in-window context, and the batch's own
 * messages, with real reply-ref resolution — unlike `analyze.ts`'s
 * prefilter-only input), calls `deps.ai.extraction.extract` *outside* any
 * transaction, then resolves/policies/dedups the result and, in **one**
 * transaction, writes every resulting proposal (`shown` and `suppressed`
 * alike), marks the batch's messages `analyzed`, and marks the batch
 * `done`. A failure anywhere inside that transaction — including
 * `insertProposal` itself, per the brief's step 6 — rolls every write in it
 * back: no partial proposals, no messages flipped to `analyzed`, no `done`
 * batch; the caller (`analyzeJob`) sees the rejection and re-queues the
 * batch for retry exactly as it does for an extractor failure. Cards are
 * never sent here — that is the outbox's job (Task 2.12).
 */
export async function processBatch(
  deps: AppDeps,
  batch: BatchRow,
  opts?: ProcessBatchOptions,
): Promise<ProcessBatchResult> {
  if (!deps.ai) throw new Error('processBatch: deps.ai is null (AI analysis disabled)');
  const ai = deps.ai;
  const now = deps.clock.now();

  const batchMessages = await loadBatchMessages(deps.db, batch.id);
  if (batchMessages.length === 0) {
    await deps.db
      .update(analysisBatches)
      .set({ status: 'done', finishedAt: now, nextAttemptAt: null })
      .where(eq(analysisBatches.id, batch.id));
    return { shown: 0, suppressed: 0 };
  }

  const owner = await getOwner(deps.db, deps.workspace.id);
  if (!owner) throw new Error('processBatch: workspace has no owner');

  const members = await listMembersWithUsers(deps.db, deps.workspace.id);
  const participants = toParticipants(members);
  const usersById = new Map(members.map((m) => [m.user.id, m.user]));
  const displayNameByUserId = new Map(members.map((m) => [m.user.id, m.membership.displayName]));

  const skippedContext = await loadSkippedContext(deps.db, batch.chatId, batchMessages);
  const relevant = [...skippedContext, ...batchMessages];
  const tgIdToDbId = new Map(relevant.map((m) => [m.tgMessageId, m.id]));
  const dbIdToAuthor = new Map(relevant.map((m) => [m.id, m.authorUserId]));
  const messagesById = new Map(relevant.map((m) => [m.id, m]));

  const contextForLlm = skippedContext.map((row) => toMessageForLlm(row, usersById, tgIdToDbId));
  const newForLlm = batchMessages.map((row) => toMessageForLlm(row, usersById, tgIdToDbId));

  const openTasks = await loadOpenTasks(deps.db, deps.workspace.id, participants, owner.user.id);
  const openProposals = await loadOpenProposals(deps.db, deps.workspace.id);

  const settings = await getSettings(deps.db, deps.workspace.id);
  const prompt = loadPrompt({
    name: 'extractor',
    version: EXTRACTOR_PROMPT_VERSION,
    profile: deps.workspace.profile,
  });
  const input = buildExtractionInput(
    {
      now,
      workspaceTz: deps.workspace.timezone,
      participants,
      openTasks,
      openProposals,
      context: contextForLlm,
      messages: newForLlm,
    },
    prompt,
  );

  const startedAt = deps.clock.now();
  const extracted = await ai.extraction.extract(input);
  const finishedAt = deps.clock.now();

  const messagesForResolve: ResolveContext['messages'] = new Map();
  for (const m of [...contextForLlm, ...newForLlm]) {
    const replyToAuthorUserId =
      m.replyToMessageId !== null ? (dbIdToAuthor.get(m.replyToMessageId) ?? null) : null;
    messagesForResolve.set(m.id, { authorUserId: m.authorUserId, authorTz: m.authorTz, replyToAuthorUserId });
  }

  const resolveCtx: ResolveContext = {
    refs: input.refs,
    messages: messagesForResolve,
    ownerUserId: owner.user.id,
    workspaceTz: deps.workspace.timezone,
    now,
    fuzzy: settings.fuzzyTimes,
  };

  const { actions, dropped } = resolveActions(extracted.result, resolveCtx);
  if (dropped.length > 0) {
    // Indices and reasons only — never message text (CLAUDE.md §8/SPEC §18).
    deps.logger.warn({ batchId: batch.id, dropped }, 'processBatch: dropped actions with unresolved refs');
  }

  const mode: PolicyMode = opts?.mode ?? 'auto';
  const thresholds = settings.ai.thresholds;
  const batchIds = batchMessages.map((m) => m.id);

  const result = await deps.db.transaction(async (tx) => {
    let shown = 0;
    let suppressed = 0;
    const accepted: ResolvedAction[] = [];

    for (const action of actions) {
      if (isRepeatInBatch(accepted, action)) continue;
      accepted.push(action);

      const policy = applyPolicy(action, thresholds, mode);

      let duplicateOf: ProposalPayload['duplicateOf'];
      if (action.kind === 'create') {
        const match = await findPossibleDuplicate(tx, {
          workspaceId: deps.workspace.id,
          title: action.title,
          assignee: action.assignee,
          now,
        });
        if (match) duplicateOf = { type: match.type, id: match.id, title: match.title };
      }

      const quote = buildQuote(action, messagesById, displayNameByUserId);
      const payload = buildPayload(action, quote, duplicateOf, opts?.noReaction);

      const newProposal: NewProposal = {
        workspaceId: deps.workspace.id,
        chatId: batch.chatId,
        batchId: batch.id,
        kind: action.kind,
        category: action.kind === 'create' ? action.category : null,
        payload,
        targetTaskId: targetTaskIdOf(action),
        confidence: action.confidence,
        policyDecision: policy.decision,
        policyReason: policy.reason,
        sourceMessageIds: action.sourceMessageIds,
      };

      const inserted = await insertProposal(tx, newProposal);
      if (inserted.policyDecision === 'shown') shown += 1;
      else suppressed += 1;
    }

    await tx.update(messages).set({ analysisStatus: 'analyzed' }).where(inArray(messages.id, batchIds));

    const totals = accumulateUsage(batch, extracted.usage);
    await tx
      .update(analysisBatches)
      .set({
        status: 'done',
        finishedAt: now,
        model: extracted.model,
        promptVersion: input.promptVersion,
        // Preserves whatever the caller (`analyzeJob`'s prefilter step, when
        // it ran and decided to proceed) already set on the `batch` it
        // handed us — this function has no prefilter of its own to record.
        prefilterModel: batch.prefilterModel,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costUsd: totals.costUsd,
        latencyMs: finishedAt.getTime() - startedAt.getTime(),
        rawResponse: extracted.raw,
        nextAttemptAt: null,
      })
      .where(eq(analysisBatches.id, batch.id));

    return { shown, suppressed };
  });

  return result;
}
