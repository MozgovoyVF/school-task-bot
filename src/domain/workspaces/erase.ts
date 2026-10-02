import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Logger } from '../../ops/logger.js';
import type { Messenger } from '../messenger.js';
import { chats, memberships, workspaces } from '../../db/schema/index.js';
import { can, type Actor } from '../people/permissions.js';
import { deleteUserIfOrphaned } from '../people/erase.js';

export type EraseWorkspaceErrorReason = 'forbidden';

/** Thrown by {@link eraseWorkspace} for every non-success outcome — mirrors `src/domain/people/erase.ts`'s
 * `EraseMemberError`: the brief pins the success type to exactly `Promise<void>`, so "forbidden" is
 * signalled by throwing, not a return union. */
export class EraseWorkspaceError extends Error {
  constructor(readonly reason: EraseWorkspaceErrorReason) {
    super(`eraseWorkspace: ${reason}`);
    this.name = 'EraseWorkspaceError';
  }
}

export interface EraseWorkspaceDeps {
  db: Db;
  messenger: Messenger;
  logger: Logger;
  /**
   * Telegram ids of configured superadmins — same convention as
   * `src/domain/chats/lifecycle.ts`'s `ChatLifecycleDeps.superadminIds` and
   * `src/domain/people/erase.ts`'s `EraseMemberDeps.superadminIds`. Threaded
   * through to `deleteUserIfOrphaned` below (D43 review finding I2): a
   * member's own `users` row should be deleted on workspace erasure under
   * the exact same "no remaining membership, not a superadmin" rule
   * `eraseMember` already applies, not left behind just because this path
   * used to rely on FK cascades alone.
   */
  superadminIds: number[];
}

export interface EraseWorkspaceInput {
  workspaceId: number;
  actor: Actor;
}

/**
 * Full workspace erasure (SPEC §19.3.3, plan.md Task 3.12): `/admin` →
 * `texts.erase.workspaceButton` — superadmin only (`admin.tech`, checked via
 * `can()` against the already DB-resolved `Actor`, never a bare
 * `actor.isSuperadmin` flag on its own — CLAUDE.md §8).
 *
 * The bot actually leaves every Telegram chat it is still a member of under
 * this workspace (`status <> 'left'`) — not just marking the chat row
 * inactive in the DB (brief) — before the DB rows themselves are deleted.
 * This loop runs outside the transaction below: each iteration is a live
 * Telegram API call, and a `messenger.leaveChat` failure (e.g. the bot was
 * already removed from that chat) is logged (id only, CLAUDE.md §8) and does
 * not abort the rest of the erasure — the DB-side privacy obligation must
 * still complete even if one Telegram call fails for some chats.
 *
 * The deletion itself: `chats` is deleted first, relying on the schema's own
 * FK cascade (`src/db/schema/*.ts`) to take `messages`, `analysis_batches`
 * and chat-scoped `proposals` with it. The workspace's member user ids are
 * captured *before* the `workspaces` row is deleted (which cascades `tasks`
 * — and `task_events` via `tasks`'s own cascade —, any remaining
 * `proposals`, `notifications`, `memberships` and `claim_codes`), so that
 * each one can then be passed to `deleteUserIfOrphaned` (D43 review finding
 * I2) once their membership here is gone: identity (`users`) is global, not
 * workspace-scoped, so a member who still belongs to another workspace, or
 * is a configured superadmin, correctly keeps their `users` row. Everything
 * from the member-id read through the last `deleteUserIfOrphaned` call runs
 * in one transaction (brief: a half-erased workspace would be a real
 * privacy/correctness bug, not a cosmetic one).
 */
export async function eraseWorkspace(deps: EraseWorkspaceDeps, input: EraseWorkspaceInput): Promise<void> {
  if (!can(input.actor, 'admin.tech')) {
    throw new EraseWorkspaceError('forbidden');
  }

  const chatsToLeave = await deps.db
    .select({ id: chats.id, tgChatId: chats.tgChatId })
    .from(chats)
    .where(and(eq(chats.workspaceId, input.workspaceId), ne(chats.status, 'left')));

  for (const chat of chatsToLeave) {
    try {
      await deps.messenger.leaveChat(chat.tgChatId);
    } catch (err) {
      deps.logger.error({ err, chatId: chat.id }, 'eraseWorkspace: failed to leave a chat');
    }
  }

  const usersDeleted = await deps.db.transaction(async (tx) => {
    const members = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.workspaceId, input.workspaceId));

    await tx.delete(chats).where(eq(chats.workspaceId, input.workspaceId));
    await tx.delete(workspaces).where(eq(workspaces.id, input.workspaceId));

    let deleted = 0;
    for (const member of members) {
      if (await deleteUserIfOrphaned(tx, member.userId, deps.superadminIds)) deleted++;
    }
    return deleted;
  });

  deps.logger.info(
    { workspaceId: input.workspaceId, chatsLeft: chatsToLeave.length, usersDeleted },
    'eraseWorkspace: done',
  );
}
