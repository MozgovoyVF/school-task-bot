import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline/promises';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { EXTRACTOR_PROMPT_VERSION } from '../src/config/constants.js';
import type { ActionT, DueT, ExtractionResultT } from '../src/ai/schemas.js';
import { ExtractionResult, extractionJsonSchema } from '../src/ai/schemas.js';
import { ExtractionError, type ExtractionProvider } from '../src/ai/providers/types.js';
import { createOpenRouterClient } from '../src/ai/providers/openrouter.js';
import { LlmExtractionProvider } from '../src/ai/pipeline/extract.js';
import {
  buildExtractionInput,
  type AssigneeResolution as PromptAssignee,
  type ExtractionInput,
  type MessageForLlm,
  type OpenProposalForLlm,
  type OpenTaskForLlm,
} from '../src/ai/pipeline/buildInput.js';
import {
  resolveActions,
  type AssigneeResolution as ResolvedAssignee,
  type ResolveContext,
} from '../src/ai/pipeline/resolve.js';
import { applyPolicy } from '../src/ai/pipeline/policy.js';
import { resolveDue } from '../src/time/resolveDue.js';
import { loadPrompt, type PromptBundle } from '../src/ai/prompts.js';
import type { ParticipantForLlm } from '../src/ai/pseudonymize.js';
import { SettingsSchema, type Settings } from '../src/domain/settings/schema.js';
import { EvalCaseSchema, type EvalCase } from './schema.js';
import {
  computeMetrics,
  explainRow,
  participantCodeToUserId,
  EVAL_OWNER_USER_ID,
  type EvalRow,
  type Metrics,
} from './metrics.js';
import {
  renderReport,
  reportFileName,
  reportableFailures,
  comparisonRow,
  COMPARISON_HEADER,
  type ReportMeta,
} from './report.js';
import { estimateCostUsd, fetchModelPricing } from './pricing.js';

// plan.md Task 2.17 / SPEC §21 — `pnpm eval`'s CLI entry point. Exercises a
// slice of the same extract -> resolve -> policy pipeline `processBatch`
// runs in production (SPEC §9), but against synthetic in-memory `EvalCase`
// data instead of persisted messages/batches/proposals (no DB at all here).
//
// Synthetic-id convention: since there is no DB, `run.ts` assigns its own
// participant/task/proposal ids for each case rather than reusing real
// rows. Two conventions matter and must stay in sync with `metrics.ts`:
//   - participant userId = `participantCodeToUserId(code)` (`P7` -> 7,
//     `OWNER` -> `EVAL_OWNER_USER_ID`) — `metrics.ts`'s `assigneeMatches`
//     decodes an `EvalCase`'s expected `assignee` string back through this
//     same function, so a predicted `AssigneeResolution.userId` compares
//     correctly without needing a separate ref map at scoring time.
//   - an open task/proposal's id = its 1-based position in
//     `openTasks`/`openProposals` — this is exactly what the dataset's own
//     `ref` field already encodes (`T1`, `R1`, verified against every case
//     in `eval/datasets/school_ru.v1.jsonl`: refs always match position),
//     so `buildExtractionInput`'s generated `T<id>`/`R<id>` refs land on
//     the same strings the dataset's `expected[].targetRef` already uses.
//
// `--prefilter` is accepted and validated (SPEC §9.4's `off`/`llm`/`jev`
// modes, matching `AI_PREFILTER` in `src/config/env.ts`) and recorded in
// the report's metadata, but is not actually exercised: there is no
// concrete `DecisionProvider` implementation anywhere in the codebase yet
// (`src/ai/providers/types.ts`'s `DecisionProvider` interface has no
// `llm`/`jev` implementation to call) — only extract -> resolve -> policy
// runs here, matching the brief's own framing of this task's pipeline
// slice. A future task that adds a prefilter provider would wire this flag
// up for real.

const REPORTS_DIR = 'eval/reports';
const DATASET_PATH = 'eval/datasets/school_ru.v1.jsonl';

// -- CLI args ----------------------------------------------------------

