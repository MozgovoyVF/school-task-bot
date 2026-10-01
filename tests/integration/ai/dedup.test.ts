import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { tasks, proposals } from '../../../src/db/schema/index.js';
import { findPossibleDuplicate, isRepeatInBatch } from '../../../src/ai/pipeline/dedup.js';
import type { AssigneeResolution, ResolvedAction } from '../../../src/ai/pipeline/resolve.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

const NOW = new Date('2026-09-28T10:00:00Z');

async function setupWorkspaceAndUsers() {
  const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
  const p1 = await upsertTelegramUser(db, { id: 1, first_name: 'Maria' });
  const p2 = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
  return { ws, p1, p2 };
}

interface InsertTaskOverrides {
  title?: string;
  status?: 'open' | 'in_progress' | 'done' | 'cancelled';
  assigneeUserId?: number | null;
  assigneeAll?: boolean;
  assigneeNameText?: string | null;
  createdAt?: Date;
}

async function insertTask(workspaceId: number, overrides: InsertTaskOverrides = {}) {
  const [row] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title: overrides.title ?? 'Подготовить расписание на октябрь',
      status: overrides.status ?? 'open',
      assigneeUserId: overrides.assigneeUserId ?? null,
      assigneeAll: overrides.assigneeAll ?? false,
      assigneeNameText: overrides.assigneeNameText ?? null,
      origin: 'ai',
      createdAt: overrides.createdAt ?? NOW,
    })
    .returning();
  if (!row) throw new Error('failed to insert test task');
  return row;
}

interface InsertProposalOverrides {
  title?: string;
  assignee?: AssigneeResolution;
  status?: 'pending' | 'accepted' | 'rejected' | 'superseded' | 'expired';
  kind?: 'create' | 'update' | 'complete' | 'cancel';
}

async function insertProposal(workspaceId: number, overrides: InsertProposalOverrides = {}) {
  const title = overrides.title ?? 'Подготовить расписание на октябрь';
  const assignee: AssigneeResolution = overrides.assignee ?? { type: 'none' };
  const [row] = await db
    .insert(proposals)
    .values({
      workspaceId,
      kind: overrides.kind ?? 'create',
      category: 'assignment',
      payload: { title, assignee },
      confidence: 0.8,
      policyDecision: 'shown',
      status: overrides.status ?? 'pending',
    })
    .returning();
  if (!row) throw new Error('failed to insert test proposal');
  return row;
}

function createAction(overrides: {
  title: string;
  sourceMessageIds: number[];
}): Extract<ResolvedAction, { kind: 'create' }> {
  return {
    kind: 'create',
    category: 'assignment',
    title: overrides.title,
    description: null,
    assignee: { type: 'none' },
    due: { dueAt: null, allDay: false, tz: null, inPast: false, invalid: false, dueText: null },
    priority: 'normal',
    sourceMessageIds: overrides.sourceMessageIds,
    confidence: 0.9,
    reasoning: 'test',
  };
}

describe('findPossibleDuplicate', () => {
  it('flags a near-duplicate open task with the same assignee', async () => {
    const { ws, p1 } = await setupWorkspaceAndUsers();
    const task = await insertTask(ws.id, { assigneeUserId: p1.id });

    const result = await findPossibleDuplicate(db, {
      workspaceId: ws.id,
      title: 'подготовить расписание на октябрь!',
      assignee: { type: 'user', userId: p1.id },
      now: NOW,
    });

    expect(result).not.toBeNull();
    expect(result?.type).toBe('task');
    expect(result?.id).toBe(task.id);
  });

  it('is not a duplicate when the assignee differs', async () => {
    const { ws, p1, p2 } = await setupWorkspaceAndUsers();
    await insertTask(ws.id, { assigneeUserId: p1.id });

    const result = await findPossibleDuplicate(db, {
      workspaceId: ws.id,
      title: 'подготовить расписание на октябрь!',
      assignee: { type: 'user', userId: p2.id },
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('is not a duplicate when the existing task was created 15 days ago', async () => {
    const { ws, p1 } = await setupWorkspaceAndUsers();
    const fifteenDaysAgo = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
    await insertTask(ws.id, { assigneeUserId: p1.id, createdAt: fifteenDaysAgo });

    const result = await findPossibleDuplicate(db, {
      workspaceId: ws.id,
      title: 'подготовить расписание на октябрь!',
      assignee: { type: 'user', userId: p1.id },
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('is not a duplicate when the existing task is done', async () => {
    const { ws, p1 } = await setupWorkspaceAndUsers();
    await insertTask(ws.id, { assigneeUserId: p1.id, status: 'done' });

    const result = await findPossibleDuplicate(db, {
      workspaceId: ws.id,
      title: 'подготовить расписание на октябрь!',
      assignee: { type: 'user', userId: p1.id },
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('is not a duplicate when the title is completely different', async () => {
    const { ws, p1 } = await setupWorkspaceAndUsers();
    await insertTask(ws.id, { assigneeUserId: p1.id });

    const result = await findPossibleDuplicate(db, {
      workspaceId: ws.id,
      title: 'заказать канцтовары',
      assignee: { type: 'user', userId: p1.id },
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('flags a near-duplicate pending proposal by payload.title', async () => {
    const { ws, p1 } = await setupWorkspaceAndUsers();
    const proposal = await insertProposal(ws.id, { assignee: { type: 'user', userId: p1.id } });

    const result = await findPossibleDuplicate(db, {
      workspaceId: ws.id,
      title: 'подготовить расписание на октябрь!',
      assignee: { type: 'user', userId: p1.id },
      now: NOW,
    });

    expect(result).not.toBeNull();
    expect(result?.type).toBe('proposal');
    expect(result?.id).toBe(proposal.id);
  });

  it('treats "all" and "all" assignees as matching', async () => {
    const { ws } = await setupWorkspaceAndUsers();
    const task = await insertTask(ws.id, { assigneeAll: true });

    const result = await findPossibleDuplicate(db, {
      workspaceId: ws.id,
      title: 'подготовить расписание на октябрь!',
      assignee: { type: 'all' },
      now: NOW,
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(task.id);
  });

  it('treats "none" and "none" assignees as matching', async () => {
    const { ws } = await setupWorkspaceAndUsers();
    const task = await insertTask(ws.id);

    const result = await findPossibleDuplicate(db, {
      workspaceId: ws.id,
      title: 'подготовить расписание на октябрь!',
      assignee: { type: 'none' },
      now: NOW,
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(task.id);
  });
});

describe('isRepeatInBatch', () => {
  it('is true for the same sourceMessageIds and a title differing only by case', () => {
    const existing = [createAction({ title: 'Подготовить расписание', sourceMessageIds: [1, 2] })];
    const candidate = createAction({ title: 'ПОДГОТОВИТЬ РАСПИСАНИЕ', sourceMessageIds: [2, 1] });

    expect(isRepeatInBatch(existing, candidate)).toBe(true);
  });
});
