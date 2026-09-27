import type { Bot } from 'grammy';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import type { Logger } from '../../ops/logger.js';
import type { Env } from '../../config/env.js';
import type { Messenger } from '../../domain/messenger.js';
import type { WorkspaceRow } from '../../domain/workspaces/repo.js';
import {
  approveChat,
  migrateChat,
  onBotAdded,
  onBotRemoved,
  rejectChat,
  type ChatLifecycleDeps,
} from '../../domain/chats/lifecycle.js';
import { texts } from '../texts/ru.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import type { BotContext } from '../context.js';

export interface ChatMemberHandlersDeps {
  db: Db;
  messenger: Messenger;
  clock: Clock;
  logger: Logger;
  config: Pick<Env, 'SUPERADMIN_TG_IDS'>;
  workspace: WorkspaceRow;
}

function toLifecycleDeps(deps: ChatMemberHandlersDeps): ChatLifecycleDeps {
  return {
    db: deps.db,
    messenger: deps.messenger,
    clock: deps.clock,
    logger: deps.logger,
    superadminIds: deps.config.SUPERADMIN_TG_IDS,
    workspace: deps.workspace,
  };
}

/** `ChatMember.status` values that count as "the bot is in the chat" — everything else is "not in it". */
const ACTIVE_MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

function isActiveMemberStatus(status: string): boolean {
  return ACTIVE_MEMBER_STATUSES.has(status);
}

/**
 * Registers the group chat lifecycle handlers (SPEC §15, plan.md Task 1.6):
 * - `my_chat_member`: the bot's own membership changed. An "added" edge
 *   (was not in the chat, now is) calls `onBotAdded`; a "removed" edge
 *   (was in the chat, now is not — `kicked` or `left`) calls `onBotRemoved`.
 *   Every other transition (e.g. promoted to administrator) is a no-op —
 *   SPEC's lifecycle only cares about "in" vs. "not in".
 * - `message:migrate_to_chat_id`: a group → supergroup upgrade
 *   (CLAUDE.md §12) — updates the same `chats` row's `tg_chat_id`/`type`.
 * - `v1:c:*` callbacks: the approve/leave buttons (`texts.chats.approveButton`/
 *   `.leaveButton`) on the approval card (`bot/views/chatApproval.ts`).
 *   DM-only, same as `/transfer`'s
 *   `v1:o:*` (`src/bot/handlers/transfer.ts`) — the card is only ever sent
 *   via DM, so a group-posted callback with this data is always a forgery.
 *   Permission (`chat.approve`) is re-checked inside `approveChat`/`rejectChat`
 *   themselves (CLAUDE.md §8: callback_data is never trusted on its own).
 */
export function registerChatMemberHandlers(bot: Bot<BotContext>, deps: ChatMemberHandlersDeps): void {
  const lifecycleDeps = toLifecycleDeps(deps);

  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const chat = update.chat;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;

    const wasActive = isActiveMemberStatus(update.old_chat_member.status);
    const isNowActive = isActiveMemberStatus(update.new_chat_member.status);

    if (!wasActive && isNowActive) {
      await onBotAdded(lifecycleDeps, {
        tgChat: { id: chat.id, title: chat.title, type: chat.type },
        addedByTgUserId: update.from.id,
      });
      return;
    }

    if (wasActive && !isNowActive) {
      await onBotRemoved(lifecycleDeps, chat.id);
    }
  });

  bot.on('message:migrate_to_chat_id', async (ctx) => {
    await migrateChat(deps.db, ctx.chat.id, ctx.message.migrate_to_chat_id);
  });

  bot.callbackQuery(/^v1:c:/, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded || (decoded.action !== 'apr' && decoded.action !== 'rej')) {
      await ctx.answerCallbackQuery();
      return;
    }

    const result =
      decoded.action === 'apr'
        ? await approveChat(lifecycleDeps, decoded.id, ctx.state.actor)
        : await rejectChat(lifecycleDeps, decoded.id, ctx.state.actor);

    if (!result.ok) {
      await ctx.answerCallbackQuery(result.reason === 'forbidden' ? { text: texts.common.forbidden } : undefined);
      return;
    }
    await ctx.answerCallbackQuery();
  });
}
