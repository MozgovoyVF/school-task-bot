import type { Bot } from 'grammy';
import type { Message } from 'grammy/types';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import type { Logger } from '../../ops/logger.js';
import type { WorkspaceRow } from '../../domain/workspaces/repo.js';
import { getChatByTgId, type ChatRow } from '../../domain/chats/repo.js';
import { applyEdit, saveIncomingMessage } from '../../domain/chats/messages.js';
import { ensureMembership, upsertTelegramUser } from '../../domain/people/repo.js';
import { classifyForAnalysis } from '../../ai/pipeline/heuristics.js';
import { normalizeIncoming, type IncomingMessage } from './normalize.js';
import type { BotContext } from '../context.js';

export interface GroupHandlersDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** The single default workspace (MVP, SPEC §5.2) every group message's author is a member of. */
  workspace: WorkspaceRow;
}

/**
 * `memberships.display_name`'s default (D28): the **first word** of
 * `first_name`. Telegram's `first_name` often carries a full name (first
 * plus last), and only the first name is ever sent to the LLM
 * (SPEC §19.3.2) — the Owner can still rename via `/people`.
 */
function defaultDisplayName(firstName: string): string {
  return firstName.trim().split(/\s+/)[0] ?? firstName;
}

/**
 * "Is this chat eligible for the bot to do anything with it beyond leaving
 * it alone?" (D12, binding — CLAUDE.md/plan.md): a `pending` chat is still
 * awaiting Owner approval, a `paused` chat had its bot presence explicitly
 * paused, and a `left` chat (or no row at all, e.g. before `my_chat_member`
 * has been processed) means the bot isn't really "in" it. Only `active`
 * chats reach any further handling — including the `/task` stub below,
 * which is why this check happens before branching on `isTaskCommand`, not
 * after.
 */
function isChatActive(chat: ChatRow | null): chat is ChatRow {
  return chat !== null && chat.status === 'active';
}

/**
 * Registers the group message intake handlers (SPEC §7.2, plan.md Task
 * 1.8): `message` for new messages, `edited_message` for edits. Both share
 * the same eligibility gate (`isChatActive`) and `normalizeIncoming` call;
 * `handleIncoming`/`handleEdit` below are exported only for this file's own
 * reuse across the two listeners, not part of this task's public
 * interface (`saveIncomingMessage`/`applyEdit` are that surface).
 */
export function registerGroupHandlers(bot: Bot<BotContext>, deps: GroupHandlersDeps): void {
  bot.on('message', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;
    await handleIncoming(deps, ctx.chat.id, ctx.message, ctx.me.username);
  });

  bot.on('edited_message', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;
    await handleEdit(deps, ctx.chat.id, ctx.editedMessage, ctx.me.username);
  });
}

async function handleIncoming(
  deps: GroupHandlersDeps,
  tgChatId: number,
  msg: Message,
  botUsername: string,
): Promise<void> {
  const chat = await getChatByTgId(deps.db, tgChatId);
  if (!isChatActive(chat)) return;

  const incoming = normalizeIncoming(msg, botUsername);
  if (!incoming) return; // bot/service message, a command other than /task, or neither text nor caption

  if (incoming.isTaskCommand) {
    // Task 3.10's handler owns /task for real; before phase 3 this is a logging-only stub
    // (plan.md Task 1.8 brief, case 12) — deliberately not gated on analysis_enabled (D12's
    // carried note: /task still works when a chat only has analysis turned off).
    deps.logger.debug({ chatId: chat.id }, 'group: /task received (stub — Task 3.10 not implemented yet)');
    return;
  }

  if (!chat.analysisEnabled) return; // analysis_enabled=false: intake is off, but /task above still ran

  await saveMessage(deps, chat, incoming);
}

async function saveMessage(deps: GroupHandlersDeps, chat: ChatRow, incoming: IncomingMessage): Promise<void> {
  const author = await upsertTelegramUser(deps.db, incoming.from);
  await ensureMembership(deps.db, {
    workspaceId: deps.workspace.id,
    userId: author.id,
    displayName: defaultDisplayName(incoming.from.first_name),
  });

  const status = classifyForAnalysis(incoming.text);
  await saveIncomingMessage(deps.db, { chat, incoming, authorUserId: author.id, status });
}

async function handleEdit(
  deps: GroupHandlersDeps,
  tgChatId: number,
  msg: Message,
  botUsername: string,
): Promise<void> {
  const chat = await getChatByTgId(deps.db, tgChatId);
  if (!isChatActive(chat)) return;

  const incoming = normalizeIncoming(msg, botUsername);
  if (!incoming) return;

  const editedAt = msg.edit_date !== undefined ? new Date(msg.edit_date * 1000) : deps.clock.now();

  const result = await applyEdit(deps.db, {
    chatId: chat.id,
    tgMessageId: incoming.tgMessageId,
    text: incoming.text,
    editedAt,
  });

  if (result === 'updated_analyzed') {
    deps.logger.debug(
      { chatId: chat.id },
      'group: edited an already-analyzed message — text updated, not re-analyzed (MVP)',
    );
  }
}
