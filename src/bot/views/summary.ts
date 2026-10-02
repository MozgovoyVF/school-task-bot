import type { Buttons } from '../../domain/messenger.js';
import type { SummarySections, TaskListItem } from '../../domain/tasks/queries.js';
import { TELEGRAM_TEXT_LIMIT } from '../../config/constants.js';
import { formatDateLabel, formatDue } from '../../time/format.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';
import { escapeHtml } from './escape.js';

export interface SummaryRender {
  text: string;
  buttons: Buttons;
}

function dueText(task: TaskListItem, zone: string): string {
  const due = task.dueAt === null ? null : { at: task.dueAt, allDay: task.dueAllDay, tz: task.dueTz };
  return texts.formatDue(formatDue(due, zone));
}

/** One overdue/today item line — same `• T{id} «title» — due` shape as `renderOverdueDigest`'s own
 * `overdueDigestLine` (`src/bot/views/reminder.ts`), reused here rather than duplicated. */
function dueSectionLine(task: TaskListItem, zone: string): string {
  return texts.reminders.overdueDigestLine(task.id, escapeHtml(task.title), dueText(task, zone));
}

function noDueSectionLine(task: TaskListItem): string {
  return texts.summary.noDueItemLine(task.id, escapeHtml(task.title));
}

/**
 * Greedily fits as many of `items`' rendered lines as `subBudget` chars allow (the incremental,
 * reserve-the-footer technique `src/bot/views/reminder.ts`'s `renderOverdueDigest` already uses for its
 * own single list), always leaving room for a trailing `sectionMore` footer the moment a row would no
 * longer fit. `subBudget` is this section's own share of the message's overall 4096-char budget
 * (`renderSummary` below splits what's left after every other, non-droppable line) — the returned lines'
 * own `join('\n').length` never exceeds it.
 */
function fitSectionItems(items: readonly TaskListItem[], subBudget: number, zone: string): string[] {
  const lines: string[] = [];
  let shown = 0;

  for (const task of items) {
    const line = dueSectionLine(task, zone);
    const remainingAfterThis = items.length - shown - 1;
    const footerReserve =
      remainingAfterThis > 0 ? texts.summary.sectionMore(remainingAfterThis).length + 1 : 0;
    const candidateLen = [...lines, line].join('\n').length + footerReserve;
    if (candidateLen > subBudget) break;
    lines.push(line);
    shown += 1;
  }

  if (shown < items.length) lines.push(texts.summary.sectionMore(items.length - shown));
  return lines;
}

function buttonsRow(): Buttons {
  return [
    [
      { text: texts.summary.allTasksButton, data: encodeCallback({ entity: 'l', action: 'all', id: 0 }) },
      // `v1:p:nbx:0` — the exact same forward reference `src/scheduler/jobs/cards.ts`'s own
      // `openInboxButton` already uses: no handler exists yet for this button outside the quiet-hours
      // batch message, but it will, via the same `nbx` callback Task 2.15 wired up for that one.
      { text: texts.cards.openInboxButton, data: encodeCallback({ entity: 'p', action: 'nbx', id: 0 }) },
    ],
  ];
}

/**
 * Pure render for the morning summary (plan.md Task 3.5, SPEC §13.4). No DB, no I/O (CLAUDE.md §7) —
 * `src/scheduler/jobs/notify.ts` resolves `s` (via `summarySections`) and `args.zone` beforehand; `args.date`
 * is whatever instant the header's own date should be read in `args.zone` (`notifyJob` passes its own
 * `now`).
 *
 * Section order follows SPEC §13.4's mockup minus the "awaiting your review" section (D40, Member-only
 * review flow removed): overdue, today, unprocessed proposals, no-due. An empty section
 * (`items.length === 0` for overdue/today/noDue, `inboxCount === 0`)
 * is left out entirely; if every section is empty, the whole body becomes `texts.summary.allEmpty`.
 *
 * Telegram's 4096-char limit (CLAUDE.md, `TELEGRAM_TEXT_LIMIT`) is budgeted *across* every section, not
 * just one: every line that must always appear (both headers, the inbox line, and the no-due block — the
 * no-due block is already capped at 5 items by `summarySections` itself, so it never needs its own
 * truncation here) is counted first; whatever's left over is split between the overdue and today sections'
 * own item lists (evenly, when both are present), each fitted via {@link fitSectionItems}. This guarantees
 * the final text never exceeds the limit, however many tasks either section holds.
 */
export function renderSummary(s: SummarySections, args: { date: Date; zone: string }): SummaryRender {
  const { date, zone } = args;
  const headerLine = texts.summary.header(formatDateLabel(date, zone));
  const buttons = buttonsRow();

  const isEmpty =
    s.overdue.length === 0 && s.today.length === 0 && s.inboxCount === 0 && s.noDue.length === 0;
  if (isEmpty) {
    return { text: [headerLine, texts.summary.allEmpty].join('\n'), buttons };
  }

  const overdueHeaderLine = s.overdue.length > 0 ? texts.summary.overdueHeader(s.overdue.length) : null;
  const todayHeaderLine = s.today.length > 0 ? texts.summary.todayHeader(s.today.length) : null;
  const inboxLine = s.inboxCount > 0 ? texts.summary.inboxLine(s.inboxCount) : null;

  const noDueBlock: string[] = [];
  if (s.noDue.length > 0) {
    noDueBlock.push(texts.summary.noDueHeader(s.noDueTotal));
    for (const task of s.noDue) noDueBlock.push(noDueSectionLine(task));
    if (s.noDueTotal > s.noDue.length)
      noDueBlock.push(texts.summary.sectionMore(s.noDueTotal - s.noDue.length));
  }

  const mandatoryLines = [headerLine, overdueHeaderLine, todayHeaderLine, inboxLine, ...noDueBlock].filter(
    (line): line is string => line !== null,
  );
  const leftover = Math.max(0, TELEGRAM_TEXT_LIMIT - mandatoryLines.join('\n').length);

  let overdueShare = 0;
  let todayShare = 0;
  if (overdueHeaderLine !== null && todayHeaderLine !== null) {
    overdueShare = Math.floor(leftover / 2);
    todayShare = leftover - overdueShare;
  } else if (overdueHeaderLine !== null) {
    overdueShare = leftover;
  } else if (todayHeaderLine !== null) {
    todayShare = leftover;
  }

  // `- 1` reserves the newline that will connect this section's first item line to its own header.
  const overdueItemLines =
    overdueHeaderLine !== null ? fitSectionItems(s.overdue, Math.max(0, overdueShare - 1), zone) : [];
  const todayItemLines =
    todayHeaderLine !== null ? fitSectionItems(s.today, Math.max(0, todayShare - 1), zone) : [];

  const lines: string[] = [headerLine];
  if (overdueHeaderLine !== null) lines.push(overdueHeaderLine, ...overdueItemLines);
  if (todayHeaderLine !== null) lines.push(todayHeaderLine, ...todayItemLines);
  if (inboxLine !== null) lines.push(inboxLine);
  lines.push(...noDueBlock);

  return { text: lines.join('\n'), buttons };
}