interface CliArgs {
  model: string | null;
  fallback: string | null;
  prefilter: 'off' | 'llm' | 'jev';
  promptVersion: string;
  limit: number | null;
  concurrency: number;
  yes: boolean;
  provider: 'openrouter' | 'fixture';
}

// External input (process.argv), so it goes through zod (CLAUDE.md §8).
// `yes` is a real boolean by construction (see parseArgv: a bare `--yes`
// with no attached value is recorded as the boolean `true`, never a string
// coerced through zod) — CLAUDE.md's "no `z.coerce.boolean()`" rule is
// about not trusting a string like "false" to coerce truthy, which never
// arises here.
const RawCliArgsSchema = z.object({
  model: z.string().optional(),
  fallback: z.string().optional(),
  prefilter: z.enum(['off', 'llm', 'jev']).default('off'),
  promptVersion: z.string().default(EXTRACTOR_PROMPT_VERSION),
  limit: z.coerce.number().int().positive().optional(),
  concurrency: z.coerce.number().int().positive().default(4),
  yes: z.boolean().default(false),
  provider: z.enum(['openrouter', 'fixture']).default('fixture'),
});

function toCamelCase(key: string): string {
  return key.replace(/-([a-z])/g, (_match, c: string) => c.toUpperCase());
}

/** Minimal hand-rolled `--flag value` / `--flag` parser (no CLI-args dependency in SPEC §4's allowlist). */
function parseArgv(argv: readonly string[]): CliArgs {
  const raw: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = toCamelCase(token.slice(2));
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      raw[key] = next;
      i += 1;
    } else {
      raw[key] = true;
    }
  }
  const parsed = RawCliArgsSchema.parse(raw);
  return {
    model: parsed.model ?? null,
    fallback: parsed.fallback ?? null,
    prefilter: parsed.prefilter,
    promptVersion: parsed.promptVersion,
    limit: parsed.limit ?? null,
    concurrency: parsed.concurrency,
    yes: parsed.yes,
    provider: parsed.provider,
  };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// -- Dataset -------------------------------------------------------------

/** Deterministic, evenly spaced sample of `limit` items (same cases for every model). */
function spreadSample<T>(items: readonly T[], limit: number): T[] {
  if (limit >= items.length) return [...items];
  const step = items.length / limit;
  const picked: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    const item = items[Math.floor(i * step)];
    if (item !== undefined) picked.push(item);
  }
  return picked;
}

function loadDataset(path: string): EvalCase[] {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => EvalCaseSchema.parse(JSON.parse(line) as unknown));
}

// -- EvalCase -> pipeline input -------------------------------------------

function toPromptAssignee(code: string | null): PromptAssignee {
  if (code === null) return { kind: 'none' };
  if (code === 'ALL') return { kind: 'all' };
  if (code === 'OWNER') return { kind: 'owner' };
  return { kind: 'participant', code };
}

/** D47 (plan.md Task 3.15): an eval case's open-task assignee code -> `resolve.ts`'s own `AssigneeResolution`
 * (for `ResolveContext.targetTasks`) — eval cases only ever carry a participant code for an open task's
 * assignee (`EvalCase`'s schema has no free-text-name case), so unlike `processBatch.ts`'s real `taskAssignee`
 * this never produces a `'text'` result. */
function toResolvedAssignee(code: string | null): ResolvedAssignee {
  if (code === null) return { type: 'none' };
  if (code === 'ALL') return { type: 'all' };
  return { type: 'user', userId: participantCodeToUserId(code) };
}

function parseOpenItemDue(due: string | null, zone: string): { dueAt: Date | null; dueAllDay: boolean } {
  if (due === null) return { dueAt: null, dueAllDay: false };
  const dt = DateTime.fromISO(due, { zone });
  if (!dt.isValid) return { dueAt: null, dueAllDay: false };
  return { dueAt: dt.toJSDate(), dueAllDay: !due.includes('T') };
}

type ExpectedAction = EvalCase['expected'][number];
type ExpectedDue = NonNullable<ExpectedAction['due']>;

