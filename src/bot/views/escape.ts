/**
 * Minimal HTML escaping for values interpolated into Telegram's
 * `parse_mode: 'HTML'` messages (CLAUDE.md's Telegram rule). Only `&`, `<`
 * and `>` need escaping for the HTML subset Telegram supports — none of the
 * strings this bot builds put user text inside an attribute, so quotes are
 * left alone. `&` must be replaced first, or a later `&lt;`/`&gt;` would
 * itself get re-escaped into `&amp;lt;`/`&amp;gt;`.
 *
 * `src/bot/texts/ru.ts` keeps its own private copy of this same logic for
 * its own (already Cyrillic-literal-holding) text functions; this exported
 * copy is what `bot/views/*` — starting with `proposalCard.ts` (Task
 * 2.11) — call directly on raw user/DB text (titles, quotes, names) before
 * handing already-escaped strings to `texts.proposalCard.*`'s pure
 * templates, per this task's split: `ru.ts` owns the Russian wording,
 * `views/` own escaping dynamic content into it.
 */
export function escapeHtml(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
