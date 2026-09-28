import { describe, it, expect, beforeEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import { createLogger } from '../../../src/ops/logger.js';
import { createErrorReporter } from '../../../src/ops/errorReporter.js';
import { loadEnv } from '../../../src/config/env.js';
import { ensureDefaultWorkspace, updateSettings } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser, markDmStarted } from '../../../src/domain/people/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { proposals, messages, memberships, users, chats } from '../../../src/db/schema/index.js';
import type { NewProposal, ProposalPayload } from '../../../src/domain/proposals/repo.js';
import { insertProposal } from '../../../src/domain/proposals/repo.js';
import { cardsJob } from '../../../src/scheduler/jobs/cards.js';
import { MessengerError } from '../../../src/domain/messenger.js';
import type { AppDeps } from '../../../src/deps.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://stb:stb@localhost:5433/stb_test';
const SUPERADMIN_ID = 900000001;

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

async function makeDeps(
  clock: ReturnType<typeof fixedClock>,
  messenger: FakeMessenger = new FakeMessenger(),
): Promise<{ deps: AppDeps; messenger: FakeMessenger }> {
  const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
  const config = makeConfig();
  const logger = createLogger({ level: 'silent' });
  const errors = createErrorReporter({
    db,
    messenger,
    clock,
    logger,
    superadminIds: config.SUPERADMIN_TG_IDS,
  });
  const deps: AppDeps = { config, db, clock, logger, errors, messenger, workspace, ai: null, taskHooks: [] };
  return { deps, messenger };
}

async function makeOwner(workspaceId: number, tgUserId: number, name: string, dmStarted = true) {
  const user = await upsertTelegramUser(db, { id: tgUserId, first_name: name });
  await db.insert(memberships).values({ workspaceId, userId: user.id, role: 'owner', displayName: name });
  if (dmStarted) await markDmStarted(db, user.id, new Date('2020-01-01T00:00:00Z'));
  return user;
}

async function makeChat(workspaceId: number, tgChatId: number, now: Date, reactionsEnabled = true) {
  const chat = await upsertChatOnAdd(db, {
    tgChatId,
    title: `Chat ${String(tgChatId)}`,
    type: 'supergroup',
    workspaceId,
    addedByUserId: null,
    status: 'active',
    pendingSince: null,
    now,
  });
  if (!reactionsEnabled) {
    await db.update(chats).set({ reactionsEnabled: false }).where(eq(chats.id, chat.id));
  }
  return chat;
}

async function makeMessage(chatId: number, tgMessageId: number, sentAt: Date) {
  const [row] = await db
    .insert(messages)
    .values({ chatId, tgMessageId, sentAt, text: 'Маша, подготовь расписание', analysisStatus: 'analyzed' })
    .returning();
  if (!row) throw new Error('failed to insert test message');
  return row;
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
    quote: 'Маша, подготовь расписание',
    quoteAuthorName: 'Анна',
    ...overrides,
  };
}

async function makeProposal(overrides: Partial<NewProposal> & { workspaceId: number; createdAt: Date }) {
  return db.transaction((tx) =>
    insertProposal(tx, {
      workspaceId: overrides.workspaceId,
      chatId: overrides.chatId ?? null,
      batchId: overrides.batchId ?? null,
      kind: overrides.kind ?? 'create',
      category: overrides.category ?? 'assignment',
      payload: overrides.payload ?? basePayload(),
      targetTaskId: overrides.targetTaskId ?? null,
      confidence: overrides.confidence ?? 0.8,
      policyDecision: overrides.policyDecision ?? 'shown',
      policyReason: overrides.policyReason ?? 'high confidence',
      sourceMessageIds: overrides.sourceMessageIds ?? [],
      createdAt: overrides.createdAt,
    }),
  );
}

async function proposalsByIds(ids: number[]) {
  return db.select().from(proposals).where(inArray(proposals.id, ids));
}