/** `EvalCase`'s `{date, time, hint}` -> the extractor's own `DueT` wire shape, so both the expected side (via `resolveDue`, for scoring) and the fixture provider (as a synthesized "perfect" prediction) go through the exact resolver production uses. */
function toDueT(due: ExpectedDue): DueT {
  const dueLocal = due.date === null ? null : due.time !== null ? `${due.date}T${due.time}` : due.date;
  return { due_local: dueLocal, time_hint: due.hint, due_text: null };
}

interface BuiltMessages {
  context: MessageForLlm[];
  messages: MessageForLlm[];
  forResolve: ResolveContext['messages'];
}

function convertContextMessage(
  m: EvalCase['context'][number],
  refToId: Map<string, number>,
  tzByCode: ReadonlyMap<string, string | null>,
  id: number,
): MessageForLlm {
  refToId.set(m.ref, id);
  return {
    id,
    sentAt: new Date(m.at),
    authorUserId: participantCodeToUserId(m.author),
    authorTz: tzByCode.get(m.author) ?? null,
    text: m.text,
    replyToMessageId: null,
    replyQuote: null,
    isForward: false,
    forwardOriginName: null,
    forwardOriginUserId: null,
  };
}

function convertNewMessage(
  m: EvalCase['messages'][number],
  refToId: Map<string, number>,
  tzByCode: ReadonlyMap<string, string | null>,
  id: number,
): MessageForLlm {
  refToId.set(m.ref, id);
  const forward = m.forwardFrom ?? null;
  return {
    id,
    sentAt: new Date(m.at),
    authorUserId: participantCodeToUserId(m.author),
    authorTz: tzByCode.get(m.author) ?? null,
    text: m.text,
    replyToMessageId: m.replyTo !== undefined ? (refToId.get(m.replyTo) ?? null) : null,
    replyQuote: null,
    isForward: forward !== null,
    forwardOriginName: forward,
    forwardOriginUserId: null,
  };
}

/** Mirrors `processBatch.ts`'s own message assembly (context first, then the batch's own messages, refs resolved in send order) against synthetic ids instead of DB rows. */
function buildMessages(evalCase: EvalCase): BuiltMessages {
  const tzByCode = new Map(evalCase.participants.map((p) => [p.code, p.tz ?? null] as const));
  const refToId = new Map<string, number>();
  let nextId = 1;

  const context = evalCase.context.map((m) => {
    const built = convertContextMessage(m, refToId, tzByCode, nextId);
    nextId += 1;
    return built;
  });
  const messages = evalCase.messages.map((m) => {
    const built = convertNewMessage(m, refToId, tzByCode, nextId);
    nextId += 1;
    return built;
  });

  const byId = new Map<number, MessageForLlm>();
  for (const m of [...context, ...messages]) byId.set(m.id, m);

  const forResolve: ResolveContext['messages'] = new Map();
  for (const m of [...context, ...messages]) {
    const replyToAuthorUserId =
      m.replyToMessageId !== null ? (byId.get(m.replyToMessageId)?.authorUserId ?? null) : null;
    forResolve.set(m.id, { authorUserId: m.authorUserId, authorTz: m.authorTz, replyToAuthorUserId });
  }

  return { context, messages, forResolve };
}

// -- Fixture provider: a deterministic "perfect" echo ---------------------

/**
 * `--provider fixture` (brief step 3: "отвечает эталоном: даёт метрики 1.0
 * и служит smoke-проверкой без затрат"). Ignores the real prompt text
 * entirely and instead re-derives, from the case's own `expected[]`, the
 * `ExtractionResultT` a perfect extractor would have produced — so running
 * a case through `resolveActions`/`applyPolicy` afterwards reproduces
 * `expected` almost exactly (modulo `title`/`description`, which
 * `computeMetrics` never scores). This is a smoke test for the eval
 * pipeline's own plumbing (buildInput -> resolve -> policy -> metrics), not
 * a real model evaluation — no network call is made, and its report is
 * named `*.local.md` (gitignored) and never appended to `COMPARISON.md`,
 * so it can never be mistaken for a real model's score. Zero cost, zero
 * usage.
 */
