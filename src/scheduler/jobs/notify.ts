import { and, asc, eq, lte } from 'drizzle-orm';
import type { AppDeps } from '../../deps.js';
import type { Tx } from '../../db/client.js';
import { notifications } from '../../db/schema/index.js';
import { getOwner, getUserById, markDmBlocked, type UserRow } from '../../domain/people/repo.js';
import { getSettings } from '../../domain/workspaces/repo.js';
import { getTaskById, type TaskRow } from '../../domain/tasks/repo.js';
import {
  getTaskListItem,
  summarySections,
  type SummarySections,
  type TaskListItem,
} from '../../domain/tasks/queries.js';
import { nextOverdueAfter, type PlanRecipient } from '../../domain/notifications/plan.js';
import { nextAttemptAt } from '../../ai/pipeline/batcher.js';
import { userZone } from '../../time/zones.js';
import { isQuietAt } from '../../time/quiet.js';
import { renderOverdueDigest, renderReminder, type ReminderKind } from '../../bot/views/reminder.js';
import { renderSummary } from '../../bot/views/summary.js';
import { MessengerError, type Buttons, type MessengerErrorKind } from '../../domain/messenger.js';
import type { Job } from '../ticker.js';
import type { Settings } from '../../domain/settings/schema.js';

type NotificationRow = typeof notifications.$inferSelect;

const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled']);

/** D10/SPEC §13.5: these two task-bound kinds are suppressed during quiet hours (`status='cancelled'`,
 * `last_error='quiet'`); `due` and `snooze` are always sent. `summary` is also suppressed by D10, but it
 * has no task and is handled on its own branch in `resolveNotification` (review round 1, I1) rather than
 * through this set. */
const SUPPRESSED_BY_QUIET = new Set<NotificationRow['kind']>(['pre_due', 'overdue']);

const NOTIFY_BATCH_LIMIT = 50;

/** A task-bound `scheduled` row (`pre_due`/`due`/`overdue`/`snooze`), resolved against its still-current
 * task/recipient and ready to be sent (or grouped into an overdue digest) this tick. */
interface ResolvedTaskNotification {
  kind: 'task';
  row: NotificationRow;
  taskRow: TaskRow;
  listItem: TaskListItem;
  recipient: UserRow;
  zone: string;
}

/** A `summary`-kind `scheduled` row, resolved with its own freshly-built `SummarySections` (Task 3.5) —
 * has no task of its own, so it never joins {@link ResolvedTaskNotification}'s `overdue`-chain grouping. */
interface ResolvedSummaryNotification {
  kind: 'summary';
  row: NotificationRow;
  sections: SummarySections;
  recipient: UserRow;
  zone: string;
}

/** One `scheduled` row, resolved against its still-current recipient (and, for a task-bound kind, its
 * still-current task) and ready to be sent this tick. */
type ResolvedNotification = ResolvedTaskNotification | ResolvedSummaryNotification;

type SendResult = { ok: true; messageId: number } | { ok: false; kind: MessengerErrorKind };

/** Sends one reminder DM, translating a `Messenger` failure into {@link SendResult} instead of throwing — mirrors `src/scheduler/jobs/cards.ts`'s `sendToOwner`. */
async function sendReminder(
  deps: AppDeps,
  tgUserId: number,
  text: string,
  buttons: Buttons,
): Promise<SendResult> {
  try {
    const { messageId } = await deps.messenger.send(tgUserId, text, { buttons });
    return { ok: true, messageId };
  } catch (err) {
    if (err instanceof MessengerError) return { ok: false, kind: err.kind };
    throw err;
  }
}

async function cancelNotification(tx: Tx, id: number, lastError: string | null): Promise<void> {
  await tx.update(notifications).set({ status: 'cancelled', lastError }).where(eq(notifications.id, id));
}

/**
 * `nextOverdueAfter`'s underlying `earliestTimeStrictlyAfter` has no awareness of "now" — it only finds the
 * first `overdueTime` strictly after whatever instant it's given. After real downtime (bot down for days),
 * anchoring purely on the just-handled row's own `fireAt` would compute a next link that is *itself* still
 * in the past, cascading into several near-instant catch-up overdue pings the next few ticks (review round
 * 1, I3). Clamping the anchor forward to `now` fixes that without changing anything in normal operation —
 * a row's `fireAt` is only ever at or before `now` by construction (the job only selects due rows), so this
 * only has an effect when it is *behind* `now` by more than the gap between one `overdueTime` and the next.
 */
