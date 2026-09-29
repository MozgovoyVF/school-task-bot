import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, callback, botKeyboardMessage } from '../../helpers/updates.js';
import { encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { formatDue } from '../../../src/time/format.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import {
  insertProposal,
  type ProposalPayload,
  type ProposalRow,
} from '../../../src/domain/proposals/repo.js';
import { memberships, proposals, tasks } from '../../../src/db/schema/index.js';
import { FixtureClient } from '../../../src/ai/providers/fixture.js';
import type { AiProviders, CompletionResponse } from '../../../src/ai/providers/types.js';

// plan.md Task 2.14: the "✏️ Изменить" edit dialog (`src/bot/conversations/editProposal.ts`) end to end —
// menu navigation, the free-text date step against `FixtureClient` (never a real LLM call, CLAUDE.md), and
// `acceptProposal`'s edited fields landing on the created task plus `payload.ownerEdits` (SPEC §20.4).

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };

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

function defaultPayload(overrides: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    title: 'Старое название',
    description: null,
    category: 'assignment',
    assignee: { type: 'none' },
    due: null,
    dueText: null,
    priority: 'normal',
    reasoning: 'test fixture',
    origin: 'ai',
    quote: null,
    quoteAuthorName: null,
    ...overrides,
  };
}

async function insertCreateProposal(
  harness: BotHarness,
  payload: Partial<ProposalPayload> = {},
): Promise<ProposalRow> {
  return harness.db.transaction((tx) =>
    insertProposal(tx, {
      workspaceId: harness.deps.workspace.id,
      chatId: null,
      batchId: null,
      kind: 'create',
      category: 'assignment',
      payload: defaultPayload(payload),
      targetTaskId: null,
      confidence: 0.8,
      policyDecision: 'shown',
      policyReason: 'ok',
      sourceMessageIds: [],
      createdAt: harness.clock.now(),
    }),
  );
}

function edtData(proposalId: number): string {
  return encodeCallback({ entity: 'p', action: 'edt', id: proposalId });
}

function p(action: string, id: number, arg?: string): string {
  return encodeCallback(arg === undefined ? { entity: 'p', action, id } : { entity: 'p', action, id, arg });
}

function response(content: string): CompletionResponse {
  return {
    content,
    usage: { inputTokens: 8, outputTokens: 4, costUsd: 0.0001 },
    model: 'fixture/primary',
    raw: {},
  };
}

function fixtureAi(script: ReadonlyArray<CompletionResponse | Error>): AiProviders {
  return {
    extraction: {
      extract() {
        throw new Error('extraction should not be used by the editProposal dialog');
      },
    },
    decision: null,
    client: new FixtureClient(script),
    models: { primary: 'fixture/primary', fallback: null },
  };
}

async function lastTaskFor(harness: BotHarness): Promise<typeof tasks.$inferSelect | undefined> {
  const [row] = await harness.db.select().from(tasks).where(eq(tasks.workspaceId, harness.deps.workspace.id));
  return row;
}

