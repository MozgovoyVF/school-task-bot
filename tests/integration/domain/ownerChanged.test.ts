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
});
