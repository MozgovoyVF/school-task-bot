import { asc, eq, inArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  EXTRACTOR_PROMPT_VERSION,
  LLM_CONSECUTIVE_FAILURES_ALERT_THRESHOLD,
  MAX_BATCHES_PER_TICK,
} from '../../config/constants.js';
import { buildExtractionInput, type MessageForLlm } from '../../ai/pipeline/buildInput.js';
import {
  claimNextBatch,
  enqueueBatches,
  nextAttemptAt,
  recoverStaleBatches,
  type BatchRow,
} from '../../ai/pipeline/batcher.js';
import { spentTodayUsd } from '../../ai/budget.js';
import type { ParticipantForLlm } from '../../ai/pseudonymize.js';
import { loadPrompt } from '../../ai/prompts.js';
import type { Usage } from '../../ai/providers/types.js';
import { texts } from '../../bot/texts/ru.js';
import type { AppDeps } from '../../deps.js';
import type { DbOrTx } from '../../db/client.js';
import { analysisBatches, messages } from '../../db/schema/index.js';
import type { MessageRow } from '../../domain/chats/messages.js';
import { getOwner, listMembersWithUsers, type UserRow } from '../../domain/people/repo.js';
import { getState, setState } from '../../domain/system/appState.js';
import type { Job } from '../ticker.js';

const CONSECUTIVE_FAILURES_KEY = 'llm:consecutive_failures';
const BUDGET_PAUSED_THROTTLE_MS = 24 * 60 * 60 * 1000;

const ConsecutiveFailuresState = z.object({ count: z.number().int().nonnegative() });
const BudgetPausedState = z.object({ notifiedAt: z.string() });

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function sumUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

async function resetConsecutiveFailures(db: DbOrTx, now: Date): Promise<void> {
  await setState(db, CONSECUTIVE_FAILURES_KEY, { count: 0 }, now);
}

/**
 * SPEC §8/§9.2: alerts superadmin once the streak of consecutive LLM-call
 * failures (across *different* batches — a within-batch retry is its own,
 * separate backoff/give-up path, see {@link markFailedOrRetry}) reaches
 * {@link LLM_CONSECUTIVE_FAILURES_ALERT_THRESHOLD}, then resets the streak
 * so the next 5-in-a-row triggers a fresh alert instead of firing every
 * single failure from then on.
 */
async function bumpConsecutiveFailures(deps: AppDeps, now: Date): Promise<void> {
  const state = await getState(deps.db, CONSECUTIVE_FAILURES_KEY, ConsecutiveFailuresState);
  const count = (state?.count ?? 0) + 1;
  if (count >= LLM_CONSECUTIVE_FAILURES_ALERT_THRESHOLD) {
    await deps.errors.alert('llm-consecutive-failures', texts.errors.llmConsecutiveFailures(count));
    await setState(deps.db, CONSECUTIVE_FAILURES_KEY, { count: 0 }, now);
  } else {
    await setState(deps.db, CONSECUTIVE_FAILURES_KEY, { count }, now);
  }
}

/**
 * SPEC §9.3's participant projection, built from every current workspace
 * member (not just this batch's message authors — an assignee the extractor
 * resolves a task to may never have posted in this particular batch).
 * Codes are assigned `P1`, `P2`, … in membership order (stable — `id`
 * order, per {@link listMembersWithUsers}); the Owner still gets a `P#`
 * code too (rendered as `P#/OWNER` by `buildExtractionInput`), per SPEC
 * §9.3's `P0/OWNER: <name>` example.
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

/**
 * A DB message row → `buildExtractionInput`'s `MessageForLlm`. Reply-target
 * resolution (`replyToTgMessageId` → the internal id of the replied-to row)
 * and forward-author resolution are left out here — `messages` does not
 * store a forward author id at all, and resolving a reply to a ref needs
 * the same chat's full message history, which is Task 2.10's fuller input
 * assembly to build (it also wires in open tasks/proposals context, SPEC
 * §9.3). Leaving them out never drops the message itself, only a "reply
 * to"/"forwarded from a participant" hint in the rendered prompt —
 * `formatForwardSegment` still falls back to the freeform
 * `forwardOriginName` when there is one.
 */
function toMessageForLlm(row: MessageRow, usersById: ReadonlyMap<number, UserRow>): MessageForLlm {
  if (row.authorUserId === null) {
    // Should not happen — `saveIncomingMessage` always writes a real author.
    // Surfacing this as a thrown error (caught by `runOneBatch`, handled as
    // a batch failure with backoff/alerting) is safer than silently
    // skipping the message's content out of the LLM call.
    throw new Error(`analyzeJob: message ${String(row.id)} has no author`);
  }
  const author = usersById.get(row.authorUserId);
  return {
    id: row.id,
    sentAt: row.sentAt,
    authorUserId: row.authorUserId,
    authorTz: author?.timezone ?? null,
    text: row.text ?? '',
    replyToMessageId: null,
    replyQuote: row.replyToQuote,
    isForward: row.isForward,
    forwardOriginName: row.forwardOriginName,
    forwardOriginUserId: null,
  };
}

