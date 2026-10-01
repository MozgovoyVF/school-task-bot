import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EvalCaseSchema } from '../../../eval/schema.js';

const cases = readFileSync('eval/datasets/school_ru.v1.jsonl', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => EvalCaseSchema.parse(JSON.parse(l)));
// The dataset test brief describes `examples.school_ru.json` as an array of
// `{ messages: Array<{ text: string }> }`, but the actual file (Task 2.3)
// stores each few-shot example as `{ user: string; assistant: string }`,
// where `user` is the full rendered prompt (system context + message
// excerpts) rather than a structured message list. There is no `messages`
// field to read, so the leak check below works against the real shape: it
// asserts that no dataset message text appears verbatim inside any few-shot
// example's rendered `user` prompt.
const examples = JSON.parse(readFileSync('prompts/examples.school_ru.json', 'utf8')) as Array<{
  user: string;
}>;
const share = (pred: (c: (typeof cases)[number]) => boolean) => cases.filter(pred).length / cases.length;

describe('eval dataset (SPEC §20.1)', () => {
  it('has at least 150 unique cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(150);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
  it('follows the target distribution', () => {
    expect(share((c) => c.expected.some((a) => a.type === 'create'))).toBeGreaterThanOrEqual(0.4);
    expect(share((c) => c.expected.some((a) => a.type === 'create'))).toBeLessThanOrEqual(0.5);
    const mod = share((c) => c.expected.length > 0 && c.expected.every((a) => a.type !== 'create'));
    expect(mod).toBeGreaterThanOrEqual(0.12);
    expect(mod).toBeLessThanOrEqual(0.18);
    expect(share((c) => c.expected.length === 0)).toBeGreaterThanOrEqual(0.35);
    expect(share((c) => c.expected.length === 0)).toBeLessThanOrEqual(0.45);
  });
  it('covers every category', () => {
    for (const cat of ['assignment', 'event', 'owner_intent', 'commitment', 'request_to_owner']) {
      expect(cases.filter((c) => c.expected.some((a) => a.category === cat)).length).toBeGreaterThanOrEqual(
        8,
      );
    }
  });
  it('covers date phrases, month and year crossing', () => {
    const dateCases = cases.filter((c) => c.tags.includes('dates'));
    expect(dateCases.length).toBeGreaterThanOrEqual(20);
    const all = dateCases.flatMap((c) => c.messages.map((m) => m.text.toLowerCase())).join('\n');
    for (const p of [
      'к пятнице',
      'в среду в 15',
      'до конца недели',
      'на днях',
      'завтра утром',
      'после обеда',
      'через неделю',
      '15.10',
      'к 1 ноября',
    ]) {
      expect(all).toContain(p);
    }
    expect(cases.some((c) => c.tags.includes('month_cross'))).toBe(true);
    expect(cases.some((c) => c.tags.includes('year_cross'))).toBe(true);
  });
  it('has consistent references', () => {
    for (const c of cases) {
      const people = new Set([...c.participants.map((p) => p.code), 'OWNER', 'ALL']);
      const targets = new Set([...c.openTasks.map((t) => t.ref), ...c.openProposals.map((p) => p.ref)]);
      for (const a of c.expected) {
        if (a.assignee) expect(people.has(a.assignee), `${c.id}`).toBe(true);
        if (a.targetRef) expect(targets.has(a.targetRef), `${c.id}`).toBe(true);
      }
    }
  });
  it('does not leak few-shot examples', () => {
    const shots = examples.map((e) => e.user);
    for (const c of cases) {
      for (const m of c.messages) {
        expect(
          shots.some((u) => u.includes(m.text)),
          c.id,
        ).toBe(false);
      }
    }
  });
});
