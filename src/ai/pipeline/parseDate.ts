import { DateTime } from 'luxon';
import type { AppDeps } from '../../deps.js';
import { analysisBatches } from '../../db/schema/index.js';
import { PARSE_DATE_PROMPT_VERSION } from '../../config/constants.js';
import { getSettings } from '../../domain/workspaces/repo.js';
import { resolveDue, type ResolvedDue } from '../../time/resolveDue.js';
import { pseudonymizeText } from '../pseudonymize.js';
import { loadPrompt, renderTemplate } from '../prompts.js';
import { Due } from '../schemas.js';

const PARSE_DATE_TIMEOUT_MS = 15_000;

/**
 * The `AppDeps` subset {@link parseDateText} actually needs — narrower than the brief's literal
 * `deps: AppDeps` signature, mirroring `src/domain/proposals/decide.ts`'s `DecideDeps` precedent
 * (documented there): callers only have to build what is actually read, and `src/bot/conversations/
 * editProposal.ts` can pass its own narrow deps type straight through with no adapter.
 */
export type ParseDateDeps = Pick<AppDeps, 'db' | 'ai' | 'workspace' | 'logger'>;

export interface ParseDateContext {
  zone: string;
  now: Date;
}

/**
 * Records this on-demand parse's cost as its own `analysis_batches` row (`kind='manual'` — D5: manual LLM
 * calls count toward the daily cost budget same as an automatic batch), independent of the
 * queued/running/done lifecycle `src/ai/pipeline/batcher.ts` drives for chat analysis: this call is
 * synchronous, on-demand from inside a conversation, and never tied to a chat (`chatId: null`), so it is
 * simply inserted already `done`, in one shot, never claimed/retried.
 */
async function recordManualBatch(
  deps: ParseDateDeps,
  args: {
    now: Date;
    model: string | null;
    promptVersion: string | null;
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
    messageCount: 0,
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
 * A `ResolvedDue` with no actual date (`dueAt === null`) or an impossible calendar date (`invalid`) both
 * mean "could not make sense of this phrase" from this free-text entry point specifically — unlike the
 * extractor's own `resolveDue` call, D23's quick-pick buttons already cover "no due date" on purpose (the
 * owner would press that button, not type free text, to mean that) — so the editProposal dialog (plan.md
 * Task 2.14) shows `texts.editProposal.dateNotParsed` for either case rather than a preview with no date
 * in it.
 */
function isUsableDue(due: ResolvedDue): boolean {
  return due.dueAt !== null && !due.invalid;
}

/**
 * Parses a free-text date/time phrase (the editProposal dialog's own free-text step, plan.md Task 2.14,
 * D23) via the `parseDate.v1` prompt and the extractor's own `Due` schema (`src/ai/schemas.ts`, shared
 * rather than duplicated), then resolves it to a concrete instant exactly the way the extractor's own
 * dates are (`resolveDue`, `src/time/resolveDue.ts`, fed `settings.fuzzyTimes` read fresh from the
 * workspace). Deliberately does not retry/fall back to a second model, unlike `LlmExtractionProvider`
 * (SPEC §9.2's extraction pipeline) — this is a single on-demand call inside a live dialog; on any
 * failure the owner just sees `texts.editProposal.dateNotParsed` and can retype the phrase, which is
 * simpler than a repair turn here. Returns `null` when the call itself fails, the response isn't valid
 * JSON, it doesn't match `Due`'s schema, or it resolves to "no date" ({@link isUsableDue}) — CLAUDE.md
 * §8: external LLM output is never trusted past its zod schema. Also `null` when AI is disabled
 * (`deps.ai === null`): this dialog step simply cannot work without a model to call.
 */
export async function parseDateText(
  deps: ParseDateDeps,
  text: string,
  ctx: ParseDateContext,
): Promise<ResolvedDue | null> {
  if (deps.ai === null) return null;
  const ai = deps.ai;

  const settings = await getSettings(deps.db, deps.workspace.id);
  const prompt = loadPrompt({
    name: 'parseDate',
    version: PARSE_DATE_PROMPT_VERSION,
    profile: deps.workspace.profile,
  });

  const nowLocal = DateTime.fromJSDate(ctx.now).setZone(ctx.zone);
  const userContent = renderTemplate(prompt.userTemplate, {
    now_local: nowLocal.toFormat('yyyy-MM-dd HH:mm'),
    weekday: nowLocal.setLocale('ru').toFormat('cccc'),
    workspace_tz: ctx.zone,
    // No participant list to resolve @usernames against here (a bare phrase, not a message from a known
    // author) — still pseudonymized (CLAUDE.md: every LLM call is), which still strips the format-only PII
    // (URLs, emails, phones, card numbers) that doesn't depend on knowing the participants.
    phrase: pseudonymizeText(text, []),
  });

  let response;
  try {
    response = await ai.client.complete({
      model: ai.models.primary,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: userContent },
      ],
      jsonSchema: null,
      timeoutMs: PARSE_DATE_TIMEOUT_MS,
    });
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'parseDateText: request failed',
    );
    await recordManualBatch(deps, {
      now: ctx.now,
      model: ai.models.primary,
      promptVersion: prompt.version,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: 'request_failed',
    });
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(response.content);
  } catch {
    await recordManualBatch(deps, {
      now: ctx.now,
      model: response.model,
      promptVersion: prompt.version,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.costUsd,
      error: 'invalid_json',
    });
    return null;
  }

  const parsed = Due.safeParse(raw);
  await recordManualBatch(deps, {
    now: ctx.now,
    model: response.model,
    promptVersion: prompt.version,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: response.usage.costUsd,
    error: parsed.success ? null : 'invalid_schema',
  });
  if (!parsed.success) return null;

  const resolved = resolveDue(parsed.data, { zone: ctx.zone, now: ctx.now, fuzzy: settings.fuzzyTimes });
  return isUsableDue(resolved) ? resolved : null;
}
