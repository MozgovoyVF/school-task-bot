import type { Context } from 'grammy';
import type { ConversationFlavor } from '@grammyjs/conversations';
import type { memberships, users, workspaces } from '../db/schema/index.js';

/**
 * The bot's custom context type and the `Actor`/`Role` shapes it carries in
 * `ctx.state`.
 *
 * TEMPORARY (Task 0.7, phase 0): the real `Actor`/`Role` types and the `can()`
 * permission-check function are defined in `src/domain/people/permissions.ts`
 * (plan.md's locked shared contract), which is built in a later phase-1 task
 * (plan.md line ~1019 — that task also rewrites `src/bot/middleware/context.ts`
 * to import `Actor`/`can` from there). That file does not exist yet, so
 * `Role`/`Actor` are defined locally here, matching plan.md's contract shape
 * verbatim. Once `permissions.ts` lands, delete this block and import
 * `Actor`/`Role` from there instead everywhere this module is used
 * (`src/bot/middleware/context.ts`, `src/bot/views/help.ts`, …).
 */
export type Role = 'owner' | 'member';

export interface Actor {
  userId: number | null;
  isSuperadmin: boolean;
  role: Role | null;
  dmStarted: boolean;
}

export type UserRow = typeof users.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;

/**
 * Only `state.user`, `actor.userId`/`actor.isSuperadmin`/`actor.dmStarted` are
 * meaningfully populated in phase 0 (by `src/bot/middleware/context.ts`).
 * `state.membership`, `state.workspace` and `actor.role` stay `null` until
 * phase 1 adds workspace/membership resolution.
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
