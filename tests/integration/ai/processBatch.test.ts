import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq, asc, inArray } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { EXTRACTOR_PROMPT_VERSION } from '../../../src/config/constants.js';
import { fixedClock } from '../../helpers/clock.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import { createLogger } from '../../../src/ops/logger.js';
import { createErrorReporter } from '../../../src/ops/errorReporter.js';
import { loadEnv } from '../../../src/config/env.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { analysisBatches, memberships, messages, proposals, tasks } from '../../../src/db/schema/index.js';
import { processBatch } from '../../../src/ai/pipeline/processBatch.js';
import { LlmExtractionProvider } from '../../../src/ai/pipeline/extract.js';
import { FixtureClient } from '../../../src/ai/providers/fixture.js';
import { resolveDue } from '../../../src/time/resolveDue.js';
import type {
  AiProviders,
  ChatCompletionClient,
  CompletionResponse,
} from '../../../src/ai/providers/types.js';
import type { AppDeps } from '../../../src/deps.js';
import type { BatchRow } from '../../../src/ai/pipeline/batcher.js';

// plan.md Task 2.10: `processBatch` turns one already-`claimNextBatch`-claimed
// batch (here inserted directly, skipping the batcher) into proposals — the
// extractor call goes through `FixtureClient` (CLAUDE.md forbids real LLM
// calls in tests), fixed clocks throughout.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://stb:stb@localhost:5433/stb_test';
const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/llm/', import.meta.url));

function loadFixture(name: string): CompletionResponse {
  const raw = readFileSync(`${FIXTURES_DIR}${name}.json`, 'utf8');
  return JSON.parse(raw) as CompletionResponse;
}

const db = getTestDb();
beforeEach(() => truncateAll(db));

const UNUSED_CLIENT: ChatCompletionClient = {
  complete(): Promise<CompletionResponse> {
    throw new Error('ChatCompletionClient.complete should not have been called');
  },
};

function extractorFrom(script: ReadonlyArray<CompletionResponse | Error>): {
  extraction: AiProviders['extraction'];
  client: FixtureClient;
} {
  const client = new FixtureClient(script);
  return {
    extraction: new LlmExtractionProvider(client, {
      primary: 'fixture/primary',
      fallback: null,
      jsonSchema: null,
    }),
    client,
  };
}

function makeConfig() {
  return loadEnv({
    TELEGRAM_BOT_TOKEN: 'test-token:ABC',
    DATABASE_URL: TEST_DATABASE_URL,
    SUPERADMIN_TG_IDS: '900000001',
    GIT_SHA: 'test-sha',
  });
}

async function makeDeps(
  clock: ReturnType<typeof fixedClock>,
  extraction: AiProviders['extraction'],
): Promise<AppDeps> {
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
  const ai: AiProviders = {
    extraction,
    decision: null,
    client: UNUSED_CLIENT,
    models: { primary: 'fixture/primary', fallback: null },
  };
  return { config, db, clock, logger, errors, messenger, workspace, ai, taskHooks: [] };
}

