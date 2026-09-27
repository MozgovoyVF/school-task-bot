import { Api } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { run } from '@grammyjs/runner';
import type { RunnerHandle } from '@grammyjs/runner';
import type { FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { ensureDefaultWorkspace } from './domain/workspaces/repo.js';
import { bootstrapOwner } from './domain/people/repo.js';
import { createBot } from './bot/bot.js';
import { createGrammyMessenger } from './bot/messenger.js';
import type { Messenger } from './domain/messenger.js';
import { createErrorReporter } from './ops/errorReporter.js';
import { createLogger } from './ops/logger.js';
import { systemClock } from './time/clock.js';
import type { Clock } from './time/clock.js';
import { createTicker } from './scheduler/ticker.js';
import { buildHttpServer } from './http/server.js';
import type { AppDeps } from './deps.js';

/** Update types the production long-polling runner asks Telegram for (brief Step 3). */
const RUNNER_ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
  'chat_member',
] as const;

export interface StartAppOverrides {
  /** Skips the real Telegram-backed messenger, e.g. `FakeMessenger` in tests. */
  messenger?: Messenger;
  /** `false` skips starting the `@grammyjs/runner` long-polling loop entirely (tests: no real Telegram calls). Defaults to `true`. */
  polling?: boolean;
  /** Pre-seeds the bot's own identity, skipping the `getMe` round-trip grammY would otherwise do on first use. */
  botInfo?: UserFromGetMe;
  clock?: Clock;
}

export interface StartedApp {
  deps: AppDeps;
  http: FastifyInstance;
  /** Idempotent: stops the runner (if started), then the ticker, then http, then the db pool. A second call is a no-op. */
  stop(): Promise<void>;
}

/**
 * The composition root: builds every `AppDeps` field and wires bot, ticker
 * and http server together, in the order fixed by the Task 0.8 brief —
 * `logger` → `createDb` → `runMigrations` → `createBot` → `messenger` →
 * `errors` → `ticker` → `http.listen` → runner.
 */
export async function startApp(env: Env, overrides?: StartAppOverrides): Promise<StartedApp> {
  const logger = createLogger({ level: env.LOG_LEVEL });
  const clock = overrides?.clock ?? systemClock;

  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  if (env.MIGRATE_ON_START) {
    await runMigrations(db);
  }

  // MVP has a single default workspace (SPEC §5.2); the bot's context
  // middleware needs it to resolve a DM actor's membership. `bootstrapOwner`
  // (Task 1.2) creates the Owner's membership from `BOOTSTRAP_OWNER_TG_ID`
  // when the workspace doesn't have one yet — a no-op ('skipped'/'exists')
  // on every run after the first.
  const workspace = await ensureDefaultWorkspace(db, {
    name: env.DEFAULT_WORKSPACE_NAME,
    timezone: env.DEFAULT_TIMEZONE,
  });
  await bootstrapOwner(db, { workspaceId: workspace.id, tgUserId: env.BOOTSTRAP_OWNER_TG_ID });

  // `createBot` (src/bot/bot.ts) needs a fully-built `Messenger`/`ErrorReporter`
  // *before* it constructs its own `Bot` — its middleware closes over `deps`
  // synchronously — so there is no `bot.api` yet to hand to
  // `createGrammyMessenger` at this point. Building a second grammY `Api`
  // client with the same token and the same autoRetry/apiThrottler
  // transformers `createBot` applies to `bot.api` breaks that cycle without
  // changing `createBot`'s signature. Both clients call the same bot token,
  // so the only real difference from sharing `bot.api` is that retries and
  // throttling are tracked per-client rather than globally — a non-issue at
  // this bot's volume (SPEC: up to ~500 messages/day across up to 5 groups).
  let messenger = overrides?.messenger;
  if (!messenger) {
    const api = new Api(env.TELEGRAM_BOT_TOKEN);
    api.config.use(autoRetry());
    api.config.use(apiThrottler());
    messenger = createGrammyMessenger(api);
  }

  const errors = createErrorReporter({
    db,
    messenger,
    clock,
    logger,
    superadminIds: env.SUPERADMIN_TG_IDS,
  });

  // `ai` is always `null` in phase 0 — no `src/ai/**` code exists yet (see
  // `src/deps.ts`'s `AiProviders` placeholder / plan.md decision D32). This
  // condition mirrors the check phase 2 will use to actually decide whether
  // to build the real `AiProviders`, so the warning already fires correctly
  // once that wiring lands.
  if (!env.OPENROUTER_API_KEY || !env.LLM_MODEL_PRIMARY) {
    logger.warn('AI analysis disabled: OPENROUTER_API_KEY or LLM_MODEL_PRIMARY is not set');
  }

  const deps: AppDeps = {
    config: env,
    db,
    clock,
    logger,
    errors,
    messenger,
    workspace,
    ai: null,
    taskHooks: [],
  };

  const bot = createBot(deps, { botInfo: overrides?.botInfo });

  const ticker = createTicker(deps, []);
  // One synchronous tick before we start serving traffic, so `/healthz`
  // doesn't 503 on a cold start waiting for the first interval tick.
  // `start()` then keeps the heartbeat refreshed going forward; the extra
  // immediate tick it fires is harmless (the phase-0 job list is empty, and
  // ticks are otherwise idempotent).
  await ticker.tickOnce();
  ticker.start();

  const http = buildHttpServer({ db, clock, heartbeat: () => ticker.lastHeartbeat() });
  await http.listen({ host: '0.0.0.0', port: env.HTTP_PORT });

  const polling = overrides?.polling ?? true;
  let runner: RunnerHandle | undefined;
  if (polling) {
    runner = run(bot, { runner: { fetch: { allowed_updates: [...RUNNER_ALLOWED_UPDATES] } } });
  }

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (runner?.isRunning()) {
      await runner.stop();
    }
    await ticker.stop();
    await http.close();
    await closeDb();
  }

  return { deps, http, stop };
}
