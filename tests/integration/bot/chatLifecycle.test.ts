import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import {
  botAdded,
  botKicked,
  botPromoted,
  callback,
  botKeyboardMessage,
  chatMigrated,
  dmText,
} from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { decodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import type { Buttons } from '../../../src/domain/messenger.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { chats, memberships, messages, tasks } from '../../../src/db/schema/index.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };
const SUPERADMIN = { id: 900000001, firstName: 'Admin' };
const STRANGER = { id: 300, firstName: 'Nina' };
const GROUP = { id: -1001111, type: 'supergroup' as const, title: 'Group' };

interface CallbackButton {
  text: string;
  callback_data?: string;
}

/**
 * `chatMember.ts`'s handlers send everything (the privacy notice, the
 * approval card) through the domain-level `Messenger` — `harness.deps.messenger`
 * (a `FakeMessenger`) — not through `ctx.reply`/`bot.api`, so none of it shows
 * up in `harness.calls`/`harness.replies()` (those only see real Bot API
 * calls). These helpers read `FakeMessenger.sent` instead.
 */
function fake(harness: BotHarness): FakeMessenger {
  return harness.deps.messenger as FakeMessenger;
}

function sentTo(harness: BotHarness, chatId: number): string[] {
  return fake(harness)
    .sent.filter((m) => m.chatId === chatId)
    .map((m) => m.text);
}

function lastButtonsTo(harness: BotHarness, chatId: number): Buttons {
  const sent = fake(harness).sent.filter((m) => m.chatId === chatId);
  const last = sent[sent.length - 1];
  if (!last?.opts?.buttons) throw new Error(`no message with buttons sent to ${String(chatId)}`);
  return last.opts.buttons;
}

function findButtonData(buttons: Buttons, action: string): string {
  for (const row of buttons) {
    for (const button of row) {
      if (button.data === undefined) continue;
      const decoded = decodeCallback(button.data);
      if (decoded?.action === action) return button.data;
    }
  }
  throw new Error(`no button for action=${action}`);
}

/** For the `/admin`/`/claim` portion of a test — those go through `ctx.reply`, i.e. real Bot API calls. */
function lastKeyboard(harness: BotHarness, chatId: number): CallbackButton[][] {
  const sendCalls = harness.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chatId);
  const last = sendCalls[sendCalls.length - 1];
  const markup = last?.payload.reply_markup as { inline_keyboard?: CallbackButton[][] } | undefined;
  if (!markup?.inline_keyboard)
    throw new Error(`no reply_markup on the last sendMessage to ${String(chatId)}`);
  return markup.inline_keyboard;
}

function findTgButtonData(keyboard: CallbackButton[][], action: string): string {
  for (const row of keyboard) {
    for (const button of row) {
      if (button.callback_data === undefined) continue;
      const decoded = decodeCallback(button.callback_data);
      if (decoded?.action === action) return button.callback_data;
    }
  }
  throw new Error(`no button for action=${action}`);
}

