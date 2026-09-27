import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { Button, Buttons } from '../../domain/messenger.js';

function toInlineKeyboardButton(button: Button): InlineKeyboardButton {
  if (button.url !== undefined) return InlineKeyboard.url(button.text, button.url);
  if (button.data !== undefined) return InlineKeyboard.text(button.text, button.data);
  throw new Error('button must have either "data" or "url"');
}

/**
 * Builds a grammY `InlineKeyboard` from the domain-level, grammY-free
 * `Buttons` type (`src/domain/messenger.ts`). `data` must already be an
 * encoded `callback_data` string from `encodeCallback` (`callbackCodec.ts`).
 */
export function toInlineKeyboard(buttons: Buttons): InlineKeyboard {
  return InlineKeyboard.from(buttons.map((row) => row.map(toInlineKeyboardButton)));
}
