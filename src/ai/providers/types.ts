import type { ExtractionInput } from '../pipeline/buildInput.js';
import type { ExtractionResultT } from '../schemas.js';

// SPEC §9.2 plus the client-level abstraction this task adds (plan.md Task
// 2.4): `ChatCompletionClient` talks to one provider (OpenRouter, or a
// fixture in tests); `ExtractionProvider`/`DecisionProvider` are the
// pipeline-facing abstractions built on top of it.

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CompletionRequest {
  model: string;
  messages: ExtractionInput['messages'];
  // The full strict schema, sent by default. Task 2.18 compat fix C:
  // `compatJsonSchema`, when given, is used instead once the client has
  // remembered this model as rejecting `jsonSchema` outright (see
  // `src/ai/providers/openrouter.ts`'s `nonStrictModels`) — typically a
  // narrower schema a stricter provider (e.g. Gemini) can actually accept.
  // Falls back to `jsonSchema` itself when omitted.
  jsonSchema: Record<string, unknown> | null;
  compatJsonSchema?: Record<string, unknown> | null;
  timeoutMs: number;
}

export interface CompletionResponse {
  content: string;
  usage: Usage;
  model: string;
  raw: unknown;
}

export interface ChatCompletionClient {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export interface ExtractionProvider {
  extract(
    input: ExtractionInput,
  ): Promise<{ result: ExtractionResultT; usage: Usage; model: string; raw: unknown }>;
}

export interface PrefilterInput {
  messages: ExtractionInput['messages'];
}

export interface DecisionProvider {
  hasActionableContent(input: PrefilterInput): Promise<{ probability: number; usage: Usage; model: string }>;
}

/**
 * Thrown by `ExtractionProvider.extract` when every model/attempt failed to
 * produce a response that parses against the extraction schema. `usage`
 * sums every attempt's usage (all of it was spent, even the failed calls);
 * `attempts` describes each one in order for logging/error reports (SPEC
 * §18: entity IDs only, so callers must not put message text into it).
 */
export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
    readonly attempts: string[],
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export interface AiProviders {
  extraction: ExtractionProvider;
  decision: DecisionProvider | null;
  client: ChatCompletionClient;
  models: { primary: string; fallback: string | null };
}
