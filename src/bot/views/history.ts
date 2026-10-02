/**
 * Renders the task card's history screen (`src/bot/handlers/taskCallbacks.ts`, plan.md Task 3.6,
 * SPEC §12.4's "every change is written to task_events"). Pure function: no DB, no I/O, no grammY
 * (CLAUDE.md §7) — the caller resolves every event's actor display name and orders/caps the list (last 20,
 * newest first — `src/domain/tasks/events.ts`'s `listTaskEvents`) beforehand.
 */
import type { Buttons } from '../../domain/messenger.js';
import { TELEGRAM_TEXT_LIMIT } from '../../config/constants.js';
import { formatDue } from '../../time/format.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';
import { escapeHtml } from './escape.js';

export interface TaskHistoryEventView {
  /** `task_events.type` — free text (`src/domain/tasks/events.ts`'s doc comment); unrecognized values fall
   * back to `texts.taskHistory.typeOther`. */
  type: string;
  /** Already resolved to its final display string by the caller (member display name for `actor_type ===
   * 'user'`, or one of `texts.taskHistory.actorSystem`/`.actorAi`/`.actorApple`/`.actorUnknownUser`
   * otherwise) and already HTML-escaped. */
  actorLabel: string;
  createdAt: Date;
}

export interface TaskHistoryRender {
  text: string;
  buttons: Buttons;
}

const TYPE_LABEL: Record<string, string> = {
  created: texts.taskHistory.typeCreated,
  updated: texts.taskHistory.typeUpdated,
  status_changed: texts.taskHistory.typeStatusChanged,
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? texts.taskHistory.typeOther(type);
}

/** `createdAt` is always a precise instant (never all-day, no zone of its own to compare against the
 * viewer's) — `formatDue`'s `tz: null` means its own zone-label logic never fires, so this always reads
 * as a plain "date, HH:mm" in `viewerZone`, with no zone-label suffix (an audit-log timestamp, not a
 * due date — CLAUDE.md's "time only via luxon" is honoured by going through `formatDue`/`clock`-sourced
 * `Date` values the caller already resolved, same as every other view in this codebase). */
function dateLabel(at: Date, viewerZone: string): string {
  return texts.formatDue(formatDue({ at, allDay: false, tz: null }, viewerZone));
}

/**
 * Pure render for the history screen (SPEC §12.4, Task 3.6 brief scenario 8: the last 20 events with
 * dates in the recipient's own zone). `events` is expected already capped/ordered by the caller — this never
 * re-slices it beyond Telegram's own 4096-char limit.
 */
export function renderTaskHistory(
  taskId: number,
  title: string,
  events: readonly TaskHistoryEventView[],
  viewerZone: string,
): TaskHistoryRender {
  const lines = [texts.taskHistory.header(taskId, escapeHtml(title))];

  if (events.length === 0) {
    lines.push(texts.taskHistory.empty);
  } else {
    for (const event of events) {
      lines.push(
        texts.taskHistory.line(
          dateLabel(event.createdAt, viewerZone),
          event.actorLabel,
          typeLabel(event.type),
        ),
      );
    }
  }

  return {
    text: lines.join('\n').slice(0, TELEGRAM_TEXT_LIMIT),
    buttons: [
      [{ text: texts.taskCard.backButton, data: encodeCallback({ entity: 't', action: 'bck', id: taskId }) }],
    ],
  };
}
