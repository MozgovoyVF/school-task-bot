import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { errorReports } from '../db/schema/index.js';
import type { Messenger } from '../domain/messenger.js';
import type { Clock } from '../time/clock.js';
import { texts } from '../bot/texts/ru.js';
import type { Logger } from './logger.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_FRAMES = 5;
const LONG_DIGIT_RUN = /\d{7,}/g;

type Context = Record<string, string | number | boolean | null>;

interface NormalizedError {
  name: string;
  message: string;
  stack: string | undefined;
}

function normalizeError(err: unknown): NormalizedError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: 'NonError', message: String(err), stack: undefined };
}

function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Groups occurrences of "the same" error regardless of the numbers embedded
 * in the message (ids, counts, …): sha256 of the error name, the message
 * with digit runs blanked out, and the first stack frame after the
 * "Name: message" header — truncated to 16 hex chars.
 */
export function fingerprint(err: unknown): string {
  const normalized = normalizeError(err);
  const normalizedMessage = normalized.message.replace(/\d+/g, '#');
  const frame = stackFrames(normalized.stack)[0] ?? '';
  const input = `${normalized.name}:${normalizedMessage}:${frame}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** Masks digit runs longer than 6 digits (phone numbers, tokens, …) and caps length at 300 chars. */
function sanitizeMessage(message: string): string {
  const masked = message.replace(LONG_DIGIT_RUN, (run) => '#'.repeat(run.length));
  return masked.length > MAX_MESSAGE_CHARS ? masked.slice(0, MAX_MESSAGE_CHARS) : masked;
}

interface ErrorSample {
  name: string;
  message: string;
  topFrames: string[];
  context: Context;
}

function buildSample(normalized: NormalizedError, context: Context): ErrorSample {
  return {
    name: normalized.name,
    message: sanitizeMessage(normalized.message),
    topFrames: stackFrames(normalized.stack).slice(0, MAX_STACK_FRAMES),
    context,
  };
}

export interface ErrorReporter {
  report(err: unknown, context?: Context): Promise<void>;
  /** Uses the same `error_reports` table, fingerprinted as `alert:<key>`. */
  alert(key: string, text: string, opts?: { throttleMs?: number; alsoTo?: number[] }): Promise<void>;
}

export interface ErrorReporterDeps {
  db: Db;
  messenger: Messenger;
  clock: Clock;
  logger: Logger;
  superadminIds: number[];
}

interface NotifyDecision {
  shouldNotify: boolean;
  /** How many times the error repeated since the previous notification (0 on a fresh fingerprint). */
  repeatCount: number;
}

/**
 * Upserts the `error_reports` row for `key` and decides whether to notify:
 * a brand-new fingerprint always notifies; an existing one notifies again
 * only once `last_notified_at` is missing or older than `throttleMs`, at
 * which point `count` resets to 0 for the fresh throttling window. Otherwise
 * the occurrence is just tallied into `count`.
 */
async function upsertAndDecide(
  db: Db,
  key: string,
  now: Date,
  throttleMs: number,
  sample: unknown,
): Promise<NotifyDecision> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(errorReports).where(eq(errorReports.fingerprint, key)).for('update');
    const existing = rows[0];
    if (!existing) {
      await tx.insert(errorReports).values({
        fingerprint: key,
        count: 0,
        firstAt: now,
        lastAt: now,
        lastNotifiedAt: now,
        sample,
      });
      return { shouldNotify: true, repeatCount: 0 };
    }
    const stale =
      existing.lastNotifiedAt === null || now.getTime() - existing.lastNotifiedAt.getTime() > throttleMs;
    if (stale) {
      const repeatCount = existing.count + 1;
      await tx
        .update(errorReports)
        .set({ count: 0, lastAt: now, lastNotifiedAt: now, sample })
        .where(eq(errorReports.fingerprint, key));
      return { shouldNotify: true, repeatCount };
    }
    await tx
      .update(errorReports)
      .set({ count: existing.count + 1, lastAt: now, sample })
      .where(eq(errorReports.fingerprint, key));
    return { shouldNotify: false, repeatCount: 0 };
  });
}

function dedupeIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

export function createErrorReporter(deps: ErrorReporterDeps): ErrorReporter {
  const { db, messenger, clock, logger, superadminIds } = deps;

  async function notify(
    recipients: number[],
    text: string,
    logContext: Record<string, unknown>,
  ): Promise<void> {
    for (const chatId of recipients) {
      try {
        await messenger.send(chatId, text);
      } catch (sendErr) {
        logger.error({ err: sendErr, chatId, ...logContext }, 'failed to send error notification');
      }
    }
  }

  return {
    async report(err, context = {}) {
      try {
        const key = fingerprint(err);
        const normalized = normalizeError(err);
        const now = clock.now();
        const sample = buildSample(normalized, context);
        const decision = await upsertAndDecide(db, key, now, ONE_HOUR_MS, sample);
        if (!decision.shouldNotify) return;
        const text = texts.errors.report(
          key,
          normalized.name,
          normalized.message,
          context,
          decision.repeatCount > 0 ? decision.repeatCount : undefined,
        );
        await notify(superadminIds, text, { fingerprint: key });
      } catch (reportErr) {
        logger.error({ err: reportErr }, 'error reporter failed to process an error');
      }
    },
    async alert(key, text, opts) {
      try {
        const alertFingerprint = `alert:${key}`;
        const now = clock.now();
        const throttleMs = opts?.throttleMs ?? ONE_HOUR_MS;
        const decision = await upsertAndDecide(db, alertFingerprint, now, throttleMs, null);
        if (!decision.shouldNotify) return;
        const recipients = dedupeIds([...superadminIds, ...(opts?.alsoTo ?? [])]);
        await notify(recipients, text, { alertKey: key });
      } catch (alertErr) {
        logger.error({ err: alertErr }, 'error reporter failed to process an alert');
      }
    },
  };
}