function chainAnchor(fireAt: Date, now: Date): Date {
  return fireAt.getTime() > now.getTime() ? fireAt : now;
}

/** The next link of an `overdue` chain (D7 — the chain continues daily until the task closes): planned from
 * `after` (see {@link chainAnchor} for why callers pass a clamped instant, not the row's raw `fireAt`). A
 * no-op once the task has no due date left or is closed. */
async function scheduleNextOverdueLink(
  tx: Tx,
  workspaceId: number,
  task: TaskRow,
  recipient: PlanRecipient,
  reminders: Settings['reminders'],
  after: Date,
): Promise<void> {
  const planned = nextOverdueAfter({ task, recipient, reminders, after });
  if (planned === null) return;
  await tx
    .insert(notifications)
    .values({
      workspaceId,
      taskId: task.id,
      recipientUserId: planned.recipientUserId,
      kind: planned.kind,
      fireAt: planned.fireAt,
      dedupeKey: planned.dedupeKey,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey });
}

/** `attempts++`/backoff (SPEC §13.1): reuses `src/ai/pipeline/batcher.ts`'s `nextAttemptAt` — 1/5/15 min,
 * `failed` once `attempts` reaches its cap. Returns whether this failure was the one that pushed the row to
 * `failed` — its caller uses that to decide whether an `overdue` row's chain still needs continuing (review
 * round 1, I2: exhausting retries must not silently end the chain). */
async function recordSendFailure(
  tx: Tx,
  row: NotificationRow,
  kind: MessengerErrorKind,
  now: Date,
): Promise<{ failed: boolean }> {
  const attempts = row.attempts + 1;
  const next = nextAttemptAt(attempts, now);
  if (next === null) {
    await tx
      .update(notifications)
      .set({ status: 'failed', attempts, lastError: kind })
      .where(eq(notifications.id, row.id));
    return { failed: true };
  }
  await tx
    .update(notifications)
    .set({ attempts, fireAt: next, lastError: kind })
    .where(eq(notifications.id, row.id));
  return { failed: false };
}

/** 403 (SPEC §13.1): flips `users.dm_blocked` and cancels every `scheduled` notification for that
 * recipient — not just the one that just failed. */
async function handleForbidden(tx: Tx, recipientId: number): Promise<void> {
  await markDmBlocked(tx, recipientId, true);
  await tx
    .update(notifications)
    .set({ status: 'cancelled' })
    .where(and(eq(notifications.recipientUserId, recipientId), eq(notifications.status, 'scheduled')));
}

/** Applies one send's outcome to every row it covers (a single reminder, or every row behind a grouped
 * overdue digest, which is exactly one Telegram message): on success, or once an `overdue` row's retries
 * are exhausted (`failed` — review round 1, I2: D7's chain continues "until the task closes", not until the
 * first unlucky Telegram outage), continues each covered task's own `overdue` chain. `forbidden` is the one
 * outcome that deliberately does *not* continue any chain — the recipient blocked the bot, so nothing more
 * is scheduled for them until they unblock it and D40's recipient resolution picks them up again. */
async function applySendResult(
  tx: Tx,
  deps: AppDeps,
  rows: readonly ResolvedNotification[],
  recipient: UserRow,
  settings: Settings,
  now: Date,
  result: SendResult,
): Promise<void> {
  if (!result.ok) {
    if (result.kind === 'forbidden') {
      await handleForbidden(tx, recipient.id);
      return;
    }
    for (const r of rows) {
      const { failed } = await recordSendFailure(tx, r.row, result.kind, now);
      if (failed && r.kind === 'task' && r.row.kind === 'overdue') {
        await scheduleNextOverdueLink(
          tx,
          deps.workspace.id,
          r.taskRow,
          { userId: r.recipient.id, zone: r.zone },
          settings.reminders,
          chainAnchor(r.row.fireAt, now),
        );
      }
    }
    return;
  }

  for (const r of rows) {
    await tx
      .update(notifications)
      .set({ status: 'sent', sentTgMessageId: result.messageId })
      .where(eq(notifications.id, r.row.id));
    if (r.kind === 'task' && r.row.kind === 'overdue') {
      await scheduleNextOverdueLink(
        tx,
        deps.workspace.id,
        r.taskRow,
        { userId: r.recipient.id, zone: r.zone },
        settings.reminders,
        chainAnchor(r.row.fireAt, now),
      );
    }
  }
}

