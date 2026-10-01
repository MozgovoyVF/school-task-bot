import { describe, it, expect } from 'vitest';
import { estimateCostUsd, fetchModelPricing, type ModelPricing } from '../../../eval/pricing.js';

// Task 2.18 compat fix D — real-API finding: the old estimate (built only
// from each case's raw message text, ignoring the system prompt/few-shot
// examples resent on every call and all output-token cost) reported $0.0004
// for a 30-case run that actually cost $0.0065. `estimateCostUsd` now takes
// each case's *full* rendered request length and adds a flat output-token
// allowance.

const PRICING: ModelPricing = { promptUsdPerToken: 0.000002, completionUsdPerToken: 0.000006 };

describe('estimateCostUsd', () => {
  it('prices input chars/3 at the prompt rate plus a per-case output-token allowance at the completion rate', () => {
    // One case, 300 input chars -> 100 input tokens; the fixed 300-token
    // output allowance (see pricing.ts) is priced at the completion rate.
    const estimate = estimateCostUsd([300], PRICING);
    const expected = 100 * PRICING.promptUsdPerToken + 300 * PRICING.completionUsdPerToken;
    expect(estimate).toBeCloseTo(expected, 10);
  });

  it('sums input chars and scales the output allowance by the number of cases', () => {
    const estimate = estimateCostUsd([300, 600], PRICING);
    const expectedInputTokens = (300 + 600) / 3;
    const expectedOutputTokens = 2 * 300;
    expect(estimate).toBeCloseTo(
      expectedInputTokens * PRICING.promptUsdPerToken + expectedOutputTokens * PRICING.completionUsdPerToken,
      10,
    );
  });

  it('is 0 for an empty run', () => {
    expect(estimateCostUsd([], PRICING)).toBe(0);
  });

  it("scales up sharply when given each case's full rendered length instead of only its raw message text", () => {
    // A system prompt + few-shot block alone is several thousand characters
    // (prompts/extractor.v1.md + prompts/examples.school_ru.json), resent on
    // every single case — not just the user's own message text (~200 chars
    // in these cases). The caller (`eval/run.ts`) must feed the full
    // rendered length, not just raw message text, or the estimate
    // reproduces the old order-of-magnitude undercount this fix was for.
    const fullRenderedCharsPerCase = 15_000;
    const rawMessageTextOnlyCharsPerCase = 200;
    const n = 30;
    const realistic = estimateCostUsd(Array(n).fill(fullRenderedCharsPerCase) as number[], PRICING);
    const underestimate = estimateCostUsd(Array(n).fill(rawMessageTextOnlyCharsPerCase) as number[], PRICING);
    // Both share the same fixed per-case output-token allowance (same `n`),
    // so the gap is driven entirely by the input side — still several times
    // larger even with that shared floor.
    expect(realistic).toBeGreaterThan(underestimate * 5);
  });
});

describe('fetchModelPricing', () => {
  it('parses pricing.prompt/pricing.completion (USD-per-token decimal strings) for the matching model id', async () => {
    const fetchImpl = ((): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: 'openai/gpt-5-mini', pricing: { prompt: '0.0000002', completion: '0.0000008' } },
              { id: 'other/model', pricing: { prompt: '1', completion: '1' } },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof fetch;

    const pricing = await fetchModelPricing('openai/gpt-5-mini', { fetchImpl });

    expect(pricing).toEqual({ promptUsdPerToken: 0.0000002, completionUsdPerToken: 0.0000008 });
  });

  it('returns null when the model id is not in the catalog', async () => {
    const fetchImpl = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof fetch;

    expect(await fetchModelPricing('unknown/model', { fetchImpl })).toBeNull();
  });

  it('throws on a non-ok HTTP response', async () => {
    const fetchImpl = ((): Promise<Response> =>
      Promise.resolve(new Response('', { status: 500 }))) as typeof fetch;

    await expect(fetchModelPricing('any/model', { fetchImpl })).rejects.toThrow();
  });
});
