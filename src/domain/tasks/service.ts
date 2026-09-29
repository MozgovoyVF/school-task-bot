import type { Tx } from '../../db/client.js';
import type { AppDeps } from '../../deps.js';
import type { AssigneeResolution } from '../../ai/pipeline/resolve.js';
import { QUOTE_MAX_CHARS, TASK_TITLE_MAX_CHARS } from '../../config/constants.js';
import { getTaskById, insertTask, updateTaskRow, type NewTaskRow, type TaskRow } from './repo.js';
import { insertTaskEvent, type TaskEventActor } from './events.js';

export type TaskStatus = TaskRow['status'];

export interface CreateTaskInput {
  workspaceId: number;
  title: string;
  description: string | null;
  assignee: AssigneeResolution;
  due: { at: Date | null; allDay: boolean; tz: string | null };
  priority: 'low' | 'normal' | 'high';
  origin: 'ai' | 'manual_group' | 'manual_dm' | 'forward';
  proposalId: number | null;
  source: { chatId: number | null; tgMessageId: number | null; link: string | null; quote: string | null };
}

/** Who caused a task write, for `task_events.actor_type`/`actor_user_id` (plan.md Task 2.13). `'apple'` is
 * a forward reference to phase 5's `SyncTarget` (Apple Reminders); the `userId` on `'apple'` is whichever
 * user that sync is acting on behalf of. */
export type ActorRef =
  { type: 'user'; userId: number } | { type: 'system' } | { type: 'ai' } | { type: 'apple'; userId: number };

/**
 * What changed, handed to every registered {@link TaskHook} (plan.md decision D32) alongside the task row
 * itself — `task` is `null` only for a hook reacting to a task that no longer resolves within its own
 * transaction (kept nullable to match `src/deps.ts`'s original forward-declared shape; `TaskService` itself
 * always passes the just-written row, never `null`). `diff`/`status_changed`'s `from`/`to` mirror what
 * `TaskService.update`/`setStatus` also write to `task_events.diff` — see those methods' bodies.
 */
export type TaskChange =
  | { type: 'created' }
  | { type: 'updated'; diff: Record<string, { before: unknown; after: unknown }> }
  | { type: 'status_changed'; from: TaskStatus; to: TaskStatus };

/**
 * A side effect that must run in lockstep with a task write — phase 3's reminder scheduler and phase 5's
 * Apple Reminders sync (`SyncTarget`) are the two consumers plan.md names. `afterChange` receives the same
 * transaction (`tx`) the write itself ran in, so a hook that writes to the DB commits or rolls back
 * together with the task change that triggered it — never left half-applied by a crash between the two.
 */
export interface TaskHook {
  readonly name: string;
  afterChange(
    tx: Tx,
    task: TaskRow | null,
    change: TaskChange,
    deps: Pick<AppDeps, 'clock' | 'config'>,
  ): Promise<void>;
}

export interface TaskService {
  create(tx: Tx, input: CreateTaskInput, actor: ActorRef): Promise<TaskRow>;
  update(
    tx: Tx,
    taskId: number,
    patch: Partial<Pick<CreateTaskInput, 'title' | 'description' | 'assignee' | 'due' | 'priority'>>,
    actor: ActorRef,
  ): Promise<TaskRow>;
  setStatus(tx: Tx, taskId: number, status: TaskStatus, actor: ActorRef): Promise<TaskRow>;
}

/** `AssigneeResolution` -> `tasks.assignee_user_id`/`assignee_name_text`/`assignee_all`. */
function assigneeColumns(
  a: AssigneeResolution,
): Pick<NewTaskRow, 'assigneeUserId' | 'assigneeNameText' | 'assigneeAll'> {
  switch (a.type) {
    case 'user':
      return { assigneeUserId: a.userId, assigneeNameText: null, assigneeAll: false };
    case 'all':
      return { assigneeUserId: null, assigneeNameText: null, assigneeAll: true };
    case 'text':
      return { assigneeUserId: null, assigneeNameText: a.name, assigneeAll: false };
    case 'none':
      return { assigneeUserId: null, assigneeNameText: null, assigneeAll: false };
  }
}

/** The inverse of {@link assigneeColumns} — a task row's current assignee, for `update`'s diff `before`. */
function currentAssignee(row: TaskRow): AssigneeResolution {
  if (row.assigneeAll) return { type: 'all' };
  if (row.assigneeUserId !== null) return { type: 'user', userId: row.assigneeUserId };
  if (row.assigneeNameText !== null) return { type: 'text', name: row.assigneeNameText };
  return { type: 'none' };
}

function actorColumns(actor: ActorRef): TaskEventActor {
  switch (actor.type) {
    case 'user':
      return { actorType: 'user', actorUserId: actor.userId };
    case 'apple':
      return { actorType: 'apple', actorUserId: actor.userId };
    case 'system':
      return { actorType: 'system', actorUserId: null };
    case 'ai':
      return { actorType: 'ai', actorUserId: null };
  }
}

