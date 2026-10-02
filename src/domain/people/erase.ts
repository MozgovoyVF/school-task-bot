import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import type { Logger } from '../../ops/logger.js';
import { claimCodes, memberships, proposals, tasks, users } from '../../db/schema/index.js';
// `domain/` importing `bot/texts` is a deliberate, pre-existing exception (see
// `src/domain/chats/lifecycle.ts`'s own doc comment): `tasks.assignee_name_text`'s erased-assignee
// placeholder is Russian user-facing copy, and SPEC §19.3.3/plan.md Task 3.12's brief pin it to
// `texts.erase.anonymous` specifically, not a value this module should invent on its own.
import { texts } from '../../bot/texts/ru.js';
import { can, type Actor } from './permissions.js';
import { getMembership, getUserById } from './repo.js';

export type EraseMemberErrorReason = 'forbidden' | 'not_found' | 'owner_must_transfer';

/**
 * Thrown by {@link eraseMember} for every non-success outcome — the brief
 * pins its success type to exactly `Promise<{ messages; tasksAnonymized;
 * userDeleted }>` (plan.md Task 3.12), so "forbidden"/"not found"/"owner
 * must transfer first" are signalled by throwing, not a wider return union
 * (same shape as `src/domain/people/repo.ts`'s `AliasValidationError`).
 */
export class EraseMemberError extends Error {
  constructor(readonly reason: EraseMemberErrorReason) {
    super(`eraseMember: ${reason}`);
    this.name = 'EraseMemberError';
  }
}

export interface EraseMemberDeps {
  db: Db;
  logger: Logger;
  /**
   * Telegram ids of configured superadmins — same convention as
   * `src/domain/chats/lifecycle.ts`'s `ChatLifecycleDeps.superadminIds`.
   * `users` carries no "is superadmin" column of its own (it is an env-level
   * list, SPEC §3), so this is how step 8 below knows not to delete a
   * superadmin's own `users` row even when they have no remaining
   * membership anywhere.
   */
  superadminIds: number[];
}

export interface EraseMemberInput {
  workspaceId: number;
  userId: number;
  actor: Actor;
}

export interface EraseMemberResult {
  messages: number;
  tasksAnonymized: number;
  userDeleted: boolean;
}

/**
 * Deletes `userId`'s own `users` row, but only if they now have no
 * remaining workspace membership anywhere and are not a configured
 * superadmin (SPEC §19.3.3's "not a superadmin" clause) — shared by
 * {@link eraseMember} below and `src/domain/workspaces/erase.ts`'s
 * `eraseWorkspace`, which both need this exact same orphan check (D43
 * review finding I2: `eraseWorkspace` used to rely only on FK cascades and
 * never deleted the `users` rows themselves). The caller must have already
 * removed whatever membership row(s) made `userId` relevant to begin with.
 *
 * Deletes `claim_codes.created_by_user_id` rows for this user first: unlike
 * every other FK to `users` (`set null`/`cascade`), that one is `ON DELETE
 * no action` (D43 review finding C1 — a former Owner who issued a `/transfer`
 * code before being demoted would otherwise make the `users` delete below
 * fail with a raw FK violation, rolling back the whole erasure). A claim
 * code is single-use and worthless once redeemed (`used_at` is already set
 * by then, or it's simply expired/unused) — deleting it here is a safe,
 * intentional cleanup, not data loss.
 */
export async function deleteUserIfOrphaned(
  tx: DbOrTx,
  userId: number,
  superadminIds: number[],
): Promise<boolean> {
  const user = await getUserById(tx, userId);
  if (!user || superadminIds.includes(user.tgUserId)) return false;

  const [remaining] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  if ((remaining?.count ?? 0) !== 0) return false;

  await tx.delete(claimCodes).where(eq(claimCodes.createdByUserId, userId));
  await tx.delete(users).where(eq(users.id, userId));
  return true;
}

/**
 * GDPR-style per-member erasure (SPEC §19.3.3, plan.md Task 3.12): Owner →
 * `/people` → a member → `texts.erase.memberButton`. `actor` is checked via `can()`
 * against the already DB-resolved `Actor` (CLAUDE.md §8 — a bare role flag
 * is never trusted on its own) — `people.manage` is Owner-only (SPEC §19.3.3
 * names only the Owner for per-member erasure; the Superadmin-only path is
 * the separate, more destructive `eraseWorkspace`, `src/domain/workspaces/
 * erase.ts`).
 *
 * An owner can never erase themselves (`'owner_must_transfer'`) — they must
 * `/transfer` ownership first (plan.md brief), checked by looking at the
 * *target*'s own membership row, not the actor's — this also protects an
 * owner acting on their own `/people` card.
 *
 * Every multi-table write below runs inside one transaction: a half-applied
 * erasure (e.g. messages gone but the membership row still present) would be
 * a privacy/correctness bug, not a cosmetic one. Steps 1–2 run before step 6
 * deletes the member's own `messages` rows, since both still need to join
 * against them. Only ids/counts are logged (CLAUDE.md §8 — never names,
 * usernames or message text at `info` level or above).
 */
