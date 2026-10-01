import type { DbOrTx } from '../../db/client.js';
import { getOwner } from '../people/repo.js';
import { getWorkspace } from '../workspaces/repo.js';
import type { Settings } from '../settings/schema.js';
import type { TaskRow } from '../tasks/repo.js';
import type { PlanRecipient } from './plan.js';

/**
 * Resolves who should receive reminder notifications for a task (Task 3.2) — D40: task notifications go only
 * to the workspace owner, never to members/assignees, and only once they have actually started a DM with the
 * bot (`dm_started_at` set) and have not blocked it (`dm_blocked=false`); otherwise an empty list, which
 * `remindersHook` then turns into "no reminders scheduled" rather than an error (recall-first: a missing
 * recipient must never crash the task write it's attached to).
 *
 * `settings` is accepted for interface symmetry with `planTaskNotifications` (which the caller feeds this
 * function's result into) — recipient resolution itself does not currently depend on any workspace setting.
 */
export async function resolveRecipients(
  db: DbOrTx,
  task: Pick<TaskRow, 'workspaceId'>,
  settings: Settings,
): Promise<PlanRecipient[]> {
  void settings;

  const owner = await getOwner(db, task.workspaceId);
  if (!owner) return [];
  if (owner.user.dmStartedAt === null || owner.user.dmBlocked) return [];

  let zone = owner.user.timezone;
  if (zone === null) {
    const workspace = await getWorkspace(db, task.workspaceId);
    zone = workspace?.timezone ?? null;
  }
  if (zone === null) return [];

  return [{ userId: owner.user.id, zone }];
}
