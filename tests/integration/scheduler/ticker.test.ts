import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { loadEnv } from '../../../src/config/env.js';
import { createLogger } from '../../../src/ops/logger.js';
import { getState } from '../../../src/domain/system/appState.js';
import { createTicker, type Job } from '../../../src/scheduler/ticker.js';
import { dailyJob } from '../../../src/scheduler/daily.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

const DEFAULT_TEST_DATABASE_URL = 'postgres://stb:stb@localhost:5433/stb_test';

// No explicit return type here: annotating it as `AppDeps` would widen `errors`'s vi.fn mocks
// to the interface's method-shorthand signatures, which trips `@typescript-eslint/unbound-method`
// on `deps.errors.report` below. Left inferred, `deps` still structurally satisfies `AppDeps`
// wherever it's passed (e.g. `createTicker(deps, ...)`).
function makeDeps(clock: ReturnType<typeof fixedClock> = fixedClock('2026-09-23T12:00:00Z')) {
  return {
    config: loadEnv({
      TELEGRAM_BOT_TOKEN: 'test-token:ABC',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
      SUPERADMIN_TG_IDS: '900000001',
      GIT_SHA: 'test-sha',
    }),
    db,
    clock,
    logger: createLogger({ level: 'silent' }),
    errors: {
      report: vi.fn(() => Promise.resolve()),
      alert: vi.fn(() => Promise.resolve()),
    },
    messenger: new FakeMessenger(),
    ai: null,
    taskHooks: [],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('createTicker', () => {
  it('tickOnce runs all jobs in array order', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    const jobs: Job[] = [
      {
        name: 'a',
        run() {
          order.push('a');
          return Promise.resolve();
        },
      },
      {
        name: 'b',
        run() {
          order.push('b');
          return Promise.resolve();
        },
      },
    ];
    const ticker = createTicker(deps, jobs);

    await ticker.tickOnce();

    expect(order).toEqual(['a', 'b']);
  });

  it('reports a failing job to deps.errors but keeps running the rest', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    const jobs: Job[] = [
      {
        name: 'boom',
        run() {
          throw new Error('boom');
        },
      },
      {
        name: 'ok',
        run() {
          order.push('ok');
          return Promise.resolve();
        },
      },
    ];
    const ticker = createTicker(deps, jobs);

    await ticker.tickOnce();

    expect(order).toEqual(['ok']);
    expect(deps.errors.report).toHaveBeenCalledTimes(1);
    expect(deps.errors.report).toHaveBeenCalledWith(expect.any(Error), { job: 'boom' });
  });

  it('stores the heartbeat (in memory and in app_state) after a tick', async () => {
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const deps = makeDeps(clock);
    const ticker = createTicker(deps, []);

    expect(ticker.lastHeartbeat()).toBeNull();
    await ticker.tickOnce();

    expect(ticker.lastHeartbeat()).toEqual(clock.now());
    const stored = await getState(db, 'ticker:heartbeat', z.object({ at: z.string() }));
    expect(stored?.at).toBe(clock.now().toISOString());
  });

  it('never overlaps ticks: with intervalMs=10 and a 50ms job, at most 1 concurrent run', async () => {
    const deps = makeDeps();
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const job: Job = {
      name: 'slow',
      async run() {
        runs += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await delay(50);
        concurrent -= 1;
      },
    };
    const ticker = createTicker(deps, [job], { intervalMs: 10 });

    ticker.start();
    await delay(220);
    await ticker.stop();

    expect(maxConcurrent).toBeLessThanOrEqual(1);
    expect(runs).toBeGreaterThanOrEqual(2);
  });

  it('stop() waits for an in-flight tick to finish before resolving, and a second stop() is a no-op', async () => {
    const deps = makeDeps();
    let finished = false;
    let runs = 0;
    const job: Job = {
      name: 'slow',
      async run() {
        runs += 1;
        await delay(50);
        finished = true;
      },
    };
    const ticker = createTicker(deps, [job], { intervalMs: 10 });

    ticker.start();
    await delay(5); // let the first tick begin
    await ticker.stop();

    const runsAfterFirstStop = runs;
    await expect(ticker.stop()).resolves.toBeUndefined();
    expect(runs).toBe(runsAfterFirstStop); // the second stop() didn't trigger another tick

    expect(finished).toBe(true);
  });
});

describe('dailyJob', () => {
  it('does not run before atUtc that day', async () => {
    const deps = makeDeps(fixedClock('2026-09-24T03:29:00Z'));
    const ran = vi.fn(() => Promise.resolve());
    const job = dailyJob('retention', '03:30', ran);

    await job.run(deps);

    expect(ran).not.toHaveBeenCalled();
  });

  it('runs once atUtc has passed', async () => {
    const deps = makeDeps(fixedClock('2026-09-24T03:31:00Z'));
    const ran = vi.fn(() => Promise.resolve());
    const job = dailyJob('retention', '03:30', ran);

    await job.run(deps);

    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('does not re-run later the same day', async () => {
    const clock = fixedClock('2026-09-24T03:31:00Z');
    const deps = makeDeps(clock);
    const ran = vi.fn(() => Promise.resolve());
    const job = dailyJob('retention', '03:30', ran);

    await job.run(deps);
    clock.set('2026-09-24T10:00:00Z');
    await job.run(deps);

    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('runs again the next day after atUtc', async () => {
    const clock = fixedClock('2026-09-24T03:31:00Z');
    const deps = makeDeps(clock);
    const ran = vi.fn(() => Promise.resolve());
    const job = dailyJob('retention', '03:30', ran);

    await job.run(deps);
    clock.set('2026-09-25T03:31:00Z');
    await job.run(deps);

    expect(ran).toHaveBeenCalledTimes(2);
  });
});
