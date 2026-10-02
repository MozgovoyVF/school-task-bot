import type { AppDeps } from '../../deps.js';
import { analysisBatches } from '../../db/schema/index.js';
import { EXTRACTOR_SINGLE_PROMPT_VERSION, MANUAL_FALLBACK_TITLE_MAX_CHARS } from '../../config/constants.js';
import { getOwner, listMembersWithUsers, type UserRow } from '../../domain/people/repo.js';
import { getSettings } from '../../domain/workspaces/repo.js';
import type { ParticipantForLlm } from '../pseudonymize.js';
import { loadPrompt } from '../prompts.js';
import { ExtractionError } from '../providers/types.js';
import { buildExtractionInput, type MessageForLlm } from './buildInput.js';
import { resolveActions, type ResolveContext, type ResolvedAction } from './resolve.js';

export type ExtractSingleDeps = Pick<AppDeps, 'db' | 'ai' | 'workspace' | 'logger'>;

export interface ExtractSingleInput {
  text: string;
  authorUserId: number;
  workspaceId: number;
  now: Date;
}

type CreateAction = Extract<ResolvedAction, { kind: 'create' }>;

/**
 * SPEC §9.3's participant projection, built from every current workspace member. Duplicated from
 * `src/ai/pipeline/processBatch.ts`'s own private `toParticipants` (itself duplicated from
 * `src/scheduler/jobs/analyze.ts`'s) rather than imported — same module-boundary/precedent reason both of
 * those document: this stays a small, self-contained pipeline step.
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
 * D19's fallback draft: a `create` action with `title` set to the first {@link
 * MANUAL_FALLBACK_TITLE_MAX_CHARS} *code points* (not UTF-16 units, matching every other truncation in this
 * codebase) of the raw text, no assignee, no due date, normal priority. Used both when the model is
 * unavailable entirely (`deps.ai === null`, or every model/attempt failed) and when a real call succeeded
 * but returned no usable `create` action — D19 treats both the same way. `category: 'owner_intent'` is a
 * placeholder only: nothing in the manual-creation flow ever displays `payload.category` for a `category:
 * 'manual'` proposal row (`src/scheduler/jobs/cards.ts`'s card always shows a "manual" label, driven by
 * `payload.origin`, not this field) — picked over e.g. `'assignment'` only because an unassigned fallback
 * reads slightly more naturally as "something to remember" than "something assigned to no one".
 */
function fallbackAction(text: string): CreateAction {
  const chars = Array.from(text.trim());
  const title = chars.slice(0, MANUAL_FALLBACK_TITLE_MAX_CHARS).join('');
  return {
    kind: 'create',
    category: 'owner_intent',
    title,
    description: null,
    assignee: { type: 'none' },
    due: { dueAt: null, allDay: false, tz: null, inPast: false, invalid: false, dueText: null },
    priority: 'normal',
    sourceMessageIds: [1],
    confidence: 0,
    // English on purpose (CLAUDE.md confines Cyrillic to `src/bot/texts/ru.ts`/`src/config/constants.ts`):
    // this `reasoning` is never shown to the Owner (unlike the model's own, SPEC-mandated Russian
    // `reasoning`) — it only ever lands in `proposals.payload`, read back (if at all) by a future debug tool.
    reasoning: 'manual draft: model unavailable or returned no create action (D19 fallback)',
  };
}

/**
 * Records this on-demand call's cost as its own `analysis_batches` row (`kind='manual'` — D5/D13: manual
 * LLM calls count toward the daily cost budget same as an automatic batch), independent of the
 * queued/running/done lifecycle `src/ai/pipeline/batcher.ts` drives for chat analysis — mirrors
 * `src/ai/pipeline/parseDate.ts`'s own `recordManualBatch` (duplicated, not imported — same reasoning: a
 * small, self-contained pipeline step, not worth a shared module for one struct literal). Never tied to a
 * chat (`chatId: null`) even for `/task` in a group — D5's own comment on this column: manual calls simply
 * aren't chat-scoped.
 */
async function recordManualBatch(
  deps: ExtractSingleDeps,
  args: {
    now: Date;
    model: string | null;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    error: string | null;
  },
): Promise<void> {
  await deps.db.insert(analysisBatches).values({
    chatId: null,
    status: 'done',
    kind: 'manual',
    messageCount: 1,
    promptVersion: args.promptVersion,
    model: args.model,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    costUsd: String(args.costUsd),
    error: args.error,
    attempts: 1,
    createdAt: args.now,
    finishedAt: args.now,
  });
}

/**
 * Finds the first resolved action that is actually a usable `create` — the extractor.single prompt
 * instructs the model to never return anything else (D19: "exactly one task"), but nothing here trusts
 * that instruction: an `update`/`complete`/`cancel` action, or no action at all (an empty `actions` array,
 * or every action dropped by `resolveActions` for an unresolved ref), is treated exactly like "the model
 * found nothing" rather than thrown on.
 */
