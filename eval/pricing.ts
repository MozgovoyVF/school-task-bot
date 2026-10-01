import { z } from 'zod';

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

// A live eval run (2026-10-01, 30 cases, deepseek/deepseek-v4-flash)
// actually cost $0.0065, while the original estimate — built only from each
// case's own message text, ignoring the system prompt/few-shot examples
// repeated on *every* request and all output-token cost — reported $0.0004,
// off by more than an order of magnitude. `estimateCostUsd` now takes each
// case's full rendered request length (`eval/run.ts` measures this straight
// off the same `ExtractionInput.messages` sent to the provider: system +
// few-shot + that case's own data) and adds a flat output-token allowance.
// Extraction responses are a short JSON actions array (SPEC §9.5's `Action`
// schema) — typically 0-2 actions per case, each a few dozen tokens of
// title/description/reasoning/due — so 300 tokens/case is a deliberately
// generous guardrail, not a tight prediction (same spirit as the input-side
// chars/3 approximation: catch an order-of-magnitude mistake, not predict
// the exact bill).
const OUTPUT_TOKENS_PER_CASE_ESTIMATE = 300;

/**
 * Pre-flight cost estimate (brief step 3) for running against a model
 * priced at `pricing`. `inputCharsPerCase` must be each case's *full*
 * rendered request length — i.e. every message `eval/run.ts` would actually
 * send for that case (system prompt + few-shot examples + that case's own
 * data), not just its raw message text — since the system prompt and
 * few-shot examples are resent on every single call, not once per run.
 */
export function estimateCostUsd(inputCharsPerCase: readonly number[], pricing: ModelPricing): number {
  const totalInputChars = inputCharsPerCase.reduce((sum, chars) => sum + chars, 0);
  const estimatedInputTokens = totalInputChars / CHARS_PER_TOKEN_ESTIMATE;
  const estimatedOutputTokens = inputCharsPerCase.length * OUTPUT_TOKENS_PER_CASE_ESTIMATE;
  return (
    estimatedInputTokens * pricing.promptUsdPerToken + estimatedOutputTokens * pricing.completionUsdPerToken
  );
}
