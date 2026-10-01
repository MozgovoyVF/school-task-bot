import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DbOrTx } from '../../db/client.js';
import { chats, memberships, tasks } from '../../db/schema/index.js';
import { PAGE_SIZE } from '../../config/constants.js';
import { texts } from '../../bot/texts/ru.js';
import { listPendingProposals } from '../proposals/queries.js';
import { getTaskById, type TaskRow } from './repo.js';

/**
 * A task's display-ready projection for reminders and lists (plan.md Task 3.3; Tasks 3.5 and 3.7 add their
 * own sections to this file). `assigneeName` is already resolved to its final display string — the
 * assignee's membership `displayName`, the task's free-text `assigneeNameText`, or
 * `texts.proposalCard.assigneeAll` (the "everyone" label) for `assigneeAll` — `null` means only
 * "unassigned" (mirrors `src/scheduler/jobs/cards.ts`'s `assigneeView`/`assigneeText` pair, which resolves
 * a proposal's assignee the same three ways for a card).
 */
export interface TaskListItem {
  id: number;
  title: string;
  assigneeName: string | null;
  dueAt: Date | null;
  dueAllDay: boolean;
  dueTz: string | null;
  status: string;
}

/** `task.assignee_user_id`'s display name — looked up via `memberships` (not `users`), since the display
 * name shown on cards/reminders is the per-workspace `displayName`, not the Telegram profile name. `null`
 * if the membership is somehow gone (should not happen under normal operation — a deleted member leaves the
 * task's `assignee_user_id` null too, SPEC's `ON DELETE SET NULL` — but this is read-only, so this stays a
 * graceful `null` rather than a throw). Exported for `src/bot/handlers/lists.ts` (Task 3.7) — its `assignee`
 * filter's header line resolves a specific `userId`'s display name the same way, rather than duplicating
 * this lookup. */
export async function resolveAssigneeDisplayName(
  db: DbOrTx,
  workspaceId: number,
  assigneeUserId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ displayName: memberships.displayName })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, assigneeUserId)))
    .limit(1);
  return row?.displayName ?? null;
}

/** Exported for `src/bot/handlers/taskCallbacks.ts` (plan.md Task 3.6) — its task-card builder resolves
 * the same three-way assignee display name {@link getTaskListItem} already resolves internally, rather
 * than duplicating this logic. */
export async function resolveAssigneeName(db: DbOrTx, task: TaskRow): Promise<string | null> {
  if (task.assigneeAll) return texts.proposalCard.assigneeAll;
  if (task.assigneeUserId !== null)
    return resolveAssigneeDisplayName(db, task.workspaceId, task.assigneeUserId);
  if (task.assigneeNameText !== null) return task.assigneeNameText;
  return null;
}

function toListItem(task: TaskRow, assigneeName: string | null): TaskListItem {
  return {
    id: task.id,
    title: task.title,
    assigneeName,
    dueAt: task.dueAt,
    dueAllDay: task.dueAllDay,
    dueTz: task.dueTz,
    status: task.status,
  };
}

/** `taskId` → its {@link TaskListItem} projection, or `null` if the task no longer exists. */
export async function getTaskListItem(db: DbOrTx, taskId: number): Promise<TaskListItem | null> {
  const task = await getTaskById(db, taskId);
  if (task === null) return null;
  const assigneeName = await resolveAssigneeName(db, task);
  return toListItem(task, assigneeName);
}

/** The task card's own data (plan.md Task 3.6, SPEC §12.4) — the raw {@link TaskRow} plus the two
 * display-ready fields the card needs that aren't columns on it directly: the resolved assignee name
 * (same three-way resolution as {@link getTaskListItem}) and the source chat's title (`tasks.sourceChatId`
 * → `chats.title`, `null` for a DM-created task or one whose chat has since been deleted —
 * `sourceChatId`'s own `ON DELETE SET NULL`, same graceful-`null` stance as `resolveAssigneeDisplayName`
 * above). `tasks.sourceQuote`/`sourceLink` are already plain columns on the row itself, set once by
 * `TaskService.create` — no further resolution needed for those two. `null` if the task no longer exists. */
export interface TaskCardData {
  task: TaskRow;
  assigneeName: string | null;
  chatTitle: string | null;
}

