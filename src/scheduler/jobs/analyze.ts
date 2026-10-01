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
import { processBatch, ProcessBatchError } from '../../ai/pipeline/processBatch.js';
import type { ParticipantForLlm } from '../../ai/pseudonymize.js';
import { loadPrompt } from '../../ai/prompts.js';
import { ExtractionError, type Usage } from '../../ai/providers/types.js';
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

/**
 * SPEC §9.2: `analysis_batches`' token/cost columns accumulate across every
 * attempt made against that row — a batch that fails and is retried keeps
 * every prior attempt's spend on top of the new one, instead of the latest
 * attempt overwriting it. `batch` is the row as claimed at the *start* of
 * this attempt, so its `inputTokens`/`outputTokens`/`costUsd` are exactly
 * "everything spent on this batch before this attempt" (`null` for a
 * brand-new batch, i.e. its first attempt).
 */
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
  const totals = accumulateUsage(batch, args.usage);
  await db.transaction(async (tx) => {
    await tx.update(messages).set({ analysisStatus: 'analyzed' }).where(inArray(messages.id, messageIds));
    await tx
      .update(analysisBatches)
      .set({
        status: 'done',
        finishedAt: args.now,
        prefilterModel: args.prefilterModel,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costUsd: totals.costUsd,
        nextAttemptAt: null,
      })
      .where(eq(analysisBatches.id, batch.id));
  });
}

/**
 * Walks `err.cause` (and its own `.cause`, up to a few hops) looking for a
 * string `.code` — how a Postgres error identifies itself (`postgres.js`'s
 * `PostgresError`, e.g. `23505` for a unique violation), reachable either
 * directly or through however many wrapper errors sit on top of it (e.g.
 * `processBatch`'s own `ProcessBatchError` wrapping drizzle's
 * `DrizzleQueryError` wrapping the `PostgresError`). The hop limit guards
 * against an accidental circular `cause` chain, which should never happen
 * but costs nothing to guard against.
 */
function errorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let hop = 0; hop < 4 && current instanceof Error; hop += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return null;
}

/**
 * Review round 1, I1: turns any thrown error into an ID-safe summary for
 * `analysis_batches.error` and the superadmin alert (CLAUDE.md §8/SPEC
 * §18 — no message text, no names; also keeps the alert well under
 * Telegram's 4096-char limit). `ExtractionError.message` is already a
 * static, safe string (`'extraction failed on every model/attempt'`) and is
 * used as-is. Everything else — in particular a `ProcessBatchError` from
 * `processBatch`'s transaction (`insertProposal`, etc.) — can wrap a
 * drizzle `DrizzleQueryError`, whose own `.message` embeds the failed query
 * *and its bound parameters*: since those parameters can be
 * `payload.quote` (message text) or `payload.quoteAuthorName` (a real
 * name), only `err.name` plus, when found, a Postgres error code from
 * {@link errorCode} ever survive into the summary — never `err.message`
 * itself.
 */
function summarizeError(err: unknown): string {
  if (err instanceof ExtractionError) return err.message;
  if (!(err instanceof Error)) return 'unknown error';
  const code = errorCode(err);
  return code !== null ? `${err.name} (code=${code})` : err.name;
}

/**
 * SPEC §8/§9.2: on failure, the batch's messages are left untouched
 * (`pending`) — only the batch row moves, either back to `queued` with
 * backoff (via {@link nextAttemptAt}) or, after its 5th failed attempt, to
 * `failed` with a superadmin alert. Either way the consecutive-failure
 * streak is bumped, and `usage` (this attempt's prefilter + — if the
 * extractor was reached and itself failed — its billed-but-unparseable
 * `ExtractionError.usage`, or `processBatch`'s own `ProcessBatchError.usage`
 * for a post-extraction failure) is accumulated onto the batch's running
 * token/cost totals via {@link accumulateUsage}: a model that returns
 * billed, invalid JSON on every attempt still spends real money, and that
 * spend must count toward `spentTodayUsd` even though the batch never
 * succeeds (SPEC §9.2's budget cap would otherwise never trip).
 */
