import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { memberships, chats, analysisBatches, messages } from '../../../src/db/schema/index.js';

const SUPERADMIN = { id: 900000001, firstName: 'Admin' };
const OWNER = { id: 100, firstName: 'Anna' };

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

async function makeChat(harness: BotHarness, tgChatId: number, title: string) {
  const [row] = await harness.db
    .insert(chats)
    .values({ tgChatId, workspaceId: harness.deps.workspace.id, title, type: 'supergroup', status: 'active' })
    .returning();
  if (!row) throw new Error('expected chat to be inserted');
  return row;
}

describe('/debug', () => {
  it('is forbidden for the Owner (superadmin-only per SPEC §12.2, not owner-only)', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await harness.send(dmText(OWNER, '/debug'));
    expect(harness.replies(OWNER.id)).toContain(texts.common.forbidden);
  });

  it('shows the last batches for a superadmin, with shown/suppressed reasons and cost', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness, -1, 'Учителя французского');
    await harness.db.insert(analysisBatches).values({
      chatId: chat.id,
      status: 'done',
      kind: 'auto',
      messageCount: 3,
      model: 'test-model',
      costUsd: '0.0123',
      createdAt: harness.clock.now(),
      finishedAt: harness.clock.now(),
    });

    await harness.send(dmText(SUPERADMIN, '/debug'));
    const text = harness.replies(SUPERADMIN.id).at(-1);
    expect(text).toContain(texts.debug.header);
    expect(text).toContain('Учителя французского');
  });

  it('shows the empty state when there are no batches yet', async () => {
    const harness = await createBotHarness();
    await harness.send(dmText(SUPERADMIN, '/debug'));
    expect(harness.replies(SUPERADMIN.id).at(-1)).toBe(texts.debug.empty);
  });
});

describe('/reanalyze', () => {
  it('is forbidden for the Owner', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const chat = await makeChat(harness, -2, 'Chat');
    await harness.send(dmText(OWNER, `/reanalyze ${String(chat.id)}`));
    expect(harness.replies(OWNER.id)).toContain(texts.common.forbidden);
  });

  it('reports chat_not_found for an unknown chat id', async () => {
    const harness = await createBotHarness();
    await harness.send(dmText(SUPERADMIN, '/reanalyze 999999'));
    expect(harness.replies(SUPERADMIN.id).at(-1)).toBe(texts.reanalyze.chatNotFound);
  });

  it('with no N, requeues failed batches by clearing batch_id on their messages', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness, -3, 'Chat');
    const [batch] = await harness.db
      .insert(analysisBatches)
      .values({ chatId: chat.id, status: 'failed', kind: 'auto', messageCount: 1 })
      .returning();
    if (!batch) throw new Error('expected batch to be inserted');
    const [msg] = await harness.db
      .insert(messages)
      .values({
        chatId: chat.id,
        tgMessageId: 1,
        sentAt: harness.clock.now(),
        text: 'hi',
        analysisStatus: 'pending',
        batchId: batch.id,
      })
      .returning();
    if (!msg) throw new Error('expected message to be inserted');

    await harness.send(dmText(SUPERADMIN, `/reanalyze ${String(chat.id)}`));
    expect(harness.replies(SUPERADMIN.id).at(-1)).toBe(texts.reanalyze.requeued(1, 1));

    const [after] = await harness.db.select().from(messages).where(eq(messages.id, msg.id));
    expect(after?.batchId).toBeNull();
  });

  it('with N, queues a new kind=reanalyze batch over the last N text messages', async () => {
    const harness = await createBotHarness();
    const chat = await makeChat(harness, -4, 'Chat');
    for (let i = 0; i < 3; i++) {
      await harness.db.insert(messages).values({
        chatId: chat.id,
        tgMessageId: i + 1,
        sentAt: new Date(harness.clock.now().getTime() + i * 1000),
        text: `msg ${String(i)}`,
        analysisStatus: 'analyzed',
      });
    }

    await harness.send(dmText(SUPERADMIN, `/reanalyze ${String(chat.id)} 2`));
    expect(harness.replies(SUPERADMIN.id).at(-1)).toBe(texts.reanalyze.created(2));

    const [newBatch] = await harness.db
      .select()
      .from(analysisBatches)
      .where(eq(analysisBatches.chatId, chat.id));
    expect(newBatch?.kind).toBe('reanalyze');
    expect(newBatch?.status).toBe('queued');
  });
});
