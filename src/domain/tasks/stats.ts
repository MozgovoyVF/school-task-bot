/**
 * `/stats` (plan.md Task 3.8, SPEC §12.5): per-assignee counters over a 7/30/90-day window. Grouping key
 * ruling (the brief's interface left this ambiguous, resolved for this task): `{ type: 'owner' }` for a
 * task the workspace Owner delegated to themself (`assigneeUserId` equals the Owner's own user id — this
 * produces SPEC §12.5's separate "Owner" row); `{ type: 'user'; userId; name }` for any other real member;
 * `{ type: 'none' }` for everything else (no assignee, `assigneeAll=true`, or a free-text
 * `assigneeNameText`) — folded together since the interface has no fourth variant for those.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../../db/client.js';
import { tasks } from '../../db/schema/index.js';
import { getOwner, listMembersWithUsers } from '../people/repo.js';
import { getWorkspace } from '../workspaces/repo.js';
import { dueBucket } from './queries.js';
import type { TaskRow } from './repo.js';

export type TaskStatsKey =
  { type: 'user'; userId: number; name: string } | { type: 'owner' } | { type: 'none' };

export interface TaskStatsRow {
  key: TaskStatsKey;
  open: number;
  inProgress: number;
  overdueNow: number;
  done: number;
  onTimePct: number | null;
  avgLateHours: number | null;
}

/** The cohort is every `open`/`in_progress`/`done` task created within the period (ruling: `periodDays`
 * filters by `tasks.created_at`, not by when a task happened to finish) — `cancelled` tasks are excluded
 * entirely, same as they're excluded from every count SPEC §12.5 actually asks for. */
const COHORT_STATUSES = ['open', 'in_progress', 'done'] as const;

interface Accumulator {
  key: TaskStatsKey;
  open: number;
  inProgress: number;
  overdueNow: number;
  done: number;
  onTimeCount: number;
  lateCount: number;
  lateHoursSum: number;
}

/** `task`'s own {@link TaskStatsKey} and a stable string to group accumulators by — see this file's own
 * top doc comment for the three-way ruling. */
function classify(
  task: TaskRow,
  ownerId: number | null,
  nameByUserId: ReadonlyMap<number, string>,
): { groupKey: string; key: TaskStatsKey } {
  if (task.assigneeUserId !== null) {
    if (ownerId !== null && task.assigneeUserId === ownerId) {
      return { groupKey: 'owner', key: { type: 'owner' } };
    }
    const name = nameByUserId.get(task.assigneeUserId);
    // `name === undefined` only if the membership is somehow gone — shouldn't happen under normal
    // operation (the FK's `ON DELETE SET NULL` already clears `assigneeUserId` when a member is removed),
    // but this stays graceful rather than throwing, same stance `./queries.ts`'s
    // `resolveAssigneeDisplayName` already takes.
    if (name !== undefined) {
      return {
        groupKey: `user:${String(task.assigneeUserId)}`,
        key: { type: 'user', userId: task.assigneeUserId, name },
      };
    }
  }
  return { groupKey: 'none', key: { type: 'none' } };
}

function isUserKey(key: TaskStatsKey): key is Extract<TaskStatsKey, { type: 'user' }> {
  return key.type === 'user';
}

/** User rows alphabetically (Russian collation) first, then Owner, then "without assignee" last — a group
 * with no tasks in the cohort simply has no row (standard `GROUP BY` behaviour: nothing invented for a
 * group that isn't present in the data). */
function sortRows(rows: readonly TaskStatsRow[]): TaskStatsRow[] {
  const userRows = rows
    .filter((r) => isUserKey(r.key))
    .sort((a, b) =>
      (a.key as Extract<TaskStatsKey, { type: 'user' }>).name.localeCompare(
        (b.key as Extract<TaskStatsKey, { type: 'user' }>).name,
        'ru',
      ),
    );
  const ownerRow = rows.find((r) => r.key.type === 'owner');
  const noneRow = rows.find((r) => r.key.type === 'none');
  return [...userRows, ...(ownerRow ? [ownerRow] : []), ...(noneRow ? [noneRow] : [])];
}

