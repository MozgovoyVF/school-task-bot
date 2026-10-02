import { describe, it, expect } from 'vitest';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { feedbackStats } from '../../../src/domain/proposals/feedback.js';
import { proposals } from '../../../src/db/schema/index.js';
import type { ProposalPayload } from '../../../src/domain/proposals/repo.js';

const db = getTestDb();

function basePayload(overrides: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    title: 'Подготовить расписание на четверг',
    description: null,
    reasoning: 'test',
    origin: 'ai',
    quote: 'не забудьте про расписание, пожалуйста',
    quoteAuthorName: 'Директор',
    ...overrides,
  };
}

interface SeedProposalInput {
  workspaceId: number;
  kind: 'create' | 'update' | 'complete' | 'cancel';
  category: 'assignment' | 'event' | 'owner_intent' | 'commitment' | 'request_to_owner' | 'manual' | null;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded' | 'expired';
  policyDecision: 'shown' | 'suppressed';
  confidence: number;
  rejectReason?: 'not_task' | 'duplicate' | 'already_done' | 'other' | null;
  payload: ProposalPayload;
  createdAt: Date;
}

async function seedProposal(input: SeedProposalInput) {
  const [row] = await db
    .insert(proposals)
    .values({
      workspaceId: input.workspaceId,
      chatId: null,
      batchId: null,
      kind: input.kind,
      category: input.category,
      payload: input.payload,
      targetTaskId: null,
      confidence: input.confidence,
      policyDecision: input.policyDecision,
      policyReason: 'test',
      status: input.status,
      rejectReason: input.rejectReason ?? null,
      sourceMessageIds: [],
      createdAt: input.createdAt,
    })
    .returning();
  if (!row) throw new Error('seedProposal: insert returned no row');
  return row;
}

