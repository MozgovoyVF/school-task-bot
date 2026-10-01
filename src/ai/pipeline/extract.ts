import { parseExtraction, type ExtractionResultT } from '../schemas.js';
import {
  ExtractionError,
  type ChatCompletionClient,
  type CompletionResponse,
  type ExtractionProvider,
  type Usage,
} from '../providers/types.js';
import type { ExtractionInput } from './buildInput.js';

const DEFAULT_TIMEOUT_MS = 30_000;

// SPEC §9.2 ("zod validation, 1 retry with the error message, then fall back
// to the next model"): each model gets one initial attempt plus one repair
// retry before the pipeline gives up on it and moves to the next model.
const MAX_ATTEMPTS_PER_MODEL = 2;

// English on purpose: this text is an instruction sent to the LLM, not
// user-facing product copy, and CLAUDE.md confines Cyrillic in `src/**/*.ts`
// to `src/bot/texts/ru.ts`/`src/config/constants.ts`.
const REPAIR_INSTRUCTION = 'Your previous response did not match the required schema:';
const REPAIR_SUFFIX = 'Return a corrected JSON object that matches the schema exactly, with no extra text.';

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

function parseContent(
  content: string,
): { ok: true; value: ExtractionResultT } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  return parseExtraction(raw);
}

/**
 * Orchestrates one extraction call (plan.md Task 2.4): tries `primary`, and
 * on repeated failure `fallback` (if any), reading the provider's raw text
 * through `parseExtraction` (Task 2.1) and feeding a validation error back
 * to the model as a one-shot repair turn before switching models. A
 * transport-level failure (timeout, network, API error — anything the
 * client itself rejects with) skips the repair turn and moves to the next
 * model immediately, since there is no response to repair.
 */
export class LlmExtractionProvider implements ExtractionProvider {
  private readonly primary: string;
  private readonly fallback: string | null;
  private readonly timeoutMs: number;
  private readonly jsonSchema: Record<string, unknown> | null;
  private readonly compatJsonSchema: Record<string, unknown> | null | undefined;

  constructor(
    private readonly client: ChatCompletionClient,
    opts: {
      primary: string;
      fallback: string | null;
      timeoutMs?: number;
      jsonSchema: Record<string, unknown> | null;
      // Task 2.18 compat fix C: passed straight through to the client as
      // `CompletionRequest.compatJsonSchema` on every request — see its doc
      // comment (`src/ai/providers/types.ts`) for how it's used.
      compatJsonSchema?: Record<string, unknown> | null;
    },
  ) {
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.jsonSchema = opts.jsonSchema;
    this.compatJsonSchema = opts.compatJsonSchema;
  }

  async extract(
    input: ExtractionInput,
  ): Promise<{ result: ExtractionResultT; usage: Usage; model: string; raw: unknown }> {
    const models = this.fallback === null ? [this.primary] : [this.primary, this.fallback];
    let usage = zeroUsage();
    const attempts: string[] = [];

    for (const model of models) {
      let messages = input.messages;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
        let response: CompletionResponse;
        try {
          response = await this.client.complete({
            model,
            messages,
            jsonSchema: this.jsonSchema,
            compatJsonSchema: this.compatJsonSchema,
            timeoutMs: this.timeoutMs,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          attempts.push(`${model}: request failed: ${message}`);
          break;
        }

        usage = sumUsage(usage, response.usage);
        const parsed = parseContent(response.content);
        if (parsed.ok) {
          return { result: parsed.value, usage, model, raw: response.raw };
        }

        attempts.push(`${model}: ${parsed.error}`);
        if (attempt >= MAX_ATTEMPTS_PER_MODEL) break;

        messages = [
          ...messages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: `${REPAIR_INSTRUCTION} ${parsed.error}. ${REPAIR_SUFFIX}` },
        ];
      }
    }

    throw new ExtractionError('extraction failed on every model/attempt', usage, attempts);
  }
}