/** Extracts the 8-char claim code out of a `<code>...</code>` span in a reply (mirrors transfer.test.ts). */
function extractCode(text: string): string {
  const match = /<code>([A-Z0-9]{8})<\/code>/.exec(text);
  if (!match?.[1]) throw new Error(`no claim code found in: ${text}`);
  return match[1];
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

async function getChatRow(harness: BotHarness, tgChatId: number) {
  const [row] = await harness.db.select().from(chats).where(eq(chats.tgChatId, tgChatId));
  return row;
}

describe('group chat lifecycle', () => {
  it('the owner adding the bot activates the chat and publishes the privacy notice exactly once', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(botAdded(GROUP, OWNER));

    const chatRow = await getChatRow(harness, GROUP.id);
    expect(chatRow?.status).toBe('active');
    expect(chatRow?.noticeSentAt).not.toBeNull();
    expect(sentTo(harness, GROUP.id)).toEqual([texts.privacy.chatNotice]);

    await harness.send(botAdded(GROUP, OWNER)); // a duplicate my_chat_member update

    expect(sentTo(harness, GROUP.id)).toEqual([texts.privacy.chatNotice]); // still just the one notice
  });

  it('a superadmin adding the bot activates the chat directly (D14)', async () => {
    const harness = await createBotHarness();

    await harness.send(botAdded(GROUP, SUPERADMIN));

    const chatRow = await getChatRow(harness, GROUP.id);
    expect(chatRow?.status).toBe('active');
    expect(sentTo(harness, GROUP.id)).toEqual([texts.privacy.chatNotice]);
  });

  it('a stranger adding the bot, with an owner already set, leaves it pending and cards the owner + superadmin', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(botAdded(GROUP, STRANGER));

    const chatRow = await getChatRow(harness, GROUP.id);
    expect(chatRow?.status).toBe('pending');
    expect(chatRow?.pendingSince).not.toBeNull();

    const ownerMessages = sentTo(harness, OWNER.id);
    expect(ownerMessages).toHaveLength(1);
    expect(ownerMessages[0]).toContain('Group');
    expect(ownerMessages[0]).toContain('Nina');
    expect(sentTo(harness, SUPERADMIN.id)).toHaveLength(1);

    const buttons = lastButtonsTo(harness, OWNER.id);
    expect(findButtonData(buttons, 'apr')).toBeTruthy();
    expect(findButtonData(buttons, 'rej')).toBeTruthy();
  });

  it('with no owner yet, a stranger add leaves pending_since null and cards only the superadmin — /claim later requests approval', async () => {
    const harness = await createBotHarness();

    await harness.send(botAdded(GROUP, STRANGER));

    let chatRow = await getChatRow(harness, GROUP.id);
    expect(chatRow?.status).toBe('pending');
    expect(chatRow?.pendingSince).toBeNull();
    expect(sentTo(harness, OWNER.id)).toEqual([]);
    expect(sentTo(harness, SUPERADMIN.id)).toHaveLength(1);

    // The superadmin issues a claim code for the empty workspace, and OWNER claims it
    // (these two steps go through real bot commands, hence `ctx.reply`/`harness.replies`).
    await harness.send(dmText(SUPERADMIN, '/admin'));
    const keyboard = lastKeyboard(harness, SUPERADMIN.id);
    const data = findTgButtonData(keyboard, 'adm');
    await harness.send(callback(SUPERADMIN, data, botKeyboardMessage(SUPERADMIN)));
    const code = extractCode(harness.replies(SUPERADMIN.id)[1] ?? '');

    await harness.send(dmText(OWNER, `/claim ${code}`));

    chatRow = await getChatRow(harness, GROUP.id);
    expect(chatRow?.pendingSince).not.toBeNull();
    const ownerMessages = sentTo(harness, OWNER.id);
    expect(ownerMessages.some((m) => m.includes('Group'))).toBe(true);
  });

  it('"Разрешить" from the owner activates the chat and publishes the notice; from a member (forged callback) it is forbidden', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await makeMember(harness, MEMBER);

    await harness.send(botAdded(GROUP, STRANGER));
    const buttons = lastButtonsTo(harness, OWNER.id);
    const approveData = findButtonData(buttons, 'apr');

    await harness.send(callback(MEMBER, approveData, botKeyboardMessage(MEMBER)));
    let chatRow = await getChatRow(harness, GROUP.id);
    expect(chatRow?.status).toBe('pending');

    await harness.send(callback(OWNER, approveData, botKeyboardMessage(OWNER)));
    chatRow = await getChatRow(harness, GROUP.id);
    expect(chatRow?.status).toBe('active');
    expect(sentTo(harness, GROUP.id)).toEqual([texts.privacy.chatNotice]);
  });

  it('"Покинуть чат" rejects a pending chat: the bot leaves and status becomes left', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(botAdded(GROUP, STRANGER));
    const buttons = lastButtonsTo(harness, OWNER.id);
    const rejectData = findButtonData(buttons, 'rej');

    await harness.send(callback(OWNER, rejectData, botKeyboardMessage(OWNER)));

    const chatRow = await getChatRow(harness, GROUP.id);
    expect(chatRow?.status).toBe('left');
    expect(fake(harness).left).toContain(GROUP.id);
  });

  it('the bot being kicked marks the chat left, deletes pending messages, and leaves tasks untouched', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await harness.send(botAdded(GROUP, OWNER));
    const chatRow = await getChatRow(harness, GROUP.id);
    if (!chatRow) throw new Error('expected the chat row to exist');

    await harness.db.insert(messages).values({
      chatId: chatRow.id,
      tgMessageId: 1,
      sentAt: harness.clock.now(),
      text: 'hello',
      analysisStatus: 'pending',
    });
    const [task] = await harness.db
      .insert(tasks)
      .values({
        workspaceId: harness.deps.workspace.id,
        title: 'Do something',
        origin: 'manual_group',
        sourceChatId: chatRow.id,
      })
      .returning();
    if (!task) throw new Error('expected the task row to be inserted');

    await harness.send(botKicked(GROUP, OWNER));

    const chatAfter = await getChatRow(harness, GROUP.id);
    expect(chatAfter?.status).toBe('left');
    expect(chatAfter?.noticeSentAt).toBeNull();

    const remainingMessages = await harness.db.select().from(messages).where(eq(messages.chatId, chatRow.id));
    expect(remainingMessages).toHaveLength(0);

    const [taskAfter] = await harness.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskAfter).toBeDefined();
  });

  it('migrate_to_chat_id updates the same row\'s tg_chat_id and type', async () => {
    const harness = await createBotHarness();
    const OLD_GROUP = { id: -333, type: 'group' as const, title: 'Old Group' };
    const NEW_TG_ID = -1004444;
    await makeOwner(harness, OWNER);
    await harness.send(botAdded(OLD_GROUP, OWNER));
    const before = await getChatRow(harness, OLD_GROUP.id);
    if (!before) throw new Error('expected the chat row to exist');

    await harness.send(chatMigrated(OLD_GROUP, NEW_TG_ID, OWNER));

    const [after] = await harness.db.select().from(chats).where(eq(chats.id, before.id));
    expect(after?.tgChatId).toBe(NEW_TG_ID);
    expect(after?.type).toBe('supergroup');
  });

  it('promoting the bot to administrator does not change its status', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await harness.send(botAdded(GROUP, OWNER));

    await harness.send(botPromoted(GROUP, OWNER));

    const chatRow = await getChatRow(harness, GROUP.id);
    expect(chatRow?.status).toBe('active');
  });
});
