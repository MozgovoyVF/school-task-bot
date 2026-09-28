import { DEFAULT_STOP_LIST, COMPLETION_SIGNALS } from '../../config/constants.js';

/**
 * Punctuation (`\p{P}`) plus whitespace, anchored at either edge — used to
 * strip surrounding punctuation (plan.md Task 1.7 step 3: normalize, then
 * strip edge punctuation). Deliberately excludes `\p{S}` (symbols, which
 * covers emoji): an edge emoji must survive normalization so it can still
 * match a stop-list entry that itself ends in an emoji, or be caught by
 * {@link PURE_EMOJI_OR_PUNCTUATION_RE} below rather than silently
 * disappearing here.
 */
const EDGE_PUNCTUATION_RE = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

/**
 * Matches a string made up of nothing but emoji/pictographs and punctuation
 * (SPEC §7.3: skip when the text consists only of emoji, a sticker, or
 * punctuation), per plan.md Task 1.7's exact class list. Deliberately does
 * NOT use `\p{Emoji_Component}`: that property also matches plain digits
 * (`0`-`9`, `#`, `*`), which would wrongly classify text like `15:00` as
 * pure emoji (CLAUDE.md §12).
 */
const PURE_EMOJI_OR_PUNCTUATION_RE =
  // eslint-disable-next-line no-misleading-character-class -- ZWJ + VS16 are part of the class deliberately (plan.md Task 1.7 step 3's exact regex), not a typo
  /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️\p{P}\p{S}\s]+$/u;

/** NFC → lowercase → trim → collapse whitespace → strip edge punctuation (plan.md Task 1.7 step 3). */
function normalizeText(input: string): string {
  const collapsed = input.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
  return collapsed.replace(EDGE_PUNCTUATION_RE, '');
}

/** Strips edge punctuation from a single word, so a completion signal followed by a period/comma still matches. */
function stripWordPunctuation(word: string): string {
  return word.replace(EDGE_PUNCTUATION_RE, '');
}

/**
 * Stage 0 heuristic (SPEC §7.3): decides, before any LLM call, whether a
 * message's text is worth analyzing at all. Rule order (plan.md Task 1.7
 * step 3, must not be reordered):
 *   1. any word matches a completion signal → `'pending'` (never skipped,
 *      even if the rest of the message would otherwise be skipped);
 *   2. the whole normalized text matches the stop list → `'skipped'`;
 *   3. normalized length (code points, not UTF-16 units) < 3 → `'skipped'`;
 *   4. normalized text is only emoji/pictographs and punctuation → `'skipped'`;
 *   5. otherwise → `'pending'`.
 */
export function classifyForAnalysis(
  text: string,
  opts?: { stopList?: readonly string[]; completionSignals?: readonly string[] },
): 'pending' | 'skipped' {
  const stopList = opts?.stopList ?? DEFAULT_STOP_LIST;
  const completionSignals = opts?.completionSignals ?? COMPLETION_SIGNALS;

  const normalized = normalizeText(text);
  const words = normalized.length === 0 ? [] : normalized.split(' ').map(stripWordPunctuation);

  if (words.some((word) => completionSignals.includes(word))) return 'pending';
  if (stopList.includes(normalized)) return 'skipped';
  if (Array.from(normalized).length < 3) return 'skipped';
  if (PURE_EMOJI_OR_PUNCTUATION_RE.test(normalized)) return 'skipped';
  return 'pending';
}