function createdByColumn(actor: ActorRef): number | null {
  return actor.type === 'user' || actor.type === 'apple' ? actor.userId : null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Builds the one `TaskService` implementation (plan.md Task 2.13). Every mutation writes its `tasks` row,
 * its `task_events` row and every registered `taskHooks[].afterChange` inside the *same* transaction
 * (`tx`, supplied by the caller — `TaskService` never opens its own) — see the review risk-focus note on
 * `src/domain/proposals/decide.ts`: a crash partway through must never leave a task changed without its
 * event/hooks, or vice versa.
 */
export function createTaskService(deps: Pick<AppDeps, 'clock' | 'config' | 'taskHooks'>): TaskService {
  async function runHooks(tx: Tx, task: TaskRow, change: TaskChange): Promise<void> {
    for (const hook of deps.taskHooks) {
      await hook.afterChange(tx, task, change, { clock: deps.clock, config: deps.config });
    }
  }

  return {
    async create(tx, input, actor) {
      const now = deps.clock.now();
      const title = truncate(input.title, TASK_TITLE_MAX_CHARS);
      const quote = input.source.quote === null ? null : truncate(input.source.quote, QUOTE_MAX_CHARS);

      const values: NewTaskRow = {
        workspaceId: input.workspaceId,
        title,
        description: input.description,
        ...assigneeColumns(input.assignee),
        dueAt: input.due.at,
        dueAllDay: input.due.allDay,
        dueTz: input.due.tz,
        priority: input.priority,
        status: 'open',
        origin: input.origin,
        proposalId: input.proposalId,
        sourceChatId: input.source.chatId,
        sourceTgMessageId: input.source.tgMessageId,
        sourceLink: input.source.link,
        sourceQuote: quote,
        createdByUserId: createdByColumn(actor),
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      const task = await insertTask(tx, values);
      await insertTaskEvent(tx, {
        taskId: task.id,
        ...actorColumns(actor),
        type: 'created',
        diff: null,
        createdAt: now,
      });
      await runHooks(tx, task, { type: 'created' });
      return task;
    },

    async update(tx, taskId, patch, actor) {
      const now = deps.clock.now();
      const current = await getTaskById(tx, taskId);
      if (!current) throw new Error(`TaskService.update: task ${String(taskId)} not found`);

      const sets: Partial<NewTaskRow> = { updatedAt: now, version: current.version + 1 };
      const diff: Record<string, { before: unknown; after: unknown }> = {};

      if (patch.title !== undefined) {
        const title = truncate(patch.title, TASK_TITLE_MAX_CHARS);
        if (title !== current.title) {
          diff.title = { before: current.title, after: title };
          sets.title = title;
        }
      }
      if (patch.description !== undefined && patch.description !== current.description) {
        diff.description = { before: current.description, after: patch.description };
        sets.description = patch.description;
      }
      if (patch.assignee !== undefined) {
        diff.assignee = { before: currentAssignee(current), after: patch.assignee };
        Object.assign(sets, assigneeColumns(patch.assignee));
      }
      if (patch.due !== undefined) {
        diff.due = {
          before: { at: current.dueAt, allDay: current.dueAllDay, tz: current.dueTz },
          after: patch.due,
        };
        sets.dueAt = patch.due.at;
        sets.dueAllDay = patch.due.allDay;
        sets.dueTz = patch.due.tz;
      }
      if (patch.priority !== undefined && patch.priority !== current.priority) {
        diff.priority = { before: current.priority, after: patch.priority };
        sets.priority = patch.priority;
      }

      const updated = await updateTaskRow(tx, taskId, sets);
      await insertTaskEvent(tx, {
        taskId,
        ...actorColumns(actor),
        type: 'updated',
        diff,
        createdAt: now,
      });
      await runHooks(tx, updated, { type: 'updated', diff });
      return updated;
    },

    async setStatus(tx, taskId, status, actor) {
      const now = deps.clock.now();
      const current = await getTaskById(tx, taskId);
      if (!current) throw new Error(`TaskService.setStatus: task ${String(taskId)} not found`);

      const sets: Partial<NewTaskRow> = { status, updatedAt: now, version: current.version + 1 };
      if (status === 'done') {
        sets.completedAt = now;
        sets.completedByUserId = createdByColumn(actor);
      }
      if (status === 'cancelled') {
        sets.cancelledAt = now;
      }

      const updated = await updateTaskRow(tx, taskId, sets);
      await insertTaskEvent(tx, {
        taskId,
        ...actorColumns(actor),
        type: 'status_changed',
        diff: { status: { before: current.status, after: status } },
        createdAt: now,
      });
      await runHooks(tx, updated, { type: 'status_changed', from: current.status, to: status });
      return updated;
    },
  };
}
