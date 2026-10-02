import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser, markDmStarted } from '../../../src/domain/people/repo.js';
import { createTaskService, type CreateTaskInput } from '../../../src/domain/tasks/service.js';
import { createSnooze } from '../../../src/domain/notifications/snooze.js';
import { notifications } from '../../../src/db/schema/index.js';
import type { Env } from '../../../src/config/env.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

const baseInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  workspaceId: 0, // filled in per-test once the workspace is known
  title: 'Подготовить расписание',
  description: null,
  assignee: { type: 'none' },
  due: { at: null, allDay: false, tz: null },
  priority: 'normal',
  origin: 'manual_dm',
  proposalId: null,
  source: { chatId: null, tgMessageId: null, link: null, quote: null, quoteAuthorUserId: null },
  ...overrides,
});

describe('createSnooze', () => {
  it('inserts a scheduled kind=snooze row keyed by snooze:{task}:{recipient}:{fireAtISO}', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await markDmStarted(db, owner.id, clock.now());

    // `taskHooks: []` — `createSnooze` never goes through `TaskService`/`remindersHook` (SPEC §13.3), so
    // the task itself is created with no hooks to keep this test focused on `createSnooze` alone.
    const service = createTaskService({ clock, config: {} as Env, taskHooks: [] });
    const task = await db.transaction((tx) =>
      service.create(tx, baseInput({ workspaceId: ws.id }), { type: 'user', userId: owner.id }),
    );

    const fireAt = new Date('2026-09-23T13:00:00+03:00');
    await db.transaction((tx) =>
      createSnooze(tx, { taskId: task.id, recipientUserId: owner.id, fireAt, workspaceId: ws.id }),
    );

    const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kind).toBe('snooze');
    expect(row?.status).toBe('scheduled');
    expect(row?.recipientUserId).toBe(owner.id);
    expect(row?.workspaceId).toBe(ws.id);
    expect(row?.fireAt.toISOString()).toBe(fireAt.toISOString());
    expect(row?.dedupeKey).toBe(`snooze:${String(task.id)}:${String(owner.id)}:${fireAt.toISOString()}`);
  });

  it('a second insert for the exact same task/recipient/instant is a harmless no-op (onConflictDoNothing)', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await markDmStarted(db, owner.id, clock.now());

    const service = createTaskService({ clock, config: {} as Env, taskHooks: [] });
    const task = await db.transaction((tx) =>
      service.create(tx, baseInput({ workspaceId: ws.id }), { type: 'user', userId: owner.id }),
    );

    const fireAt = new Date('2026-09-23T13:00:00+03:00');
    const input = { taskId: task.id, recipientUserId: owner.id, fireAt, workspaceId: ws.id };
    await db.transaction((tx) => createSnooze(tx, input));
    await expect(db.transaction((tx) => createSnooze(tx, input))).resolves.not.toThrow();

    const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(rows).toHaveLength(1);
  });
});
