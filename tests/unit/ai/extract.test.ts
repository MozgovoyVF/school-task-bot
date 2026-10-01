import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LlmExtractionProvider } from '../../../src/ai/pipeline/extract.js';
import { FixtureClient } from '../../../src/ai/providers/fixture.js';
import {
  ExtractionError,
  type CompletionRequest,
  type CompletionResponse,
} from '../../../src/ai/providers/types.js';
import type { ExtractionInput } from '../../../src/ai/pipeline/buildInput.js';

// plan.md Task 2.4 extract.test.ts: orchestration of `LlmExtractionProvider`
// against the `FixtureClient` test double — retry/repair on a
// schema-invalid response, fallback to a second model, and error mapping to
// `ExtractionError`. Never touches the network (CLAUDE.md: real LLM calls
// forbidden in tests); every response comes from `tests/fixtures/llm/*.json`.

const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/llm/', import.meta.url));

function loadFixture(name: string): CompletionResponse {
  const raw = readFileSync(`${FIXTURES_DIR}${name}.json`, 'utf8');
  return JSON.parse(raw) as CompletionResponse;
}

const JSON_SCHEMA = { type: 'object', properties: { actions: { type: 'array' } } };

const INPUT: ExtractionInput = {
  promptVersion: 'extractor.v1',
  messages: [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'USER DATA' },
  ],
  refs: { messages: new Map(), participants: new Map(), tasks: new Map(), proposals: new Map() },
};

function makeProvider(
  client: FixtureClient,
  fallback: string | null = 'fixture/fallback',
): LlmExtractionProvider {
  return new LlmExtractionProvider(client, {
    primary: 'fixture/primary',
    fallback,
    timeoutMs: 1_000,
    jsonSchema: JSON_SCHEMA,
  });
}

function sumUsage(...responses: CompletionResponse[]): CompletionResponse['usage'] {
  return responses.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.usage.inputTokens,
      outputTokens: acc.outputTokens + r.usage.outputTokens,
      costUsd: acc.costUsd + r.usage.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject');
}

