/**
 * Renders the Owner's task card (`src/bot/handlers/taskCallbacks.ts`, plan.md Task 3.6, SPEC §12.4). Pure
 * function: no DB, no I/O, no grammY (CLAUDE.md §7) — the caller (`taskCallbacks.ts`) resolves every
 * id/name/quote/link beforehand (`src/domain/tasks/queries.ts`'s `getTaskCardData`).
 */
import type { Buttons } from '../../domain/messenger.js';
import { QUOTE_MAX_CHARS, TELEGRAM_TEXT_LIMIT } from '../../config/constants.js';
import { formatDue } from '../../time/format.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';
import { escapeHtml } from './escape.js';

export type TaskCardStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export type TaskCardPriority = 'low' | 'normal' | 'high';

export interface TaskCardView {
  id: number;
  title: string;
  description: string | null;
  status: TaskCardStatus;
  priority: TaskCardPriority;
  assigneeName: string | null;
  due: { at: Date; allDay: boolean; tz: string | null } | null;
  /** `tasks.source_quote` — already truncated to `QUOTE_MAX_CHARS` at write time
   * (`TaskService.create`/`src/config/constants.ts`), truncated again here defensively, same stance as
   * `src/bot/views/proposalCard.ts`'s own `truncateQuote`. */
  quote: string | null;
  chatTitle: string | null;
  /** `tasks.source_link` — already a full `https://t.me/c/...` URL (or `null`), computed once at task
   * creation (`TaskService.create`'s `CreateTaskInput.source.link`); unlike `proposalCard.ts`, this view
   * never recomputes it. */
  link: string | null;
}

export interface TaskCardRender {
  text: string;
  buttons: Buttons;
}

const STATUS_LABEL: Record<TaskCardStatus, string> = {
  open: texts.taskCard.statusOpen,
  in_progress: texts.taskCard.statusInProgress,
  done: texts.taskCard.statusDone,
  cancelled: texts.taskCard.statusCancelled,
};

const PRIORITY_LABEL: Record<TaskCardPriority, string> = {
  low: texts.proposalCard.priorityLow,
  normal: texts.proposalCard.priorityNormal,
  high: texts.proposalCard.priorityHigh,
};

/** SPEC §11.1's own quote-truncation stance, reused verbatim (`proposalCard.ts`'s `truncateQuote`): cut
 * **before** escaping, never after (escaping can only grow the string). */
function truncateQuote(quote: string): string {
  return quote.length > QUOTE_MAX_CHARS ? `${quote.slice(0, QUOTE_MAX_CHARS)}…` : quote;
}

function assigneeLabel(name: string | null): string {
  return name === null ? texts.proposalCard.assigneeNone : escapeHtml(name);
}

/** `done`/`cancelled` — SPEC §12.4's "archive" (its own "delete forever" button is archive-only), `/archive`'s own
 * two statuses. */
function isArchived(status: TaskCardStatus): boolean {
  return status === 'done' || status === 'cancelled';
}

function button(taskId: number, text: string, action: string, arg?: string): Buttons[number][number] {
  return {
    text,
    data: encodeCallback({ entity: 't', action, id: taskId, ...(arg !== undefined ? { arg } : {}) }),
  };
}

/**
 * The card's own buttons (SPEC §12.4): an active (`open`/`in_progress`) task gets the full management row
 * set; the "start" button is only shown for `open` (already redundant once the task is `in_progress`). An
 * archived task (`done`/`cancelled`) instead gets "restore"/"delete forever" — none of the
 * active-task actions make sense on a closed task. The "snooze" button reuses Task 3.4's existing snooze
 * picker directly (`entity: 'n', action: 'pick'`, `src/bot/handlers/reminderCallbacks.ts`) rather than a
 * parallel UI — same callback a reminder DM's own "pick time" button emits.
 */
function buttonsFor(view: TaskCardView): Buttons {
  const id = view.id;

  if (isArchived(view.status)) {
    return [
      [
        button(id, texts.taskCard.restoreButton, 'rst'),
        button(id, texts.taskCard.deleteForeverButton, 'del'),
      ],
      [button(id, texts.taskCard.historyButton, 'his')],
    ];
  }

  const firstRow: Buttons[number] = [button(id, texts.taskCard.doneButton, 'don')];
  if (view.status === 'open') firstRow.push(button(id, texts.taskCard.startButton, 'prg'));

  return [
    firstRow,
    [
      button(id, texts.taskCard.editButton, 'edt'),
      { text: texts.taskCard.snoozeButton, data: encodeCallback({ entity: 'n', action: 'pick', id }) },
    ],
    [button(id, texts.taskCard.cancelButton, 'cnl'), button(id, texts.taskCard.historyButton, 'his')],
  ];
}

/**
 * Pure render for a task card (SPEC §12.4). `text.slice(0, TELEGRAM_TEXT_LIMIT)` is the same defensive
 * backstop `proposalCard.ts` uses — with the title capped at `TASK_TITLE_MAX_CHARS` and the quote at
 * `QUOTE_MAX_CHARS` upstream, a card never actually approaches Telegram's 4096-char limit.
 */
export function renderTaskCard(view: TaskCardView, viewerZone: string): TaskCardRender {
  const lines = [
    texts.taskCard.titleLine(view.id, escapeHtml(view.title)),
    texts.taskCard.statusLine(STATUS_LABEL[view.status], PRIORITY_LABEL[view.priority]),
    texts.reminders.metaLine(
      assigneeLabel(view.assigneeName),
      texts.formatDue(formatDue(view.due, viewerZone)),
    ),
  ];

  if (view.description !== null && view.description !== '') {
    lines.push(texts.taskCard.descriptionLine(escapeHtml(view.description)));
  }

  if (view.quote !== null) {
    const quote = escapeHtml(truncateQuote(view.quote));
    const chatTitle = view.chatTitle === null ? null : escapeHtml(view.chatTitle);
    lines.push(texts.proposalCard.quoteLine(quote, null, chatTitle));
  }

  if (view.link !== null) lines.push(texts.proposalCard.linkLine(escapeHtml(view.link)));

  return {
    text: lines.join('\n').slice(0, TELEGRAM_TEXT_LIMIT),
    buttons: buttonsFor(view),
  };
}