describe('editProposal dialog (v1:p:edt:*, plan.md Task 2.14)', () => {
  it('a member pressing "✏️ Изменить" is rejected and never enters the dialog', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await makeMember(harness, MEMBER);
    const proposal = await insertCreateProposal(harness);

    await harness.send(callback(MEMBER, edtData(proposal.id), botKeyboardMessage(MEMBER)));

    expect(harness.replies(MEMBER.id)).toEqual([]);
    const answers = harness.calls.filter((c) => c.method === 'answerCallbackQuery');
    expect(answers[answers.length - 1]?.payload.text).toBe(texts.common.forbidden);
  });

  it('the owner edits title/assignee/due/priority/description and saves — the task gets every edit, and payload.ownerEdits records before/after', async () => {
    const dueLocal = '2030-10-15T14:00';
    const ai = fixtureAi([
      response(JSON.stringify({ due_local: dueLocal, time_hint: 'none', due_text: '15.10 14:00' })),
    ]);
    const harness = await createBotHarness({ ai });
    await makeOwner(harness, OWNER);
    const proposal = await insertCreateProposal(harness);

    // Enter the dialog.
    await harness.send(callback(OWNER, edtData(proposal.id), botKeyboardMessage(OWNER)));
    expect(harness.replies(OWNER.id).at(-1)).toContain(texts.editProposal.menuHeader);

    // "Название" → new title.
    await harness.send(callback(OWNER, p('etl', proposal.id), botKeyboardMessage(OWNER)));
    await harness.send(dmText(OWNER, 'Новое название'));

    // "Исполнитель" → "Всем".
    await harness.send(callback(OWNER, p('eas', proposal.id), botKeyboardMessage(OWNER)));
    await harness.send(callback(OWNER, p('aal', proposal.id), botKeyboardMessage(OWNER)));

    // "Срок" → "Ввести…" → free text → preview → "Да".
    await harness.send(callback(OWNER, p('edu', proposal.id), botKeyboardMessage(OWNER)));
    await harness.send(callback(OWNER, p('den', proposal.id), botKeyboardMessage(OWNER)));
    await harness.send(dmText(OWNER, '15.10 14:00'));
    const expectedDueAt = new Date('2030-10-15T14:00:00+03:00');
    const expectedLabel = texts.formatDue(
      formatDue({ at: expectedDueAt, allDay: false, tz: 'Europe/Moscow' }, 'Europe/Moscow'),
    );
    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.editProposal.duePreview(expectedLabel));
    await harness.send(callback(OWNER, p('dok', proposal.id), botKeyboardMessage(OWNER)));

    // "Приоритет" → "высокий".
    await harness.send(callback(OWNER, p('epr', proposal.id), botKeyboardMessage(OWNER)));
    await harness.send(callback(OWNER, p('phi', proposal.id), botKeyboardMessage(OWNER)));

    // "Описание" → new description.
    await harness.send(callback(OWNER, p('edc', proposal.id), botKeyboardMessage(OWNER)));
    await harness.send(dmText(OWNER, 'Новое описание'));

    // "Сохранить и создать".
    await harness.send(callback(OWNER, p('esv', proposal.id), botKeyboardMessage(OWNER)));

    const task = await lastTaskFor(harness);
    expect(task?.title).toBe('Новое название');
    expect(task?.assigneeAll).toBe(true);
    expect(task?.priority).toBe('high');
    expect(task?.description).toBe('Новое описание');
    expect(task?.dueAt?.toISOString()).toBe(expectedDueAt.toISOString());
    expect(task?.dueAllDay).toBe(false);
    expect(task?.dueTz).toBe('Europe/Moscow');
    expect(task?.origin).toBe('ai');

    const [decided] = await harness.db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(decided?.status).toBe('accepted');
    const payload = decided?.payload as ProposalPayload | undefined;
    expect(payload?.ownerEdits).toMatchObject({
      title: { before: 'Старое название', after: 'Новое название' },
      assignee: { before: texts.proposalCard.assigneeNone, after: texts.proposalCard.assigneeAll },
      due: { before: 'без срока', after: expectedLabel },
      priority: { before: texts.proposalCard.priorityNormal, after: texts.proposalCard.priorityHigh },
      description: { before: null, after: 'Новое описание' },
    });

    expect(harness.replies(OWNER.id).at(-1)).toBe(
      texts.proposalDecide.createdCard(task!.id, 'Новое название'),
    );
  });

  it('"↩️ Назад" leaves without saving anything', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const proposal = await insertCreateProposal(harness);

    await harness.send(callback(OWNER, edtData(proposal.id), botKeyboardMessage(OWNER)));
    await harness.send(callback(OWNER, p('ebk', proposal.id), botKeyboardMessage(OWNER)));

    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.editProposal.cancelled);
    const [row] = await harness.db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(row?.status).toBe('pending');
    expect(await lastTaskFor(harness)).toBeUndefined();
  });
});
