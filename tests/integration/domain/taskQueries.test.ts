import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { chats, memberships, tasks } from '../../../src/db/schema/index.js';
import { listTasks, type ListFilter } from '../../../src/domain/tasks/queries.js';
import type { NewTaskRow, TaskRow } from '../../../src/domain/tasks/repo.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

async function makeWorkspace() {
  return ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
}

async function insertTask(workspaceId: number, overrides: Partial<NewTaskRow> = {}): Promise<TaskRow> {
  const now = new Date('2026-09-20T09:00:00Z');
  const [row] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title: 'Подготовить расписание',
      origin: 'manual_dm',
      status: 'open',
      createdAt: now,
      updatedAt: now,
      version: 1,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('expected the task row to be inserted');
  return row;
}

async function makeMember(workspaceId: number, tgId: number, displayName: string) {
  const user = await upsertTelegramUser(db, { id: tgId, first_name: displayName });
  await db.insert(memberships).values({ workspaceId, userId: user.id, role: 'member', displayName });
  return user;
}

describe('listTasks', () => {
  it('"today" classifies the same due date differently across the Yekaterinburg/Moscow midnight boundary (20:30Z)', async () => {
    const ws = await makeWorkspace();
    const now = new Date('2026-09-25T20:30:00Z'); // 23:30 MSK (still the 25th) / 01:30 Yekaterinburg (the 26th)

    // 21:00Z = 00:00 MSK on the 26th (tomorrow for Moscow) / 02:00 Yekaterinburg on the 26th (today there).
    const task = await insertTask(ws.id, { dueAt: new Date('2026-09-25T21:00:00Z'), dueAllDay: false });

    const moscow = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'today' },
      page: 1,
      now,
      zone: 'Europe/Moscow',
    });
    expect(moscow.items.map((i) => i.id)).not.toContain(task.id);

    const yekaterinburg = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'today' },
      page: 1,
      now,
      zone: 'Asia/Yekaterinburg',
    });
    expect(yekaterinburg.items.map((i) => i.id)).toContain(task.id);
  });

  it('"overdue" only ever returns past-instant datetime dues, regardless of the "today" boundary', async () => {
    const ws = await makeWorkspace();
    const now = new Date('2026-09-25T20:30:00Z');

    const overdue = await insertTask(ws.id, { dueAt: new Date('2026-09-25T10:00:00Z'), dueAllDay: false });
    const future = await insertTask(ws.id, { dueAt: new Date('2026-09-25T21:00:00Z'), dueAllDay: false });

    const r = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'overdue' },
      page: 1,
      now,
      zone: 'Europe/Moscow',
    });
    expect(r.items.map((i) => i.id)).toEqual([overdue.id]);
    expect(r.items.map((i) => i.id)).not.toContain(future.id);
  });

  it('"today_and_overdue" (/today) is the union of both buckets', async () => {
    const ws = await makeWorkspace();
    const now = new Date('2026-09-25T10:00:00Z'); // 13:00 MSK

    const overdue = await insertTask(ws.id, { dueAt: new Date('2026-09-25T09:00:00Z'), dueAllDay: false });
    const today = await insertTask(ws.id, { dueAt: new Date('2026-09-25T15:00:00Z'), dueAllDay: false });
    const later = await insertTask(ws.id, { dueAt: new Date('2026-10-01T10:00:00Z'), dueAllDay: false });

    const r = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'today_and_overdue' },
      page: 1,
      now,
      zone: 'Europe/Moscow',
    });
    const ids = r.items.map((i) => i.id).sort((a, b) => a - b);
    expect(ids).toEqual([overdue.id, today.id].sort((a, b) => a - b));
    expect(ids).not.toContain(later.id);
  });

  it('"archive" is done/cancelled tasks, newest-archived-first', async () => {
    const ws = await makeWorkspace();

    const oldDone = await insertTask(ws.id, {
      status: 'done',
      completedAt: new Date('2026-09-01T10:00:00Z'),
    });
    const newCancelled = await insertTask(ws.id, {
      status: 'cancelled',
      cancelledAt: new Date('2026-09-10T10:00:00Z'),
    });
    const stillOpen = await insertTask(ws.id, { status: 'open' });

    const r = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'archive' },
      page: 1,
      now: new Date('2026-09-20T09:00:00Z'),
      zone: 'Europe/Moscow',
    });

    expect(r.items.map((i) => i.id)).toEqual([newCancelled.id, oldDone.id]);
    expect(r.items.map((i) => i.id)).not.toContain(stillOpen.id);
  });

  it('paginates (5 per page by default) and clamps a page past the last one', async () => {
    const ws = await makeWorkspace();
    for (let i = 0; i < 12; i += 1) {
      await insertTask(ws.id, { title: `Задача ${String(i)}` });
    }

    const page1 = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'open' },
      page: 1,
      now: new Date('2026-09-20T09:00:00Z'),
      zone: 'Europe/Moscow',
    });
    expect(page1.items).toHaveLength(5);
    expect(page1.total).toBe(12);
    expect(page1.pages).toBe(3);

    const pastLast = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'open' },
      page: 99,
      now: new Date('2026-09-20T09:00:00Z'),
      zone: 'Europe/Moscow',
    });
    expect(pastLast.items).toHaveLength(2);
  });

  it('"no_due" only matches open/in_progress tasks with no due date, oldest-created first', async () => {
    const ws = await makeWorkspace();
    const older = await insertTask(ws.id, { dueAt: null, createdAt: new Date('2026-09-01T00:00:00Z') });
    const newer = await insertTask(ws.id, { dueAt: null, createdAt: new Date('2026-09-10T00:00:00Z') });
    await insertTask(ws.id, { dueAt: new Date('2026-09-20T00:00:00Z') });

    const r = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'no_due' },
      page: 1,
      now: new Date('2026-09-20T09:00:00Z'),
      zone: 'Europe/Moscow',
    });
    expect(r.items.map((i) => i.id)).toEqual([older.id, newer.id]);
  });

  it('"assignee" filters by a specific member, "none" (no member, no "everyone"), or "all"', async () => {
    const ws = await makeWorkspace();
    const maria = await makeMember(ws.id, 501, 'Мария');

    const hers = await insertTask(ws.id, { assigneeUserId: maria.id });
    const everyone = await insertTask(ws.id, { assigneeAll: true });
    const freeText = await insertTask(ws.id, { assigneeNameText: 'Новый сотрудник' });
    const unassigned = await insertTask(ws.id, {});

    const now = new Date('2026-09-20T09:00:00Z');
    const zone = 'Europe/Moscow';

    const forMaria = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'assignee', userId: maria.id },
      page: 1,
      now,
      zone,
    });
    expect(forMaria.items.map((i) => i.id)).toEqual([hers.id]);

    const forAll = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'assignee', userId: 'all' },
      page: 1,
      now,
      zone,
    });
    expect(forAll.items.map((i) => i.id)).toEqual([everyone.id]);

    const forNone = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'assignee', userId: 'none' },
      page: 1,
      now,
      zone,
    });
    const noneIds = forNone.items.map((i) => i.id).sort((a, b) => a - b);
    expect(noneIds).toEqual([freeText.id, unassigned.id].sort((a, b) => a - b));
  });

  it('"chat" filters by sourceChatId', async () => {
    const ws = await makeWorkspace();
    const [chatRow] = await db
      .insert(chats)
      .values({
        tgChatId: -1001,
        workspaceId: ws.id,
        title: 'Учительская',
        type: 'supergroup',
        status: 'active',
      })
      .returning();
    if (!chatRow) throw new Error('expected the chat row to be inserted');

    const fromChat = await insertTask(ws.id, { sourceChatId: chatRow.id });
    await insertTask(ws.id, {});

    const r = await listTasks(db, {
      workspaceId: ws.id,
      filter: { kind: 'chat', chatId: chatRow.id },
      page: 1,
      now: new Date('2026-09-20T09:00:00Z'),
      zone: 'Europe/Moscow',
    } satisfies { workspaceId: number; filter: ListFilter; page: number; now: Date; zone: string });
    expect(r.items.map((i) => i.id)).toEqual([fromChat.id]);
  });
});
