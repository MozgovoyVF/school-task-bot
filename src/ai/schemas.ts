import { z } from 'zod';

// SPEC §9.5 — verbatim local zod schema for the extractor's output.

export const TimeHint = z.enum(['morning', 'afternoon', 'evening', 'end_of_week', 'soon', 'none']);

const Base = {
  source_message_ids: z.array(z.string().regex(/^M\d+$/)).min(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(200),
};

export const Due = z.object({
  due_local: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
    .nullable(),
  time_hint: TimeHint,
  due_text: z.string().max(80).nullable(),
});

export const Action = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create'),
    category: z.enum(['assignment', 'event', 'owner_intent', 'commitment', 'request_to_owner']),
    title: z.string().min(3).max(120),
    description: z.string().max(500).nullable(),
    assignee_ref: z
      .string()
      .regex(/^(P\d+|OWNER|ALL)$/)
      .nullable(),
    assignee_name_text: z.string().max(60).nullable(),
    due: Due,
    priority: z.enum(['low', 'normal', 'high']),
    ...Base,
  }),
  z.object({
    type: z.literal('update'),
    target_ref: z.string().regex(/^[TR]\d+$/),
    changes: z.object({
      due: Due.optional(),
      assignee_ref: z.string().nullable().optional(),
      title: z.string().max(120).optional(),
    }),
    ...Base,
  }),
  z.object({ type: z.literal('complete'), target_ref: z.string().regex(/^[TR]\d+$/), ...Base }),
  z.object({ type: z.literal('cancel'), target_ref: z.string().regex(/^[TR]\d+$/), ...Base }),
]);

export const ExtractionResult = z.object({ actions: z.array(Action).max(20) });

export type ExtractionResultT = z.infer<typeof ExtractionResult>;
export type DueT = z.infer<typeof Due>;
export type ActionT = z.infer<typeof Action>;

// D4 — wire schema for the provider's structured-output mode: `nullable`
// instead of `optional`, every field required. Only `update.changes` differs
// from the local schema (its three fields are optional there); everywhere
// else the local schema is already wire-shaped (no `.optional()` used).
const ChangesWire = z.object({
  due: Due.nullable(),
  assignee_ref: z.string().nullable(),
  title: z.string().max(120).nullable(),
});

const ActionWire = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create'),
    category: z.enum(['assignment', 'event', 'owner_intent', 'commitment', 'request_to_owner']),
    title: z.string().min(3).max(120),
    description: z.string().max(500).nullable(),
    assignee_ref: z
      .string()
      .regex(/^(P\d+|OWNER|ALL)$/)
      .nullable(),
    assignee_name_text: z.string().max(60).nullable(),
    due: Due,
    priority: z.enum(['low', 'normal', 'high']),
    ...Base,
  }),
  z.object({
    type: z.literal('update'),
    target_ref: z.string().regex(/^[TR]\d+$/),
    changes: ChangesWire,
    ...Base,
  }),
  z.object({ type: z.literal('complete'), target_ref: z.string().regex(/^[TR]\d+$/), ...Base }),
  z.object({ type: z.literal('cancel'), target_ref: z.string().regex(/^[TR]\d+$/), ...Base }),
]);

export const ExtractionWire = z.object({ actions: z.array(ActionWire).max(20) });

/**
 * Recursively renames every `oneOf` key to `anyOf`. zod v4's `toJSONSchema`
 * emits `oneOf` for discriminated unions and for `.nullable()` (an
 * exclusive union with `null`); strict structured-output mode only
 * understands `anyOf` (D4).
 */
function replaceOneOfWithAnyOf(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(replaceOneOfWithAnyOf);
  }
  if (node && typeof node === 'object') {
    const entries = Object.entries(node as Record<string, unknown>).map(([key, value]): [string, unknown] => [
      key === 'oneOf' ? 'anyOf' : key,
      replaceOneOfWithAnyOf(value),
    ]);
    return Object.fromEntries(entries);
  }
  return node;
}

export function extractionJsonSchema(): Record<string, unknown> {
  return replaceOneOfWithAnyOf(z.toJSONSchema(ExtractionWire)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `Array.isArray` is typed `(arg: any) => arg is any[]` in lib.es5.d.ts, so a
// bare `Array.isArray(x)` guard would leak `any` into everything narrowed by
// it. This wrapper keeps the narrowed type at `unknown[]`.
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

const UPDATE_CHANGES_NULLABLE_KEYS = ['due', 'assignee_ref', 'title'] as const;

/**
 * `null` in wire `update.changes.*` means "leave unchanged" — the local
 * schema instead expects the key to be absent (`.optional()`). Strips such
 * keys before the strict local validation runs.
 */
function normalizeWireInput(raw: unknown): unknown {
  if (!isRecord(raw) || !isUnknownArray(raw.actions)) {
    return raw;
  }
  const actions = raw.actions.map((action) => {
    if (!isRecord(action) || action.type !== 'update' || !isRecord(action.changes)) {
      return action;
    }
    const changes = { ...action.changes };
    for (const key of UPDATE_CHANGES_NULLABLE_KEYS) {
      if (changes[key] === null) {
        delete changes[key];
      }
    }
    return { ...action, changes };
  });
  return { ...raw, actions };
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

export function parseExtraction(
  raw: unknown,
): { ok: true; value: ExtractionResultT } | { ok: false; error: string } {
  const normalized = normalizeWireInput(raw);
  const result = ExtractionResult.safeParse(normalized);
  if (!result.success) {
    return { ok: false, error: formatIssues(result.error) };
  }
  return { ok: true, value: result.data };
}
