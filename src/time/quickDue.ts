import { DateTime } from 'luxon';

/** The editProposal dialog's due-date quick-pick buttons (plan.md Task 2.14, D23). `'none'` is "no due date". */
export type QuickDueOption = 'today' | 'tomorrow' | 'fri' | 'next_mon' | 'none';

export interface QuickDue {
  at: Date | null;
  allDay: boolean;
  tz: string | null;
}

const ISO_FRIDAY = 5;
const ISO_MONDAY = 1;
const ISO_WEEK_LENGTH = 7;

/** 23:59 in `zone` (D23: every quick-pick option that resolves to a date is all-day). */
function endOfDay(dt: DateTime): DateTime {
  return dt.set({ hour: 23, minute: 59, second: 0, millisecond: 0 });
}

/**
 * Days from `today` (an ISO weekday, 1=Monday..7=Sunday) to the next occurrence of `targetWeekday`,
 * inclusive of today itself (`0` when `today === targetWeekday`).
 */
function daysUntil(today: number, targetWeekday: number): number {
  return (targetWeekday - today + ISO_WEEK_LENGTH) % ISO_WEEK_LENGTH;
}

/**
 * D23's quick due dates: `today`/`tomorrow`/`fri`/`next_mon` all resolve to an all-day due date (23:59 in
 * `zone`) on the picked date; `none` clears the due date entirely (`at: null`). `fri` means "today" when
 * `now` itself falls on a Friday, and the *next* Friday on every other day, including Saturday/Sunday (so
 * picking it over the weekend never lands in the past — D23's explicit Saturday example: 26.09 (Sat) →
 * 02.10, not 25.09, which would already be gone). `next_mon` is always the Monday still to come, even
 * when `now` is itself a Monday — picking "today" already covers that day, so "next Monday" here always
 * means next week's, matching `daysUntil`'s own `|| ISO_WEEK_LENGTH` fallback for a same-weekday match.
 */
export function quickDue(option: QuickDueOption, now: Date, zone: string): QuickDue {
  if (option === 'none') return { at: null, allDay: false, tz: null };

  const today = DateTime.fromJSDate(now, { zone });

  let target: DateTime;
  switch (option) {
    case 'today':
      target = today;
      break;
    case 'tomorrow':
      target = today.plus({ days: 1 });
      break;
    case 'fri':
      target = today.plus({ days: daysUntil(today.weekday, ISO_FRIDAY) });
      break;
    case 'next_mon':
      target = today.plus({ days: daysUntil(today.weekday, ISO_MONDAY) || ISO_WEEK_LENGTH });
      break;
  }

  return { at: endOfDay(target).toJSDate(), allDay: true, tz: zone };
}
