import type { MiddlewareFn } from 'grammy';
import type { ErrorReporter } from '../../ops/errorReporter.js';
import type { Logger } from '../../ops/logger.js';
import { texts } from '../texts/ru.js';
import type { BotContext } from '../context.js';

export interface ErrorsMiddlewareDeps {
  errors: ErrorReporter;
  logger: Logger;
}

/**
 * The outermost bot middleware (registered first, per the brief's
 * errors → context → conversations() → handlers order): wraps every
 * downstream middleware in a try/catch, reports any thrown error via
 * `deps.errors.report`, and — if the update has a chat to reply into — lets
 * the user know via `texts.errors.userFacing`, without ever re-throwing (so a
 * failure here can't crash the process; `bot.catch` in `bot.ts` is the
 * last-resort fallback for anything this middleware itself fails to handle).
 */
export function createErrorsMiddleware(deps: ErrorsMiddlewareDeps): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      await deps.errors.report(err, { updateId: ctx.update.update_id });
      if (ctx.chat) {
        try {
          await ctx.reply(texts.errors.userFacing, { parse_mode: 'HTML' });
        } catch (replyErr) {
          deps.logger.error({ err: replyErr }, 'failed to send the user-facing error reply');
        }
      }
    }
  };
}
