import type { Bot, Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot, type BotDeps } from '../../src/bot/bot.js';
import type { BotContext } from '../../src/bot/context.js';
import { createErrorReporter } from '../../src/ops/errorReporter.js';
import { createLogger } from '../../src/ops/logger.js';
import { loadEnv } from '../../src/config/env.js';
import { ensureDefaultWorkspace } from '../../src/domain/workspaces/repo.js';
import { DEFAULT_WORKSPACE_NAME } from '../../src/config/constants.js';
import { getTestDb, truncateAll } from './db.js';
import { fixedClock } from './clock.js';
import { FakeMessenger } from './fakeMessenger.js';
import { DEFAULT_BOT_USER } from './updates.js';

export interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface BotHarness {
  bot: Bot<BotContext>;
  deps: BotDeps;
  clock: ReturnType<typeof fixedClock>;
  db: ReturnType<typeof getTestDb>;
  /** Every outbound Bot API call made via `bot.api`/`ctx.api`, in order (recorded by the harness's transformer). */
  calls: RecordedCall[];
  send(update: Update): Promise<void>;
  /** Text bodies of every `sendMessage`/`editMessageText` call, optionally filtered to one `chat_id`. */
  replies(chatId?: number): string[];
  /** Clears `calls` only. Does not truncate the DB or move the clock — call `truncateAll(harness.db)` /
   *  `harness.clock.set(...)` yourself if a test needs that between updates. */
  reset(): void;
}

const DEFAULT_SUPERADMIN_IDS = [900000001];
const DEFAULT_TEST_DATABASE_URL = 'postgres://stb:stb@localhost:5433/stb_test';

function defaultBotInfo(): UserFromGetMe {
  return {
    id: DEFAULT_BOT_USER.id,
    is_bot: true,
    first_name: DEFAULT_BOT_USER.firstName ?? 'Test Bot',
    username: DEFAULT_BOT_USER.username ?? 'school_task_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
}

/**
 * Records every outbound Bot API call into `calls` and returns a fake
 * response instead of hitting the network: `sendMessage` → a message object
 * with an incrementing `message_id` echoing `chat_id`/`text`; every other
 * method → `true` (brief's Harness note; verified against grammY's
 * `Transformer`/`ApiCallFn` generics in `core/client.d.ts` — those types are
 * intentionally generic per-method, so a fake implementation that returns the
 * same shape regardless of `M` needs the `unknown` cast below rather than a
 * literal structural match).
 */
let nextFakeMessageId = 1;

/** Shared by both fake-response paths below: everything but `sendMessage` just gets a bare `true`. */
function fakeApiResult(method: string, payload: Record<string, unknown>): unknown {
  if (method !== 'sendMessage') return true;
  return {
    message_id: nextFakeMessageId++,
    date: 1_700_000_000,
    chat: { id: payload.chat_id, type: 'private' },
    text: payload.text,
  };
}

function createRecordingTransformer(calls: RecordedCall[]): Transformer {
  const impl = (_prev: unknown, method: string, payload: unknown): Promise<{ ok: true; result: unknown }> => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    return Promise.resolve({ ok: true, result: fakeApiResult(method, p) });
  };
  return impl as unknown as Transformer;
}

/**
 * `@grammyjs/conversations` builds its own `Api` instance for every context
 * it hydrates inside a conversation (`hydrateContext` in its `plugin.js`),
 * from `new Api(protoApi.token, protoApi.options)` — the `options` a bot was
 * constructed with, but *not* any transformer installed afterwards via
 * `bot.api.config.use()`. `createRecordingTransformer` above therefore never
 * sees API calls made from inside an active conversation (e.g. every
 * `ctx.reply`/`answerCallbackQuery` in `src/bot/conversations/timezone.ts`).
 * `options.fetch` (grammY's `ApiClientOptions.fetch`), by contrast, *is*
 * part of `options` and so *is* inherited by that inner `Api` instance —
 * this fakes the low-level HTTP call itself, one layer below transformers,
 * so it catches everything the transformer above misses without duplicating
 * or reordering what it already records.
 */
function createFakeFetch(calls: RecordedCall[]): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = url.split('/').pop() ?? '';
    const bodyText = typeof init?.body === 'string' ? init.body : '{}';
    const payload = JSON.parse(bodyText) as Record<string, unknown>;
    calls.push({ method, payload });
    const body = JSON.stringify({ ok: true, result: fakeApiResult(method, payload) });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
}

export async function createBotHarness(opts?: {
  clock?: string;
  superadminIds?: number[];
}): Promise<BotHarness> {
  const db = getTestDb();
  await truncateAll(db);

  const clock = fixedClock(opts?.clock ?? '2026-09-23T12:00:00+03:00');
  const logger = createLogger({ level: 'silent' });
  const messenger = new FakeMessenger();
  const superadminIds = opts?.superadminIds ?? DEFAULT_SUPERADMIN_IDS;

  const config = loadEnv({
    TELEGRAM_BOT_TOKEN: 'test-token:ABC',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
    SUPERADMIN_TG_IDS: superadminIds.join(','),
    GIT_SHA: 'test-sha',
  });

  const errors = createErrorReporter({ db, messenger, clock, logger, superadminIds });
  const workspace = await ensureDefaultWorkspace(db, {
    name: DEFAULT_WORKSPACE_NAME,
    timezone: 'Europe/Moscow',
  });
  const deps: BotDeps = { config, db, clock, logger, errors, messenger, workspace };
  const calls: RecordedCall[] = [];
  const bot = createBot(deps, { botInfo: defaultBotInfo(), client: { fetch: createFakeFetch(calls) } });

  bot.api.config.use(createRecordingTransformer(calls));

  return {
    bot,
    deps,
    clock,
    db,
    calls,
    send: (update) => bot.handleUpdate(update),
    replies(chatId) {
      return calls
        .filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText')
        .filter((call) => chatId === undefined || call.payload.chat_id === chatId)
        .map((call) => (typeof call.payload.text === 'string' ? call.payload.text : ''));
    },
    reset() {
      calls.length = 0;
    },
  };
}
