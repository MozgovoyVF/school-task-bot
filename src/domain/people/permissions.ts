/**
 * The permission matrix from SPEC §3. Pure, side-effect-free — no DB, no
 * grammY (CLAUDE.md §7's `domain/` boundary). `src/bot/context.ts` re-exports
 * `Actor`/`Role` from here for `BotContext`; `src/bot/middleware/context.ts`
 * builds the actual `Actor` values from `users`/`memberships` lookups.
 */

export type Role = 'owner' | 'member';

/**
 * The requester of a callback/command, resolved by
 * `src/bot/middleware/context.ts` before any handler/permission check runs.
 * `role` is the actor's membership role in the *relevant* workspace (the
 * chat's workspace for a group update, the single default workspace for a
 * DM in MVP — SPEC §5.2) — `null` when the actor has no membership there
 * (e.g. a stranger, or a pending/unapproved chat).
 */
export interface Actor {
  userId: number | null;
  isSuperadmin: boolean;
  role: Role | null;
  dmStarted: boolean;
}

/**
 * SPEC §3's action set — one entry per row of the permission table, plus
 * `chat.manage` (Task 1.9) and `people.manage` (Task 1.10): SPEC §3 has no
 * dedicated row for managing an already-approved chat or editing member
 * profiles, so both are instead derived from SPEC §12.2's `/chats` and
 * `/people` command rows (both "Owner" only, unlike `/transfer`'s explicit
 * "Owner, Superadmin").
 */
export type Action =
  | 'proposal.receive'
  | 'proposal.decide'
  | 'task.createDm'
  | 'task.viewAll'
  | 'task.viewOwn'
  | 'task.startOwn'
  | 'task.doneOwn'
  | 'task.edit'
  | 'reminders.receive'
  | 'chat.approve'
  | 'chat.manage'
  | 'people.manage'
  | 'admin.tech'
  | 'transfer.generate';

/** Narrows the "own task" actions to a specific task's assignee. */
export interface ActionTarget {
  assigneeUserId?: number | null;
}

function ownsTarget(actor: Actor, target: ActionTarget | undefined): boolean {
  return target?.assigneeUserId != null && target.assigneeUserId === actor.userId;
}

// Exhaustiveness guard: a new `Action` variant that isn't handled below fails to compile here.
function assertNever(action: never): never {
  throw new Error(`can(): unhandled action ${String(action)}`);
}

/**
 * Checks whether `actor` may perform `action`, per the SPEC §3 role matrix.
 * `target.assigneeUserId` restricts the "own task" actions (`task.viewOwn` /
 * `task.startOwn` / `task.doneOwn` / `reminders.receive`) to a Member's own
 * tasks; the Owner may act on any task regardless of assignee. Members can
 * never act until they have started a DM with the bot (`actor.dmStarted`).
 */
export function can(actor: Actor, action: Action, target?: ActionTarget): boolean {
  const isOwner = actor.role === 'owner';

  switch (action) {
    // Owner-only: proposals, manual DM task creation, the full task list/archive/search, editing/cancelling tasks.
    // `chat.manage` (SPEC §12.2's `/chats` row: "Owner" only, unlike `/transfer`'s explicit "Owner,
    // Superadmin") — managing an already-approved chat (toggle analysis/reactions, pause, resume,
    // leave), distinct from `chat.approve` below (deciding whether the bot may run in a *pending*
    // chat at all, which SPEC §3's matrix does grant a superadmin). `people.manage` (SPEC §12.2's
    // `/people` row: also "Owner" only) — viewing/editing member names and aliases; deliberately its
    // own Action rather than reusing `chat.manage` (a different resource) or `chat.approve` (which
    // also grants a superadmin, unlike `/people`'s own row).
    case 'proposal.receive':
    case 'proposal.decide':
    case 'task.createDm':
    case 'task.viewAll':
    case 'task.edit':
    case 'chat.manage':
    case 'people.manage':
      return isOwner;

    // Superadmin or Owner: approving a new group chat, generating an ownership-transfer code.
    case 'chat.approve':
    case 'transfer.generate':
      return actor.isSuperadmin || isOwner;

    // Superadmin only: technical commands, error reports, LLM cost.
    case 'admin.tech':
      return actor.isSuperadmin;

    // Owner (any task) or a Member who has started a DM, restricted to their own task.
    case 'task.viewOwn':
    case 'task.startOwn':
    case 'task.doneOwn':
    case 'reminders.receive':
      return isOwner || (actor.role === 'member' && actor.dmStarted && ownsTarget(actor, target));

    default:
      return assertNever(action);
  }
}
