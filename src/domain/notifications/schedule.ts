import { and, eq, sql } from 'drizzle-orm';
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
 * task is closed or has no eligible recipient — inserts the freshly planned rows.
 *
 * `ON CONFLICT (dedupe_key) DO UPDATE ... WHERE status='cancelled'` (not `DO NOTHING`, review round 3, C1):
 * `dedupeKey` is `task:{id}:v{version}:{kind}:{recipient}:{fire_date}` (D6) — it only changes when
 * `task.version` bumps, which `TaskService.update`/`setStatus` do on every ordinary edit, but
 * `afterOwnerChanged`'s replan (`src/domain/people/ownerChanged.ts`, review round 2, I3 part 2) calls this
 * hook directly, with no task edit and so no version bump. A self-claim (new owner === old owner) or an
 * A→B→A round trip with no edit in between therefore recomputes the *exact same* dedupe keys the
 * `cancelScheduled` call just above cancelled — `DO NOTHING` would silently drop the re-insert entirely,
 * leaving the task with no reminders at all (worse than not replanning). `DO UPDATE` revives exactly the
 * row this same call just cancelled back to `scheduled` with the freshly planned `fire_at`/recipient/kind;
 * `setWhere: status='cancelled'` guards a `sent` row from ever being revived by a later, unrelated replan —
 * same pattern `src/scheduler/jobs/summary.ts`'s `ensureSummariesJob` already uses for this exact trap.
 * `excluded.*` (not a literal) is required here because this is a *multi-row* insert — every planned row's
 * own `fire_at`/`recipient_user_id`/`kind` must be written back, not one shared value.
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
      .onConflictDoUpdate({
        target: notifications.dedupeKey,
        set: {
          status: 'scheduled',
          recipientUserId: sql.raw(`excluded.${notifications.recipientUserId.name}`),
          kind: sql.raw(`excluded.${notifications.kind.name}`),
          fireAt: sql.raw(`excluded.${notifications.fireAt.name}`),
          attempts: 0,
          lastError: null,
          sentTgMessageId: null,
        },
        setWhere: eq(notifications.status, 'cancelled'),
      });
  },
};