async function loadBatchMessages(db: DbOrTx, batchId: number): Promise<MessageRow[]> {
  return db.select().from(messages).where(eq(messages.batchId, batchId)).orderBy(asc(messages.sentAt));
}

/**
 * SPEC §9.4: the prefilter decided this batch has nothing actionable —
 * its messages go straight to `analyzed` with no extractor call and no
 * proposals, and the prefilter's own usage is still recorded on the batch
 * (SPEC §9.2: every LLM call's cost counts toward the daily budget).
 */
async function markSkippedByPrefilter(
  db: DbOrTx,
  batch: BatchRow,
  messageIds: number[],
  args: { prefilterModel: string; usage: Usage; now: Date },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(messages).set({ analysisStatus: 'analyzed' }).where(inArray(messages.id, messageIds));
    await tx
      .update(analysisBatches)
      .set({
        status: 'done',
        finishedAt: args.now,
        prefilterModel: args.prefilterModel,
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        costUsd: String(args.usage.costUsd),
        nextAttemptAt: null,
      })
      .where(eq(analysisBatches.id, batch.id));
  });
}

/**
 * The extractor call succeeded. This deliberately stops at recording the
 * call's own bookkeeping (model, tokens, cost, latency, raw response) and
 * marking the messages `analyzed` — turning `extracted`'s actions into
 * `proposals` (resolving refs/dates, policy, dedup, all in one transaction
 * with this same bookkeeping) is Task 2.10's `processBatch`, which does not
 * exist yet. See this task's report for why: none of this task's brief
 * covers that path, and building it here would need open
 * tasks/proposals/participant context this job does not assemble. Marking
 * `analyzed` now (not leaving the batch `running`) is still required for
 * correctness — otherwise `recoverStaleBatches` would re-claim and
 * re-extract (and re-spend budget on) the same batch forever.
 */
async function markDone(
  db: DbOrTx,
  batch: BatchRow,
  messageIds: number[],
  args: {
    model: string;
    promptVersion: string;
    prefilterModel: string | null;
    usage: Usage;
    raw: unknown;
    latencyMs: number;
    now: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(messages).set({ analysisStatus: 'analyzed' }).where(inArray(messages.id, messageIds));
    await tx
      .update(analysisBatches)
      .set({
        status: 'done',
        finishedAt: args.now,
        model: args.model,
        promptVersion: args.promptVersion,
        prefilterModel: args.prefilterModel,
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        costUsd: String(args.usage.costUsd),
        latencyMs: args.latencyMs,
        rawResponse: args.raw,
        nextAttemptAt: null,
      })
      .where(eq(analysisBatches.id, batch.id));
  });
}

/**
 * SPEC §8: on failure, the batch's messages are left untouched (`pending`)
 * — only the batch row moves, either back to `queued` with backoff (via
 * {@link nextAttemptAt}) or, after its 5th failed attempt, to `failed` with
 * a superadmin alert. Either way the consecutive-failure streak is bumped.
 */
async function markFailedOrRetry(deps: AppDeps, batch: BatchRow, err: unknown, now: Date): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = batch.attempts + 1;
  const next = nextAttemptAt(attempts, now);

  if (next === null) {
    await deps.db
      .update(analysisBatches)
      .set({ status: 'failed', attempts, error: message, finishedAt: now, nextAttemptAt: null })
      .where(eq(analysisBatches.id, batch.id));
    await deps.errors.alert(`batch-failed:${String(batch.id)}`, texts.errors.batchFailed(batch.id, message));
  } else {
    await deps.db
      .update(analysisBatches)
      .set({ status: 'queued', attempts, error: message, nextAttemptAt: next })
      .where(eq(analysisBatches.id, batch.id));
  }

  await bumpConsecutiveFailures(deps, now);
}

/**
 * Runs one already-`claimNextBatch`-claimed batch through the prefilter
 * (if configured) and the extractor, and always leaves it in a terminal or
 * requeued state (`done`/`failed`/back to `queued`) — never `running` —
 * regardless of whether the call succeeded, was skipped, or threw.
 */