describe('LlmExtractionProvider.extract (plan.md Task 2.4)', () => {
  it('returns the result and model=primary on a valid first response', async () => {
    const valid = loadFixture('valid_complete_t12');
    const client = new FixtureClient([valid]);
    const provider = makeProvider(client);

    const res = await provider.extract(INPUT);

    expect(res.model).toBe('fixture/primary');
    expect(res.result.actions).toHaveLength(1);
    expect(res.result.actions[0]).toMatchObject({ type: 'complete', target_ref: 'T12' });
    expect(res.usage).toEqual(valid.usage);
    expect(client.requests).toHaveLength(1);
  });

  it('repairs on primary after invalid JSON: second attempt carries the raw response and the error as messages, usage is summed', async () => {
    const invalid = loadFixture('invalid_json');
    const valid = loadFixture('valid_complete_t12');
    const client = new FixtureClient([invalid, valid]);
    const provider = makeProvider(client);

    const res = await provider.extract(INPUT);

    expect(res.model).toBe('fixture/primary');
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.model).toBe('fixture/primary');
    expect(client.requests[1]?.model).toBe('fixture/primary');

    const secondMessages: CompletionRequest['messages'] = client.requests[1]?.messages ?? [];
    expect(secondMessages).toHaveLength(4);
    expect(secondMessages[0]).toEqual(INPUT.messages[0]);
    expect(secondMessages[1]).toEqual(INPUT.messages[1]);
    expect(secondMessages[2]).toEqual({ role: 'assistant', content: invalid.content });
    expect(secondMessages[3]?.role).toBe('user');
    expect(secondMessages[3]?.content).toContain('invalid JSON');

    expect(res.usage).toEqual(sumUsage(invalid, valid));
  });

  it('falls back to the fallback model after two failed attempts on primary, and succeeds there', async () => {
    const first = loadFixture('schema_violation');
    const second = loadFixture('invalid_json');
    const third = loadFixture('valid_complete_t12');
    const client = new FixtureClient([first, second, third]);
    const provider = makeProvider(client);

    const res = await provider.extract(INPUT);

    expect(res.model).toBe('fixture/fallback');
    expect(client.requests).toHaveLength(3);
    expect(client.requests[0]?.model).toBe('fixture/primary');
    expect(client.requests[1]?.model).toBe('fixture/primary');
    expect(client.requests[2]?.model).toBe('fixture/fallback');
    // The fallback attempt starts over from the original messages, it does
    // not carry primary's repair turns with it.
    expect(client.requests[2]?.messages).toEqual(INPUT.messages);
    expect(res.usage).toEqual(sumUsage(first, second, third));
  });

  it('moves straight to the fallback model on a transport-level failure, without a repair turn', async () => {
    const valid = loadFixture('valid_complete_t12');
    const client = new FixtureClient([new Error('timeout'), valid]);
    const provider = makeProvider(client);

    const res = await provider.extract(INPUT);

    expect(res.model).toBe('fixture/fallback');
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.model).toBe('fixture/primary');
    expect(client.requests[1]?.model).toBe('fixture/fallback');
    expect(client.requests[1]?.messages).toEqual(INPUT.messages);
    // The failed transport call produced no response, so it contributes no usage.
    expect(res.usage).toEqual(valid.usage);
  });

  it('throws ExtractionError with summed usage and one entry per attempt when every model/attempt fails', async () => {
    const a = loadFixture('schema_violation');
    const b = loadFixture('invalid_json');
    const c = loadFixture('schema_violation');
    const d = loadFixture('invalid_json');
    const client = new FixtureClient([a, b, c, d]);
    const provider = makeProvider(client);

    const err = await captureRejection(provider.extract(INPUT));

    expect(err).toBeInstanceOf(ExtractionError);
    const extractionError = err as ExtractionError;
    expect(extractionError.attempts).toHaveLength(4);
    expect(extractionError.attempts[0]).toContain('fixture/primary');
    expect(extractionError.attempts[1]).toContain('fixture/primary');
    expect(extractionError.attempts[2]).toContain('fixture/fallback');
    expect(extractionError.attempts[3]).toContain('fixture/fallback');
    expect(extractionError.usage).toEqual(sumUsage(a, b, c, d));
    expect(client.requests).toHaveLength(4);
  });

  it('throws ExtractionError after two failed attempts when there is no fallback model', async () => {
    const a = loadFixture('schema_violation');
    const b = loadFixture('invalid_json');
    const client = new FixtureClient([a, b]);
    const provider = makeProvider(client, null);

    const err = await captureRejection(provider.extract(INPUT));

    expect(err).toBeInstanceOf(ExtractionError);
    const extractionError = err as ExtractionError;
    expect(extractionError.attempts).toHaveLength(2);
    expect(extractionError.usage).toEqual(sumUsage(a, b));
    expect(client.requests).toHaveLength(2);
  });

  it('treats an empty actions array as a successful result, not an error', async () => {
    const empty = loadFixture('empty_actions');
    const client = new FixtureClient([empty]);
    const provider = makeProvider(client);

    const res = await provider.extract(INPUT);

    expect(res.result).toEqual({ actions: [] });
    expect(res.model).toBe('fixture/primary');
  });

  // Task 2.18 compat fix C: `compatJsonSchema` is forwarded verbatim on
  // every request, alongside `jsonSchema` — it's the client's job (not
  // this orchestration layer's) to pick between them per model.
  it('forwards compatJsonSchema to the client on every request', async () => {
    const valid = loadFixture('valid_complete_t12');
    const client = new FixtureClient([valid]);
    const COMPAT_SCHEMA = { type: 'object', title: 'compat' };
    const provider = new LlmExtractionProvider(client, {
      primary: 'fixture/primary',
      fallback: null,
      timeoutMs: 1_000,
      jsonSchema: JSON_SCHEMA,
      compatJsonSchema: COMPAT_SCHEMA,
    });

    await provider.extract(INPUT);

    expect(client.requests[0]?.jsonSchema).toEqual(JSON_SCHEMA);
    expect(client.requests[0]?.compatJsonSchema).toEqual(COMPAT_SCHEMA);
  });
});