/**
 * Resolves one `scheduled` row against its (possibly now-stale) task and recipient: `null` once it has
 * nothing left to send for — the row is cancelled and `null` is returned.
 *
 * `summary` rows have no task (`taskId` is `null` — their dedupe key is `summary:{ws}:{user}:{date}`, SPEC
 * §13.1) and are resolved on their own branch, checked *before* the generic task lookup (review round 1,
 * I1 — checking the generic "no task" branch first was unconditionally cancelling every `summary` row,
 * quiet hours or not, instead of only suppressing it during quiet hours like D10 requires): quiet hours
 * cancel it with `last_error='quiet'` (`src/scheduler/jobs/summary.ts`'s `ensureSummariesJob` — running
 * right after this job in `src/app.ts`'s ticker — then schedules the next occurrence); otherwise (Task
 * 3.5) its `SummarySections` are built fresh, right here, from the current state of the workspace's tasks
 * and proposals — a summary is never pre-rendered ahead of its own fire time.
 */
async function resolveNotification(
  tx: Tx,
  deps: AppDeps,
  settings: Settings,
  row: NotificationRow,
  now: Date,
): Promise<ResolvedNotification | null> {
  const recipient = await getUserById(tx, row.recipientUserId);
  if (recipient === null) {
    await cancelNotification(tx, row.id, null);
    return null;
  }

  // D40: every notification goes to the Owner, always — but `row.recipientUserId` was fixed at planning
  // time (`remindersHook`/`ensureSummariesJob`) and nothing replans or cancels existing rows when
  // ownership changes mid-flight (review round 2, I3). This safety net catches whatever
  // `afterOwnerChanged`'s own replan (`src/domain/people/ownerChanged.ts`) didn't — a row planned *after*
  // the last replan but *before* a subsequent transfer, or simply a workspace with no Owner at all right
  // now. Runs for every kind, `summary` included: `ensureSummariesJob` only ever looks at the *current*
  // owner's own rows, so it would never find (or cancel) a stale row still pointing at a former one.
  const owner = await getOwner(tx, deps.workspace.id);
  if (owner === null || recipient.id !== owner.user.id) {
    await cancelNotification(tx, row.id, null);
    return null;
  }
  const zone = userZone(recipient, deps.workspace);

  if (row.kind === 'summary') {
    if (isQuietAt(now, zone, settings.quiet)) {
      await cancelNotification(tx, row.id, 'quiet');
      return null;
    }
    const sections = await summarySections(tx, { workspaceId: deps.workspace.id, now, zone });
    return { kind: 'summary', row, sections, recipient, zone };
  }

  const taskRow = row.taskId === null ? null : await getTaskById(tx, row.taskId);
  if (taskRow === null || CLOSED_TASK_STATUSES.has(taskRow.status)) {
    await cancelNotification(tx, row.id, null);
    return null;
  }

  if (SUPPRESSED_BY_QUIET.has(row.kind) && isQuietAt(now, zone, settings.quiet)) {
    await cancelNotification(tx, row.id, 'quiet');
    if (row.kind === 'overdue') {
      await scheduleNextOverdueLink(
        tx,
        deps.workspace.id,
        taskRow,
        { userId: recipient.id, zone },
        settings.reminders,
        chainAnchor(row.fireAt, now),
      );
    }
    return null;
  }

  const listItem = await getTaskListItem(tx, taskRow.id);
  if (listItem === null) {
    await cancelNotification(tx, row.id, null);
    return null;
  }

  return { kind: 'task', row, taskRow, listItem, recipient, zone };
}

/** `row.kind` narrowed to {@link ReminderKind} — safe once `resolveNotification` has already returned
 * `null` for `summary`. */
