import type { Tx } from '../../db/client.js';
import { taskEvents } from '../../db/schema/index.js';

export type TaskEventRow = typeof taskEvents.$inferSelect;

/** `task_events.actor_type`/`actor_user_id` (`src/db/schema/tasks.ts`'s `taskEventActorType` enum). */
export interface TaskEventActor {
  actorType: 'user' | 'system' | 'ai' | 'apple';
  actorUserId: number | null;
}

export interface NewTaskEvent extends TaskEventActor {
  taskId: number;
  /** e.g. `'created'`, `'updated'`, `'status_changed'` — free text (the column has no enum), see
   * `src/db/schema/tasks.ts`'s doc comment on `task_events.type` for the full expected vocabulary. */
  type: string;
  diff: unknown;
  createdAt: Date;
}

/** Always called inside the same transaction as the task write it records (`TaskService`) — never a
 * plain `Db` — so a crash between the two can never leave one without the other. */
export async function insertTaskEvent(tx: Tx, event: NewTaskEvent): Promise<TaskEventRow> {
  const [row] = await tx
    .insert(taskEvents)
    .values({
      taskId: event.taskId,
      actorType: event.actorType,
      actorUserId: event.actorUserId,
      type: event.type,
      diff: event.diff ?? null,
      createdAt: event.createdAt,
    })
    .returning();
  if (!row) throw new Error('insertTaskEvent: insert returned no row');
  return row;
}
