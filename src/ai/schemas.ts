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
    // `target_ref` is not meaningful for a new task — there is nothing
    // existing to point at. Declared here only so a model that attaches one
    // anyway doesn't fail the discriminated union's shape; `parseExtraction`
    // (via `normalizeWireInput`) always forces this to `null` before
    // validation, regardless of what a provider sent (Task 2.18 compat fix
    // C — a missed task is worse than a false alarm, CLAUDE.md).
    target_ref: z
      .string()
      .regex(/^[TR]\d+$/)
      .nullable(),
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
    // D47: whether this is an explicit hand-over of the target's assignee
    // to someone else ("hand it to Veronika", "Veronika does it now instead
    // of Masha") rather than a brand-new instruction that merely mentions the same
    // topic as `target_ref` — `resolve.ts` uses this to decide whether a
    // named-assignee conflict on the target becomes a new `create` action
    // instead of applying as an `update` (plan.md decision D47). Optional
    // here (unlike the wire schema below) so every fixture/example written
    // before this field existed still parses; `resolve.ts` treats an absent
    // value as `false` (the conservative default — not an explicit
    // hand-over).
    explicit_transfer: z.boolean().optional(),
    // D47: the model's own title for the new task this `update` would
    // become if the pipeline (or the Owner, via the card's manual escape
    // hatch) decides to split it off from `target_ref` instead of applying
    // it — same bounds as `create.title` (plan.md Task 3.15). Optional/
    // nullable so old fixtures/examples without it still parse; absent is
    // treated the same as `null` (fall back to the target's own title).
    new_task_title: z.string().min(3).max(120).nullable().optional(),
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
    // See the local `Action` schema above for why `create` carries this.
    target_ref: z
      .string()
      .regex(/^[TR]\d+$/)
      .nullable(),
    ...Base,
  }),
  z.object({
    type: z.literal('update'),
    target_ref: z.string().regex(/^[TR]\d+$/),
    changes: ChangesWire,
    // D47 — see the local `Action` schema's `update` variant above for what
    // these mean; required (not nullable/optional) here like every other
    // wire field, since the wire schema always forces a value.
    explicit_transfer: z.boolean(),
    new_task_title: z.string().min(3).max(120).nullable(),
    ...Base,
  }),
  z.object({ type: z.literal('complete'), target_ref: z.string().regex(/^[TR]\d+$/), ...Base }),
  z.object({ type: z.literal('cancel'), target_ref: z.string().regex(/^[TR]\d+$/), ...Base }),
]);

export const ExtractionWire = z.object({ actions: z.array(ActionWire).max(20) });

/**
 * Recursively renames every `oneOf` key to `anyOf`. zod v4's `toJSONSchema`
 * emits `oneOf` for `z.discriminatedUnion`; strict structured-output mode
 * only understands `anyOf` (D4). The walk covers the whole tree (not just
 * the discriminated union) to stay robust if the schema grows more unions
 * or a future zod version changes what emits `oneOf`.
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

// Gemini's `response_json_schema` only understands a named subset of JSON
// Schema (Google Gen AI SDK, `types.py`'s `response_json_schema` docstring:
// `$id`/`$defs`/`$ref`/`$anchor`/`type`/`format`/`title`/`description`/
// `enum`/`items`/`prefixItems`/`minItems`/`maxItems`/`minimum`/`maximum`/
// `anyOf`/`oneOf`/`properties`/`additionalProperties`/`required`, plus the
// non-standard `propertyOrdering`) — `pattern`, `minLength` and `maxLength`
// are not on that list. `zod.toJSONSchema()` emits all three throughout this
// schema (every `.regex()`/string `.min()`/`.max()`), and sending them was
// reproduced live (2026-09-30, `google/gemini-3.8-flash` via OpenRouter) as
// a 400 `INVALID_ARGUMENT` straight from Google AI Studio.
//
// Task 2.18 compat fix C — stripping these unconditionally for every model
// was itself a regression: a model that *does* honour strict `json_schema`
// (e.g. `deepseek/deepseek-v4-flash`) then loses the `target_ref` pattern
// constraint, is free to emit anything for it, and fails local validation
// in `parseExtraction` instead (recall dropped from ~95% to 54–71% in a
// real eval run, repair retry doesn't help since the model has no way to
// know the pattern it's violating). `extractionJsonSchema()` now sends the
// full schema by default; `extractionJsonSchemaCompat()` is the stripped
// variant, used only for a model already remembered as rejecting the full
// strict schema (`nonStrictModels` in `src/ai/providers/openrouter.ts`).
// Either way this is purely a provider-side hint: the local
// `ExtractionResult`/`Action` zod schema above (not either of these) is
// what actually validates a response via `parseExtraction`, and it keeps
// every `.regex()`/`.min()`/`.max()` constraint regardless of which wire
// schema the provider was asked to enforce.
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set(['pattern', 'minLength', 'maxLength']);

function stripUnsupportedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripUnsupportedKeywords);
  }
  if (node && typeof node === 'object') {
    const entries = Object.entries(node as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_SCHEMA_KEYWORDS.has(key))
      .map(([key, value]): [string, unknown] => [key, stripUnsupportedKeywords(value)]);
    return Object.fromEntries(entries);
  }
  return node;
}

/** Full strict wire schema (pattern/minLength/maxLength included) — the default. */
export function extractionJsonSchema(): Record<string, unknown> {
  return replaceOneOfWithAnyOf(z.toJSONSchema(ExtractionWire)) as Record<string, unknown>;
}

/**
 * Gemini-compatible wire schema, with `pattern`/`minLength`/`maxLength`
 * stripped. Only for a model already remembered as rejecting the full
 * schema from `extractionJsonSchema()` — see the comment above.
 */
export function extractionJsonSchemaCompat(): Record<string, unknown> {
  return stripUnsupportedKeywords(extractionJsonSchema()) as Record<string, unknown>;
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
function normalizeUpdateChanges(action: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(action.changes)) {
    return action;
  }
  const changes = { ...action.changes };
  for (const key of UPDATE_CHANGES_NULLABLE_KEYS) {
    if (changes[key] === null) {
      delete changes[key];
    }
  }
  return { ...action, changes };
}

/**
 * `target_ref` is not meaningful on a `create` action (SPEC: a new task has
 * nothing existing to point at). Task 2.18 compat fix C: a model can still
 * attach an invalid, empty, or otherwise irrelevant value to it — e.g. under
 * the `json_object` compat path, where nothing enforces the wire shape at
 * all — so this always forces the field to `null` rather than validating
 * it, regardless of what was sent. `update`/`complete`/`cancel` actions are
 * untouched: their `target_ref` is meaningful (it names the task being
 * acted on), so an invalid one there must still fail that action — inventing
 * a target would be worse than dropping it.
 */
function normalizeCreateTargetRef(action: Record<string, unknown>): Record<string, unknown> {
  return { ...action, target_ref: null };
}

function normalizeWireInput(raw: unknown): unknown {
  if (!isRecord(raw) || !isUnknownArray(raw.actions)) {
    return raw;
  }
  const actions = raw.actions.map((action) => {
    if (!isRecord(action)) {
      return action;
    }
    if (action.type === 'create') {
      return normalizeCreateTargetRef(action);
    }
    if (action.type === 'update') {
      return normalizeUpdateChanges(action);
    }
    return action;
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