describe('feedbackStats', () => {
  it('aggregates seeded decisions into byCategory/rejectReasons/editedFields/confidenceBuckets, filtered by since', async () => {
    await truncateAll(db);
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const inWindow = (daysAfterSince: number) =>
      new Date(since.getTime() + daysAfterSince * 24 * 60 * 60 * 1000);

    // A: assignment, accepted, confidence 0.92 -> bucket [0.8,1], ownerEdits title+due.
    await seedProposal({
      workspaceId: ws.id,
      kind: 'create',
      category: 'assignment',
      status: 'accepted',
      policyDecision: 'shown',
      confidence: 0.92,
      payload: basePayload({
        ownerEdits: {
          title: { before: 'Подготовить расписание', after: 'Подготовить расписание на четверг' },
          due: { before: null, after: '2026-10-02' },
        },
      }),
      createdAt: inWindow(1),
    });

    // B: assignment, rejected (not_task), confidence 0.55 -> bucket [0.4,0.6).
    await seedProposal({
      workspaceId: ws.id,
      kind: 'create',
      category: 'assignment',
      status: 'rejected',
      policyDecision: 'shown',
      confidence: 0.55,
      rejectReason: 'not_task',
      payload: basePayload({ title: 'Купить цветы' }),
      createdAt: inWindow(2),
    });

    // C: event, rejected (duplicate), confidence 0.3 -> bucket [0.2,0.4).
    await seedProposal({
      workspaceId: ws.id,
      kind: 'create',
      category: 'event',
      status: 'rejected',
      policyDecision: 'shown',
      confidence: 0.3,
      rejectReason: 'duplicate',
      payload: basePayload({ title: 'Собрание родителей' }),
      createdAt: inWindow(3),
    });

    // D: event, still pending, shown but undecided -> contributes to byCategory.shown only, excluded from
    // confidenceBuckets (no accept/reject decision yet).
    await seedProposal({
      workspaceId: ws.id,
      kind: 'create',
      category: 'event',
      status: 'pending',
      policyDecision: 'shown',
      confidence: 0.7,
      payload: basePayload({ title: 'Экскурсия в музей' }),
      createdAt: inWindow(4),
    });

    // E: category null ("unknown" bucket), accepted, suppressed (shown=0), confidence 0.99 -> [0.8,1].
    await seedProposal({
      workspaceId: ws.id,
      kind: 'create',
      category: null,
      status: 'accepted',
      policyDecision: 'suppressed',
      confidence: 0.99,
      payload: basePayload({ title: 'Что-то малозначимое' }),
      createdAt: inWindow(5),
    });

    // G: commitment, rejected with no reason (update/complete/cancel kinds never get a reason submenu) ->
    // counted under rejectReasons.unspecified. Confidence 0.65 -> bucket [0.6,0.8).
    await seedProposal({
      workspaceId: ws.id,
      kind: 'update',
      category: 'commitment',
      status: 'rejected',
      policyDecision: 'shown',
      confidence: 0.65,
      rejectReason: null,
      payload: basePayload({ changes: { title: 'Сдать отчёт' } }),
      createdAt: inWindow(6),
    });

    // H: assignment, accepted again, confidence 0.85 -> [0.8,1], ownerEdits.title (accumulates with A).
    await seedProposal({
      workspaceId: ws.id,
      kind: 'create',
      category: 'assignment',
      status: 'accepted',
      policyDecision: 'shown',
      confidence: 0.85,
      payload: basePayload({
        title: 'Заказать автобус',
        ownerEdits: { title: { before: 'Заказать транспорт', after: 'Заказать автобус' } },
      }),
      createdAt: inWindow(6.5),
    });

    // F: outside the `since` window entirely — must be excluded from every count below.
    await seedProposal({
      workspaceId: ws.id,
      kind: 'create',
      category: 'assignment',
      status: 'rejected',
      policyDecision: 'shown',
      confidence: 0.1,
      rejectReason: 'other',
      payload: basePayload({ title: 'Старое предложение вне окна' }),
      createdAt: new Date(since.getTime() - 24 * 60 * 60 * 1000),
    });

    const stats = await feedbackStats(db, { since, withText: false });

    expect(stats.byCategory).toEqual({
      assignment: { shown: 3, accepted: 2, rejected: 1 },
      event: { shown: 2, accepted: 0, rejected: 1 },
      commitment: { shown: 1, accepted: 0, rejected: 1 },
      unknown: { shown: 0, accepted: 1, rejected: 0 },
    });

    expect(stats.rejectReasons).toEqual({ not_task: 1, duplicate: 1, unspecified: 1 });

    expect(stats.editedFields).toEqual({ title: 2, due: 1 });

    expect(stats.confidenceBuckets).toEqual([
      { from: 0, to: 0.2, accepted: 0, rejected: 0 },
      { from: 0.2, to: 0.4, accepted: 0, rejected: 1 },
      { from: 0.4, to: 0.6, accepted: 0, rejected: 1 },
      { from: 0.6, to: 0.8, accepted: 0, rejected: 1 },
      { from: 0.8, to: 1, accepted: 3, rejected: 0 },
    ]);
  });

  it('withText: false never leaks task titles/quotes — not even inside JSON.stringify of the result', async () => {
    await truncateAll(db);
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();
    const since = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    const secretTitle = 'СОВЕРШЕННО СЕКРЕТНОЕ НАЗВАНИЕ ЗАДАЧИ';
    const secretQuote = 'ЦИТАТА_ИЗ_ЧАТА_КОТОРУЮ_НЕЛЬЗЯ_ПОКАЗЫВАТЬ';

    await seedProposal({
      workspaceId: ws.id,
      kind: 'create',
      category: 'assignment',
      status: 'accepted',
      policyDecision: 'shown',
      confidence: 0.91,
      payload: basePayload({ title: secretTitle, quote: secretQuote }),
      createdAt: now,
    });

    const statsWithoutText = await feedbackStats(db, { since, withText: false });
    expect(statsWithoutText.samples).toBeUndefined();

    const serialized = JSON.stringify(statsWithoutText);
    expect(serialized).not.toContain(secretTitle);
    expect(serialized).not.toContain(secretQuote);

    // Sanity check the flag actually works, and that samples is where the text would otherwise leak from.
    const statsWithText = await feedbackStats(db, { since, withText: true });
    expect(JSON.stringify(statsWithText)).toContain(secretTitle);
  });
});
