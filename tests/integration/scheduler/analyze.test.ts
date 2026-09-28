import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import { createDb } from '../../../src/db/client.js';
import { createLogger } from '../../../src/ops/logger.js';
import { createErrorReporter } from '../../../src/ops/errorReporter.js';
import { loadEnv } from '../../../src/config/env.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { getState } from '../../../src/domain/system/appState.js';
import { messages, memberships, analysisBatches } from '../../../src/db/schema/index.js';
import { analyzeJob } from '../../../src/scheduler/jobs/analyze.js';
import { enqueueBatches, claimNextBatch, recoverStaleBatches } from '../../../src/ai/pipeline/batcher.js';
import { LlmExtractionProvider } from '../../../src/ai/pipeline/extract.js';
import { FixtureClient } from '../../../src/ai/providers/fixture.js';
import type {
  AiProviders,
  ChatCompletionClient,
  CompletionResponse,
  DecisionProvider,
} from '../../../src/ai/providers/types.js';
import type { AppDeps } from '../../../src/deps.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://stb:stb@localhost:5433/stb_test';
const SUPERADMIN_ID = 900000001;
const ConsecutiveFailuresState = z.object({ count: z.number().int().nonnegative() });

const db = getTestDb();
beforeEach(() => truncateAll(db));

function makeConfig() {
  return loadEnv({
    TELEGRAM_BOT_TOKEN: 'test-token:ABC',
    DATABASE_URL: TEST_DATABASE_URL,
    SUPERADMIN_TG_IDS: String(SUPERADMIN_ID),
    LLM_DAILY_BUDGET_USD: '1',
    AI_PREFILTER_THRESHOLD: '0.15',
    GIT_SHA: 'test-sha',
  });
}

async function makeDeps(clock: ReturnType<typeof fixedClock>, ai: AiProviders | null): Promise<AppDeps> {
  const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
  const config = makeConfig();
  const messenger = new FakeMessenger();
  const logger = createLogger({ level: 'silent' });
  const errors = createErrorReporter({
    db,
    messenger,
    clock,
    logger,
    superadminIds: config.SUPERADMIN_TG_IDS,
  });
  return {
    config,
    db,
    clock,
    logger,
    errors,
    messenger,
    workspace,
    ai,
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

async function makeMember(
  workspaceId: number,
  tgUserId: number,
  name: string,
  role: 'owner' | 'member' = 'member',
) {
  const user = await upsertTelegramUser(db, { id: tgUserId, first_name: name });
  await db
    .insert(memberships)
    .values({ workspaceId, userId: user.id, role, displayName: name })
    .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] });
  return user;
}

async function insertMessage(
  chatId: number,
  tgMessageId: number,
  authorUserId: number,
  sentAt: Date,
  text: string,
) {
  const [row] = await db
    .insert(messages)
    .values({ chatId, tgMessageId, authorUserId, sentAt, text, analysisStatus: 'pending' })
    .returning();
  if (!row) throw new Error('failed to insert test message');
  return row;
}

/** Never-invoked `ChatCompletionClient`/`DecisionProvider` — used to prove a code path is not reached. */
const UNUSED_CLIENT: ChatCompletionClient = {
  complete(): Promise<CompletionResponse> {
    throw new Error('ChatCompletionClient.complete should not have been called');
  },
};

function extractorFrom(script: ReadonlyArray<CompletionResponse | Error>): AiProviders['extraction'] {
  return new LlmExtractionProvider(new FixtureClient(script), {
    primary: 'fixture/primary',
    fallback: null, // one model only → MAX_ATTEMPTS_PER_MODEL (2) client.complete() calls per extract()
    jsonSchema: null,
  });
}

function fakeDecision(probability: number, costUsd = 0.0001): DecisionProvider {
  return {
    hasActionableContent: () =>
      Promise.resolve({
        probability,
        usage: { inputTokens: 20, outputTokens: 0, costUsd },
        model: 'decision-fake',
      }),
  };
}

