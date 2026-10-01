import type { Bot } from 'grammy';
import { PAGE_SIZE } from '../../config/constants.js';
import type { Db } from '../../db/client.js';
import type { Logger } from '../../ops/logger.js';
import type { Messenger, Buttons } from '../../domain/messenger.js';
import type { WorkspaceRow } from '../../domain/workspaces/repo.js';
import { can } from '../../domain/people/permissions.js';
import { listPendingProposals, type PendingProposalListItem } from '../../domain/proposals/queries.js';
import { getProposalById } from '../../domain/proposals/repo.js';
import { renderProposalCardForResend } from '../../scheduler/jobs/cards.js';
import { texts } from '../texts/ru.js';
import { decodeCallback, encodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import type { BotContext } from '../context.js';

export interface InboxHandlersDeps {
  db: Db;
  messenger: Messenger;
  logger: Logger;
  workspace: WorkspaceRow;
}

const KIND_ICON: Record<PendingProposalListItem['kind'], string> = {
  create: texts.inbox.kindCreateIcon,
  update: texts.inbox.kindUpdateIcon,
  complete: texts.inbox.kindCompleteIcon,
  cancel: texts.inbox.kindCancelIcon,
};

interface InboxListView {
  text: string;
  buttons: Buttons;
}

/**
 * Pure-ish render for one `/inbox` page (`page` 0-indexed, matching the `v1:p:nbx:<page>` callback's
 * `id`): a button per proposal (`v1:p:snd:<proposalId>`, "press to resend" the full card) plus a
 * prev/next row when there is more than one page. Kept local to this handler (not `bot/views/`, unlike
 * most other list views) since this task's file list has no new `bot/views/inbox.ts` — see the
 * `/inbox`+`/debug`+`/reanalyze` brief.
 */
function renderInboxList(items: PendingProposalListItem[], page: number, totalPages: number): InboxListView {
  if (items.length === 0) return { text: texts.inbox.empty, buttons: [] };

  const text = [texts.inbox.header, texts.inbox.pageFooter(page + 1, totalPages)].join('\n');
  const buttons: Buttons = items.map((item) => [
    {
      text: texts.inbox.itemButton(KIND_ICON[item.kind], item.title, item.chatTitle),
      data: encodeCallback({ entity: 'p', action: 'snd', id: item.id }),
    },
  ]);

  if (totalPages > 1) {
    const navRow: Buttons[number] = [];
    if (page > 0) {
      navRow.push({
        text: texts.inbox.prevButton,
        data: encodeCallback({ entity: 'p', action: 'nbx', id: page - 1 }),
      });
    }
    if (page < totalPages - 1) {
      navRow.push({
        text: texts.inbox.nextButton,
        data: encodeCallback({ entity: 'p', action: 'nbx', id: page + 1 }),
      });
    }
    if (navRow.length > 0) buttons.push(navRow);
  }

  return { text, buttons };
}

async function loadInboxPage(deps: InboxHandlersDeps, page: number): Promise<InboxListView> {
  const { items, total } = await listPendingProposals(deps.db, deps.workspace.id, {
    page: page + 1,
    pageSize: PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return renderInboxList(items, page, totalPages);
}

/** Redraws the message a `v1:p:nbx:*` callback came from with `view`. A no-op if the callback carries no `message` (mirrors `bot/handlers/chats.ts`'s `renderInto`). */
async function renderInto(deps: InboxHandlersDeps, ctx: BotContext, view: InboxListView): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  await deps.messenger.edit(msg.chat.id, msg.message_id, view.text, { buttons: view.buttons });
}

const KNOWN_ACTIONS = new Set(['nbx', 'snd']);

/**
 * Registers `/inbox` (SPEC §12.2's row, Owner only — D40) and the `v1:p:nbx`/`v1:p:snd` callbacks its
 * list uses: `nbx` (re)draws a page (`id` is the 0-indexed page number — also the id
 * `src/scheduler/jobs/cards.ts`'s quiet-hours `texts.cards.openInboxButton` already encodes as its forward
 * reference, `v1:p:nbx:0`, i.e. "open page 0"), `snd` resends one proposal's card as a fresh DM message
 * (`renderProposalCardForResend`, `src/scheduler/jobs/cards.ts`) — never edits it into the list.
 *
 * Registered in `src/bot/bot.ts` *before* `registerGroupHandlers` — required for the `/inbox` command
 * half to work in DM at all (its own doc comment there explains why); the `v1:p:*` callback half has no
 * such constraint relative to `registerProposalCallbackHandlers` (registered later, on the same
 * `/^v1:p:/` pattern): whichever of the two runs first, it falls through to `next()` for any action
 * outside its own `KNOWN_ACTIONS` (this file's `nbx`/`snd`, or `proposalCallbacks.ts`'s
 * `acc`/`rej`/`rjr`/`apl`/`dup`/`dpm`/`dpa`), so the other one still sees it.
 *
 * `proposal.receive` (Owner only) is checked once, immediately after decoding and before any branch —
 * `callback_data` is never trusted (CLAUDE.md §8) — via `ctx.state.actor`, resolved fresh from the DB on
 * every update, same as `proposalCallbacks.ts`'s own `proposal.decide` check.
 */
export function registerInboxHandlers(bot: Bot<BotContext>, deps: InboxHandlersDeps): void {
  bot.command('inbox', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!can(ctx.state.actor, 'proposal.receive')) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const view = await loadInboxPage(deps, 0);
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      ...(view.buttons.length > 0 ? { reply_markup: toInlineKeyboard(view.buttons) } : {}),
    });
  });

  bot.callbackQuery(/^v1:p:/, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded || !KNOWN_ACTIONS.has(decoded.action)) {
      await next();
      return;
    }

    if (!can(ctx.state.actor, 'proposal.receive')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }

    if (decoded.action === 'nbx') {
      const view = await loadInboxPage(deps, decoded.id);
      await ctx.answerCallbackQuery();
      await renderInto(deps, ctx, view);
      return;
    }

    // decoded.action === 'snd': resend one proposal's card as a fresh DM message.
    const proposal = await getProposalById(deps.db, decoded.id);
    if (!proposal || proposal.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: texts.inbox.noLongerPending });
      return;
    }
    const card = await renderProposalCardForResend(deps, proposal);
    if (!card) {
      await ctx.answerCallbackQuery({ text: texts.inbox.cardUnavailable });
      return;
    }
    await deps.messenger.send(ctx.chat.id, card.text, { buttons: card.buttons });
    await ctx.answerCallbackQuery({ text: texts.inbox.resent });
  });
}
