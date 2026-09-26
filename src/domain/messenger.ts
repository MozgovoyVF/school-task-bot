/**
 * The domain-side interface to Telegram. `domain/`, `ai/`, `time/` and
 * `scheduler/` must never import grammY (CLAUDE.md §7); they send through
 * this interface instead. It is implemented on grammY in `src/bot/messenger.ts`
 * (Task 0.7) and faked in tests via `tests/helpers/fakeMessenger.ts`.
 */

export interface Button {
  text: string;
  data?: string;
  url?: string;
}

export type Buttons = Button[][];

export interface SendOptions {
  buttons?: Buttons;
  silent?: boolean;
  replyToMessageId?: number;
}

export type MessengerErrorKind =
  'forbidden' | 'not_found' | 'rate_limited' | 'bad_request' | 'network' | 'other';

export class MessengerError extends Error {
  constructor(
    readonly kind: MessengerErrorKind,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'MessengerError';
  }
}

export interface Messenger {
  send(chatId: number, text: string, opts?: SendOptions): Promise<{ messageId: number }>;
  /** "message is not modified" from the Bot API is treated as success. */
  edit(chatId: number, messageId: number, text: string, opts?: { buttons?: Buttons }): Promise<void>;
  react(chatId: number, messageId: number, emoji: string | null): Promise<void>;
  leaveChat(chatId: number): Promise<void>;
}