describe('cardsJob', () => {
  it('sends up to MAX_CARDS_PER_BATCH cards per batch group and one overflow message for the rest', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const { deps, messenger } = await makeDeps(clock);
    await makeOwner(deps.workspace.id, 42, 'Anna');
    const now = clock.now();

    const created = [];
    for (let i = 0; i < 12; i++) {
      const row = await makeProposal({
        workspaceId: deps.workspace.id,
        batchId: null,
        createdAt: new Date(now.getTime() + i * 1000),
      });
      created.push(row);
    }
    await cardsJob.run(deps);

    expect(messenger.sent).toHaveLength(11);
    const overflow = messenger.sent[messenger.sent.length - 1];
    expect(overflow?.text).toContain('Ещё 2 предложения');
    expect(overflow?.text).toContain('/inbox');

    const after = await proposalsByIds(created.map((p) => p.id));
    const byId = new Map(after.map((p) => [p.id, p]));
    for (const p of created) {
      expect(byId.get(p.id)?.notifiedAt).not.toBeNull();
    }
    const sortedByCreatedAt = [...created].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const p of sortedByCreatedAt.slice(0, 10)) {
      expect(byId.get(p.id)?.ownerDmMessageId).not.toBeNull();
    }
    for (const p of sortedByCreatedAt.slice(10)) {
      expect(byId.get(p.id)?.ownerDmMessageId).toBeNull();
    }
  });

  it('reacts 👀 on the first source message, gated by reactions_enabled/onDetect/noReaction, without blocking delivery on a react() failure', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const { deps, messenger } = await makeDeps(clock);
    await makeOwner(deps.workspace.id, 42, 'Anna');
    const now = clock.now();

    const chatOn = await makeChat(deps.workspace.id, -1001111111111, now, true);
    const chatOff = await makeChat(deps.workspace.id, -1001111111112, now, false);
    const msgOn = await makeMessage(chatOn.id, 501, now);
    const msgOff = await makeMessage(chatOff.id, 502, now);
    const msgNoReaction = await makeMessage(chatOn.id, 503, now);

    const pReacts = await makeProposal({
      workspaceId: deps.workspace.id,
      chatId: chatOn.id,
      sourceMessageIds: [msgOn.id],
      createdAt: now,
    });
    const pDisabledChat = await makeProposal({
      workspaceId: deps.workspace.id,
      chatId: chatOff.id,
      sourceMessageIds: [msgOff.id],
      createdAt: new Date(now.getTime() + 1000),
    });
    const pNoReaction = await makeProposal({
      workspaceId: deps.workspace.id,
      chatId: chatOn.id,
      sourceMessageIds: [msgNoReaction.id],
      payload: basePayload({ noReaction: true }),
      createdAt: new Date(now.getTime() + 2000),
    });

    await cardsJob.run(deps);

    expect(messenger.reactions).toEqual([{ chatId: chatOn.tgChatId, messageId: 501, emoji: '👀' }]);
    expect(messenger.sent).toHaveLength(3);
    const after = await proposalsByIds([pReacts.id, pDisabledChat.id, pNoReaction.id]);
    for (const p of after) expect(p.notifiedAt).not.toBeNull();
  });

  it('does not block card delivery when react() throws bad_request', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    class ReactFailingMessenger extends FakeMessenger {
      override react(): Promise<void> {
        return Promise.reject(new MessengerError('bad_request', 'reaction rejected'));
      }
    }
    const messenger = new ReactFailingMessenger();
    const { deps } = await makeDeps(clock, messenger);
    await makeOwner(deps.workspace.id, 42, 'Anna');
    const now = clock.now();
    const chat = await makeChat(deps.workspace.id, -1001111111113, now, true);
    const msg = await makeMessage(chat.id, 601, now);
    const p = await makeProposal({
      workspaceId: deps.workspace.id,
      chatId: chat.id,
      sourceMessageIds: [msg.id],
      createdAt: now,
    });

    await expect(cardsJob.run(deps)).resolves.toBeUndefined();

    expect(messenger.sent).toHaveLength(1);
    const [after] = await proposalsByIds([p.id]);
    expect(after?.notifiedAt).not.toBeNull();
  });

  it('sends nothing during quiet hours, then one grouped summary once they end (D10)', async () => {
    const clock = fixedClock('2026-09-23T12:00:00Z'); // 15:00 MSK
    const { deps, messenger } = await makeDeps(clock);
    await makeOwner(deps.workspace.id, 42, 'Anna');
    await updateSettings(db, deps.workspace.id, {
      quiet: { enabled: true, weekdays: [], windows: [{ from: '14:00', to: '16:00' }], dateRanges: [] },
    });
    const now = clock.now();

    const p1 = await makeProposal({ workspaceId: deps.workspace.id, createdAt: now });
    const p2 = await makeProposal({
      workspaceId: deps.workspace.id,
      createdAt: new Date(now.getTime() + 1000),
    });

    await cardsJob.run(deps);
    expect(messenger.sent).toHaveLength(0);
    let after = await proposalsByIds([p1.id, p2.id]);
    expect(after.every((p) => p.notifiedAt === null)).toBe(true);

    clock.advance(3 * 60 * 60_000); // 18:00 MSK — past the 14:00-16:00 window
    await cardsJob.run(deps);

    expect(messenger.sent).toHaveLength(1);
    const [summary] = messenger.sent;
    expect(summary?.text).toContain('За время тишины найдено 2 предложения');
    expect(summary?.opts?.buttons?.[0]?.[0]?.text).toBe('📥 Разобрать');

    after = await proposalsByIds([p1.id, p2.id]);
    expect(after.every((p) => p.notifiedAt !== null)).toBe(true);
    expect(after.every((p) => p.ownerDmMessageId === null)).toBe(true);
  });

  it('sends nothing and alerts superadmin (throttled) while the Owner has not started a DM, then resumes after /start', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const { deps, messenger } = await makeDeps(clock);
    const owner = await makeOwner(deps.workspace.id, 42, 'Anna', false);
    const now = clock.now();
    const p = await makeProposal({ workspaceId: deps.workspace.id, createdAt: now });

    await cardsJob.run(deps);
    await cardsJob.run(deps); // second tick within the hour — throttled, not a second alert

    const superadminSends = messenger.sent.filter((s) => s.chatId === SUPERADMIN_ID);
    expect(superadminSends).toHaveLength(1);
    const ownerSends = messenger.sent.filter((s) => s.chatId === owner.tgUserId);
    expect(ownerSends).toHaveLength(0);
    let [after] = await proposalsByIds([p.id]);
    expect(after?.notifiedAt).toBeNull();

    await markDmStarted(db, owner.id, clock.now());
    await cardsJob.run(deps);

    const ownerSendsAfter = messenger.sent.filter((s) => s.chatId === owner.tgUserId);
    expect(ownerSendsAfter).toHaveLength(1);
    [after] = await proposalsByIds([p.id]);
    expect(after?.notifiedAt).not.toBeNull();
  });

  it('marks users.dm_blocked on a forbidden send and leaves notified_at empty for retry', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const { deps, messenger } = await makeDeps(clock);
    const owner = await makeOwner(deps.workspace.id, 42, 'Anna');
    const now = clock.now();
    const p = await makeProposal({ workspaceId: deps.workspace.id, createdAt: now });

    messenger.failNextWith(new MessengerError('forbidden', 'bot was blocked by the user'));
    await cardsJob.run(deps);

    const [ownerAfter] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(ownerAfter?.dmBlocked).toBe(true);
    const [after] = await proposalsByIds([p.id]);
    expect(after?.notifiedAt).toBeNull();
  });

  it('never sends suppressed proposals', async () => {
    const clock = fixedClock('2026-09-23T09:00:00Z');
    const { deps, messenger } = await makeDeps(clock);
    await makeOwner(deps.workspace.id, 42, 'Anna');
    const now = clock.now();
    const p = await makeProposal({
      workspaceId: deps.workspace.id,
      policyDecision: 'suppressed',
      policyReason: 'low confidence',
      createdAt: now,
    });

    await cardsJob.run(deps);

    expect(messenger.sent).toHaveLength(0);
    const [after] = await proposalsByIds([p.id]);
    expect(after?.notifiedAt).toBeNull();
  });
});
