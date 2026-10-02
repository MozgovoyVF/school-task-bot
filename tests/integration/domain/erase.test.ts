import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { createLogger } from '../../../src/ops/logger.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser, getUserByTgId } from '../../../src/domain/people/repo.js';
import { upsertChatOnAdd, pauseChatRow, markChatLeft } from '../../../src/domain/chats/repo.js';
import type { Actor } from '../../../src/domain/people/permissions.js';
import { eraseMember, EraseMemberError } from '../../../src/domain/people/erase.js';
import { eraseWorkspace, EraseWorkspaceError } from '../../../src/domain/workspaces/erase.js';
import { createClaimCode, redeemClaimCode } from '../../../src/domain/people/claim.js';
import { acceptProposal, applyModification } from '../../../src/domain/proposals/decide.js';
import { fixedClock } from '../../helpers/clock.js';
import type { Env } from '../../../src/config/env.js';
import {
  analysisBatches,
  chats,
  claimCodes,
  memberships,
  messages,
  notifications,
  proposals,
  taskEvents,
  tasks,
  workspaces,
} from '../../../src/db/schema/index.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { MessengerError } from '../../../src/domain/messenger.js';

const db = getTestDb();
const logger = createLogger({ level: 'silent' });
beforeEach(() => truncateAll(db));

function actorOf(userId: number, role: 'owner' | 'member' | null, isSuperadmin = false): Actor {
  return { userId, isSuperadmin, role, dmStarted: true };
}

async function setupSchool() {
  const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
  const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
  await db
    .insert(memberships)
    .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });
  const maria = await upsertTelegramUser(db, { id: 2, first_name: 'Maria' });
  await db
    .insert(memberships)
    .values({ workspaceId: ws.id, userId: maria.id, role: 'member', displayName: 'Maria' });
  const chat = await upsertChatOnAdd(db, {
    tgChatId: -100,
    title: 'Group',
    type: 'supergroup',
    workspaceId: ws.id,
    addedByUserId: owner.id,
    status: 'active',
    pendingSince: null,
    now: new Date('2026-09-23T12:00:00Z'),
  });
  return { ws, owner, maria, chat };
}