function reminderKind(row: NotificationRow): ReminderKind {
  if (row.kind === 'summary') throw new Error('notifyJob: unexpected summary row past resolveNotification');
  return row.kind;
}

/**
 * The reminder outbox (SPEC §13.1/§13.2, plan.md Task 3.3): one transaction claims up to
 * {@link NOTIFY_BATCH_LIMIT} due `scheduled` rows (`FOR UPDATE SKIP LOCKED`, so two concurrent ticks never
 * send the same notification twice), resolves each against its current task/recipient, groups same-tick
 * `overdue` rows per recipient into one digest once their count reaches `settings.reminders.
 * groupOverdueThreshold`, sends everything else individually, and records each send's outcome (sent —
 * continuing that task's own `overdue` chain; backed-off retry; `failed` past the attempt cap — also
 * continuing the chain, review round 1 I2; or `forbidden`'s `dm_blocked` + cancel-all, which does not).
 */
export const notifyJob: Job = {
  name: 'notify',
  async run(deps) {
    const now = deps.clock.now();

    await deps.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.workspaceId, deps.workspace.id),
            eq(notifications.status, 'scheduled'),
            lte(notifications.fireAt, now),
          ),
        )
        .orderBy(asc(notifications.fireAt), asc(notifications.id))
        .limit(NOTIFY_BATCH_LIMIT)
        .for('update', { skipLocked: true });
      if (due.length === 0) return;

      const settings = await getSettings(tx, deps.workspace.id);

      const individual: ResolvedNotification[] = [];
      const overdueByRecipient = new Map<number, ResolvedTaskNotification[]>();

      for (const row of due) {
        const resolved = await resolveNotification(tx, deps, settings, row, now);
        if (resolved === null) continue;
        if (resolved.kind === 'task' && resolved.row.kind === 'overdue') {
          const list = overdueByRecipient.get(resolved.recipient.id) ?? [];
          list.push(resolved);
          overdueByRecipient.set(resolved.recipient.id, list);
        } else {
          individual.push(resolved);
        }
      }

      // 403 is scoped to its recipient (`handleForbidden` cancels every `scheduled` row for them, including
      // ones already resolved into `overdueByRecipient` above) — skip sending to a recipient this tick has
      // already found blocked, rather than sending (and failing) again.
      const blocked = new Set<number>();

      for (const r of individual) {
        if (blocked.has(r.recipient.id)) continue;
        // `summary` (Task 3.5) has no task of its own — rendered from its pre-built `SummarySections`
        // instead of `renderReminder`'s task-card shape.
        const { text, buttons } =
          r.kind === 'summary'
            ? renderSummary(r.sections, { date: now, zone: r.zone })
            : renderReminder({ kind: reminderKind(r.row), task: r.listItem, viewerZone: r.zone });
        const result = await sendReminder(deps, r.recipient.tgUserId, text, buttons);
        if (!result.ok && result.kind === 'forbidden') blocked.add(r.recipient.id);
        await applySendResult(tx, deps, [r], r.recipient, settings, now, result);
      }

      for (const list of overdueByRecipient.values()) {
        const first = list[0];
        if (first === undefined || blocked.has(first.recipient.id)) continue;

        if (list.length >= settings.reminders.groupOverdueThreshold) {
          const { text, buttons } = renderOverdueDigest(
            list.map((r) => r.listItem),
            first.zone,
          );
          const result = await sendReminder(deps, first.recipient.tgUserId, text, buttons);
          if (!result.ok && result.kind === 'forbidden') blocked.add(first.recipient.id);
          await applySendResult(tx, deps, list, first.recipient, settings, now, result);
        } else {
          for (const r of list) {
            if (blocked.has(r.recipient.id)) continue;
            const { text, buttons } = renderReminder({
              kind: reminderKind(r.row),
              task: r.listItem,
              viewerZone: r.zone,
            });
            const result = await sendReminder(deps, r.recipient.tgUserId, text, buttons);
            if (!result.ok && result.kind === 'forbidden') blocked.add(r.recipient.id);
            await applySendResult(tx, deps, [r], r.recipient, settings, now, result);
          }
        }
      }
    });
  },
};
