import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions.js';
import { z } from 'zod';
import type { Logger } from '../../ops/logger.js';
import type { ChatCompletionClient, CompletionRequest, CompletionResponse, Usage } from './types.js';

// SPEC §9.2/§4 — LLM access goes through OpenRouter via the `openai` SDK
// (`baseURL` swapped). Verified against `node_modules/openai` v7.23.0's
// `.d.ts` (Context7 has no ID for the JS SDK): `response_format: { type:
// 'json_schema', json_schema: { name, schema, strict } }` is
// `Shared.ResponseFormatJSONSchema`, `APIError`/`BadRequestError` carry
// `.status` and a `"<status> <body message>"` `.message`.

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const RESPONSE_FORMAT_SCHEMA_NAME = 'extraction';

// OpenRouter-only request field (https://openrouter.ai/docs/features/provider-routing):
// restricts routing to providers that support every parameter in the
// request (here, structured `response_format`), instead of silently
// dropping it. Not part of the OpenAI SDK's own request types.
interface OpenRouterProviderPreferences {
  provider?: { require_parameters?: boolean };
}

type OpenRouterCreateParams = ChatCompletionCreateParamsNonStreaming & OpenRouterProviderPreferences;

// `usage.cost` is an OpenRouter extension absent from the SDK's
// `CompletionUsage` type (plan.md Task 2.4 step 4), so it is parsed
// separately with `.passthrough()` straight off the raw response object.
// `cost` is `number | null` in OpenRouter's `ChatUsage` schema (e.g. absent
// pricing for a BYOK/free route), not merely optional — both are treated the
// same way below (costUsd defaults to 0, with a warning).
const OpenRouterUsageSchema = z
  .object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cost: z.number().nullable().optional(),
  })
  .passthrough();

function toChatMessage(message: CompletionRequest['messages'][number]): ChatCompletionMessageParam {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant':
      return { role: 'assistant', content: message.content };
  }
}

/**
 * Used only when a model has already failed a strict `json_schema` request
 * with a 400 mentioning `response_format` (`nonStrictModels`): the schema is
 * instead spelled out as text appended to the system message, and the
 * request falls back to plain `json_object` mode.
 */
function injectSchemaIntoSystem(
  messages: ChatCompletionMessageParam[],
  jsonSchema: Record<string, unknown>,
): ChatCompletionMessageParam[] {
  const instruction = `Respond with a single JSON object only (no markdown, no extra text) that matches exactly this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
  const [first, ...rest] = messages;
  if (first !== undefined && first.role === 'system' && typeof first.content === 'string') {
    return [{ role: 'system', content: `${first.content}\n\n${instruction}` }, ...rest];
  }
  return [{ role: 'system', content: instruction }, ...messages];
}

function buildRequestBody(
  req: CompletionRequest,
  useJsonSchema: boolean,
  includeTemperature: boolean,
): OpenRouterCreateParams {
  const messages = req.messages.map(toChatMessage);
  const base: OpenRouterCreateParams = {
    model: req.model,
    messages,
    provider: { require_parameters: true },
    // CLAUDE.md requires temperature 0 wherever the endpoint supports it;
    // `includeTemperature` is only ever false for a model already remembered
    // (`noTemperatureModels`) as rejecting it outright (see
    // `isNoEndpointsError` below), not a general opt-out.
    ...(includeTemperature ? { temperature: 0 } : {}),
  };
  if (req.jsonSchema === null) {
    return base;
  }
  if (useJsonSchema) {
    return {
      ...base,
      response_format: {
        type: 'json_schema',
        json_schema: { name: RESPONSE_FORMAT_SCHEMA_NAME, strict: true, schema: req.jsonSchema },
      },
    };
  }
  // Task 2.18 compat fix C: the compat path (a model already remembered as
  // rejecting the full strict schema) uses `compatJsonSchema` when the
  // caller provided one, not `jsonSchema` itself — see `CompletionRequest`.
  const compatSchema = req.compatJsonSchema ?? req.jsonSchema;
  return {
    ...base,
    messages: injectSchemaIntoSystem(messages, compatSchema),
    response_format: { type: 'json_object' },
  };
}

function isResponseFormatBadRequest(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    typeof err.message === 'string' &&
    err.message.toLowerCase().includes('response_format')
  );
}

// OpenRouter's JSON body shape for a provider-side error, as handed back
// through `OpenAI.APIError#error` (the SDK parses `errorResponse['error']`
// itself — see `node_modules/openai/core/error.js`'s `APIError.generate`).
// `metadata.raw` carries the upstream provider's own untouched error text
// (e.g. Google AI Studio's), which is where an `INVALID_ARGUMENT` for a
// rejected `json_schema` request actually shows up — `APIError#message` only
// ever contains the generic OpenRouter-level `message` field, not this.
const OpenRouterApiErrorBodySchema = z
  .object({
    message: z.string().optional(),
    metadata: z.object({ raw: z.string().optional(), provider_name: z.string().optional() }).optional(),
  })
  .passthrough();

/**
 * A strict `json_schema` request rejected with a 400 whose upstream raw
 * error is `INVALID_ARGUMENT` (observed from Google AI Studio/Gemini: our
 * schema's `pattern`/`minLength`/`maxLength` keywords — present by default
 * in `extractionJsonSchema()`, dropped only in the compat variant
 * `extractionJsonSchemaCompat()` (`src/ai/schemas.ts`, Task 2.18 compat fix
 * C) — trigger this). Once remembered, later requests for this model use
 * `compatJsonSchema` (the stripped schema) if the caller supplied one.
 * Distinct from `isResponseFormatBadRequest`, which only catches a provider
 * saying it does not support `response_format`/structured outputs at all.
 */
function isJsonSchemaInvalidArgument(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError) || err.status !== 400) return false;
  const parsed = OpenRouterApiErrorBodySchema.safeParse(err.error);
  if (!parsed.success) return false;
  const raw = parsed.data.metadata?.raw ?? '';
  return raw.toUpperCase().includes('INVALID_ARGUMENT');
}