function buildFixtureExtractionProvider(evalCase: EvalCase): ExtractionProvider {
  return {
    extract(input) {
      const newMessageRefs = [...input.refs.messages.keys()].filter((ref) => /^M\d+$/.test(ref));
      const actions = evalCase.expected.map((exp) => toFixtureAction(exp, newMessageRefs, evalCase.id));
      const result: ExtractionResultT = ExtractionResult.parse({ actions });
      return Promise.resolve({
        result,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        model: 'fixture',
        raw: null,
      });
    },
  };
}

function toFixtureAction(exp: ExpectedAction, newMessageRefs: string[], caseId: string): ActionT {
  if (newMessageRefs.length === 0) {
    throw new Error(`eval case "${caseId}": no new-message refs to cite as source_message_ids`);
  }
  const common = {
    source_message_ids: newMessageRefs,
    confidence: 1,
    reasoning: "fixture: echoes the eval case's own expected action",
  };
  switch (exp.type) {
    case 'create':
      return {
        type: 'create',
        category: exp.category ?? 'assignment',
        title: `fixture ${exp.category ?? 'action'}`,
        description: null,
        assignee_ref: exp.assignee ?? null,
        assignee_name_text: null,
        due: exp.due !== undefined ? toDueT(exp.due) : { due_local: null, time_hint: 'none', due_text: null },
        priority: 'normal',
        // Not meaningful for `create` (Task 2.18 compat fix C) — always null.
        target_ref: null,
        ...common,
      };
    case 'update':
      if (exp.targetRef === undefined) {
        throw new Error(`eval case "${caseId}": expected update with no targetRef`);
      }
      return {
        type: 'update',
        target_ref: exp.targetRef,
        changes: {
          due: exp.due !== undefined ? toDueT(exp.due) : undefined,
          assignee_ref: exp.assignee,
          title: undefined,
        },
        ...common,
      };
    case 'complete':
      if (exp.targetRef === undefined) {
        throw new Error(`eval case "${caseId}": expected complete with no targetRef`);
      }
      return { type: 'complete', target_ref: exp.targetRef, ...common };
    case 'cancel':
      if (exp.targetRef === undefined) {
        throw new Error(`eval case "${caseId}": expected cancel with no targetRef`);
      }
      return { type: 'cancel', target_ref: exp.targetRef, ...common };
  }
}

function buildProviderFactory(args: CliArgs, modelLabel: string): (evalCase: EvalCase) => ExtractionProvider {
  if (args.provider === 'fixture') {
    return (evalCase) => buildFixtureExtractionProvider(evalCase);
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new Error('eval: OPENROUTER_API_KEY is required for --provider openrouter');
  }
  const client = createOpenRouterClient({
    apiKey,
    referer: 'https://github.com/MozgovoyVF/school-task-bot',
    title: 'school-task-bot eval',
  });
  const shared = new LlmExtractionProvider(client, {
    primary: modelLabel,
    fallback: args.fallback,
    jsonSchema: extractionJsonSchema(),
  });
  return () => shared;
}

// -- Running one case ------------------------------------------------------

interface RunCtx {
  providerFactory: (evalCase: EvalCase) => ExtractionProvider;
  prompt: PromptBundle;
  settings: Settings;
  /** The model label this run was invoked with (`--model`, or `'fixture'`) — used only as the fallback error-summary bucket for a failure that isn't an `ExtractionError` (so has no per-model `attempts` to attribute to). */
  modelLabel: string;
}

interface PipelineInput {
  now: Date;
  input: ExtractionInput;
  forResolve: ResolveContext['messages'];
  targetTasks: ResolveContext['targetTasks'];
}

/**
 * Builds everything `runCase` needs *before* the provider call: the exact
 * `ExtractionInput` (system + few-shot + this case's own data — the same
 * shape `LlmExtractionProvider` sends) plus the resolve-step context. Pulled
 * out of `runCase` so `main()` can also call it up front, purely to measure
 * each case's full rendered request length for the pre-flight cost estimate
 * (`--provider openrouter` step, below) without making any network call or
 * duplicating this assembly logic.
 */
