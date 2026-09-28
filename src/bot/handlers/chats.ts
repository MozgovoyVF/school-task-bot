import type { Bot } from 'grammy';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import type { Messenger } from '../../domain/messenger.js';
import type { WorkspaceRow } from '../../domain/workspaces/repo.js';
import { can } from '../../domain/people/permissions.js';
import {
  leaveChat,
  pauseChat,
  resumeChat,
  setAnalysis,
  setReactions,
  type ChatLifecycleDeps,
} from '../../domain/chats/lifecycle.js';
import { getChatById, listChatsForWorkspace } from '../../domain/chats/repo.js';
import { texts } from '../texts/ru.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { renderChatCard, renderChatList, renderLeaveConfirm, type ChatsView } from '../views/chats.js';
import type { BotContext } from '../context.js';

export interface ChatsHandlersDeps {
  db: Db;
  messenger: Messenger;
  clock: Clock;
  workspace: WorkspaceRow;
}

function toLifecycleDeps(deps: ChatsHandlersDeps): Pick<ChatLifecycleDeps, 'db' | 'clock' | 'messenger'> {
  return { db: deps.db, clock: deps.clock, messenger: deps.messenger };
}

/** Redraws the message a `v1:c:*` callback came from with `view`. A no-op if the callback carries no `message` (e.g. a very old keyboard). */
async function renderInto(deps: ChatsHandlersDeps, ctx: BotContext, view: ChatsView): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  await deps.messenger.edit(msg.chat.id, msg.message_id, view.text, { buttons: view.buttons });
}

/** `callback_data` actions this handler owns (`/chats`' management card, Task 1.9) — distinct from `apr`/`rej`, which stay `chatMember.ts`'s (the pending-approval card). */
const KNOWN_ACTIONS = new Set(['lst', 'opn', 'ana', 'rea', 'pau', 'res', 'lva', 'lvc']);

/**
 * Registers `/chats` (SPEC §12.2: Owner only — `chat.manage`, distinct from
 * `chat.approve`, which stays superadmin-or-Owner for Task 1.6's pending-chat
 * approve/reject and is *not* reused here) and the `v1:c:*` callbacks its
 * list/card keyboards use. DM-only, same reasoning as `/transfer`
 * (`transfer.ts`) and the pending-chat approval callbacks (`chatMember.ts`):
 * the list would leak every chat's title/status into a group otherwise, and
 * CLAUDE.md §12.2's "the bot only ever writes text in a group for
 * `/privacy`" rule.
 *
 * `bot.callbackQuery(/^v1:c:/, ...)` is also where `chatMember.ts` listens
 * for `apr`/`rej` — that handler runs first (registered earlier in
 * `bot.ts`) and calls `next()` for any other action, which is what reaches
 * this one. `chat.manage` is checked once, immediately after decoding and
 * before *any* branch — including the read-only `lst`/`opn`/`lva`
 * navigation actions, not only the five mutating ones — since CLAUDE.md §8
 * requires a DB-backed permission check on every callback and
 * `callback_data` is never trusted on its own: a forged `v1:c:lst:0` (or
 * `opn`/`lva` against any chat id) must not leak the chat list/a chat's
 * card/a leave prompt to someone who never had a `/chats` keyboard of their
 * own.
 */
export function registerChatsHandlers(bot: Bot<BotContext>, deps: ChatsHandlersDeps): void {
  bot.command('chats', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!can(ctx.state.actor, 'chat.manage')) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    const rows = await listChatsForWorkspace(deps.db, deps.workspace.id);
    const view = renderChatList(rows);
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      ...(view.buttons.length > 0 ? { reply_markup: toInlineKeyboard(view.buttons) } : {}),
    });
  });

  bot.callbackQuery(/^v1:c:/, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded || !KNOWN_ACTIONS.has(decoded.action)) {
      await next();
      return;
    }

    if (!can(ctx.state.actor, 'chat.manage')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }

    if (decoded.action === 'lst') {
      const rows = await listChatsForWorkspace(deps.db, deps.workspace.id);
      await ctx.answerCallbackQuery();
      await renderInto(deps, ctx, renderChatList(rows));
      return;
    }

    if (decoded.action === 'opn' || decoded.action === 'lva') {
      const chat = await getChatById(deps.db, decoded.id);
      await ctx.answerCallbackQuery();
      if (!chat) return;
      await renderInto(deps, ctx, decoded.action === 'opn' ? renderChatCard(chat) : renderLeaveConfirm(chat));
      return;
    }

    const lifecycleDeps = toLifecycleDeps(deps);
    const result =
      decoded.action === 'ana'
        ? await setAnalysis(lifecycleDeps, decoded.id, ctx.state.actor)
        : decoded.action === 'rea'
          ? await setReactions(lifecycleDeps, decoded.id, ctx.state.actor)
          : decoded.action === 'pau'
            ? await pauseChat(lifecycleDeps, decoded.id, ctx.state.actor)
            : decoded.action === 'res'
              ? await resumeChat(lifecycleDeps, decoded.id, ctx.state.actor)
              : await leaveChat(lifecycleDeps, decoded.id, ctx.state.actor);

    if (!result.ok) {
      // `chat.manage` was already re-checked above, so `result.reason` here is always the
      // domain function's own not-found/not-active/not-paused reason, never `forbidden`.
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    await renderInto(deps, ctx, renderChatCard(result.chat));
  });
}
