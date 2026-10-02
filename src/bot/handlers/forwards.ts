import type { Bot } from 'grammy';
import type { AppDeps } from '../../deps.js';
import { FORWARD_BURST_MS, QUOTE_MAX_CHARS } from '../../config/constants.js';
import { can } from '../../domain/people/permissions.js';
import { createManualProposal } from '../../domain/proposals/repo.js';
import { extractSingle } from '../../ai/pipeline/extractSingle.js';
import { renderProposalCardForResend, markCardSent } from '../../scheduler/jobs/cards.js';
import { forwardOriginName } from './normalize.js';
import type { BotContext } from '../context.js';

export type ForwardsDeps = Pick<AppDeps, 'db' | 'ai' | 'workspace' | 'clock' | 'logger' | 'messenger'>;

function truncateQuote(text: string): string {
  const chars = Array.from(text);
  return chars.length <= QUOTE_MAX_CHARS ? text : chars.slice(0, QUOTE_MAX_CHARS).join('');
}

interface ForwardBuffer {
  authorUserId: number;
  tgChatId: number;
  /** One entry per buffered forward, in arrival order — joined into one combined text for `extractSingle`
   * once the burst window elapses. */
  texts: string[];
  /** The *first* forwarded message's own text and origin — D18/SPEC §12.1: the resulting draft quotes
   * only the first one, not every one. */
  firstText: string;
  firstAuthorName: string | null;
  timer: NodeJS.Timeout;
}

/**
 * A DM forward batch, flushed into one manual draft (plan.md Task 3.10, D18/D19, SPEC §12.1): forwarded
 * messages from the same DM chat arriving within {@link FORWARD_BURST_MS} of each other are combined into
 * one `extractSingle` call and one `createManualProposal` (`origin='forward'`); a gap of at least that long
 * starts a fresh draft instead. State is a plain in-memory `Map`, scoped to this registration call's own
 * closure (mirrors D16's conversation-state precedent: a restart loses an in-flight burst, nothing else —
 * no proposal or task data is ever held only here). Every forward resets the window's timer, so a burst of
 * N messages each under {@link FORWARD_BURST_MS} apart all land in one draft regardless of N.
 *
 * Reuses `src/bot/handlers/dmFreeText.ts`'s own "render and send the card inline, then `markCardSent`"
 * approach rather than waiting on the next outbox tick — same reasoning (the Owner is actively watching
 * this DM). Sends through `deps.messenger` (not `ctx.reply`): the flush itself runs from a bare `setTimeout`
 * callback, with no live `ctx` to reply through — `buffer.tgChatId` (the DM chat id, captured when the
 * burst started) is exactly what `Messenger.send`'s `chatId` expects for a private chat.
 *
 * Mirrors `dmFreeText.ts`'s own D40 gate: a Member's forward is silently ignored (no LLM call, no draft) —
 * manual DM creation is Owner-only.
 */
export function registerForwardsHandler(bot: Bot<BotContext>, deps: ForwardsDeps): void {
  const buffers = new Map<number, ForwardBuffer>();

  async function flush(tgChatId: number): Promise<void> {
    const buffer = buffers.get(tgChatId);
    if (!buffer) return;
    buffers.delete(tgChatId);

    try {
      const now = deps.clock.now();
      const combinedText = buffer.texts.join('\n\n');
      const action = await extractSingle(deps, {
        text: combinedText,
        authorUserId: buffer.authorUserId,
        workspaceId: deps.workspace.id,
        now,
      });

      const inserted = await createManualProposal(deps.db, {
        workspaceId: deps.workspace.id,
        chatId: null,
        action,
        origin: 'forward',
        sourceMessageIds: [],
        quote: truncateQuote(buffer.firstText),
        quoteAuthorName: buffer.firstAuthorName,
        createdByUserId: buffer.authorUserId,
        now,
      });

      const render = await renderProposalCardForResend(deps, inserted);
      if (render === null) {
        deps.logger.error({ proposalId: inserted.id }, 'forwards: failed to render the draft card inline');
        return;
      }
      const { messageId } = await deps.messenger.send(buffer.tgChatId, render.text, {
        buttons: render.buttons,
      });
      await markCardSent(deps.db, inserted.id, now, messageId);
    } catch (err) {
      deps.logger.error({ err, tgChatId }, 'forwards: failed to flush a forward batch');
    }
  }

  bot.chatType('private').on('message', (ctx, next) => {
    const msg = ctx.message;
    // `next()`, not a bare `return`: this uses the broad `message` filter (any message type, not just
    // text), so a non-forwarded private message — including every command — must still reach whatever is
    // registered after this handler (a bare `return` would silently swallow it, grammY's documented
    // middleware-chain behaviour).
    if (msg.forward_origin === undefined) return next();

    const text = msg.text ?? msg.caption ?? null;
    if (text === null) return; // a forwarded media message with no text/caption — nothing to extract

    if (!can(ctx.state.actor, 'task.createDm')) return; // D40: Owner-only, silently ignored for anyone else
    const userId = ctx.state.actor.userId;
    if (userId === null) return;

    const tgChatId = ctx.chat.id;
    const originName = forwardOriginName(msg);
    const existing = buffers.get(tgChatId);

    if (existing) {
      clearTimeout(existing.timer);
      existing.texts.push(text);
      existing.timer = setTimeout(() => void flush(tgChatId), FORWARD_BURST_MS);
      return;
    }

    buffers.set(tgChatId, {
      authorUserId: userId,
      tgChatId,
      texts: [text],
      firstText: text,
      firstAuthorName: originName,
      timer: setTimeout(() => void flush(tgChatId), FORWARD_BURST_MS),
    });
  });
}
