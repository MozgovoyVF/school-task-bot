import { DateTime } from 'luxon';
import type { Settings } from '../domain/settings/schema.js';

type QuietWindow = Settings['quiet']['windows'][number];

/** `HH:mm` → minutes since local midnight. */
function toMinutes(time: string): number {
  const [hourStr, minuteStr] = time.split(':');
  return Number(hourStr ?? 0) * 60 + Number(minuteStr ?? 0);
}

/**
 * `minutes` (local clock-of-day) falls inside `[w.from, w.to)`. `from`
 * inclusive, `to` exclusive (SPEC §13.5/D10's examples: the window's end
 * instant itself is already "quiet hours over"). `from > to` is an
 * overnight window (e.g. `22:00`–`08:00`) — it matches everything from
 * `from` through midnight, plus everything before `to`.
 */
function inWindow(minutes: number, w: QuietWindow): boolean {
  const from = toMinutes(w.from);
  const to = toMinutes(w.to);
  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * Whether `instant` falls inside quiet hours, evaluated in `zone` — always
 * the *recipient's* zone (D10), never the workspace's. `quiet` is a
 * workspace's `Settings['quiet']` branch (already zod-validated/defaulted
 * by `parseSettings`).
 *
 * The recurring weekly schedule (`weekdays`/`windows`) and the one-off
 * `dateRanges` are two independent conditions, combined with OR — either
 * one alone is enough to make `instant` quiet:
 *
 * - The recurring schedule only applies at all when `weekdays` or `windows`
 *   is non-empty (D10, plan.md Task 2.12's brief fixtures — an empty
 *   `weekdays` means "every day" and an empty `windows` means "all day", so
 *   with *both* empty there is no recurring rule to speak of, and a
 *   `dateRanges`-only config must not accidentally become "always quiet").
 *   Within it, `weekdays` (empty ⇒ every day) and `windows` (empty ⇒ the
 *   entire day, no time-of-day restriction) are ANDed together.
 * - `dateRanges` entries are inclusive calendar-date ranges (D10) in the
 *   recipient's zone, covering the *entire* local day — no time-of-day
 *   check — matching D10's "cards created during the quiet period" framing
 *   of a holiday-style blackout rather than a daily window.
 */
export function isQuietAt(instant: Date, zone: string, quiet: Settings['quiet']): boolean {
  if (!quiet.enabled) return false;

  const dt = DateTime.fromJSDate(instant).setZone(zone);
  if (!dt.isValid) return false;

  const hasRecurringRule = quiet.weekdays.length > 0 || quiet.windows.length > 0;
  if (hasRecurringRule) {
    const weekdayOk = quiet.weekdays.length === 0 || quiet.weekdays.includes(dt.weekday);
    const minutes = dt.hour * 60 + dt.minute;
    const windowOk = quiet.windows.length === 0 || quiet.windows.some((w) => inWindow(minutes, w));
    if (weekdayOk && windowOk) return true;
  }

  if (quiet.dateRanges.length > 0) {
    const date = dt.toFormat('yyyy-MM-dd');
    if (quiet.dateRanges.some((r) => date >= r.from && date <= r.to)) return true;
  }

  return false;
}
