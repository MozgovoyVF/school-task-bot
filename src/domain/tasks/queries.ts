import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { memberships } from '../../db/schema/index.js';
import { texts } from '../../bot/texts/ru.js';
import { getTaskById, type TaskRow } from './repo.js';

/**
 * A task's display-ready projection for reminders and lists (plan.md Task 3.3; Tasks 3.5 and 3.7 add their
 * own sections to this file). `assigneeName` is already resolved to its final display string — the
 * assignee's membership `displayName`, the task's free-text `assigneeNameText`, or
 * `texts.proposalCard.assigneeAll` (the "everyone" label) for `assigneeAll` — `null` means only
 * "unassigned" (mirrors `src/scheduler/jobs/cards.ts`'s `assigneeView`/`assigneeText` pair, which resolves
 * a proposal's assignee the same three ways for a card).
 */
export interface TaskListItem {
  id: number;
  title: string;
  assigneeName: string | null;
  dueAt: Date | null;
  dueAllDay: boolean;
  dueTz: string | null;
  status: string;
}

/** `task.assignee_user_id`'s display name — looked up via `memberships` (not `users`), since the display
 * name shown on cards/reminders is the per-workspace `displayName`, not the Telegram profile name. `null`
 * if the membership is somehow gone (should not happen under normal operation — a deleted member leaves the
 * task's `assignee_user_id` null too, SPEC's `ON DELETE SET NULL` — but this is read-only, so this stays a
 * graceful `null` rather than a throw). */
async function resolveAssigneeDisplayName(
  db: DbOrTx,
  workspaceId: number,
  assigneeUserId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ displayName: memberships.displayName })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, assigneeUserId)))
    .limit(1);
  return row?.displayName ?? null;
}

async function resolveAssigneeName(db: DbOrTx, task: TaskRow): Promise<string | null> {
  if (task.assigneeAll) return texts.proposalCard.assigneeAll;
  if (task.assigneeUserId !== null)
    return resolveAssigneeDisplayName(db, task.workspaceId, task.assigneeUserId);
  if (task.assigneeNameText !== null) return task.assigneeNameText;
  return null;
}

function toListItem(task: TaskRow, assigneeName: string | null): TaskListItem {
  return {
    id: task.id,
    title: task.title,
    assigneeName,
    dueAt: task.dueAt,
    dueAllDay: task.dueAllDay,
    dueTz: task.dueTz,
    status: task.status,
  };
}

/** `taskId` → its {@link TaskListItem} projection, or `null` if the task no longer exists. */
export async function getTaskListItem(db: DbOrTx, taskId: number): Promise<TaskListItem | null> {
  const task = await getTaskById(db, taskId);
  if (task === null) return null;
  const assigneeName = await resolveAssigneeName(db, task);
  return toListItem(task, assigneeName);
}
