/**
 * Renders `/tasks`/`/today`/`/overdue`/`/archive`'s task lists, the assignee/chat picker submenus they
 * link to, and `rowMarker` (plan.md Task 3.7, SPEC §12.3, D24). Pure functions: no DB, no I/O, no grammY
 * (CLAUDE.md §7) — the caller (`src/bot/handlers/lists.ts`) resolves `listTasks`'s own `ListTasksResult`
 * (and, for the assignee/chat filters, the already-escaped header `label`) beforehand.
 */
import type { Buttons } from '../../domain/messenger.js';
import {
  dueBucket,
  type ListFilter,
  type ListTasksResult,
  type TaskListItem,
} from '../../domain/tasks/queries.js';
import { formatDateLabel } from '../../time/format.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';
import { escapeHtml } from './escape.js';

export interface TaskListRender {
  text: string;
  buttons: Buttons;
}

/**
 * A list row's marker (D24): overdue is always 🔴, regardless of status — an in-progress task that's also
 * overdue stays red, since "it's late" outranks "someone's on it". Otherwise `in_progress` is 🔵, a due
 * date of today is 🟡, and anything later (or with no due date at all) is ⚪. Reuses
 * `src/domain/tasks/queries.ts`'s own {@link dueBucket} for the overdue/today/later classification rather
 * than reimplementing that date math here.
 */
export function rowMarker(item: TaskListItem, now: Date, zone: string): '🔴' | '🔵' | '🟡' | '⚪' {
  const bucket = dueBucket(item, now, zone);
  if (bucket === 'overdue') return '🔴';
  if (item.status === 'in_progress') return '🔵';
  if (bucket === 'today') return '🟡';
  return '⚪';
}

/** A row's own due column: no due date at all reads as `texts.taskList.noDueLabel`; an all-day due reads
 * its own calendar date in `item.dueTz ?? zone` (same business-date convention `dueBucket` itself uses),
 * a datetime due in the viewer's own `zone`. Deliberately never shows a time (SPEC §12.3's row sample is
 * date-only) — unlike `texts.formatDue`, which a task card/reminder uses for its own, more detailed line. */
function dueLabelForRow(item: TaskListItem, zone: string): string {
  if (item.dueAt === null) return texts.taskList.noDueLabel;
  const effectiveZone = item.dueAllDay ? (item.dueTz ?? zone) : zone;
  return formatDateLabel(item.dueAt, effectiveZone);
}

function assigneeLabel(name: string | null): string {
  return name === null ? texts.proposalCard.assigneeNone : escapeHtml(name);
}

function rowLine(item: TaskListItem, now: Date, zone: string): string {
  return texts.taskList.row(
    rowMarker(item, now, zone),
    item.id,
    escapeHtml(item.title),
    assigneeLabel(item.assigneeName),
    dueLabelForRow(item, zone),
  );
}

/** One row's own "open the card" button (`v1:l:opn:<taskId>`, `src/bot/handlers/lists.ts`) — the same
 * marker as the row's own text line, so the button visually matches the row it opens. */
function openButton(item: TaskListItem, now: Date, zone: string): Buttons[number][number] {
  return {
    text: `${rowMarker(item, now, zone)} T${String(item.id)}`,
    data: encodeCallback({ entity: 'l', action: 'opn', id: item.id }),
  };
}

function filterHeader(filter: ListFilter, label: string | undefined): string {
  switch (filter.kind) {
    case 'open':
      return texts.taskList.headerOpen;
    case 'today':
      return texts.taskList.headerToday;
    case 'overdue':
      return texts.taskList.headerOverdue;
    case 'no_due':
      return texts.taskList.headerNoDue;
    case 'today_and_overdue':
      return texts.taskList.headerTodayAndOverdue;
    case 'archive':
      return texts.taskList.headerArchive;
    case 'assignee':
      return texts.taskList.headerAssignee(label ?? '');
    case 'chat':
      return texts.taskList.headerChat(label ?? '');
  }
}

/** `{ action, arg }` for `filter` — the callback half of `v1:l:<f>:<page>[:<arg>]` (the brief's own
 * scheme), reused by both the pagination row and (indirectly, via `src/bot/handlers/lists.ts` applying a
 * freshly-picked `arg`) the assignee/chat pickers below. */
function filterAction(filter: ListFilter): { action: string; arg?: string } {
  switch (filter.kind) {
    case 'open':
      return { action: 'all' };
    case 'today':
      return { action: 'tod' };
    case 'overdue':
      return { action: 'ovd' };
    case 'no_due':
      return { action: 'nod' };
    case 'today_and_overdue':
      return { action: 'tov' };
    case 'archive':
      return { action: 'arc' };
    case 'assignee':
      return { action: 'asg', arg: String(filter.userId) };
    case 'chat':
      return { action: 'cht', arg: String(filter.chatId) };
  }
}

function filterCallback(filter: ListFilter, page: number): string {
  const { action, arg } = filterAction(filter);
  return encodeCallback({ entity: 'l', action, id: page, ...(arg !== undefined ? { arg } : {}) });
}

function paginationRow(filter: ListFilter, page: number, pages: number): Buttons[number] {
  const row: Buttons[number] = [];
  if (page > 1) row.push({ text: texts.taskList.prevButton, data: filterCallback(filter, page - 1) });
  if (page < pages) row.push({ text: texts.taskList.nextButton, data: filterCallback(filter, page + 1) });
  return row;
}