function buildPipelineInput(evalCase: EvalCase, prompt: PromptBundle): PipelineInput {
  const now = new Date(evalCase.now);
  const owner = evalCase.participants.find((p) => p.role === 'owner');
  if (!owner || owner.code !== 'OWNER') {
    throw new Error(`eval case "${evalCase.id}": expected a participant with role "owner" and code "OWNER"`);
  }

  const participants: ParticipantForLlm[] = evalCase.participants.map((p) => ({
    code: p.code,
    userId: participantCodeToUserId(p.code),
    displayName: p.name,
    aliases: p.aliases ?? [],
    username: null,
    lastName: null,
    isOwner: p.role === 'owner',
  }));

  const openTasks: OpenTaskForLlm[] = evalCase.openTasks.map((t, i) => {
    const { dueAt, dueAllDay } = parseOpenItemDue(t.due, evalCase.workspaceTz);
    return { id: i + 1, title: t.title, assignee: toPromptAssignee(t.assignee), dueAt, dueAllDay };
  });
  // D47 (plan.md Task 3.15): `ResolveContext.targetTasks`, parallel to `openTasks` above (same `i + 1` ids).
  const targetTasks = new Map(
    evalCase.openTasks.map((t, i) => [i + 1, { title: t.title, assignee: toResolvedAssignee(t.assignee) }]),
  );
  const openProposals: OpenProposalForLlm[] = evalCase.openProposals.map((p, i) => ({
    id: i + 1,
    title: p.title,
    kind: 'create',
    targetTaskId: null,
  }));

  const { context, messages, forResolve } = buildMessages(evalCase);

  const input = buildExtractionInput(
    { now, workspaceTz: evalCase.workspaceTz, participants, openTasks, openProposals, context, messages },
    prompt,
  );

  return { now, input, forResolve, targetTasks };
}

/** Sum of every message's content length in a case's full rendered request — what the pre-flight cost estimate (brief step 3, broadened per review) prices. */
function totalInputChars(input: ExtractionInput): number {
  return input.messages.reduce((sum, m) => sum + m.content.length, 0);
}

/** `expected[].due` run through `resolveDue`, parallel to `expected` by index — shared between a successful run (`runCase`) and an errored one (`runCaseSafe`), since it only depends on the case's own data, not on the provider call. */
function computeResolvedExpectedDue(evalCase: EvalCase, settings: Settings): Array<Date | null> {
  const now = new Date(evalCase.now);
  return evalCase.expected.map((exp) =>
    exp.due !== undefined
      ? resolveDue(toDueT(exp.due), { zone: evalCase.workspaceTz, now, fuzzy: settings.fuzzyTimes }).dueAt
      : null,
  );
}

async function runCase(evalCase: EvalCase, pipeline: PipelineInput, ctx: RunCtx): Promise<EvalRow> {
  const { now, input, forResolve, targetTasks } = pipeline;

  const extraction = ctx.providerFactory(evalCase);
  const startedAt = performance.now();
  const extracted = await extraction.extract(input);
  const latencyMs = performance.now() - startedAt;

  const resolveCtx: ResolveContext = {
    refs: input.refs,
    messages: forResolve,
    ownerUserId: EVAL_OWNER_USER_ID,
    workspaceTz: evalCase.workspaceTz,
    now,
    fuzzy: ctx.settings.fuzzyTimes,
    targetTasks,
  };

  const { actions, dropped } = resolveActions(extracted.result, resolveCtx);
  if (dropped.length > 0) {
    console.warn(
      `eval case "${evalCase.id}": dropped ${String(dropped.length)} action(s) with unresolved refs`,
    );
  }

  const predicted = actions.map((action) => ({
    ...action,
    decision: applyPolicy(action, ctx.settings.ai.thresholds, 'auto').decision,
  }));

  return {
    caseId: evalCase.id,
    expected: evalCase.expected,
    predicted,
    resolvedExpectedDue: computeResolvedExpectedDue(evalCase, ctx.settings),
    costUsd: extracted.usage.costUsd,
    latencyMs,
  };
}

