import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { callback, botKeyboardMessage } from '../../helpers/updates.js';
import { encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import {
  insertProposal,
  type ProposalPayload,
  type ProposalRow,
} from '../../../src/domain/proposals/repo.js';
import { acceptProposal } from '../../../src/domain/proposals/decide.js';
import { updateSettings } from '../../../src/domain/workspaces/repo.js';
import {
  chats,
  memberships,
  messages,
  proposals,
  tasks,
  taskEvents,
  workspaces,
} from '../../../src/db/schema/index.js';
import type { TaskRow } from '../../../src/domain/tasks/repo.js';
import { createDb } from '../../../src/db/client.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };
// Matches `tests/helpers/db.ts`'s own `DEFAULT_TEST_DATABASE_URL` fallback pattern.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://stb:stb@localhost:5433/stb_test';

function fake(harness: BotHarness): FakeMessenger {
  return harness.deps.messenger as FakeMessenger;
}

function lastEditTo(harness: BotHarness, chatId: number) {
  const edits = fake(harness).edits.filter((e) => e.chatId === chatId);
  const last = edits[edits.length - 1];
  if (!last) throw new Error(`no edit sent to ${String(chatId)}`);
  return last;
}

/** The `text` of the most recent `answerCallbackQuery` call — the toast/alert shown to the presser,
 * distinct from `lastEditTo`'s card edit. `undefined` for a bare `answerCallbackQuery()` with no text. */
function lastAnswerText(harness: BotHarness): string | undefined {
  const calls = harness.calls.filter((c) => c.method === 'answerCallbackQuery');
  const last = calls[calls.length - 1];
  return typeof last?.payload.text === 'string' ? last.payload.text : undefined;
}

async function makeOwner(harness: BotHarness, tgUser: { id: number; firstName: string }) {
  const userRow = await upsertTelegramUser(harness.db, { id: tgUser.id, first_name: tgUser.firstName });
  await harness.db.insert(memberships).values({
    workspaceId: harness.deps.workspace.id,
    userId: userRow.id,
    role: 'owner',
    displayName: tgUser.firstName,
  });
  return userRow;
}

async function makeMember(harness: BotHarness, tgUser: { id: number; firstName: string }) {
  const userRow = await upsertTelegramUser(harness.db, { id: tgUser.id, first_name: tgUser.firstName });
  await harness.db.insert(memberships).values({
    workspaceId: harness.deps.workspace.id,
    userId: userRow.id,
    role: 'member',
    displayName: tgUser.firstName,
  });
  return userRow;
}

async function makeSupergroupChat(
  harness: BotHarness,
  tgChatId: number,
  title: string,
  overrides: { reactionsEnabled?: boolean } = {},
) {
  const [row] = await harness.db
    .insert(chats)
    .values({
      tgChatId,
      workspaceId: harness.deps.workspace.id,
      title,
      type: 'supergroup',
      status: 'active',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('expected the chat row to be inserted');
  return row;
}

async function makeSourceMessage(harness: BotHarness, chatId: number, tgMessageId: number, text: string) {
  const [row] = await harness.db
    .insert(messages)
    .values({ chatId, tgMessageId, sentAt: harness.clock.now(), text, analysisStatus: 'analyzed' })
    .returning();
  if (!row) throw new Error('expected the message row to be inserted');
  return row;
}

function defaultPayload(overrides: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    title: 'Подготовить расписание на октябрь',
    description: null,
    category: 'assignment',
    assignee: { type: 'none' },
    due: null,
    dueText: null,
    priority: 'normal',
    reasoning: 'test fixture',
    origin: 'ai',
    quote: 'Маша, подготовь расписание к пятнице',
    quoteAuthorName: 'Анна',
    ...overrides,
  };
}

async function insertCreateProposal(
  harness: BotHarness,
  opts: { chatId?: number | null; sourceMessageIds?: number[]; payload?: Partial<ProposalPayload> } = {},
): Promise<ProposalRow> {
  return harness.db.transaction((tx) =>
    insertProposal(tx, {
      workspaceId: harness.deps.workspace.id,
      chatId: opts.chatId ?? null,
      batchId: null,
      kind: 'create',
      category: 'assignment',
      payload: defaultPayload(opts.payload),
      targetTaskId: null,
      confidence: 0.87,
      policyDecision: 'shown',
      policyReason: 'ok',
      sourceMessageIds: opts.sourceMessageIds ?? [],
      createdAt: harness.clock.now(),
    }),
  );
}

async function insertTargetProposal(
  harness: BotHarness,
  kind: 'update' | 'complete' | 'cancel',
  targetTaskId: number,
  payload: Partial<ProposalPayload> = {},
): Promise<ProposalRow> {
  return harness.db.transaction((tx) =>
    insertProposal(tx, {
      workspaceId: harness.deps.workspace.id,
      chatId: null,
      batchId: null,
      kind,
      category: null,
      payload: defaultPayload({ title: undefined, ...payload }),
      targetTaskId,
      confidence: 0.8,
      policyDecision: 'shown',
      policyReason: 'ok',
      sourceMessageIds: [],
      createdAt: harness.clock.now(),
    }),
  );
}

async function insertOpenTask(harness: BotHarness, overrides: Partial<TaskRow> = {}): Promise<TaskRow> {
  const [row] = await harness.db
    .insert(tasks)
    .values({
      workspaceId: harness.deps.workspace.id,
      title: 'Подготовить расписание на октябрь',
      origin: 'manual_dm',
      status: 'open',
      createdAt: harness.clock.now(),
      updatedAt: harness.clock.now(),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('expected the task row to be inserted');
  return row;
}

async function getProposalRow(harness: BotHarness, id: number): Promise<ProposalRow | undefined> {
  const [row] = await harness.db.select().from(proposals).where(eq(proposals.id, id));
  return row;
}

describe('proposal decision callbacks (v1:p:*)', () => {
  it('owner accepting a create-kind proposal creates the task and edits the card', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const proposal = await insertCreateProposal(harness);
    const data = encodeCallback({ entity: 'p', action: 'acc', id: proposal.id });

    await harness.send(callback(OWNER, data, botKeyboardMessage(OWNER)));

    const [task] = await harness.db
      .select()
      .from(tasks)
      .where(eq(tasks.workspaceId, harness.deps.workspace.id));
    expect(task?.origin).toBe('ai');
    expect(task?.title).toBe('Подготовить расписание на октябрь');

    const decidedProposal = await getProposalRow(harness, proposal.id);
    expect(decidedProposal?.status).toBe('accepted');
    expect(decidedProposal?.decidedByUserId).not.toBeNull();
    expect(decidedProposal?.decidedAt).not.toBeNull();

    const edit = lastEditTo(harness, OWNER.id);
    expect(edit.text).toBe(`✅ Создано: T${String(task?.id)} «Подготовить расписание на октябрь»`);

    // A second press (e.g. a stale keyboard tapped twice) must not create a second task — the reply text
    // is the "already handled" toast, not a second card edit.
    await harness.send(callback(OWNER, data, botKeyboardMessage(OWNER)));
    expect(lastAnswerText(harness)).toBe(texts.proposalDecide.alreadyDecided);
    const tasksAfterSecondPress = await harness.db
      .select()
      .from(tasks)
      .where(eq(tasks.workspaceId, harness.deps.workspace.id));
    expect(tasksAfterSecondPress).toHaveLength(1);
  });

  it('two concurrent accepts on the same proposal create exactly one task; the loser gets already_decided', async () => {
    const harness = await createBotHarness();
    const owner = await makeOwner(harness, OWNER);
    const proposal = await insertCreateProposal(harness);
    const actor = { userId: owner.id, isSuperadmin: false, role: 'owner' as const, dmStarted: true };

    // A second, genuinely separate connection pool onto the same test database — `tests/helpers/db.ts`'s
    // shared handle is capped at `max: 1`, which would serialize both calls at the connection level and
    // never actually race them. This exercises `claimProposal`'s atomic `UPDATE ... WHERE status='pending'`
    // under real concurrent transactions instead.
    const alt = createDb(TEST_DATABASE_URL, { max: 2 });
    try {
      const deps = { ...harness.deps, db: alt.db };
      const [a, b] = await Promise.all([
        acceptProposal(deps, { proposalId: proposal.id, actor }),
        acceptProposal(deps, { proposalId: proposal.id, actor }),
      ]);

      const results = [a, b];
      const oks = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      expect(oks).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ ok: false, reason: 'already_decided' });

      const createdTasks = await harness.db
        .select()
        .from(tasks)
        .where(eq(tasks.workspaceId, harness.deps.workspace.id));
      expect(createdTasks).toHaveLength(1);
    } finally {
      await alt.close();
    }
  });

  it('a member pressing "Создать" on a forwarded card is forbidden and creates no task', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await makeMember(harness, MEMBER);
    const proposal = await insertCreateProposal(harness);
    const data = encodeCallback({ entity: 'p', action: 'acc', id: proposal.id });

    await harness.send(callback(MEMBER, data, botKeyboardMessage(MEMBER)));

    const createdTasks = await harness.db.select().from(tasks);
    expect(createdTasks).toHaveLength(0);
    expect(fake(harness).edits).toHaveLength(0);
    expect(lastAnswerText(harness)).toBe(texts.common.forbidden);
  });

  it('a former owner (now a member after ownership transfer) is forbidden', async () => {
    const harness = await createBotHarness();
    const formerOwner = await makeOwner(harness, OWNER);
    const proposal = await insertCreateProposal(harness);

    // Simulate `/transfer`'s effect directly (that flow itself is Task 1.x's own concern) — the former
    // owner keeps their membership row, just demoted to `member`.
    await harness.db
      .update(memberships)
      .set({ role: 'member' })
      .where(eq(memberships.userId, formerOwner.id));

    const data = encodeCallback({ entity: 'p', action: 'acc', id: proposal.id });
    await harness.send(callback(OWNER, data, botKeyboardMessage(OWNER)));

    const createdTasks = await harness.db.select().from(tasks);
    expect(createdTasks).toHaveLength(0);
    expect(lastAnswerText(harness)).toBe(texts.common.forbidden);
  });

  it('"Не задача" opens the reason menu; "Уже сделано" rejects with that reason and edits the card', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const proposal = await insertCreateProposal(harness);
    const rejData = encodeCallback({ entity: 'p', action: 'rej', id: proposal.id });

    await harness.send(callback(OWNER, rejData, botKeyboardMessage(OWNER)));
    expect(lastEditTo(harness, OWNER.id).text).toBe(texts.proposalDecide.reasonMenuTitle);

    const rjrData = encodeCallback({ entity: 'p', action: 'rjr', id: proposal.id, arg: 'done' });
    await harness.send(callback(OWNER, rjrData, botKeyboardMessage(OWNER)));

    const decided = await getProposalRow(harness, proposal.id);
    expect(decided?.status).toBe('rejected');
    expect(decided?.rejectReason).toBe('already_done');
    expect(lastEditTo(harness, OWNER.id).text).toContain('Уже сделано');
  });

  it('"Дубль T<id>" opens a mark-only/mark-and-append submenu instead of deciding directly', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const existingTask = await insertOpenTask(harness, { title: 'Существующая задача', description: null });
    const proposal = await insertCreateProposal(harness);
    const data = encodeCallback({
      entity: 'p',
      action: 'dup',
      id: proposal.id,
      arg: String(existingTask.id),
    });

    await harness.send(callback(OWNER, data, botKeyboardMessage(OWNER)));

    // Not decided yet — the initial button only opens the submenu.
    const stillPending = await getProposalRow(harness, proposal.id);
    expect(stillPending?.status).toBe('pending');
    expect(lastEditTo(harness, OWNER.id).text).toBe(texts.proposalDecide.duplicateMenuTitle(existingTask.id));
  });

  it('"Только пометить" (dpm) rejects as a duplicate without touching the existing task\'s description', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const existingTask = await insertOpenTask(harness, { title: 'Существующая задача', description: null });
    const proposal = await insertCreateProposal(harness);
    const data = encodeCallback({
      entity: 'p',
      action: 'dpm',
      id: proposal.id,
      arg: String(existingTask.id),
    });

    await harness.send(callback(OWNER, data, botKeyboardMessage(OWNER)));

    const decided = await getProposalRow(harness, proposal.id);
    expect(decided?.status).toBe('rejected');
    expect(decided?.rejectReason).toBe('duplicate');

    const [untouchedTask] = await harness.db.select().from(tasks).where(eq(tasks.id, existingTask.id));
    expect(untouchedTask?.description).toBeNull();
    expect(untouchedTask?.version).toBe(1);

    expect(lastEditTo(harness, OWNER.id).text).toBe(`🔗 Отмечено как дубль T${String(existingTask.id)}`);
  });

  it('"Пометить и дописать" (dpa) rejects as a duplicate and appends the quote to the existing task\'s description', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const existingTask = await insertOpenTask(harness, { title: 'Существующая задача', description: null });
    const proposal = await insertCreateProposal(harness);
    const data = encodeCallback({
      entity: 'p',
      action: 'dpa',
      id: proposal.id,
      arg: String(existingTask.id),
    });

    await harness.send(callback(OWNER, data, botKeyboardMessage(OWNER)));

    const decided = await getProposalRow(harness, proposal.id);
    expect(decided?.status).toBe('rejected');
    expect(decided?.rejectReason).toBe('duplicate');

    const [updatedTask] = await harness.db.select().from(tasks).where(eq(tasks.id, existingTask.id));
    expect(updatedTask?.description).toBe('Маша, подготовь расписание к пятнице');
    expect(updatedTask?.version).toBe(2);

    expect(lastEditTo(harness, OWNER.id).text).toBe(
      `🔗 Отмечено как дубль T${String(existingTask.id)}, описание дополнено`,
    );
  });

  it('"Пометить и дописать" (dpa) is rejected (target_gone) when taskId belongs to a different workspace', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const [otherWorkspace] = await harness.db
      .insert(workspaces)
      .values({ name: 'Другая школа', timezone: 'Europe/Moscow' })
      .returning();
    if (!otherWorkspace) throw new Error('expected the second workspace row to be inserted');
    const foreignTask = await insertOpenTask(harness, {
      workspaceId: otherWorkspace.id,
      title: 'Чужая задача',
    });
    const proposal = await insertCreateProposal(harness);
    const data = encodeCallback({ entity: 'p', action: 'dpa', id: proposal.id, arg: String(foreignTask.id) });

    await harness.send(callback(OWNER, data, botKeyboardMessage(OWNER)));

    const stillPending = await getProposalRow(harness, proposal.id);
    expect(stillPending?.status).toBe('pending');
    expect(lastAnswerText(harness)).toBe(texts.proposalDecide.targetGone);

    const [untouchedForeignTask] = await harness.db.select().from(tasks).where(eq(tasks.id, foreignTask.id));
    expect(untouchedForeignTask?.description).toBeNull();
  });

  it('applyModification: "Применить" updates the task, "Закрыть задачу" completes it, "Отменить задачу" cancels it', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    const taskToUpdate = await insertOpenTask(harness, { title: 'Задача со сроком' });
    const updateProposal = await insertTargetProposal(harness, 'update', taskToUpdate.id, {
      changes: { title: 'Новое название задачи' },
    });
    await harness.send(
      callback(
        OWNER,
        encodeCallback({ entity: 'p', action: 'apl', id: updateProposal.id }),
        botKeyboardMessage(OWNER),
      ),
    );
    const [afterUpdate] = await harness.db.select().from(tasks).where(eq(tasks.id, taskToUpdate.id));
    expect(afterUpdate?.title).toBe('Новое название задачи');
    expect(afterUpdate?.version).toBe(2);
    const events = await harness.db.select().from(taskEvents).where(eq(taskEvents.taskId, taskToUpdate.id));
    expect(events.some((e) => e.type === 'updated')).toBe(true);
    expect(lastEditTo(harness, OWNER.id).text).toContain('Применено');

    const taskToComplete = await insertOpenTask(harness, { title: 'Задача на закрытие' });
    const completeProposal = await insertTargetProposal(harness, 'complete', taskToComplete.id);
    await harness.send(
      callback(
        OWNER,
        encodeCallback({ entity: 'p', action: 'apl', id: completeProposal.id }),
        botKeyboardMessage(OWNER),
      ),
    );
    const [afterComplete] = await harness.db.select().from(tasks).where(eq(tasks.id, taskToComplete.id));
    expect(afterComplete?.status).toBe('done');
    expect(lastEditTo(harness, OWNER.id).text).toContain('Закрыто');

    const taskToCancel = await insertOpenTask(harness, { title: 'Задача на отмену' });
    const cancelProposal = await insertTargetProposal(harness, 'cancel', taskToCancel.id);
    await harness.send(
      callback(
        OWNER,
        encodeCallback({ entity: 'p', action: 'apl', id: cancelProposal.id }),
        botKeyboardMessage(OWNER),
      ),
    );
    const [afterCancel] = await harness.db.select().from(tasks).where(eq(tasks.id, taskToCancel.id));
    expect(afterCancel?.status).toBe('cancelled');
    expect(lastEditTo(harness, OWNER.id).text).toContain('Отменено');
  });

  it('applyModification on a deleted target task returns target_gone and leaves the proposal pending', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const task = await insertOpenTask(harness);
    const proposal = await insertTargetProposal(harness, 'complete', task.id);
    await harness.db.delete(tasks).where(eq(tasks.id, task.id));

    await harness.send(
      callback(
        OWNER,
        encodeCallback({ entity: 'p', action: 'apl', id: proposal.id }),
        botKeyboardMessage(OWNER),
      ),
    );

    const row = await getProposalRow(harness, proposal.id);
    expect(row?.status).toBe('pending');
    expect(lastAnswerText(harness)).toBe(texts.proposalDecide.targetGone);
  });

  it('reacts with reactions.onAccept on the source message once the proposal is accepted', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await updateSettings(harness.db, harness.deps.workspace.id, { reactions: { onAccept: '✍' } });

    const chat = await makeSupergroupChat(harness, -5001, 'Учителя');
    const message = await makeSourceMessage(harness, chat.id, 42, 'Маша, подготовь расписание к пятнице');
    const proposal = await insertCreateProposal(harness, { chatId: chat.id, sourceMessageIds: [message.id] });

    await harness.send(
      callback(
        OWNER,
        encodeCallback({ entity: 'p', action: 'acc', id: proposal.id }),
        botKeyboardMessage(OWNER),
      ),
    );

    expect(fake(harness).reactions).toContainEqual({ chatId: chat.tgChatId, messageId: 42, emoji: '✍' });
  });

  it('does not react when the chat has reactions disabled, even with reactions.onAccept set', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await updateSettings(harness.db, harness.deps.workspace.id, { reactions: { onAccept: '✍' } });

    const chat = await makeSupergroupChat(harness, -5002, 'Учителя', { reactionsEnabled: false });
    const message = await makeSourceMessage(harness, chat.id, 43, 'Маша, подготовь расписание к пятнице');
    const proposal = await insertCreateProposal(harness, { chatId: chat.id, sourceMessageIds: [message.id] });

    await harness.send(
      callback(
        OWNER,
        encodeCallback({ entity: 'p', action: 'acc', id: proposal.id }),
        botKeyboardMessage(OWNER),
      ),
    );

    expect(fake(harness).reactions).toHaveLength(0);
  });
});
