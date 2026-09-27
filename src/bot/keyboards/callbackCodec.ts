/**
 * Versioned `callback_data` codec (SPEC §25): `v1:<entity>:<action>:<id>[:<arg>]`.
 *
 * `encodeCallback` is used by `bot/views/*` when building keyboards from
 * trusted, internal data; it throws on malformed input, on payloads that
 * would exceed Telegram's 64-byte `callback_data` limit, or on payloads
 * that `decodeCallback` couldn't parse back (e.g. an `id`/`arg` that stays
 * under 64 bytes but still exceeds the wire regex's own per-field caps) —
 * `encodeCallback` always round-trips through `decodeCallback` before
 * returning, so a keyboard can never be built with a `callback_data` the
 * bot's own decoder would reject.
 *
 * `decodeCallback` is the inverse used by `bot/handlers/*` on incoming
 * callback queries, which are untrusted external data (CLAUDE.md §8): it
 * never throws, returning `null` for anything that doesn't parse.
 */
import { z } from 'zod';

export type Entity = 'p' | 't' | 'c' | 'n' | 'l' | 's' | 'u' | 'a' | 'z' | 'o';

const ENTITIES = ['p', 't', 'c', 'n', 'l', 's', 'u', 'a', 'z', 'o'] as const;

export interface CallbackPayload {
  entity: Entity;
  action: string;
  id: number;
  arg?: string;
}

export class CallbackTooLongError extends Error {
  constructor(detail: string) {
    super(`callback_data does not fit the 64-byte v1 wire format: ${detail}`);
    this.name = 'CallbackTooLongError';
  }
}

export class CallbackEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallbackEncodeError';
  }
}

const MAX_BYTES = 64;

// Charset check only (no length cap): length is enforced by the overall
// byte-size check below, so the two failure modes stay distinguishable.
const ENCODE_ARG_CHARSET_RE = /^[A-Za-z0-9_.-]+$/;
const ENCODE_ACTION_RE = /^[a-z]{1,4}$/;

const entitySchema = z.enum(ENTITIES);

export function encodeCallback(payload: CallbackPayload): string {
  const { entity, action, id, arg } = payload;
  if (!entitySchema.safeParse(entity).success) {
    throw new CallbackEncodeError(`invalid entity: ${entity}`);
  }
  if (!ENCODE_ACTION_RE.test(action)) {
    throw new CallbackEncodeError(`invalid action: ${action}`);
  }
  if (!Number.isInteger(id) || id < 0) {
    throw new CallbackEncodeError(`invalid id: ${String(id)}`);
  }
  if (arg !== undefined && !ENCODE_ARG_CHARSET_RE.test(arg)) {
    throw new CallbackEncodeError(`invalid arg: ${arg}`);
  }

  const data = `v1:${entity}:${action}:${String(id)}${arg !== undefined ? `:${arg}` : ''}`;
  const size = Buffer.byteLength(data, 'utf8');
  if (size > MAX_BYTES) throw new CallbackTooLongError(`${String(size)} bytes, over the limit`);

  // Byte size alone isn't enough: the wire regex also caps `id` at 15
  // digits and `arg` at 40 chars, both stricter than what 64 bytes allows
  // on their own (e.g. a short entity/action/id leaves room for an arg
  // over 40 chars while staying under 64 bytes). Round-tripping through
  // decodeCallback catches that gap and any future divergence between the
  // two functions, so a keyboard is never built with a callback_data the
  // bot's own decoder would silently reject.
  const roundTrip = decodeCallback(data);
  if (
    roundTrip === null ||
    roundTrip.entity !== entity ||
    roundTrip.action !== action ||
    roundTrip.id !== id ||
    roundTrip.arg !== arg
  ) {
    throw new CallbackTooLongError('id/arg exceed the wire format field limits (15 digits / 40 chars)');
  }
  return data;
}

const CALLBACK_RE = /^v1:([a-z]):([a-z]{1,4}):(\d{1,15})(?::([A-Za-z0-9_.-]{1,40}))?$/;

const decodedSchema = z.object({
  entity: entitySchema,
  action: z.string(),
  id: z.number().int().nonnegative(),
  arg: z.string().optional(),
});

export function decodeCallback(data: string): CallbackPayload | null {
  const match = CALLBACK_RE.exec(data);
  if (!match) return null;

  const [, entity, action, idStr, arg] = match;
  if (entity === undefined || action === undefined || idStr === undefined) return null;

  const parsed = decodedSchema.safeParse({ entity, action, id: Number(idStr), arg });
  if (!parsed.success) return null;

  return arg === undefined
    ? { entity: parsed.data.entity, action: parsed.data.action, id: parsed.data.id }
    : { entity: parsed.data.entity, action: parsed.data.action, id: parsed.data.id, arg };
}