interface EvalOutcome {
  row: EvalRow;
  /** `null` on success; the error's own text (no chat message content, SPEC §18) otherwise. */
  errorText: string | null;
  /** Models an error can be attributed to, for the per-model error summary — `[]` on success. */
  failedModels: string[];
}

/** `"model: reason"` (how `extract.ts`'s `ExtractionError.attempts` entries are built) -> `"model"`. */
function modelFromAttempt(attempt: string): string {
  const idx = attempt.indexOf(':');
  return idx === -1 ? attempt : attempt.slice(0, idx);
}

/**
 * Runs one case without ever letting it abort the whole eval run (review
 * finding: a single bad case used to crash `main()` before any report was
 * written). A failure — provider error, a parse/validation dead end
 * (`ExtractionError`), or a bug in this file's own case conversion — is
 * recorded as a case with nothing shown (`predicted: []`, which `scoreRow`
 * then scores as a plain FN/TN like any other miss) plus the error text and
 * the model(s) it can be attributed to, for `main()`'s failures section and
 * per-model error summary.
 */
async function runCaseSafe(evalCase: EvalCase, pipeline: PipelineInput, ctx: RunCtx): Promise<EvalOutcome> {
  try {
    const row = await runCase(evalCase, pipeline, ctx);
    return { row, errorText: null, failedModels: [] };
  } catch (err) {
    const baseText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const errorText = err instanceof ExtractionError ? `${baseText} [${err.attempts.join(' | ')}]` : baseText;
    const failedModels =
      err instanceof ExtractionError ? [...new Set(err.attempts.map(modelFromAttempt))] : [ctx.modelLabel];
    console.error(`eval case "${evalCase.id}" failed: ${errorText}`);
    const row: EvalRow = {
      caseId: evalCase.id,
      expected: evalCase.expected,
      predicted: [],
      resolvedExpectedDue: computeResolvedExpectedDue(evalCase, ctx.settings),
      costUsd: err instanceof ExtractionError ? err.usage.costUsd : 0,
      latencyMs: 0,
    };
    return { row, errorText, failedModels };
  }
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      const item = items[current];
      if (item === undefined) return;
      results[current] = await worker(item);
    }
  }
  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => runNext()));
  return results;
}

// -- Report I/O --------------------------------------------------------

function writeReport(meta: ReportMeta, report: string, metrics: Metrics): void {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, reportFileName(meta));
  writeFileSync(reportPath, report, 'utf8');
  console.log(`eval: wrote ${reportPath}`);

  // Fixture runs are a plumbing smoke test, not a real model score — never
  // recorded in the comparison table (see reportFileName's doc comment).
  if (meta.provider !== 'openrouter') return;

  const comparisonPath = join(REPORTS_DIR, 'COMPARISON.md');
  const line = comparisonRow(meta, metrics);
  if (!existsSync(comparisonPath)) {
    writeFileSync(comparisonPath, `${COMPARISON_HEADER}\n${line}\n`, 'utf8');
  } else {
    appendFileSync(comparisonPath, `${line}\n`, 'utf8');
  }
  console.log(`eval: appended a row to ${comparisonPath}`);
}

