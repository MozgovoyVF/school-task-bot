import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import type { TaskHook } from '../tasks/service.js';
import { notifications } from '../../db/schema/index.js';
import { getSettings } from '../workspaces/repo.js';
import { resolveRecipients } from './recipients.js';
import { planTaskNotifications } from './plan.js';

/**
 * Cancels every still-`scheduled` notification for a task (SPEC §13.2: "any change -> cancel everything",
 * covering `pre_due`/`due`/`overdue`/`snooze` alike — there is no kind-specific carve-out). Rows already
 * `sent`/`failed`/`cancelled` are left untouched.
 */
async function cancelScheduled(tx: Tx, taskId: number): Promise<void> {
  await tx
    .update(notifications)
    .set({ status: 'cancelled' })
    .where(and(eq(notifications.taskId, taskId), eq(notifications.status, 'scheduled')));
}

/**
 * Recomputes a task's reminder notifications on every change (Task 3.2, wiring Task 3.1's
 * `planTaskNotifications` into `TaskService`): cancels every `scheduled` row for the task, then — unless the
 * task is closed or has no eligible recipient — inserts the freshly planned rows, `ON CONFLICT (dedupe_key)
 * DO NOTHING` so a same-day due-time edit after a reminder has already fired (D6) never collides with it.
 *
 * `task` is `null` for a hook reacting to a task that no longer resolves within its own transaction (see
 * `TaskHook`'s doc comment) — `TaskService` itself never does this (always passes the just-written row), and
 * `TaskChange` carries no task id for this hook to cancel by in that case, so this is a no-op then.
 */
export const remindersHook: TaskHook = {
  name: 'reminders',

  async afterChange(tx, task, _change, deps) {
    if (!task) return;

    await cancelScheduled(tx, task.id);

    const settings = await getSettings(tx, task.workspaceId);
    const recipients = await resolveRecipients(tx, task, settings);
    if (recipients.length === 0) return;

    const planned = planTaskNotifications({
      task,
      recipients,
      reminders: settings.reminders,
      now: deps.clock.now(),
    });
    if (planned.length === 0) return;

    await tx
      .insert(notifications)
      .values(
        planned.map((p) => ({
          workspaceId: task.workspaceId,
          taskId: task.id,
          recipientUserId: p.recipientUserId,
          kind: p.kind,
          fireAt: p.fireAt,
          dedupeKey: p.dedupeKey,
        })),
      )
      .onConflictDoNothing({ target: notifications.dedupeKey });
  },
};
