import { DateTime } from 'luxon';
import { MSK_TOKENS } from '../config/constants.js';

/**
 * Timezones for `/timezone`'s quick-pick keyboard (SPEC §10.10): the 11 IANA
 * zones actually used across Russia, ordered west to east, plus
 * `Europe/Moscow` itself. Button labels (Russian city names) live in
 * `src/bot/texts/ru.ts` — no Cyrillic is allowed in this file (CLAUDE.md §8).
 */
export const RU_ZONES = [
  'Europe/Kaliningrad',
  'Europe/Moscow',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Novosibirsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Yakutsk',
  'Asia/Vladivostok',
  'Asia/Magadan',
  'Asia/Kamchatka',
] as const;

/**
 * Moscow's fixed UTC offset. Russia stopped observing DST in 2014 and has
 * kept `Europe/Moscow` at UTC+3 year-round since; this is a stable fact about
 * the zone, not a "current time" lookup, so hardcoding it here does not run
 * afoul of CLAUDE.md §8's ban on reading the current time in `src/time/`.
 */
const MOSCOW_UTC_OFFSET_HOURS = 3;

/** IANA's valid offset range is UTC-12:00..UTC+14:00. */
const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;

let ianaZoneLookup: Map<string, string> | null = null;

/** Lazily built, case-insensitive lookup from a lowercased IANA zone name to its canonical spelling. */
function getIanaZoneLookup(): Map<string, string> {
  ianaZoneLookup ??= new Map(Intl.supportedValuesOf('timeZone').map((zone) => [zone.toLowerCase(), zone]));
  return ianaZoneLookup;
}

const OFFSET_TOKEN_RE = /^([+-])(\d{1,2})(?::([0-5]\d))?$/;

/**
 * Parses a signed offset token (e.g. `+5`, `-3:30`) added on top of
 * `baseHours` (0 for a bare `UTC`/`GMT` prefix, {@link MOSCOW_UTC_OFFSET_HOURS}
 * for an MSK-token prefix), returning the total offset in minutes or `null`
 * if the token is malformed or the resulting offset falls outside the valid
 * UTC-12:00..UTC+14:00 range.
 */
function parseOffsetToken(spec: string, baseHours: number): number | null {
  const match = OFFSET_TOKEN_RE.exec(spec);
  if (!match) return null;
  const [, signStr, hoursStr, minutesStr] = match;
  if (signStr === undefined || hoursStr === undefined) return null;

  const sign = signStr === '-' ? -1 : 1;
  const hours = Number(hoursStr);
  const minutes = minutesStr === undefined ? 0 : Number(minutesStr);
  const totalMinutes = baseHours * 60 + sign * (hours * 60 + minutes);

  if (totalMinutes < MIN_OFFSET_MINUTES || totalMinutes > MAX_OFFSET_MINUTES) return null;
  return totalMinutes;
}

/** Formats a total offset in minutes as luxon's fixed-offset zone spec, e.g. `UTC+5`, `UTC-3:30`. */
function formatFixedOffsetZone(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return minutes === 0
    ? `UTC${sign}${String(hours)}`
    : `UTC${sign}${String(hours)}:${String(minutes).padStart(2, '0')}`;
}

// `\p{L}` (any Unicode letter) rather than a hardcoded Latin/Cyrillic range: this matches an
// MSK-token candidate (a Cyrillic word, per `MSK_TOKENS` in `src/config/constants.ts`) without
// spelling out Cyrillic characters in this file's source, which CLAUDE.md §8 reserves for
// `src/bot/texts/ru.ts`/`src/config/constants.ts`.
const MSK_TOKEN_RE = /^(\p{L}+)([+-]\d{1,2}(?::[0-5]\d)?)?$/u;

/**
 * Parses a user-typed timezone (`/timezone`'s manual-entry step, SPEC
 * §10.10): a bare MSK token (→ `Europe/Moscow`), an MSK token with a signed
 * offset (→ a `UTC±N` fixed-offset spec relative to Moscow's UTC+3), a
 * `UTC`/`GMT`-prefixed or bare signed offset (→ a normalized `UTC±N` spec),
 * or an IANA zone name (case-insensitively matched and returned in its
 * canonical casing). Returns `null` for anything it cannot confidently
 * resolve, including offsets outside the valid UTC-12:00..+14:00 range and
 * unknown zone names — per CLAUDE.md §1's top priority (missing a task is
 * worse than a false positive), an unresolvable zone must not be guessed.
 */
export function parseZoneInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();

  const mskMatch = MSK_TOKEN_RE.exec(lower);
  if (mskMatch) {
    const [, token, offsetPart] = mskMatch;
    if (token !== undefined && (MSK_TOKENS as readonly string[]).includes(token)) {
      if (offsetPart === undefined) return 'Europe/Moscow';
      const offsetMinutes = parseOffsetToken(offsetPart, MOSCOW_UTC_OFFSET_HOURS);
      return offsetMinutes === null ? null : formatFixedOffsetZone(offsetMinutes);
    }
  }

  const offsetMatch = /^(?:utc|gmt)?([+-]\d{1,2}(?::[0-5]\d)?)$/.exec(lower);
  if (offsetMatch) {
    const [, offsetPart] = offsetMatch;
    if (offsetPart !== undefined) {
      const offsetMinutes = parseOffsetToken(offsetPart, 0);
      return offsetMinutes === null ? null : formatFixedOffsetZone(offsetMinutes);
    }
  }

  return getIanaZoneLookup().get(lower) ?? null;
}

export interface ZoneLabel {
  kind: 'msk' | 'utc';
  offsetMinutes: number;
}

function isRuZone(zone: string): boolean {
  return (RU_ZONES as readonly string[]).includes(zone);
}

/**
 * Computes `zone`'s offset at instant `at`, relative to Moscow for the RU
 * zones (`kind: 'msk'`, D17) and relative to UTC for everything else
 * (`kind: 'utc'`). `src/bot/texts/ru.ts`'s `formatZoneLabel` turns this into
 * a display string — this module stays Cyrillic-free (CLAUDE.md §8).
 */
export function zoneLabel(zone: string, at: Date): ZoneLabel {
  const dt = DateTime.fromJSDate(at).setZone(zone);
  const offsetMinutes = dt.isValid ? dt.offset : 0;

  if (isRuZone(zone)) {
    const moscow = DateTime.fromJSDate(at).setZone('Europe/Moscow');
    const moscowOffset = moscow.isValid ? moscow.offset : MOSCOW_UTC_OFFSET_HOURS * 60;
    return { kind: 'msk', offsetMinutes: offsetMinutes - moscowOffset };
  }

  return { kind: 'utc', offsetMinutes };
}

/**
 * The zone a due date/reminder should be shown in for `user` (SPEC §10.1):
 * their own preference if set, otherwise the workspace's zone.
 */
export function userZone(user: { timezone: string | null }, workspace: { timezone: string }): string {
  return user.timezone ?? workspace.timezone;
}
