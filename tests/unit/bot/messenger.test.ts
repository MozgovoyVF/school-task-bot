import { describe, it, expect, vi } from 'vitest';
import { GrammyError, HttpError } from 'grammy';
import type { Api } from 'grammy';
import { MessengerError } from '../../../src/domain/messenger.js';
import { createGrammyMessenger, toMessengerError } from '../../../src/bot/messenger.js';

function grammyError(
  errorCode: number,
  description: string,
  parameters?: { retry_after?: number },
): GrammyError {
  return new GrammyError(
    description,
    { ok: false, error_code: errorCode, description, parameters },
    'sendMessage',
    {},
  );
}

describe('toMessengerError', () => {
  it('maps a 403 GrammyError to forbidden', () => {
    const err = toMessengerError(grammyError(403, 'Forbidden: bot was blocked by the user'));
    expect(err).toBeInstanceOf(MessengerError);
    expect(err.kind).toBe('forbidden');
  });

  it('maps a 429 GrammyError with retry_after to rate_limited, carrying retryAfterSec', () => {
    const err = toMessengerError(grammyError(429, 'Too Many Requests: retry after 5', { retry_after: 5 }));
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterSec).toBe(5);
  });

  it('maps a 400 "chat not found" GrammyError to not_found', () => {
    const err = toMessengerError(grammyError(400, 'Bad Request: chat not found'));
    expect(err.kind).toBe('not_found');
  });

  it('maps HttpError (network-level) to network', () => {
    const err = toMessengerError(new HttpError('fetch failed', new Error('ECONNRESET')));
    expect(err.kind).toBe('network');
  });

  it('maps anything else to other', () => {
    const err = toMessengerError(new Error('unexpected'));
    expect(err.kind).toBe('other');
  });
});

describe('createGrammyMessenger', () => {
  it('edit() treats "message is not modified" as success rather than throwing', async () => {
    const editMessageText = vi.fn(() =>
      Promise.reject(grammyError(400, 'Bad Request: message is not modified')),
    );
    const api = { editMessageText } as unknown as Api;
    const messenger = createGrammyMessenger(api);

    await expect(messenger.edit(1, 2, 'text')).resolves.toBeUndefined();
  });

  it('edit() still rejects other 400s as a MessengerError', async () => {
    const editMessageText = vi.fn(() => Promise.reject(grammyError(400, 'Bad Request: chat not found')));
    const api = { editMessageText } as unknown as Api;
    const messenger = createGrammyMessenger(api);

    await expect(messenger.edit(1, 2, 'text')).rejects.toMatchObject({ kind: 'not_found' });
  });
});
