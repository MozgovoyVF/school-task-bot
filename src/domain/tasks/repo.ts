import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../../db/client.js';
import { tasks } from '../../db/schema/index.js';

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;

/** Raw DB access for `tasks` (plan.md Task 2.13) — business logic (truncation, versioning, events,
 * `taskHooks`) lives in `src/domain/tasks/service.ts`'s `TaskService`; this module only ever reads/writes
 * the row itself, mirroring `src/domain/proposals/repo.ts`'s split. */

/** Mirrors `src/domain/tasks/queries.ts`'s own (unexported) `OPEN_STATUSES` — kept as a separate local
 * const here rather than imported, since that module's is private and this one lives on the opposite side
 * of the `repo`/`queries` split (plan.md Task 2.13's doc comment above). */
const OPEN_STATUSES = ['open', 'in_progress'] as const;

export async function getTaskById(db: DbOrTx, id: number): Promise<TaskRow | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return row ?? null;
}

/** Every open (`'open'`/`'in_progress'`) task row in a workspace — added for `afterOwnerChanged`
 * (`src/domain/people/ownerChanged.ts`, review round 2, I3): an ownership transfer replans every open
 * task's reminders so the new Owner (D40) gets them without waiting for each task to be individually
 * edited first. No other caller currently needs full `TaskRow`s for every open task at once (`queries.ts`'s
 * own `OPEN_STATUSES`-filtered queries all project a narrower shape for list views). */
export async function getOpenTasksByWorkspace(db: DbOrTx, workspaceId: number): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, OPEN_STATUSES)));
}

/** The task created from a given `proposals.id` (`tasks.proposal_id`, set once by `TaskService.create` and
 * never changed after) — `null` when no task was ever created from it (not yet accepted, or not a
 * `create`-kind proposal at all). Added for D44 (`src/domain/proposals/resolveDependents.ts`): resolving a
 * dependent `update`/`complete`/`cancel` proposal's `payload.targetProposalId` once that target proposal
 * has been accepted needs the resulting task's id, and this is the only column that links the two. */
export async function getTaskByProposalId(db: DbOrTx, proposalId: number): Promise<TaskRow | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.proposalId, proposalId)).limit(1);
  return row ?? null;
}

/** Always called inside the caller's transaction (`TaskService.create`) — never a plain `Db` — so the
 * insert commits atomically with the `task_events` row and any `taskHooks` call for the same change. */
export async function insertTask(tx: Tx, values: NewTaskRow): Promise<TaskRow> {
  const [row] = await tx.insert(tasks).values(values).returning();
  if (!row) throw new Error('insertTask: insert returned no row');
  return row;
}

/** Same atomicity note as {@link insertTask}. `id` not found is an internal-consistency bug (the caller
 * already read the row within the same transaction) — thrown rather than returning `null`, unlike
 * `getTaskById`. */
export async function updateTaskRow(tx: Tx, id: number, patch: Partial<NewTaskRow>): Promise<TaskRow> {
  const [row] = await tx.update(tasks).set(patch).where(eq(tasks.id, id)).returning();
  if (!row) throw new Error(`updateTaskRow: task ${String(id)} not found`);
  return row;
}

/** Hard delete (plan.md Task 3.6's "delete forever" button, SPEC §12.4) — `task_events.task_id` and
 * `notifications.task_id` both carry `onDelete: 'cascade'` (`src/db/schema/tasks.ts`/`notifications.ts`),
 * so deleting the `tasks` row alone cascades both; no manual cleanup, no `task_events` row for this (there
 * is nothing left for it to reference). Returns `true` when a row actually existed and was deleted, `false`
 * for an id that was already gone — lets the caller tell a genuine delete apart from a no-op. */
export async function deleteTaskById(tx: Tx, id: number): Promise<boolean> {
  const [row] = await tx.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
  return row !== undefined;
}