function firstCreateAction(actions: readonly ResolvedAction[]): CreateAction | null {
  for (const action of actions) {
    if (action.kind === 'create') return action;
  }
  return null;
}

/**
 * The manual single-message extraction step (plan.md Task 3.10, D19): `/task` (in a group, replying to a
 * message or with inline text), DM free text, and a DM forward batch (D18) all funnel through this one
 * function to turn one piece of text into exactly one `create` action, via the `extractor.single.v1` prompt
 * (SPEC §12.1: "exactly one task", the auto-pipeline's confidence threshold never applies — enforced
 * downstream by `src/domain/proposals/repo.ts`'s `createManualProposal`, which always writes
 * `policyDecision: 'shown'` regardless of `confidence`). Builds the same kind of extractor input
 * `src/ai/pipeline/processBatch.ts` does (one participant projection, one synthetic message — `id: 1`, no
 * open tasks/proposals, no context window) and resolves the result through the same `resolveActions`
 * (`src/ai/pipeline/resolve.ts`) the batch pipeline uses, so an `assignee_ref`/due date the model resolves
 * against a real participant or "now" behaves identically either way.
 *
 * Returns the D19 fallback draft ({@link fallbackAction}) — title set to the first
 * {@link MANUAL_FALLBACK_TITLE_MAX_CHARS} characters of `input.text` — in three cases: AI is disabled
 * entirely (`deps.ai === null`, no DB access and no cost record at all, mirroring `parseDateText`'s own
 * `deps.ai === null` short-circuit); the extraction call itself failed on every model/attempt
 * ({@link ExtractionError}, its usage still recorded); or the call succeeded but produced no usable
 * `create` action ({@link firstCreateAction} returns `null`, the real usage still recorded). Any other
 * thrown error (a genuine bug, not a classified LLM failure) propagates — this function does not swallow
 * those.
 */
export async function extractSingle(
  deps: ExtractSingleDeps,
  input: ExtractSingleInput,
): Promise<CreateAction> {
  if (deps.ai === null) return fallbackAction(input.text);
  const ai = deps.ai;

  const members = await listMembersWithUsers(deps.db, input.workspaceId);
  const owner = await getOwner(deps.db, input.workspaceId);
  if (!owner) {
    deps.logger.warn(
      { workspaceId: input.workspaceId },
      'extractSingle: workspace has no owner yet — using the D19 fallback draft',
    );
    return fallbackAction(input.text);
  }

  const participants = toParticipants(members);
  const author = members.find((m) => m.user.id === input.authorUserId)?.user ?? null;

  const message: MessageForLlm = {
    id: 1,
    sentAt: input.now,
    authorUserId: input.authorUserId,
    authorTz: author?.timezone ?? null,
    text: input.text,
    replyToMessageId: null,
    replyQuote: null,
    isForward: false,
    forwardOriginName: null,
    forwardOriginUserId: null,
  };

  const prompt = loadPrompt({
    name: 'extractor.single',
    version: EXTRACTOR_SINGLE_PROMPT_VERSION,
    profile: deps.workspace.profile,
  });
  const promptInput = buildExtractionInput(
    {
      now: input.now,
      workspaceTz: deps.workspace.timezone,
      participants,
      openTasks: [],
      openProposals: [],
      context: [],
      messages: [message],
    },
    prompt,
  );

  let extracted;
  try {
    extracted = await ai.extraction.extract(promptInput);
  } catch (err) {
    if (!(err instanceof ExtractionError)) throw err;
    await recordManualBatch(deps, {
      now: input.now,
      model: null,
      promptVersion: promptInput.promptVersion,
      inputTokens: err.usage.inputTokens,
      outputTokens: err.usage.outputTokens,
      costUsd: err.usage.costUsd,
      error: 'extraction_failed',
    });
    return fallbackAction(input.text);
  }

  const settings = await getSettings(deps.db, input.workspaceId);
  const resolveCtx: ResolveContext = {
    refs: promptInput.refs,
    messages: new Map([
      [1, { authorUserId: input.authorUserId, authorTz: message.authorTz, replyToAuthorUserId: null }],
    ]),
    ownerUserId: owner.user.id,
    workspaceTz: deps.workspace.timezone,
    now: input.now,
    fuzzy: settings.fuzzyTimes,
  };
  const { actions } = resolveActions(extracted.result, resolveCtx);
  const createAction = firstCreateAction(actions);

  await recordManualBatch(deps, {
    now: input.now,
    model: extracted.model,
    promptVersion: promptInput.promptVersion,
    inputTokens: extracted.usage.inputTokens,
    outputTokens: extracted.usage.outputTokens,
    costUsd: extracted.usage.costUsd,
    error: null,
  });

  return createAction ?? fallbackAction(input.text);
}
