import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Tx } from '../../db/client.js';
import { notifications } from '../../db/schema/index.js';
import type { Settings } from '../settings/schema.js';

/**
 * SPEC §13.3's snooze options (plan.md Task 3.4): the reminder's own `plusHourButton`/`tomorrowButton`
 * (`texts.reminders`) map to `'1h'`/`'tomorrow'`; the `pickTimeButton` submenu's own three buttons map to
 * `'3h'`/`'today18'`/`'dayafter'` (`src/bot/handlers/reminderCallbacks.ts`'s own `callback_data` scheme for
 * that submenu — not specified by the brief). A snooze never changes the task's own due date (SPEC §13.3:
 * changing the due date itself goes through the task's edit flow instead) — it only schedules one extra
 * `kind='snooze'` notification for the pressing recipient.
 */
export const SnoozeOptionSchema = z.enum(['1h', 'tomorrow', '3h', 'today18', 'dayafter']);
export type SnoozeOption = z.infer<typeof SnoozeOptionSchema>;

/** `dt`, re-anchored to `time`'s (`HH:mm`, zod-validated by `RemindersSchema`) clock-of-day — mirrors
 * `src/domain/notifications/plan.ts`'s own private `atTime` helper (not exported from there). */
function atTime(dt: DateTime, time: string): DateTime {
  const [hourStr, minuteStr] = time.split(':');
  return dt.set({ hour: Number(hourStr ?? 0), minute: Number(minuteStr ?? 0), second: 0, millisecond: 0 });
}

// Exhaustiveness guard: a new `SnoozeOption` variant that isn't handled below fails to compile here
// (mirrors `src/domain/people/permissions.ts`'s own `assertNever`).
function assertNever(option: never): never {
  throw new Error(`snoozeFireAt: unhandled option ${String(option)}`);
}

/**
 * Resolves one snooze option to a concrete fire instant, in `zone` at `now` (plan.md Task 3.4, SPEC §13.3).
 * `'1h'`/`'3h'` are always applicable (purely relative to `now`). `'tomorrow'`/`'dayafter'` land the next
 * day / the day after next at `reminders.preDueTime` (the app's one existing "default reminder hour", also
 * what `src/domain/notifications/plan.ts` uses for its own day-before-due reminder) — SPEC §13.3's
 * `tomorrowButton` labeled "10:00" is that same convention, not a separate hardcoded literal. `'today18'`
 * is the one option
 * that can already be unreachable: if 18:00 today has already passed (strictly not after `now`), there is no
 * sensible same-day instant left for it and this returns `null` instead of silently scheduling it for
 * yesterday or jumping a day ahead on its own — the caller (`reminderCallbacks.ts`) surfaces that as "this
 * option is no longer available" rather than guessing (CLAUDE.md: a wrong guess is worse than asking again).
 */
export function snoozeFireAt(
  option: SnoozeOption,
  now: Date,
  zone: string,
  reminders: Settings['reminders'],
): Date | null {
  const nowZoned = DateTime.fromJSDate(now, { zone });

  switch (option) {
    case '1h':
      return nowZoned.plus({ hours: 1 }).toJSDate();
    case '3h':
      return nowZoned.plus({ hours: 3 }).toJSDate();
    case 'tomorrow':
      return atTime(nowZoned.plus({ days: 1 }), reminders.preDueTime).toJSDate();
    case 'dayafter':
      return atTime(nowZoned.plus({ days: 2 }), reminders.preDueTime).toJSDate();
    case 'today18': {
      const candidate = nowZoned.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
      return candidate.toMillis() > nowZoned.toMillis() ? candidate.toJSDate() : null;
    }
    default:
      return assertNever(option);
  }
}

export interface CreateSnoozeInput {
  taskId: number;
  recipientUserId: number;
  fireAt: Date;
  workspaceId: number;
}

/**
 * Inserts one `kind='snooze'` notification row directly (plan.md Task 3.4) — unlike every other
 * notification kind, a snooze does not go through `TaskService`/`remindersHook`
 * (`src/domain/notifications/schedule.ts`): it never changes the task itself (SPEC §13.3), so there is
 * nothing for that hook to recompute. `dedupeKey` follows the same `snooze:{task}:{recipient}:{fireAtISO}`
 * shape `src/scheduler/jobs/notify.ts`'s own doc comments already describe; `onConflictDoNothing` makes a
 * repeat press that resolves to the exact same instant (same task, same recipient, same millisecond) a
 * harmless no-op instead of a unique-constraint error, the same idempotency convention every other
 * notification insert in this codebase (`schedule.ts`, `notify.ts`) already follows.
 */
export async function createSnooze(tx: Tx, input: CreateSnoozeInput): Promise<void> {
  const dedupeKey = `snooze:${String(input.taskId)}:${String(input.recipientUserId)}:${input.fireAt.toISOString()}`;

  await tx
    .insert(notifications)
    .values({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      recipientUserId: input.recipientUserId,
      kind: 'snooze',
      fireAt: input.fireAt,
      dedupeKey,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey });
}
