import { GrammyError, HttpError } from 'grammy';
import type { Api } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup, ReactionTypeEmoji } from 'grammy/types';
import type { Button, Buttons, Messenger, SendOptions } from '../domain/messenger.js';
import { MessengerError } from '../domain/messenger.js';

const NOT_MODIFIED_MARKER = 'message is not modified';
const CHAT_NOT_FOUND_MARKER = 'chat not found';

/**
 * Maps a grammY-thrown error to the domain-level {@link MessengerError}, per
 * the 5 cases fixed by the Task 0.7 brief (verified against grammY 1.46's
 * `GrammyError`/`HttpError` shapes in `node_modules/grammy/out/core/error.d.ts`,
 * Context7 being unable to surface the exact field list from prose docs):
 * - `error_code: 403` → `forbidden`
 * - `error_code: 429` (+ `parameters.retry_after`) → `rate_limited`
 * - `error_code: 400` with a "chat not found" description → `not_found`
 * - any other `GrammyError` → `other`
 * - `HttpError` (network-level) → `network`
 * - anything else → `other`
 *
 * The "message is not modified" 400 case is *not* handled here: per the
 * brief, `edit()` must treat it as success rather than throwing at all, so
 * that check lives inside `edit()`'s own `catch`, before it ever calls this
 * function.
 */
export function toMessengerError(e: unknown): MessengerError {
  if (e instanceof GrammyError) {
    if (e.error_code === 403) return new MessengerError('forbidden', e.description);
    if (e.error_code === 429) {
      return new MessengerError('rate_limited', e.description, e.parameters.retry_after);
    }
    if (e.error_code === 400 && e.description.toLowerCase().includes(CHAT_NOT_FOUND_MARKER)) {
      return new MessengerError('not_found', e.description);
    }
    return new MessengerError('other', e.description);
  }
  if (e instanceof HttpError) {
    return new MessengerError('network', e.message);
  }
  return new MessengerError('other', e instanceof Error ? e.message : String(e));
}

function isNotModifiedError(e: unknown): boolean {
  return (
    e instanceof GrammyError &&
    e.error_code === 400 &&
    e.description.toLowerCase().includes(NOT_MODIFIED_MARKER)
  );
}

function toInlineKeyboardButton(button: Button): InlineKeyboardButton {
  if (button.url !== undefined) return { text: button.text, url: button.url };
  if (button.data !== undefined) return { text: button.text, callback_data: button.data };
  throw new Error('button must have either "data" or "url"');
}

function toInlineKeyboard(buttons: Buttons): InlineKeyboardMarkup {
  return { inline_keyboard: buttons.map((row) => row.map(toInlineKeyboardButton)) };
}

/** Implements the domain `Messenger` (src/domain/messenger.ts) on top of a grammY `Api` instance. */
export function createGrammyMessenger(api: Api): Messenger {
  return {
    async send(chatId, text, opts?: SendOptions) {
      try {
        const message = await api.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          disable_notification: opts?.silent,
          reply_parameters:
            opts?.replyToMessageId !== undefined ? { message_id: opts.replyToMessageId } : undefined,
          reply_markup: opts?.buttons !== undefined ? toInlineKeyboard(opts.buttons) : undefined,
        });
        return { messageId: message.message_id };
      } catch (err) {
        throw toMessengerError(err);
      }
    },

    async edit(chatId, messageId, text, opts) {
      try {
        await api.editMessageText(chatId, messageId, text, {
          parse_mode: 'HTML',
          reply_markup: opts?.buttons !== undefined ? toInlineKeyboard(opts.buttons) : undefined,
        });
      } catch (err) {
        if (isNotModifiedError(err)) return;
        throw toMessengerError(err);
      }
    },

    async react(chatId, messageId, emoji) {
      try {
        const reaction: ReactionTypeEmoji[] =
          emoji === null ? [] : [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }];
        await api.setMessageReaction(chatId, messageId, reaction);
      } catch (err) {
        throw toMessengerError(err);
      }
    },

    async leaveChat(chatId) {
      try {
        await api.leaveChat(chatId);
      } catch (err) {
        throw toMessengerError(err);
      }
    },
  };
}
