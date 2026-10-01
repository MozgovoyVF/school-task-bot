import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import type { UserFromGetMe } from 'grammy/types';
import { startApp } from '../../../src/app.js';
import { loadEnv } from '../../../src/config/env.js';
import { fixedClock } from '../../helpers/clock.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import { getTestDb, truncateAll } from '../../helpers/db.js';

const DEFAULT_TEST_DATABASE_URL = 'postgres://stb:stb@localhost:5433/stb_test';

function testEnv() {
  return loadEnv({
    TELEGRAM_BOT_TOKEN: 'test-token:ABC',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
    SUPERADMIN_TG_IDS: '900000001',
    GIT_SHA: 'test-sha',
  });
}

/**
 * `can_read_all_group_messages: true` — `startApp`'s `checkPrivacyMode` call
 * (Task 1.11) must not fire `errors.alert` (which would otherwise call the
 * `FakeMessenger` below) for this unrelated startup smoke test.
 */
function testBotInfo(): UserFromGetMe {
  return {
    id: 100000001,
    is_bot: true,
    first_name: 'Test Bot',
    username: 'school_task_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: true,
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
 * Fakes `bot.api`'s HTTP transport so `syncCommands`'s `setMyCommands` calls
 * (Task 1.11, run once at every `startApp`) never hit the real Telegram API —
 * `botInfo` above already makes `bot.init()` skip its own `getMe` call.
 */
function fakeFetch(): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

describe('startApp', () => {
  it('applies migrations, serves /healthz, and shuts down cleanly (idempotent stop)', async () => {
    const env = testEnv();
    const messenger = new FakeMessenger();
    const app = await startApp(env, {
      messenger,
      polling: false,
      clock: fixedClock('2026-09-23T12:00:00Z'),
      botInfo: testBotInfo(),
      client: { fetch: fakeFetch() },
    });

    try {
      const migrationRows = await app.deps.db.execute<{ count: number }>(
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
      );
      expect(migrationRows[0]?.count).toBeGreaterThan(0);

      const response = await app.http.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });

      // review round C1: without both OPENROUTER_API_KEY and
      // LLM_MODEL_PRIMARY, `deps.ai` must stay `null` (AI analysis
      // disabled) — this is the already-correct path.
      expect(app.deps.ai).toBeNull();
    } finally {
      const startedAt = Date.now();
      await app.stop();
      expect(Date.now() - startedAt).toBeLessThan(10_000);

      // A second stop() call is a no-op: it must resolve without error and without
      // trying to close already-closed resources again.
      await expect(app.stop()).resolves.toBeUndefined();
    }
  }, 15_000);

  it('builds a real AiProviders when OPENROUTER_API_KEY and LLM_MODEL_PRIMARY are both set (review round C1)', async () => {
    // Fix round 2, I-B: this test exercises the REAL (non-stubbed) OpenRouter
    // client construction path, and `startApp` runs one scheduler tick before
    // returning. `stb_test` is shared with every other integration test file,
    // and this file otherwise never clears it — so a queued batch left behind
    // by an earlier-run file could be claimed and processed by that tick,
    // firing a genuine HTTP POST to openrouter.ai with this test's fake API
    // key. Truncating first guarantees nothing is claimable, without stubbing
    // `fetch` (which would defeat the point of this test: proving the real
    // client gets constructed).
    await truncateAll(getTestDb());

    const env = loadEnv({
      TELEGRAM_BOT_TOKEN: 'test-token:ABC',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
      SUPERADMIN_TG_IDS: '900000001',
      GIT_SHA: 'test-sha',
      OPENROUTER_API_KEY: 'sk-test',
      LLM_MODEL_PRIMARY: 'openrouter/model-x',
      LLM_MODEL_FALLBACK: 'openrouter/model-y',
    });
    const messenger = new FakeMessenger();
    const app = await startApp(env, {
      messenger,
      polling: false,
      clock: fixedClock('2026-09-23T12:00:00Z'),
      botInfo: testBotInfo(),
      client: { fetch: fakeFetch() },
    });

    try {
      // Construction only — `analyzeJob`'s one synchronous `tickOnce()` tick
      // (startApp) finds no queued batches in this fresh test DB, so no real
      // OpenRouter/network call is ever made here.
      expect(app.deps.ai).not.toBeNull();
      expect(app.deps.ai?.models).toEqual({ primary: 'openrouter/model-x', fallback: 'openrouter/model-y' });
      expect(app.deps.ai?.decision).toBeNull();
    } finally {
      await app.stop();
    }
  }, 15_000);
});