/**
 * OpenRouter's exact "no route for this parameter set" 404 message, returned
 * instead of silently dropping an unsupported request parameter when
 * `provider.require_parameters: true` is set (provider-routing docs).
 * Observed for `temperature` on a model whose listed endpoints don't support
 * it (e.g. `openai/gpt-5-mini`). Matched on the full phrase, not just "no
 * endpoints found" — OpenRouter also 404s with that shorter prefix for
 * unrelated routing reasons (e.g. a data-policy mismatch), which dropping
 * `temperature` would never fix and must not be retried as if it would.
 */
function isNoEndpointsError(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 404 &&
    typeof err.message === 'string' &&
    err.message.toLowerCase().includes('no endpoints found that can handle the requested parameters')
  );
}

function toUsage(response: ChatCompletion, model: string, logger: Logger | undefined): Usage {
  const parsed = OpenRouterUsageSchema.safeParse(response.usage);
  if (!parsed.success) {
    logger?.warn({ model }, 'openrouter response missing usage, defaulting to zero');
    return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  if (parsed.data.cost === undefined || parsed.data.cost === null) {
    logger?.warn({ model }, 'openrouter response missing usage.cost, defaulting costUsd to 0');
  }
  return {
    inputTokens: parsed.data.prompt_tokens,
    outputTokens: parsed.data.completion_tokens,
    costUsd: parsed.data.cost ?? 0,
  };
}

function toCompletionResponse(
  response: ChatCompletion,
  requestedModel: string,
  logger: Logger | undefined,
): CompletionResponse {
  const content = response.choices[0]?.message.content ?? '';
  return {
    content,
    usage: toUsage(response, requestedModel, logger),
    model: response.model,
    raw: response,
  };
}

/**
 * Builds a `ChatCompletionClient` that talks to OpenRouter through the
 * `openai` SDK (plan.md Task 2.4). Two independent per-model fallbacks are
 * remembered for the lifetime of this client, each triggered by a distinct
 * error shape and each retried at most once:
 *   - a model that rejects strict `json_schema` mode (400 mentioning
 *     `response_format`, or a 400 whose upstream raw error is
 *     `INVALID_ARGUMENT` — see `isJsonSchemaInvalidArgument`) goes straight
 *     to `json_object` mode with the compat schema (`req.compatJsonSchema`,
 *     falling back to `req.jsonSchema`) spelled out in the system message
 *     for every later request (`nonStrictModels`) — a model never remembered
 *     this way keeps getting the full `req.jsonSchema` in strict mode
 *     (Task 2.18 compat fix C);
 *   - a model whose endpoints don't support `temperature` (OpenRouter's "no
 *     endpoints found" 404, since `provider.require_parameters: true` is
 *     always set) drops `temperature` from every later request
 *     (`noTemperatureModels`) — `temperature: 0` (CLAUDE.md) is otherwise
 *     always sent.
 */
export function createOpenRouterClient(opts: {
  apiKey: string;
  fetch?: typeof fetch;
  referer: string;
  title: string;
  logger?: Logger;
}): ChatCompletionClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: { 'HTTP-Referer': opts.referer, 'X-Title': opts.title },
    fetch: opts.fetch,
    // The SDK defaults to 2 retries on top of `extract.ts`'s own
    // retry-then-fallback logic (SPEC-mandated primary -> fallback on
    // timeout) — without this, the SDK's own retries triple every request's
    // effective timeout, and a full outage can stall a tick for several
    // minutes (review round, I2).
    maxRetries: 0,
  });
  const nonStrictModels = new Set<string>();
  const noTemperatureModels = new Set<string>();

  return {
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const useJsonSchema = req.jsonSchema !== null && !nonStrictModels.has(req.model);
      const includeTemperature = !noTemperatureModels.has(req.model);
      try {
        const response = await client.chat.completions.create(
          buildRequestBody(req, useJsonSchema, includeTemperature),
          { timeout: req.timeoutMs },
        );
        return toCompletionResponse(response, req.model, opts.logger);
      } catch (err) {
        if (useJsonSchema && (isResponseFormatBadRequest(err) || isJsonSchemaInvalidArgument(err))) {
          opts.logger?.warn(
            { model: req.model },
            'openrouter rejected strict json_schema response_format, retrying in json_object mode',
          );
          nonStrictModels.add(req.model);
          const response = await client.chat.completions.create(
            buildRequestBody(req, false, includeTemperature),
            { timeout: req.timeoutMs },
          );
          return toCompletionResponse(response, req.model, opts.logger);
        }
        if (includeTemperature && isNoEndpointsError(err)) {
          opts.logger?.warn(
            { model: req.model },
            'openrouter found no endpoints supporting temperature for this model, retrying without it',
          );
          noTemperatureModels.add(req.model);
          const response = await client.chat.completions.create(buildRequestBody(req, useJsonSchema, false), {
            timeout: req.timeoutMs,
          });
          return toCompletionResponse(response, req.model, opts.logger);
        }
        throw err;
      }
    },
  };
}