async function runOneBatch(deps: AppDeps, batch: BatchRow, now: Date): Promise<void> {
  const ai = deps.ai;
  if (!ai) return; // defensive — the caller already checked

  const batchMessages = await loadBatchMessages(deps.db, batch.id);
  if (batchMessages.length === 0) {
    await deps.db
      .update(analysisBatches)
      .set({ status: 'done', finishedAt: now, nextAttemptAt: null })
      .where(eq(analysisBatches.id, batch.id));
    return;
  }
  const messageIds = batchMessages.map((m) => m.id);

  try {
    const members = await listMembersWithUsers(deps.db, deps.workspace.id);
    const participants = toParticipants(members);
    const usersById = new Map(members.map((m) => [m.user.id, m.user]));
    const messagesForLlm = batchMessages.map((row) => toMessageForLlm(row, usersById));

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
        openTasks: [],
        openProposals: [],
        context: [],
        messages: messagesForLlm,
      },
      prompt,
    );

    let usage = zeroUsage();
    let prefilterModel: string | null = null;

    if (ai.decision) {
      const decision = await ai.decision.hasActionableContent({ messages: input.messages });
      usage = sumUsage(usage, decision.usage);
      prefilterModel = decision.model;
      if (decision.probability < deps.config.AI_PREFILTER_THRESHOLD) {
        await markSkippedByPrefilter(deps.db, batch, messageIds, { prefilterModel, usage, now });
        await resetConsecutiveFailures(deps.db, now);
        return;
      }
    }

    const startedAt = deps.clock.now();
    const extracted = await ai.extraction.extract(input);
    const finishedAt = deps.clock.now();
    usage = sumUsage(usage, extracted.usage);

    await markDone(deps.db, batch, messageIds, {
      model: extracted.model,
      promptVersion: input.promptVersion,
      prefilterModel,
      usage,
      raw: extracted.raw,
      latencyMs: finishedAt.getTime() - startedAt.getTime(),
      now,
    });
    await resetConsecutiveFailures(deps.db, now);
  } catch (err) {
    await markFailedOrRetry(deps, batch, err, now);
  }
}

/**
 * SPEC §9.2: once `spentTodayUsd` reaches `LLM_DAILY_BUDGET_USD`, superadmin
 * and the Owner each get one alert per calendar day (in the workspace's
 * timezone) — deduped via `app_state['budget:paused:<date>']`, per plan.md
 * Task 2.9 step 3, rather than `ErrorReporter.alert`'s own hourly throttle
 * (which would otherwise re-notify every hour the pause continues).
 */
async function maybeAlertBudgetPaused(deps: AppDeps, now: Date, spent: number): Promise<void> {
  const dateKey = DateTime.fromJSDate(now).setZone(deps.workspace.timezone).toFormat('yyyy-MM-dd');
  const stateKey = `budget:paused:${dateKey}`;
  const existing = await getState(deps.db, stateKey, BudgetPausedState);
  if (existing) return;

  const owner = await getOwner(deps.db, deps.workspace.id);
  const alsoTo = owner ? [owner.user.tgUserId] : [];
  await deps.errors.alert(
    `budget-paused:${dateKey}`,
    texts.errors.budgetPaused(spent, deps.config.LLM_DAILY_BUDGET_USD),
    { alsoTo, throttleMs: BUDGET_PAUSED_THROTTLE_MS },
  );
  await setState(deps.db, stateKey, { notifiedAt: now.toISOString() }, now);
}

/**
 * SPEC §8/§9.2, plan.md Task 2.9: the ticker job that turns pending group
 * messages into `analysis_batches` and runs them through the LLM
 * (prefilter, then the extractor). No-ops entirely when `deps.ai` is
 * `null` (AI analysis disabled — SPEC §9.2/D5's env-gated fallback):
 * nothing is batched, nothing is claimed, no message is touched.
 *
 * Fixed order (plan.md Task 2.9 step 3): recover stale `running` batches →
 * enqueue new ones → check today's spend against `LLM_DAILY_BUDGET_USD` →
 * claim and process up to `MAX_BATCHES_PER_TICK` batches. The budget check
 * runs *after* `enqueueBatches`, so messages keep getting grouped into
 * batches even while paused (SPEC §9.2: messages pile up rather than being
 * dropped) — they are simply never claimed until spend resets on the next
 * calendar day (in the workspace's timezone).
 */
export const analyzeJob: Job = {
  name: 'analyze',
  async run(deps) {
    if (!deps.ai) return;
    const now = deps.clock.now();

    await recoverStaleBatches(deps.db, { now });
    await enqueueBatches(deps.db, { now });

    const spent = await spentTodayUsd(deps.db, { now, tz: deps.workspace.timezone });
    if (spent >= deps.config.LLM_DAILY_BUDGET_USD) {
      await maybeAlertBudgetPaused(deps, now, spent);
      return;
    }

    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      const batch = await claimNextBatch(deps.db, { now });
      if (!batch) break;
      await runOneBatch(deps, batch, now);
    }
  },
};
