import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../../../src/ops/logger.js';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _e, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, destination };
}

describe('logger redaction', () => {
  it('never prints message texts, names, usernames or secrets', () => {
    const { lines, destination } = capture();
    const log = createLogger({ level: 'debug', destination });
    log.info(
      {
        text: 'СЕКРЕТ-1',
        msg1: {
          text: 'СЕКРЕТ-2',
          caption: 'СЕКРЕТ-3',
          from: { first_name: 'Анна', last_name: 'Петрова', username: 'anna_p' },
        },
        update: { message: { text: 'СЕКРЕТ-4' } },
        config: { TELEGRAM_BOT_TOKEN: '123:TOKEN', OPENROUTER_API_KEY: 'sk-or-KEY' },
        headers: { authorization: 'Bearer XYZ' },
        chatId: 42,
      },
      'incoming',
    );
    const out = lines.join('');
    for (const s of ['СЕКРЕТ', 'Анна', 'Петрова', 'anna_p', 'TOKEN', 'sk-or-KEY', 'XYZ']) expect(out).not.toContain(s);
    expect(out).toContain('"chatId":42');
    expect(out).toContain('[REDACTED]');
  });
});