/** The filter-switcher rows every list screen ends with (SPEC §12.3's six buttons minus the removed
 * "awaiting review" one, D40) — always resets to page 1 on switch, and is shown regardless of which filter is
 * currently active, so the Owner can pivot from any screen (including `/archive`/`/today`) without typing
 * a fresh command. `asm`/`csm` (assignee/chat submenu) open {@link renderAssigneePicker}/
 * {@link renderChatPicker} below rather than applying a filter directly.
 */
function filterSwitchRows(): Buttons {
  return [
    [
      { text: texts.taskList.filterAllButton, data: encodeCallback({ entity: 'l', action: 'all', id: 1 }) },
      { text: texts.taskList.filterTodayButton, data: encodeCallback({ entity: 'l', action: 'tod', id: 1 }) },
    ],
    [
      {
        text: texts.taskList.filterOverdueButton,
        data: encodeCallback({ entity: 'l', action: 'ovd', id: 1 }),
      },
      { text: texts.taskList.filterNoDueButton, data: encodeCallback({ entity: 'l', action: 'nod', id: 1 }) },
    ],
    [
      {
        text: texts.taskList.filterAssigneeButton,
        data: encodeCallback({ entity: 'l', action: 'asm', id: 1 }),
      },
      { text: texts.taskList.filterChatButton, data: encodeCallback({ entity: 'l', action: 'csm', id: 1 }) },
    ],
  ];
}

export interface TaskListArgs {
  filter: ListFilter;
  /** 1-indexed, already clamped into `[1, r.pages]` by `listTasks` — passed through unchanged for the
   * footer/pagination row. */
  page: number;
  zone: string;
  now: Date;
  /** Already-HTML-escaped assignee display name / chat title — only read for `filter.kind ===
   * 'assignee' | 'chat'`'s own header line; every other kind ignores it. */
  label?: string;
}

/**
 * Pure render for one `/tasks`-family page (plan.md Task 3.7, SPEC §12.3): a header line, one text row
 * per task plus its own "open card" button, a page-count footer (`texts.taskList.pageFooter`), a
 * prev/next row (only the sides that have another page), and the filter-switcher rows. `r.items` is
 * already this page's slice (`listTasks`) — this function does no further slicing.
 */
export function renderTaskList(r: ListTasksResult, args: TaskListArgs): TaskListRender {
  const { filter, page, zone, now, label } = args;
  const header = filterHeader(filter, label);

  if (r.items.length === 0) {
    return { text: [header, texts.taskList.empty].join('\n'), buttons: filterSwitchRows() };
  }

  const text = [
    header,
    '',
    ...r.items.map((item) => rowLine(item, now, zone)),
    '',
    texts.taskList.pageFooter(page, r.pages),
  ].join('\n');

  const rowButtons: Buttons = r.items.map((item) => [openButton(item, now, zone)]);
  const navRow = paginationRow(filter, page, r.pages);

  return {
    text,
    buttons: [...rowButtons, ...(navRow.length > 0 ? [navRow] : []), ...filterSwitchRows()],
  };
}

export interface AssigneeOption {
  userId: number;
  /** Plain (unescaped) display name — Telegram button text isn't HTML-parsed (CLAUDE.md's `escapeHtml`
   * rule is for `parse_mode: 'HTML'` message bodies only), same convention `texts.people`'s own member
   * buttons already use. */
  name: string;
}

/** The "assignee" filter submenu (`texts.taskList.filterAssigneeButton`, `v1:l:asm:*` opens this,
 * `src/bot/handlers/lists.ts`): "assigned to everyone"/"unassigned" (reusing `texts.proposalCard`'s own
 * wording for those two, rather than introducing new synonyms) plus one button per workspace member, each
 * applying `{ kind: 'assignee', userId }` at page 1. */
export function renderAssigneePicker(options: readonly AssigneeOption[]): TaskListRender {
  const buttons: Buttons = [
    [
      {
        text: texts.proposalCard.assigneeAll,
        data: encodeCallback({ entity: 'l', action: 'asg', id: 1, arg: 'all' }),
      },
    ],
    [
      {
        text: texts.proposalCard.assigneeNone,
        data: encodeCallback({ entity: 'l', action: 'asg', id: 1, arg: 'none' }),
      },
    ],
    ...options.map((o): Buttons[number] => [
      {
        text: o.name,
        data: encodeCallback({ entity: 'l', action: 'asg', id: 1, arg: String(o.userId) }),
      },
    ]),
    [{ text: texts.taskList.backButton, data: encodeCallback({ entity: 'l', action: 'all', id: 1 }) }],
  ];
  return { text: texts.taskList.assigneeMenuHeader, buttons };
}

export interface ChatOption {
  chatId: number;
  /** Plain (unescaped) chat title — same button-text convention as {@link AssigneeOption.name}. */
  title: string;
}

/** The "chat" filter submenu (`texts.taskList.filterChatButton`, `v1:l:csm:*` opens this) — one button per
 * workspace chat, each applying `{ kind: 'chat', chatId }` at page 1. */
export function renderChatPicker(options: readonly ChatOption[]): TaskListRender {
  if (options.length === 0) {
    return {
      text: [texts.taskList.chatMenuHeader, texts.taskList.chatMenuEmpty].join('\n'),
      buttons: [
        [{ text: texts.taskList.backButton, data: encodeCallback({ entity: 'l', action: 'all', id: 1 }) }],
      ],
    };
  }

  const buttons: Buttons = [
    ...options.map((o): Buttons[number] => [
      {
        text: o.title,
        data: encodeCallback({ entity: 'l', action: 'cht', id: 1, arg: String(o.chatId) }),
      },
    ]),
    [{ text: texts.taskList.backButton, data: encodeCallback({ entity: 'l', action: 'all', id: 1 }) }],
  ];
  return { text: texts.taskList.chatMenuHeader, buttons };
}
