import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { listPendingProposals, reanalyze } from '../../../src/domain/proposals/queries.js';
import { insertProposal, type ProposalPayload } from '../../../src/domain/proposals/repo.js';
import { analysisBatches, messages, proposals, tasks } from '../../../src/db/schema/index.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

function basePayload(overrides: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    title: 'Подготовить расписание',
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
    quoteAuthorUserId: null,
    ...overrides,
  };
}

async function makeChat(workspaceId: number, tgChatId: number, now: Date) {
  return upsertChatOnAdd(db, {
    tgChatId,
    title: `Chat ${String(tgChatId)}`,
    type: 'supergroup',
    workspaceId,
    addedByUserId: null,
    status: 'active',
    pendingSince: null,
    now,
  });
}

async function makeMessage(chatId: number, tgMessageId: number, sentAt: Date, text: string | null = 'hi') {
  const [row] = await db
    .insert(messages)
    .values({ chatId, tgMessageId, sentAt, text, analysisStatus: 'analyzed' })
    .returning();
  if (!row) throw new Error('makeMessage: insert returned no row');
  return row;
}

describe('listPendingProposals', () => {
  it('paginates pending proposals oldest-first, PAGE_SIZE per page, both shown and suppressed', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();
    const chat = await makeChat(ws.id, -1, now);

    for (let i = 0; i < 7; i++) {
      await db.transaction((tx) =>
        insertProposal(tx, {
          workspaceId: ws.id,
          chatId: chat.id,
          batchId: null,
          kind: 'create',
          category: 'assignment',
          payload: basePayload({ title: `Task ${String(i)}` }),
          targetTaskId: null,
          confidence: 0.5,
          policyDecision: i % 2 === 0 ? 'shown' : 'suppressed',
          policyReason: 'test',
          sourceMessageIds: [],
          createdAt: new Date(now.getTime() + i * 1000),
        }),
      );
    }
    // Already decided — must never appear.
    const decided = await db.transaction((tx) =>
      insertProposal(tx, {
        workspaceId: ws.id,
        chatId: chat.id,
        batchId: null,
        kind: 'create',
        category: 'assignment',
        payload: basePayload({ title: 'Decided' }),
        targetTaskId: null,
        confidence: 0.5,
        policyDecision: 'shown',
        policyReason: 'test',
        sourceMessageIds: [],
        createdAt: now,
      }),
    );
    await db.update(proposals).set({ status: 'accepted' }).where(eq(proposals.id, decided.id));

    const page1 = await listPendingProposals(db, ws.id, { page: 1, pageSize: 5 });
    expect(page1.total).toBe(7);
    expect(page1.items).toHaveLength(5);
    expect(page1.items.map((i) => i.title)).toEqual(['Task 0', 'Task 1', 'Task 2', 'Task 3', 'Task 4']);
    expect(page1.items[0]?.chatTitle).toBe(chat.title);

    const page2 = await listPendingProposals(db, ws.id, { page: 2, pageSize: 5 });
    expect(page2.total).toBe(7);
    expect(page2.items.map((i) => i.title)).toEqual(['Task 5', 'Task 6']);
  });

  it("resolves an update/complete/cancel proposal's title from its target task", async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();

    const [task] = await db
      .insert(tasks)
      .values({ workspaceId: ws.id, title: 'Существующая задача', origin: 'manual_dm' })
      .returning();
    if (!task) throw new Error('expected task to be inserted');

    await db.transaction((tx) =>
      insertProposal(tx, {
        workspaceId: ws.id,
        chatId: null,
        batchId: null,
        kind: 'complete',
        category: null,
        payload: {
          reasoning: 'test',
          origin: 'ai',
          quote: null,
          quoteAuthorName: null,
          quoteAuthorUserId: null,
        },
        targetTaskId: task.id,
        confidence: 0.9,
        policyDecision: 'shown',
        policyReason: 'test',
        sourceMessageIds: [],
        createdAt: now,
      }),
    );

    const page = await listPendingProposals(db, ws.id, { page: 1, pageSize: 5 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe('Существующая задача');
    expect(page.items[0]?.kind).toBe('complete');
  });
});

describe('reanalyze', () => {
  it('returns chat_not_found for an unknown chatId', async () => {
    await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const result = await reanalyze({ db, clock: fixedClock('2026-09-28T12:00:00Z') }, { chatId: 999999 });
    expect(result).toEqual({ ok: false, reason: 'chat_not_found' });
  });

  it('with no lastN, clears batch_id on a failed batch’s messages and leaves the batch row alone', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();
    const chat = await makeChat(ws.id, -10, now);

    const [batch] = await db
      .insert(analysisBatches)
      .values({ chatId: chat.id, status: 'failed', kind: 'auto', messageCount: 1 })
      .returning();
    if (!batch) throw new Error('expected batch to be inserted');
    const msg = await makeMessage(chat.id, 1, now);
    await db.update(messages).set({ batchId: batch.id }).where(eq(messages.id, msg.id));

    const result = await reanalyze({ db, clock }, { chatId: chat.id });
    expect(result).toEqual({ ok: true, mode: 'requeued', batches: 1, messages: 1 });

    const [after] = await db.select().from(messages).where(eq(messages.id, msg.id));
    expect(after?.batchId).toBeNull();

    const [batchAfter] = await db.select().from(analysisBatches).where(eq(analysisBatches.id, batch.id));
    expect(batchAfter?.status).toBe('failed');
  });

  it('with no lastN and no failed batches, is a no-op', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const chat = await makeChat(ws.id, -11, clock.now());

    const result = await reanalyze({ db, clock }, { chatId: chat.id });
    expect(result).toEqual({ ok: true, mode: 'requeued', batches: 0, messages: 0 });
  });

  it('with lastN, queues a fresh reanalyze batch over the chat’s last N text messages', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const now = clock.now();
    const chat = await makeChat(ws.id, -12, now);

    for (let i = 0; i < 5; i++) {
      await makeMessage(chat.id, i + 1, new Date(now.getTime() + i * 1000), `msg ${String(i)}`);
    }
    // A textless message must never be picked.
    await makeMessage(chat.id, 100, now, null);

    const result = await reanalyze({ db, clock }, { chatId: chat.id, lastN: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok || result.mode !== 'created') throw new Error('expected a created batch');
    expect(result.messages).toBe(2);

    const [batch] = await db.select().from(analysisBatches).where(eq(analysisBatches.id, result.batchId));
    expect(batch?.kind).toBe('reanalyze');
    expect(batch?.status).toBe('queued');
    expect(batch?.messageCount).toBe(2);

    const batched = await db
      .select()
      .from(messages)
      .where(eq(messages.batchId, result.batchId))
      .orderBy(messages.tgMessageId);
    expect(batched.map((m) => m.tgMessageId)).toEqual([4, 5]);
    expect(batched.every((m) => m.analysisStatus === 'pending')).toBe(true);
  });

  it('with lastN and no text messages, returns no_messages', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const chat = await makeChat(ws.id, -13, clock.now());

    const result = await reanalyze({ db, clock }, { chatId: chat.id, lastN: 5 });
    expect(result).toEqual({ ok: false, reason: 'no_messages' });
  });
});
