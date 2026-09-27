import type {
  CallbackQuery,
  Chat,
  ChatMemberUpdated,
  Message,
  MessageEntity,
  Update,
  User,
} from 'grammy/types';

/**
 * Minimal-but-valid Telegram `Update` factories for `bot.handleUpdate()` in
 * bot tests (`tests/helpers/botHarness.ts`). Not every factory is exercised
 * by Task 0.7's own tests, but all of them must type-check and produce
 * structurally valid updates now, since later tasks import them directly.
 */

export interface TgUserLike {
  id: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  isBot?: boolean;
}

export interface TgChatLike {
  id: number;
  type: 'group' | 'supergroup';
  title?: string;
}

/** The bot's own identity for `botAdded`/`botRemoved`; match this in `createBotHarness`'s default `botInfo`. */
export const DEFAULT_BOT_USER: TgUserLike = {
  id: 100000001,
  firstName: 'Test Bot',
  username: 'school_task_test_bot',
  isBot: true,
};

// Fixed (not clock-derived) Unix timestamps for Telegram's `date`/`edit_date` fields: these updates are
// test fixtures, not domain logic under test, so a stable constant keeps the fixtures fully deterministic.
const FIXED_UNIX_DATE = 1_700_000_000;

let nextUpdateId = 1_000_000;
let nextMessageId = 1;

function updateId(): number {
  return nextUpdateId++;
}

function messageId(): number {
  return nextMessageId++;
}

function toUser(from: TgUserLike): User {
  return {
    id: from.id,
    is_bot: from.isBot ?? false,
    first_name: from.firstName ?? 'Test',
    last_name: from.lastName,
    username: from.username,
  };
}

function privateChat(from: TgUserLike): Chat.PrivateChat {
  return {
    id: from.id,
    type: 'private',
    first_name: from.firstName ?? 'Test',
    last_name: from.lastName,
    username: from.username,
  };
}

type NonChannelChat = Chat.PrivateChat | Chat.GroupChat | Chat.SupergroupChat;
/** Fields callers may override via `extra`; identity fields (`chat`/`from`/`message_id`/`date`) stay controlled. */
type MessageExtra = Partial<Omit<Message, 'chat' | 'from' | 'message_id' | 'date'>>;

function groupChat(chat: TgChatLike): Chat.GroupChat | Chat.SupergroupChat {
  return chat.type === 'supergroup'
    ? { id: chat.id, type: 'supergroup', title: chat.title ?? 'Test group' }
    : { id: chat.id, type: 'group', title: chat.title ?? 'Test group' };
}

// grammY's `bot.command()` matches on a `bot_command` entity (see `context.js`'s `Context.has.command`),
// not by parsing `text` itself — Telegram clients always attach this entity for real commands, so fixture
// messages need one too, unless `extra.entities` overrides it.
const COMMAND_PATTERN = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?/;

function commandEntities(text: string): MessageEntity[] | undefined {
  const match = COMMAND_PATTERN.exec(text);
  return match ? [{ type: 'bot_command', offset: 0, length: match[0].length }] : undefined;
}

function baseMessage(chat: NonChannelChat, from: TgUserLike, text: string, extra?: MessageExtra) {
  return {
    message_id: messageId(),
    date: FIXED_UNIX_DATE,
    chat,
    from: toUser(from),
    text,
    entities: commandEntities(text),
    ...extra,
  };
}

/** A private-chat text message from `from` to the bot. */
export function dmText(from: TgUserLike, text: string, extra?: MessageExtra): Update {
  return { update_id: updateId(), message: baseMessage(privateChat(from), from, text, extra) };
}

/** A text message from `from` in a group/supergroup `chat`. */
export function groupText(chat: TgChatLike, from: TgUserLike, text: string, extra?: MessageExtra): Update {
  return { update_id: updateId(), message: baseMessage(groupChat(chat), from, text, extra) };
}

/** A group/supergroup text message that was edited after being sent. */
export function editedGroupText(
  chat: TgChatLike,
  from: TgUserLike,
  text: string,
  extra?: MessageExtra,
): Update {
  const message = baseMessage(groupChat(chat), from, text, extra);
  return { update_id: updateId(), edited_message: { ...message, edit_date: FIXED_UNIX_DATE + 100 } };
}

/** A private-chat message forwarded from `from`'s own earlier message (SPEC §7.4's forwards-to-DM flow). */
export function forwardedDm(from: TgUserLike, text: string, extra?: MessageExtra): Update {
  const message = baseMessage(privateChat(from), from, text, extra);
  return {
    update_id: updateId(),
    message: {
      ...message,
      forward_origin: { type: 'user', date: FIXED_UNIX_DATE - 60, sender_user: toUser(from) },
    },
  };
}

/**
 * The DM message a bot's own keyboard would have been attached to, in the private chat with `chat`
 * (its `id` equals `chat.id` — a DM's chat id is the user's own Telegram id). Real callback queries
 * for a bot-sent keyboard always carry this (`callback_query.message`) — grammY's `ctx.chat` reads
 * it (`ctx.msg?.chat`), and `@grammyjs/conversations`' default session storage keys off `ctx.chat.id`,
 * so a `callback()` update meant to resume an active DM conversation needs this as its `message`.
 */
export function botKeyboardMessage(chat: TgUserLike): Message {
  return baseMessage(privateChat(chat), DEFAULT_BOT_USER, '');
}

/** A callback query from an inline keyboard button, optionally attached to the originating `message`. */
export function callback(from: TgUserLike, data: string, message?: Message): Update {
  const query: CallbackQuery = {
    id: String(updateId()),
    from: toUser(from),
    chat_instance: 'test-chat-instance',
    data,
    message,
  };
  return { update_id: updateId(), callback_query: query };
}

function chatMemberUpdate(
  chat: TgChatLike,
  by: TgUserLike,
  oldStatus: 'left' | 'member',
  newStatus: 'left' | 'member',
): ChatMemberUpdated {
  return {
    chat: groupChat(chat),
    from: toUser(by),
    date: FIXED_UNIX_DATE + 200,
    old_chat_member: { status: oldStatus, user: toUser(DEFAULT_BOT_USER) },
    new_chat_member: { status: newStatus, user: toUser(DEFAULT_BOT_USER) },
  };
}

/** The bot (`DEFAULT_BOT_USER`) was added to `chat` by `by`. */
export function botAdded(chat: TgChatLike, by: TgUserLike): Update {
  return { update_id: updateId(), my_chat_member: chatMemberUpdate(chat, by, 'left', 'member') };
}

/** The bot (`DEFAULT_BOT_USER`) was removed from `chat` by `by`. */
export function botRemoved(chat: TgChatLike, by: TgUserLike): Update {
  return { update_id: updateId(), my_chat_member: chatMemberUpdate(chat, by, 'member', 'left') };
}
