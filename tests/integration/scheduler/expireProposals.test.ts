import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { createLogger } from '../../../src/ops/logger.js';
import { loadEnv } from '../../../src/config/env.js';
import { ensureDefaultWorkspace, updateSettings } from '../../../src/domain/workspaces/repo.js';
import { insertProposal, type ProposalPayload } from '../../../src/domain/proposals/repo.js';
import { expireProposalsJob } from '../../../src/scheduler/jobs/expireProposals.js';
import { proposals } from '../../../src/db/schema/index.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import type { AppDeps } from '../../../src/deps.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://stb:stb@localhost:5433/stb_test';

async function makeDeps(clock: ReturnType<typeof fixedClock>): Promise<AppDeps> {
  const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
  return {
    config: loadEnv({
      TELEGRAM_BOT_TOKEN: 'test-token:ABC',
      DATABASE_URL: TEST_DATABASE_URL,
      SUPERADMIN_TG_IDS: '900000001',
      GIT_SHA: 'test-sha',
    }),
    db,
    clock,
    logger: createLogger({ level: 'silent' }),
    errors: { report: () => Promise.resolve(), alert: () => Promise.resolve() },
    messenger: new FakeMessenger(),
    workspace,
    ai: null,
    taskHooks: [],
  };
}

function basePayload(overrides: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    title: 'Test',
    description: null,
    category: 'assignment',
    assignee: { type: 'none' },
    due: null,
    dueText: null,
    priority: 'normal',
    reasoning: 'test',
    origin: 'ai',
    quote: null,
    quoteAuthorName: null,
    quoteAuthorUserId: null,
    ...overrides,
  };
}

async function makeProposal(workspaceId: number, createdAt: Date) {
  return db.transaction((tx) =>
    insertProposal(tx, {
      workspaceId,
      chatId: null,
      batchId: null,
      kind: 'create',
      category: 'assignment',
      payload: basePayload(),
      targetTaskId: null,
      confidence: 0.8,
      policyDecision: 'shown',
      policyReason: 'above_low',
      sourceMessageIds: [],
      createdAt,
    }),
  );
}

describe('expireProposalsJob', () => {
  it('expires a pending proposal older than proposalExpiryDays (7d default) but keeps a 6d-old one', async () => {
    const clock = fixedClock('2026-09-28T04:00:00Z'); // past the 03:40 UTC daily cutoff
    const deps = await makeDeps(clock);
    const now = clock.now();

    const old = await makeProposal(deps.workspace.id, new Date(now.getTime() - 8 * DAY_MS));
    const recent = await makeProposal(deps.workspace.id, new Date(now.getTime() - 6 * DAY_MS));

    await expireProposalsJob.run(deps);

    const [oldAfter] = await db.select().from(proposals).where(eq(proposals.id, old.id));
    expect(oldAfter?.status).toBe('expired');

    const [recentAfter] = await db.select().from(proposals).where(eq(proposals.id, recent.id));
    expect(recentAfter?.status).toBe('pending');
  });

  it('never touches an already-decided proposal', async () => {
    const clock = fixedClock('2026-09-28T04:00:00Z');
    const deps = await makeDeps(clock);
    const now = clock.now();

    const accepted = await makeProposal(deps.workspace.id, new Date(now.getTime() - 30 * DAY_MS));
    await db.update(proposals).set({ status: 'accepted' }).where(eq(proposals.id, accepted.id));

    await expireProposalsJob.run(deps);

    const [after] = await db.select().from(proposals).where(eq(proposals.id, accepted.id));
    expect(after?.status).toBe('accepted');
  });

  it('respects a workspace-configured proposalExpiryDays', async () => {
    const clock = fixedClock('2026-09-28T04:00:00Z');
    const deps = await makeDeps(clock);
    await updateSettings(db, deps.workspace.id, { ai: { proposalExpiryDays: 3 } });
    const now = clock.now();

    const old = await makeProposal(deps.workspace.id, new Date(now.getTime() - 4 * DAY_MS));

    await expireProposalsJob.run(deps);

    const [after] = await db.select().from(proposals).where(eq(proposals.id, old.id));
    expect(after?.status).toBe('expired');
  });

  it('only runs once per UTC calendar day (dailyJob guard)', async () => {
    const clock = fixedClock('2026-09-28T04:00:00Z');
    const deps = await makeDeps(clock);
    const now = clock.now();
    const old = await makeProposal(deps.workspace.id, new Date(now.getTime() - 8 * DAY_MS));

    await expireProposalsJob.run(deps);
    // A second, still-8d-old proposal created after the first run — must wait for the next day.
    const secondOld = await makeProposal(deps.workspace.id, new Date(now.getTime() - 8 * DAY_MS));
    await expireProposalsJob.run(deps);

    const [firstAfter] = await db.select().from(proposals).where(eq(proposals.id, old.id));
    const [secondAfter] = await db.select().from(proposals).where(eq(proposals.id, secondOld.id));
    expect(firstAfter?.status).toBe('expired');
    expect(secondAfter?.status).toBe('pending');
  });
});
