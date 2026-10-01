/**
 * `/search` (plan.md Task 3.8, SPEC §12.2: free-text search across a task's title and description, via
 * trigram similarity plus ILIKE, across every status). A deliberately separate query from
 * `src/bot/handlers/lists.ts`'s `listTasks` (Task 3.7): a free-text search ranked by similarity is
 * different enough from a filtered, fixed-order list that sharing one function isn't warranted — this file
 * only reuses {@link TaskListItem}/{@link resolveAssigneeName} from `./queries.js`, the same three-way
 * assignee resolution every other task projection already uses.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { tasks } from '../../db/schema/index.js';
import { PAGE_SIZE } from '../../config/constants.js';
import { resolveAssigneeName, type TaskListItem } from './queries.js';
import type { TaskRow } from './repo.js';

/**
 * Escapes `%`, `_`, and the escape character itself `\` for a safe `ILIKE ... ESCAPE '\'` substring match
 * (plan.md Task 3.8 review focus 4): without this, a literal `%`/`_` typed by the Owner would act as an
 * ILIKE wildcard instead of being searched for literally (e.g. a bare `_` query would otherwise match
 * "any task with a title of at least one character" — effectively every task). Order matters: the escape
 * character itself must be doubled first, before `%`/`_` are escaped, or a user-typed `\%` would be
 * double-escaped into something that no longer means a literal `%`.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** Mirrors `./queries.ts`'s own private `toListItem` (not exported there) — kept in sync by hand since
 * both are small, stable projections of the same five {@link TaskListItem} fields off a {@link TaskRow}. */
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

/** `page` (1-indexed) clamped into `[1, pages]` — same convention `src/domain/tasks/queries.ts`'s own
 * `clampPage` already uses for `listTasks`, so a stale/forged page number never produces a negative
 * offset or an empty page when earlier ones exist. */
function clampPage(page: number, pages: number): number {
  if (page < 1) return 1;
  if (page > pages) return pages;
  return page;
}

export interface SearchTasksResult {
  items: TaskListItem[];
  total: number;
}

/**
 * Full-text-ish search across every task's `title`/`description`, by any status (open, in_progress, done,
 * cancelled — SPEC §12.2's "every status", so an archived task is always findable). Step 3's own recipe:
 * an escaped `ILIKE ... ESCAPE '\'` substring match against `title` or `description` (always literal — see
 * {@link escapeLikePattern}), OR'd with a `pg_trgm` fuzzy match against `title` alone
 * (`similarity(title, q) > 0.2`, tolerant of a typo in the query); ranked by
 * `greatest(similarity(title, q), similarity(description, q))` descending (Postgres's `GREATEST` ignores a
 * `NULL` argument, so a `NULL` `description` never breaks the ranking), with the task id as a stable
 * tie-breaker so pagination never skips or repeats a row across pages with equal ranking. `pg_trgm` is
 * already enabled with `gin_trgm_ops` indexes on both columns (`src/db/schema/tasks.ts`, an earlier phase's
 * migration) — no new migration needed.
 *
 * `page` is clamped the same way `listTasks` clamps its own `page` — a stale/forged page from a prior
 * search (e.g. the result count shrank after a task was archived between searches) never produces an empty
 * page or a negative offset. `pageSize` defaults to `PAGE_SIZE` (5, same as every other task list).
 */
export async function searchTasks(
  db: DbOrTx,
  args: { workspaceId: number; query: string; page: number; pageSize?: number },
): Promise<SearchTasksResult> {
  const { workspaceId, query, page } = args;
  const pageSize = args.pageSize ?? PAGE_SIZE;

  const pattern = `%${escapeLikePattern(query)}%`;
  const matchClause = sql`(
    ${tasks.title} ILIKE ${pattern} ESCAPE '\\'
    OR ${tasks.description} ILIKE ${pattern} ESCAPE '\\'
    OR similarity(${tasks.title}, ${query}) > 0.2
  )`;
  const where = and(eq(tasks.workspaceId, workspaceId), matchClause);

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(where);
  const total = totalRow?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = clampPage(page, pages);

  if (total === 0) return { items: [], total };

  const rank = sql`greatest(similarity(${tasks.title}, ${query}), similarity(${tasks.description}, ${query}))`;
  const rows = await db
    .select()
    .from(tasks)
    .where(where)
    .orderBy(desc(rank), asc(tasks.id))
    .limit(pageSize)
    .offset((safePage - 1) * pageSize);

  const items: TaskListItem[] = [];
  for (const task of rows) {
    // Sequential, not `Promise.all` — `db` may be a transaction, same note `./queries.ts`'s own
    // `toListItems` already carries (a single Postgres connection can't run overlapping queries).
    const assigneeName = await resolveAssigneeName(db, task);
    items.push(toListItem(task, assigneeName));
  }

  return { items, total };
}
