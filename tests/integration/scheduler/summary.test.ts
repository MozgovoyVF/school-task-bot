import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import { createLogger } from '../../../src/ops/logger.js';
import { createErrorReporter } from '../../../src/ops/errorReporter.js';
import { loadEnv } from '../../../src/config/env.js';
import { ensureDefaultWorkspace, updateSettings } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser, markDmStarted, markDmBlocked } from '../../../src/domain/people/repo.js';
import { notifyJob } from '../../../src/scheduler/jobs/notify.js';
import { ensureSummariesJob } from '../../../src/scheduler/jobs/summary.js';
import { MessengerError } from '../../../src/domain/messenger.js';
import { memberships, notifications } from '../../../src/db/schema/index.js';
import type { AppDeps } from '../../../src/deps.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://stb:stb@localhost:5433/stb_test';
const SUPERADMIN_ID = 900000002;

const db = getTestDb();
beforeEach(() => truncateAll(db));

function makeConfig() {
  return loadEnv({
    TELEGRAM_BOT_TOKEN: 'test-token:ABC',
    DATABASE_URL: TEST_DATABASE_URL,
    SUPERADMIN_TG_IDS: String(SUPERADMIN_ID),
    GIT_SHA: 'test-sha',
  });
}

function makeDeps(
  clock: ReturnType<typeof fixedClock>,
  workspace: AppDeps['workspace'],
  messenger: FakeMessenger,
): AppDeps {
  const config = makeConfig();
  const logger = createLogger({ level: 'silent' });
  const errors = createErrorReporter({
    db,
    messenger,
    clock,
    logger,
    superadminIds: config.SUPERADMIN_TG_IDS,
  });
  return { config, db, clock, logger, errors, messenger, workspace, ai: null, taskHooks: [] };
}

/** Mirrors `src/app.ts`'s ticker order: `notifyJob` then `ensureSummariesJob`, in the same tick. */
async function tick(deps: AppDeps): Promise<void> {
  await notifyJob.run(deps);
  await ensureSummariesJob.run(deps);
}

async function setupOwner(zone: string, clockIso: string) {
  const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: zone });
  const clock = fixedClock(clockIso);
  const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
  await markDmStarted(db, owner.id, clock.now());
  await db
    .insert(memberships)
    .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });
  return { ws, owner, clock };
}

async function scheduledSummaries(workspaceId: number) {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.kind, 'summary'),
        eq(notifications.status, 'scheduled'),
      ),
    );
}

