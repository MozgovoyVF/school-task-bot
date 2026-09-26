import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { conversations } from '@grammyjs/conversations';
import type { Env } from '../config/env.js';
import type { Db } from '../db/client.js';
import type { Clock } from '../time/clock.js';
import type { Logger } from '../ops/logger.js';
import type { ErrorReporter } from '../ops/errorReporter.js';
import type { Messenger } from '../domain/messenger.js';
import type { BotContext } from './context.js';
import { createErrorsMiddleware } from './middleware/errors.js';
import { createContextMiddleware } from './middleware/context.js';
import { registerDmHandlers } from './handlers/dm.js';
import { registerAdminHandlers } from './handlers/admin.js';

/**
 * The subset of the eventual `AppDeps` (Task 0.8, `src/deps.ts` — not built
 * yet, this task runs before 0.8) that bot construction and this task's
 * handlers/middleware actually need. This is a plain data parameter (not a
 * function-typed parameter being assigned elsewhere, unlike Task 0.6's
 * `TickerDeps`/`dailyJob` case — see plan.md decision D30), so when Task 0.8
 * calls `createBot(deps)` with the real, wider `AppDeps`-typed object,
 * ordinary structural assignability satisfies `BotDeps` with no special
 * handling needed. No decisions-table entry required for this one.
 */
export interface BotDeps {
  config: Env;
  db: Db;
  clock: Clock;
  logger: Logger;
  errors: ErrorReporter;
  messenger: Messenger;
}

/**
 * Builds the bot: `errors` → `context` → `conversations()` → handlers
 * (CLAUDE.md §5, brief Step 3). `opts.botInfo` lets tests (and hosting setups
 * that want to skip the extra `getMe` round-trip) pre-seed the bot's own
 * identity instead of grammY fetching it on `bot.init()`/`bot.start()`.
 * `bot.catch` is the last-resort fallback for anything `errors` middleware
 * itself fails to handle — it only reports, it does not attempt a user-facing
 * reply (see `src/bot/middleware/errors.ts` for that).
 */
export function createBot(deps: BotDeps, opts?: { botInfo?: UserFromGetMe }): Bot<BotContext> {
  const bot = new Bot<BotContext>(deps.config.TELEGRAM_BOT_TOKEN, { botInfo: opts?.botInfo });

  bot.api.config.use(autoRetry());
  bot.api.config.use(apiThrottler());

  const startedAt = deps.clock.now();

  bot.use(createErrorsMiddleware(deps));
  bot.use(createContextMiddleware(deps));
  bot.use(conversations());

  registerDmHandlers(bot);
  registerAdminHandlers(bot, deps, startedAt);

  bot.catch((err) => {
    void deps.errors.report(err.error, { updateId: err.ctx.update.update_id });
  });

  return bot;
}
