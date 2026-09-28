import { PII_MARKERS } from '../config/constants.js';

// SPEC §19.3.2 — participant projection safe to pass into pseudonymized LLM
// input: no Telegram ID, no username, no last name (those never leave the
// pipeline), only the anonymous code, display name and aliases.
export interface ParticipantForLlm {
  code: string;
  userId: number;
  displayName: string;
  aliases: string[];
  username: string | null;
  lastName: string | null;
  isOwner: boolean;
}

// Word boundaries via lookaround instead of `\b`, so they also work across
// Cyrillic text (`\b` is ASCII-only and misfires around Cyrillic letters).
const LEFT_BOUNDARY = '(?<![\\p{L}\\p{N}_])';
const RIGHT_BOUNDARY = '(?![\\p{L}\\p{N}_])';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const URL_RE = new RegExp(`${LEFT_BOUNDARY}(?:https?:\\/\\/|www\\.)\\S+`, 'giu');
const EMAIL_RE = new RegExp(
  `${LEFT_BOUNDARY}[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}.-]+\\.\\p{L}{2,}${RIGHT_BOUNDARY}`,
  'giu',
);
const USERNAME_RE = new RegExp(`${LEFT_BOUNDARY}@([A-Za-z0-9_]{1,32})${RIGHT_BOUNDARY}`, 'gu');

// Card/account numbers: 16-20 digits, optionally grouped with single spaces
// or hyphens between digits. Runs before phone matching so long digit runs
// are not partially picked up by the (shorter) phone pattern.
const CARD_RE = new RegExp(`${LEFT_BOUNDARY}\\d(?:[ -]?\\d){15,19}${RIGHT_BOUNDARY}`, 'gu');

// Phones vary too much in grouping (RU trunk/country code, bare local
// numbers, international) to pin down with one shape-specific regex, so a
// permissive digit/separator run is matched first and then filtered by its
// total digit count. That range also keeps 8-digit dates (`2026-10-03`) and
// amounts (`15 000`) out without needing to special-case them.
const PHONE_CANDIDATE_RE = new RegExp(`${LEFT_BOUNDARY}\\+?[\\d() -]*\\d${RIGHT_BOUNDARY}`, 'gu');
const PHONE_MIN_DIGITS = 9;
const PHONE_MAX_DIGITS = 11;

function replaceUrls(text: string): string {
  return text.replace(URL_RE, PII_MARKERS.link);
}

function replaceEmails(text: string): string {
  return text.replace(EMAIL_RE, PII_MARKERS.email);
}

function replaceUsernames(text: string, participants: readonly ParticipantForLlm[]): string {
  return text.replace(USERNAME_RE, (_match, handle: string) => {
    const found = participants.find(
      (p) => p.username !== null && p.username.toLowerCase() === handle.toLowerCase(),
    );
    return found ? found.code : PII_MARKERS.unknownUser;
  });
}

function replaceCardNumbers(text: string): string {
  return text.replace(CARD_RE, PII_MARKERS.requisites);
}

function replacePhones(text: string): string {
  return text.replace(PHONE_CANDIDATE_RE, (match: string) => {
    const digitCount = match.replace(/\D/gu, '').length;
    return digitCount >= PHONE_MIN_DIGITS && digitCount <= PHONE_MAX_DIGITS ? PII_MARKERS.phone : match;
  });
}

function nameVariants(participant: ParticipantForLlm): string[] {
  return [participant.displayName, ...participant.aliases];
}

// "First Last" -> "First", only when the first name is a known display name
// or alias of the same participant whose last name follows. Must run before
// replaceStandaloneSurnames, which would otherwise swallow the last name on
// its own.
function replaceNameSurnamePairs(text: string, participants: readonly ParticipantForLlm[]): string {
  let result = text;
  for (const participant of participants) {
    const lastName = participant.lastName;
    if (!lastName) continue;
    for (const name of nameVariants(participant)) {
      const re = new RegExp(
        `${LEFT_BOUNDARY}(${escapeRegExp(name)})\\s+${escapeRegExp(lastName)}${RIGHT_BOUNDARY}`,
        'giu',
      );
      result = result.replace(re, (_match, firstName: string) => firstName);
    }
  }
  return result;
}

// Case-insensitive, exact match only — case declensions are not handled in
// the MVP (documented in `/privacy`).
function replaceStandaloneSurnames(text: string, participants: readonly ParticipantForLlm[]): string {
  let result = text;
  for (const participant of participants) {
    const lastName = participant.lastName;
    if (!lastName) continue;
    const re = new RegExp(`${LEFT_BOUNDARY}${escapeRegExp(lastName)}${RIGHT_BOUNDARY}`, 'giu');
    result = result.replace(re, participant.code);
  }
  return result;
}

/**
 * Strips PII from a message text before it is sent to the LLM (SPEC §19.3.2).
 * Order matters: URL → e-mail → @username → card/account numbers → phones →
 * surnames, so later steps never re-parse text a marker already replaced.
 * Third-party names (students) are intentionally left untouched — replacing
 * them badly hurts extraction quality (documented in `/privacy`).
 */
export function pseudonymizeText(text: string, participants: readonly ParticipantForLlm[]): string {
  let result = text;
  result = replaceUrls(result);
  result = replaceEmails(result);
  result = replaceUsernames(result, participants);
  result = replaceCardNumbers(result);
  result = replacePhones(result);
  result = replaceNameSurnamePairs(result, participants);
  result = replaceStandaloneSurnames(result, participants);
  return result;
}