export async function eraseMember(
  deps: EraseMemberDeps,
  input: EraseMemberInput,
): Promise<EraseMemberResult> {
  if (!can(input.actor, 'people.manage')) {
    throw new EraseMemberError('forbidden');
  }

  const result = await deps.db.transaction(async (tx) => {
    const membership = await getMembership(tx, input.workspaceId, input.userId);
    if (!membership) throw new EraseMemberError('not_found');
    if (membership.role === 'owner') throw new EraseMemberError('owner_must_transfer');

    // 1. Clear `source_quote` on tasks sourced from one of this member's messages. The `messages` rows
    // themselves still exist at this point (deleted in step 6), so the join below can still match them.
    await tx.execute(sql`
      update tasks t
      set source_quote = null
      from messages m
      inner join chats c on c.id = m.chat_id
      where t.workspace_id = ${input.workspaceId}
        and c.workspace_id = ${input.workspaceId}
        and m.author_user_id = ${input.userId}
        and m.chat_id = t.source_chat_id
        and m.tg_message_id = t.source_tg_message_id
    `);

    // 2. Remove this member's message ids from every `proposals.source_message_ids` array — same
    // "while the `messages` rows still exist" ordering requirement as step 1.
    await tx.execute(sql`
      update proposals p
      set source_message_ids = (
        select coalesce(array_agg(mid), '{}')
        from unnest(p.source_message_ids) as mid
        where mid not in (
          select m.id from messages m
          inner join chats c on c.id = m.chat_id
          where m.author_user_id = ${input.userId} and c.workspace_id = ${input.workspaceId}
        )
      )
      where p.workspace_id = ${input.workspaceId}
        and exists (
          select 1 from messages m
          inner join chats c on c.id = m.chat_id
          where m.author_user_id = ${input.userId}
            and c.workspace_id = ${input.workspaceId}
            and m.id = any(p.source_message_ids)
        )
    `);

    // 3. Anonymize tasks where this member is the assignee (SPEC §19.3.3: `assignee_user_id=null`,
    // `assignee_name_text` from `texts.erase.anonymous`).
    const anonymized = await tx
      .update(tasks)
      .set({ assigneeUserId: null, assigneeNameText: texts.erase.anonymous })
      .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.assigneeUserId, input.userId)))
      .returning({ id: tasks.id });

    // 4. Clear `task_events.actor_user_id` for this workspace's tasks — the audit-trail row itself stays
    // (brief: it belongs to other data, the task's own history, not this member's).
    await tx.execute(sql`
      update task_events te
      set actor_user_id = null
      from tasks t
      where te.task_id = t.id
        and t.workspace_id = ${input.workspaceId}
        and te.actor_user_id = ${input.userId}
    `);

    // 5. Clear `proposals.decided_by_user_id` — the proposal row itself (the AI feedback/audit trail,
    // `pnpm feedback-report`'s input) stays.
    await tx
      .update(proposals)
      .set({ decidedByUserId: null })
      .where(and(eq(proposals.workspaceId, input.workspaceId), eq(proposals.decidedByUserId, input.userId)));

    // 6. Delete this member's own messages across this workspace's chats.
    const deletedMessages = await tx.execute<{ id: number }>(sql`
      delete from messages m
      using chats c
      where m.chat_id = c.id
        and c.workspace_id = ${input.workspaceId}
        and m.author_user_id = ${input.userId}
      returning m.id
    `);

    // 7. Delete the membership row itself.
    await tx.delete(memberships).where(eq(memberships.id, membership.id));

    // 8. Delete the `users` row too, but only if they now have no other workspace membership and are
    // not a superadmin (SPEC §19.3.3 / plan.md brief) — see `deleteUserIfOrphaned` above.
    const userDeleted = await deleteUserIfOrphaned(tx, input.userId, deps.superadminIds);

    return {
      messages: deletedMessages.length,
      tasksAnonymized: anonymized.length,
      userDeleted,
    };
  });

  deps.logger.info(
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      messages: result.messages,
      tasksAnonymized: result.tasksAnonymized,
      userDeleted: result.userDeleted,
    },
    'eraseMember: done',
  );

  return result;
}
