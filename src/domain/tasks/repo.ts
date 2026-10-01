import { eq } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../../db/client.js';
import { tasks } from '../../db/schema/index.js';

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;

/** Raw DB access for `tasks` (plan.md Task 2.13) — business logic (truncation, versioning, events,
 * `taskHooks`) lives in `src/domain/tasks/service.ts`'s `TaskService`; this module only ever reads/writes
 * the row itself, mirroring `src/domain/proposals/repo.ts`'s split. */

export async function getTaskById(db: DbOrTx, id: number): Promise<TaskRow | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
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
