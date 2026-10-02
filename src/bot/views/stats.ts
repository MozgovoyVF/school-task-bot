/**
 * Renders `/stats` (plan.md Task 3.8, SPEC §12.5). Pure function: no DB, no I/O, no grammY (CLAUDE.md §7)
 * — the caller (`src/bot/handlers/stats.ts`) resolves `taskStats`'s own rows beforehand.
 */
import type { Buttons } from '../../domain/messenger.js';
import type { TaskStatsRow } from '../../domain/tasks/stats.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';
import { escapeHtml } from './escape.js';

export interface StatsRender {
  text: string;
  buttons: Buttons;
}

/** Every `/stats` period the Owner can switch to (SPEC §12.5: 7, 30, or 90 days). */
export const STATS_PERIODS = [7, 30, 90] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

/** `row.key`'s own display label, icon included — `texts.stats.row`'s `name` parameter only holds the
 * Russian wording, this is the one place that decides which emoji goes with which key kind (same split
 * `src/bot/views/taskList.ts`'s `rowMarker` keeps between icon-picking-in-view and wording-in-texts). */
function keyLabel(key: TaskStatsRow['key']): string {
  if (key.type === 'owner') return `👑 ${texts.stats.ownerLabel}`;
  if (key.type === 'none') return `❓ ${texts.stats.noneLabel}`;
  return `👤 ${escapeHtml(key.name)}`;
}

function rowBlock(row: TaskStatsRow): string {
  return texts.stats.row(
    keyLabel(row.key),
    row.open,
    row.inProgress,
    row.overdueNow,
    row.done,
    row.onTimePct,
    row.avgLateHours,
  );
}

/** `v1:s:per:0:<periodDays>` (entity `'s'`, shared with `src/bot/handlers/search.ts`'s own `v1:s:pg:*`
 * pagination callback under the same entity — the two are told apart by `action`, `'per'` vs `'pg'`, same
 * "decode, check `KNOWN_ACTIONS`, else `next()`" fallthrough convention `src/bot/handlers/lists.ts` already
 * uses for its own multi-action entity). `id` is unused (always `0`) — the period itself travels in `arg`,
 * since `encodeCallback`'s `action` field only accepts lowercase letters (no digits), unlike `arg`. */
function periodCallback(periodDays: StatsPeriod): string {
  return encodeCallback({ entity: 's', action: 'per', id: 0, arg: String(periodDays) });
}

function periodRow(activePeriodDays: StatsPeriod): Buttons[number] {
  return STATS_PERIODS.map((p) => ({
    text: p === activePeriodDays ? texts.stats.periodButtonActive(p) : texts.stats.periodButton(p),
    data: periodCallback(p),
  }));
}

/**
 * Pure render for `/stats` (plan.md Task 3.8, SPEC §12.5): a header line, one block per assignee (blank
 * line between blocks), and the `[7] [30] [90]` period-switch row. `rows` is already `taskStats`'s own
 * output — this function does no further grouping/sorting.
 */
export function renderStats(rows: readonly TaskStatsRow[], periodDays: StatsPeriod): StatsRender {
  const header = texts.stats.header(periodDays);
  const buttons: Buttons = [periodRow(periodDays)];

  if (rows.length === 0) {
    return { text: [header, texts.stats.empty].join('\n'), buttons };
  }

  const text = [header, '', rows.map(rowBlock).join('\n\n')].join('\n');
  return { text, buttons };
}