export async function getTaskCardData(db: DbOrTx, taskId: number): Promise<TaskCardData | null> {
  const task = await getTaskById(db, taskId);
  if (task === null) return null;
  const assigneeName = await resolveAssigneeName(db, task);
  let chatTitle: string | null = null;
  if (task.sourceChatId !== null) {
    const [chatRow] = await db
      .select({ title: chats.title })
      .from(chats)
      .where(eq(chats.id, task.sourceChatId))
      .limit(1);
    chatTitle = chatRow?.title ?? null;
  }
  return { task, assigneeName, chatTitle };
}

async function toListItems(db: DbOrTx, rows: readonly TaskRow[]): Promise<TaskListItem[]> {
  const items: TaskListItem[] = [];
  for (const task of rows) {
    // Sequential, not `Promise.all` — `db` may be a transaction (`notifyJob`'s own `tx`), and a single
    // Postgres connection cannot run overlapping queries.
    const assigneeName = await resolveAssigneeName(db, task);
    items.push(toListItem(task, assigneeName));
  }
  return items;
}

const OPEN_STATUSES = ['open', 'in_progress'] as const;

/** Top-N cap for the morning summary's no-due-date section (SPEC §13.4: "top 5 oldest"). */
const SUMMARY_NO_DUE_TOP_N = 5;

/** The morning summary's own sections (plan.md Task 3.5, SPEC §13.4's mockup, D40 — no "awaiting your
 * review" section, since the review flow is Member-only and was removed). */
export interface SummarySections {
  overdue: TaskListItem[];
  today: TaskListItem[];
  inboxCount: number;
  /** Oldest-created-first, capped at {@link SUMMARY_NO_DUE_TOP_N}; `noDueTotal` is the full count. */
  noDue: TaskListItem[];
  noDueTotal: number;
}

/** The subset of a task's own due-date fields {@link dueBucket} needs — satisfied structurally by both
 * {@link TaskRow} (`summarySections`' own caller) and {@link TaskListItem} (`src/bot/views/taskList.ts`'s
 * `rowMarker`, Task 3.7), so neither caller needs to pass fields it doesn't have. */
export interface DueBucketInput {
  dueAt: Date | null;
  dueAllDay: boolean;
  dueTz: string | null;
}

/**
 * Which summary bucket `task` (an open/in_progress task with a due date) falls into — same rules as
 * `src/domain/notifications/plan.ts`'s reminder planning: a datetime due is "overdue" once its exact
 * instant is in the past, otherwise "today" when its local calendar date (in `zone`, the recipient's own
 * zone) is today's; an all-day due reads its own calendar date in `task.dueTz ?? zone` (a business date,
 * independent of who's being shown the summary) and compares it against today's date in `zone`. Exported
 * for `src/bot/views/taskList.ts`'s `rowMarker` (Task 3.7, D24) — it reuses this exact overdue/today/later
 * classification for a task list row's marker, rather than reimplementing the date math.
 */
export function dueBucket(task: DueBucketInput, now: Date, zone: string): 'overdue' | 'today' | 'later' {
  const dueAt = task.dueAt;
  if (dueAt === null) return 'later';

  const today = DateTime.fromJSDate(now, { zone }).toISODate();

  if (task.dueAllDay) {
    const dueDate = DateTime.fromJSDate(dueAt, { zone: task.dueTz ?? zone }).toISODate();
    if (dueDate === null || today === null) return 'later';
    if (dueDate < today) return 'overdue';
    return dueDate === today ? 'today' : 'later';
  }

  if (dueAt.getTime() < now.getTime()) return 'overdue';
  const dueDate = DateTime.fromJSDate(dueAt, { zone }).toISODate();
  if (dueDate === null || today === null) return 'later';
  return dueDate === today ? 'today' : 'later';
}

/**
 * Builds every section of the morning summary (plan.md Task 3.5) for `workspaceId`, as seen from
 * `zone` (the recipient's own zone) at `now`. `db` may be a transaction — `src/scheduler/jobs/notify.ts`
 * calls this from inside its own `tx` when it's time to actually send a `summary`-kind notification row.
 */
