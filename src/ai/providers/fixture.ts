import type { ChatCompletionClient, CompletionRequest, CompletionResponse } from './types.js';

/**
 * Test double for `ChatCompletionClient` (plan.md Task 2.4). Plays back a
 * fixed script of responses/errors in order — no network, no OpenRouter —
 * so `LlmExtractionProvider`'s retry/repair/fallback logic can be tested
 * deterministically (CLAUDE.md: real LLM calls are forbidden in tests).
 * Every request it receives is recorded in `requests`, in call order, so
 * tests can assert on the exact repair messages a caller built.
 */
export class FixtureClient implements ChatCompletionClient {
  readonly requests: CompletionRequest[] = [];
  private cursor = 0;

  constructor(private readonly script: ReadonlyArray<CompletionResponse | Error>) {}

  complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const entry = this.script[this.cursor];
    this.cursor += 1;
    if (entry === undefined) {
      return Promise.reject(
        new Error(`FixtureClient: script exhausted after ${String(this.cursor - 1)} request(s)`),
      );
    }
    return entry instanceof Error ? Promise.reject(entry) : Promise.resolve(entry);
  }
}
