import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { createLogger } from '../../../src/ops/logger.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser, markDmStarted } from '../../../src/domain/people/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { afterOwnerChanged } from '../../../src/domain/people/ownerChanged.js';
import { chats, memberships, notifications, tasks } from '../../../src/db/schema/index.js';
import { MessengerError } from '../../../src/domain/messenger.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import type { Env } from '../../../src/config/env.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

// `remindersHook.afterChange`'s own `deps` parameter (`Pick<AppDeps, 'clock' | 'config'>`) requires a real
// `Env`, but nothing it actually reads for this hook's body ever touches `config` — same `{} as Env`
// convention `tests/integration/domain/erase.test.ts` already uses for the same reason.
const config = {} as Env;

describe('afterOwnerChanged', () => {
  it('keeps logging the owner change (Task 1.5) and, alongside that, requests pending approvals (Task 1.6)', async () => {
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await db
      .insert(memberships)
      .values({ workspaceId: workspace.id, userId: owner.id, role: 'owner', displayName: 'Anna' });

    // A chat added before this owner existed: still waiting for its approval request.
    const pendingChat = await upsertChatOnAdd(db, {
      tgChatId: -1,
      title: 'Group',
      type: 'supergroup',
      workspaceId: workspace.id,
      addedByUserId: null,
      status: 'pending',
      pendingSince: null,
      now: clock.now(),
    });

    const messenger = new FakeMessenger();
    const logger = createLogger({ level: 'silent' });
    const infoSpy = vi.spyOn(logger, 'info');
    const syncCommands = vi.fn().mockResolvedValue(undefined);

    await afterOwnerChanged({ db, logger, messenger, clock, config, syncCommands }, workspace.id);

    // The existing behaviour (Task 1.5) still happens.
    expect(infoSpy).toHaveBeenCalledWith({ workspaceId: workspace.id }, 'owner changed');

    // The new call (Task 1.6) fires alongside it: the pending chat's approval clock starts,
    // and the owner is sent the approval card.
    const [chatAfter] = await db.select().from(chats).where(eq(chats.id, pendingChat.id));
    expect(chatAfter?.pendingSince).not.toBeNull();
    expect(messenger.sent.some((m) => m.chatId === owner.tgUserId)).toBe(true);
  });

  it('rolls back pending_since when the approval-card send fails, so a later call can retry', async () => {
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await db
      .insert(memberships)
      .values({ workspaceId: workspace.id, userId: owner.id, role: 'owner', displayName: 'Anna' });

    const pendingChat = await upsertChatOnAdd(db, {
      tgChatId: -2,
      title: 'Group 2',
      type: 'supergroup',
      workspaceId: workspace.id,
      addedByUserId: null,
      status: 'pending',
      pendingSince: null,
      now: clock.now(),
    });

    const logger = createLogger({ level: 'silent' });
    const failingMessenger = new FakeMessenger();
    failingMessenger.failNextWith(new MessengerError('other', 'boom'));
    const syncCommands = vi.fn().mockResolvedValue(undefined);

    await afterOwnerChanged(
      { db, logger, messenger: failingMessenger, clock, config, syncCommands },
      workspace.id,
    );

    // The send failed, so the Owner never actually saw the approval request — the 72h auto-leave
    // clock must NOT have started (unlike the un-stamp-on-failure this mirrors, `publishNoticeOnce`'s
    // claimNoticeSlot/clearNoticeSlot).
    const [chatAfterFailure] = await db.select().from(chats).where(eq(chats.id, pendingChat.id));
    expect(chatAfterFailure?.pendingSince).toBeNull();

    // A later call (e.g. the next /claim, or a retry) can still reach the Owner.
    const retryMessenger = new FakeMessenger();
    const retrySyncCommands = vi.fn().mockResolvedValue(undefined);
    await afterOwnerChanged(
      { db, logger, messenger: retryMessenger, clock, config, syncCommands: retrySyncCommands },
      workspace.id,
    );

    const [chatAfterRetry] = await db.select().from(chats).where(eq(chats.id, pendingChat.id));
    expect(chatAfterRetry?.pendingSince).not.toBeNull();
    expect(retryMessenger.sent.some((m) => m.chatId === owner.tgUserId)).toBe(true);
  });

  it('also calls the injected syncCommands callback exactly once (Task 1.11)', async () => {
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await db
      .insert(memberships)
      .values({ workspaceId: workspace.id, userId: owner.id, role: 'owner', displayName: 'Anna' });

    const messenger = new FakeMessenger();
    const logger = createLogger({ level: 'silent' });
    // `afterOwnerChanged` (domain/) never imports `src/bot/commands.ts` itself — it only calls the
    // no-arg callback the caller hands it (CLAUDE.md §7: domain/ never imports grammY, and
    // `syncCommands` does real Telegram I/O). See `tests/integration/bot/privacy.test.ts`'s own
    // `syncCommands` describe block for coverage of the real function's scopes/command lists, and
    // its "/claim refreshes the owner command menu" test for the full bot-layer wiring
    // (`src/bot/handlers/transfer.ts` binding the real `syncCommands` to `ctx.api`).
    const syncCommands = vi.fn().mockResolvedValue(undefined);

    await afterOwnerChanged({ db, logger, messenger, clock, config, syncCommands }, workspace.id);

    expect(syncCommands).toHaveBeenCalledTimes(1);
    expect(syncCommands).toHaveBeenCalledWith();
  });

  it(
    "replans every open task's reminders for the new Owner (D40) in one go, instead of waiting for each " +
      'task to be individually edited (review round 2, I3 part 2)',
    async () => {
      const clock = fixedClock('2026-09-15T07:00:00Z');
      const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });

      const ownerA = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
      await db
        .insert(memberships)
        .values({ workspaceId: workspace.id, userId: ownerA.id, role: 'owner', displayName: 'Anna' });

      const [openTask] = await db
        .insert(tasks)
        .values({
          workspaceId: workspace.id,
          title: 'Собрать подписи',
          origin: 'manual_dm',
          status: 'open',
          dueAt: new Date('2026-09-20T10:00:00+03:00'),
          dueAllDay: false,
          dueTz: 'Europe/Moscow',
          createdAt: clock.now(),
          updatedAt: clock.now(),
          version: 1,
        })
        .returning();
      if (!openTask) throw new Error('setup: failed to insert openTask');

      const [closedTask] = await db
        .insert(tasks)
        .values({
          workspaceId: workspace.id,
          title: 'Задача закрыта',
          origin: 'manual_dm',
          status: 'done',
          createdAt: clock.now(),
          updatedAt: clock.now(),
          version: 1,
        })
        .returning();
      if (!closedTask) throw new Error('setup: failed to insert closedTask');

      // A reminder already scheduled for the old owner (A) — as `remindersHook` itself would have planned
      // when the task was created or last edited.
      const [staleRow] = await db
        .insert(notifications)
        .values({
          workspaceId: workspace.id,
          taskId: openTask.id,
          recipientUserId: ownerA.id,
          kind: 'due',
          fireAt: new Date('2026-09-20T07:00:00Z'),
          dedupeKey: 'test:i3:stale-due',
        })
        .returning();
      if (!staleRow) throw new Error('setup: failed to insert staleRow');

      // The transfer itself: A is demoted to a plain member, B becomes the new Owner.
      await db.update(memberships).set({ role: 'member' }).where(eq(memberships.userId, ownerA.id));
      const ownerB = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
      await db
        .insert(memberships)
        .values({ workspaceId: workspace.id, userId: ownerB.id, role: 'owner', displayName: 'Boris' });

      const messenger = new FakeMessenger();
      const logger = createLogger({ level: 'silent' });
      const syncCommands = vi.fn().mockResolvedValue(undefined);

      await afterOwnerChanged({ db, logger, messenger, clock, config, syncCommands }, workspace.id);

      const openTaskRows = await db.select().from(notifications).where(eq(notifications.taskId, openTask.id));
      const staleAfter = openTaskRows.find((r) => r.id === staleRow.id);
      expect(staleAfter?.status).toBe('cancelled');

      // `resolveRecipients` only resolves a recipient once the Owner has actually started a DM — B hasn't
      // here, so no fresh row is expected yet; the key assertion is that the stale row pointing at A is
      // gone. A second case below covers B actually receiving a fresh row once they have started a DM.
      const scheduledForOpenTask = openTaskRows.filter((r) => r.status === 'scheduled');
      expect(scheduledForOpenTask).toHaveLength(0);

      // The closed task's own hook run is a no-op (no scheduled rows existed, none are created) — just a
      // sanity check that iterating every open task doesn't also touch a closed one.
      const closedTaskRows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.taskId, closedTask.id));
      expect(closedTaskRows).toHaveLength(0);
    },
  );

  it(
    'the new Owner actually receives a fresh scheduled row once they have started a DM (D40, review round ' +
      '2, I3 part 2)',
    async () => {
      const clock = fixedClock('2026-09-15T07:00:00Z');
      const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });

      const ownerA = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
      await markDmStarted(db, ownerA.id, clock.now());
      await db
        .insert(memberships)
        .values({ workspaceId: workspace.id, userId: ownerA.id, role: 'owner', displayName: 'Anna' });

      const [openTask] = await db
        .insert(tasks)
        .values({
          workspaceId: workspace.id,
          title: 'Собрать подписи',
          origin: 'manual_dm',
          status: 'open',
          dueAt: new Date('2026-09-20T10:00:00+03:00'),
          dueAllDay: false,
          dueTz: 'Europe/Moscow',
          createdAt: clock.now(),
          updatedAt: clock.now(),
          version: 1,
        })
        .returning();
      if (!openTask) throw new Error('setup: failed to insert openTask');

      const [staleRow] = await db
        .insert(notifications)
        .values({
          workspaceId: workspace.id,
          taskId: openTask.id,
          recipientUserId: ownerA.id,
          kind: 'due',
          fireAt: new Date('2026-09-20T07:00:00Z'),
          dedupeKey: 'test:i3:stale-due-2',
        })
        .returning();
      if (!staleRow) throw new Error('setup: failed to insert staleRow');

      await db.update(memberships).set({ role: 'member' }).where(eq(memberships.userId, ownerA.id));
      const ownerB = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
      await markDmStarted(db, ownerB.id, clock.now());
      await db
        .insert(memberships)
        .values({ workspaceId: workspace.id, userId: ownerB.id, role: 'owner', displayName: 'Boris' });

      const messenger = new FakeMessenger();
      const logger = createLogger({ level: 'silent' });
      const syncCommands = vi.fn().mockResolvedValue(undefined);

      await afterOwnerChanged({ db, logger, messenger, clock, config, syncCommands }, workspace.id);

      const rows = await db.select().from(notifications).where(eq(notifications.taskId, openTask.id));
      const staleAfter = rows.find((r) => r.id === staleRow.id);
      expect(staleAfter?.status).toBe('cancelled');

      const fresh = rows.find((r) => r.status === 'scheduled');
      expect(fresh).toBeDefined();
      expect(fresh?.recipientUserId).toBe(ownerB.id);
    },
  );
});