/** Tallies {@link EvalOutcome.failedModels} across a run, for the per-model error summary `main()` prints after the report. */
function tallyErrorsByModel(outcomes: readonly EvalOutcome[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    for (const model of outcome.failedModels) counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return counts;
}

/**
 * The real-money guardrail for `--provider openrouter` (review finding: the
 * old `estimate > $1` threshold meant a cheap-looking estimate — itself
 * wrong by over an order of magnitude, see `pricing.ts` — skipped
 * confirmation entirely). Now **always** asks, regardless of the estimate
 * (even an unpriced one), unless `--yes` was passed. With no `--yes` and
 * stdin not a TTY (CI, a piped invocation, anything non-interactive) there
 * is no one to ask, so the run aborts rather than silently calling the API
 * or silently blocking forever on `readline`.
 */
async function confirmOpenRouterSpend(
  cases: readonly EvalCase[],
  args: CliArgs,
  estimate: number | null,
): Promise<boolean> {
  if (args.yes) return true;
  if (process.stdin.isTTY !== true) {
    console.error(
      'eval: --provider openrouter requires --yes when stdin is not a TTY (no interactive confirmation possible)',
    );
    return false;
  }
  const estimateText =
    estimate !== null ? `$${estimate.toFixed(4)}` : 'unknown (no OpenRouter pricing found)';
  const modelText = args.model ?? '(unset)';
  const fallbackText = args.fallback ?? 'none';
  return confirm(
    `About to call OpenRouter for ${String(cases.length)} case(s) — model "${modelText}" ` +
      `(fallback: ${fallbackText}). Estimated cost: ${estimateText}. Proceed? [y/N] `,
  );
}

// -- main ----------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgv(process.argv.slice(2));

  if (args.provider === 'openrouter' && args.model === null) {
    console.error('eval: --model is required for --provider openrouter');
    process.exitCode = 1;
    return;
  }
  const modelLabel = args.model ?? 'fixture';

  const allCases = loadDataset(DATASET_PATH);
  // `--limit` takes evenly spaced cases across the whole dataset, not the first N: the dataset is
  // grouped by category, so a prefix would miss whole categories (e.g. all negatives).
  const cases = args.limit !== null ? spreadSample(allCases, args.limit) : allCases;
  if (cases.length === 0) {
    console.error('eval: no cases to run (empty dataset or --limit 0)');
    process.exitCode = 1;
    return;
  }

  const prompt = loadPrompt({ name: 'extractor', version: args.promptVersion, profile: 'school_ru' });
  const settings = SettingsSchema.parse({});
  const providerFactory = buildProviderFactory(args, modelLabel);

  // Built once up front (network-free): reused both for the pre-flight cost
  // estimate below (its exact rendered length) and for every case's actual
  // run, so the two can never drift apart.
  const pipelines = cases.map((evalCase) => ({ evalCase, pipeline: buildPipelineInput(evalCase, prompt) }));

  if (args.provider === 'openrouter') {
    const pricing = await fetchModelPricing(modelLabel);
    let estimate: number | null = null;
    if (pricing === null) {
      console.warn(`eval: no OpenRouter pricing found for "${modelLabel}", cost estimate unavailable`);
    } else {
      estimate = estimateCostUsd(
        pipelines.map(({ pipeline }) => totalInputChars(pipeline.input)),
        pricing,
      );
      console.log(
        `eval: pre-flight cost estimate for ${String(cases.length)} case(s): $${estimate.toFixed(4)}`,
      );
    }
    const proceed = await confirmOpenRouterSpend(cases, args, estimate);
    if (!proceed) {
      console.log('eval: aborted');
      process.exitCode = 1;
      return;
    }
  }

  const ctx: RunCtx = { providerFactory, prompt, settings, modelLabel };
  const outcomes = await runWithConcurrency(pipelines, args.concurrency, ({ evalCase, pipeline }) =>
    runCaseSafe(evalCase, pipeline, ctx),
  );

  const rows = outcomes.map((o) => o.row);
  const metrics = computeMetrics(rows);
  const failures = reportableFailures(
    outcomes.map((o) => {
      const explanation = explainRow(o.row);
      const mismatches =
        o.errorText !== null ? [...explanation.mismatches, `error: ${o.errorText}`] : explanation.mismatches;
      return { caseId: o.row.caseId, classification: explanation.classification, mismatches };
    }),
  );
  const actualCostUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);

  const meta: ReportMeta = {
    date: DateTime.now().toISODate() ?? '1970-01-01',
    model: modelLabel,
    fallback: args.fallback,
    promptVersion: args.promptVersion,
    prefilter: args.prefilter,
    provider: args.provider,
    datasetPath: DATASET_PATH,
    actualCostUsd,
  };

  const report = renderReport(meta, metrics, failures);
  writeReport(meta, report, metrics);

  console.log(report);
  console.log(`eval: actual cost $${actualCostUsd.toFixed(4)}`);

  const errorCounts = tallyErrorsByModel(outcomes);
  if (errorCounts.size > 0) {
    console.error('eval: errors by model:');
    for (const [model, count] of errorCounts) {
      console.error(`  ${model}: ${String(count)} case(s)`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
