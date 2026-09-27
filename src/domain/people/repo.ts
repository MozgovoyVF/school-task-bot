import { and, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { memberships, users } from '../../db/schema/index.js';

export type UserRow = typeof users.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;

/** The subset of Telegram's `User` object {@link upsertTelegramUser} needs. */
export interface TelegramUserInput {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
}

/**
 * Upserts a `users` row by `tg_user_id`. On conflict, refreshes the mutable
 * profile fields (`username`/`first_name`/`last_name`) — everything else
 * (`dm_started_at`, `dm_blocked`, `timezone`) is left untouched. Does not
 * touch `updated_at`: this function takes no `now` (CLAUDE.md §8 forbids
 * `new Date()`/SQL `now()` in `domain/`), and `updated_at` is not part of
 * this task's documented behaviour.
 */
export async function upsertTelegramUser(db: DbOrTx, tg: TelegramUserInput): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({
      tgUserId: tg.id,
      username: tg.username ?? null,
      firstName: tg.first_name,
      lastName: tg.last_name ?? null,
    })
    .onConflictDoUpdate({
      target: users.tgUserId,
      set: {
        username: tg.username ?? null,
        firstName: tg.first_name,
        lastName: tg.last_name ?? null,
      },
    })
    .returning();
  if (!row) throw new Error('upsertTelegramUser: insert/update returned no row');
  return row;
}

/** Looks up a `users` row by Telegram id. `undefined`/no row → `null`. */
export async function getUserByTgId(db: DbOrTx, tgUserId: number): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.tgUserId, tgUserId)).limit(1);
  return row ?? null;
}

/** Looks up a `users` row by internal id. */
export async function getUserById(db: DbOrTx, id: number): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/**
 * Ensures a `member` membership row exists for `userId` in `workspaceId`. If
 * a membership already exists (`member` or `owner`), it is returned
 * unchanged — this never overwrites an existing `role` or `display_name`
 * (in particular, it can never demote an owner).
 */
export async function ensureMembership(
  db: DbOrTx,
  input: { workspaceId: number; userId: number; displayName: string },
): Promise<MembershipRow> {
  const inserted = await db
    .insert(memberships)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: 'member',
      displayName: input.displayName,
    })
    .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] })
    .returning();
  if (inserted[0]) return inserted[0];

  const existing = await getMembership(db, input.workspaceId, input.userId);
  if (!existing) throw new Error('ensureMembership: conflicting insert but no existing row found');
  return existing;
}

/** Returns the workspace's owner (user + membership), or `null` if it has none yet. */
export async function getOwner(
  db: DbOrTx,
  workspaceId: number,
): Promise<{ user: UserRow; membership: MembershipRow } | null> {
  const [row] = await db
    .select({ user: users, membership: memberships })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')))
    .limit(1);
  return row ?? null;
}

/** Returns a user's membership in a workspace, or `null` if they have none. */
export async function getMembership(
  db: DbOrTx,
  workspaceId: number,
  userId: number,
): Promise<MembershipRow | null> {
  const [row] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Lists all memberships in a workspace (id order). */
export async function listMembers(db: DbOrTx, workspaceId: number): Promise<MembershipRow[]> {
  return db
    .select()
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(memberships.id);
}

/**
 * Sets `dm_started_at` the first time a private-chat update arrives from
 * this user. Idempotent: the `UPDATE` only matches rows where it is still
 * unset, so a later call is a no-op and returns `null` (it never overwrites
 * an already-set value).
 */
export async function markDmStarted(db: DbOrTx, userId: number, now: Date): Promise<UserRow | null> {
  const [row] = await db
    .update(users)
    .set({ dmStartedAt: now, updatedAt: now })
    .where(and(eq(users.id, userId), isNull(users.dmStartedAt)))
    .returning();
  return row ?? null;
}

/** Sets `dm_blocked` (e.g. after Telegram reports the user has blocked the bot). */
export async function markDmBlocked(db: DbOrTx, userId: number, blocked: boolean): Promise<UserRow | null> {
  const [row] = await db.update(users).set({ dmBlocked: blocked }).where(eq(users.id, userId)).returning();
  return row ?? null;
}

/** Sets the user's preferred IANA timezone (`/timezone`, Task 1.4). */
export async function setUserTimezone(db: DbOrTx, userId: number, zone: string): Promise<UserRow | null> {
  const [row] = await db.update(users).set({ timezone: zone }).where(eq(users.id, userId)).returning();
  return row ?? null;
}

/**
 * Bootstraps the workspace's owner from `BOOTSTRAP_OWNER_TG_ID` (called from
 * `startApp` after `ensureDefaultWorkspace` — Task 0.8/`src/app.ts`).
 * `tgUserId` is `env.BOOTSTRAP_OWNER_TG_ID`, which is `undefined` when unset.
 *
 * - `'skipped'` — no `tgUserId` given, nothing done.
 * - `'exists'` — the workspace already has an owner, nothing done.
 * - `'created'` — a `users` row was found or created for `tgUserId`, and
 *   given an `owner` membership. The placeholder `display_name` ("Owner",
 *   not Cyrillic — this runs before the owner has ever messaged the bot, so
 *   no `first_name` is known yet) can be changed later via `/people`.
 */
export async function bootstrapOwner(
  db: DbOrTx,
  input: { workspaceId: number; tgUserId: number | null | undefined },
): Promise<'created' | 'exists' | 'skipped'> {
  if (input.tgUserId == null) return 'skipped';

  const existingOwner = await getOwner(db, input.workspaceId);
  if (existingOwner) return 'exists';

  const [inserted] = await db
    .insert(users)
    .values({ tgUserId: input.tgUserId })
    .onConflictDoNothing({ target: users.tgUserId })
    .returning();
  const ownerUser = inserted ?? (await getUserByTgId(db, input.tgUserId));
  if (!ownerUser) throw new Error('bootstrapOwner: failed to find or create the owner user row');

  await db.insert(memberships).values({
    workspaceId: input.workspaceId,
    userId: ownerUser.id,
    role: 'owner',
    displayName: 'Owner',
  });

  return 'created';
}
