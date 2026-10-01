import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser, markDmStarted, markDmBlocked } from '../../../src/domain/people/repo.js';
import { createTaskService, type CreateTaskInput } from '../../../src/domain/tasks/service.js';
import { remindersHook } from '../../../src/domain/notifications/schedule.js';
import { memberships, notifications } from '../../../src/db/schema/index.js';
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
  source: { chatId: null, tgMessageId: null, link: null, quote: null },
  ...overrides,
});

describe('remindersHook', () => {
  it('creating a task with a due date and an employee assignee writes notifications only for the owner (D40)', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');

    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await markDmStarted(db, owner.id, clock.now());
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });

    const employee = await upsertTelegramUser(db, { id: 2, first_name: 'Ivan' });
    await markDmStarted(db, employee.id, clock.now());
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: employee.id, role: 'member', displayName: 'Ivan' });

    const service = createTaskService({ clock, config: {} as Env, taskHooks: [remindersHook] });

    const task = await db.transaction((tx) =>
      service.create(
        tx,
        baseInput({
          workspaceId: ws.id,
          assignee: { type: 'user', userId: employee.id },
          due: { at: new Date('2026-09-30T10:00:00+03:00'), allDay: false, tz: 'Europe/Moscow' },
        }),
        { type: 'user', userId: owner.id },
      ),
    );

    const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.recipientUserId === owner.id)).toBe(true);
  });

  it('owner has not started a DM — no notifications', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');

    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });

    const service = createTaskService({ clock, config: {} as Env, taskHooks: [remindersHook] });

    const task = await db.transaction((tx) =>
      service.create(
        tx,
        baseInput({
          workspaceId: ws.id,
          due: { at: new Date('2026-09-30T10:00:00+03:00'), allDay: false, tz: 'Europe/Moscow' },
        }),
        { type: 'user', userId: owner.id },
      ),
    );

    const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(rows).toHaveLength(0);
  });

  it('owner blocked the bot — no notifications', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');

    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await markDmStarted(db, owner.id, clock.now());
    await markDmBlocked(db, owner.id, true);
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });

    const service = createTaskService({ clock, config: {} as Env, taskHooks: [remindersHook] });

    const task = await db.transaction((tx) =>
      service.create(
        tx,
        baseInput({
          workspaceId: ws.id,
          due: { at: new Date('2026-09-30T10:00:00+03:00'), allDay: false, tz: 'Europe/Moscow' },
        }),
        { type: 'user', userId: owner.id },
      ),
    );

    const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(rows).toHaveLength(0);
  });

  it('changing the due date cancels the old scheduled rows and schedules new ones with v2 in the dedupe key', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');

    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await markDmStarted(db, owner.id, clock.now());
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });

    const service = createTaskService({ clock, config: {} as Env, taskHooks: [remindersHook] });

    const task = await db.transaction((tx) =>
      service.create(
        tx,
        baseInput({
          workspaceId: ws.id,
          due: { at: new Date('2026-09-30T10:00:00+03:00'), allDay: false, tz: 'Europe/Moscow' },
        }),
        { type: 'user', userId: owner.id },
      ),
    );

    const before = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.status === 'scheduled')).toBe(true);
    expect(before.every((r) => r.dedupeKey.includes(':v1:'))).toBe(true);

    await db.transaction((tx) =>
      service.update(
        tx,
        task.id,
        { due: { at: new Date('2026-10-05T10:00:00+03:00'), allDay: false, tz: 'Europe/Moscow' } },
        { type: 'user', userId: owner.id },
      ),
    );

    const after = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    const oldRows = after.filter((r) => r.dedupeKey.includes(':v1:'));
    const newRows = after.filter((r) => r.dedupeKey.includes(':v2:'));

    expect(oldRows.length).toBeGreaterThan(0);
    expect(oldRows.every((r) => r.status === 'cancelled')).toBe(true);
    expect(newRows.length).toBeGreaterThan(0);
    expect(newRows.every((r) => r.status === 'scheduled')).toBe(true);
  });

  it('moving the due time within the same day after a "due" reminder was already sent inserts a new row without conflict (D6)', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');

    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await markDmStarted(db, owner.id, clock.now());
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });

    const service = createTaskService({ clock, config: {} as Env, taskHooks: [remindersHook] });

    const task = await db.transaction((tx) =>
      service.create(
        tx,
        baseInput({
          workspaceId: ws.id,
          due: { at: new Date('2026-09-23T13:00:00+03:00'), allDay: false, tz: 'Europe/Moscow' },
        }),
        { type: 'user', userId: owner.id },
      ),
    );

    const beforeDue = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    const dueRow = beforeDue.find((r) => r.kind === 'due');
    expect(dueRow).toBeDefined();

    // Simulate the sending job (Task 3.3) marking it sent.
    await db.update(notifications).set({ status: 'sent' }).where(eq(notifications.id, dueRow!.id));

    // Due time moved later the same day — still after "now".
    await db.transaction((tx) =>
      service.update(
        tx,
        task.id,
        { due: { at: new Date('2026-09-23T18:00:00+03:00'), allDay: false, tz: 'Europe/Moscow' } },
        { type: 'user', userId: owner.id },
      ),
    );

    const after = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    const newDueRows = after.filter((r) => r.kind === 'due' && r.dedupeKey.includes(':v2:'));
    expect(newDueRows).toHaveLength(1);
    expect(newDueRows[0]?.status).toBe('scheduled');

    const sentRow = after.find((r) => r.id === dueRow!.id);
    expect(sentRow?.status).toBe('sent');
  });

  it('setStatus("done") or ("cancelled") cancels every scheduled notification', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');

    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await markDmStarted(db, owner.id, clock.now());
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });

    const service = createTaskService({ clock, config: {} as Env, taskHooks: [remindersHook] });

    const task = await db.transaction((tx) =>
      service.create(
        tx,
        baseInput({
          workspaceId: ws.id,
          due: { at: new Date('2026-09-30T10:00:00+03:00'), allDay: false, tz: 'Europe/Moscow' },
        }),
        { type: 'user', userId: owner.id },
      ),
    );

    const before = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(before.length).toBeGreaterThan(0);

    await db.transaction((tx) => service.setStatus(tx, task.id, 'done', { type: 'user', userId: owner.id }));

    const after = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(after.length).toBe(before.length);
    expect(after.every((r) => r.status === 'cancelled')).toBe(true);
  });
});
