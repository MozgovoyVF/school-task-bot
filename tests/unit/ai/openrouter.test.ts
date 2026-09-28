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
});
