import type { MiddlewareFn } from 'grammy';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import { getChatByTgId } from '../../domain/chats/repo.js';
import { getMembership, markDmStarted, upsertTelegramUser } from '../../domain/people/repo.js';
import { getWorkspace, type WorkspaceRow } from '../../domain/workspaces/repo.js';
import type { Actor, BotContext } from '../context.js';

export interface ContextMiddlewareDeps {
  db: Db;
  config: Pick<Env, 'SUPERADMIN_TG_IDS'>;
  clock: Clock;
  /**
   * The single default workspace (MVP has exactly one — SPEC §5.2). A DM
   * update resolves its actor's membership against this workspace directly.
   * A group update instead resolves it via the chat's own `workspace_id`,
   * which is only set once the Owner approves that chat (Task 1.6) — until
   * then this field is unused for that update.
   */
  workspace: WorkspaceRow;
}

const NO_ACTOR: Actor = { userId: null, isSuperadmin: false, role: null, dmStarted: false };

/**
 * Populates `ctx.state` on every update that carries `ctx.from`:
 * `state.user` (upserted from `ctx.from`), `state.workspace`/`state.membership`
 * (resolved as described on {@link ContextMiddlewareDeps.workspace}), and
 * `state.actor` built from those plus `SUPERADMIN_TG_IDS`.
 *
 * `dm_started_at` is set the first time a private-chat update arrives from
 * that user (idempotent — see `markDmStarted`).
 */
export function createContextMiddleware(deps: ContextMiddlewareDeps): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (!ctx.from) {
      ctx.state = { user: null, membership: null, workspace: null, actor: NO_ACTOR };
      await next();
      return;
    }

    const from = ctx.from;
    const now = deps.clock.now();

    let user = await upsertTelegramUser(deps.db, from);

    if (ctx.chat?.type === 'private' && user.dmStartedAt === null) {
      const updated = await markDmStarted(deps.db, user.id, now);
      if (updated) user = updated;
    }

    let workspace: WorkspaceRow | null = null;
    if (ctx.chat?.type === 'private') {
      workspace = deps.workspace;
    } else if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
      const chatRow = await getChatByTgId(deps.db, ctx.chat.id);
      if (chatRow?.workspaceId != null) {
        workspace = await getWorkspace(deps.db, chatRow.workspaceId);
      }
    }

    const membership = workspace ? await getMembership(deps.db, workspace.id, user.id) : null;

    const actor: Actor = {
      userId: user.id,
      isSuperadmin: deps.config.SUPERADMIN_TG_IDS.includes(from.id),
      role: membership?.role ?? null,
      dmStarted: user.dmStartedAt !== null,
    };
    ctx.state = { user, membership, workspace, actor };
    await next();
  };
}