/**
 * Per-assignee counters for `workspaceId` over the last `periodDays` days as seen from `now` (SPEC §12.5).
 * `open`/`inProgress`/`overdueNow` are current-status snapshot counts (`overdueNow` is the subset of
 * `open`-status tasks that are currently overdue, per {@link dueBucket}); `done`/`onTimePct`/
 * `avgLateHours` describe the cohort's tasks that reached `done`: on-time is `completedAt <= dueAt` or no
 * due date at all, late is `completedAt > dueAt`, and `avgLateHours` averages the late ones' lateness in
 * hours (`null` with no late tasks). `onTimePct` is `round(onTimeCount / doneCount * 100)`, `null` with no
 * done tasks at all.
 *
 * No `zone` parameter (the brief's own interface) — `dueBucket`'s all-day-due boundary falls back to the
 * workspace's own timezone when a task's `dueTz` is unset (the normal case always sets it), read once from
 * `workspaces.timezone` rather than widening this function's signature for an edge case the UI never
 * actually produces.
 */
export async function taskStats(
  db: DbOrTx,
  args: { workspaceId: number; periodDays: 7 | 30 | 90; now: Date },
): Promise<TaskStatsRow[]> {
  const { workspaceId, periodDays, now } = args;
  const cutoff = DateTime.fromJSDate(now).minus({ days: periodDays }).toJSDate();

  // Sequential, not `Promise.all` — `db` may be a transaction, same note `./queries.ts`'s own
  // `toListItems` already carries (a single Postgres connection can't run overlapping queries).
  const owner = await getOwner(db, workspaceId);
  const members = await listMembersWithUsers(db, workspaceId);
  const workspace = await getWorkspace(db, workspaceId);
  const zone = workspace?.timezone ?? 'UTC';

  const ownerId = owner?.user.id ?? null;
  const nameByUserId = new Map(members.map((m) => [m.user.id, m.membership.displayName]));

  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        gte(tasks.createdAt, cutoff),
        inArray(tasks.status, COHORT_STATUSES),
      ),
    );

  const groups = new Map<string, Accumulator>();

  for (const task of rows) {
    const { groupKey, key } = classify(task, ownerId, nameByUserId);
    let acc = groups.get(groupKey);
    if (acc === undefined) {
      acc = {
        key,
        open: 0,
        inProgress: 0,
        overdueNow: 0,
        done: 0,
        onTimeCount: 0,
        lateCount: 0,
        lateHoursSum: 0,
      };
      groups.set(groupKey, acc);
    }

    if (task.status === 'open') {
      acc.open += 1;
      if (dueBucket(task, now, zone) === 'overdue') acc.overdueNow += 1;
    } else if (task.status === 'in_progress') {
      acc.inProgress += 1;
    } else {
      // task.status === 'done' (COHORT_STATUSES has no other member left)
      acc.done += 1;
      if (task.completedAt !== null) {
        if (task.dueAt === null || task.completedAt.getTime() <= task.dueAt.getTime()) {
          acc.onTimeCount += 1;
        } else {
          acc.lateCount += 1;
          acc.lateHoursSum += (task.completedAt.getTime() - task.dueAt.getTime()) / 3_600_000;
        }
      }
    }
  }

  const result: TaskStatsRow[] = [...groups.values()].map((acc) => ({
    key: acc.key,
    open: acc.open,
    inProgress: acc.inProgress,
    overdueNow: acc.overdueNow,
    done: acc.done,
    onTimePct: acc.done === 0 ? null : Math.round((acc.onTimeCount / acc.done) * 100),
    avgLateHours: acc.lateCount === 0 ? null : acc.lateHoursSum / acc.lateCount,
  }));

  return sortRows(result);
}
