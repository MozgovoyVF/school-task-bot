import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { createLogger } from '../../../src/ops/logger.js';
import { loadEnv } from '../../../src/config/env.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { chats } from '../../../src/db/schema/index.js';
import { pendingChatsJob } from '../../../src/scheduler/jobs/pendingChats.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

const DEFAULT_TEST_DATABASE_URL = 'postgres://stb:stb@localhost:5433/stb_test';
const HOUR_MS = 60 * 60 * 1000;

// No explicit return type (see ticker.test.ts's `makeDeps` for why): it would widen `errors`'s
// vi.fn-free plain-async-function mocks and trips nothing here, but keeping the same shape as the
// sibling test file avoids surprises if this grows a spy later.
async function makeDeps(clock: ReturnType<typeof fixedClock>) {
  const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
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
      report: () => Promise.resolve(),
      alert: () => Promise.resolve(),
    },
    messenger: new FakeMessenger(),
    workspace,
    ai: null,
    taskHooks: [],
  };
}

async function makePendingChat(workspaceId: number, tgChatId: number, pendingSince: Date | null, now: Date) {
  return upsertChatOnAdd(db, {
    tgChatId,
    title: `Chat ${String(tgChatId)}`,
    type: 'supergroup',
    workspaceId,
    addedByUserId: null,
    status: 'pending',
    pendingSince,
    now,
  });
}

describe('pendingChatsJob', () => {
  it('leaves and marks left only chats pending for over 72h — not ones pending 71h, nor ones with pending_since=null', async () => {
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const deps = await makeDeps(clock);
    const now = clock.now();

    const expired = await makePendingChat(
      deps.workspace.id,
      -1,
      new Date(now.getTime() - (72 * HOUR_MS + 60_000)),
      now,
    );
    const recent = await makePendingChat(deps.workspace.id, -2, new Date(now.getTime() - 71 * HOUR_MS), now);
    const noOwnerYet = await makePendingChat(deps.workspace.id, -3, null, now);

    await pendingChatsJob.run(deps);

    const [expiredAfter] = await db.select().from(chats).where(eq(chats.id, expired.id));
    expect(expiredAfter?.status).toBe('left');
    expect(deps.messenger.left).toContain(-1);

    const [recentAfter] = await db.select().from(chats).where(eq(chats.id, recent.id));
    expect(recentAfter?.status).toBe('pending');
    expect(deps.messenger.left).not.toContain(-2);

    const [noOwnerAfter] = await db.select().from(chats).where(eq(chats.id, noOwnerYet.id));
    expect(noOwnerAfter?.status).toBe('pending');
    expect(deps.messenger.left).not.toContain(-3);
  });

  it('does nothing when there are no expired pending chats', async () => {
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const deps = await makeDeps(clock);

    await expect(pendingChatsJob.run(deps)).resolves.toBeUndefined();
    expect(deps.messenger.left).toEqual([]);
  });
});
