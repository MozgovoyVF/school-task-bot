import type { Message, User } from 'grammy/types';
import { QUOTE_MAX_CHARS } from '../../config/constants.js';
import { texts } from '../texts/ru.js';

/**
 * A normalized incoming Telegram message, ready to be classified (stage 0,
 * `src/ai/pipeline/heuristics.ts`) and saved (plan.md Task 1.8). Produced by
 * {@link normalizeIncoming}, which returns `null` for anything SPEC §7.2 says
 * to ignore outright.
 */
export interface IncomingMessage {
  tgChatId: number;
  tgMessageId: number;
  from: { id: number; first_name: string; last_name?: string; username?: string; is_bot: boolean };
  sentAt: Date;
  text: string;
  replyToTgMessageId: number | null;
  replyQuote: string | null;
  isForward: boolean;
  forwardOriginName: string | null;
  isTaskCommand: boolean;
  commandArgs: string | null;
}

/** `/command` or `/command@botname [args]`, command name and args each captured — anchored to the whole text. */
const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:[ \t]+([\s\S]*))?$/;

type ParsedCommand = { name: string; args: string | null };

/**
 * Parses a leading Telegram bot command out of `text`. Returns `null` when
 * `text` isn't a command at all (plain text) — distinct from a command that
 * *is* recognized but not ours (`@other_bot`), which the caller must drop
 * the whole message for (SPEC §7.2: every command other than `/task` is
 * ignored).
 */
function parseCommand(text: string, botUsername: string): ParsedCommand | 'not-a-command' | 'other-bot' {
  const match = COMMAND_RE.exec(text);
  if (!match) return 'not-a-command';
  const name = match[1] ?? '';
  const mentionedBot = match[2];
  const argsRaw = match[3];
  if (mentionedBot !== undefined && mentionedBot.toLowerCase() !== botUsername.toLowerCase()) {
    return 'other-bot';
  }
  const args = argsRaw !== undefined && argsRaw.trim().length > 0 ? argsRaw.trim() : null;
  return { name: name.toLowerCase(), args };
}

/** `texts.media`'s bracketed label for a message's media type, or `null` for a plain text message (SPEC §7.2). */
function mediaLabel(msg: Message): string | null {
  if (msg.animation) return texts.media.gif;
  if (msg.video) return texts.media.video;
  if (msg.audio) return texts.media.audio;
  if (msg.document) return texts.media.document;
  if (msg.photo) return texts.media.photo;
  return null;
}

/** `first_name`, plus ` last_name` when present — used for a forwarded message's `sender_user` origin. */
function formatUserName(user: User): string {
  return user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name;
}

/** `forward_origin`'s display name (SPEC §7.2: the name from `forward_origin`, when available), or `null` if not forwarded. */
function forwardOriginName(msg: Message): string | null {
  const origin = msg.forward_origin;
  if (!origin) return null;
  switch (origin.type) {
    case 'user':
      return formatUserName(origin.sender_user);
    case 'hidden_user':
      return origin.sender_user_name;
    case 'chat':
      return origin.sender_chat.title ?? null;
    case 'channel':
      return origin.chat.title;
  }
}

/** Truncates to `QUOTE_MAX_CHARS` *code points* (not UTF-16 units), matching `classifyForAnalysis`'s length rule. */
function truncateQuote(text: string): string {
  const chars = Array.from(text);
  return chars.length <= QUOTE_MAX_CHARS ? text : chars.slice(0, QUOTE_MAX_CHARS).join('');
}

/**
 * The message's reply target: `replyToTgMessageId`/`replyQuote` (SPEC §7.2).
 * A reply to a forum topic's own "topic created" service message doesn't
 * count as a reply at all (D26) — `reply_to_message.forum_topic_created`
 * means the original message just anchors the topic, it wasn't authored by
 * anyone the reply is actually addressing.
 */
function resolveReply(msg: Message): { replyToTgMessageId: number | null; replyQuote: string | null } {
  const original = msg.reply_to_message;
  if (!original || original.forum_topic_created) {
    return { replyToTgMessageId: null, replyQuote: null };
  }
  if (msg.quote) {
    return { replyToTgMessageId: original.message_id, replyQuote: truncateQuote(msg.quote.text) };
  }
  const originalText = original.text ?? original.caption ?? null;
  return {
    replyToTgMessageId: original.message_id,
    replyQuote: originalText === null ? null : truncateQuote(originalText),
  };
}

/**
 * Normalizes a raw Telegram `Message` into an {@link IncomingMessage}, or
 * `null` for anything SPEC §7.2 says to ignore outright: messages from bots,
 * service messages, commands other than `/task` (including `/task` sent to
 * a different bot in the same group), and messages with neither `text` nor
 * `caption`. Does not truncate `text` — the 2000-character cap for analysis
 * input is applied later, only in `buildInput` (plan.md Task 1.7 step 3,
 * case 10); the DB and this function always keep the full text.
 */
export function normalizeIncoming(msg: Message, botUsername: string): IncomingMessage | null {
  if (!msg.from || msg.from.is_bot) return null;

  const label = mediaLabel(msg);
  let text: string;
  let isTaskCommand = false;
  let commandArgs: string | null = null;

  if (label !== null) {
    text = msg.caption ? `${label} ${msg.caption}` : label;
  } else if (msg.text !== undefined) {
    const parsed = parseCommand(msg.text, botUsername);
    if (parsed === 'other-bot') return null;
    if (parsed !== 'not-a-command') {
      if (parsed.name !== 'task') return null;
      isTaskCommand = true;
      commandArgs = parsed.args;
    }
    text = msg.text;
  } else {
    return null;
  }

  const { replyToTgMessageId, replyQuote } = resolveReply(msg);

  return {
    tgChatId: msg.chat.id,
    tgMessageId: msg.message_id,
    from: {
      id: msg.from.id,
      first_name: msg.from.first_name,
      last_name: msg.from.last_name,
      username: msg.from.username,
      is_bot: msg.from.is_bot,
    },
    sentAt: new Date(msg.date * 1000),
    text,
    replyToTgMessageId,
    replyQuote,
    isForward: msg.forward_origin !== undefined,
    forwardOriginName: forwardOriginName(msg),
    isTaskCommand,
    commandArgs,
  };
}