describe('ensureSummariesJob (SPEC §13.4, plan.md Task 3.5)', () => {
  it("creates a scheduled row for the next occurrence of summary.time in the owner's zone", async () => {
    const { ws, owner, clock } = await setupOwner('Asia/Yekaterinburg', '2026-09-23T03:00:00Z'); // 08:00 local
    const deps = makeDeps(clock, ws, new FakeMessenger());

    await ensureSummariesJob.run(deps);

    const rows = await scheduledSummaries(ws.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientUserId).toBe(owner.id);
    expect(rows[0]?.fireAt.toISOString()).toBe('2026-09-23T04:00:00.000Z'); // 09:00 Yekaterinburg
    expect(rows[0]?.dedupeKey).toBe(`summary:${String(ws.id)}:${String(owner.id)}:2026-09-23`);
  });

  it('does nothing when there is no Owner, the Owner never started a DM, or is dm_blocked', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const clock = fixedClock('2026-09-23T03:00:00Z');
    const deps = makeDeps(clock, ws, new FakeMessenger());

    await ensureSummariesJob.run(deps);
    expect(await scheduledSummaries(ws.id)).toHaveLength(0);

    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });
    // No `markDmStarted` — Owner has a membership but never ran /start.
    await ensureSummariesJob.run(deps);
    expect(await scheduledSummaries(ws.id)).toHaveLength(0);

    await markDmStarted(db, owner.id, clock.now());
    await markDmBlocked(db, owner.id, true);
    await ensureSummariesJob.run(deps);
    expect(await scheduledSummaries(ws.id)).toHaveLength(0);
  });

  it('scenario 1: tick before fire_at does nothing; tick at fire_at sends and schedules tomorrow (same tick)', async () => {
    const { ws, owner, clock } = await setupOwner('Asia/Yekaterinburg', '2026-09-23T03:00:00Z');
    const messenger = new FakeMessenger();
    const deps = makeDeps(clock, ws, messenger);
    await updateSettings(db, ws.id, { summary: { enabled: true, time: '09:00' } });

    await ensureSummariesJob.run(deps); // bootstrap: schedules today's 04:00Z row
    const before = await scheduledSummaries(ws.id);
    expect(before).toHaveLength(1);
    const todayId = before[0]?.id;

    clock.set('2026-09-23T03:59:00Z');
    await tick(deps);
    expect(messenger.sent).toHaveLength(0);
    const stillScheduled = await scheduledSummaries(ws.id);
    expect(stillScheduled).toHaveLength(1);
    expect(stillScheduled[0]?.id).toBe(todayId); // unchanged — still valid, not recreated

    clock.set('2026-09-23T04:00:00Z');
    await tick(deps);
    expect(messenger.sent).toHaveLength(1);

    const [sentRow] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, todayId as number));
    expect(sentRow?.status).toBe('sent');

    const tomorrow = await scheduledSummaries(ws.id);
    expect(tomorrow).toHaveLength(1);
    expect(tomorrow[0]?.id).not.toBe(todayId);
    expect(tomorrow[0]?.fireAt.toISOString()).toBe('2026-09-24T04:00:00.000Z');
    expect(tomorrow[0]?.recipientUserId).toBe(owner.id);
  });

  it('scenario 2: summary.enabled=false cancels any scheduled row and creates none', async () => {
    const { ws } = await setupOwner('Europe/Moscow', '2026-09-23T03:00:00Z');
    const deps = makeDeps(fixedClock('2026-09-23T03:00:00Z'), ws, new FakeMessenger());

    await ensureSummariesJob.run(deps);
    const before = await scheduledSummaries(ws.id);
    expect(before).toHaveLength(1);
    const staleId = before[0]?.id as number;

    await updateSettings(db, ws.id, { summary: { enabled: false, time: '09:00' } });
    await ensureSummariesJob.run(deps);

    expect(await scheduledSummaries(ws.id)).toHaveLength(0);
    const [stale] = await db.select().from(notifications).where(eq(notifications.id, staleId));
    expect(stale?.status).toBe('cancelled');
  });

  it('scenario 3: changing summary.time via /settings recreates the scheduled row', async () => {
    const { ws } = await setupOwner('Europe/Moscow', '2026-09-23T03:00:00Z');
    const deps = makeDeps(fixedClock('2026-09-23T03:00:00Z'), ws, new FakeMessenger());

    await ensureSummariesJob.run(deps);
    const before = await scheduledSummaries(ws.id);
    expect(before).toHaveLength(1);
    const oldId = before[0]?.id as number;
    expect(before[0]?.fireAt.toISOString()).toBe('2026-09-23T06:00:00.000Z'); // 09:00 MSK

    await updateSettings(db, ws.id, { summary: { enabled: true, time: '18:00' } });
    await ensureSummariesJob.run(deps);

    // Same local calendar date (23 Sep) as before — the stale row is revived in place (same id, same
    // dedupe_key) with the new fire_at, rather than left permanently cancelled with nothing scheduled.
    const after = await scheduledSummaries(ws.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(oldId);
    expect(after[0]?.fireAt.toISOString()).toBe('2026-09-23T15:00:00.000Z'); // 18:00 MSK
  });

  it("scenario 4: a quiet day suppresses today's summary; tomorrow's is scheduled in the same tick", async () => {
    const { ws, owner, clock } = await setupOwner('Europe/Moscow', '2026-09-23T03:00:00Z');
    const messenger = new FakeMessenger();
    const deps = makeDeps(clock, ws, messenger);
    await updateSettings(db, ws.id, {
      summary: { enabled: true, time: '09:00' },
      quiet: {
        enabled: true,
        weekdays: [],
        windows: [],
        dateRanges: [{ from: '2026-09-23', to: '2026-09-23', label: 'Каникулы' }],
      },
    });

    await ensureSummariesJob.run(deps); // bootstrap: schedules today's 06:00Z (09:00 MSK) row
    const before = await scheduledSummaries(ws.id);
    expect(before).toHaveLength(1);
    const todayId = before[0]?.id as number;

    clock.set('2026-09-23T06:00:00Z');
    await tick(deps);

    expect(messenger.sent).toHaveLength(0);
    const [cancelled] = await db.select().from(notifications).where(eq(notifications.id, todayId));
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.lastError).toBe('quiet');

    const tomorrow = await scheduledSummaries(ws.id);
    expect(tomorrow).toHaveLength(1);
    expect(tomorrow[0]?.id).not.toBe(todayId);
    expect(tomorrow[0]?.fireAt.toISOString()).toBe('2026-09-24T06:00:00.000Z');
    expect(tomorrow[0]?.recipientUserId).toBe(owner.id);
  });

  it('a mid-retry row (attempts>0, shifted fire_at) survives ensureSummariesJob — not cancelled/duplicated (review round 2, I1)', async () => {
    const { ws, clock } = await setupOwner('Europe/Moscow', '2026-09-23T03:00:00Z');
    const messenger = new FakeMessenger();
    const deps = makeDeps(clock, ws, messenger);
    await updateSettings(db, ws.id, { summary: { enabled: true, time: '09:00' } });

    await ensureSummariesJob.run(deps); // bootstrap: schedules today's 06:00Z row
    const before = await scheduledSummaries(ws.id);
    expect(before).toHaveLength(1);
    const todayId = before[0]?.id;
    expect(before[0]?.fireAt.toISOString()).toBe('2026-09-23T06:00:00.000Z'); // 09:00 MSK

    clock.set('2026-09-23T06:00:00Z');
    messenger.failNextWith(new MessengerError('network', 'connection reset'));
    await notifyJob.run(deps);

    const afterFailure = await scheduledSummaries(ws.id);
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]?.id).toBe(todayId);
    expect(afterFailure[0]?.attempts).toBe(1);
    // Shifted by the 1-minute backoff — no longer lines up with settings.summary.time (09:00 MSK) at all.
    expect(afterFailure[0]?.fireAt.toISOString()).toBe('2026-09-23T06:01:00.000Z');

    // ensureSummariesJob must not read the shifted fire_at as stale: no cancel, no second row inserted.
    await ensureSummariesJob.run(deps);

    const afterEnsure = await scheduledSummaries(ws.id);
    expect(afterEnsure).toHaveLength(1);
    expect(afterEnsure[0]?.id).toBe(todayId);
    expect(afterEnsure[0]?.status).toBe('scheduled');

    const [row] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, todayId as number));
    expect(row?.status).toBe('scheduled');
    expect(row?.attempts).toBe(1);

    // The retry itself still succeeds once its (shifted) fire_at is reached.
    clock.set('2026-09-23T06:01:00Z');
    await notifyJob.run(deps);
    expect(messenger.sent).toHaveLength(1);
    const [sentRow] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, todayId as number));
    expect(sentRow?.status).toBe('sent');
  });

  it('is idempotent within one tick: running it twice in a row does not create a duplicate', async () => {
    const { ws } = await setupOwner('Europe/Moscow', '2026-09-23T03:00:00Z');
    const deps = makeDeps(fixedClock('2026-09-23T03:00:00Z'), ws, new FakeMessenger());

    await ensureSummariesJob.run(deps);
    await ensureSummariesJob.run(deps);

    expect(await scheduledSummaries(ws.id)).toHaveLength(1);
  });
});