export async function summarySections(
  db: DbOrTx,
  args: { workspaceId: number; now: Date; zone: string },
): Promise<SummarySections> {
  const { workspaceId, now, zone } = args;

  const dueTasks = await db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, OPEN_STATUSES), isNotNull(tasks.dueAt)),
    )
    .orderBy(asc(tasks.dueAt));

  const overdueRows: TaskRow[] = [];
  const todayRows: TaskRow[] = [];
  for (const task of dueTasks) {
    const bucket = dueBucket(task, now, zone);
    if (bucket === 'overdue') overdueRows.push(task);
    else if (bucket === 'today') todayRows.push(task);
  }

  const noDueWhere = and(
    eq(tasks.workspaceId, workspaceId),
    inArray(tasks.status, OPEN_STATUSES),
    isNull(tasks.dueAt),
  );
  const [noDueTotalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(noDueWhere);
  const noDueTotal = noDueTotalRow?.count ?? 0;

  const noDueRows = await db
    .select()
    .from(tasks)
    .where(noDueWhere)
    .orderBy(asc(tasks.createdAt), asc(tasks.id))
    .limit(SUMMARY_NO_DUE_TOP_N);

  const overdue = await toListItems(db, overdueRows);
  const today = await toListItems(db, todayRows);
  const noDue = await toListItems(db, noDueRows);

  const { total: inboxCount } = await listPendingProposals(db, workspaceId, { page: 1, pageSize: 1 });

  return { overdue, today, inboxCount, noDue, noDueTotal };
}

/**
 * `/tasks`/`/today`/`/overdue`/`/archive`'s own filter kinds (plan.md Task 3.7, SPEC §12.3). `today` and
 * `overdue` are each a single bucket (the filter row's own "today"/"overdue" buttons); `/today` the
 * *command* uses `today_and_overdue` instead (SPEC §12.2: today plus overdue — the union of both).
 * `assignee`'s `userId` mirrors `TaskRow`'s own three-way assignee resolution (SPEC §9.4/D5): `'all'` =
 * `assignee_all`, `'none'` = no member and no "everyone" (covers both a truly unassigned task and a
 * free-text `assigneeNameText` one — neither has a specific member to filter by), a number = a specific
 * `assignee_user_id`. `archive` is `done`/`cancelled` (SPEC §12.4's "cancel" action → archive).
 */
export type ListFilter =
  | { kind: 'open' }
  | { kind: 'today' }
  | { kind: 'overdue' }
  | { kind: 'no_due' }
  | { kind: 'assignee'; userId: number | 'none' | 'all' }
  | { kind: 'chat'; chatId: number }
  | { kind: 'archive' }
  | { kind: 'today_and_overdue' };

export interface ListTasksResult {
  items: TaskListItem[];
  total: number;
  pages: number;
}

const ARCHIVE_STATUSES = ['done', 'cancelled'] as const;

/** `page` (1-indexed) clamped into `[1, pages]` — a stale/forged callback page (e.g. the page count shrank
 * after a task was archived between loading the list and tapping "▶️") never produces an empty page or a
 * negative offset. */
function clampPage(page: number, pages: number): number {
  if (page < 1) return 1;
  if (page > pages) return pages;
  return page;
}

function assigneeWhere(filter: Extract<ListFilter, { kind: 'assignee' }>) {
  if (filter.userId === 'all') return eq(tasks.assigneeAll, true);
  if (filter.userId === 'none') return and(eq(tasks.assigneeAll, false), isNull(tasks.assigneeUserId));
  return eq(tasks.assigneeUserId, filter.userId);
}

/** Builds the `WHERE`/`ORDER BY` for every {@link ListFilter} kind except `today`/`overdue`/
 * `today_and_overdue` — those three need per-row {@link dueBucket} classification (an all-day due's own
 * `dueTz` makes the boundary impossible to express as a single SQL date range), so {@link listTasks}
 * handles them separately via {@link listByDueBucket}. Ordering: `archive` is newest-archived-first (the
 * brief's "newest to oldest") by whichever of `completed_at`/`cancelled_at`/`updated_at` is set;
 * `no_due` is oldest-created-first (same "oldest neglected task first" convention `summarySections`' own
 * no-due section already uses); every other kind sorts by `due_at` ascending — Postgres's own default
 * NULL ordering puts a `NULL` due date last in ascending order, so this naturally surfaces the most
 * urgent (earliest-due) tasks first without a separate `NULLS LAST` clause.
 */
