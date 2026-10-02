import { describe, it, expect } from 'vitest';
import { parseProposalPayload } from '../../../src/domain/proposals/repo.js';

describe('parseProposalPayload', () => {
  // D46 fix round 1 (critical): every proposal row persisted before `quoteAuthorUserId` was introduced has
  // no such key in its jsonb `payload` at all. `ProposalPayloadSchema.safeParse` must tolerate its total
  // absence (not merely `null`) or every pre-existing proposal becomes unparsable — `acceptProposal`,
  // `loadEditable` and the duplicate lookup would all break for every old pending proposal.
  it('parses a legacy payload with no quoteAuthorUserId key at all (pre-D46 row)', () => {
    const legacyPayload = {
      title: 'Подготовить расписание',
      description: null,
      category: 'assignment',
      assignee: { type: 'none' },
      due: null,
      dueText: null,
      priority: 'normal',
      reasoning: 'placeholder',
      origin: 'ai',
      quote: 'Цитата',
      quoteAuthorName: 'Анна',
      // No `quoteAuthorUserId` key — this is exactly the shape of a pre-D46 row.
    };

    const parsed = parseProposalPayload(legacyPayload);
    expect(parsed).not.toBeNull();
    expect(parsed?.quoteAuthorUserId).toBeUndefined();
  });

  it('still parses a payload with an explicit quoteAuthorUserId (null or a number)', () => {
    const base = {
      reasoning: 'placeholder',
      origin: 'ai' as const,
      quote: null,
      quoteAuthorName: null,
    };

    expect(parseProposalPayload({ ...base, quoteAuthorUserId: null })?.quoteAuthorUserId).toBeNull();
    expect(parseProposalPayload({ ...base, quoteAuthorUserId: 42 })?.quoteAuthorUserId).toBe(42);
  });
});