describe('enqueueBatches (SPEC §8)', () => {
  it('batches a chat’s pending messages once the quiet period elapses, and never includes a message saved afterward', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const chat = await makeActiveChat(ws.id, -100, now);
    const author = await makeMember(ws.id, 10, 'Maria');

    const threeMinAgo = new Date(now.getTime() - 3 * 60_000);
    const m1 = await insertMessage(chat.id, 1, author.id, new Date(threeMinAgo.getTime() - 20_000), 'привет');
    const m2 = await insertMessage(
      chat.id,
      2,
      author.id,
      new Date(threeMinAgo.getTime() - 10_000),
      'как дела',
    );
    const m3 = await insertMessage(chat.id, 3, author.id, threeMinAgo, 'до пятницы успею');

    const created = await enqueueBatches(db, { now });
    expect(created).toHaveLength(1);

    const [batch] = await db.select().from(analysisBatches).where(eq(analysisBatches.id, created[0]!));
    expect(batch?.status).toBe('queued');
    expect(batch?.kind).toBe('auto');
    expect(batch?.chatId).toBe(chat.id);
    expect(batch?.messageCount).toBe(3);

    for (const m of [m1, m2, m3]) {
      const [after] = await db.select().from(messages).where(eq(messages.id, m.id));
      expect(after?.batchId).toBe(batch?.id);
    }

    // A message saved after enqueueBatches ran is not swept into the already-created batch.
    const m4 = await insertMessage(chat.id, 4, author.id, now, 'новое сообщение');
    const [m4After] = await db.select().from(messages).where(eq(messages.id, m4.id));
    expect(m4After?.batchId).toBeNull();
  });

  it('never opens a second batch for a chat that already has one queued/running', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const chat = await makeActiveChat(ws.id, -101, now);
    const author = await makeMember(ws.id, 11, 'Boris');
    await insertMessage(chat.id, 1, author.id, new Date(now.getTime() - 200_000), 'первая пачка');

    const first = await enqueueBatches(db, { now });
    expect(first).toHaveLength(1);

    await insertMessage(chat.id, 2, author.id, new Date(now.getTime() - 200_000), 'вторая пачка');
    const second = await enqueueBatches(db, { now });
    expect(second).toHaveLength(0);
  });
});

describe('claimNextBatch (SPEC §8 — FOR UPDATE SKIP LOCKED)', () => {
  it('two concurrent callers never claim the same batch', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const chat = await makeActiveChat(ws.id, -102, now);
    const [batch] = await db
      .insert(analysisBatches)
      .values({ chatId: chat.id, status: 'queued', kind: 'auto' })
      .returning();
    if (!batch) throw new Error('failed to insert test batch');

    const conn1 = createDb(TEST_DATABASE_URL, { max: 1 });
    const conn2 = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      const [r1, r2] = await Promise.all([
        claimNextBatch(conn1.db, { now }),
        claimNextBatch(conn2.db, { now }),
      ]);
      const claimed = [r1, r2].filter((r) => r !== null);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.id).toBe(batch.id);

      const [after] = await db.select().from(analysisBatches).where(eq(analysisBatches.id, batch.id));
      expect(after?.status).toBe('running');
    } finally {
      await conn1.close();
      await conn2.close();
    }
  });
});

describe('recoverStaleBatches', () => {
  it('requeues a batch stuck running past its stale-claim deadline, and leaves a fresh one alone', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const chat = await makeActiveChat(ws.id, -103, now);

    const [stale] = await db
      .insert(analysisBatches)
      .values({
        chatId: chat.id,
        status: 'running',
        kind: 'auto',
        nextAttemptAt: new Date(now.getTime() - 6 * 60_000),
      })
      .returning();
    const [fresh] = await db
      .insert(analysisBatches)
      .values({
        chatId: chat.id,
        status: 'running',
        kind: 'auto',
        nextAttemptAt: new Date(now.getTime() + 60_000),
      })
      .returning();
    if (!stale || !fresh) throw new Error('failed to insert test batches');

    const recovered = await recoverStaleBatches(db, { now });
    expect(recovered).toBe(1);

    const [staleAfter] = await db.select().from(analysisBatches).where(eq(analysisBatches.id, stale.id));
    expect(staleAfter?.status).toBe('queued');
    expect(staleAfter?.nextAttemptAt).toBeNull();

    const [freshAfter] = await db.select().from(analysisBatches).where(eq(analysisBatches.id, fresh.id));
    expect(freshAfter?.status).toBe('running');
  });
});

