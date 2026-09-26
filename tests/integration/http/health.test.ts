import { describe, it, expect } from 'vitest';
import { createDb } from '../../../src/db/client.js';
import { fixedClock } from '../../helpers/clock.js';
import { buildHttpServer } from '../../../src/http/server.js';

const DEFAULT_TEST_DATABASE_URL = 'postgres://stb:stb@localhost:5433/stb_test';

function testDbUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

describe('GET /healthz', () => {
  it('returns 200 when the heartbeat is recent and the db is reachable', async () => {
    const { db, close } = createDb(testDbUrl(), { max: 1 });
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const heartbeat = new Date(clock.now().getTime() - 10_000);
    const app = buildHttpServer({ db, clock, heartbeat: () => heartbeat });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await close();
  });

  it('returns 503 when the heartbeat is stale (61s old)', async () => {
    const { db, close } = createDb(testDbUrl(), { max: 1 });
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const heartbeat = new Date(clock.now().getTime() - 61_000);
    const app = buildHttpServer({ db, clock, heartbeat: () => heartbeat });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(503);
    await close();
  });

  it('returns 503 when the database connection is unreachable', async () => {
    const { db, close } = createDb(testDbUrl(), { max: 1 });
    await close();
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const heartbeat = new Date(clock.now().getTime() - 10_000);
    const app = buildHttpServer({ db, clock, heartbeat: () => heartbeat });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(503);
  });
});
