import type { Buttons, Messenger, MessengerError, SendOptions } from '../../src/domain/messenger.js';

/**
 * In-memory {@link Messenger} for handler/reporter tests. Records every call
 * so tests can assert on `sent`/`edits`/`reactions`/`left`, and lets a test
 * queue up exactly one failure via `failNextWith`.
 */
export class FakeMessenger implements Messenger {
  readonly sent: Array<{ chatId: number; text: string; opts?: SendOptions }> = [];
  readonly edits: Array<{ chatId: number; messageId: number; text: string; buttons?: Buttons }> = [];
  readonly reactions: Array<{ chatId: number; messageId: number; emoji: string | null }> = [];
  readonly left: number[] = [];

  private nextError: MessengerError | undefined;
  private nextMessageId = 1;

  /** Makes the next Messenger call throw `err` instead of succeeding. */
  failNextWith(err: MessengerError): void {
    this.nextError = err;
  }

  private throwIfQueued(): void {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = undefined;
      throw err;
    }
  }

  send(chatId: number, text: string, opts?: SendOptions): Promise<{ messageId: number }> {
    this.throwIfQueued();
    this.sent.push(opts === undefined ? { chatId, text } : { chatId, text, opts });
    return Promise.resolve({ messageId: this.nextMessageId++ });
  }

  edit(chatId: number, messageId: number, text: string, opts?: { buttons?: Buttons }): Promise<void> {
    this.throwIfQueued();
    this.edits.push(
      opts?.buttons === undefined
        ? { chatId, messageId, text }
        : { chatId, messageId, text, buttons: opts.buttons },
    );
    return Promise.resolve();
  }

  react(chatId: number, messageId: number, emoji: string | null): Promise<void> {
    this.throwIfQueued();
    this.reactions.push({ chatId, messageId, emoji });
    return Promise.resolve();
  }

  leaveChat(chatId: number): Promise<void> {
    this.throwIfQueued();
    this.left.push(chatId);
    return Promise.resolve();
  }
}
