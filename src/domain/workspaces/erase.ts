import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Logger } from '../../ops/logger.js';
import type { Messenger } from '../messenger.js';
import { chats, workspaces } from '../../db/schema/index.js';
import { can, type Actor } from '../people/permissions.js';

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
 * still complete even if one Telegram call fails.
 *
 * The deletion itself is two statements that rely on the schema's own FK
 * cascade (`src/db/schema/*.ts`): deleting `chats` cascades `messages`,
 * `analysis_batches` and chat-scoped `proposals`; deleting the `workspaces`
 * row itself then cascades `tasks` (and `task_events` via `tasks`'s own
 * cascade), any remaining `proposals`, `notifications`, `memberships` and
 * `claim_codes`. Both run in one transaction (brief: a half-erased workspace
 * would be a real privacy/correctness bug, not a cosmetic one). `users` rows
 * are deliberately left untouched — identity is global (`users.tg_user_id`
 * is unique across the whole bot), not scoped to one workspace.
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

  await deps.db.transaction(async (tx) => {
    await tx.delete(chats).where(eq(chats.workspaceId, input.workspaceId));
    await tx.delete(workspaces).where(eq(workspaces.id, input.workspaceId));
  });

  deps.logger.info(
    { workspaceId: input.workspaceId, chatsLeft: chatsToLeave.length },
    'eraseWorkspace: done',
  );
}
