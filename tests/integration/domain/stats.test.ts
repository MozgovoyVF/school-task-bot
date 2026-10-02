import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { memberships, tasks, workspaces } from '../../../src/db/schema/index.js';
import { taskStats } from '../../../src/domain/tasks/stats.js';
import type { NewTaskRow, TaskRow } from '../../../src/domain/tasks/repo.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

async function makeWorkspace() {
  return ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
}

async function makeOwner(workspaceId: number, tgId: number, displayName: string) {
  const user = await upsertTelegramUser(db, { id: tgId, first_name: displayName });
  await db.insert(memberships).values({ workspaceId, userId: user.id, role: 'owner', displayName });
  return user;
}

async function makeMember(workspaceId: number, tgId: number, displayName: string) {
  const user = await upsertTelegramUser(db, { id: tgId, first_name: displayName });
  await db.insert(memberships).values({ workspaceId, userId: user.id, role: 'member', displayName });
  return user;
}

async function insertTask(workspaceId: number, overrides: Partial<NewTaskRow> = {}): Promise<TaskRow> {
  const createdAt = new Date('2026-09-15T09:00:00Z');
  const [row] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title: 'Задача',
      origin: 'manual_dm',
      status: 'open',
      createdAt,
      updatedAt: createdAt,
      version: 1,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('expected the task row to be inserted');
  return row;
}

