/**
 * Deep link to a specific message inside a Telegram supergroup (SPEC
 * §11.1): `https://t.me/c/<chat id without its -100 prefix>/<message id>`.
 * Ordinary (non-super) groups have no such link — Telegram only exposes
 * `t.me/c/...` links for supergroups/channels — so `proposalCard.ts` shows
 * only the quote for those (`messageLink` returning `null` is the signal to
 * omit the link line entirely).
 */
export function messageLink(
  chat: { type: 'group' | 'supergroup'; tgChatId: number },
  tgMessageId: number,
): string | null {
  if (chat.type !== 'supergroup') return null;

  // A supergroup/channel's `tg_chat_id` is always the "real" chat id
  // prefixed with the literal `-100` (SPEC §11.1, `docs/agents/reference.md`
  // §3) — stripping that 4-character prefix off the id's decimal string
  // recovers the id `t.me/c/...` expects. If some future non-standard id
  // doesn't have that prefix, there is no known link format for it, so this
  // falls back to `null` rather than emitting a broken link.
  const raw = String(chat.tgChatId);
  if (!raw.startsWith('-100')) return null;

  return `https://t.me/c/${raw.slice(4)}/${String(tgMessageId)}`;
}
