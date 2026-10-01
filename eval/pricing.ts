import { z } from 'zod';
import type { EvalCase } from './schema.js';

// OpenRouter `GET /api/v1/models` (https://openrouter.ai/docs) has no Context7
// ID (see docs/agents/reference.md), so this schema was checked against a
// live response (curl, 2026-09-29 — read-only, no cost, not an LLM call):
// `{ data: [{ id, pricing: { prompt, completion, ... }, ... }, ...] }`, with
// `pricing.prompt`/`pricing.completion` given as USD-per-token decimal
// strings (e.g. "0.000002"). Every other field on a model entry is ignored
// here — only pricing is needed for `pnpm eval`'s cost guardrail.
const OpenRouterModelSchema = z.object({
  id: z.string(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
  }),
});

const OpenRouterModelsResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema),
});

const MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface ModelPricing {
  /** USD per input (prompt) token. */
  promptUsdPerToken: number;
  /** USD per output (completion) token. */
  completionUsdPerToken: number;
}

/**
 * Looks up `modelId`'s current pricing from OpenRouter's public model
 * catalog (brief step 3: `run.ts` "берёт цену модели из
 * `GET https://openrouter.ai/api/v1/models`"). Returns `null` when the
 * model id isn't listed (e.g. a typo, or a provider-specific variant not in
 * the catalog) rather than throwing — the caller then skips the pre-flight
 * cost estimate and prints a warning instead of blocking the run entirely.
 * Only called for `--provider openrouter`; `--provider fixture` never
 * reaches this (no network access at all, CLAUDE.md's "real LLM calls
 * forbidden in tests" — this endpoint is a public pricing catalog, not an
 * LLM call, but is still real network I/O kept out of the fixture path).
 */
export async function fetchModelPricing(
  modelId: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<ModelPricing | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const res = await fetchImpl(MODELS_URL);
  if (!res.ok) {
    throw new Error(`fetchModelPricing: GET ${MODELS_URL} failed with status ${String(res.status)}`);
  }
  const raw: unknown = await res.json();
  const parsed = OpenRouterModelsResponseSchema.parse(raw);
  const model = parsed.data.find((m) => m.id === modelId);
  if (!model) return null;
  return {
    promptUsdPerToken: Number(model.pricing.prompt),
    completionUsdPerToken: Number(model.pricing.completion),
  };
}

// Brief step 3's pre-flight estimate formula: "символы / 3 × цена токена" —
// a rough chars-per-token approximation used only to decide whether to ask
// for confirmation before an actual run, not a precise cost prediction (the
// real cost comes back from OpenRouter's own `usage.cost` per call).
const CHARS_PER_TOKEN_ESTIMATE = 3;

function charsInCase(evalCase: EvalCase): number {
  let total = 0;
  for (const m of evalCase.context) total += m.text.length;
  for (const m of evalCase.messages) total += m.text.length;
  return total;
}

/**
 * Pre-flight cost estimate (brief step 3) for running `cases` against a
 * model priced at `pricing`: total message-text characters across every
 * case, divided by {@link CHARS_PER_TOKEN_ESTIMATE} to approximate input
 * tokens, priced at the prompt (input) rate. Deliberately ignores
 * completion-token cost and everything else that goes into the real prompt
 * (participants, open tasks/proposals, the system prompt, few-shot
 * examples) — this is only meant to catch an order-of-magnitude mistake
 * (e.g. running the full dataset against an expensive model) before
 * spending real money, not to predict the exact bill.
 */
export function estimateCostUsd(cases: readonly EvalCase[], pricing: ModelPricing): number {
  const totalChars = cases.reduce((sum, c) => sum + charsInCase(c), 0);
  const estimatedTokens = totalChars / CHARS_PER_TOKEN_ESTIMATE;
  return estimatedTokens * pricing.promptUsdPerToken;
}
