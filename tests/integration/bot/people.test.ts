import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { callback, botKeyboardMessage, dmText } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { decodeCallback, encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { upsertTelegramUser, type MembershipRow } from '../../../src/domain/people/repo.js';
import { memberships } from '../../../src/db/schema/index.js';
import type { Buttons } from '../../../src/domain/messenger.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };

interface CallbackButton {
  text: string;
  callback_data?: string;
}

function fake(harness: BotHarness): FakeMessenger {
  return harness.deps.messenger as FakeMessenger;
}

/** The last card/list edit `Messenger.edit` recorded for `chatId` (the DM the `/people` message lives in). */
function lastEditTo(harness: BotHarness, chatId: number): { text: string; buttons?: Buttons } {
  const edits = fake(harness).edits.filter((e) => e.chatId === chatId);
  const last = edits[edits.length - 1];
  if (!last) throw new Error(`no edit sent to ${String(chatId)}`);
  return last;
}

/** `/people`'s own reply and the conversation's prompts go through `ctx.reply` (real Bot API). */
function lastKeyboard(harness: BotHarness, chatId: number): CallbackButton[][] {
  const sendCalls = harness.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chatId);
  const last = sendCalls[sendCalls.length - 1];
  const markup = last?.payload.reply_markup as { inline_keyboard?: CallbackButton[][] } | undefined;
  if (!markup?.inline_keyboard)
    throw new Error(`no reply_markup on the last sendMessage to ${String(chatId)}`);
  return markup.inline_keyboard;
}

function findButtonData(keyboard: CallbackButton[][], action: string, id: number): string {
  for (const row of keyboard) {
    for (const button of row) {
      if (button.callback_data === undefined) continue;
      const decoded = decodeCallback(button.callback_data);
      if (decoded?.action === action && decoded.id === id) return button.callback_data;
    }
  }
  throw new Error(`no button for action=${action} id=${String(id)}`);
}

/** Same lookup as {@link findButtonData}, but for `Messenger.edit`'s domain-level `Buttons` (`data`, not `callback_data`). */
function findDomainButtonData(buttons: Buttons, action: string, id: number): string {
  for (const row of buttons) {
    for (const button of row) {
      if (button.data === undefined) continue;
      const decoded = decodeCallback(button.data);
      if (decoded?.action === action && decoded.id === id) return button.data;
    }
  }
  throw new Error(`no button for action=${action} id=${String(id)}`);
}

async function makeOwner(
  harness: BotHarness,
  tgUser: { id: number; firstName: string },
): Promise<MembershipRow> {
  const userRow = await upsertTelegramUser(harness.db, { id: tgUser.id, first_name: tgUser.firstName });
  const [row] = await harness.db
    .insert(memberships)
    .values({
      workspaceId: harness.deps.workspace.id,
      userId: userRow.id,
      role: 'owner',
      displayName: tgUser.firstName,
    })
    .returning();
  if (!row) throw new Error('expected the owner membership row to be inserted');
  return row;
}

async function makeMember(
  harness: BotHarness,
  tgUser: { id: number; firstName: string },
): Promise<MembershipRow> {
  const userRow = await upsertTelegramUser(harness.db, { id: tgUser.id, first_name: tgUser.firstName });
  const [row] = await harness.db
    .insert(memberships)
    .values({
      workspaceId: harness.deps.workspace.id,
      userId: userRow.id,
      role: 'member',
      displayName: tgUser.firstName,
      aliases: ['Боря'],
    })
    .returning();
  if (!row) throw new Error('expected the member membership row to be inserted');
  return row;
}

