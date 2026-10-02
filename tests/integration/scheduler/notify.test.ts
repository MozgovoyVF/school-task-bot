import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import { createDb } from '../../../src/db/client.js';
import { createLogger } from '../../../src/ops/logger.js';
import { createErrorReporter } from '../../../src/ops/errorReporter.js';
import { loadEnv } from '../../../src/config/env.js';
import { ensureDefaultWorkspace, updateSettings } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser, markDmStarted, getUserById } from '../../../src/domain/people/repo.js';
import { notifyJob } from '../../../src/scheduler/jobs/notify.js';
import { MessengerError } from '../../../src/domain/messenger.js';
import { memberships, notifications, tasks } from '../../../src/db/schema/index.js';
import type { AppDeps } from '../../../src/deps.js';

type TaskRow = typeof tasks.$inferSelect;

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://stb:stb@localhost:5433/stb_test';
const SUPERADMIN_ID = 900000001;

const db = getTestDb();
beforeEach(() => truncateAll(db));

function makeConfig() {
  return loadEnv({
    TELEGRAM_BOT_TOKEN: 'test-token:ABC',
    DATABASE_URL: TEST_DATABASE_URL,
    SUPERADMIN_TG_IDS: String(SUPERADMIN_ID),
    GIT_SHA: 'test-sha',
  });
}

function makeDeps(
  db_: AppDeps['db'],
  clock: ReturnType<typeof fixedClock>,
  workspace: AppDeps['workspace'],
  messenger: FakeMessenger,
): AppDeps {
  const config = makeConfig();
  const logger = createLogger({ level: 'silent' });
  const errors = createErrorReporter({
    db: db_,
    messenger,
    clock,
    logger,
    superadminIds: config.SUPERADMIN_TG_IDS,
  });
  return { config, db: db_, clock, logger, errors, messenger, workspace, ai: null, taskHooks: [] };
}

let dedupeCounter = 0;
function dedupeKey(): string {
  dedupeCounter += 1;
  return `test:dedupe:${String(dedupeCounter)}`;
}

async function setupOwner() {
  const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
  const clock = fixedClock('2026-09-23T07:00:00Z'); // 10:00 MSK
  const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
  await markDmStarted(db, owner.id, clock.now());
  await db
    .insert(memberships)
    .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });
  return { ws, owner, clock };
}

async function insertTask(
  workspaceId: number,
  overrides: Partial<typeof tasks.$inferInsert> = {},
): Promise<TaskRow> {
  const now = new Date('2026-09-20T07:00:00Z');
  const [row] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title: 'Купить краски',
      origin: 'manual_dm',
      status: 'open',
      dueAt: new Date('2026-09-20T10:00:00+03:00'),
      dueAllDay: false,
      dueTz: 'Europe/Moscow',
      createdAt: now,
      updatedAt: now,
      version: 1,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('failed to insert test task');
  return row;
}

async function insertNotification(overrides: {
  workspaceId: number;
  taskId: number | null;
  recipientUserId: number;
  kind: 'pre_due' | 'due' | 'overdue' | 'summary' | 'snooze';
  fireAt: Date;
  status?: 'scheduled' | 'sent' | 'cancelled' | 'failed';
  attempts?: number;
}) {
  const [row] = await db
    .insert(notifications)
    .values({ ...overrides, dedupeKey: dedupeKey() })
    .returning();
  if (!row) throw new Error('failed to insert test notification');
  return row;
}

