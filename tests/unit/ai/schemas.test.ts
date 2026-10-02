import { describe, it, expect } from 'vitest';
import {
  parseExtraction,
  extractionJsonSchema,
  extractionJsonSchemaCompat,
} from '../../../src/ai/schemas.js';

const create = {
  type: 'create',
  category: 'assignment',
  title: 'Подготовить расписание на октябрь',
  description: null,
  assignee_ref: 'P1',
  assignee_name_text: null,
  due: { due_local: '2026-09-25', time_hint: 'none', due_text: 'к пятнице' },
  priority: 'normal',
  source_message_ids: ['M1'],
  confidence: 0.87,
  reasoning: 'Прямое поручение',
};

describe('extraction schema', () => {
  it('accepts a valid result', () => {
    expect(parseExtraction({ actions: [create] })).toMatchObject({ ok: true });
    expect(parseExtraction({ actions: [] })).toMatchObject({ ok: true });
  });
  it.each([
    [{ ...create, source_message_ids: ['X1'] }],
    [{ ...create, source_message_ids: [] }],
    [{ ...create, confidence: 1.2 }],
    [{ ...create, title: 'ok' }],
    [{ ...create, assignee_ref: 'Маша' }],
    [{ ...create, due: { due_local: '25.09.2026', time_hint: 'none', due_text: null } }],
    [{ type: 'complete', target_ref: 'X5', source_message_ids: ['M1'], confidence: 0.9, reasoning: '' }],
  ])('rejects invalid action %#', (a) => {
    const r = parseExtraction({ actions: [a] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
  it('rejects more than 20 actions', () => {
    expect(parseExtraction({ actions: Array(21).fill(create) }).ok).toBe(false);
  });
  it('normalizes wire nulls in update.changes', () => {
    const r = parseExtraction({
      actions: [
        {
          type: 'update',
          target_ref: 'T12',
          changes: { due: null, assignee_ref: null, title: 'Новое' },
          source_message_ids: ['M2'],
          confidence: 0.8,
          reasoning: 'Уточнение',
        },
      ],
    });
    expect(r.ok && r.value.actions[0]).toMatchObject({ changes: { title: 'Новое' } });
    expect(r.ok && 'due' in (r.value.actions[0] as { changes: object }).changes).toBe(false);
  });
  it.each([
    ['extractionJsonSchema (full, strict default)', extractionJsonSchema],
    ['extractionJsonSchemaCompat (Gemini-compatible)', extractionJsonSchemaCompat],
  ])('produces a strict-compatible JSON schema — %s', (_label, schemaFn) => {
    const walk = (n: unknown): void => {
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        if (o.type === 'object' && o.properties) {
          expect(o.additionalProperties).toBe(false);
          expect(new Set(o.required as string[])).toEqual(new Set(Object.keys(o.properties)));
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(schemaFn());
    expect(JSON.stringify(schemaFn())).not.toContain('"oneOf"'); // strict mode понимает только anyOf
  });
  // Task 2.18 compat fix C — real-API finding: stripping
  // pattern/minLength/maxLength from the wire schema for *every* model (to
  // satisfy `google/gemini-3.8-flash`'s 400 INVALID_ARGUMENT on those
  // keywords) was itself a regression for a model that honours strict
  // `json_schema` (e.g. `deepseek/deepseek-v4-flash`): with no
  // `target_ref` pattern sent, the model is free to emit anything for it
  // and fails local validation instead (recall dropped from ~95% to
  // 54–71% in a real eval run). `extractionJsonSchema()` now sends the
  // full schema by default; only `extractionJsonSchemaCompat()` strips
  // these keywords, for a model already remembered as rejecting the full
  // one.
  it('extractionJsonSchema (default) keeps pattern/minLength/maxLength', () => {
    expect(JSON.stringify(extractionJsonSchema())).toContain('"pattern"');
    expect(JSON.stringify(extractionJsonSchema())).toContain('"maxLength"');
  });
  it('extractionJsonSchemaCompat strips pattern/minLength/maxLength (unsupported by Gemini structured outputs)', () => {
    const walk = (n: unknown): void => {
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        expect(o).not.toHaveProperty('pattern');
        expect(o).not.toHaveProperty('minLength');
        expect(o).not.toHaveProperty('maxLength');
        Object.values(o).forEach(walk);
      }
    };
    walk(extractionJsonSchemaCompat());
  });
  it('still enforces regex/length constraints locally even though the compat wire schema does not', () => {
    expect(parseExtraction({ actions: [{ ...create, assignee_ref: 'not-a-valid-ref' }] }).ok).toBe(false);
    expect(parseExtraction({ actions: [{ ...create, title: 'ab' }] }).ok).toBe(false);
  });
  // Task 2.18 compat fix C — target_ref is not meaningful on a `create`
  // action; a model (especially one unconstrained by the schema, e.g. under
  // the json_object compat path) must not be able to fail a whole batch by
  // attaching an invalid one to it.
  it.each([['bogus'], [''], ['T']])(
    'normalises an invalid create.target_ref (%j) to null instead of rejecting the batch',
    (badRef) => {
      const r = parseExtraction({ actions: [{ ...create, target_ref: badRef }] });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const action = r.value.actions[0] as { target_ref: unknown };
        expect(action.target_ref).toBeNull();
      }
    },
  );
  it('normalises a missing create.target_ref to null', () => {
    // `create` (the shared fixture above) has no `target_ref` key at all.
    const r = parseExtraction({ actions: [create] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const action = r.value.actions[0] as { target_ref: unknown };
      expect(action.target_ref).toBeNull();
    }
  });
  // D47 (plan.md Task 3.15): `update`'s new `explicit_transfer`/`new_task_title` fields.
  it('accepts an update action carrying explicit_transfer/new_task_title', () => {
    const r = parseExtraction({
      actions: [
        {
          type: 'update',
          target_ref: 'T12',
          changes: { assignee_ref: 'P2' },
          explicit_transfer: false,
          new_task_title: 'Подготовить отчёт',
          source_message_ids: ['M1'],
          confidence: 0.8,
          reasoning: 'другой адресат',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.actions[0]).toMatchObject({
        explicit_transfer: false,
        new_task_title: 'Подготовить отчёт',
      });
    }
  });
  it('accepts an update action with explicit_transfer:true and a null new_task_title', () => {
    const r = parseExtraction({
      actions: [
        {
          type: 'update',
          target_ref: 'T12',
          changes: { assignee_ref: 'P2' },
          explicit_transfer: true,
          new_task_title: null,
          source_message_ids: ['M1'],
          confidence: 0.8,
          reasoning: 'явная передача',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.actions[0]).toMatchObject({ explicit_transfer: true, new_task_title: null });
    }
  });
  it('still accepts an update action with neither field (old fixtures/examples)', () => {
    const r = parseExtraction({
      actions: [
        {
          type: 'update',
          target_ref: 'T12',
          changes: { due: { due_local: '2026-09-25', time_hint: 'none', due_text: null } },
          source_message_ids: ['M1'],
          confidence: 0.8,
          reasoning: 'перенос срока',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const action = r.value.actions[0] as { explicit_transfer?: boolean; new_task_title?: string | null };
      expect(action.explicit_transfer).toBeUndefined();
      expect(action.new_task_title).toBeUndefined();
    }
  });
  // D47 fix round 1, I2: a too-short/out-of-range `new_task_title` must degrade to `null` instead of
  // failing the whole batch — a model on the Gemini-compat path (`extractionJsonSchemaCompat`, no
  // `minLength`/`maxLength` sent) or the `json_object` fallback isn't actually constrained to 3..120
  // chars by the wire schema it was asked to follow, so this is a realistic provider response, not a
  // hypothetical. Losing every other action in the same batch over this one cosmetic field would be
  // strictly worse than not having D47 at all.
  it('normalizes a too-short new_task_title to null instead of rejecting the whole batch', () => {
    const r = parseExtraction({
      actions: [
        {
          type: 'update',
          target_ref: 'T12',
          changes: {},
          new_task_title: 'ab',
          source_message_ids: ['M1'],
          confidence: 0.8,
          reasoning: 'r',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.actions[0]).toMatchObject({ new_task_title: null });
  });
  it('normalizes an empty-string new_task_title to null', () => {
    const r = parseExtraction({
      actions: [
        {
          type: 'update',
          target_ref: 'T12',
          changes: {},
          new_task_title: '',
          source_message_ids: ['M1'],
          confidence: 0.8,
          reasoning: 'r',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.actions[0]).toMatchObject({ new_task_title: null });
  });
  it('normalizes an over-120-char new_task_title to null', () => {
    const r = parseExtraction({
      actions: [
        {
          type: 'update',
          target_ref: 'T12',
          changes: {},
          new_task_title: 'я'.repeat(121),
          source_message_ids: ['M1'],
          confidence: 0.8,
          reasoning: 'r',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.actions[0]).toMatchObject({ new_task_title: null });
  });
  it('normalizes a non-boolean explicit_transfer to absent instead of rejecting the batch', () => {
    const r = parseExtraction({
      actions: [
        {
          type: 'update',
          target_ref: 'T12',
          changes: {},
          explicit_transfer: 'yes',
          source_message_ids: ['M1'],
          confidence: 0.8,
          reasoning: 'r',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const action = r.value.actions[0] as { explicit_transfer?: boolean };
      expect(action.explicit_transfer).toBeUndefined();
    }
  });
  it('still rejects an invalid target_ref on update/complete/cancel actions (inventing a target is worse than dropping one)', () => {
    expect(
      parseExtraction({
        actions: [
          {
            type: 'complete',
            target_ref: 'bogus',
            source_message_ids: ['M1'],
            confidence: 0.9,
            reasoning: 'r',
          },
        ],
      }).ok,
    ).toBe(false);
  });
});
