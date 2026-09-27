import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { startApp } from '../../../src/app.js';
import { loadEnv } from '../../../src/config/env.js';
import { fixedClock } from '../../helpers/clock.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';

const DEFAULT_TEST_DATABASE_URL = 'postgres://stb:stb@localhost:5433/stb_test';

function testEnv() {
  return loadEnv({
    TELEGRAM_BOT_TOKEN: 'test-token:ABC',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
    SUPERADMIN_TG_IDS: '900000001',
    GIT_SHA: 'test-sha',
  });
}

describe('startApp', () => {
  it('applies migrations, serves /healthz, and shuts down cleanly (idempotent stop)', async () => {
    const env = testEnv();
    const messenger = new FakeMessenger();
    const app = await startApp(env, {
      messenger,
      polling: false,
      clock: fixedClock('2026-09-23T12:00:00Z'),
    });

    try {
      const migrationRows = await app.deps.db.execute<{ count: number }>(
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
      );
      expect(migrationRows[0]?.count).toBeGreaterThan(0);

      const response = await app.http.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    } finally {
      const startedAt = Date.now();
      await app.stop();
      expect(Date.now() - startedAt).toBeLessThan(10_000);

      // A second stop() call is a no-op: it must resolve without error and without
      // trying to close already-closed resources again.
      await expect(app.stop()).resolves.toBeUndefined();
    }
  }, 15_000);
});
