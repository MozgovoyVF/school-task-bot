import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createOpenRouterClient } from '../../../src/ai/providers/openrouter.js';
import { createLogger } from '../../../src/ops/logger.js';
import type { CompletionRequest } from '../../../src/ai/providers/types.js';

/** Mirrors `groupIntake.test.ts`'s helper: a pino logger writing into an in-memory array. */
function capturingLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: unknown, _enc, cb: () => void) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, logger: createLogger({ level: 'debug', destination }) };
}

interface RecordedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function chatCompletion(opts: { usage?: Record<string, unknown>; content?: string } = {}): unknown {
  return {
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    created: 0,
    model: 'openrouter/model-x',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content: opts.content ?? '{"actions":[]}' },
      },
    ],
    usage: opts.usage,
  };
}

function requestUrl(input: string | URL | Request): string {
  if (input instanceof Request) return input.url;
  return input instanceof URL ? input.href : input;
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
}

function stubFetch(
  handler: (input: string | URL | Request, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetch: typeof fetch; recorded: RecordedRequest[] } {
  const recorded: RecordedRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    recorded.push({
      url: requestUrl(input),
      headers: new Headers(init?.headers),
      body: requestBody(init),
    });
    return handler(input, init);
  };
  return { fetch: fetchFn, recorded };
}

const JSON_SCHEMA = { type: 'object', properties: { actions: { type: 'array' } } };

const BASE_REQUEST: CompletionRequest = {
  model: 'openrouter/model-x',
  messages: [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'USER DATA' },
  ],
  jsonSchema: JSON_SCHEMA,
  timeoutMs: 5_000,
};

