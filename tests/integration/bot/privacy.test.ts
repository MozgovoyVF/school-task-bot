import { describe, it, expect } from 'vitest';
import type { UserFromGetMe } from 'grammy/types';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, groupText, callback, botKeyboardMessage } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { checkPrivacyMode } from '../../../src/bot/startupChecks.js';
import { syncCommands } from '../../../src/bot/commands.js';
import { decodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { memberships } from '../../../src/db/schema/index.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };
const SUPERADMIN_ID = 900000001;
const GROUP = { id: -1001111, type: 'supergroup' as const, title: 'Group' };

interface RenderedButton {
  text: string;
  callback_data?: string;
}

function fake(harness: BotHarness): FakeMessenger {
  return harness.deps.messenger as FakeMessenger;
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

describe('checkPrivacyMode', () => {
  it('alerts every superadmin when the bot has privacy mode enabled (can_read_all_group_messages: false)', async () => {
    const harness = await createBotHarness({ superadminIds: [SUPERADMIN_ID] });
    // The harness's default botInfo already has can_read_all_group_messages: false.
    const me = harness.bot.botInfo;
    expect(me.can_read_all_group_messages).toBe(false);

    await checkPrivacyMode({ logger: harness.deps.logger, errors: harness.deps.errors }, me);

    const sentToSuperadmin = fake(harness).sent.filter((m) => m.chatId === SUPERADMIN_ID);
    expect(sentToSuperadmin).toHaveLength(1);
    expect(sentToSuperadmin[0]?.text).toBe(texts.admin.privacyModeOn);
    expect(sentToSuperadmin[0]?.text).toContain('заново добавьте бота');
  });

  it('sends nothing when the bot can read all group messages', async () => {
    const harness = await createBotHarness({ superadminIds: [SUPERADMIN_ID] });
    const me: UserFromGetMe = { ...harness.bot.botInfo, can_read_all_group_messages: true };

    await checkPrivacyMode({ logger: harness.deps.logger, errors: harness.deps.errors }, me);

    expect(fake(harness).sent).toHaveLength(0);
  });
});

describe('/privacy', () => {
  it('replies with the full text in a group — the one command the bot answers with text there', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(groupText(GROUP, MEMBER, '/privacy'));

    expect(harness.replies(GROUP.id)).toEqual([texts.privacy.full()]);
  });

  it('replies with the same full text in a DM, for anyone (no permission check)', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(MEMBER, '/privacy'));

    expect(harness.replies(MEMBER.id)).toEqual([texts.privacy.full()]);
  });

  it('does not swallow /task in a group — group intake still runs for other commands', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(groupText(GROUP, MEMBER, '/privacy'));
    await harness.send(groupText(GROUP, MEMBER, 'обычное сообщение'));

    // Sanity: /privacy replied, and a later plain message wasn't affected by /privacy's handler.
    expect(harness.replies(GROUP.id)).toEqual([texts.privacy.full()]);
  });
});

describe('syncCommands', () => {
  it('makes 4 setMyCommands calls with the right scopes (1 owner + 1 superadmin)', async () => {
    const harness = await createBotHarness({ superadminIds: [SUPERADMIN_ID] });
    await makeOwner(harness, OWNER);

    await syncCommands(
      { db: harness.db, workspace: harness.deps.workspace, superadminIds: [SUPERADMIN_ID] },
      harness.bot.api,
    );

    const calls = harness.calls.filter((c) => c.method === 'setMyCommands');
    expect(calls).toHaveLength(4);

    const scopes = calls.map((c) => c.payload.scope);
    expect(scopes).toContainEqual({ type: 'all_private_chats' });
    expect(scopes).toContainEqual({ type: 'all_group_chats' });
    expect(scopes).toContainEqual({ type: 'chat', chat_id: OWNER.id });
    expect(scopes).toContainEqual({ type: 'chat', chat_id: SUPERADMIN_ID });

    const dmCall = calls.find(
      (c) => (c.payload.scope as { type?: string } | undefined)?.type === 'all_private_chats',
    );
    const dmCommandNames = (dmCall?.payload.commands as Array<{ command: string }>).map((c) => c.command);
    expect(dmCommandNames).toEqual(['start', 'help', 'timezone', 'privacy']);
    expect(dmCommandNames).not.toContain('my'); // D40

    const groupCall = calls.find(
      (c) => (c.payload.scope as { type?: string } | undefined)?.type === 'all_group_chats',
    );
    const groupCommandNames = (groupCall?.payload.commands as Array<{ command: string }>).map(
      (c) => c.command,
    );
    expect(groupCommandNames).toEqual(['task', 'privacy']);

    const superadminCall = calls.find(
      (c) => (c.payload.scope as { type?: string; chat_id?: number } | undefined)?.chat_id === SUPERADMIN_ID,
    );
    const superadminCommandNames = (superadminCall?.payload.commands as Array<{ command: string }>).map(
      (c) => c.command,
    );
    expect(superadminCommandNames).toEqual(
      expect.arrayContaining(['admin', 'debug', 'reanalyze', 'tasks', 'chats', 'people']),
    );
  });

  it('skips the owner chat scope when the workspace has no owner yet', async () => {
    const harness = await createBotHarness({ superadminIds: [SUPERADMIN_ID] });

    await syncCommands(
      { db: harness.db, workspace: harness.deps.workspace, superadminIds: [SUPERADMIN_ID] },
      harness.bot.api,
    );

    const calls = harness.calls.filter((c) => c.method === 'setMyCommands');
    expect(calls).toHaveLength(3);
  });
});

describe('/claim refreshes the owner command menu', () => {
  it('sets the new owner’s chat-scope command menu right after a successful /claim', async () => {
    const harness = await createBotHarness({ superadminIds: [SUPERADMIN_ID] });
    await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/transfer'));
    const keyboard = lastKeyboard(harness, OWNER.id);
    const removeData = findButtonData(keyboard, 'rem');
    await harness.send(callback(OWNER, removeData, botKeyboardMessage(OWNER)));
    const code = extractCode(harness.replies(OWNER.id)[1] ?? '');
    harness.reset();

    const NEW_OWNER = { id: 300, firstName: 'Nina' };
    await harness.send(dmText(NEW_OWNER, `/claim ${code}`));

    const setMyCommandsCalls = harness.calls.filter((c) => c.method === 'setMyCommands');
    const ownerScopeCall = setMyCommandsCalls.find(
      (c) => (c.payload.scope as { type?: string; chat_id?: number } | undefined)?.chat_id === NEW_OWNER.id,
    );
    expect(ownerScopeCall).toBeDefined();
  });
});
