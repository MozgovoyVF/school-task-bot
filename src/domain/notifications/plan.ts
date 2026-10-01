import { DateTime } from 'luxon';
import type { Settings } from '../settings/schema.js';

/**
 * Plans a task's pre-due, due and overdue reminders (SPEC §13.2; plan.md
 * decisions D6-D8, D40). Pure function: "now" is always injected, never read
 * from the system clock (CLAUDE.md — `domain/` must not call `Date.now()`/
 * `new Date()`). The caller passes only the owner as recipient in practice —
 * D40 restricts task notifications to the workspace owner.
 *
 * `nextOverdueAfter` plans the next link of the overdue chain once the
 * previous `overdue` notification has been sent (Task 3.3's sending job).
 */

/** A notification's recipient: their Telegram user id and IANA timezone. */
export interface PlanRecipient {
  userId: number;
  zone: string;
}

export type NotificationKind = 'pre_due' | 'due' | 'overdue';

export interface PlannedNotification {
  kind: NotificationKind;
  recipientUserId: number;
  fireAt: Date;
  /** `task:{id}:v{version}:{kind}:{recipient}:{fire_date}` (D6) — the version guards against a same-day due-date
   * edit colliding with an already-sent reminder for the previous due instant. */
  dedupeKey: string;
}

/** The subset of a task row this module needs — see `src/domain/tasks/repo.ts` for the full row. */
export interface TaskForPlanning {
  id: number;
  version: number;
  dueAt: Date | null;
  dueAllDay: boolean;
  dueTz: string | null;
  status: string;
}

const CLOSED_STATUSES = new Set(['done', 'cancelled']);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Sets `dt`'s clock-of-day to an `HH:mm` string (zod-validated by `RemindersSchema`). */
function atTime(dt: DateTime, time: string): DateTime {
  const [hourStr, minuteStr] = time.split(':');
  return dt.set({ hour: Number(hourStr ?? 0), minute: Number(minuteStr ?? 0), second: 0, millisecond: 0 });
}

/** Midnight of `dt`'s calendar date, re-anchored in `zone` — a calendar date is zone-agnostic once extracted,
 * so this lets a date read in one zone (e.g. `task.dueTz`) drive reminder times computed in another (the
 * recipient's). */
function dateAnchor(dt: DateTime, zone: string): DateTime {
  return DateTime.fromObject({ year: dt.year, month: dt.month, day: dt.day }, { zone });
}

/** Earliest `time`-of-day instant (in `zone`) strictly after `after`. */
function earliestTimeStrictlyAfter(zone: string, time: string, after: Date): DateTime {
  let day = dateAnchor(DateTime.fromJSDate(after, { zone }), zone);
  let candidate = atTime(day, time);
  while (candidate.toMillis() <= after.getTime()) {
    day = day.plus({ days: 1 });
    candidate = atTime(day, time);
  }
  return candidate;
}

function dedupeKey(
  task: TaskForPlanning,
  kind: NotificationKind,
  recipient: PlanRecipient,
  fireAt: DateTime,
): string {
  const fireDate = fireAt.setZone(recipient.zone).toISODate();
  return `task:${task.id}:v${task.version}:${kind}:${recipient.userId}:${fireDate}`;
}

function toNotification(
  task: TaskForPlanning,
  kind: NotificationKind,
  recipient: PlanRecipient,
  fireAt: DateTime,
): PlannedNotification {
  return {
    kind,
    recipientUserId: recipient.userId,
    fireAt: fireAt.toJSDate(),
    dedupeKey: dedupeKey(task, kind, recipient, fireAt),
  };
}

