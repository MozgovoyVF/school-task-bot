import type { Context } from 'grammy';
import type { ConversationFlavor } from '@grammyjs/conversations';
import type { memberships, users, workspaces } from '../db/schema/index.js';
import type { Actor } from '../domain/people/permissions.js';

/**
 * `Actor`/`Role` (and the `can()` permission-check function) live in
 * `src/domain/people/permissions.ts` (plan.md's locked shared contract,
 * CLAUDE.md §7: `domain/` never imports grammY) and are re-exported here so
 * bot-layer modules (`src/bot/middleware/context.ts`, `src/bot/views/help.ts`,
 * …) can keep importing them by name from this module.
 */
export type { Actor, Role } from '../domain/people/permissions.js';

export type UserRow = typeof users.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;

/**
 * `src/bot/middleware/context.ts` fills every field of `state` on each
 * update: `user`/`actor.userId`/`actor.isSuperadmin`/`actor.dmStarted` from
 * the `users` upsert, and `membership`/`workspace`/`actor.role` from a
 * membership lookup against the chat's workspace (group updates) or the
 * single default workspace (DM updates, MVP — SPEC §5.2). All of `state.user`/
 * `.membership`/`.workspace`/`actor.role` are `null` when there is no
 * resolvable workspace context (e.g. a pending/unapproved group chat).
 */
export type BotContext = Context &
  ConversationFlavor<Context> & {
    state: {
      user: UserRow | null;
      membership: MembershipRow | null;
      workspace: WorkspaceRow | null;
      actor: Actor;
    };
  };
