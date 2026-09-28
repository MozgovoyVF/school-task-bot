import { describe, it, expect } from 'vitest';
import { InlineKeyboard } from 'grammy';
import { toInlineKeyboard, InvalidButtonError } from '../../../src/bot/keyboards/build.js';
import type { Buttons } from '../../../src/domain/messenger.js';

describe('toInlineKeyboard', () => {
  it('builds a grammY InlineKeyboard from data and url buttons, row by row', () => {
    const buttons: Buttons = [
      [
        { text: 'Принять', data: 'v1:p:acc:1' },
        { text: 'Отклонить', data: 'v1:p:rej:1' },
      ],
      [{ text: 'Открыть', url: 'https://t.me/c/123/1' }],
    ];

    const keyboard = toInlineKeyboard(buttons);

    expect(keyboard).toBeInstanceOf(InlineKeyboard);
    expect(keyboard.inline_keyboard).toEqual([
      [
        { text: 'Принять', callback_data: 'v1:p:acc:1' },
        { text: 'Отклонить', callback_data: 'v1:p:rej:1' },
      ],
      [{ text: 'Открыть', url: 'https://t.me/c/123/1' }],
    ]);
  });

  it('builds an empty keyboard from no rows', () => {
    expect(toInlineKeyboard([]).inline_keyboard).toEqual([]);
  });

  it('throws when a button has neither data nor url', () => {
    const buttons = [[{ text: 'Bad' }]] as Buttons;
    expect(() => toInlineKeyboard(buttons)).toThrow(InvalidButtonError);
  });
});