async function markFailedOrRetry(
  deps: AppDeps,
  batch: BatchRow,
  err: unknown,
  usage: Usage,
  now: Date,
): Promise<void> {
  const message = summarizeError(err);
  const attempts = batch.attempts + 1;
  const next = nextAttemptAt(attempts, now);
  const totals = accumulateUsage(batch, usage);

  if (next === null) {
    await deps.db
      .update(analysisBatches)
      .set({
        status: 'failed',
        attempts,
        error: message,
        finishedAt: now,
        nextAttemptAt: null,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costUsd: totals.costUsd,
      })
      .where(eq(analysisBatches.id, batch.id));
    await deps.errors.alert(`batch-failed:${String(batch.id)}`, texts.errors.batchFailed(batch.id, message));
  } else {
    await deps.db
      .update(analysisBatches)
      .set({
        status: 'queued',
        attempts,
        error: message,
        nextAttemptAt: next,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costUsd: totals.costUsd,
      })
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

  // Accumulated *this attempt's* usage only (prefilter, plus the extractor's
  // if it failed before `processBatch` could record its own) —
  // `markFailedOrRetry`/`processBatch`'s `accumulateUsage` add it on top of
  // the batch's own running totals from any earlier attempt. Read outside
  // the `try` so the `catch` below can still see whatever was spent before
  // the throw (SPEC §9.2 — every attempt's spend counts, success or
  // failure).
  let usage = zeroUsage();
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

    // From here on, `processBatch` (Task 2.10) owns everything: it builds
    // its own fuller extraction input (participants, open tasks/proposals,
    // recent chat context, real reply-ref resolution — `input` above is
    // only ever the prefilter's deliberately trivial version), the
    // extractor call itself, and resolving/policying/deduping the result
    // into proposals, all the way through marking the batch's messages
    // `analyzed` and the batch `done`, in one transaction. `usage`/
    // `prefilterModel` are folded into an in-memory copy of `batch` first
    // so `processBatch`'s own bookkeeping (`accumulateUsage`, and its
    // `prefilterModel` passthrough — it has no prefilter of its own) adds
    // its spend on top of what the prefilter above already spent, instead
    // of losing it. A failure *after* `processBatch`'s own extraction call
    // succeeds no longer loses that call's usage either (review round 1,
    // M1) — it surfaces as `ProcessBatchError`, folded in below exactly
    // like `ExtractionError`.
    const batchWithPrefilter: BatchRow = {
      ...batch,
      inputTokens: (batch.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (batch.outputTokens ?? 0) + usage.outputTokens,
      costUsd: String(Number(batch.costUsd ?? 0) + usage.costUsd),
      prefilterModel,
    };
    // `kind === 'reanalyze'` (Task 2.15's `/reanalyze <chat> <N>`, superadmin-only) always suppresses the
    // 👀 reaction on its source messages — `src/domain/proposals/queries.ts`'s `createReanalyzeBatch`
    // builds the batch itself but has no way to stamp this onto the row (`analysis_batches` carries no
    // `noReaction` column, only `kind`), so it is derived here, at the one place that actually calls
    // `processBatch` for every batch kind alike (`ProcessBatchOptions.noReaction`, Task 2.10).
    await processBatch(deps, batchWithPrefilter, { mode: 'auto', noReaction: batch.kind === 'reanalyze' });
    await resetConsecutiveFailures(deps.db, now);
  } catch (err) {
    // `ExtractionError.usage` sums every attempt the extractor itself made
    // (all of it billed even though none parsed) — fold it into this
    // attempt's usage so a billed-but-invalid response is never lost, on
    // top of whatever the prefilter already spent above. `ProcessBatchError`
    // (review round 1, M1) is the same idea for a failure *after* a
    // successful extraction call: `processBatch` couldn't record that
    // call's usage on the batch itself (its own transaction rolled back),
    // so it carries it back out this way instead.
    if (err instanceof ExtractionError || err instanceof ProcessBatchError) {
      usage = sumUsage(usage, err.usage);
    }
    await markFailedOrRetry(deps, batch, err, usage, now);
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

/** `analysis_batches.kind` values claimed while the daily budget is exceeded — SPEC.md:260 (manual commands keep working), only auto-created batches pause (review round, M2). */
const MANUAL_BATCH_KINDS = ['manual', 'reanalyze'] as const;

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
 * calendar day (in the workspace's timezone). Once paused, only manual
 * batches (`kind='manual'`/`'reanalyze'`) are still claimed and processed —
 * SPEC.md:260 promises manual commands keep working even while auto-analysis
 * is paused (review round, M2); their cost still counts toward the budget
 * via the same `accumulateUsage`/`markFailedOrRetry` bookkeeping every other
 * batch goes through.
 */
export const analyzeJob: Job = {
  name: 'analyze',
  async run(deps) {
    if (!deps.ai) return;
    const now = deps.clock.now();

    await recoverStaleBatches(deps.db, { now });
    await enqueueBatches(deps.db, { now });

    const spent = await spentTodayUsd(deps.db, { now, tz: deps.workspace.timezone });
    const budgetPaused = spent >= deps.config.LLM_DAILY_BUDGET_USD;
    if (budgetPaused) {
      await maybeAlertBudgetPaused(deps, now, spent);
    }

    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      // Fresh per batch, not the tick's `now` above: up to 5 batches run
      // sequentially here, each potentially a real (slow) LLM call, so
      // reusing one timestamp across all of them would let backoff/latency
      // bookkeeping drift from wall-clock reality on a long tick.
      const batchNow = deps.clock.now();
      const batch = await claimNextBatch(deps.db, {
        now: batchNow,
        kinds: budgetPaused ? MANUAL_BATCH_KINDS : undefined,
      });
      if (!batch) break;
      await runOneBatch(deps, batch, batchNow);
    }
  },
};
