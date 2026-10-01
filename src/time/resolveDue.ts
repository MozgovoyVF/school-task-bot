import { DateTime } from 'luxon';
import type { DueT } from '../ai/schemas.js';
import type { Settings } from '../domain/settings/schema.js';

/**
 * The fuzzy-time table (SPEC §10.7, §16, `settings.fuzzyTimes`): the
 * clock-of-day each `time_hint` resolves to, plus `end_of_week`'s
 * weekday/time and `soon`'s workday count.
 */
export type FuzzyTimes = Settings['fuzzyTimes'];

export interface ResolvedDue {
  dueAt: Date | null;
  allDay: boolean;
  tz: string | null;
  inPast: boolean;
  invalid: boolean;
  dueText: string | null;
}

export interface ResolveDueOptions {
  /** The message author's timezone, or the workspace's (SPEC §10.1). */
  zone: string;
  /** Injected instead of read from the system clock (CLAUDE.md — this module never calls `Date.now()`/`new Date()`). */
  now: Date;
  fuzzy: FuzzyTimes;
}

const ISO_SATURDAY = 6;
const ISO_SUNDAY = 7;

function isWeekend(dt: DateTime): boolean {
  return dt.weekday === ISO_SATURDAY || dt.weekday === ISO_SUNDAY;
}

/** Sets `dt`'s clock-of-day to an `HH:mm` string (already zod-validated by `FuzzyTimesSchema`, or the literal `'23:59'` below). */
function atTime(dt: DateTime, time: string): DateTime {
  const [hourStr, minuteStr] = time.split(':');
  return dt.set({ hour: Number(hourStr ?? 0), minute: Number(minuteStr ?? 0), second: 0, millisecond: 0 });
}

/**
 * `fuzzy.endOfWeekDay` (Friday, by default) of `now`'s ISO week at
 * `fuzzy.endOfWeekTime`, rolled to the following week when that candidate is
 * already at-or-before `now` (SPEC §10.4; brief step 3).
 */
function resolveEndOfWeek(now: DateTime, fuzzy: FuzzyTimes): DateTime {
  const candidate = atTime(now.startOf('week').plus({ days: fuzzy.endOfWeekDay - 1 }), fuzzy.endOfWeekTime);
  return candidate.toMillis() <= now.toMillis() ? candidate.plus({ weeks: 1 }) : candidate;
}

/**
 * `fuzzy.soonWorkdays` workdays (Mon-Fri, holidays not considered — SPEC
 * §30.2) after `now`, at `fuzzy.defaultTime` (SPEC §10.5; brief step 3).
 */
function resolveSoon(now: DateTime, fuzzy: FuzzyTimes): DateTime {
  let date = now;
  let workdaysLeft = fuzzy.soonWorkdays;
  while (workdaysLeft > 0) {
    date = date.plus({ days: 1 });
    if (!isWeekend(date)) workdaysLeft -= 1;
  }
  return atTime(date, fuzzy.defaultTime);
}

/** Resolves a date-only `due_local` (no `T...` suffix) plus a `time_hint`, per SPEC §10.3-5. */
function resolveDateOnlyTime(
  dateOnly: DateTime,
  hint: DueT['time_hint'],
  fuzzy: FuzzyTimes,
): { dt: DateTime; allDay: boolean } {
  switch (hint) {
    case 'morning':
      return { dt: atTime(dateOnly, fuzzy.morning), allDay: false };
    case 'afternoon':
      return { dt: atTime(dateOnly, fuzzy.afternoon), allDay: false };
    case 'evening':
      return { dt: atTime(dateOnly, fuzzy.evening), allDay: false };
    case 'none':
      return { dt: atTime(dateOnly, '23:59'), allDay: true };
    case 'end_of_week':
    case 'soon':
      // A concrete date is already known — only the clock-of-day is left
      // fuzzy, and neither hint defines one of its own for this case, so it
      // falls back to `fuzzy.defaultTime` (brief step 3).
      return { dt: atTime(dateOnly, fuzzy.defaultTime), allDay: false };
  }
}

function finish(
  dt: DateTime,
  allDay: boolean,
  now: DateTime,
  zone: string,
  dueText: string | null,
): ResolvedDue {
  return {
    dueAt: dt.toJSDate(),
    allDay,
    tz: zone,
    inPast: dt.toMillis() < now.toMillis(),
    invalid: false,
    dueText,
  };
}

const NOTHING_RESOLVED: Omit<ResolvedDue, 'dueText'> = {
  dueAt: null,
  allDay: false,
  tz: null,
  inPast: false,
  invalid: false,
};

/**
 * Turns the extractor's `due` (SPEC §9.5) into a concrete UTC instant, per
 * SPEC §10: a `due_local` with a time is taken as-is in `opts.zone`; a
 * date-only `due_local` combines with `due.time_hint` via `opts.fuzzy`;
 * `end_of_week`/`soon` without a `due_local` resolve relative to `opts.now`.
 * An impossible calendar date (e.g. 2026-02-30) is reported as `invalid`
 * rather than thrown; a resolved instant before `opts.now` is flagged
 * `inPast` (SPEC §10.8) so the caller can warn the recipient instead of
 * silently dropping the task (CLAUDE.md — a missed task is worse than a
 * false positive).
 */
export function resolveDue(due: DueT, opts: ResolveDueOptions): ResolvedDue {
  const { zone, fuzzy } = opts;
  const now = DateTime.fromJSDate(opts.now, { zone });
  const dueText = due.due_text;

  if (due.due_local === null) {
    switch (due.time_hint) {
      case 'end_of_week':
        return finish(resolveEndOfWeek(now, fuzzy), false, now, zone, dueText);
      case 'soon':
        return finish(resolveSoon(now, fuzzy), false, now, zone, dueText);
      // `morning`/`afternoon`/`evening` have nothing to attach a clock-of-day
      // to without a date, and `none` means no due date was found at all
      // (SPEC §10.6) — both resolve to "no due date".
      case 'morning':
      case 'afternoon':
      case 'evening':
      case 'none':
        return { ...NOTHING_RESOLVED, dueText };
    }
  }

  const hasTime = due.due_local.includes('T');
  const parsed = DateTime.fromISO(due.due_local, { zone });
  if (!parsed.isValid) {
    return { ...NOTHING_RESOLVED, invalid: true, dueText };
  }
  if (hasTime) {
    return finish(parsed, false, now, zone, dueText);
  }

  const { dt, allDay } = resolveDateOnlyTime(parsed, due.time_hint, fuzzy);
  return finish(dt, allDay, now, zone, dueText);
}
