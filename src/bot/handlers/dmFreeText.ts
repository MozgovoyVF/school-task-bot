import type { Bot } from 'grammy';
import type { AppDeps } from '../../deps.js';
import { QUOTE_MAX_CHARS } from '../../config/constants.js';
import { can } from '../../domain/people/permissions.js';
import { createManualProposal } from '../../domain/proposals/repo.js';
import { extractSingle } from '../../ai/pipeline/extractSingle.js';
import { renderProposalCardForResend, markCardSent } from '../../scheduler/jobs/cards.js';
import { texts } from '../texts/ru.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import type { BotContext } from '../context.js';

export type DmFreeTextDeps = Pick<AppDeps, 'db' | 'ai' | 'workspace' | 'clock' | 'logger'>;

/** Truncates to `QUOTE_MAX_CHARS` *code points*, matching every other quote truncation in this codebase. */
function truncateQuote(text: string): string {
  const chars = Array.from(text);
  return chars.length <= QUOTE_MAX_CHARS ? text : chars.slice(0, QUOTE_MAX_CHARS).join('');
}

/**
 * The Owner's free text in DM, outside any active dialog (plan.md Task 3.10, SPEC §12.1): turned into a
 * `create` draft via `extractSingle` (D19) and `createManualProposal` (`origin='manual_dm'`), then rendered
 * and sent back *inline*, right here, rather than waiting on the next `cardsJob` outbox tick
 * (`src/scheduler/jobs/cards.ts`, Task 2.12) — the Owner is actively waiting on a reply to the message they
 * just typed, unlike the AI pipeline's own silent background detection. `markCardSent` right after keeps
 * the outbox from delivering this same proposal a second time later. Uses `bot.chatType('private')`
 * (rather than a manual `ctx.chat?.type` check) so a group message is never at risk of being swallowed by
 * this handler regardless of registration order relative to `registerGroupHandlers` — grammY's own
 * documented idiom for this (`bot.chatType("private").on(...)`).
 *
 * Deliberately skips, via `next()` rather than a bare `return` (a command handler, or `forwards.ts`, may
 * well be registered *after* this one and must still get the update — a bare `return` here would silently
 * swallow it for every handler below this one, grammY's documented middleware-chain behaviour): command
 * text (`/foo`, recognized or not — every real command has its own `bot.command(...)` handler elsewhere)
 * and a forwarded message (`src/bot/handlers/forwards.ts` owns those, D18).
 *
 * A Member's free text (D40: manual DM creation is Owner-only) gets a polite, fixed reply and no LLM call
 * at all — `extractSingle`/`createManualProposal` are never reached for them. This one *is* a bare
 * `return` — fully handled, nothing else should also act on it.
 */
export function registerDmFreeTextHandler(bot: Bot<BotContext>, deps: DmFreeTextDeps): void {
  bot.chatType('private').on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return next(); // a command — real or unrecognized, neither is free text
    if (ctx.message.forward_origin !== undefined) return next(); // forwards.ts owns these (D18)

    if (!can(ctx.state.actor, 'task.createDm')) {
      await ctx.reply(texts.manualTask.membersNotSupported, { parse_mode: 'HTML' });
      return;
    }
    const userId = ctx.state.actor.userId;
    if (userId === null) return; // should not happen once `can()` is true, defensive only

    const now = deps.clock.now();
    const action = await extractSingle(deps, {
      text,
      authorUserId: userId,
      workspaceId: deps.workspace.id,
      now,
    });

    const inserted = await createManualProposal(deps.db, {
      workspaceId: deps.workspace.id,
      chatId: null,
      action,
      origin: 'manual_dm',
      sourceMessageIds: [],
      quote: truncateQuote(text),
      quoteAuthorName: null,
      // D46: the quote is the Owner's own DM text (D40: this handler is Owner-only) — `userId` is the
      // actual author, even though `quoteAuthorName` stays `null` here (an unrelated, pre-existing
      // display-only decision for this handler, not touched by this change).
      quoteAuthorUserId: userId,
      createdByUserId: userId,
      now,
    });

    const render = await renderProposalCardForResend(deps, inserted);
    if (render === null) {
      // Should not happen for a fresh `create` proposal this call just inserted — defensive fallback: it
      // still exists and will be delivered by the next `cardsJob` outbox tick instead of inline.
      deps.logger.error({ proposalId: inserted.id }, 'dmFreeText: failed to render the draft card inline');
      return;
    }
    const sent = await ctx.reply(render.text, {
      parse_mode: 'HTML',
      reply_markup: toInlineKeyboard(render.buttons),
    });
    await markCardSent(deps.db, inserted.id, now, sent.message_id);
  });
}
