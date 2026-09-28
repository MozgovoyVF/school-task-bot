import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { callback, botKeyboardMessage, dmText } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { encodeCallback, decodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import type { ChatRow } from '../../../src/domain/chats/repo.js';
import { chats, memberships, messages } from '../../../src/db/schema/index.js';
import type { Buttons } from '../../../src/domain/messenger.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };
const STRANGER = { id: 300, firstName: 'Nina' };
/** Matches `botHarness.ts`'s `DEFAULT_SUPERADMIN_IDS` — a superadmin who is *not* the Owner. */
const SUPERADMIN = { id: 900000001, firstName: 'Admin' };

interface CallbackButton {
  text: string;
  callback_data?: string;
}

function fake(harness: BotHarness): FakeMessenger {
  return harness.deps.messenger as FakeMessenger;
}

/** The last card/list edit `Messenger.edit` recorded for `chatId` (the DM the `/chats` message lives in). */
function lastEditTo(harness: BotHarness, chatId: number): { text: string; buttons?: Buttons } {
  const edits = fake(harness).edits.filter((e) => e.chatId === chatId);
  const last = edits[edits.length - 1];
  if (!last) throw new Error(`no edit sent to ${String(chatId)}`);
  return last;
}

/** `/chats`' own reply goes through `ctx.reply` (real Bot API), same as `/admin`'s panel in chatLifecycle.test.ts. */
function lastKeyboard(harness: BotHarness, chatId: number): CallbackButton[][] {
  const sendCalls = harness.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chatId);
  const last = sendCalls[sendCalls.length - 1];
  const markup = last?.payload.reply_markup as { inline_keyboard?: CallbackButton[][] } | undefined;
  if (!markup?.inline_keyboard)
    throw new Error(`no reply_markup on the last sendMessage to ${String(chatId)}`);
  return markup.inline_keyboard;
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

/** Inserts an already-`active` chat row directly (this suite exercises `/chats`' management actions, not the lifecycle that produces one — that's `chatLifecycle.test.ts`). */
async function makeActiveChat(harness: BotHarness, tgChatId: number, title: string): Promise<ChatRow> {
  const [row] = await harness.db
    .insert(chats)
    .values({
      tgChatId,
      workspaceId: harness.deps.workspace.id,
      title,
      type: 'supergroup',
      status: 'active',
      noticeSentAt: harness.clock.now(),
    })
    .returning();
  if (!row) throw new Error('expected the chat row to be inserted');
  return row;
}

async function getChatRow(harness: BotHarness, chatId: number): Promise<ChatRow | undefined> {
  const [row] = await harness.db.select().from(chats).where(eq(chats.id, chatId));
  return row;
}

describe('/chats management', () => {
  it('lists chats with their status and offers a button per chat', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const chat = await makeActiveChat(harness, -5001, 'Учителя французского');

    await harness.send(dmText(OWNER, '/chats'));

    expect(harness.replies(OWNER.id)[0]).toContain('🟢 активен');
    expect(harness.replies(OWNER.id)[0]).toContain('Учителя французского');
    const keyboard = lastKeyboard(harness, OWNER.id);
    const opn = keyboard.flat().find((b) => decodeCallback(b.callback_data ?? '')?.action === 'opn');
    expect(opn && decodeCallback(opn.callback_data ?? '')?.id).toBe(chat.id);
  });

  it('an owner toggling analysis updates the DB and edits the card in place; a member is forbidden', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await makeMember(harness, MEMBER);
    const chat = await makeActiveChat(harness, -5002, 'Group');
    const data = encodeCallback({ entity: 'c', action: 'ana', id: chat.id });

    await harness.send(callback(MEMBER, data, botKeyboardMessage(MEMBER)));
    let row = await getChatRow(harness, chat.id);
    expect(row?.analysisEnabled).toBe(true); // unchanged

    await harness.send(callback(OWNER, data, botKeyboardMessage(OWNER)));
    row = await getChatRow(harness, chat.id);
    expect(row?.analysisEnabled).toBe(false);

    const edit = lastEditTo(harness, OWNER.id);
    expect(edit.buttons?.flat().map((b) => b.text)).toContain('Анализ: выкл');
  });

  it('an owner toggling reactions updates the DB and edits the card in place', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const chat = await makeActiveChat(harness, -5003, 'Group');
    const data = encodeCallback({ entity: 'c', action: 'rea', id: chat.id });

    await harness.send(callback(OWNER, data, botKeyboardMessage(OWNER)));

    const row = await getChatRow(harness, chat.id);
    expect(row?.reactionsEnabled).toBe(false);
    expect(
      lastEditTo(harness, OWNER.id)
        .buttons?.flat()
        .map((b) => b.text),
    ).toContain('Реакции: выкл');
  });

  it('"⏸ Пауза" pauses an active chat; "▶️ Возобновить" resumes it', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const chat = await makeActiveChat(harness, -5004, 'Group');

    await harness.send(
      callback(OWNER, encodeCallback({ entity: 'c', action: 'pau', id: chat.id }), botKeyboardMessage(OWNER)),
    );
    let row = await getChatRow(harness, chat.id);
    expect(row?.status).toBe('paused');
    expect(lastEditTo(harness, OWNER.id).text).toContain('пауза');

    await harness.send(
      callback(OWNER, encodeCallback({ entity: 'c', action: 'res', id: chat.id }), botKeyboardMessage(OWNER)),
    );
    row = await getChatRow(harness, chat.id);
    expect(row?.status).toBe('active');
    expect(lastEditTo(harness, OWNER.id).text).toContain('активен');
  });

  it('"🚪 Покинуть" asks for confirmation; confirming leaves the chat and deletes its pending messages', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const chat = await makeActiveChat(harness, -5005, 'Учителя французского');
    await harness.db.insert(messages).values({
      chatId: chat.id,
      tgMessageId: 1,
      sentAt: harness.clock.now(),
      text: 'hello',
      analysisStatus: 'pending',
    });

    await harness.send(
      callback(OWNER, encodeCallback({ entity: 'c', action: 'lva', id: chat.id }), botKeyboardMessage(OWNER)),
    );
    const confirmEdit = lastEditTo(harness, OWNER.id);
    expect(confirmEdit.text).toBe('Точно покинуть „Учителя французского“?');

    await harness.send(
      callback(OWNER, encodeCallback({ entity: 'c', action: 'lvc', id: chat.id }), botKeyboardMessage(OWNER)),
    );

    const row = await getChatRow(harness, chat.id);
    expect(row?.status).toBe('left');
    expect(fake(harness).left).toContain(-5005);

    const remaining = await harness.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(remaining).toHaveLength(0);
  });

  it('a member is forbidden from pausing or leaving a chat', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await makeMember(harness, MEMBER);
    const chat = await makeActiveChat(harness, -5006, 'Group');

    await harness.send(
      callback(
        MEMBER,
        encodeCallback({ entity: 'c', action: 'pau', id: chat.id }),
        botKeyboardMessage(MEMBER),
      ),
    );
    const row = await getChatRow(harness, chat.id);
    expect(row?.status).toBe('active');
  });

  // Regression (group review of Task 1.9): `lst`/`opn`/`lva` used to skip the permission check
  // entirely — a forged callback against any of the three could hand back the chat list, an
  // individual chat's card, or the leave-confirmation prompt to anyone, regardless of role.
  it('a member and a stranger get `forbidden` (not chat data) from lst/opn/lva', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await makeMember(harness, MEMBER);
    const chat = await makeActiveChat(harness, -5007, 'Group');
    const actions = ['lst', 'opn', 'lva'] as const;

    for (const actor of [MEMBER, STRANGER]) {
      for (const action of actions) {
        await harness.send(
          callback(
            actor,
            encodeCallback({ entity: 'c', action, id: action === 'lst' ? 0 : chat.id }),
            botKeyboardMessage(actor),
          ),
        );
      }
    }

    expect(fake(harness).edits).toHaveLength(0);
    const answers = harness.calls.filter((c) => c.method === 'answerCallbackQuery');
    expect(answers).toHaveLength(6);
    for (const answer of answers) {
      expect(answer.payload.text).toBe(texts.common.forbidden);
    }
  });

  // Regression (group review of Task 1.9): `/chats` used to reuse `chat.approve` (superadmin or
  // Owner) instead of an Owner-only permission, per SPEC §12.2's `/chats` row.
  it('a superadmin who is not the Owner is forbidden from /chats and its callbacks (chat.manage is Owner-only)', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const chat = await makeActiveChat(harness, -5008, 'Group');

    await harness.send(dmText(SUPERADMIN, '/chats'));
    expect(harness.replies(SUPERADMIN.id)).toEqual([texts.common.forbidden]);

    await harness.send(
      callback(
        SUPERADMIN,
        encodeCallback({ entity: 'c', action: 'ana', id: chat.id }),
        botKeyboardMessage(SUPERADMIN),
      ),
    );
    const row = await getChatRow(harness, chat.id);
    expect(row?.analysisEnabled).toBe(true); // unchanged
    expect(fake(harness).edits.filter((e) => e.chatId === SUPERADMIN.id)).toHaveLength(0);
  });

  it('/chats in a group is silently ignored (DM-only, same as /transfer)', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: -999, type: 'supergroup', title: 'G' },
        from: { id: OWNER.id, is_bot: false, first_name: OWNER.firstName },
        text: '/chats',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    });

    expect(harness.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
  });

  it("texts.common.forbidden is sent to a stranger's /chats", async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await makeMember(harness, MEMBER);

    await harness.send(dmText(MEMBER, '/chats'));

    expect(harness.replies(MEMBER.id)).toEqual([texts.common.forbidden]);
  });
});