describe('createOpenRouterClient (plan.md Task 2.4)', () => {
  it('sends baseURL, model, temperature 0, strict json_schema response_format and Referer/Title headers', async () => {
    const { fetch: fetchStub, recorded } = stubFetch(() =>
      jsonResponse(200, chatCompletion({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } })),
    );
    const client = createOpenRouterClient({
      apiKey: 'sk-test',
      referer: 'https://example.test',
      title: 'STB Test',
      fetch: fetchStub,
    });

    await client.complete(BASE_REQUEST);

    expect(recorded).toHaveLength(1);
    const req = recorded[0];
    if (req === undefined) throw new Error('expected a recorded request');
    expect(req.url).toContain('https://openrouter.ai/api/v1');
    expect(req.headers.get('HTTP-Referer')).toBe('https://example.test');
    expect(req.headers.get('X-Title')).toBe('STB Test');
    expect(req.body.model).toBe('openrouter/model-x');
    expect(req.body.temperature).toBe(0);
    expect(req.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema: JSON_SCHEMA },
    });
  });

  it('turns usage.cost/prompt_tokens/completion_tokens into Usage', async () => {
    const { fetch: fetchStub } = stubFetch(() =>
      jsonResponse(
        200,
        chatCompletion({ usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0042 } }),
      ),
    );
    const client = createOpenRouterClient({ apiKey: 'k', referer: 'r', title: 't', fetch: fetchStub });

    const res = await client.complete(BASE_REQUEST);

    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.0042 });
  });

  it('defaults costUsd to 0 and warns when usage.cost is absent', async () => {
    const { fetch: fetchStub } = stubFetch(() =>
      jsonResponse(200, chatCompletion({ usage: { prompt_tokens: 80, completion_tokens: 20 } })),
    );
    const { logger, lines } = capturingLogger();
    const client = createOpenRouterClient({
      apiKey: 'k',
      referer: 'r',
      title: 't',
      fetch: fetchStub,
      logger,
    });

    const res = await client.complete(BASE_REQUEST);

    expect(res.usage).toEqual({ inputTokens: 80, outputTokens: 20, costUsd: 0 });
    expect(lines.some((line) => line.includes('usage.cost'))).toBe(true);
  });

  it('retries in json_object mode (schema as system text) after a 400 mentioning response_format, and remembers the model as non-strict', async () => {
    let call = 0;
    const { fetch: fetchStub, recorded } = stubFetch(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse(400, {
          error: { message: 'Provider does not support response_format', type: 'invalid_request_error' },
        });
      }
      return jsonResponse(
        200,
        chatCompletion({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }),
      );
    });
    const client = createOpenRouterClient({ apiKey: 'k', referer: 'r', title: 't', fetch: fetchStub });

    const res = await client.complete(BASE_REQUEST);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.body.response_format).toMatchObject({ type: 'json_schema' });
    expect(recorded[1]?.body.response_format).toEqual({ type: 'json_object' });
    const secondMessages = recorded[1]?.body.messages as Array<{ role: string; content: string }> | undefined;
    expect(secondMessages?.[0]?.role).toBe('system');
    expect(secondMessages?.[0]?.content).toContain(JSON.stringify(JSON_SCHEMA));
    expect(res.model).toBe('openrouter/model-x');

    // A later call for the same model must skip straight to json_object mode.
    await client.complete(BASE_REQUEST);
    expect(recorded).toHaveLength(3);
    expect(recorded[2]?.body.response_format).toEqual({ type: 'json_object' });
  });

  // Task 2.18 compat fix C: `extractionJsonSchema()` is now sent by default
  // (strict mode, keeps `pattern`/`minLength`/`maxLength`, matching
  // `JSON_SCHEMA` on `BASE_REQUEST`); once a model is remembered as
  // non-strict, later requests use `compatJsonSchema` instead, not the
  // strict schema embedded as text.
  it('uses compatJsonSchema (not jsonSchema) once a model is remembered as non-strict', async () => {
    const COMPAT_SCHEMA = { type: 'object', properties: { actions: { type: 'array' } }, title: 'compat' };
    let call = 0;
    const { fetch: fetchStub, recorded } = stubFetch(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse(400, {
          error: { message: 'Provider does not support response_format', type: 'invalid_request_error' },
        });
      }
      return jsonResponse(
        200,
        chatCompletion({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }),
      );
    });
    const client = createOpenRouterClient({ apiKey: 'k', referer: 'r', title: 't', fetch: fetchStub });

    await client.complete({ ...BASE_REQUEST, compatJsonSchema: COMPAT_SCHEMA });

    expect(recorded).toHaveLength(2);
    const secondMessages = recorded[1]?.body.messages as Array<{ role: string; content: string }> | undefined;
    expect(secondMessages?.[0]?.content).toContain(JSON.stringify(COMPAT_SCHEMA));
    expect(secondMessages?.[0]?.content).not.toContain(JSON.stringify(JSON_SCHEMA));

    // A later call for the same (now-remembered) model also uses the compat
    // schema, in a single request straight away.
    await client.complete({ ...BASE_REQUEST, compatJsonSchema: COMPAT_SCHEMA });
    expect(recorded).toHaveLength(3);
    const thirdMessages = recorded[2]?.body.messages as Array<{ role: string; content: string }> | undefined;
    expect(thirdMessages?.[0]?.content).toContain(JSON.stringify(COMPAT_SCHEMA));
  });

  it('never retries at the SDK level on a 500 (maxRetries: 0, review round I2) — one fetch call, error propagates', async () => {
    const { fetch: fetchStub, recorded } = stubFetch(() =>
      jsonResponse(500, { error: { message: 'upstream error', type: 'server_error' } }),
    );
    const client = createOpenRouterClient({ apiKey: 'k', referer: 'r', title: 't', fetch: fetchStub });

    await expect(client.complete(BASE_REQUEST)).rejects.toThrow();
    // The OpenAI SDK's own `maxRetries` defaults to 2 (i.e. 3 fetch calls for
    // a retryable 500) — `extract.ts` already owns primary->fallback retry
    // logic on top, so the SDK's own retries must be disabled.
    expect(recorded).toHaveLength(1);
  });

  // Task 2.18 compat fix A — real-API finding: `openai/gpt-5-mini` 404s with
  // OpenRouter's "No endpoints found that can handle the requested
  // parameters" because `temperature: 0` is sent unconditionally alongside
  // `provider.require_parameters: true`, but the model's listed endpoints
  // don't support `temperature`.
  it('retries without temperature after OpenRouter\'s "no endpoints found" 404, and remembers the model', async () => {
    let call = 0;
    const { fetch: fetchStub, recorded } = stubFetch(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse(404, {
          error: {
            message: 'No endpoints found that can handle the requested parameters.',
            code: 404,
          },
        });
      }
      return jsonResponse(
        200,
        chatCompletion({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }),
      );
    });
    const client = createOpenRouterClient({ apiKey: 'k', referer: 'r', title: 't', fetch: fetchStub });

    const res = await client.complete(BASE_REQUEST);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.body.temperature).toBe(0);
    expect(recorded[1]?.body.temperature).toBeUndefined();
    // The other request shape (strict json_schema) is untouched — only
    // temperature is dropped.
    expect(recorded[1]?.body.response_format).toMatchObject({ type: 'json_schema' });
    expect(res.model).toBe('openrouter/model-x');

    // A later call for the same model must skip straight to no-temperature.
    await client.complete(BASE_REQUEST);
    expect(recorded).toHaveLength(3);
    expect(recorded[2]?.body.temperature).toBeUndefined();
  });

  it('does not retry on a "no endpoints found" 404 for a different reason (e.g. an unknown model id)', async () => {
    const { fetch: fetchStub, recorded } = stubFetch(() =>
      jsonResponse(404, { error: { message: 'No endpoints found matching your data policy.', code: 404 } }),
    );
    const client = createOpenRouterClient({ apiKey: 'k', referer: 'r', title: 't', fetch: fetchStub });

    await expect(client.complete(BASE_REQUEST)).rejects.toThrow();
    expect(recorded).toHaveLength(1);
  });

  // Task 2.18 compat fix B — real-API finding: `google/gemini-3.8-flash` 400s
  // with a generic OpenRouter-level "Provider returned error" message whose
  // `error.metadata.raw` (Google AI Studio's own untouched error text)
  // contains `INVALID_ARGUMENT`. The old `response_format`-substring check
  // never saw this, since OpenRouter's top-level message never mentions
  // `response_format` here.
  it('retries in json_object mode after a 400 whose provider raw error is INVALID_ARGUMENT for a json_schema request', async () => {
    let call = 0;
    const { fetch: fetchStub, recorded } = stubFetch(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse(400, {
          error: {
            message: 'Provider returned error',
            code: 400,
            metadata: {
              raw: 'Request contains an invalid argument. INVALID_ARGUMENT',
              provider_name: 'Google AI Studio',
            },
          },
        });
      }
      return jsonResponse(
        200,
        chatCompletion({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }),
      );
    });
    const client = createOpenRouterClient({ apiKey: 'k', referer: 'r', title: 't', fetch: fetchStub });

    const res = await client.complete(BASE_REQUEST);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.body.response_format).toMatchObject({ type: 'json_schema' });
    expect(recorded[1]?.body.response_format).toEqual({ type: 'json_object' });
    expect(res.model).toBe('openrouter/model-x');
  });

  it('does not treat an unrelated 400 (no INVALID_ARGUMENT raw error) as a json_schema rejection', async () => {
    const { fetch: fetchStub, recorded } = stubFetch(() =>
      jsonResponse(400, {
        error: { message: 'Provider returned error', code: 400, metadata: { raw: 'Rate limited' } },
      }),
    );
    const client = createOpenRouterClient({ apiKey: 'k', referer: 'r', title: 't', fetch: fetchStub });

    await expect(client.complete(BASE_REQUEST)).rejects.toThrow();
    expect(recorded).toHaveLength(1);
  });
});
