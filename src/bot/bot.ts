import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { ApiClientOptions } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { sequentialize } from '@grammyjs/runner';
import { conversations } from '@grammyjs/conversations';
import type { Env } from '../config/env.js';
import type { Db } from '../db/client.js';
import type { Clock } from '../time/clock.js';
import type { Logger } from '../ops/logger.js';
import type { ErrorReporter } from '../ops/errorReporter.js';
import type { Messenger } from '../domain/messenger.js';
import type { WorkspaceRow } from '../domain/workspaces/repo.js';
import type { TaskHook } from '../domain/tasks/service.js';
import type { AiProviders } from '../ai/providers/types.js';
import type { BotContext } from './context.js';
import { createErrorsMiddleware } from './middleware/errors.js';
import { createContextMiddleware } from './middleware/context.js';
import { privateOnly } from './middleware/privateOnly.js';
import { registerDmHandlers } from './handlers/dm.js';
import { registerAdminHandlers } from './handlers/admin.js';
import { registerTransferHandlers } from './handlers/transfer.js';
import { registerChatMemberHandlers } from './handlers/chatMember.js';
import { registerChatsHandlers } from './handlers/chats.js';
import { registerPeopleHandlers } from './handlers/people.js';
import { registerPrivacyHandlers } from './handlers/privacy.js';
import { registerGroupHandlers } from './handlers/group.js';
import { registerProposalCallbackHandlers } from './handlers/proposalCallbacks.js';
import { registerReminderCallbackHandlers } from './handlers/reminderCallbacks.js';
import { registerInboxHandlers } from './handlers/inbox.js';
import { registerStubCommandHandlers } from './handlers/stubs.js';
import { registerTimezoneConversation } from './conversations/timezone.js';
import { registerEditPersonConversation } from './conversations/editPerson.js';
import { registerEditProposalConversation } from './conversations/editProposal.js';
import { registerSnoozeInputConversation } from './conversations/snoozeInput.js';

/**
 * The subset of `AppDeps` (`src/deps.ts`) that bot construction and its
 * handlers/middleware actually need. It is a plain data parameter (not a
 * function-typed parameter being assigned elsewhere, unlike Task 0.6's
 * `TickerDeps`/`dailyJob` case — see plan.md decision D30), so `src/app.ts`
 * calls `createBot(deps)` with the full, wider `AppDeps` object and ordinary
 * structural assignability satisfies `BotDeps`. It is kept narrower than
 * `AppDeps` on purpose so `tests/helpers/botHarness.ts` only has to build
 * these fields (plan.md decision D34). `workspace` was added in Task 1.2 —
 * `createContextMiddleware` (`src/bot/middleware/context.ts`) needs it to
 * resolve a DM actor's membership (MVP has a single default workspace,
 * SPEC §5.2). `taskHooks` was added in Task 2.13 — `src/bot/handlers/
 * proposalCallbacks.ts`'s decision handlers need it for `createTaskService`
 * (D34's original "no benefit" reasoning for not widening this interface no
 * longer holds for this one field specifically). `ai` was added in Task
 * 2.14 — `src/bot/conversations/editProposal.ts`'s free-text date step
 * needs it for `parseDateText` (D34's reasoning finally runs out: a
 * bot-layer handler now does call into `ai`).
 */
export interface BotDeps {
  config: Env;
  db: Db;
  clock: Clock;
  logger: Logger;
  errors: ErrorReporter;
  messenger: Messenger;
  workspace: WorkspaceRow;
  taskHooks: TaskHook[];
  ai: AiProviders | null;
}

