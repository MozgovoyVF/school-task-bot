import { describe, it, expect } from 'vitest';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, callback, botKeyboardMessage } from '../../helpers/updates.js';
import { encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { insertProposal, type ProposalPayload } from '../../../src/domain/proposals/repo.js';
import { memberships, chats } from '../../../src/db/schema/index.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };

function fake(harness: BotHarness): FakeMessenger {
  return harness.deps.messenger as FakeMessenger;
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

function basePayload(overrides: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    title: 'Подготовить расписание',
    description: null,
    category: 'assignment',
    assignee: { type: 'none' },
    due: null,
    dueText: null,
    priority: 'normal',
    reasoning: 'test',
    origin: 'ai',
    quote: 'цитата',
    quoteAuthorName: 'Анна',
    ...overrides,
  };
}

async function insertPending(harness: BotHarness, chatId: number | null, title: string) {
  return harness.db.transaction((tx) =>
    insertProposal(tx, {
      workspaceId: harness.deps.workspace.id,
      chatId,
      batchId: null,
      kind: 'create',
      category: 'assignment',
      payload: basePayload({ title }),
      targetTaskId: null,
      confidence: 0.87,
      policyDecision: 'shown',
      policyReason: 'above_low',
      sourceMessageIds: [],
      createdAt: harness.clock.now(),
    }),
  );
}

describe('/inbox', () => {
  it('is forbidden for a Member', async () => {
    const harness = await createBotHarness();
    await makeMember(harness, MEMBER);
    await harness.send(dmText(MEMBER, '/inbox'));
    expect(harness.replies(MEMBER.id)).toContain(texts.common.forbidden);
  });

  it('lists pending proposals and resends the tapped one as a fresh card', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const proposal = await insertPending(harness, null, 'Подготовить расписание на октябрь');

    await harness.send(dmText(OWNER, '/inbox'));
    const listText = harness.replies(OWNER.id).at(-1);
    expect(listText).toContain(texts.inbox.header);

    const data = encodeCallback({ entity: 'p', action: 'snd', id: proposal.id });
    await harness.send(callback(OWNER, data, botKeyboardMessage(OWNER)));

    expect(fake(harness).sent).toHaveLength(1);
    expect(fake(harness).sent[0]?.chatId).toBe(OWNER.id);
    expect(fake(harness).sent[0]?.text).toContain('Подготовить расписание на октябрь');
  });

  it('shows the empty state when there is nothing pending', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await harness.send(dmText(OWNER, '/inbox'));
    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.inbox.empty);
  });

  it('paginates at PAGE_SIZE (5) and the "next" button moves to page 2', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    for (let i = 0; i < 6; i++) await insertPending(harness, null, `Задача ${String(i)}`);

    await harness.send(dmText(OWNER, '/inbox'));
    expect(harness.replies(OWNER.id).at(-1)).toContain(texts.inbox.pageFooter(1, 2));

    const nextData = encodeCallback({ entity: 'p', action: 'nbx', id: 1 });
    await harness.send(callback(OWNER, nextData, botKeyboardMessage(OWNER)));
    const lastEdit = fake(harness).edits.at(-1);
    expect(lastEdit?.text).toContain(texts.inbox.pageFooter(2, 2));
  });

  it("surfaces a suppressed proposal too — /inbox is the one place it's visible", async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const chat = await harness.db
      .insert(chats)
      .values({
        tgChatId: -1,
        workspaceId: harness.deps.workspace.id,
        title: 'Group',
        type: 'supergroup',
        status: 'active',
      })
      .returning();
    const chatRow = chat[0];
    if (!chatRow) throw new Error('expected chat to be inserted');
    await harness.db.transaction((tx) =>
      insertProposal(tx, {
        workspaceId: harness.deps.workspace.id,
        chatId: chatRow.id,
        batchId: null,
        kind: 'create',
        category: 'assignment',
        payload: basePayload({ title: 'Скрытое предложение' }),
        targetTaskId: null,
        confidence: 0.2,
        policyDecision: 'suppressed',
        policyReason: 'below_low',
        sourceMessageIds: [],
        createdAt: harness.clock.now(),
      }),
    );

    await harness.send(dmText(OWNER, '/inbox'));
    expect(harness.replies(OWNER.id).at(-1)).toContain(texts.inbox.header);
  });
});