/**
 * Plans the full reminder set for one recipient. `pre_due`/`due` are dropped
 * once their instant is already in the past (D7 — "never schedules in the
 * past"). For a datetime due, `pre_due` additionally requires `dueAt - now`
 * to be strictly more than 24h (D8, SPEC §13.2) — the "day before due date"
 * candidate can otherwise still be in the future while due itself is under
 * 24h away (e.g. a due time earlier in the day than `preDueTime`). All-day
 * due has no such 24h rule (D8's row in plan.md scopes it to a due with a time, not all-day). `overdue` is
 * always in the future by construction, so it is never filtered.
 */
function planForRecipient(
  task: TaskForPlanning,
  recipient: PlanRecipient,
  reminders: Settings['reminders'],
  now: Date,
): PlannedNotification[] {
  if (task.dueAt === null || CLOSED_STATUSES.has(task.status)) return [];
  const dueAt = task.dueAt;

  // All-day: the calendar date is read in `task.dueTz` (falling back to the recipient's zone) — it is a
  // business date (e.g. a school deadline), independent of who is being reminded. Datetime due: there is no
  // separate "calendar date" concept, only the exact instant, so the day anchor used for `pre_due` is simply
  // that instant's date as seen in the recipient's own zone.
  const dateZone = task.dueAllDay ? (task.dueTz ?? recipient.zone) : recipient.zone;
  const dueDateAnchor = dateAnchor(DateTime.fromJSDate(dueAt, { zone: dateZone }), recipient.zone);

  const result: PlannedNotification[] = [];

  const preDueAt = atTime(dueDateAnchor.minus({ days: 1 }), reminders.preDueTime);
  const preDueMoreThan24hOut = task.dueAllDay || dueAt.getTime() - now.getTime() > ONE_DAY_MS;
  if (preDueMoreThan24hOut && preDueAt.toMillis() > now.getTime()) {
    result.push(toNotification(task, 'pre_due', recipient, preDueAt));
  }

  const dueNotificationAt = task.dueAllDay
    ? atTime(dueDateAnchor, reminders.allDayDueTime)
    : DateTime.fromJSDate(dueAt, { zone: recipient.zone });
  if (dueNotificationAt.toMillis() > now.getTime()) {
    result.push(toNotification(task, 'due', recipient, dueNotificationAt));
  }

  let overdueAt: DateTime;
  if (task.dueAllDay) {
    // Earliest `overdueTime` not earlier than the day after the due date, and strictly after `now`.
    let day = dueDateAnchor.plus({ days: 1 });
    let candidate = atTime(day, reminders.overdueTime);
    while (candidate.toMillis() <= now.getTime()) {
      day = day.plus({ days: 1 });
      candidate = atTime(day, reminders.overdueTime);
    }
    overdueAt = candidate;
  } else {
    // Earliest `overdueTime` strictly after `max(dueAt, now)` — may fall on the due date itself (SPEC §13.2).
    const base = dueAt.getTime() > now.getTime() ? dueAt : now;
    overdueAt = earliestTimeStrictlyAfter(recipient.zone, reminders.overdueTime, base);
  }
  result.push(toNotification(task, 'overdue', recipient, overdueAt));

  return result;
}

export function planTaskNotifications(a: {
  task: TaskForPlanning;
  recipients: PlanRecipient[];
  reminders: Settings['reminders'];
  now: Date;
}): PlannedNotification[] {
  return a.recipients.flatMap((recipient) => planForRecipient(a.task, recipient, a.reminders, a.now));
}

/**
 * The next `overdue` reminder after one that was just sent — the link used to chain overdue reminders until
 * the task closes (Task 3.3). `null` once the task no longer has a due date or has been closed.
 */
export function nextOverdueAfter(a: {
  task: TaskForPlanning;
  recipient: PlanRecipient;
  reminders: Settings['reminders'];
  after: Date;
}): PlannedNotification | null {
  if (a.task.dueAt === null || CLOSED_STATUSES.has(a.task.status)) return null;
  const fireAt = earliestTimeStrictlyAfter(a.recipient.zone, a.reminders.overdueTime, a.after);
  return toNotification(a.task, 'overdue', a.recipient, fireAt);
}
