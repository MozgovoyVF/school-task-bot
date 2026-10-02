import type { Buttons } from '../../domain/messenger.js';
import type { TaskListItem } from '../../domain/tasks/queries.js';
import { TELEGRAM_TEXT_LIMIT } from '../../config/constants.js';
import { formatDue } from '../../time/format.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';
import { escapeHtml } from './escape.js';

/** `notifyJob`'s own send kinds (plan.md Task 3.3) — `summary` is rendered separately by Task 3.5, never
 * through this view. */
export type ReminderKind = 'pre_due' | 'due' | 'overdue' | 'snooze';

export interface ReminderRender {
  text: string;
  buttons: Buttons;
}

function headerFor(kind: ReminderKind): string {
  switch (kind) {
    case 'pre_due':
      return texts.reminders.preDueHeader;
    case 'due':
      return texts.reminders.dueHeader;
    case 'overdue':
      return texts.reminders.overdueHeader;
    case 'snooze':
      return texts.reminders.snoozeHeader;
  }
}

function assigneeLabel(name: string | null): string {
  return name === null ? texts.proposalCard.assigneeNone : escapeHtml(name);
}

function dueLine(task: TaskListItem, viewerZone: string): string {
  const due = task.dueAt === null ? null : { at: task.dueAt, allDay: task.dueAllDay, tz: task.dueTz };
  return texts.formatDue(formatDue(due, viewerZone));
}

/** SPEC §13.3's fixed four-button row — `id` is always the task's own id (never the notification row's),
 * since all four actions operate on the task; `src/bot/handlers/reminderCallbacks.ts` (Task 3.4) checks the
 * pressing user's permission itself rather than trusting anything from the callback payload. */
function buttonsFor(taskId: number): Buttons {
  return [
    [
      { text: texts.reminders.doneButton, data: encodeCallback({ entity: 'n', action: 'done', id: taskId }) },
      {
        text: texts.reminders.plusHourButton,
        data: encodeCallback({ entity: 'n', action: 'hour', id: taskId }),
      },
      {
        text: texts.reminders.tomorrowButton,
        data: encodeCallback({ entity: 'n', action: 'tmrw', id: taskId }),
      },
      {
        text: texts.reminders.pickTimeButton,
        data: encodeCallback({ entity: 'n', action: 'pick', id: taskId }),
      },
    ],
  ];
}

/** The reminder's own `pickTimeButton` row (`texts.reminders`) opens this submenu (plan.md Task 3.4,
 * SPEC §13.3): three fixed-option buttons
 * (`snz`, with `arg` one of `'3h'`/`'today18'`/`'dayafter'` — `src/domain/notifications/snooze.ts`'s
 * `SnoozeOption`) plus the free-text entry button (`inp`, no `arg` — enters `src/bot/conversations/
 * snoozeInput.ts`'s conversation). `taskId` is always the task's own id, same as `buttonsFor` above. */
export function renderSnoozeMenu(taskId: number): ReminderRender {
  const b = (text: string, action: string, arg?: string): Buttons[number][number] => ({
    text,
    data: encodeCallback({ entity: 'n', action, id: taskId, ...(arg !== undefined ? { arg } : {}) }),
  });

  return {
    text: texts.reminders.pickMenuTitle,
    buttons: [
      [b(texts.reminders.pick3hButton, 'snz', '3h'), b(texts.reminders.pickToday18Button, 'snz', 'today18')],
      [b(texts.reminders.pickDayAfterButton, 'snz', 'dayafter')],
      [b(texts.reminders.pickEnterButton, 'inp')],
    ],
  };
}

/**
 * Pure render for one reminder DM (SPEC §13.2/§13.3, Task 3.3). No DB, no I/O (CLAUDE.md §7) — the caller
 * (`notifyJob`) resolves `v.task`/`v.viewerZone` beforehand.
 */
export function renderReminder(v: {
  kind: ReminderKind;
  task: TaskListItem;
  viewerZone: string;
}): ReminderRender {
  const lines = [
    headerFor(v.kind),
    texts.reminders.titleLine(escapeHtml(v.task.title)),
    texts.reminders.metaLine(assigneeLabel(v.task.assigneeName), dueLine(v.task, v.viewerZone)),
  ];
  return { text: lines.join('\n'), buttons: buttonsFor(v.task.id) };
}

/**
 * The grouped-overdue digest (SPEC §13.2: 3+ simultaneous `overdue` reminders for the Owner become one
 * list message instead of individual ones): one line per task, no buttons — acting on an individual task
 * from here would need one button row per task, so the Owner goes through `/tasks` instead.
 *
 * `notifyJob` groups up to its own 50-row batch limit into one digest, and each title can be up to
 * `TASK_TITLE_MAX_CHARS` long — well past Telegram's `TELEGRAM_TEXT_LIMIT` (4096, CLAUDE.md) for a large
 * backlog. Rows are added one at a time, always leaving room for a trailing `overdueDigestMore(N)` footer
 * (review round 1, I4) the moment a row would no longer fit; the footer itself is only appended if the list
 * actually had to be cut short.
 */
export function renderOverdueDigest(items: TaskListItem[], viewerZone: string): ReminderRender {
  const lines = [texts.reminders.overdueDigestHeader(items.length)];
  let shown = 0;

  for (const task of items) {
    const line = texts.reminders.overdueDigestLine(
      task.id,
      escapeHtml(task.title),
      dueLine(task, viewerZone),
    );
    const remainingAfterThis = items.length - shown - 1;
    const footerReserve =
      remainingAfterThis > 0 ? texts.reminders.overdueDigestMore(remainingAfterThis).length + 1 : 0;
    const lengthWithThisLine = lines.join('\n').length + 1 + line.length + footerReserve;
    if (lengthWithThisLine > TELEGRAM_TEXT_LIMIT) break;
    lines.push(line);
    shown += 1;
  }

  if (shown < items.length) lines.push(texts.reminders.overdueDigestMore(items.length - shown));

  return { text: lines.join('\n'), buttons: [] };
}