/**
 * Builds the bot: `sequentialize` → `errors` → `context` → `conversations()`
 * → handlers (CLAUDE.md §5, brief Step 3). `sequentialize` (from
 * `@grammyjs/runner`, keyed by `chat_id`) goes first, ahead of everything
 * else — including `conversations()`, per CLAUDE.md §5's pre-verified fact
 * (sequentialize is installed before conversations(), keyed by chat_id) — so
 * that the `@grammyjs/runner` concurrency Task 0.8 (`src/app.ts`) enables in
 * production can never let two updates for the same chat race each other
 * through the rest of the middleware chain; it is registered here (not in
 * `src/app.ts`) because middleware order is fixed at `bot.use()` time.
 * `opts.botInfo` lets tests (and hosting setups that want to skip the extra
 * `getMe` round-trip) pre-seed the bot's own identity instead of grammY
 * fetching it on `bot.init()`/`bot.start()`. `opts.client` is forwarded as
 * grammY's `client` config; `tests/helpers/botHarness.ts` uses its `fetch`
 * option to fake HTTP responses for the API calls that `@grammyjs/conversations`
 * makes through a freshly constructed `Api` instance (`hydrateContext` in
 * that plugin builds `new Api(token, options)` straight from `options`,
 * bypassing every transformer installed via `bot.api.config.use()` below —
 * confirmed by reading `@grammyjs/conversations`' `plugin.js`, since neither
 * its docs nor CLAUDE.md's pre-verified facts mention this). `bot.catch` is
 * the last-resort fallback for anything `errors` middleware itself fails to
 * handle — it only reports, it does not attempt a user-facing reply (see
 * `src/bot/middleware/errors.ts` for that).
 */
export function createBot(
  deps: BotDeps,
  opts?: { botInfo?: UserFromGetMe; client?: ApiClientOptions },
): Bot<BotContext> {
  const bot = new Bot<BotContext>(deps.config.TELEGRAM_BOT_TOKEN, {
    botInfo: opts?.botInfo,
    client: opts?.client,
  });

  bot.api.config.use(autoRetry());
  bot.api.config.use(apiThrottler());

  const startedAt = deps.clock.now();

  bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));
  bot.use(createErrorsMiddleware(deps));
  bot.use(createContextMiddleware(deps));
  // Scoped to private chats only (final Phase 1 review's C1 fix, belt-and-suspenders on top of each
  // conversation-entering command's own private-chat guard) — see `privateOnly.ts`'s doc comment for why
  // every `createConversation(...)` registration (`timezone.ts`, `editPerson.ts`) must be wrapped the
  // same way.
  bot.use(privateOnly(conversations()));

  registerTimezoneConversation(bot, deps);
  registerEditPersonConversation(bot, deps);
  registerEditProposalConversation(bot, deps);
  // Must be registered before `registerReminderCallbackHandlers` below — its own `v1:n:inp:` entry
  // callback needs first crack at that action, same ordering reason `registerEditProposalConversation`
  // above is registered ahead of `registerProposalCallbackHandlers` for its `v1:p:edt:` entry callback.
  registerSnoozeInputConversation(bot, deps);
  registerDmHandlers(bot);
  registerAdminHandlers(bot, deps, startedAt);
  registerTransferHandlers(bot, deps);
  registerChatMemberHandlers(bot, deps);
  registerChatsHandlers(bot, deps);
  registerPeopleHandlers(bot, deps);
  // Must run before registerGroupHandlers (privacy.ts's doc comment, and — for the same reason —
  // registerInboxHandlers's own `/inbox` command below): its bot.on('message', ...) would otherwise
  // swallow a DM command update in a group before this handler ever sees it (`/privacy` and `/inbox`
  // are both message-type updates; `registerGroupHandlers`'s catch-all matches every chat type and only
  // returns early for non-group ones without calling `next()`, which — per grammY's middleware chain —
  // stops any handler registered after it from ever running).
  registerPrivacyHandlers(bot);
  // `registerInboxHandlers`'s `v1:p:*` callback half doesn't have this ordering constraint relative to
  // `registerProposalCallbackHandlers` below (different update type — `callback_query`, not `message` —
  // and both fall through unknown actions via `next()` symmetrically), only its `/inbox` command half
  // does; registering the whole thing here, ahead of `registerGroupHandlers`, satisfies that.
  registerInboxHandlers(bot, deps);
  // Same ordering constraint as `/privacy`/`/inbox` above — must run before `registerGroupHandlers`,
  // whose `bot.on('message', ...)` would otherwise swallow these DM commands first (see that file's own
  // doc comment, and `stubs.ts`'s).
  registerStubCommandHandlers(bot);
  registerGroupHandlers(bot, deps);
  registerProposalCallbackHandlers(bot, deps);
  registerReminderCallbackHandlers(bot, deps);

  bot.catch((err) => {
    void deps.errors.report(err.error, { updateId: err.ctx.update.update_id });
  });

  return bot;
}
