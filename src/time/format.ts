import { DateTime } from 'luxon';
import { zoneLabel, type ZoneLabel } from './zones.js';
import { RU_MONTHS_SHORT, RU_WEEKDAYS_SHORT } from '../bot/texts/ru.js';

export interface FormattedDue {
  date: string;
  time: string | null;
  zone: ZoneLabel | null;
}

/**
 * Short "weekday, day month" label for `at`, read in `zone` (D17's own arrays —
 * `RU_WEEKDAYS_SHORT`/`RU_MONTHS_SHORT`, no trailing dot, no ICU dependency). Extracted out of `formatDue`
 * below (which uses it for its own `date` field) so `src/bot/views/summary.ts`'s `renderSummary` (Task 3.5,
 * SPEC §13.4) can build its own "summary for {date}" header line from it directly, without its own copy of
 * this date math.
 *
 * The day/month arrays are Cyrillic literals, which CLAUDE.md §8 allows only in `bot/texts/ru.ts` — so,
 * like `time/zones.ts`'s `zoneLabel` (whose Cyrillic rendering lives in `ru.ts`'s `formatZoneLabel`), this
 * module imports the arrays' *values* from there rather than declaring them itself, keeping this file's own
 * source Cyrillic-free while its output isn't.
 */
export function formatDateLabel(at: Date, zone: string): string {
  const dt = DateTime.fromJSDate(at, { zone });
  const weekday = RU_WEEKDAYS_SHORT[dt.weekday - 1];
  const month = RU_MONTHS_SHORT[dt.month - 1];
  if (weekday === undefined || month === undefined) {
    throw new Error(
      `formatDateLabel: invalid zone or date (weekday=${String(dt.weekday)}, month=${String(dt.month)})`,
    );
  }
  return `${weekday}, ${String(dt.day)} ${month}`;
}

/**
 * Structured pieces of a due date/time, in `viewerZone` (SPEC §10.9, D29):
 * `formatDateLabel`'s own short date, an `HH:mm` time (`null` for an all-day due date), and a `ZoneLabel`
 * to show alongside it — only when `viewerZone` differs from the due date's own zone (`due.tz`) *and* the
 * due date isn't all-day (D29: an all-day due date never gets a zone label, even if the viewer's zone
 * differs). `null` in, `null` out (no due date to format). `bot/texts/ru.ts`'s `texts.formatDue` turns this
 * structure (or `null`, the "no due date" case) into the final one-line display string.
 */
export function formatDue(
  due: { at: Date; allDay: boolean; tz: string | null } | null,
  viewerZone: string,
): FormattedDue | null {
  if (due === null) return null;

  const dt = DateTime.fromJSDate(due.at, { zone: viewerZone });
  const showZone = !due.allDay && due.tz !== null && due.tz !== viewerZone;

  return {
    date: formatDateLabel(due.at, viewerZone),
    time: due.allDay ? null : dt.toFormat('HH:mm'),
    zone: showZone ? zoneLabel(viewerZone, due.at) : null,
  };
}
