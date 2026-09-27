import { and, eq, isNull } from 'drizzle-orm';
import type { MiddlewareFn } from 'grammy';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import { users } from '../../db/schema/index.js';
import type { Actor, BotContext } from '../context.js';

export interface ContextMiddlewareDeps {
  db: Db;
  config: Pick<Env, 'SUPERADMIN_TG_IDS'>;
  clock: Clock;
}

const NO_ACTOR: Actor = { userId: null, isSuperadmin: false, role: null, dmStarted: false };

/**
 * Populates `ctx.state` (phase 0: only `state.user` and `actor.userId` /
 * `actor.isSuperadmin` / `actor.dmStarted` are meaningfully filled in —
 * `state.membership`, `state.workspace` and `actor.role` stay `null` until a
 * phase-1 task adds workspace/membership resolution; see `src/bot/context.ts`).
 *
 * Upserts a `users` row from `ctx.from` on every update that carries one
 * (mutable fields — `username`/`first_name`/`last_name` — are refreshed on
 * conflict). `dm_started_at` is set the first time a private-chat update
 * arrives from that user (idempotent: the second `UPDATE` only touches rows
 * where it is still unset, so it is never overwritten once set).
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
    const [upserted] = await deps.db
      .insert(users)
      .values({
        tgUserId: from.id,
        username: from.username ?? null,
        firstName: from.first_name,
        lastName: from.last_name ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: users.tgUserId,
        set: {
          username: from.username ?? null,
          firstName: from.first_name,
          lastName: from.last_name ?? null,
          updatedAt: now,
        },
      })
      .returning();
    if (!upserted) throw new Error('user upsert returned no row');

    let user = upserted;
    if (ctx.chat?.type === 'private' && user.dmStartedAt === null) {
      const [updated] = await deps.db
        .update(users)
        .set({ dmStartedAt: now, updatedAt: now })
        .where(and(eq(users.id, user.id), isNull(users.dmStartedAt)))
        .returning();
      if (updated) user = updated;
    }

    const actor: Actor = {
      userId: user.id,
      isSuperadmin: deps.config.SUPERADMIN_TG_IDS.includes(from.id),
      role: null,
      dmStarted: user.dmStartedAt !== null,
    };
    ctx.state = { user, membership: null, workspace: null, actor };
    await next();
  };
}
