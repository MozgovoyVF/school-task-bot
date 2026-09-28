import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { createLogger } from '../../../src/ops/logger.js';
import { loadEnv } from '../../../src/config/env.js';
import { ensureDefaultWorkspace, updateSettings } from '../../../src/domain/workspaces/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { runRetention } from '../../../src/domain/chats/retention.js';
import { retentionJob } from '../../../src/scheduler/jobs/retention.js';
import { messages, analysisBatches, proposals } from '../../../src/db/schema/index.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

const DEFAULT_TEST_DATABASE_URL = 'postgres://stb:stb@localhost:5433/stb_test';
const DAY_MS = 24 * 60 * 60 * 1000;

// No explicit return type (see tests/integration/scheduler/pendingChats.test.ts's `makeDeps` for why).
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

async function makeActiveChat(workspaceId: number, tgChatId: number, now: Date) {
  return upsertChatOnAdd(db, {
    tgChatId,
    title: `Chat ${String(tgChatId)}`,
    type: 'supergroup',
    workspaceId,
    addedByUserId: null,
    status: 'active',
    pendingSince: null,
    now,
  });
}

async function insertMessage(chatId: number, tgMessageId: number, sentAt: Date, text: string | null = 'hi') {
  const [row] = await db
    .insert(messages)
    .values({ chatId, tgMessageId, sentAt, text, analysisStatus: 'analyzed' })
    .returning();
  if (!row) throw new Error('insertMessage: insert returned no row');
  return row;
}

describe('runRetention', () => {
  it('deletes messages older than the workspace default (30d) but keeps ones only 29d old', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const deps = await makeDeps(clock);
    const now = clock.now();
    const chat = await makeActiveChat(deps.workspace.id, -1, now);

    const old = await insertMessage(chat.id, 1, new Date(now.getTime() - 31 * DAY_MS));
    const recent = await insertMessage(chat.id, 2, new Date(now.getTime() - 29 * DAY_MS));

    const result = await runRetention(db, { now });

    expect(result.deletedMessages).toBe(1);
    expect(result.clearedTexts).toBe(0);
    expect(result.clearedRaw).toBe(0);

    const [oldAfter] = await db.select().from(messages).where(eq(messages.id, old.id));
    expect(oldAfter).toBeUndefined();

    const [recentAfter] = await db.select().from(messages).where(eq(messages.id, recent.id));
    expect(recentAfter?.text).toBe('hi');
  });

  it('keeps (but blanks the text of) an old message still referenced by a pending proposal', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const deps = await makeDeps(clock);
    const now = clock.now();
    const chat = await makeActiveChat(deps.workspace.id, -2, now);

    const referenced = await insertMessage(chat.id, 1, new Date(now.getTime() - 31 * DAY_MS));
    await db.insert(proposals).values({
      workspaceId: deps.workspace.id,
      chatId: chat.id,
      kind: 'create',
      payload: { title: 'test' },
      confidence: 0.8,
      policyDecision: 'shown',
      status: 'pending',
      sourceMessageIds: [referenced.id],
    });

    const result = await runRetention(db, { now });

    expect(result.deletedMessages).toBe(0);
    expect(result.clearedTexts).toBe(1);

    const [after] = await db.select().from(messages).where(eq(messages.id, referenced.id));
    expect(after).not.toBeUndefined();
    expect(after?.text).toBeNull();
  });

  it('blanks analysis_batches.raw_response once the batch is older than batchRawDays (30d)', async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const deps = await makeDeps(clock);
    const now = clock.now();
    const chat = await makeActiveChat(deps.workspace.id, -3, now);

    const [oldBatch] = await db
      .insert(analysisBatches)
      .values({
        chatId: chat.id,
        status: 'done',
        rawResponse: { raw: true },
        createdAt: new Date(now.getTime() - 31 * DAY_MS),
      })
      .returning();
    if (!oldBatch) throw new Error('insert returned no row');

    const [recentBatch] = await db
      .insert(analysisBatches)
      .values({
        chatId: chat.id,
        status: 'done',
        rawResponse: { raw: true },
        createdAt: new Date(now.getTime() - 10 * DAY_MS),
      })
      .returning();
    if (!recentBatch) throw new Error('insert returned no row');

    const result = await runRetention(db, { now });

    expect(result.clearedRaw).toBe(1);

    const [oldAfter] = await db.select().from(analysisBatches).where(eq(analysisBatches.id, oldBatch.id));
    expect(oldAfter?.rawResponse).toBeNull();

    const [recentAfter] = await db
      .select()
      .from(analysisBatches)
      .where(eq(analysisBatches.id, recentBatch.id));
    expect(recentAfter?.rawResponse).toEqual({ raw: true });
  });

  it("uses the chat's workspace settings.retention.messageDays (e.g. 10) instead of the 30d default", async () => {
    const clock = fixedClock('2026-09-28T12:00:00Z');
    const deps = await makeDeps(clock);
    const now = clock.now();
    await updateSettings(db, deps.workspace.id, { retention: { messageDays: 10 } });
    const chat = await makeActiveChat(deps.workspace.id, -4, now);

    const old = await insertMessage(chat.id, 1, new Date(now.getTime() - 11 * DAY_MS));
    const recent = await insertMessage(chat.id, 2, new Date(now.getTime() - 9 * DAY_MS));

    const result = await runRetention(db, { now });

    expect(result.deletedMessages).toBe(1);

    const [oldAfter] = await db.select().from(messages).where(eq(messages.id, old.id));
    expect(oldAfter).toBeUndefined();

    const [recentAfter] = await db.select().from(messages).where(eq(messages.id, recent.id));
    expect(recentAfter).not.toBeUndefined();
  });
});

describe('retentionJob', () => {
  it('runs the cleanup once per UTC day — a second same-day tick leaves a newly-stale message untouched', async () => {
    const clock = fixedClock('2026-09-24T03:31:00Z');
    const deps = await makeDeps(clock);
    const now = clock.now();
    const chat = await makeActiveChat(deps.workspace.id, -5, now);

    const firstStale = await insertMessage(chat.id, 1, new Date(now.getTime() - 31 * DAY_MS));

    await retentionJob.run(deps);

    const [firstAfter] = await db.select().from(messages).where(eq(messages.id, firstStale.id));
    expect(firstAfter).toBeUndefined(); // proves the job actually ran once

    const secondStale = await insertMessage(chat.id, 2, new Date(now.getTime() - 31 * DAY_MS));

    await retentionJob.run(deps); // same UTC day, no clock advance

    const [secondAfter] = await db.select().from(messages).where(eq(messages.id, secondStale.id));
    expect(secondAfter).not.toBeUndefined(); // the second tick was a no-op — proves it did not re-run
  });
});
