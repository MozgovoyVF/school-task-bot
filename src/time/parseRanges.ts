/**
 * Free-text parsers for `/settings`'s "quiet hours" section (plan.md Task 3.11, SPEC §13.5): a date range
 * (free text like "31.12 - 08.01", with or without surrounding words) for `quiet.dateRanges`, and an
 * `HH:mm-HH:mm` window ("22:00-08:00" or the shorthand "22-8") for `quiet.windows`. Both are pure,
 * Cyrillic-free (CLAUDE.md §8) — they take `now`/`zone` as plain parameters rather than reading the clock
 * themselves, so the caller (a bot conversation) supplies `clock.now()`.
 */
import { DateTime } from 'luxon';

/** `DD.MM` or `DD.MM.YYYY` — the parser extracts dates by shape, not by any surrounding wording. */
const DATE_TOKEN_RE = /\d{1,2}\.\d{1,2}(?:\.\d{4})?/g;
const DATE_TOKEN_FULL_RE = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/;

interface DateToken {
  day: number;
  month: number;
  year: number | null;
}

function parseDateToken(token: string): DateToken | null {
  const match = DATE_TOKEN_FULL_RE.exec(token);
  if (!match) return null;
  const [, dayStr, monthStr, yearStr] = match;
  if (dayStr === undefined || monthStr === undefined) return null;
  return {
    day: Number(dayStr),
    month: Number(monthStr),
    year: yearStr === undefined ? null : Number(yearStr),
  };
}

function toDateTime(token: DateToken, year: number, zone: string): DateTime | null {
  const dt = DateTime.fromObject({ day: token.day, month: token.month, year }, { zone });
  return dt.isValid ? dt : null;
}

/**
 * Parses a free-text date range for `quiet.dateRanges` (SPEC §13.5's "31.12 - 08.01"-style input):
 * extracts the first two `DD.MM[.YYYY]`-shaped
 * tokens in `input` (regardless of surrounding words), infers a missing
 * year for each from `now`/`zone`, and returns both dates as `YYYY-MM-DD`.
 *
 * Year inference (both ends independently, so a range can cross a year
 * boundary): the "from" date, taken in the current year, keeps that year if
 * it is today or later, otherwise rolls to next year (a date already in the
 * past this year almost certainly means next year's occurrence — e.g. a
 * recurring school holiday). The "to" date is resolved the same way
 * relative to the (already-resolved) "from" date: same year as "from"
 * unless that would put it before "from", in which case it rolls to
 * "from"'s year + 1 (handles e.g. "31.12 — 08.01" spanning New Year's).
 * An explicit `.YYYY` on either token is always used as-is, never inferred.
 *
 * Returns `null` if `input` doesn't contain two parseable date tokens, or
 * either one isn't a valid calendar date (e.g. `32.12`).
 */
export function parseDateRange(input: string, now: Date, zone: string): { from: string; to: string } | null {
  const matches = input.match(DATE_TOKEN_RE);
  if (matches === null || matches.length < 2) return null;

  const [fromRaw, toRaw] = matches;
  if (fromRaw === undefined || toRaw === undefined) return null;

  const fromToken = parseDateToken(fromRaw);
  const toToken = parseDateToken(toRaw);
  if (fromToken === null || toToken === null) return null;

  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  if (!today.isValid) return null;

  let fromYear = fromToken.year;
  if (fromYear === null) {
    const candidate = toDateTime(fromToken, today.year, zone);
    fromYear = candidate !== null && candidate >= today ? today.year : today.year + 1;
  }
  const fromDt = toDateTime(fromToken, fromYear, zone);
  if (fromDt === null) return null;

  let toYear = toToken.year;
  if (toYear === null) {
    const candidate = toDateTime(toToken, fromYear, zone);
    toYear = candidate !== null && candidate >= fromDt ? fromYear : fromYear + 1;
  }
  const toDt = toDateTime(toToken, toYear, zone);
  if (toDt === null || toDt < fromDt) return null;

  const fromIso = fromDt.toISODate();
  const toIso = toDt.toISODate();
  if (fromIso === null || toIso === null) return null;

  return { from: fromIso, to: toIso };
}

const TIME_TOKEN_RE = /^(\d{1,2})(?::([0-5]\d))?$/;

function parseTimeToken(raw: string): string | null {
  const match = TIME_TOKEN_RE.exec(raw.trim());
  if (!match) return null;
  const [, hourStr, minuteStr] = match;
  if (hourStr === undefined) return null;
  const hour = Number(hourStr);
  const minute = minuteStr === undefined ? 0 : Number(minuteStr);
  if (hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Parses a free-text `HH:mm-HH:mm` window for `quiet.windows` (e.g.
 * `22:00-08:00`), or its bare-hour shorthand (`22-8`). A window crossing
 * midnight (`to` < `from`) is a valid, common case for quiet hours (e.g.
 * "22:00-08:00") — this parser does not reject it; `SettingsSchema`'s own
 * `QuietWindowSchema` doesn't either (confirmed by `tests/unit/domain/
 * settings.test.ts`'s "accepts quiet windows crossing midnight" case).
 * Returns `null` for anything else, including an out-of-range hour
 * (`25-8`).
 */
export function parseTimeWindow(input: string): { from: string; to: string } | null {
  const parts = input.split('-');
  if (parts.length !== 2) return null;
  const [fromRaw, toRaw] = parts;
  if (fromRaw === undefined || toRaw === undefined) return null;

  const from = parseTimeToken(fromRaw);
  const to = parseTimeToken(toRaw);
  if (from === null || to === null) return null;
  return { from, to };
}
