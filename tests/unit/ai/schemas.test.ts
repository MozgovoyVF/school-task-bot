import { describe, it, expect } from 'vitest';
import { parseExtraction, extractionJsonSchema } from '../../../src/ai/schemas.js';

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
  it('produces a strict-compatible JSON schema', () => {
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
    walk(extractionJsonSchema());
    expect(JSON.stringify(extractionJsonSchema())).not.toContain('"oneOf"'); // strict mode понимает только anyOf
  });
});
