import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { aiStats, listRecentBatches } from '../../../src/domain/ai/stats.js';
import { analysisBatches, proposals } from '../../../src/db/schema/index.js';
import type { ProposalPayload } from '../../../src/domain/proposals/repo.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

const DAY_MS = 24 * 60 * 60 * 1000;

function basePayload(overrides: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    title: 'Test',
    description: null,
    category: 'assignment',
    assignee: { type: 'none' },
    due: null,
    dueText: null,
    priority: 'normal',
    reasoning: 'test',
    origin: 'ai',
    quote: null,
    quoteAuthorName: null,
    ...overrides,
  };
}

async function insertBatch(overrides: Partial<typeof analysisBatches.$inferInsert> = {}) {
  const [row] = await db
    .insert(analysisBatches)
    .values({ status: 'done', kind: 'auto', messageCount: 1, ...overrides })
    .returning();
  if (!row) throw new Error('insertBatch: insert returned no row');
  return row;
}

async function insertProposalRow(
  workspaceId: number,
  overrides: Partial<typeof proposals.$inferInsert> = {},
) {
  const [row] = await db
    .insert(proposals)
    .values({
      workspaceId,
      kind: 'create',
      payload: basePayload(),
      confidence: 0.8,
      policyDecision: 'shown',
      policyReason: 'above_low',
      status: 'pending',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('insertProposalRow: insert returned no row');
  return row;
}

describe('aiStats', () => {
  it('sums cost_usd by finished_at into today/month, tz-local boundaries', async () => {
    const clock = fixedClock('2026-09-15T10:00:00Z'); // 13:00 Europe/Moscow
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();

    // Finished today (Moscow-local), well inside the day boundary.
    await insertBatch({ finishedAt: now, costUsd: '1.5' });
    // Finished earlier this month but not today.
    await insertBatch({ finishedAt: new Date(now.getTime() - 5 * DAY_MS), costUsd: '2.25' });
    // Finished last month — must not count toward costMonth.
    await insertBatch({ finishedAt: new Date(now.getTime() - 40 * DAY_MS), costUsd: '100' });
    // Still queued (finishedAt null) — must not count at all.
    await insertBatch({ status: 'queued', finishedAt: null, costUsd: null });

    const stats = await aiStats(db, { now, tz: ws.timezone });
    expect(stats.costToday).toBeCloseTo(1.5, 6);
    expect(stats.costMonth).toBeCloseTo(3.75, 6);
  });

  it('counts last-7-days shown/suppressed/accepted/rejected and derives precision', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();

    await insertProposalRow(ws.id, { policyDecision: 'shown', status: 'accepted', createdAt: now });
    await insertProposalRow(ws.id, { policyDecision: 'shown', status: 'rejected', createdAt: now });
    await insertProposalRow(ws.id, { policyDecision: 'suppressed', status: 'pending', createdAt: now });
    // Outside the 7-day window — must not be counted.
    await insertProposalRow(ws.id, {
      policyDecision: 'shown',
      status: 'accepted',
      createdAt: new Date(now.getTime() - 10 * DAY_MS),
    });

    const stats = await aiStats(db, { now, tz: ws.timezone });
    expect(stats.last7).toEqual({ shown: 2, suppressed: 1, accepted: 1, rejected: 1 });
    expect(stats.precision).toBeCloseTo(0.5, 6);
  });

  it('reports precision as null when nothing was accepted or rejected in the last 7 days', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();
    await insertProposalRow(ws.id, { policyDecision: 'shown', status: 'pending', createdAt: now });

    const stats = await aiStats(db, { now, tz: ws.timezone });
    expect(stats.precision).toBeNull();
  });

  it('groups pending proposals by chat, excluding decided ones and DM-only drafts', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();
    const chat = await upsertChatOnAdd(db, {
      tgChatId: -1,
      title: 'French teachers',
      type: 'supergroup',
      workspaceId: ws.id,
      addedByUserId: null,
      status: 'active',
      pendingSince: null,
      now,
    });

    await insertProposalRow(ws.id, { chatId: chat.id, status: 'pending', createdAt: now });
    await insertProposalRow(ws.id, { chatId: chat.id, status: 'pending', createdAt: now });
    await insertProposalRow(ws.id, { chatId: chat.id, status: 'accepted', createdAt: now });
    await insertProposalRow(ws.id, { chatId: null, status: 'pending', createdAt: now });

    const stats = await aiStats(db, { now, tz: ws.timezone });
    expect(stats.pendingByChat).toEqual([{ chatId: chat.id, title: 'French teachers', count: 2 }]);
  });
});

describe('listRecentBatches', () => {
  it('returns the most recent batches with shown/suppressed counts and a suppressed-reason breakdown', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();
    const chat = await upsertChatOnAdd(db, {
      tgChatId: -2,
      title: 'French teachers',
      type: 'supergroup',
      workspaceId: ws.id,
      addedByUserId: null,
      status: 'active',
      pendingSince: null,
      now,
    });

    const older = await insertBatch({ chatId: chat.id, createdAt: new Date(now.getTime() - DAY_MS) });
    const newer = await insertBatch({
      chatId: chat.id,
      createdAt: now,
      model: 'test-model',
      costUsd: '0.01',
    });

    await insertProposalRow(ws.id, {
      chatId: chat.id,
      batchId: newer.id,
      policyDecision: 'shown',
      policyReason: 'above_low',
    });
    await insertProposalRow(ws.id, {
      chatId: chat.id,
      batchId: newer.id,
      policyDecision: 'suppressed',
      policyReason: 'below_low',
    });
    await insertProposalRow(ws.id, {
      chatId: chat.id,
      batchId: newer.id,
      policyDecision: 'suppressed',
      policyReason: 'below_low',
    });

    const rows = await listRecentBatches(db, { limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(newer.id); // newest first
    expect(rows[0]?.shown).toBe(1);
    expect(rows[0]?.suppressed).toBe(2);
    expect(rows[0]?.suppressedReasons).toEqual([{ reason: 'below_low', count: 2 }]);
    expect(rows[0]?.chatTitle).toBe('French teachers');
    expect(rows[1]?.id).toBe(older.id);
    expect(rows[1]?.shown).toBe(0);
    expect(rows[1]?.suppressed).toBe(0);
  });

  it('filters to one chat when chatId is given', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();
    const chatA = await upsertChatOnAdd(db, {
      tgChatId: -3,
      title: 'A',
      type: 'supergroup',
      workspaceId: ws.id,
      addedByUserId: null,
      status: 'active',
      pendingSince: null,
      now,
    });
    const chatB = await upsertChatOnAdd(db, {
      tgChatId: -4,
      title: 'B',
      type: 'supergroup',
      workspaceId: ws.id,
      addedByUserId: null,
      status: 'active',
      pendingSince: null,
      now,
    });
    await insertBatch({ chatId: chatA.id });
    await insertBatch({ chatId: chatB.id });

    const rows = await listRecentBatches(db, { limit: 10, chatId: chatA.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chatId).toBe(chatA.id);
  });
});
