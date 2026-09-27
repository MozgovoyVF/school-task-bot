/**
 * Versioned `callback_data` codec (SPEC §25): `v1:<entity>:<action>:<id>[:<arg>]`.
 *
 * `encodeCallback` is used by `bot/views/*` when building keyboards from
 * trusted, internal data; it throws on malformed input or on payloads that
 * would exceed Telegram's 64-byte `callback_data` limit.
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
  constructor(size: number) {
    super(`callback_data is ${String(size)} bytes, over the 64-byte Telegram limit`);
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
  if (size > MAX_BYTES) throw new CallbackTooLongError(size);
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