describe('taskStats', () => {
  it("Maria's 30-day stats: 2 on-time, 1 late by 48h, 1 open+overdue, 1 in_progress", async () => {
    const ws = await makeWorkspace();
    const owner = await makeOwner(ws.id, 1, 'Анна');
    const maria = await makeMember(ws.id, 2, 'Мария');

    const now = new Date('2026-09-25T10:00:00Z');
    const due = new Date('2026-09-20T12:00:00Z');

    // 2 done on time.
    await insertTask(ws.id, {
      assigneeUserId: maria.id,
      status: 'done',
      dueAt: due,
      completedAt: new Date('2026-09-20T10:00:00Z'),
    });
    await insertTask(ws.id, {
      assigneeUserId: maria.id,
      status: 'done',
      dueAt: due,
      completedAt: due,
    });
    // 1 done, 48h late.
    await insertTask(ws.id, {
      assigneeUserId: maria.id,
      status: 'done',
      dueAt: due,
      completedAt: new Date('2026-09-22T12:00:00Z'),
    });
    // 1 open and overdue (due before `now`).
    await insertTask(ws.id, {
      assigneeUserId: maria.id,
      status: 'open',
      dueAt: new Date('2026-09-24T10:00:00Z'),
    });
    // 1 in_progress, not overdue.
    await insertTask(ws.id, {
      assigneeUserId: maria.id,
      status: 'in_progress',
      dueAt: new Date('2026-10-01T10:00:00Z'),
    });

    // Owner's own self-delegated task, and an unassigned one — both should get their own separate rows.
    await insertTask(ws.id, { assigneeUserId: owner.id, status: 'open' });
    await insertTask(ws.id, { status: 'open' });

    const rows = await taskStats(db, { workspaceId: ws.id, periodDays: 30, now });

    const mariaRow = rows.find((r) => r.key.type === 'user' && r.key.name === 'Мария');
    expect(mariaRow).toBeDefined();
    expect(mariaRow).toMatchObject({
      open: 1,
      inProgress: 1,
      overdueNow: 1,
      done: 3,
      onTimePct: 67,
      avgLateHours: 48,
    });

    const ownerRow = rows.find((r) => r.key.type === 'owner');
    expect(ownerRow).toBeDefined();

    const noneRow = rows.find((r) => r.key.type === 'none');
    expect(noneRow).toBeDefined();
  });

  it('onTimePct and avgLateHours are null when there are no done/late tasks', async () => {
    const ws = await makeWorkspace();
    const maria = await makeMember(ws.id, 2, 'Мария');
    const now = new Date('2026-09-25T10:00:00Z');

    await insertTask(ws.id, { assigneeUserId: maria.id, status: 'open' });

    const rows = await taskStats(db, { workspaceId: ws.id, periodDays: 30, now });
    const mariaRow = rows.find((r) => r.key.type === 'user');

    expect(mariaRow?.done).toBe(0);
    expect(mariaRow?.onTimePct).toBeNull();
    expect(mariaRow?.avgLateHours).toBeNull();
  });

  it('onTimePct is null when done but avgLateHours is null only when every done task was on time', async () => {
    const ws = await makeWorkspace();
    const maria = await makeMember(ws.id, 2, 'Мария');
    const now = new Date('2026-09-25T10:00:00Z');
    const due = new Date('2026-09-20T12:00:00Z');

    await insertTask(ws.id, {
      assigneeUserId: maria.id,
      status: 'done',
      dueAt: due,
      completedAt: due,
    });

    const rows = await taskStats(db, { workspaceId: ws.id, periodDays: 30, now });
    const mariaRow = rows.find((r) => r.key.type === 'user');

    expect(mariaRow?.onTimePct).toBe(100);
    expect(mariaRow?.avgLateHours).toBeNull();
  });

  it('a task with no due date at all counts as on-time once done', async () => {
    const ws = await makeWorkspace();
    const maria = await makeMember(ws.id, 2, 'Мария');
    const now = new Date('2026-09-25T10:00:00Z');

    await insertTask(ws.id, {
      assigneeUserId: maria.id,
      status: 'done',
      dueAt: null,
      completedAt: new Date('2026-09-20T10:00:00Z'),
    });

    const rows = await taskStats(db, { workspaceId: ws.id, periodDays: 30, now });
    const mariaRow = rows.find((r) => r.key.type === 'user');

    expect(mariaRow?.onTimePct).toBe(100);
  });

  it('periodDays filters the cohort by createdAt, excluding tasks created before the cutoff', async () => {
    const ws = await makeWorkspace();
    const maria = await makeMember(ws.id, 2, 'Мария');
    const now = new Date('2026-09-25T10:00:00Z');

    await insertTask(ws.id, {
      assigneeUserId: maria.id,
      status: 'open',
      createdAt: new Date('2026-09-20T00:00:00Z'), // 5 days before `now`: inside a 7-day window.
    });
    await insertTask(ws.id, {
      assigneeUserId: maria.id,
      status: 'open',
      createdAt: new Date('2026-09-01T00:00:00Z'), // 24 days before `now`: outside a 7-day window.
    });

    const rows = await taskStats(db, { workspaceId: ws.id, periodDays: 7, now });
    const mariaRow = rows.find((r) => r.key.type === 'user');

    expect(mariaRow?.open).toBe(1);
  });

  it('cancelled tasks are excluded entirely from every count', async () => {
    const ws = await makeWorkspace();
    const maria = await makeMember(ws.id, 2, 'Мария');
    const now = new Date('2026-09-25T10:00:00Z');

    await insertTask(ws.id, { assigneeUserId: maria.id, status: 'cancelled' });

    const rows = await taskStats(db, { workspaceId: ws.id, periodDays: 30, now });

    expect(rows.find((r) => r.key.type === 'user')).toBeUndefined();
  });

  it('a group absent from the cohort gets no row at all (no zero-padded rows)', async () => {
    const ws = await makeWorkspace();
    await makeMember(ws.id, 2, 'Мария'); // No tasks for her at all.
    const now = new Date('2026-09-25T10:00:00Z');

    const rows = await taskStats(db, { workspaceId: ws.id, periodDays: 30, now });

    expect(rows).toEqual([]);
  });

  it('never mixes tasks from a different workspace into the stats', async () => {
    const ws1 = await makeWorkspace();
    const [ws2] = await db
      .insert(workspaces)
      .values({ name: 'Другая школа', timezone: 'Europe/Moscow' })
      .returning();
    if (!ws2) throw new Error('expected the second workspace to be inserted');
    const maria1 = await makeMember(ws1.id, 2, 'Мария');
    await makeMember(ws2.id, 3, 'Мария');
    const now = new Date('2026-09-25T10:00:00Z');

    await insertTask(ws1.id, { assigneeUserId: maria1.id, status: 'open' });

    const rows = await taskStats(db, { workspaceId: ws1.id, periodDays: 30, now });
    const mariaRow = rows.find((r) => r.key.type === 'user');

    expect(mariaRow?.open).toBe(1);
  });
});
