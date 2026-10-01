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
 * SPEC §13.5's section title translates to "quiet hours *and* days off" —
 * naming two distinct concepts, not one gating the other —
 * confirmed as a ruling during Task 2.12's review (fix round 1): `weekdays`
 * (whole days off), `windows` (daily hour ranges) and `dateRanges` (one-off
 * inclusive date ranges, covering the whole local day) are three
 * *independent* conditions, combined with OR. Any one of them matching is
 * enough — `instant` is quiet if today's ISO weekday is listed in
 * `weekdays`, **or** the local time falls inside any of `windows`, **or**
 * today's local date falls inside any of `dateRanges`. An empty array for
 * any of the three simply means that condition never contributes (matches
 * nothing) — it does not fall back to "always true" or gate the others.
 */
export function isQuietAt(instant: Date, zone: string, quiet: Settings['quiet']): boolean {
  if (!quiet.enabled) return false;

  const dt = DateTime.fromJSDate(instant).setZone(zone);
  if (!dt.isValid) return false;

  if (quiet.weekdays.includes(dt.weekday)) return true;

  const minutes = dt.hour * 60 + dt.minute;
  if (quiet.windows.some((w) => inWindow(minutes, w))) return true;

  const date = dt.toFormat('yyyy-MM-dd');
  if (quiet.dateRanges.some((r) => date >= r.from && date <= r.to)) return true;

  return false;
}