describe('/people', () => {
  it('an owner sees the member list with name/aliases/timezone (no notify toggle, D40); a member is forbidden', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    await makeMember(harness, MEMBER);

    await harness.send(dmText(MEMBER, '/people'));
    expect(harness.replies(MEMBER.id)).toEqual([texts.common.forbidden]);

    await harness.send(dmText(OWNER, '/people'));
    const [listText] = harness.replies(OWNER.id).slice(-1);
    expect(listText).toContain('Anna');
    expect(listText).toContain('Boris');
    expect(listText).toContain('Боря');
    expect(listText).toContain('МСК');
    expect(listText).not.toMatch(/уведомлен/i);
  });

  it('opens a member card with name, aliases and timezone', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const memberRow = await makeMember(harness, MEMBER);

    await harness.send(dmText(OWNER, '/people'));
    const listKeyboard = lastKeyboard(harness, OWNER.id);
    const opnData = findButtonData(listKeyboard, 'opn', memberRow.id);

    await harness.send(callback(OWNER, opnData, botKeyboardMessage(OWNER)));

    const card = lastEditTo(harness, OWNER.id);
    expect(card.text).toContain('Boris');
    expect(card.text).toContain('Боря');
    expect(card.text).not.toMatch(/уведомлен/i);
    expect(card.buttons?.flat().map((b) => b.text)).toContain(texts.people.editButton);
  });

  it('a member is forbidden from opening a card even with a hand-crafted callback', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const memberRow = await makeMember(harness, MEMBER);
    const data = encodeCallback({ entity: 'u', action: 'opn', id: memberRow.id });

    await harness.send(callback(MEMBER, data, botKeyboardMessage(MEMBER)));

    expect(fake(harness).edits).toHaveLength(0);
  });

  it('editing name and aliases through the dialog saves both to the DB', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const memberRow = await makeMember(harness, MEMBER);

    await harness.send(dmText(OWNER, '/people'));
    const listKeyboard = lastKeyboard(harness, OWNER.id);
    const opnData = findButtonData(listKeyboard, 'opn', memberRow.id);
    await harness.send(callback(OWNER, opnData, botKeyboardMessage(OWNER)));

    const cardButtons = lastEditTo(harness, OWNER.id).buttons ?? [];
    const edtData = findDomainButtonData(cardButtons, 'edt', memberRow.id);
    await harness.send(callback(OWNER, edtData, botKeyboardMessage(OWNER)));

    expect(harness.replies(OWNER.id).at(-1)).toContain('Текущее имя');

    await harness.send(dmText(OWNER, 'Борис Новый'));
    expect(harness.replies(OWNER.id).at(-1)).toContain('Текущие алиасы');

    await harness.send(dmText(OWNER, 'Боря, Борька, боря'));

    const [updated] = await harness.db.select().from(memberships).where(eq(memberships.id, memberRow.id));
    expect(updated?.displayName).toBe('Борис Новый');
    expect(updated?.aliases).toEqual(['Боря', 'Борька']);
    expect(harness.replies(OWNER.id).at(-2)).toBe(texts.people.saved);
    expect(harness.replies(OWNER.id).at(-1)).toContain('Борис Новый');
    expect(
      lastKeyboard(harness, OWNER.id)
        .flat()
        .map((b) => b.text),
    ).toContain(texts.people.editButton);
  });

  it('re-prompts on invalid aliases (too many) instead of failing the dialog', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const memberRow = await makeMember(harness, MEMBER);

    await harness.send(dmText(OWNER, '/people'));
    const listKeyboard = lastKeyboard(harness, OWNER.id);
    await harness.send(
      callback(OWNER, findButtonData(listKeyboard, 'opn', memberRow.id), botKeyboardMessage(OWNER)),
    );
    const cardButtons = lastEditTo(harness, OWNER.id).buttons ?? [];
    await harness.send(
      callback(OWNER, findDomainButtonData(cardButtons, 'edt', memberRow.id), botKeyboardMessage(OWNER)),
    );

    await harness.send(dmText(OWNER, '-'));
    const tooMany = Array.from({ length: 11 }, (_, i) => `a${String(i)}`).join(', ');
    await harness.send(dmText(OWNER, tooMany));
    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.people.aliasesTooMany());

    await harness.send(dmText(OWNER, '-'));

    const [updated] = await harness.db.select().from(memberships).where(eq(memberships.id, memberRow.id));
    // Both steps skipped ("-" then, after the retry, the second "-") — nothing changed.
    expect(updated?.aliases).toEqual(['Боря']);
    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.people.nothingChanged);
  });

  it('skipping both steps ("-", "-") saves nothing and does not touch the DB row', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const memberRow = await makeMember(harness, MEMBER);

    await harness.send(dmText(OWNER, '/people'));
    const listKeyboard = lastKeyboard(harness, OWNER.id);
    await harness.send(
      callback(OWNER, findButtonData(listKeyboard, 'opn', memberRow.id), botKeyboardMessage(OWNER)),
    );
    const cardButtons = lastEditTo(harness, OWNER.id).buttons ?? [];
    await harness.send(
      callback(OWNER, findDomainButtonData(cardButtons, 'edt', memberRow.id), botKeyboardMessage(OWNER)),
    );

    await harness.send(dmText(OWNER, '-'));
    await harness.send(dmText(OWNER, '-'));

    const [updated] = await harness.db.select().from(memberships).where(eq(memberships.id, memberRow.id));
    expect(updated?.displayName).toBe(MEMBER.firstName);
    expect(updated?.aliases).toEqual(['Боря']);
    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.people.nothingChanged);
  });
});