describe('notifyJob (SPEC §13.1, plan.md Task 3.3)', () => {
  it('sends a scheduled "due" notification whose fire_at is due, and marks it sent', async () => {
    const { ws, owner, clock } = await setupOwner();
    const task = await insertTask(ws.id);
    const messenger = new FakeMessenger();
    const deps = makeDeps(db, clock, ws, messenger);

    const n = await insertNotification({
      workspaceId: ws.id,
      taskId: task.id,
      recipientUserId: owner.id,
      kind: 'due',
      fireAt: new Date(clock.now().getTime() - 60_000),
    });

    await notifyJob.run(deps);

    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]?.chatId).toBe(owner.tgUserId);

    const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
    expect(after?.status).toBe('sent');
    expect(after?.sentTgMessageId).not.toBeNull();
  });

  it('two concurrent tickOnce calls each send the same notification exactly once (FOR UPDATE SKIP LOCKED)', async () => {
    const { ws, owner, clock } = await setupOwner();
    const task = await insertTask(ws.id);
    const messenger = new FakeMessenger();

    await insertNotification({
      workspaceId: ws.id,
      taskId: task.id,
      recipientUserId: owner.id,
      kind: 'due',
      fireAt: new Date(clock.now().getTime() - 60_000),
    });

    const conn1 = createDb(TEST_DATABASE_URL, { max: 1 });
    const conn2 = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      const deps1 = makeDeps(conn1.db, clock, ws, messenger);
      const deps2 = makeDeps(conn2.db, clock, ws, messenger);

      await Promise.all([notifyJob.run(deps1), notifyJob.run(deps2)]);

      expect(messenger.sent).toHaveLength(1);
      const sent = await db.select().from(notifications).where(eq(notifications.status, 'sent'));
      expect(sent).toHaveLength(1);
    } finally {
      await conn1.close();
      await conn2.close();
    }
  });

  it('groups 3+ overdue notifications for the same owner into one digest message (groupOverdueThreshold=3)', async () => {
    const { ws, owner, clock } = await setupOwner();
    const messenger = new FakeMessenger();
    const deps = makeDeps(db, clock, ws, messenger);

    const taskIds: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const task = await insertTask(ws.id, { title: `Задача ${String(i)}` });
      taskIds.push(task.id);
      await insertNotification({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'overdue',
        fireAt: new Date(clock.now().getTime() - 60_000),
      });
    }

    await notifyJob.run(deps);

    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]?.text).toContain('🔴 Просрочено (3):');

    const sentRows = await db.select().from(notifications).where(eq(notifications.status, 'sent'));
    expect(sentRows).toHaveLength(3);
    const messageIds = new Set(sentRows.map((r) => r.sentTgMessageId));
    expect(messageIds.size).toBe(1);
  });

  it('sends 2 overdue notifications for the same owner as separate messages (below the threshold)', async () => {
    const { ws, owner, clock } = await setupOwner();
    const messenger = new FakeMessenger();
    const deps = makeDeps(db, clock, ws, messenger);

    for (let i = 0; i < 2; i += 1) {
      const task = await insertTask(ws.id, { title: `Задача ${String(i)}` });
      await insertNotification({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'overdue',
        fireAt: new Date(clock.now().getTime() - 60_000),
      });
    }

    await notifyJob.run(deps);

    expect(messenger.sent).toHaveLength(2);
    const sentRows = await db.select().from(notifications).where(eq(notifications.status, 'sent'));
    expect(sentRows).toHaveLength(2);
    const messageIds = new Set(sentRows.map((r) => r.sentTgMessageId));
    expect(messageIds.size).toBe(2);
  });

  it('after sending an overdue reminder, schedules the next one for tomorrow at overdueTime (D7 chain)', async () => {
    const { ws, owner, clock } = await setupOwner();
    const task = await insertTask(ws.id);
    const messenger = new FakeMessenger();
    const deps = makeDeps(db, clock, ws, messenger);

    await insertNotification({
      workspaceId: ws.id,
      taskId: task.id,
      recipientUserId: owner.id,
      kind: 'overdue',
      fireAt: clock.now(),
    });

    await notifyJob.run(deps);

    const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    const next = rows.find((r) => r.status === 'scheduled');
    expect(next).toBeDefined();
    expect(next?.kind).toBe('overdue');
    expect(next?.fireAt.toISOString()).toBe(new Date('2026-09-24T07:00:00Z').toISOString());
  });

  it('does not continue the overdue chain once the task is closed', async () => {
    const { ws, owner, clock } = await setupOwner();
    const task = await insertTask(ws.id, { status: 'cancelled' });
    const messenger = new FakeMessenger();
    const deps = makeDeps(db, clock, ws, messenger);

    await insertNotification({
      workspaceId: ws.id,
      taskId: task.id,
      recipientUserId: owner.id,
      kind: 'overdue',
      fireAt: clock.now(),
    });

    await notifyJob.run(deps);

    expect(messenger.sent).toHaveLength(0);
    const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('cancelled');
  });

  it('a task closed between planning and sending: the notification is cancelled, nothing is sent', async () => {
    const { ws, owner, clock } = await setupOwner();
    const task = await insertTask(ws.id, { status: 'done' });
    const messenger = new FakeMessenger();
    const deps = makeDeps(db, clock, ws, messenger);

    const n = await insertNotification({
      workspaceId: ws.id,
      taskId: task.id,
      recipientUserId: owner.id,
      kind: 'due',
      fireAt: new Date(clock.now().getTime() - 60_000),
    });

    await notifyJob.run(deps);

    expect(messenger.sent).toHaveLength(0);
    const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
    expect(after?.status).toBe('cancelled');
  });

  it('a task deleted between planning and sending: the row is already gone (FK cascade), nothing is sent', async () => {
    const { ws, owner, clock } = await setupOwner();
    const task = await insertTask(ws.id);
    const messenger = new FakeMessenger();
    const deps = makeDeps(db, clock, ws, messenger);

    await insertNotification({
      workspaceId: ws.id,
      taskId: task.id,
      recipientUserId: owner.id,
      kind: 'due',
      fireAt: new Date(clock.now().getTime() - 60_000),
    });
    await db.delete(tasks).where(eq(tasks.id, task.id));

    await notifyJob.run(deps);

    expect(messenger.sent).toHaveLength(0);
    const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(rows).toHaveLength(0);
  });

  describe('quiet hours (SPEC §13.5, D10)', () => {
    async function setQuietAllDay(workspaceId: number) {
      await updateSettings(db, workspaceId, {
        quiet: { enabled: true, weekdays: [], windows: [{ from: '00:00', to: '23:59' }], dateRanges: [] },
      });
    }

    it('suppresses pre_due: cancelled with last_error="quiet"', async () => {
      const { ws, owner, clock } = await setupOwner();
      await setQuietAllDay(ws.id);
      const task = await insertTask(ws.id);
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'pre_due',
        fireAt: new Date(clock.now().getTime() - 60_000),
      });

      await notifyJob.run(deps);

      expect(messenger.sent).toHaveLength(0);
      const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
      expect(after?.status).toBe('cancelled');
      expect(after?.lastError).toBe('quiet');
    });

    it('suppresses overdue (cancelled, last_error="quiet") but still continues its chain', async () => {
      const { ws, owner, clock } = await setupOwner();
      await setQuietAllDay(ws.id);
      const task = await insertTask(ws.id);
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'overdue',
        fireAt: clock.now(),
      });

      await notifyJob.run(deps);

      expect(messenger.sent).toHaveLength(0);
      const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
      const original = rows.find((r) => r.id === n.id);
      expect(original?.status).toBe('cancelled');
      expect(original?.lastError).toBe('quiet');
      const next = rows.find((r) => r.id !== n.id);
      expect(next?.status).toBe('scheduled');
      expect(next?.kind).toBe('overdue');
    });

    it('does not suppress "due" — sent regardless of quiet hours', async () => {
      const { ws, owner, clock } = await setupOwner();
      await setQuietAllDay(ws.id);
      const task = await insertTask(ws.id);
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'due',
        fireAt: new Date(clock.now().getTime() - 60_000),
      });

      await notifyJob.run(deps);

      expect(messenger.sent).toHaveLength(1);
      const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
      expect(after?.status).toBe('sent');
    });

    it('does not suppress "snooze" — sent regardless of quiet hours', async () => {
      const { ws, owner, clock } = await setupOwner();
      await setQuietAllDay(ws.id);
      const task = await insertTask(ws.id);
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'snooze',
        fireAt: new Date(clock.now().getTime() - 60_000),
      });

      await notifyJob.run(deps);

      expect(messenger.sent).toHaveLength(1);
      const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
      expect(after?.status).toBe('sent');
    });

    it('suppresses "summary" (no task, taskId=null): cancelled with last_error="quiet" (review round 1, I1)', async () => {
      const { ws, owner, clock } = await setupOwner();
      await setQuietAllDay(ws.id);
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: null,
        recipientUserId: owner.id,
        kind: 'summary',
        fireAt: new Date(clock.now().getTime() - 60_000),
      });

      await notifyJob.run(deps);

      expect(messenger.sent).toHaveLength(0);
      const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
      expect(after?.status).toBe('cancelled');
      expect(after?.lastError).toBe('quiet');
    });

    it('a "summary" row outside quiet hours is sent (Task 3.5) and marked sent', async () => {
      const { ws, owner, clock } = await setupOwner();
      // No quiet hours configured — `setQuietAllDay` deliberately not called.
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: null,
        recipientUserId: owner.id,
        kind: 'summary',
        fireAt: new Date(clock.now().getTime() - 60_000),
      });

      await notifyJob.run(deps);

      expect(messenger.sent).toHaveLength(1);
      expect(messenger.sent[0]?.text).toContain('☀️ Доброе утро!');
      const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
      expect(after?.status).toBe('sent');
      expect(after?.sentTgMessageId).not.toBeNull();
    });
  });

  describe('send failures and backoff (SPEC §13.1)', () => {
    it('rate_limited/network: attempts++ and fire_at shifts by nextAttemptAt', async () => {
      const { ws, owner, clock } = await setupOwner();
      const task = await insertTask(ws.id);
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'due',
        fireAt: new Date(clock.now().getTime() - 60_000),
      });

      messenger.failNextWith(new MessengerError('rate_limited', 'too many requests'));
      await notifyJob.run(deps);

      const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
      expect(after?.status).toBe('scheduled');
      expect(after?.attempts).toBe(1);
      expect(after?.lastError).toBe('rate_limited');
      expect(after?.fireAt.toISOString()).toBe(new Date(clock.now().getTime() + 60_000).toISOString());
    });

    it('marks the notification "failed" after the 5th consecutive failure', async () => {
      const { ws, owner, clock } = await setupOwner();
      const task = await insertTask(ws.id);
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'due',
        fireAt: new Date(clock.now().getTime() - 60_000),
        attempts: 4,
      });

      messenger.failNextWith(new MessengerError('network', 'connection reset'));
      await notifyJob.run(deps);

      const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
      expect(after?.status).toBe('failed');
      expect(after?.attempts).toBe(5);
      expect(after?.lastError).toBe('network');
    });

    it('continues the overdue chain even once retries are exhausted ("failed") — D7 (review round 1, I2)', async () => {
      const { ws, owner, clock } = await setupOwner();
      const task = await insertTask(ws.id);
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'overdue',
        fireAt: clock.now(),
        attempts: 4,
      });

      messenger.failNextWith(new MessengerError('network', 'connection reset'));
      await notifyJob.run(deps);

      const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
      const original = rows.find((r) => r.id === n.id);
      expect(original?.status).toBe('failed');
      expect(original?.attempts).toBe(5);

      const next = rows.find((r) => r.id !== n.id);
      expect(next?.status).toBe('scheduled');
      expect(next?.kind).toBe('overdue');
      expect(next?.fireAt.toISOString()).toBe(new Date('2026-09-24T07:00:00Z').toISOString());
    });
  });

  it('after downtime, the next chain link is anchored on "now", not the stale row\'s own fire_at (review round 1, I3)', async () => {
    const { ws, owner, clock } = await setupOwner();
    const task = await insertTask(ws.id);
    const messenger = new FakeMessenger();
    const deps = makeDeps(db, clock, ws, messenger);

    // Simulates the bot having been down for 3 days: this overdue row's own fire_at is 3 days stale, but
    // it is only picked up and sent once the bot comes back ("now").
    const staleFireAt = new Date(clock.now().getTime() - 3 * 24 * 60 * 60 * 1000);
    await insertNotification({
      workspaceId: ws.id,
      taskId: task.id,
      recipientUserId: owner.id,
      kind: 'overdue',
      fireAt: staleFireAt,
    });

    await notifyJob.run(deps);

    expect(messenger.sent).toHaveLength(1);
    const rows = await db.select().from(notifications).where(eq(notifications.taskId, task.id));
    const next = rows.find((r) => r.status === 'scheduled');
    expect(next).toBeDefined();
    // Anchored on "now" (2026-09-23T07:00Z + 1 day) — never on the stale fire_at's own "+1 day"
    // (2026-09-21T07:00Z), which would still be in the past and cascade into an immediate re-send.
    expect(next?.fireAt.toISOString()).toBe(new Date('2026-09-24T07:00:00Z').toISOString());
    expect(next?.fireAt.toISOString()).not.toBe(new Date('2026-09-21T07:00:00Z').toISOString());
  });

  it(
    'resolveNotification safety net: a scheduled row still pointing at a no-longer-owner recipient is ' +
      'cancelled, not sent (D40, review round 2, I3 part 1)',
    async () => {
      const { ws, owner, clock } = await setupOwner();
      const task = await insertTask(ws.id);
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'due',
        fireAt: new Date(clock.now().getTime() - 60_000),
      });

      // Simulates an ownership transfer that happened without this row ever being replanned/cancelled —
      // `owner` (the row's own recipient) is demoted to a plain member, and a new owner takes over.
      await db.update(memberships).set({ role: 'member' }).where(eq(memberships.userId, owner.id));
      const newOwner = await upsertTelegramUser(db, { id: 99, first_name: 'Boris' });
      await markDmStarted(db, newOwner.id, clock.now());
      await db
        .insert(memberships)
        .values({ workspaceId: ws.id, userId: newOwner.id, role: 'owner', displayName: 'Boris' });

      await notifyJob.run(deps);

      expect(messenger.sent).toHaveLength(0);
      const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
      expect(after?.status).toBe('cancelled');
    },
  );

  it(
    'resolveNotification safety net also catches a "summary" row (no task) left pointing at a former ' +
      'owner (D40, review round 2, I3 part 1)',
    async () => {
      const { ws, owner, clock } = await setupOwner();
      const messenger = new FakeMessenger();
      const deps = makeDeps(db, clock, ws, messenger);

      const n = await insertNotification({
        workspaceId: ws.id,
        taskId: null,
        recipientUserId: owner.id,
        kind: 'summary',
        fireAt: new Date(clock.now().getTime() - 60_000),
      });

      await db.update(memberships).set({ role: 'member' }).where(eq(memberships.userId, owner.id));
      const newOwner = await upsertTelegramUser(db, { id: 99, first_name: 'Boris' });
      await markDmStarted(db, newOwner.id, clock.now());
      await db
        .insert(memberships)
        .values({ workspaceId: ws.id, userId: newOwner.id, role: 'owner', displayName: 'Boris' });

      await notifyJob.run(deps);

      expect(messenger.sent).toHaveLength(0);
      const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
      expect(after?.status).toBe('cancelled');
    },
  );

  it('forbidden (403): flips users.dm_blocked and cancels every scheduled notification for that user', async () => {
    const { ws, owner, clock } = await setupOwner();
    const task = await insertTask(ws.id);
    const messenger = new FakeMessenger();
    const deps = makeDeps(db, clock, ws, messenger);

    const dueNow = await insertNotification({
      workspaceId: ws.id,
      taskId: task.id,
      recipientUserId: owner.id,
      kind: 'due',
      fireAt: new Date(clock.now().getTime() - 60_000),
    });
    // Not due this tick, but still `scheduled` for the same recipient — the 403 cancel covers it too.
    const futurePreDue = await insertNotification({
      workspaceId: ws.id,
      taskId: task.id,
      recipientUserId: owner.id,
      kind: 'pre_due',
      fireAt: new Date(clock.now().getTime() + 24 * 60 * 60 * 1000),
    });

    messenger.failNextWith(new MessengerError('forbidden', 'bot was blocked by the user'));
    await notifyJob.run(deps);

    const blockedOwner = await getUserById(db, owner.id);
    expect(blockedOwner?.dmBlocked).toBe(true);

    const [dueRow] = await db.select().from(notifications).where(eq(notifications.id, dueNow.id));
    const [preDueRow] = await db.select().from(notifications).where(eq(notifications.id, futurePreDue.id));
    expect(dueRow?.status).toBe('cancelled');
    expect(preDueRow?.status).toBe('cancelled');
  });
});
