import { describe, it, expect } from 'vitest';
import { applyPolicy } from '../../../src/ai/pipeline/policy.js';
import type { ResolvedDue } from '../../../src/time/resolveDue.js';

const T = { low: 0.35, high: 0.7, modify: 0.5 };
const due = {
  dueAt: new Date('2026-09-25T15:00:00Z'),
  allDay: false,
  tz: 'Europe/Moscow',
  inPast: false,
  invalid: false,
  dueText: 'к пятнице',
};
const noDue = { dueAt: null, allDay: false, tz: null, inPast: false, invalid: false, dueText: null };
const create = (category: string, confidence: number, d: ResolvedDue = noDue) =>
  ({
    kind: 'create',
    category,
    confidence,
    due: d,
    title: 'X',
    description: null,
    assignee: { type: 'none' },
    priority: 'normal',
    sourceMessageIds: [1],
    reasoning: '',
  }) as never;
const modify = (kind: string, confidence: number) =>
  ({ kind, confidence, target: { taskId: 1 }, sourceMessageIds: [1], reasoning: '', changes: {} }) as never;

describe('policy (SPEC §9.6)', () => {
  it.each([
    [create('assignment', 0.35), 'shown'],
    [create('assignment', 0.34), 'suppressed'],
    [create('event', 0.5), 'shown'],
    [create('owner_intent', 0.35), 'shown'],
    [create('commitment', 0.35, due), 'shown'],
    [create('commitment', 0.34, due), 'suppressed'],
    [create('commitment', 0.69), 'suppressed'],
    [create('commitment', 0.7), 'shown'],
    [create('request_to_owner', 0.69), 'suppressed'],
    [create('request_to_owner', 0.4, due), 'shown'],
    [modify('update', 0.5), 'shown'],
    [modify('update', 0.49), 'suppressed'],
    [modify('complete', 0.5), 'shown'],
    [modify('cancel', 0.49), 'suppressed'],
  ])('%# → %s', (a, expected) => expect(applyPolicy(a, T, 'auto').decision).toBe(expected));

  it('explains suppression', () => {
    expect(applyPolicy(create('commitment', 0.5), T, 'auto').reason).toBe(
      'commitment_without_due_below_high',
    );
    expect(applyPolicy(create('assignment', 0.1), T, 'auto').reason).toBe('below_low');
    expect(applyPolicy(modify('update', 0.1), T, 'auto').reason).toBe('modify_below_threshold');
  });

  it('never suppresses manual requests', () => {
    expect(applyPolicy(create('assignment', 0.01), T, 'manual').decision).toBe('shown');
  });
});
