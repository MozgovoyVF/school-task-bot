import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { createLogger } from '../../../src/ops/logger.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { afterOwnerChanged } from '../../../src/domain/people/ownerChanged.js';
import { chats, memberships } from '../../../src/db/schema/index.js';
import { MessengerError } from '../../../src/domain/messenger.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

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

    await afterOwnerChanged({ db, logger, messenger, clock }, workspace.id);

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

    await afterOwnerChanged({ db, logger, messenger: failingMessenger, clock }, workspace.id);

    // The send failed, so the Owner never actually saw the approval request — the 72h auto-leave
    // clock must NOT have started (unlike the un-stamp-on-failure this mirrors, `publishNoticeOnce`'s
    // claimNoticeSlot/clearNoticeSlot).
    const [chatAfterFailure] = await db.select().from(chats).where(eq(chats.id, pendingChat.id));
    expect(chatAfterFailure?.pendingSince).toBeNull();

    // A later call (e.g. the next /claim, or a retry) can still reach the Owner.
    const retryMessenger = new FakeMessenger();
    await afterOwnerChanged({ db, logger, messenger: retryMessenger, clock }, workspace.id);

    const [chatAfterRetry] = await db.select().from(chats).where(eq(chats.id, pendingChat.id));
    expect(chatAfterRetry?.pendingSince).not.toBeNull();
    expect(retryMessenger.sent.some((m) => m.chatId === owner.tgUserId)).toBe(true);
  });
});