function whereAndOrder(
  workspaceId: number,
  filter: Exclude<ListFilter, { kind: 'today' | 'overdue' | 'today_and_overdue' }>,
) {
  if (filter.kind === 'archive') {
    return {
      where: and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, ARCHIVE_STATUSES)),
      orderBy: [
        desc(sql`coalesce(${tasks.completedAt}, ${tasks.cancelledAt}, ${tasks.updatedAt})`),
        desc(tasks.id),
      ],
    };
  }

  const openWhere = and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, OPEN_STATUSES));

  if (filter.kind === 'no_due') {
    return {
      where: and(openWhere, isNull(tasks.dueAt)),
      orderBy: [asc(tasks.createdAt), asc(tasks.id)],
    };
  }
  if (filter.kind === 'assignee') {
    return { where: and(openWhere, assigneeWhere(filter)), orderBy: [asc(tasks.dueAt), asc(tasks.id)] };
  }
  if (filter.kind === 'chat') {
    return {
      where: and(openWhere, eq(tasks.sourceChatId, filter.chatId)),
      orderBy: [asc(tasks.dueAt), asc(tasks.id)],
    };
  }
  // filter.kind === 'open'
  return { where: openWhere, orderBy: [asc(tasks.dueAt), asc(tasks.id)] };
}

async function listByWhereOrder(
  db: DbOrTx,
  where: ReturnType<typeof and>,
  orderBy: ReturnType<typeof asc>[],
  page: number,
  pageSize: number,
): Promise<ListTasksResult> {
  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(where);
  const total = totalRow?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = clampPage(page, pages);

  const rows =
    total === 0
      ? []
      : await db
          .select()
          .from(tasks)
          .where(where)
          .orderBy(...orderBy)
          .limit(pageSize)
          .offset((safePage - 1) * pageSize);

  return { items: await toListItems(db, rows), total, pages };
}

/** `today`/`overdue`/`today_and_overdue` (plan.md Task 3.7): fetches every open/in_progress task with a
 * due date (same base query `summarySections` above already uses), classifies each via {@link dueBucket}
 * in app code, then paginates the filtered, already-`due_at`-ascending list in memory. The dataset this
 * runs over is one school's own open tasks — small enough that fetching it whole and filtering in app
 * code is simpler (and, per D24, safer — a missed edge case in a hand-written SQL date range is worse
 * than this bot's actual data volume) than a per-kind SQL boundary.
 */
async function listByDueBucket(
  db: DbOrTx,
  workspaceId: number,
  kind: 'today' | 'overdue' | 'today_and_overdue',
  page: number,
  pageSize: number,
  now: Date,
  zone: string,
): Promise<ListTasksResult> {
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, OPEN_STATUSES), isNotNull(tasks.dueAt)),
    )
    .orderBy(asc(tasks.dueAt), asc(tasks.id));

  const matched = rows.filter((row) => {
    const bucket = dueBucket(row, now, zone);
    if (kind === 'today') return bucket === 'today';
    if (kind === 'overdue') return bucket === 'overdue';
    return bucket === 'today' || bucket === 'overdue';
  });

  const total = matched.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = clampPage(page, pages);
  const offset = (safePage - 1) * pageSize;

  return { items: await toListItems(db, matched.slice(offset, offset + pageSize)), total, pages };
}

/**
 * `/tasks`/`/today`/`/overdue`/`/archive`'s own data (plan.md Task 3.7, SPEC §12.3): `filter.kind`-specific
 * tasks, `pageSize` per `page` (1-indexed — same convention `listPendingProposals` above already uses).
 * `now`/`zone` are only read for the three due-bucket kinds (`today`/`overdue`/`today_and_overdue`) — see
 * {@link listByDueBucket}.
 */
export async function listTasks(
  db: DbOrTx,
  args: {
    workspaceId: number;
    filter: ListFilter;
    page: number;
    pageSize?: number;
    now: Date;
    zone: string;
  },
): Promise<ListTasksResult> {
  const { workspaceId, filter, page, now, zone } = args;
  const pageSize = args.pageSize ?? PAGE_SIZE;

  if (filter.kind === 'today' || filter.kind === 'overdue' || filter.kind === 'today_and_overdue') {
    return listByDueBucket(db, workspaceId, filter.kind, page, pageSize, now, zone);
  }

  const { where, orderBy } = whereAndOrder(workspaceId, filter);
  return listByWhereOrder(db, where, orderBy, page, pageSize);
}