describe('eraseMember', () => {
  it("erases Maria's data: her messages, task anonymization, source_quote, audit actor fields, source_message_ids, membership and the user row", async () => {
    const { ws, owner, maria, chat } = await setupSchool();

    // Maria's own message, quoted by a task sourced from it.
    const [mariaMessage] = await db
      .insert(messages)
      .values({
        chatId: chat.id,
        tgMessageId: 10,
        authorUserId: maria.id,
        sentAt: new Date('2026-09-23T12:01:00Z'),
        text: 'Сделаю расписание к пятнице',
      })
      .returning();
    if (!mariaMessage) throw new Error('setup: failed to insert mariaMessage');

    // Another member's message, untouched.
    const [otherMessage] = await db
      .insert(messages)
      .values({
        chatId: chat.id,
        tgMessageId: 11,
        authorUserId: owner.id,
        sentAt: new Date('2026-09-23T12:02:00Z'),
        text: 'Спасибо',
      })
      .returning();
    if (!otherMessage) throw new Error('setup: failed to insert otherMessage');

    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId: ws.id,
        title: 'Подготовить расписание',
        assigneeUserId: maria.id,
        origin: 'ai',
        sourceChatId: chat.id,
        sourceTgMessageId: mariaMessage.tgMessageId,
        sourceQuote: 'Сделаю расписание к пятнице',
        quoteAuthorUserId: maria.id,
        createdByUserId: owner.id,
      })
      .returning();
    if (!task) throw new Error('setup: failed to insert task');

    const [untouchedTask] = await db
      .insert(tasks)
      .values({
        workspaceId: ws.id,
        title: 'Другая задача',
        origin: 'manual_group',
        createdByUserId: owner.id,
      })
      .returning();
    if (!untouchedTask) throw new Error('setup: failed to insert untouchedTask');

    const [event] = await db
      .insert(taskEvents)
      .values({ taskId: task.id, actorType: 'user', actorUserId: maria.id, type: 'status_changed' })
      .returning();
    if (!event) throw new Error('setup: failed to insert task event');

    const [proposal] = await db
      .insert(proposals)
      .values({
        workspaceId: ws.id,
        chatId: chat.id,
        kind: 'create',
        payload: { title: 'Подготовить расписание' },
        confidence: 0.9,
        policyDecision: 'shown',
        status: 'accepted',
        sourceMessageIds: [mariaMessage.id, otherMessage.id],
        decidedByUserId: maria.id,
      })
      .returning();
    if (!proposal) throw new Error('setup: failed to insert proposal');

    const result = await eraseMember(
      { db, logger, superadminIds: [] },
      { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
    );

    expect(result).toEqual({ messages: 1, tasksAnonymized: 1, userDeleted: true });

    // Her message is gone; the other member's message is untouched.
    const remainingMessages = await db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(remainingMessages.map((m) => m.id)).toEqual([otherMessage.id]);

    // The task she was assigned to is anonymized.
    const [taskAfter] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskAfter?.assigneeUserId).toBeNull();
    expect(taskAfter?.assigneeNameText).toBe(texts.erase.anonymous);
    expect(taskAfter?.sourceQuote).toBe(texts.erase.redactedQuote);

    // A task she was never involved with is untouched.
    const [untouchedAfter] = await db.select().from(tasks).where(eq(tasks.id, untouchedTask.id));
    expect(untouchedAfter?.title).toBe('Другая задача');

    // task_events.actor_user_id cleared, the event row itself stays (audit trail).
    const [eventAfter] = await db.select().from(taskEvents).where(eq(taskEvents.id, event.id));
    expect(eventAfter).toBeDefined();
    expect(eventAfter?.actorUserId).toBeNull();

    // proposals.decided_by_user_id cleared, her message id removed from source_message_ids, the
    // proposal row itself stays (audit trail / feedback-report input).
    const [proposalAfter] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(proposalAfter).toBeDefined();
    expect(proposalAfter?.decidedByUserId).toBeNull();
    expect(proposalAfter?.sourceMessageIds).toEqual([otherMessage.id]);

    // Membership and the user row itself are both gone — no other workspace, not a superadmin.
    const [membershipAfter] = await db.select().from(memberships).where(eq(memberships.userId, maria.id));
    expect(membershipAfter).toBeUndefined();
    expect(await getUserByTgId(db, 2)).toBeNull();
  });

  it('keeps the users row when the member still belongs to another workspace', async () => {
    const { ws, owner, maria } = await setupSchool();
    const otherWs = await db
      .insert(workspaces)
      .values({ name: 'Other School', timezone: 'Europe/Moscow' })
      .returning();
    const other = otherWs[0];
    if (!other) throw new Error('setup: failed to insert other workspace');
    await db.insert(memberships).values({
      workspaceId: other.id,
      userId: maria.id,
      role: 'member',
      displayName: 'Maria',
    });

    const result = await eraseMember(
      { db, logger, superadminIds: [] },
      { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
    );

    expect(result.userDeleted).toBe(false);
    expect(await getUserByTgId(db, 2)).not.toBeNull();
    // The membership in the *other* workspace is untouched.
    const [otherMembership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.workspaceId, other.id));
    expect(otherMembership?.userId).toBe(maria.id);
  });

  it('keeps the users row when the member is a configured superadmin, even with no remaining membership', async () => {
    const { ws, owner, maria } = await setupSchool();

    const result = await eraseMember(
      { db, logger, superadminIds: [2] },
      { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
    );

    expect(result.userDeleted).toBe(false);
    expect(await getUserByTgId(db, 2)).not.toBeNull();
  });

  it('refuses when the owner tries to erase themselves — they must /transfer ownership first', async () => {
    const { ws, owner } = await setupSchool();

    await expect(
      eraseMember(
        { db, logger, superadminIds: [] },
        { workspaceId: ws.id, userId: owner.id, actor: actorOf(owner.id, 'owner') },
      ),
    ).rejects.toMatchObject({ reason: 'owner_must_transfer' });

    // Nothing was touched — the owner's own membership is still there.
    const [membershipAfter] = await db.select().from(memberships).where(eq(memberships.userId, owner.id));
    expect(membershipAfter?.role).toBe('owner');
  });

  it('refuses a non-owner actor (forbidden) without touching anything', async () => {
    const { ws, maria } = await setupSchool();
    const member2 = await upsertTelegramUser(db, { id: 3, first_name: 'Nina' });
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: member2.id, role: 'member', displayName: 'Nina' });

    await expect(
      eraseMember(
        { db, logger, superadminIds: [] },
        { workspaceId: ws.id, userId: maria.id, actor: actorOf(member2.id, 'member') },
      ),
    ).rejects.toMatchObject({ reason: 'forbidden' });

    expect(await getUserByTgId(db, 2)).not.toBeNull();
  });

  it('refuses an unknown target membership (not_found)', async () => {
    const { ws, owner } = await setupSchool();
    const stranger = await upsertTelegramUser(db, { id: 999, first_name: 'Ghost' });

    await expect(
      eraseMember(
        { db, logger, superadminIds: [] },
        { workspaceId: ws.id, userId: stranger.id, actor: actorOf(owner.id, 'owner') },
      ),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('is an instance of EraseMemberError with a readonly reason', async () => {
    const { ws, owner } = await setupSchool();
    try {
      await eraseMember(
        { db, logger, superadminIds: [] },
        { workspaceId: ws.id, userId: owner.id, actor: actorOf(owner.id, 'owner') },
      );
      expect.unreachable('expected eraseMember to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EraseMemberError);
      expect((err as EraseMemberError).reason).toBe('owner_must_transfer');
    }
  });

  it(
    'erases a former owner who issued a /transfer claim code before being demoted, without hitting the ' +
      "claim_codes FK (D43 review C1: claim_codes.created_by_user_id is 'on delete no action', unlike " +
      'every other FK to users)',
    async () => {
      const { ws, owner, maria } = await setupSchool();

      // Mirrors /transfer -> demote -> the successor runs /claim: owner issues the code, Maria redeems
      // it and becomes the new owner, owner is demoted to a plain member.
      const { code } = await createClaimCode(db, {
        workspaceId: ws.id,
        createdByUserId: owner.id,
        previousOwnerAction: 'demote',
        now: new Date('2026-09-23T12:00:00Z'),
      });
      const redeemed = await redeemClaimCode(db, {
        code,
        userId: maria.id,
        now: new Date('2026-09-23T12:01:00Z'),
      });
      expect(redeemed.ok).toBe(true);

      // The claim code the ex-owner created is still there, pointing at their user row.
      const codesBefore = await db.select().from(claimCodes).where(eq(claimCodes.createdByUserId, owner.id));
      expect(codesBefore).toHaveLength(1);

      // Erasing the now-plain-member ex-owner used to roll back the whole transaction with a raw FK
      // violation on claim_codes.created_by_user_id — this must now succeed and actually delete them.
      const result = await eraseMember(
        { db, logger, superadminIds: [] },
        { workspaceId: ws.id, userId: owner.id, actor: actorOf(maria.id, 'owner') },
      );

      expect(result.userDeleted).toBe(true);
      expect(await getUserByTgId(db, 1)).toBeNull();
      const codesAfter = await db.select().from(claimCodes).where(eq(claimCodes.createdByUserId, owner.id));
      expect(codesAfter).toHaveLength(0);
    },
  );

  it("does not touch a second workspace's data when erasing a member in the first", async () => {
    const { ws, owner, maria, chat } = await setupSchool();

    const [otherWs] = await db
      .insert(workspaces)
      .values({ name: 'Other School', timezone: 'Europe/Moscow' })
      .returning();
    if (!otherWs) throw new Error('setup: failed to insert other workspace');
    const ownerB = await upsertTelegramUser(db, { id: 50, first_name: 'Petr' });
    await db
      .insert(memberships)
      .values({ workspaceId: otherWs.id, userId: ownerB.id, role: 'owner', displayName: 'Petr' });
    const chatB = await upsertChatOnAdd(db, {
      tgChatId: -200,
      title: 'Other group',
      type: 'supergroup',
      workspaceId: otherWs.id,
      addedByUserId: ownerB.id,
      status: 'active',
      pendingSince: null,
      now: new Date('2026-09-23T12:00:00Z'),
    });
    const [msgB] = await db
      .insert(messages)
      .values({
        chatId: chatB.id,
        tgMessageId: 1,
        authorUserId: ownerB.id,
        sentAt: new Date('2026-09-23T12:01:00Z'),
        text: 'B message',
      })
      .returning();
    if (!msgB) throw new Error('setup: failed to insert msgB');
    const [taskB] = await db
      .insert(tasks)
      .values({ workspaceId: otherWs.id, title: 'B task', origin: 'manual_group', assigneeUserId: ownerB.id })
      .returning();
    if (!taskB) throw new Error('setup: failed to insert taskB');

    await eraseMember(
      { db, logger, superadminIds: [] },
      { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
    );

    // Workspace A's own chat is untouched by its own member's erasure.
    const [chatAfter] = await db.select().from(chats).where(eq(chats.id, chat.id));
    expect(chatAfter).toBeDefined();

    // Workspace B's message and task are completely untouched.
    const [msgBAfter] = await db.select().from(messages).where(eq(messages.id, msgB.id));
    expect(msgBAfter).toBeDefined();
    const [taskBAfter] = await db.select().from(tasks).where(eq(tasks.id, taskB.id));
    expect(taskBAfter?.assigneeUserId).toBe(ownerB.id);
    expect(await getUserByTgId(db, 50)).not.toBeNull();
  });

  // D46: regression coverage for D43 review round 2's parked Important I1 — the old `source_quote`
  // redaction joined through `messages` on `(chat_id, tg_message_id, author_user_id)`, which silently
  // stopped matching once the `messages` row was gone (30-day retention). `quote_author_user_id` fixes
  // this by not depending on `messages` at all.
  it("redacts a task's source_quote by quote_author_user_id even after its source messages row has already been deleted (post-retention)", async () => {
    const { ws, owner, maria, chat } = await setupSchool();

    const [mariaMessage] = await db
      .insert(messages)
      .values({
        chatId: chat.id,
        tgMessageId: 20,
        authorUserId: maria.id,
        sentAt: new Date('2026-09-23T12:01:00Z'),
        text: 'Куплю материалы на той неделе',
      })
      .returning();
    if (!mariaMessage) throw new Error('setup: failed to insert mariaMessage');

    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId: ws.id,
        title: 'Купить материалы',
        description: 'Описание задачи — не трогать',
        origin: 'ai',
        sourceChatId: chat.id,
        sourceTgMessageId: mariaMessage.tgMessageId,
        sourceQuote: 'Куплю материалы на той неделе',
        quoteAuthorUserId: maria.id,
        createdByUserId: owner.id,
      })
      .returning();
    if (!task) throw new Error('setup: failed to insert task');

    // Simulate the 30-day retention sweep (`chats/retention.ts`): the source message is gone before
    // `eraseMember` ever runs, so the old join-based redaction would no longer find anything to clear.
    await db.delete(messages).where(eq(messages.id, mariaMessage.id));

    await eraseMember(
      { db, logger, superadminIds: [] },
      { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
    );

    const [taskAfter] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskAfter?.sourceQuote).toBe(texts.erase.redactedQuote);
    // `description` is a different field entirely (D46: not touched by this redaction).
    expect(taskAfter?.description).toBe('Описание задачи — не трогать');
  });

  it("redacts proposals.payload.quote by payload.quoteAuthorUserId regardless of the proposal's status", async () => {
    const { ws, owner, maria, chat } = await setupSchool();

    const [pendingProposal] = await db
      .insert(proposals)
      .values({
        workspaceId: ws.id,
        chatId: chat.id,
        kind: 'create',
        payload: {
          title: 'Подготовить зал',
          reasoning: 'placeholder',
          origin: 'ai',
          quote: 'Подготовлю зал к утру',
          quoteAuthorName: 'Maria',
          quoteAuthorUserId: maria.id,
        },
        confidence: 0.9,
        policyDecision: 'shown',
        status: 'pending',
      })
      .returning();
    if (!pendingProposal) throw new Error('setup: failed to insert pendingProposal');

    const [acceptedProposal] = await db
      .insert(proposals)
      .values({
        workspaceId: ws.id,
        chatId: chat.id,
        kind: 'create',
        payload: {
          title: 'Купить призы',
          reasoning: 'placeholder',
          origin: 'ai',
          quote: 'Куплю призы к концерту',
          quoteAuthorName: 'Maria',
          quoteAuthorUserId: maria.id,
        },
        confidence: 0.9,
        policyDecision: 'shown',
        status: 'accepted',
        decidedByUserId: owner.id,
      })
      .returning();
    if (!acceptedProposal) throw new Error('setup: failed to insert acceptedProposal');

    await eraseMember(
      { db, logger, superadminIds: [] },
      { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
    );

    const [pendingAfter] = await db.select().from(proposals).where(eq(proposals.id, pendingProposal.id));
    const pendingPayload = pendingAfter?.payload as Record<string, unknown>;
    expect(pendingPayload.quote).toBe(texts.erase.redactedQuote);
    // D46 extension (2026-10-02): the quote author's display name is redacted too, not just the quote.
    expect(pendingPayload.quoteAuthorName).toBe(texts.erase.redactedQuoteAuthor);

    const [acceptedAfter] = await db.select().from(proposals).where(eq(proposals.id, acceptedProposal.id));
    const acceptedPayload = acceptedAfter?.payload as Record<string, unknown>;
    expect(acceptedPayload.quote).toBe(texts.erase.redactedQuote);
    expect(acceptedPayload.quoteAuthorName).toBe(texts.erase.redactedQuoteAuthor);
  });

  it(
    'also nulls out payload.quoteAuthorUserId when redacting a quote (D46 fix round 1) so accepting the ' +
      "proposal afterward doesn't try to insert a now-deleted user id into tasks.quote_author_user_id",
    async () => {
      const { ws, owner, maria, chat } = await setupSchool();

      const [pendingProposal] = await db
        .insert(proposals)
        .values({
          workspaceId: ws.id,
          chatId: chat.id,
          kind: 'create',
          payload: {
            title: 'Подготовить зал',
            reasoning: 'placeholder',
            origin: 'ai',
            quote: 'Подготовлю зал к утру',
            quoteAuthorName: 'Maria',
            quoteAuthorUserId: maria.id,
          },
          confidence: 0.9,
          policyDecision: 'shown',
          status: 'pending',
        })
        .returning();
      if (!pendingProposal) throw new Error('setup: failed to insert pendingProposal');

      // Maria has no other membership, so erasing her also deletes her `users` row
      // (`deleteUserIfOrphaned`) — the FK that `acceptProposal` would otherwise violate below.
      await eraseMember(
        { db, logger, superadminIds: [] },
        { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
      );
      expect(await getUserByTgId(db, 2)).toBeNull();

      const [pendingAfter] = await db.select().from(proposals).where(eq(proposals.id, pendingProposal.id));
      const payloadAfter = pendingAfter?.payload as Record<string, unknown>;
      expect(payloadAfter.quote).toBe(texts.erase.redactedQuote);
      expect(payloadAfter.quoteAuthorUserId).toBeNull();

      const deps = {
        db,
        clock: fixedClock('2026-09-24T09:00:00Z'),
        config: {} as Env,
        messenger: new FakeMessenger(),
        logger,
        workspace: ws,
        taskHooks: [],
      };
      const result = await acceptProposal(deps, {
        proposalId: pendingProposal.id,
        actor: actorOf(owner.id, 'owner'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected acceptProposal to succeed');
      expect(result.value.quoteAuthorUserId).toBeNull();
    },
  );

  it(
    'does not fabricate a redacted quote on a proposal that never had one (payload.quote is null) even ' +
      'when payload.quoteAuthorUserId is set to the erased member (processBatch can store this combination ' +
      'when the source message had no text)',
    async () => {
      const { ws, owner, maria, chat } = await setupSchool();

      const [proposal] = await db
        .insert(proposals)
        .values({
          workspaceId: ws.id,
          chatId: chat.id,
          kind: 'create',
          payload: {
            title: 'Задача без цитаты',
            reasoning: 'placeholder',
            origin: 'ai',
            quote: null,
            quoteAuthorName: null,
            quoteAuthorUserId: maria.id,
          },
          confidence: 0.9,
          policyDecision: 'shown',
          status: 'pending',
        })
        .returning();
      if (!proposal) throw new Error('setup: failed to insert proposal');

      await eraseMember(
        { db, logger, superadminIds: [] },
        { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
      );

      const [after] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
      const payloadAfter = after?.payload as Record<string, unknown>;
      expect(payloadAfter.quote).toBeNull();
      // D46 fix round 2: `quoteAuthorUserId` must be cleared regardless of whether `quote` itself is
      // null — otherwise it keeps pointing at Maria's now-deleted `users` row.
      expect(payloadAfter.quoteAuthorUserId).toBeNull();
      // D46 extension: no author name was stored, so none is fabricated either.
      expect(payloadAfter.quoteAuthorName).toBeNull();

      const deps = {
        db,
        clock: fixedClock('2026-09-24T09:00:00Z'),
        config: {} as Env,
        messenger: new FakeMessenger(),
        logger,
        workspace: ws,
        taskHooks: [],
      };
      const result = await acceptProposal(deps, {
        proposalId: proposal.id,
        actor: actorOf(owner.id, 'owner'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected acceptProposal to succeed');
      expect(result.value.quoteAuthorUserId).toBeNull();
    },
  );

  it(
    "redacts payload.quoteAuthorName even when payload.quote is null (D46 extension) — processBatch's " +
      'buildQuote derives the name from the author independently of whether the message had text',
    async () => {
      const { ws, owner, maria, chat } = await setupSchool();

      const [proposal] = await db
        .insert(proposals)
        .values({
          workspaceId: ws.id,
          chatId: chat.id,
          kind: 'create',
          payload: {
            title: 'Задача без текста',
            reasoning: 'placeholder',
            origin: 'ai',
            quote: null,
            quoteAuthorName: 'Maria',
            quoteAuthorUserId: maria.id,
          },
          confidence: 0.9,
          policyDecision: 'shown',
          status: 'pending',
        })
        .returning();
      if (!proposal) throw new Error('setup: failed to insert proposal');

      await eraseMember(
        { db, logger, superadminIds: [] },
        { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
      );

      const [after] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
      const payloadAfter = after?.payload as Record<string, unknown>;
      expect(payloadAfter.quote).toBeNull();
      expect(payloadAfter.quoteAuthorUserId).toBeNull();
      expect(payloadAfter.quoteAuthorName).toBe(texts.erase.redactedQuoteAuthor);
    },
  );

  it("leaves a task's and a proposal's quote untouched when their quote author is a different member", async () => {
    const { ws, owner, maria, chat } = await setupSchool();

    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId: ws.id,
        title: 'Задача директора',
        description: 'Не трогать',
        origin: 'ai',
        sourceChatId: chat.id,
        sourceTgMessageId: 30,
        sourceQuote: 'Цитата директора',
        quoteAuthorUserId: owner.id,
        createdByUserId: owner.id,
      })
      .returning();
    if (!task) throw new Error('setup: failed to insert task');

    const [proposal] = await db
      .insert(proposals)
      .values({
        workspaceId: ws.id,
        chatId: chat.id,
        kind: 'create',
        payload: {
          title: 'Задача директора',
          reasoning: 'placeholder',
          origin: 'ai',
          quote: 'Цитата директора',
          quoteAuthorName: 'Anna',
          quoteAuthorUserId: owner.id,
        },
        confidence: 0.9,
        policyDecision: 'shown',
        status: 'pending',
      })
      .returning();
    if (!proposal) throw new Error('setup: failed to insert proposal');

    await eraseMember(
      { db, logger, superadminIds: [] },
      { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
    );

    const [taskAfter] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskAfter?.sourceQuote).toBe('Цитата директора');
    expect(taskAfter?.description).toBe('Не трогать');

    const [proposalAfter] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    const proposalPayloadAfter = proposalAfter?.payload as Record<string, unknown>;
    expect(proposalPayloadAfter.quote).toBe('Цитата директора');
    expect(proposalPayloadAfter.quoteAuthorName).toBe('Anna');
  });

  it('leaves a legacy task (quote_author_user_id IS NULL) untouched — no retroactive backfill (D46)', async () => {
    const { ws, owner, maria, chat } = await setupSchool();

    const [legacyTask] = await db
      .insert(tasks)
      .values({
        workspaceId: ws.id,
        title: 'Старая задача',
        description: 'Описание не трогаем',
        assigneeUserId: maria.id,
        origin: 'ai',
        sourceChatId: chat.id,
        sourceTgMessageId: 40,
        sourceQuote: 'Цитата без привязанного автора',
        quoteAuthorUserId: null,
        createdByUserId: owner.id,
      })
      .returning();
    if (!legacyTask) throw new Error('setup: failed to insert legacyTask');

    await eraseMember(
      { db, logger, superadminIds: [] },
      { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
    );

    const [legacyAfter] = await db.select().from(tasks).where(eq(tasks.id, legacyTask.id));
    // She was still anonymized as the assignee (unrelated field)...
    expect(legacyAfter?.assigneeUserId).toBeNull();
    // ...but the legacy quote, with no recorded author, is left exactly as is.
    expect(legacyAfter?.sourceQuote).toBe('Цитата без привязанного автора');
    expect(legacyAfter?.description).toBe('Описание не трогаем');
  });

  it(
    'anonymizes payload.assignee when it names the erased member, so acceptProposal afterward does not ' +
      'violate the assignee_user_id FK (review round 2, I2)',
    async () => {
      const { ws, owner, maria, chat } = await setupSchool();

      const [pendingProposal] = await db
        .insert(proposals)
        .values({
          workspaceId: ws.id,
          chatId: chat.id,
          kind: 'create',
          payload: {
            title: 'Проверить дневники',
            reasoning: 'placeholder',
            origin: 'ai',
            quote: null,
            quoteAuthorName: null,
            assignee: { type: 'user', userId: maria.id },
          },
          confidence: 0.9,
          policyDecision: 'shown',
          status: 'pending',
        })
        .returning();
      if (!pendingProposal) throw new Error('setup: failed to insert pendingProposal');

      // Maria has no other membership, so erasing her also deletes her `users` row — the FK that
      // `acceptProposal` would otherwise violate below if `payload.assignee` still pointed at her.
      await eraseMember(
        { db, logger, superadminIds: [] },
        { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
      );
      expect(await getUserByTgId(db, 2)).toBeNull();

      const [pendingAfter] = await db.select().from(proposals).where(eq(proposals.id, pendingProposal.id));
      const payloadAfter = pendingAfter?.payload as Record<string, unknown>;
      expect(payloadAfter.assignee).toEqual({ type: 'text', name: texts.erase.anonymous });

      const deps = {
        db,
        clock: fixedClock('2026-09-24T09:00:00Z'),
        config: {} as Env,
        messenger: new FakeMessenger(),
        logger,
        workspace: ws,
        taskHooks: [],
      };
      const result = await acceptProposal(deps, {
        proposalId: pendingProposal.id,
        actor: actorOf(owner.id, 'owner'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected acceptProposal to succeed');
      expect(result.value.assigneeUserId).toBeNull();
      expect(result.value.assigneeNameText).toBe(texts.erase.anonymous);
    },
  );

  it(
    'anonymizes payload.changes.assignee on a pending update-kind proposal when it names the erased ' +
      'member, independently of payload.assignee (review round 2, I2)',
    async () => {
      const { ws, owner, maria, chat } = await setupSchool();

      const [targetTask] = await db
        .insert(tasks)
        .values({
          workspaceId: ws.id,
          title: 'Собрать подписи',
          origin: 'manual_group',
          status: 'open',
          createdByUserId: owner.id,
        })
        .returning();
      if (!targetTask) throw new Error('setup: failed to insert targetTask');

      const [pendingEdit] = await db
        .insert(proposals)
        .values({
          workspaceId: ws.id,
          chatId: chat.id,
          kind: 'update',
          targetTaskId: targetTask.id,
          payload: {
            reasoning: 'placeholder',
            origin: 'ai',
            quote: null,
            quoteAuthorName: null,
            changes: { assignee: { type: 'user', userId: maria.id } },
          },
          confidence: 0.9,
          policyDecision: 'shown',
          status: 'pending',
        })
        .returning();
      if (!pendingEdit) throw new Error('setup: failed to insert pendingEdit');

      await eraseMember(
        { db, logger, superadminIds: [] },
        { workspaceId: ws.id, userId: maria.id, actor: actorOf(owner.id, 'owner') },
      );
      expect(await getUserByTgId(db, 2)).toBeNull();

      const [pendingAfter] = await db.select().from(proposals).where(eq(proposals.id, pendingEdit.id));
      const payloadAfter = pendingAfter?.payload as { changes: { assignee: unknown } };
      expect(payloadAfter.changes.assignee).toEqual({ type: 'text', name: texts.erase.anonymous });

      const deps = {
        db,
        clock: fixedClock('2026-09-24T09:00:00Z'),
        config: {} as Env,
        messenger: new FakeMessenger(),
        logger,
        workspace: ws,
        taskHooks: [],
      };
      const result = await applyModification(deps, {
        proposalId: pendingEdit.id,
        actor: actorOf(owner.id, 'owner'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected applyModification to succeed');
      expect(result.value.assigneeUserId).toBeNull();
      expect(result.value.assigneeNameText).toBe(texts.erase.anonymous);
    },
  );
});

describe('eraseWorkspace', () => {
  it(
    'leaves no DB rows for the workspace (including notifications, claim_codes, analysis_batches and ' +
      "the workspace row itself), deletes orphaned members' users rows, and makes the bot leave every " +
      'chat it was still active in',
    async () => {
      const { ws, owner, maria, chat } = await setupSchool();

      const pausedChatActive = await upsertChatOnAdd(db, {
        tgChatId: -101,
        title: 'Paused group',
        type: 'supergroup',
        workspaceId: ws.id,
        addedByUserId: owner.id,
        status: 'active',
        pendingSince: null,
        now: new Date('2026-09-23T12:00:00Z'),
      });
      const pausedChat = await pauseChatRow(db, pausedChatActive.id, new Date('2026-09-23T12:00:00Z'));
      if (!pausedChat) throw new Error('setup: failed to pause the chat');

      const leftChatActive = await upsertChatOnAdd(db, {
        tgChatId: -102,
        title: 'Already left',
        type: 'supergroup',
        workspaceId: ws.id,
        addedByUserId: owner.id,
        status: 'active',
        pendingSince: null,
        now: new Date('2026-09-23T12:00:00Z'),
      });
      const leftChat = await markChatLeft(db, leftChatActive.id, new Date('2026-09-23T12:00:00Z'));
      if (!leftChat) throw new Error('setup: failed to mark the chat left');

      await db.insert(messages).values({
        chatId: chat.id,
        tgMessageId: 1,
        authorUserId: maria.id,
        sentAt: new Date('2026-09-23T12:01:00Z'),
        text: 'привет',
      });
      const [task] = await db
        .insert(tasks)
        .values({ workspaceId: ws.id, title: 'Task', origin: 'manual_group', assigneeUserId: maria.id })
        .returning();
      if (!task) throw new Error('setup: failed to insert task');
      await db
        .insert(taskEvents)
        .values({ taskId: task.id, actorType: 'user', actorUserId: owner.id, type: 'created' });
      await db.insert(proposals).values({
        workspaceId: ws.id,
        chatId: chat.id,
        kind: 'create',
        payload: { title: 'Task' },
        confidence: 0.9,
        policyDecision: 'shown',
      });
      await db.insert(notifications).values({
        workspaceId: ws.id,
        taskId: task.id,
        recipientUserId: owner.id,
        kind: 'due',
        fireAt: new Date('2026-09-23T13:00:00Z'),
        dedupeKey: `task:${String(task.id)}:due`,
      });
      await db.insert(analysisBatches).values({ chatId: chat.id, status: 'done' });
      // Owner issued a /transfer code that was never redeemed — must not block their own users-row delete.
      await createClaimCode(db, {
        workspaceId: ws.id,
        createdByUserId: owner.id,
        previousOwnerAction: 'demote',
        now: new Date('2026-09-23T12:00:00Z'),
      });

      const messenger = new FakeMessenger();
      await eraseWorkspace(
        { db, messenger, logger, superadminIds: [] },
        { workspaceId: ws.id, actor: actorOf(owner.id, 'owner', true) },
      );

      // The bot left every chat it was still active in (active/paused), not the one already left.
      expect(messenger.left.sort()).toEqual([chat.tgChatId, pausedChat.tgChatId].sort());
      expect(messenger.left).not.toContain(leftChat.tgChatId);

      // No row scoped to this workspace remains, including the workspace row itself.
      expect(await db.select().from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(0);
      expect(await db.select().from(chats).where(eq(chats.workspaceId, ws.id))).toHaveLength(0);
      expect(await db.select().from(tasks).where(eq(tasks.workspaceId, ws.id))).toHaveLength(0);
      expect(await db.select().from(proposals).where(eq(proposals.workspaceId, ws.id))).toHaveLength(0);
      expect(await db.select().from(memberships).where(eq(memberships.workspaceId, ws.id))).toHaveLength(0);
      expect(await db.select().from(messages).where(eq(messages.chatId, chat.id))).toHaveLength(0);
      expect(await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id))).toHaveLength(0);
      expect(await db.select().from(notifications).where(eq(notifications.workspaceId, ws.id))).toHaveLength(
        0,
      );
      expect(await db.select().from(claimCodes).where(eq(claimCodes.workspaceId, ws.id))).toHaveLength(0);
      expect(await db.select().from(analysisBatches).where(eq(analysisBatches.chatId, chat.id))).toHaveLength(
        0,
      );

      // Both members had no other workspace and were not superadmins (`superadminIds: []`) — their
      // `users` rows are gone too (D43 review I2), including the claim code the owner created.
      expect(await getUserByTgId(db, owner.tgUserId)).toBeNull();
      expect(await getUserByTgId(db, maria.tgUserId)).toBeNull();
    },
  );

  it("keeps a configured superadmin member's users row, but still deletes a non-superadmin member's", async () => {
    const { ws, owner, maria } = await setupSchool();
    const messenger = new FakeMessenger();

    await eraseWorkspace(
      { db, messenger, logger, superadminIds: [owner.tgUserId] },
      { workspaceId: ws.id, actor: actorOf(owner.id, 'owner', true) },
    );

    expect(await getUserByTgId(db, owner.tgUserId)).not.toBeNull();
    expect(await getUserByTgId(db, maria.tgUserId)).toBeNull();
  });

  it('refuses a non-superadmin actor (even the owner) without touching anything', async () => {
    const { ws, owner } = await setupSchool();
    const messenger = new FakeMessenger();

    await expect(
      eraseWorkspace(
        { db, messenger, logger, superadminIds: [] },
        { workspaceId: ws.id, actor: actorOf(owner.id, 'owner', false) },
      ),
    ).rejects.toMatchObject({ reason: 'forbidden' });

    expect(messenger.left).toHaveLength(0);
    // Both memberships from `setupSchool` (owner + Maria) are untouched.
    expect(await db.select().from(memberships).where(eq(memberships.workspaceId, ws.id))).toHaveLength(2);
  });

  it('is an instance of EraseWorkspaceError', async () => {
    const { ws, owner } = await setupSchool();
    const messenger = new FakeMessenger();
    try {
      await eraseWorkspace(
        { db, messenger, logger, superadminIds: [] },
        { workspaceId: ws.id, actor: actorOf(owner.id, 'owner') },
      );
      expect.unreachable('expected eraseWorkspace to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EraseWorkspaceError);
      expect((err as EraseWorkspaceError).reason).toBe('forbidden');
    }
  });

  it('continues erasing the DB even if leaving some chats fails on the Telegram side, for every remaining chat', async () => {
    const { ws, owner } = await setupSchool();

    // Three active chats: the Telegram-side failure below is queued for only the *first* `leaveChat`
    // call, so this proves one chat's failure does not stop the loop from reaching the other two.
    const chatB = await upsertChatOnAdd(db, {
      tgChatId: -201,
      title: 'B',
      type: 'supergroup',
      workspaceId: ws.id,
      addedByUserId: owner.id,
      status: 'active',
      pendingSince: null,
      now: new Date('2026-09-23T12:00:00Z'),
    });
    const chatC = await upsertChatOnAdd(db, {
      tgChatId: -202,
      title: 'C',
      type: 'supergroup',
      workspaceId: ws.id,
      addedByUserId: owner.id,
      status: 'active',
      pendingSince: null,
      now: new Date('2026-09-23T12:00:00Z'),
    });

    const messenger = new FakeMessenger();
    messenger.failNextWith(new MessengerError('forbidden', 'kicked already'));

    await eraseWorkspace(
      { db, messenger, logger, superadminIds: [] },
      { workspaceId: ws.id, actor: actorOf(owner.id, 'owner', true) },
    );

    // The failing chat's `leaveChat` call still happened (it just threw, and was logged) — only the two
    // that didn't fail actually recorded themselves in `messenger.left`.
    expect(messenger.left.sort()).toEqual([chatB.tgChatId, chatC.tgChatId].sort());
    // All three chats' DB rows are gone regardless of which `leaveChat` call failed.
    expect(await db.select().from(chats).where(eq(chats.workspaceId, ws.id))).toHaveLength(0);
  });

  it("leaves a second workspace's chats, messages, tasks and users completely untouched", async () => {
    const { ws, owner } = await setupSchool();

    const [otherWs] = await db
      .insert(workspaces)
      .values({ name: 'Other School', timezone: 'Europe/Moscow' })
      .returning();
    if (!otherWs) throw new Error('setup: failed to insert other workspace');
    const ownerB = await upsertTelegramUser(db, { id: 60, first_name: 'Olga' });
    await db
      .insert(memberships)
      .values({ workspaceId: otherWs.id, userId: ownerB.id, role: 'owner', displayName: 'Olga' });
    const chatB = await upsertChatOnAdd(db, {
      tgChatId: -300,
      title: 'Other group',
      type: 'supergroup',
      workspaceId: otherWs.id,
      addedByUserId: ownerB.id,
      status: 'active',
      pendingSince: null,
      now: new Date('2026-09-23T12:00:00Z'),
    });
    const [msgB] = await db
      .insert(messages)
      .values({
        chatId: chatB.id,
        tgMessageId: 1,
        authorUserId: ownerB.id,
        sentAt: new Date('2026-09-23T12:01:00Z'),
        text: 'B message',
      })
      .returning();
    if (!msgB) throw new Error('setup: failed to insert msgB');
    const [taskB] = await db
      .insert(tasks)
      .values({ workspaceId: otherWs.id, title: 'B task', origin: 'manual_group' })
      .returning();
    if (!taskB) throw new Error('setup: failed to insert taskB');

    const messenger = new FakeMessenger();
    await eraseWorkspace(
      { db, messenger, logger, superadminIds: [] },
      { workspaceId: ws.id, actor: actorOf(owner.id, 'owner', true) },
    );

    expect(messenger.left).not.toContain(chatB.tgChatId);
    const [otherWsAfter] = await db.select().from(workspaces).where(eq(workspaces.id, otherWs.id));
    expect(otherWsAfter).toBeDefined();
    const [chatBAfter] = await db.select().from(chats).where(eq(chats.id, chatB.id));
    expect(chatBAfter).toBeDefined();
    const [msgBAfter] = await db.select().from(messages).where(eq(messages.id, msgB.id));
    expect(msgBAfter).toBeDefined();
    const [taskBAfter] = await db.select().from(tasks).where(eq(tasks.id, taskB.id));
    expect(taskBAfter).toBeDefined();
    expect(await getUserByTgId(db, 60)).not.toBeNull();
  });
});