describe('analyzeJob', () => {
  it('does nothing at all when deps.ai is null', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const deps = await makeDeps(clock, null);
    const chat = await makeActiveChat(deps.workspace.id, -200, clock.now());
    const author = await makeMember(deps.workspace.id, 20, 'Nina');
    await insertMessage(chat.id, 1, author.id, new Date(clock.now().getTime() - 200_000), 'поручение');

    await analyzeJob.run(deps);

    const batches = await db.select().from(analysisBatches);
    expect(batches).toHaveLength(0);
    const [msg] = await db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(msg?.batchId).toBeNull();
    expect(msg?.analysisStatus).toBe('pending');
  });

  it('skips the extractor when the prefilter probability is below the threshold, and still records its cost', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const ai: AiProviders = {
      extraction: { extract: () => Promise.reject(new Error('extractor should not have been called')) },
      decision: fakeDecision(0.1),
      client: UNUSED_CLIENT,
      models: { primary: 'fixture/primary', fallback: null },
    };
    const deps = await makeDeps(clock, ai);
    const chat = await makeActiveChat(deps.workspace.id, -201, clock.now());
    const author = await makeMember(deps.workspace.id, 21, 'Oleg');
    const msg = await insertMessage(
      chat.id,
      1,
      author.id,
      new Date(clock.now().getTime() - 200_000),
      'просто болтовня без задач',
    );

    await analyzeJob.run(deps);

    const [batch] = await db.select().from(analysisBatches).where(eq(analysisBatches.chatId, chat.id));
    expect(batch?.status).toBe('done');
    expect(batch?.prefilterModel).toBe('decision-fake');
    expect(batch?.model).toBeNull();
    expect(Number(batch?.costUsd)).toBeCloseTo(0.0001, 6);

    const [msgAfter] = await db.select().from(messages).where(eq(messages.id, msg.id));
    expect(msgAfter?.analysisStatus).toBe('analyzed');
  });

  it('on an LLM failure, backs off with attempts/next_attempt_at and keeps messages pending; gives up and alerts after the 5th', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const script = Array.from({ length: 10 }, () => new Error('llm down'));
    const ai: AiProviders = {
      extraction: extractorFrom(script),
      decision: null,
      client: UNUSED_CLIENT,
      models: { primary: 'fixture/primary', fallback: null },
    };
    const deps = await makeDeps(clock, ai);
    const chat = await makeActiveChat(deps.workspace.id, -202, clock.now());
    const author = await makeMember(deps.workspace.id, 22, 'Petr');
    const msg = await insertMessage(
      chat.id,
      1,
      author.id,
      new Date(clock.now().getTime() - 200_000),
      'Петя, сделай отчёт к пятнице',
    );

    const backoffMinutes = [1, 5, 15, 15, null] as const;
    for (const [i, minutes] of backoffMinutes.entries()) {
      await analyzeJob.run(deps);
      const [batch] = await db.select().from(analysisBatches).where(eq(analysisBatches.chatId, chat.id));
      expect(batch?.attempts).toBe(i + 1);

      const [msgAfter] = await db.select().from(messages).where(eq(messages.id, msg.id));
      expect(msgAfter?.analysisStatus).toBe('pending');
      expect(msgAfter?.batchId).toBe(batch?.id);

      if (minutes === null) {
        expect(batch?.status).toBe('failed');
        expect(batch?.nextAttemptAt).toBeNull();
      } else {
        expect(batch?.status).toBe('queued');
        expect(batch?.nextAttemptAt?.getTime()).toBe(clock.now().getTime() + minutes * 60_000);
        clock.advance(minutes * 60_000 + 1000);
      }
    }

    const superadminAlerts = (deps.messenger as FakeMessenger).sent.filter(
      (m) => m.chatId === SUPERADMIN_ID && m.text.includes('Анализ сообщений не удался'),
    );
    expect(superadminAlerts).toHaveLength(1);
  });

  it('alerts once after 5 consecutive LLM failures across different batches, and a success resets the streak', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const failScript = Array.from({ length: 10 }, () => new Error('llm down'));
    const ai: AiProviders = {
      extraction: extractorFrom(failScript),
      decision: null,
      client: UNUSED_CLIENT,
      models: { primary: 'fixture/primary', fallback: null },
    };
    const deps = await makeDeps(clock, ai);
    const now = clock.now();

    for (let i = 0; i < 5; i++) {
      const chat = await makeActiveChat(deps.workspace.id, -300 - i, now);
      const author = await makeMember(deps.workspace.id, 30 + i, `User${String(i)}`);
      await insertMessage(chat.id, 1, author.id, new Date(now.getTime() - 200_000), 'сообщение с поручением');
    }

    await analyzeJob.run(deps);

    const consecutive = await getState(db, 'llm:consecutive_failures', ConsecutiveFailuresState);
    expect(consecutive).toEqual({ count: 0 });

    const alertTexts = (deps.messenger as FakeMessenger).sent.filter(
      (m) => m.chatId === SUPERADMIN_ID && m.text.includes('ошибок LLM подряд'),
    );
    expect(alertTexts).toHaveLength(1);
    expect(alertTexts[0]?.text).toContain('5 ошибок LLM подряд');

    // One more chat whose prefilter call *succeeds* (skips the extractor) resets the streak — it was
    // already reset to 0 above, so this just proves a success keeps it at 0 rather than accumulating.
    const successAi: AiProviders = {
      extraction: { extract: () => Promise.reject(new Error('should not be called')) },
      decision: fakeDecision(0.1),
      client: UNUSED_CLIENT,
      models: { primary: 'fixture/primary', fallback: null },
    };
    const successDeps = { ...deps, ai: successAi };
    const chat = await makeActiveChat(deps.workspace.id, -399, clock.now());
    const author = await makeMember(deps.workspace.id, 39, 'Last');
    await insertMessage(chat.id, 1, author.id, new Date(clock.now().getTime() - 200_000), 'ещё сообщение');

    await analyzeJob.run(successDeps);
    const afterSuccess = await getState(db, 'llm:consecutive_failures', ConsecutiveFailuresState);
    expect(afterSuccess).toEqual({ count: 0 });
  });

  it('pauses auto-analysis once the daily budget is spent, alerts superadmin and owner once per day, and resumes the next day', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const emptyScriptAi: AiProviders = {
      extraction: extractorFrom([]),
      decision: null,
      client: UNUSED_CLIENT,
      models: { primary: 'fixture/primary', fallback: null },
    };
    const deps = await makeDeps(clock, emptyScriptAi);
    const owner = await makeMember(deps.workspace.id, 40, 'Anna', 'owner');
    const chat = await makeActiveChat(deps.workspace.id, -400, now);
    const author = await makeMember(deps.workspace.id, 41, 'Employee');
    const msg = await insertMessage(chat.id, 1, author.id, new Date(now.getTime() - 200_000), 'поручение');

    // Already spent the full daily budget today (Europe/Moscow), before this tick runs.
    await db.insert(analysisBatches).values({
      chatId: null,
      status: 'done',
      kind: 'auto',
      costUsd: '1',
      createdAt: now,
      finishedAt: now,
    });

    await analyzeJob.run(deps);

    const [batch] = await db.select().from(analysisBatches).where(eq(analysisBatches.chatId, chat.id));
    expect(batch?.status).toBe('queued'); // enqueued, never claimed
    expect(batch?.attempts).toBe(0);
    const [msgAfter] = await db.select().from(messages).where(eq(messages.id, msg.id));
    expect(msgAfter?.analysisStatus).toBe('pending');

    const budgetAlerts = (deps.messenger as FakeMessenger).sent.filter((m) => m.text.includes('бюджет'));
    expect(budgetAlerts.map((m) => m.chatId).sort()).toEqual([SUPERADMIN_ID, owner.tgUserId].sort());

    // Running again the same day must not re-notify.
    await analyzeJob.run(deps);
    const budgetAlertsAfter = (deps.messenger as FakeMessenger).sent.filter((m) => m.text.includes('бюджет'));
    expect(budgetAlertsAfter).toHaveLength(2);

    // The next calendar day (Europe/Moscow), spend resets and processing resumes.
    const tomorrow = DateTime.fromJSDate(now).setZone('Europe/Moscow').plus({ days: 1 }).toJSDate();
    clock.set(tomorrow.toISOString());
    await analyzeJob.run(deps);

    const [batchAfterResume] = await db
      .select()
      .from(analysisBatches)
      .where(eq(analysisBatches.chatId, chat.id));
    // `extractorFrom([])` rejects with "script exhausted" as soon as it is actually invoked — attempts
    // moving off 0 (and the batch leaving `queued` with no `error`) is the signal it was reached at all.
    expect(batchAfterResume?.attempts).toBe(1);
  });
});