async function makeChat(workspaceId: number, tgChatId: number, now: Date) {
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

/** Inserts a `queued`→`running`-style batch row and assigns it every given message's `batch_id` (mirrors `enqueueBatches`/`claimNextBatch`, skipped here since this test drives `processBatch` directly). */
async function makeBatch(chatId: number, messageIds: number[]): Promise<BatchRow> {
  const [batch] = await db
    .insert(analysisBatches)
    .values({
      chatId,
      status: 'running',
      kind: 'auto',
      firstMessageId: messageIds[0],
      lastMessageId: messageIds[messageIds.length - 1],
      messageCount: messageIds.length,
    })
    .returning();
  if (!batch) throw new Error('failed to insert test batch');
  await db.update(messages).set({ batchId: batch.id }).where(inArray(messages.id, messageIds));
  return batch;
}

async function getBatch(id: number) {
  const [row] = await db.select().from(analysisBatches).where(eq(analysisBatches.id, id));
  return row;
}

async function proposalsForBatch(batchId: number) {
  return db.select().from(proposals).where(eq(proposals.batchId, batchId)).orderBy(asc(proposals.id));
}

describe('processBatch (plan.md Task 2.10)', () => {
  it('turns a plain assignment into one shown proposal, marks messages analyzed and the batch done with full bookkeeping', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const { extraction } = extractorFrom([loadFixture('valid_assignment')]);
    const deps = await makeDeps(clock, extraction);

    // Insertion order fixes participant codes (P1, P2, …) — Maria must be
    // P1 to match `valid_assignment.json`'s `"assignee_ref":"P1"`.
    const maria = await makeMember(deps.workspace.id, 1, 'Мария');
    const owner = await makeMember(deps.workspace.id, 2, 'Директор', 'owner');
    const chat = await makeChat(deps.workspace.id, -500, now);
    const msg = await insertMessage(chat.id, 1, owner.id, now, 'Маша, подготовь расписание к пятнице');
    const batch = await makeBatch(chat.id, [msg.id]);

    const result = await processBatch(deps, batch, { mode: 'auto' });
    expect(result).toEqual({ shown: 1, suppressed: 0 });

    const created = await proposalsForBatch(batch.id);
    expect(created).toHaveLength(1);
    const proposal = created[0]!;
    expect(proposal.kind).toBe('create');
    expect(proposal.category).toBe('assignment');
    expect(proposal.policyDecision).toBe('shown');
    expect(proposal.notifiedAt).toBeNull();
    expect(proposal.sourceMessageIds).toEqual([msg.id]);

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.assignee).toEqual({ type: 'user', userId: maria.id });
    expect(payload.dueText).toBe('к пятнице');
    expect(payload.priority).toBe('normal');
    expect(payload.origin).toBe('ai');
    expect(payload.quote).toBe('Маша, подготовь расписание к пятнице');
    expect(payload.quoteAuthorName).toBe('Директор');
    // D46: the quote's own author by internal `users.id`, straight off the source message.
    expect(payload.quoteAuthorUserId).toBe(owner.id);

    // The real, reviewed `resolveDue` (Task 2.5) is the source of truth for
    // what "к пятнице" resolves to — asserted by calling it the same way
    // `processBatch` does, not by hand-computing a clock-of-day: a
    // `due_local` date combined with `time_hint:"end_of_week"` resolves to
    // that date at `fuzzyTimes.defaultTime` (18:00), *not* to an all-day
    // 23:59 (that shape only comes from `time_hint:"none"` — see
    // `tests/unit/time/resolveDue.test.ts`'s `'дата есть → дата +
    // defaultTime'` case).
    const expectedDue = resolveDue(
      { due_local: '2026-10-02', time_hint: 'end_of_week', due_text: 'к пятнице' },
      {
        zone: 'Europe/Moscow',
        now,
        fuzzy: {
          morning: '10:00',
          afternoon: '15:00',
          evening: '19:00',
          endOfWeekDay: 5,
          endOfWeekTime: '18:00',
          soonWorkdays: 2,
          defaultTime: '18:00',
        },
      },
    );
    // Literal, independent of `resolveDue`'s own output (review round 1,
    // M6) — Europe/Moscow is UTC+3 year-round (no DST since 2014), so
    // 2026-10-02 18:00 MSK is 2026-10-02T15:00:00.000Z.
    expect(expectedDue.dueAt?.toISOString()).toBe('2026-10-02T15:00:00.000Z');
    expect(payload.due).toEqual({
      dueAt: '2026-10-02T15:00:00.000Z',
      allDay: false,
      tz: 'Europe/Moscow',
      inPast: false,
      invalid: false,
    });

    const [msgAfter] = await db.select().from(messages).where(eq(messages.id, msg.id));
    expect(msgAfter?.analysisStatus).toBe('analyzed');

    const batchAfter = await getBatch(batch.id);
    expect(batchAfter?.status).toBe('done');
    expect(batchAfter?.model).toBe('fixture/primary');
    expect(batchAfter?.promptVersion).toBe(EXTRACTOR_PROMPT_VERSION);
    expect(batchAfter?.inputTokens).toBe(512);
    expect(batchAfter?.outputTokens).toBe(96);
    expect(Number(batchAfter?.costUsd)).toBeCloseTo(0.00081, 6);
    expect(batchAfter?.latencyMs).toBe(0);
    expect(batchAfter?.rawResponse).toEqual({ id: 'fixture-valid-assignment', object: 'chat.completion' });
  });

  it('suppresses a low-confidence action, recording policy_reason and never touching notified_at', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const lowConfidence: CompletionResponse = {
      content: JSON.stringify({
        actions: [
          {
            type: 'create',
            category: 'assignment',
            title: 'Полить цветы в классе',
            description: null,
            assignee_ref: null,
            assignee_name_text: null,
            due: { due_local: null, time_hint: 'none', due_text: null },
            priority: 'normal',
            source_message_ids: ['M1'],
            confidence: 0.2,
            reasoning: 'неуверенно',
          },
        ],
      }),
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0001 },
      model: 'fixture/primary',
      raw: {},
    };
    const { extraction } = extractorFrom([lowConfidence]);
    const deps = await makeDeps(clock, extraction);
    const owner = await makeMember(deps.workspace.id, 1, 'Директор', 'owner');
    const chat = await makeChat(deps.workspace.id, -501, now);
    const msg = await insertMessage(chat.id, 1, owner.id, now, 'кто-нибудь польёт цветы?');
    const batch = await makeBatch(chat.id, [msg.id]);

    const result = await processBatch(deps, batch, { mode: 'auto' });
    expect(result).toEqual({ shown: 0, suppressed: 1 });

    const created = await proposalsForBatch(batch.id);
    expect(created).toHaveLength(1);
    expect(created[0]?.policyDecision).toBe('suppressed');
    expect(created[0]?.policyReason).toBe('below_low');
    expect(created[0]?.notifiedAt).toBeNull();
  });

  it('drops a hallucinated-ref action without persisting it, and warns with only the index/reason', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const { extraction } = extractorFrom([loadFixture('hallucinated_refs')]);
    const deps = await makeDeps(clock, extraction);
    const owner = await makeMember(deps.workspace.id, 1, 'Директор', 'owner');
    const chat = await makeChat(deps.workspace.id, -502, now);
    // Exactly one message in this batch — `hallucinated_refs.json`'s only
    // source ref is "M9", which can never exist here.
    const msg = await insertMessage(chat.id, 1, owner.id, now, 'разговор без задачи');
    const batch = await makeBatch(chat.id, [msg.id]);

    const warnSpy = vi.spyOn(deps.logger, 'warn');

    const result = await processBatch(deps, batch, { mode: 'auto' });
    expect(result).toEqual({ shown: 0, suppressed: 0 });

    const created = await proposalsForBatch(batch.id);
    expect(created).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [loggedArg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(loggedArg).toEqual({ batchId: batch.id, dropped: [{ index: 0, reason: 'unknown_message_refs' }] });
    // Never the message text — CLAUDE.md §8/SPEC §18.
    expect(JSON.stringify(loggedArg)).not.toContain('разговор');

    const batchAfter = await getBatch(batch.id);
    expect(batchAfter?.status).toBe('done');
    const [msgAfter] = await db.select().from(messages).where(eq(messages.id, msg.id));
    expect(msgAfter?.analysisStatus).toBe('analyzed');
  });

  it('flags a possible duplicate of an existing open task in payload.duplicateOf', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const { extraction } = extractorFrom([loadFixture('valid_assignment')]);
    const deps = await makeDeps(clock, extraction);
    const maria = await makeMember(deps.workspace.id, 1, 'Мария');
    const owner = await makeMember(deps.workspace.id, 2, 'Директор', 'owner');

    const [existingTask] = await db
      .insert(tasks)
      .values({
        workspaceId: deps.workspace.id,
        title: 'Подготовить расписание на октябрь',
        status: 'open',
        assigneeUserId: maria.id,
        origin: 'ai',
        createdAt: now,
      })
      .returning();
    if (!existingTask) throw new Error('failed to insert existing task');

    const chat = await makeChat(deps.workspace.id, -503, now);
    const msg = await insertMessage(chat.id, 1, owner.id, now, 'Маша, подготовь расписание к пятнице');
    const batch = await makeBatch(chat.id, [msg.id]);

    await processBatch(deps, batch, { mode: 'auto' });

    const created = await proposalsForBatch(batch.id);
    expect(created).toHaveLength(1);
    const payload = created[0]?.payload as Record<string, unknown>;
    expect(payload.duplicateOf).toEqual({
      type: 'task',
      id: existingTask.id,
      title: 'Подготовить расписание на октябрь',
    });
  });

  it('resolves a complete action against an open task by ref, setting kind and target_task_id', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const { extraction } = extractorFrom([loadFixture('valid_complete_t12')]);
    const deps = await makeDeps(clock, extraction);
    const author = await makeMember(deps.workspace.id, 1, 'Мария');
    const owner = await makeMember(deps.workspace.id, 2, 'Директор', 'owner');

    // `valid_complete_t12.json` targets "T12" — needs an open task with
    // exactly id=12 to be listed among this workspace's open tasks.
    const [task12] = await db
      .insert(tasks)
      .values({
        id: 12,
        workspaceId: deps.workspace.id,
        title: 'Отправить отчёт директору',
        status: 'open',
        assigneeUserId: author.id,
        origin: 'ai',
        createdAt: now,
      })
      .returning();
    if (!task12) throw new Error('failed to insert task 12');

    const chat = await makeChat(deps.workspace.id, -504, now);
    // The fixture's source ref is "M3" — three new messages, in order.
    const m1 = await insertMessage(chat.id, 1, owner.id, new Date(now.getTime() - 3000), 'как там отчёт?');
    const m2 = await insertMessage(chat.id, 2, author.id, new Date(now.getTime() - 2000), 'почти готово');
    const m3 = await insertMessage(
      chat.id,
      3,
      author.id,
      new Date(now.getTime() - 1000),
      'готово, отправила!',
    );
    const batch = await makeBatch(chat.id, [m1.id, m2.id, m3.id]);

    await processBatch(deps, batch, { mode: 'auto' });

    const created = await proposalsForBatch(batch.id);
    expect(created).toHaveLength(1);
    expect(created[0]?.kind).toBe('complete');
    expect(created[0]?.targetTaskId).toBe(task12.id);
    expect(created[0]?.sourceMessageIds).toEqual([m3.id]);
  });

  describe('D47 — new instruction vs update of an existing task (plan.md Task 3.15)', () => {
    async function setupTargetTask(deps: AppDeps, now: Date) {
      const maria = await makeMember(deps.workspace.id, 1, 'Мария');
      const veronika = await makeMember(deps.workspace.id, 2, 'Вероника');
      const owner = await makeMember(deps.workspace.id, 3, 'Директор', 'owner');
      const [task] = await db
        .insert(tasks)
        .values({
          id: 12,
          workspaceId: deps.workspace.id,
          title: 'Подготовить отчёт',
          status: 'open',
          assigneeUserId: maria.id,
          origin: 'ai',
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!task) throw new Error('failed to insert target task 12');
      return { maria, veronika, owner, task };
    }

    function updateFixture(args: {
      explicitTransfer: boolean;
      newTaskTitle: string | null;
      assigneeRef?: string;
    }): CompletionResponse {
      return {
        content: JSON.stringify({
          actions: [
            {
              type: 'update',
              target_ref: 'T12',
              changes: args.assigneeRef !== undefined ? { assignee_ref: args.assigneeRef } : {},
              explicit_transfer: args.explicitTransfer,
              new_task_title: args.newTaskTitle,
              source_message_ids: ['M1'],
              confidence: 0.85,
              reasoning: 'test',
            },
          ],
        }),
        usage: { inputTokens: 300, outputTokens: 50, costUsd: 0.0003 },
        model: 'fixture/primary',
        raw: {},
      };
    }

    it('splits into a new create proposal (not a dup of T12) when a different named assignee is not an explicit transfer', async () => {
      const clock = fixedClock('2026-09-23T09:00:00Z');
      const now = clock.now();
      const fixture = updateFixture({
        explicitTransfer: false,
        newTaskTitle: 'Подготовить отчёт',
        assigneeRef: 'P2',
      });
      const { extraction } = extractorFrom([fixture]);
      const deps = await makeDeps(clock, extraction);
      const { maria, veronika, owner, task } = await setupTargetTask(deps, now);

      const chat = await makeChat(deps.workspace.id, -510, now);
      const msg = await insertMessage(chat.id, 1, owner.id, now, 'Вероника, подготовь отчёт');
      const batch = await makeBatch(chat.id, [msg.id]);

      const result = await processBatch(deps, batch, { mode: 'auto' });
      expect(result).toEqual({ shown: 1, suppressed: 0 });

      const created = await proposalsForBatch(batch.id);
      expect(created).toHaveLength(1);
      const proposal = created[0]!;
      expect(proposal.kind).toBe('create');
      expect(proposal.targetTaskId).toBeNull();
      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.title).toBe('Подготовить отчёт');
      // The new named person (Veronika), not Maria (T12's own assignee) — proves this didn't silently
      // keep pointing at the old assignee.
      expect(payload.assignee).toEqual({ type: 'user', userId: veronika.id });
      // The whole point of D47's dedup-safety requirement (brief step 1.1): despite having the *exact
      // same* title as T12 (a certain trigram match) and being created in the same findPossibleDuplicate
      // pass, this proposal must NOT be flagged as a duplicate of T12 — their assignees differ. Before
      // this fix, a title-only dedup check would have matched them and suppressed/flagged this proposal.
      expect(payload.duplicateOf).toBeUndefined();

      // The target task itself is untouched (processBatch never writes to `tasks` on this path) — still
      // titled the same and still assigned to Maria, not Veronika.
      const [targetAfter] = await db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(targetAfter?.title).toBe('Подготовить отчёт');
      expect(targetAfter?.assigneeUserId).toBe(maria.id);
    });

    it('stays an update (assignee change on T12) when explicit_transfer is true', async () => {
      const clock = fixedClock('2026-09-23T09:00:00Z');
      const now = clock.now();
      const fixture = updateFixture({ explicitTransfer: true, newTaskTitle: null, assigneeRef: 'P2' });
      const { extraction } = extractorFrom([fixture]);
      const deps = await makeDeps(clock, extraction);
      const { veronika, owner, task } = await setupTargetTask(deps, now);

      const chat = await makeChat(deps.workspace.id, -511, now);
      const msg = await insertMessage(chat.id, 1, owner.id, now, 'передай отчёт Веронике');
      const batch = await makeBatch(chat.id, [msg.id]);

      await processBatch(deps, batch, { mode: 'auto' });

      const created = await proposalsForBatch(batch.id);
      expect(created).toHaveLength(1);
      const proposal = created[0]!;
      expect(proposal.kind).toBe('update');
      expect(proposal.targetTaskId).toBe(task.id);
      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.changes).toMatchObject({ assignee: { type: 'user', userId: veronika.id } });
    });

    it('stays an update and carries payload.newTaskTitle when there is no assignee change', async () => {
      const clock = fixedClock('2026-09-23T09:00:00Z');
      const now = clock.now();
      const fixture = updateFixture({ explicitTransfer: false, newTaskTitle: 'Подготовить отчёт' });
      const { extraction } = extractorFrom([fixture]);
      const deps = await makeDeps(clock, extraction);
      const { owner, task } = await setupTargetTask(deps, now);

      const chat = await makeChat(deps.workspace.id, -512, now);
      const msg = await insertMessage(chat.id, 1, owner.id, now, 'отчёт перенесём на четверг');
      const batch = await makeBatch(chat.id, [msg.id]);

      await processBatch(deps, batch, { mode: 'auto' });

      const created = await proposalsForBatch(batch.id);
      expect(created).toHaveLength(1);
      const proposal = created[0]!;
      expect(proposal.kind).toBe('update');
      expect(proposal.targetTaskId).toBe(task.id);
      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.newTaskTitle).toBe('Подготовить отчёт');
    });
  });

  it('rolls the whole transaction back when insertProposal fails on the second proposal: no proposals, messages stay pending, batch stays unfinished', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const twoAssignments: CompletionResponse = {
      content: JSON.stringify({
        actions: [
          {
            type: 'create',
            category: 'assignment',
            title: 'Заказать канцтовары',
            description: null,
            assignee_ref: null,
            assignee_name_text: null,
            due: { due_local: null, time_hint: 'none', due_text: null },
            priority: 'normal',
            source_message_ids: ['M1'],
            confidence: 0.9,
            reasoning: 'первое поручение',
          },
          {
            type: 'create',
            category: 'assignment',
            title: 'Заказать канцтовары для второго класса',
            description: null,
            assignee_ref: null,
            assignee_name_text: null,
            due: { due_local: null, time_hint: 'none', due_text: null },
            priority: 'normal',
            source_message_ids: ['M2'],
            confidence: 0.9,
            reasoning: 'второе поручение',
          },
        ],
      }),
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0001 },
      model: 'fixture/primary',
      raw: {},
    };
    const { extraction } = extractorFrom([twoAssignments]);
    const deps = await makeDeps(clock, extraction);
    const owner = await makeMember(deps.workspace.id, 1, 'Директор', 'owner');
    const chat = await makeChat(deps.workspace.id, -505, now);
    const m1 = await insertMessage(
      chat.id,
      1,
      owner.id,
      new Date(now.getTime() - 2000),
      'первое поручение текст',
    );
    const m2 = await insertMessage(
      chat.id,
      2,
      owner.id,
      new Date(now.getTime() - 1000),
      'второе поручение текст',
    );
    const batch = await makeBatch(chat.id, [m1.id, m2.id]);

    // Forces a *real* Postgres unique-violation on the transaction's second
    // `insertProposal` call, not a mocked throw: right after `truncateAll`
    // resets `proposals_id_seq` to start at 1, this placeholder row
    // explicitly occupies id=2 (an explicit value bypasses the sequence, so
    // it does not consume it). The transaction's first `insertProposal`
    // then gets the sequence's own id=1 (free, succeeds); its second gets
    // id=2 — which collides with this row — and Postgres rejects it inside
    // the same transaction `processBatch` opened, so the rollback this test
    // checks for is the database's own, not simulated.
    await db.insert(proposals).values({
      id: 2,
      workspaceId: deps.workspace.id,
      kind: 'create',
      category: null,
      payload: { reasoning: 'placeholder', origin: 'ai', quote: null, quoteAuthorName: null },
      confidence: 0,
      policyDecision: 'suppressed',
      policyReason: 'placeholder',
      sourceMessageIds: [],
    });

    await expect(processBatch(deps, batch, { mode: 'auto' })).rejects.toThrow();

    // Only the placeholder row survives — both of the transaction's own
    // inserts (including the first, which succeeded before the second
    // failed) were rolled back with it.
    const allProposals = await db.select().from(proposals);
    expect(allProposals).toHaveLength(1);
    expect(allProposals[0]?.id).toBe(2);
    expect(allProposals[0]?.policyReason).toBe('placeholder');

    const [m1After] = await db.select().from(messages).where(eq(messages.id, m1.id));
    const [m2After] = await db.select().from(messages).where(eq(messages.id, m2.id));
    expect(m1After?.analysisStatus).toBe('pending');
    expect(m2After?.analysisStatus).toBe('pending');

    const batchAfter = await getBatch(batch.id);
    expect(batchAfter?.status).toBe('running'); // never flipped to `done` — the whole update rolled back too
    expect(batchAfter?.model).toBeNull();
  });

  it('feeds a same-window skipped message in as context (M-ctx-#), never as a new message, and leaves its status untouched', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const { extraction, client } = extractorFrom([loadFixture('empty_actions')]);
    const deps = await makeDeps(clock, extraction);
    const owner = await makeMember(deps.workspace.id, 1, 'Директор', 'owner');
    const chat = await makeChat(deps.workspace.id, -506, now);

    // The skipped message must sit *within* the batch's own [earliest,
    // latest] sentAt window to count as "same time window" — an earlier
    // batch message anchors that window's start, a later one its end.
    const early = await insertMessage(
      chat.id,
      1,
      owner.id,
      new Date(now.getTime() - 10_000),
      'подготовьте отчёт',
    );
    const skipped = await insertMessage(
      chat.id,
      2,
      owner.id,
      new Date(now.getTime() - 5000),
      'спасибо большое',
    );
    await db.update(messages).set({ analysisStatus: 'skipped' }).where(eq(messages.id, skipped.id));
    const late = await insertMessage(chat.id, 3, owner.id, now, 'напомните завтра');
    const batch = await makeBatch(chat.id, [early.id, late.id]);

    await processBatch(deps, batch, { mode: 'auto' });

    // `buildExtractionInput` always appends the real rendered data block as
    // the *last* message — everything before it (system prompt, then the
    // few-shot `user`/`assistant` pairs from `examples.school_ru.json`,
    // which use their own static sample participants/messages) is not this
    // call's actual input.
    const request = client.requests[0];
    const userContent = request?.messages.at(-1)?.content;
    expect(userContent).toBeDefined();
    expect(userContent).toContain('M-ctx-1');
    expect(userContent).toContain('спасибо большое');
    // The skipped message's text must appear only under its context ref,
    // never promoted to a bare "M#" new-message ref (M1/M2 belong to
    // `early`/`late`, the batch's own two messages).
    expect(userContent).not.toMatch(/^M[12] \[.*спасибо большое/m);

    const [skippedAfter] = await db.select().from(messages).where(eq(messages.id, skipped.id));
    expect(skippedAfter?.analysisStatus).toBe('skipped');
    const [earlyAfter] = await db.select().from(messages).where(eq(messages.id, early.id));
    const [lateAfter] = await db.select().from(messages).where(eq(messages.id, late.id));
    expect(earlyAfter?.analysisStatus).toBe('analyzed');
    expect(lateAfter?.analysisStatus).toBe('analyzed');
  });

  it('saves noReaction: true into the payload of every proposal created in a /reanalyze-style call', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const { extraction } = extractorFrom([loadFixture('valid_assignment')]);
    const deps = await makeDeps(clock, extraction);
    // Needed only so "P1" (the fixture's `assignee_ref`) resolves to
    // *someone* — this test doesn't otherwise care who.
    await makeMember(deps.workspace.id, 1, 'Мария');
    const owner = await makeMember(deps.workspace.id, 2, 'Директор', 'owner');
    const chat = await makeChat(deps.workspace.id, -507, now);
    const msg = await insertMessage(chat.id, 1, owner.id, now, 'Маша, подготовь расписание к пятнице');
    const batch = await makeBatch(chat.id, [msg.id]);

    await processBatch(deps, batch, { mode: 'manual', noReaction: true });

    const created = await proposalsForBatch(batch.id);
    expect(created).toHaveLength(1);
    const payload = created[0]?.payload as Record<string, unknown>;
    expect(payload.noReaction).toBe(true);
    // `mode: 'manual'` never suppresses (CLAUDE.md's recall-first rule) —
    // proves this call actually took the manual-mode path, not a fluke.
    expect(created[0]?.policyDecision).toBe('shown');
    expect(created[0]?.policyReason).toBe('manual_override');
  });

  it('resolves a reply to an earlier, already-analyzed message from a previous batch via the default reply-to-author assignee rule (review round 1, I2)', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const now = clock.now();
    const noAssigneeRef: CompletionResponse = {
      content: JSON.stringify({
        actions: [
          {
            type: 'create',
            category: 'assignment',
            title: 'Добавить документы в папку',
            description: null,
            // No `assignee_ref`/`assignee_name_text` at all — this is
            // exactly the case SPEC §9.6's default-assignee rule covers:
            // an `assignment` in reply to someone goes to that person.
            assignee_ref: null,
            assignee_name_text: null,
            due: { due_local: null, time_hint: 'none', due_text: null },
            priority: 'normal',
            source_message_ids: ['M1'],
            confidence: 0.9,
            reasoning: 'ответ на сообщение Бориса',
          },
        ],
      }),
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0001 },
      model: 'fixture/primary',
      raw: {},
    };
    const { extraction } = extractorFrom([noAssigneeRef]);
    const deps = await makeDeps(clock, extraction);
    const boris = await makeMember(deps.workspace.id, 1, 'Борис');
    const owner = await makeMember(deps.workspace.id, 2, 'Директор', 'owner');
    const chat = await makeChat(deps.workspace.id, -508, now);

    // Simulates a message an *earlier* batch already ran through
    // `processBatch` and marked `analyzed` — inserted directly here rather
    // than via a real prior `processBatch` call, since only its presence
    // and status matter for this test.
    const earlier = await insertMessage(
      chat.id,
      1,
      boris.id,
      new Date(now.getTime() - 100_000),
      'куплю папки сегодня',
    );
    await db.update(messages).set({ analysisStatus: 'analyzed' }).where(eq(messages.id, earlier.id));

    const reply = await insertMessage(chat.id, 2, owner.id, now, 'ок, положите туда и документы тоже');
    await db.update(messages).set({ replyToTgMessageId: 1 }).where(eq(messages.id, reply.id));
    const batch = await makeBatch(chat.id, [reply.id]);

    await processBatch(deps, batch, { mode: 'auto' });

    const created = await proposalsForBatch(batch.id);
    expect(created).toHaveLength(1);
    const payload = created[0]?.payload as Record<string, unknown>;
    // Resolved only via `replyToAuthorUserId`, which is only reachable
    // because `earlier` (from a chat history *before* this batch, not
    // within its own [earliest, latest] window) is loaded as context —
    // proving this test is genuinely exercising I2's fix, not the
    // narrower same-window case the "skipped message" test above already
    // covers.
    expect(payload.assignee).toEqual({ type: 'user', userId: boris.id });
  });
});
