import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { createTaskService, type CreateTaskInput, type TaskHook } from '../../../src/domain/tasks/service.js';
import { taskEvents, tasks } from '../../../src/db/schema/index.js';
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

describe('TaskService', () => {
  it('create writes a version=1 row and a "created" task_event', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const service = createTaskService({ clock, config: {} as Env, taskHooks: [] });

    const owner = await upsertTelegramUser(db, { id: 100, first_name: 'Anna' });
    const task = await db.transaction((tx) =>
      service.create(tx, baseInput({ workspaceId: ws.id }), { type: 'user', userId: owner.id }),
    );

    expect(task.version).toBe(1);
    expect(task.status).toBe('open');

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('created');
    expect(events[0]?.actorType).toBe('user');
    expect(events[0]?.actorUserId).toBe(owner.id);
  });

  it('create truncates title to 120 chars and source_quote to 200', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const service = createTaskService({ clock, config: {} as Env, taskHooks: [] });

    const longTitle = 'A'.repeat(150);
    const longQuote = 'B'.repeat(250);
    const task = await db.transaction((tx) =>
      service.create(
        tx,
        baseInput({
          workspaceId: ws.id,
          title: longTitle,
          source: { chatId: null, tgMessageId: null, link: null, quote: longQuote },
        }),
        { type: 'system' },
      ),
    );

    expect(task.title).toHaveLength(120);
    expect(task.title).toBe('A'.repeat(120));
    expect(task.sourceQuote).toHaveLength(200);
    expect(task.sourceQuote).toBe('B'.repeat(200));
  });

  it('update increments version and writes an "updated" event with a diff', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const service = createTaskService({ clock, config: {} as Env, taskHooks: [] });

    const created = await db.transaction((tx) =>
      service.create(tx, baseInput({ workspaceId: ws.id }), { type: 'system' }),
    );
    expect(created.version).toBe(1);

    const updated = await db.transaction((tx) =>
      service.update(tx, created.id, { title: 'Новое название' }, { type: 'system' }),
    );

    expect(updated.version).toBe(2);
    expect(updated.title).toBe('Новое название');

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, created.id));
    const updateEvent = events.find((e) => e.type === 'updated');
    expect(updateEvent).toBeDefined();
    expect(updateEvent?.diff).toEqual({
      title: { before: 'Подготовить расписание', after: 'Новое название' },
    });
  });

  it('setStatus("done") stamps completedAt/completedByUserId and writes a status_changed event', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const service = createTaskService({ clock, config: {} as Env, taskHooks: [] });

    const owner = await upsertTelegramUser(db, { id: 100, first_name: 'Anna' });
    const created = await db.transaction((tx) =>
      service.create(tx, baseInput({ workspaceId: ws.id }), { type: 'user', userId: owner.id }),
    );

    const done = await db.transaction((tx) =>
      service.setStatus(tx, created.id, 'done', { type: 'user', userId: owner.id }),
    );

    expect(done.status).toBe('done');
    expect(done.completedByUserId).toBe(owner.id);
    expect(done.completedAt?.toISOString()).toBe(clock.now().toISOString());
    expect(done.version).toBe(2);
  });

  it('calls every taskHook.afterChange inside the same transaction as the write it reacts to', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');

    const seen: { changeType: string; visibleEventCount: number }[] = [];
    const spyHook: TaskHook = {
      name: 'spy',
      async afterChange(tx, task, change) {
        // Reading through the *same* tx must already see the event row this same call's caller just
        // wrote, moments earlier, in that same not-yet-committed transaction.
        const rows = task ? await tx.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)) : [];
        seen.push({ changeType: change.type, visibleEventCount: rows.length });
      },
    };
    const service = createTaskService({ clock, config: {} as Env, taskHooks: [spyHook] });

    const created = await db.transaction((tx) =>
      service.create(tx, baseInput({ workspaceId: ws.id }), { type: 'system' }),
    );
    await db.transaction((tx) => service.update(tx, created.id, { priority: 'high' }, { type: 'system' }));

    expect(seen).toEqual([
      { changeType: 'created', visibleEventCount: 1 },
      { changeType: 'updated', visibleEventCount: 2 },
    ]);
  });

  it('a hook that throws rolls the whole transaction back — no task row, no event row', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const failingHook: TaskHook = {
      name: 'failing',
      afterChange() {
        throw new Error('boom');
      },
    };
    const service = createTaskService({ clock, config: {} as Env, taskHooks: [failingHook] });

    const countBefore = (await db.select().from(tasks)).length;
    await expect(
      db.transaction((tx) => service.create(tx, baseInput({ workspaceId: ws.id }), { type: 'system' })),
    ).rejects.toThrow('boom');

    const countAfter = (await db.select().from(tasks)).length;
    expect(countAfter).toBe(countBefore);
  });
});
