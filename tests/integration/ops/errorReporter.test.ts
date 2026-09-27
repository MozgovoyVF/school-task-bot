import { describe, it, expect, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import { createErrorReporter, fingerprint } from '../../../src/ops/errorReporter.js';
import { createLogger } from '../../../src/ops/logger.js';
import { MessengerError } from '../../../src/domain/messenger.js';
import { errorReports } from '../../../src/db/schema/index.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Constructed from the same call site every time, so `fingerprint()` groups every call together. */
function taskNotFoundError(): Error {
  return new Error('Task not found');
}

function capturingLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: unknown, _enc, cb: () => void) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, logger: createLogger({ level: 'debug', destination }) };
}

async function getRow(key: string) {
  const [row] = await db.select().from(errorReports).where(eq(errorReports.fingerprint, key));
  return row;
}

describe('createErrorReporter.report', () => {
  it('notifies every superadmin on a first occurrence, with type and context but no user text', async () => {
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const messenger = new FakeMessenger();
    const { logger } = capturingLogger();
    const reporter = createErrorReporter({ db, messenger, clock, logger, superadminIds: [111, 222] });

    await reporter.report(taskNotFoundError(), { taskId: 5 });

    expect(messenger.sent).toHaveLength(2);
    expect(messenger.sent.map((m) => m.chatId).sort()).toEqual([111, 222]);
    for (const m of messenger.sent) {
      expect(m.text).toContain('Error');
      expect(m.text).toContain('Task not found');
      expect(m.text).toContain('taskId=5');
    }
  });

  it('suppresses a repeat within the hour and tallies it into count', async () => {
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const messenger = new FakeMessenger();
    const { logger } = capturingLogger();
    const reporter = createErrorReporter({ db, messenger, clock, logger, superadminIds: [111] });

    await reporter.report(taskNotFoundError(), { taskId: 5 });
    messenger.sent.length = 0;

    clock.advance(10 * 60_000);
    await reporter.report(taskNotFoundError(), { taskId: 5 });

    expect(messenger.sent).toHaveLength(0);
    const row = await getRow(fingerprint(taskNotFoundError()));
    expect(row?.count).toBe(1);
  });

  it('re-notifies once the hour has elapsed with a repeat count, and resets count', async () => {
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const messenger = new FakeMessenger();
    const { logger } = capturingLogger();
    const reporter = createErrorReporter({ db, messenger, clock, logger, superadminIds: [111] });

    await reporter.report(taskNotFoundError(), { taskId: 5 }); // t0: notified
    clock.advance(10 * 60_000);
    await reporter.report(taskNotFoundError(), { taskId: 5 }); // t0+10m: suppressed, count=1
    messenger.sent.length = 0;

    clock.advance(61 * 60_000); // t0+71m: last_notified_at (t0) is now > 1h old
    await reporter.report(taskNotFoundError(), { taskId: 5 });

    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]?.text).toContain('Повторилось 2 раза');
    const row = await getRow(fingerprint(taskNotFoundError()));
    expect(row?.count).toBe(0);
  });

  it('swallows a Messenger failure without throwing, and logs it instead', async () => {
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const messenger = new FakeMessenger();
    const { lines, logger } = capturingLogger();
    const reporter = createErrorReporter({ db, messenger, clock, logger, superadminIds: [111] });

    messenger.failNextWith(new MessengerError('network', 'boom'));
    await expect(reporter.report(taskNotFoundError(), { taskId: 5 })).resolves.toBeUndefined();

    expect(lines.length).toBeGreaterThan(0);
  });

  it('sanitizes the outbound notification text: masks long digit runs and caps length, same as the stored sample', async () => {
    // Regression: report() used to build the Telegram text from the raw, unmasked, untruncated
    // message, while only error_reports.sample went through sanitizeMessage. A long message could
    // then blow past Telegram's 4096-char send limit, and digit-masking meant to hide phone
    // numbers/tokens never applied to the one channel the text is actually broadcast on.
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const messenger = new FakeMessenger();
    const { logger } = capturingLogger();
    const reporter = createErrorReporter({ db, messenger, clock, logger, superadminIds: [111] });

    const longDigits = '5551234567'; // 10 digits, over the >6-digit masking threshold
    function makeLongError() {
      return new Error(`Phone ${longDigits} failed: ${'x'.repeat(400)}`);
    }

    await reporter.report(makeLongError());

    expect(messenger.sent).toHaveLength(1);
    const text = messenger.sent[0]?.text ?? '';
    const row = await getRow(fingerprint(makeLongError()));
    const sample = row?.sample as { message: string } | null;

    expect(sample?.message.length).toBeLessThanOrEqual(300);
    expect(sample?.message).not.toContain(longDigits);
    expect(text).not.toContain(longDigits);
    expect(text.length).toBeLessThan(1000);
    expect(sample?.message).toBeTruthy();
    if (sample) expect(text).toContain(sample.message);
  });

  it('keeps grouping by fingerprint and stores real stack frames for a multi-line error message', async () => {
    // Regression: stackFrames() used to strip the header by dropping exactly one line, so a
    // message spanning multiple lines left a message fragment (not a real stack frame) as the
    // "first frame" — leaking unmasked message text into the fingerprint and into sample.topFrames.
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const messenger = new FakeMessenger();
    const { logger } = capturingLogger();
    const reporter = createErrorReporter({ db, messenger, clock, logger, superadminIds: [111] });

    function multiLineError() {
      return new Error('Validation failed:\nfield a is required\nfield b is missing');
    }

    await reporter.report(multiLineError());
    clock.advance(10 * 60_000);
    await reporter.report(multiLineError()); // same fingerprint → suppressed, tallied into count

    expect(messenger.sent).toHaveLength(1);
    const row = await getRow(fingerprint(multiLineError()));
    expect(row?.count).toBe(1);

    const sample = row?.sample as { topFrames: string[] } | null;
    expect(sample?.topFrames.length ?? 0).toBeGreaterThan(0);
    for (const frame of sample?.topFrames ?? []) {
      expect(frame).toMatch(/^at /);
      expect(frame).not.toContain('field a');
      expect(frame).not.toContain('field b');
    }
  });
});

describe('createErrorReporter.alert', () => {
  it('dedupes two calls with the same key within the throttle window into one message', async () => {
    const clock = fixedClock('2026-09-23T12:00:00+03:00');
    const messenger = new FakeMessenger();
    const { logger } = capturingLogger();
    const reporter = createErrorReporter({ db, messenger, clock, logger, superadminIds: [111] });

    await reporter.alert('budget:2026-09-23', 'Бюджет на сегодня исчерпан');
    clock.advance(5 * 60_000);
    await reporter.alert('budget:2026-09-23', 'Бюджет на сегодня исчерпан');

    expect(messenger.sent).toHaveLength(1);

    clock.advance(ONE_HOUR_MS + 1);
    await reporter.alert('budget:2026-09-23', 'Бюджет на сегодня исчерпан');
    expect(messenger.sent).toHaveLength(2);
  });
});
