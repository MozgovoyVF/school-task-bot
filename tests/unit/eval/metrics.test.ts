import { describe, it, expect } from 'vitest';
import { computeMetrics, EVAL_OWNER_USER_ID, type EvalRow } from '../../../eval/metrics.js';
import type { ResolvedAction } from '../../../src/ai/pipeline/resolve.js';
import type { ResolvedDue } from '../../../src/time/resolveDue.js';

// plan.md Task 2.17, brief step 1 — the five hand-worked scenarios
// `computeMetrics` must satisfy. Not a D43/TDD task (see plan.md D43), so
// these tests were written alongside the implementation rather than
// failing-first, but the brief calls the scenarios specific enough to copy
// in verbatim, and doing so documents the scoring rules the doc comments
// in eval/metrics.ts describe in prose.

const NO_DUE: ResolvedDue = {
  dueAt: null,
  allDay: false,
  tz: null,
  inPast: false,
  invalid: false,
  dueText: null,
};

function dueAt(iso: string, opts?: { allDay?: boolean; tz?: string }): ResolvedDue {
  return {
    dueAt: new Date(iso),
    allDay: opts?.allDay ?? false,
    tz: opts?.tz ?? 'Europe/Moscow',
    inPast: false,
    invalid: false,
    dueText: null,
  };
}

function createAction(
  overrides: Partial<Extract<ResolvedAction, { kind: 'create' }>> = {},
): Extract<ResolvedAction, { kind: 'create' }> {
  return {
    kind: 'create',
    category: 'assignment',
    title: 'Test task',
    description: null,
    assignee: { type: 'none' },
    due: NO_DUE,
    priority: 'normal',
    sourceMessageIds: [1],
    confidence: 0.9,
    reasoning: 'test',
    ...overrides,
  };
}

function row(overrides: Partial<EvalRow> & Pick<EvalRow, 'expected' | 'predicted'>): EvalRow {
  return {
    caseId: 'case',
    resolvedExpectedDue: overrides.expected.map(() => null),
    costUsd: 0,
    latencyMs: 0,
    ...overrides,
  };
}

describe('computeMetrics', () => {
  it('classifies TP/FN/FP/TN across 4 cases into recall 0.5, precision 0.5 (brief step 1.1)', () => {
    const tp = row({
      expected: [{ type: 'create', category: 'assignment' }],
      predicted: [{ ...createAction(), decision: 'shown' }],
    });
    const fn = row({
      expected: [{ type: 'create', category: 'assignment' }],
      predicted: [],
    });
    const fp = row({
      expected: [],
      predicted: [{ ...createAction(), decision: 'shown' }],
    });
    const tn = row({ expected: [], predicted: [] });

    const metrics = computeMetrics([tp, fn, fp, tn]);
    expect(metrics.recall).toBeCloseTo(0.5);
    expect(metrics.precision).toBeCloseTo(0.5);
    expect(metrics.n).toBe(4);
  });

  it('matches by type (+targetRef for non-create); a create with the wrong category still matches on type (brief step 1.2)', () => {
    const r = row({
      expected: [{ type: 'create', category: 'assignment' }],
      predicted: [{ ...createAction({ category: 'event' }), decision: 'shown' }],
    });
    const metrics = computeMetrics([r]);
    expect(metrics.typeAccuracy).toBeCloseTo(1);
    expect(metrics.categoryAccuracy).toBeCloseTo(0);
  });

  it('compares the assignee only for matched creates where one was expected (brief step 1.3)', () => {
    const matchedWithAssignee = row({
      expected: [{ type: 'create', category: 'assignment', assignee: 'P2' }],
      predicted: [{ ...createAction({ assignee: { type: 'user', userId: 2 } }), decision: 'shown' }],
    });
    const updateWithAssignee = row({
      expected: [{ type: 'update', targetRef: 'T1', assignee: 'P2' }],
      predicted: [
        {
          kind: 'update',
          target: { taskId: 1 },
          changes: { assignee: { type: 'user', userId: 2 } },
          sourceMessageIds: [1],
          confidence: 0.9,
          reasoning: 'test',
          decision: 'shown',
        },
      ],
    });
    const metrics = computeMetrics([matchedWithAssignee, updateWithAssignee]);
    // Only the `create` row's assignee is scored — the `update` row (assignee
    // expected too) is excluded entirely, per the brief's "только у... create".
    expect(metrics.assigneeAccuracy).toBeCloseTo(1);
  });

  it('resolves the expected due via resolveDue and compares to the predicted dueAt: exact for non-all-day, date-only for all-day (brief step 1.4)', () => {
    const exactMatch = row({
      expected: [{ type: 'create', category: 'event' }],
      predicted: [{ ...createAction({ due: dueAt('2026-10-02T10:00:00+03:00') }), decision: 'shown' }],
      resolvedExpectedDue: [new Date('2026-10-02T10:00:00+03:00')],
    });
    const exactMismatch = row({
      expected: [{ type: 'create', category: 'event' }],
      predicted: [{ ...createAction({ due: dueAt('2026-10-02T10:05:00+03:00') }), decision: 'shown' }],
      resolvedExpectedDue: [new Date('2026-10-02T10:00:00+03:00')],
    });
    const allDayMatch = row({
      expected: [{ type: 'create', category: 'event' }],
      predicted: [
        {
          ...createAction({ due: dueAt('2026-10-02T23:59:00+03:00', { allDay: true }) }),
          decision: 'shown',
        },
      ],
      // A different clock-of-day on the same calendar date still matches for an all-day due.
      resolvedExpectedDue: [new Date('2026-10-02T00:00:00+03:00')],
    });

    const exact = computeMetrics([exactMatch]);
    expect(exact.dueAccuracy).toBeCloseTo(1);
    const mismatch = computeMetrics([exactMismatch]);
    expect(mismatch.dueAccuracy).toBeCloseTo(0);
    const allDay = computeMetrics([allDayMatch]);
    expect(allDay.dueAccuracy).toBeCloseTo(1);
  });

  it('does not count a suppressed action as shown (brief step 1.5)', () => {
    const r = row({
      expected: [{ type: 'create', category: 'assignment' }],
      predicted: [{ ...createAction(), decision: 'suppressed' }],
    });
    const metrics = computeMetrics([r]);
    expect(metrics.recall).toBeCloseTo(0);
    expect(metrics.precision).toBeCloseTo(1); // vacuous: no shown FP either
  });

  it('uses EVAL_OWNER_USER_ID for an expected "OWNER" assignee', () => {
    const r = row({
      expected: [{ type: 'create', category: 'owner_intent', assignee: 'OWNER' }],
      predicted: [
        {
          ...createAction({
            category: 'owner_intent',
            assignee: { type: 'user', userId: EVAL_OWNER_USER_ID },
          }),
          decision: 'shown',
        },
      ],
    });
    const metrics = computeMetrics([r]);
    expect(metrics.assigneeAccuracy).toBeCloseTo(1);
  });
});
