import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, groupText, callback, botKeyboardMessage } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { decodeCallback, encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { hashClaimCode } from '../../../src/domain/people/claim.js';
import { claimCodes, memberships } from '../../../src/db/schema/index.js';

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };
const SUPERADMIN = { id: 900000001, firstName: 'Admin' };
const STRANGER = { id: 300, firstName: 'Nina' };
const GROUP = { id: -1001111, type: 'supergroup' as const, title: 'Group' };

interface RenderedButton {
  text: string;
  callback_data?: string;
}

function lastKeyboard(harness: BotHarness, chatId: number): RenderedButton[][] {
  const sendCalls = harness.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chatId);
  const last = sendCalls[sendCalls.length - 1];
  const markup = last?.payload.reply_markup as { inline_keyboard?: RenderedButton[][] } | undefined;
  if (!markup?.inline_keyboard)
    throw new Error(`no reply_markup on the last sendMessage to ${String(chatId)}`);
  return markup.inline_keyboard;
}

function findButtonData(keyboard: RenderedButton[][], action: string): string {
  for (const row of keyboard) {
    for (const button of row) {
      if (button.callback_data === undefined) continue;
      const decoded = decodeCallback(button.callback_data);
      if (decoded?.action === action) return button.callback_data;
    }
  }
  throw new Error(`no button for action=${action}`);
}

/** Extracts the 8-char claim code out of a `<code>...</code>` span in a reply. */
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

/** A message whose `.chat` is `GROUP` — stands in for the message a group-posted keyboard would be attached to. */
function groupKeyboardMessage(chat: typeof GROUP, from: { id: number; firstName: string }) {
  const msg = groupText(chat, from, '').message;
  if (!msg) throw new Error('expected a message on the fixture update');
  return msg;
}

describe('/transfer', () => {
  it('an owner picking "prior owner becomes a member" gets a message with the code', async () => {
    const harness = await createBotHarness();
    const owner = await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/transfer'));
    expect(harness.replies(OWNER.id)).toEqual([texts.transfer.prompt]);
    const keyboard = lastKeyboard(harness, OWNER.id);
    const demoteData = findButtonData(keyboard, 'dem');

    await harness.send(callback(OWNER, demoteData, botKeyboardMessage(OWNER)));

    const replies = harness.replies(OWNER.id);
    expect(replies).toHaveLength(2);
    const code = extractCode(replies[1] ?? '');
    expect(code).toHaveLength(8);

    const [row] = await harness.db
      .select()
      .from(claimCodes)
      .where(eq(claimCodes.codeHash, hashClaimCode(code)));
    expect(row?.workspaceId).toBe(harness.deps.workspace.id);
    expect(row?.createdByUserId).toBe(owner.id);
    expect(row?.previousOwnerAction).toBe('demote');
    expect(row?.usedAt).toBeNull();
    expect(harness.calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
  });

  it('a member (no owner/superadmin role) is forbidden', async () => {
    const harness = await createBotHarness();
    await makeMember(harness, MEMBER);

    await harness.send(dmText(MEMBER, '/transfer'));

    expect(harness.replies(MEMBER.id)).toEqual([texts.common.forbidden]);
    const codes = await harness.db.select().from(claimCodes);
    expect(codes).toHaveLength(0);
  });

  it('is ignored in a group chat, even for an owner (a claim code must never be posted in a group)', async () => {
    const harness = await createBotHarness();
    await harness.db.insert(memberships).values({
      workspaceId: harness.deps.workspace.id,
      userId: (await upsertTelegramUser(harness.db, { id: OWNER.id, first_name: OWNER.firstName })).id,
      role: 'owner',
      displayName: OWNER.firstName,
    });

    await harness.send(groupText(GROUP, OWNER, '/transfer'));

    expect(harness.replies(GROUP.id)).toEqual([]);
    const codes = await harness.db.select().from(claimCodes);
    expect(codes).toHaveLength(0);
  });

  it('the v1:o:* callback is also ignored in a group chat (defense in depth — no code is ever generated)', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const data = encodeCallback({ entity: 'o', action: 'dem', id: 0 });

    await harness.send(callback(OWNER, data, groupKeyboardMessage(GROUP, OWNER)));

    expect(harness.replies(GROUP.id)).toEqual([]);
    const codes = await harness.db.select().from(claimCodes);
    expect(codes).toHaveLength(0);
    expect(harness.calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
  });
});

describe('/claim', () => {
  it('is ignored in a group chat (no reply)', async () => {
    const harness = await createBotHarness();

    await harness.send(groupText(GROUP, STRANGER, '/claim ABCD2345'));

    expect(harness.replies(GROUP.id)).toEqual([]);
  });

  it('a valid code redeemed in DM makes the claimant the owner', async () => {
    const harness = await createBotHarness();
    const owner = await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/transfer'));
    const keyboard = lastKeyboard(harness, OWNER.id);
    const removeData = findButtonData(keyboard, 'rem');
    await harness.send(callback(OWNER, removeData, botKeyboardMessage(OWNER)));
    const code = extractCode(harness.replies(OWNER.id)[1] ?? '');
    harness.reset();

    await harness.send(dmText(STRANGER, `/claim ${code}`));

    expect(harness.replies(STRANGER.id)).toEqual([texts.claim.success]);

    const [ownerRow] = await harness.db.select().from(memberships).where(eq(memberships.userId, owner.id));
    expect(ownerRow).toBeUndefined(); // previousOwnerAction was 'remove'
  });
});

describe('/admin', () => {
  it('generating "Код владельца" as a superadmin returns a claim code', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/admin'));
    const keyboard = lastKeyboard(harness, SUPERADMIN.id);
    const data = findButtonData(keyboard, 'adm');

    await harness.send(callback(SUPERADMIN, data, botKeyboardMessage(SUPERADMIN)));

    const replies = harness.replies(SUPERADMIN.id);
    expect(replies).toHaveLength(2);
    const code = extractCode(replies[1] ?? '');

    const [row] = await harness.db
      .select()
      .from(claimCodes)
      .where(eq(claimCodes.codeHash, hashClaimCode(code)));
    expect(row?.workspaceId).toBe(harness.deps.workspace.id);
    expect(row?.expiresAt.getTime()).toBe(harness.clock.now().getTime() + 24 * 60 * 60 * 1000);
  });
});
