import { describe, it, expect } from 'vitest';
import type { Chat, Message } from 'grammy/types';
import { normalizeIncoming } from '../../../src/bot/handlers/normalize.js';

const BOT_USERNAME = 'school_bot';

const GROUP: Chat.SupergroupChat = { id: -100, type: 'supergroup', title: 'Учительская' };

function baseFields(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: GROUP,
    from: { id: 1, is_bot: false, first_name: 'Ольга' },
    ...overrides,
  };
}

describe('normalizeIncoming (SPEC §7.2)', () => {
  it('1. text message from a human → IncomingMessage with text and sentAt = date*1000', () => {
    const msg = baseFields({ text: 'привет всем' });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result).toEqual({
      tgChatId: -100,
      tgMessageId: 1,
      from: { id: 1, first_name: 'Ольга', last_name: undefined, username: undefined, is_bot: false },
      sentAt: new Date(1_700_000_000 * 1000),
      text: 'привет всем',
      replyToTgMessageId: null,
      replyQuote: null,
      isForward: false,
      forwardOriginName: null,
      isTaskCommand: false,
      commandArgs: null,
    });
  });

  it('2. from.is_bot → null', () => {
    const msg = baseFields({ text: 'привет', from: { id: 2, is_bot: true, first_name: 'Бот' } });
    expect(normalizeIncoming(msg, BOT_USERNAME)).toBeNull();
  });

  it('3. no text and no caption (sticker, new_chat_members) → null', () => {
    const sticker = baseFields({
      sticker: {
        file_id: 'f1',
        file_unique_id: 'u1',
        type: 'regular',
        width: 1,
        height: 1,
        is_animated: false,
        is_video: false,
      },
    });
    expect(normalizeIncoming(sticker, BOT_USERNAME)).toBeNull();

    const newMembers = baseFields({
      new_chat_members: [{ id: 3, is_bot: false, first_name: 'Новый' }],
    });
    expect(normalizeIncoming(newMembers, BOT_USERNAME)).toBeNull();
  });

  it("4. photo + caption 'счёт' → text '[фото] счёт'", () => {
    const msg = baseFields({
      photo: [{ file_id: 'p1', file_unique_id: 'pu1', width: 10, height: 10 }],
      caption: 'счёт',
    });
    expect(normalizeIncoming(msg, BOT_USERNAME)?.text).toBe('[фото] счёт');
  });

  it("4. document + caption → text '[документ] …'", () => {
    const msg = baseFields({
      document: { file_id: 'd1', file_unique_id: 'du1' },
      caption: 'счёт',
    });
    expect(normalizeIncoming(msg, BOT_USERNAME)?.text).toBe('[документ] счёт');
  });

  it("4. video + caption → text '[видео] …'", () => {
    const msg = baseFields({
      video: { file_id: 'v1', file_unique_id: 'vu1', width: 1, height: 1, duration: 1 },
      caption: 'счёт',
    });
    expect(normalizeIncoming(msg, BOT_USERNAME)?.text).toBe('[видео] счёт');
  });

  it("4. audio + caption → text '[аудио] …'", () => {
    const msg = baseFields({
      audio: { file_id: 'a1', file_unique_id: 'au1', duration: 1 },
      caption: 'счёт',
    });
    expect(normalizeIncoming(msg, BOT_USERNAME)?.text).toBe('[аудио] счёт');
  });

  it("4. animation + caption → text '[gif] …'", () => {
    const msg = baseFields({
      animation: { file_id: 'g1', file_unique_id: 'gu1', width: 1, height: 1, duration: 1 },
      document: { file_id: 'g1', file_unique_id: 'gu1' },
      caption: 'счёт',
    });
    expect(normalizeIncoming(msg, BOT_USERNAME)?.text).toBe('[gif] счёт');
  });

  it('5. /help → null', () => {
    const msg = baseFields({ text: '/help' });
    expect(normalizeIncoming(msg, BOT_USERNAME)).toBeNull();
  });

  it("5. /task купить бумагу → isTaskCommand=true, commandArgs='купить бумагу'", () => {
    const msg = baseFields({ text: '/task купить бумагу' });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result?.isTaskCommand).toBe(true);
    expect(result?.commandArgs).toBe('купить бумагу');
  });

  it('5. /task@school_bot (no args) → isTaskCommand=true, commandArgs=null', () => {
    const msg = baseFields({ text: '/task@school_bot' });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result?.isTaskCommand).toBe(true);
    expect(result?.commandArgs).toBeNull();
  });

  it('5. /task@other_bot → not for this bot → null', () => {
    const msg = baseFields({ text: '/task@other_bot список' });
    expect(normalizeIncoming(msg, BOT_USERNAME)).toBeNull();
  });

  it('6. forward_origin: user → sender_user first_name', () => {
    const msg = baseFields({
      text: 'переслано',
      forward_origin: {
        type: 'user',
        date: 1_699_999_000,
        sender_user: { id: 9, is_bot: false, first_name: 'Ольга' },
      },
    });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result?.isForward).toBe(true);
    expect(result?.forwardOriginName).toBe('Ольга');
  });

  it('6. forward_origin: hidden_user → sender_user_name', () => {
    const msg = baseFields({
      text: 'переслано',
      forward_origin: { type: 'hidden_user', date: 1_699_999_000, sender_user_name: 'Скрытый пользователь' },
    });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result?.isForward).toBe(true);
    expect(result?.forwardOriginName).toBe('Скрытый пользователь');
  });

  it('6. forward_origin: chat → title', () => {
    const msg = baseFields({
      text: 'переслано',
      forward_origin: {
        type: 'chat',
        date: 1_699_999_000,
        sender_chat: { id: -200, type: 'group', title: 'Другая группа' },
      },
    });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result?.isForward).toBe(true);
    expect(result?.forwardOriginName).toBe('Другая группа');
  });

  it('6. forward_origin: channel → title', () => {
    const msg = baseFields({
      text: 'переслано',
      forward_origin: {
        type: 'channel',
        date: 1_699_999_000,
        chat: { id: -300, type: 'channel', title: 'Канал школы' },
        message_id: 42,
      },
    });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result?.isForward).toBe(true);
    expect(result?.forwardOriginName).toBe('Канал школы');
  });

  it('7. reply_to_message → replyToTgMessageId and replyQuote truncated to 200 chars', () => {
    const longText = 'а'.repeat(250);
    const msg = baseFields({
      text: 'ответ',
      reply_to_message: {
        message_id: 5,
        date: 1_699_999_500,
        chat: GROUP,
        from: { id: 4, is_bot: false, first_name: 'Автор' },
        text: longText,
        reply_to_message: undefined,
      },
    });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result?.replyToTgMessageId).toBe(5);
    expect(result?.replyQuote).toBe('а'.repeat(200));
    expect(result?.replyQuote?.length).toBe(200);
  });

  it('8. reply_to_message.forum_topic_created → replyToTgMessageId=null (D26)', () => {
    const msg = baseFields({
      text: 'ответ в теме',
      reply_to_message: {
        message_id: 6,
        date: 1_699_999_500,
        chat: GROUP,
        forum_topic_created: { name: 'Тема', icon_color: 0 },
        reply_to_message: undefined,
      },
    });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result?.replyToTgMessageId).toBeNull();
    expect(result?.replyQuote).toBeNull();
  });

  it('9. quote (partial quote on reply) → replyQuote = quote.text', () => {
    const msg = baseFields({
      text: 'ответ на часть',
      reply_to_message: {
        message_id: 7,
        date: 1_699_999_500,
        chat: GROUP,
        from: { id: 4, is_bot: false, first_name: 'Автор' },
        text: 'Исходное сообщение целиком, но процитирована только часть.',
        reply_to_message: undefined,
      },
      quote: { text: 'процитирована только часть', position: 30 },
    });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result?.replyToTgMessageId).toBe(7);
    expect(result?.replyQuote).toBe('процитирована только часть');
  });

  it('10. a 5000-char text is stored in full (2000-char truncation is buildInput-only)', () => {
    const longText = 'слово '.repeat(834); // > 5000 chars
    const msg = baseFields({ text: longText });
    const result = normalizeIncoming(msg, BOT_USERNAME);
    expect(result?.text).toBe(longText);
    expect(Array.from(longText).length).toBeGreaterThan(5000);
  });
});
