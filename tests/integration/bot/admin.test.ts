import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, groupText, callback, botKeyboardMessage } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { decodeCallback, encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { upsertChatOnAdd } from '../../../src/domain/chats/repo.js';
import { chats, memberships, workspaces } from '../../../src/db/schema/index.js';
import type { Buttons } from '../../../src/domain/messenger.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';

const SUPERADMIN = { id: 900000001, firstName: 'Anna' };
const STRANGER = { id: 42, firstName: 'Ivan' };
const GROUP = { id: -1003333, type: 'supergroup' as const, title: 'Учительская' };

interface CallbackButton {
  text: string;
  callback_data?: string;
}

function fake(harness: BotHarness): FakeMessenger {
  return harness.deps.messenger as FakeMessenger;
}

function lastEditTo(harness: BotHarness, chatId: number): { text: string; buttons?: Buttons } {
  const edits = fake(harness).edits.filter((e) => e.chatId === chatId);
  const last = edits[edits.length - 1];
  if (!last) throw new Error(`no edit sent to ${String(chatId)}`);
  return last;
}

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

describe('/admin', () => {
  it('forbids a non-superadmin', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(STRANGER, '/admin'));

    expect(harness.replies(STRANGER.id)).toEqual([texts.common.forbidden]);
  });

  it('shows GIT_SHA and elapsed uptime for a superadmin', async () => {
    const harness = await createBotHarness();
    harness.clock.advance(90_000);

    await harness.send(dmText(SUPERADMIN, '/admin'));

    expect(harness.replies(SUPERADMIN.id)).toEqual([
      texts.admin.panel('test-sha', 90, {
        costToday: 0,
        costMonth: 0,
        last7: { shown: 0, suppressed: 0, accepted: 0, rejected: 0 },
        precision: null,
      }),
    ]);
  });

  it('has no effect at all in a group, even for a superadmin (final Phase 1 review’s C1 fix)', async () => {
    const harness = await createBotHarness();

    await harness.send(groupText(GROUP, SUPERADMIN, '/admin'));

    expect(harness.replies(GROUP.id)).toEqual([]);
  });
});

describe('/testerror', () => {
  it('reports to superadmins and apologizes to the invoking superadmin', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/testerror'));

    const messenger = harness.deps.messenger as FakeMessenger;
    const report = messenger.sent.find((s) => s.chatId === SUPERADMIN.id);
    expect(report?.text).toContain('Test error from /testerror');
    expect(harness.replies(SUPERADMIN.id)).toContain(texts.errors.userFacing);
  });

  it('is silently ignored for a non-superadmin (no reply, no report)', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(STRANGER, '/testerror'));

    expect(harness.replies(STRANGER.id)).toEqual([]);
    const messenger = harness.deps.messenger as FakeMessenger;
    expect(messenger.sent).toEqual([]);
  });

  it(
    'still reports to superadmins when thrown in a group, but does not post the apology there ' +
      '(final Phase 1 review’s I1 fix)',
    async () => {
      const harness = await createBotHarness();

      await harness.send(groupText(GROUP, SUPERADMIN, '/testerror'));

      const messenger = harness.deps.messenger as FakeMessenger;
      const report = messenger.sent.find((s) => s.chatId === SUPERADMIN.id);
      expect(report?.text).toContain('Test error from /testerror');
      expect(harness.replies(GROUP.id)).toEqual([]);
    },
  );
});

describe('/admin — erase workspace (D43 review I3.1)', () => {
  it('requires two confirmations past the initial press, then deletes the workspace and leaves every active chat', async () => {
    const harness = await createBotHarness();
    const superadminUser = await upsertTelegramUser(harness.db, {
      id: SUPERADMIN.id,
      first_name: SUPERADMIN.firstName,
    });
    await harness.db.insert(memberships).values({
      workspaceId: harness.deps.workspace.id,
      userId: superadminUser.id,
      role: 'owner',
      displayName: SUPERADMIN.firstName,
    });
    const chat = await upsertChatOnAdd(harness.db, {
      tgChatId: -5000,
      title: 'Group',
      type: 'supergroup',
      workspaceId: harness.deps.workspace.id,
      addedByUserId: superadminUser.id,
      status: 'active',
      pendingSince: null,
      now: harness.clock.now(),
    });

    await harness.send(dmText(SUPERADMIN, '/admin'));
    const panelKeyboard = lastKeyboard(harness, SUPERADMIN.id);
    const weraData = findButtonData(panelKeyboard, 'wera', 0);

    // Initial press — only opens the first confirm screen, nothing deleted yet.
    await harness.send(callback(SUPERADMIN, weraData, botKeyboardMessage(SUPERADMIN)));
    const confirm1 = lastEditTo(harness, SUPERADMIN.id);
    expect(confirm1.text).toBe(texts.erase.workspaceConfirm1);
    expect(await harness.db.select().from(chats).where(eq(chats.id, chat.id))).toHaveLength(1);

    // First confirmation — still not deleted, now shows the second (final) confirm screen.
    const werbData = findDomainButtonData(confirm1.buttons ?? [], 'werb', 0);
    await harness.send(callback(SUPERADMIN, werbData, botKeyboardMessage(SUPERADMIN)));
    const confirm2 = lastEditTo(harness, SUPERADMIN.id);
    expect(confirm2.text).toBe(texts.erase.workspaceConfirm2);
    expect(await harness.db.select().from(chats).where(eq(chats.id, chat.id))).toHaveLength(1);

    // Second confirmation — now it's actually gone, and the bot left the chat for real.
    const wercData = findDomainButtonData(confirm2.buttons ?? [], 'werc', 0);
    await harness.send(callback(SUPERADMIN, wercData, botKeyboardMessage(SUPERADMIN)));

    expect(await harness.db.select().from(chats).where(eq(chats.id, chat.id))).toHaveLength(0);
    expect(
      await harness.db.select().from(workspaces).where(eq(workspaces.id, harness.deps.workspace.id)),
    ).toHaveLength(0);
    expect(fake(harness).left).toContain(chat.tgChatId);
    const finalEdit = lastEditTo(harness, SUPERADMIN.id);
    expect(finalEdit.text).toBe(texts.erase.workspaceDone);
  });

  it('cancelling (werx) on either confirm screen returns to the live panel without deleting anything', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/admin'));
    const panelKeyboard = lastKeyboard(harness, SUPERADMIN.id);
    const weraData = findButtonData(panelKeyboard, 'wera', 0);
    await harness.send(callback(SUPERADMIN, weraData, botKeyboardMessage(SUPERADMIN)));
    const confirm1 = lastEditTo(harness, SUPERADMIN.id);

    const werxData = findDomainButtonData(confirm1.buttons ?? [], 'werx', 0);
    await harness.send(callback(SUPERADMIN, werxData, botKeyboardMessage(SUPERADMIN)));

    const backToPanel = lastEditTo(harness, SUPERADMIN.id);
    expect(backToPanel.text).toContain('Панель администратора');
    expect(
      await harness.db.select().from(workspaces).where(eq(workspaces.id, harness.deps.workspace.id)),
    ).toHaveLength(1);
  });

  it('a non-superadmin cannot reach the erase-workspace flow even with a hand-crafted callback', async () => {
    const harness = await createBotHarness();
    const data = encodeCallback({ entity: 'a', action: 'wera', id: 0 });

    await harness.send(callback(STRANGER, data, botKeyboardMessage(STRANGER)));

    expect(fake(harness).edits).toHaveLength(0);
    expect(
      await harness.db.select().from(workspaces).where(eq(workspaces.id, harness.deps.workspace.id)),
    ).toHaveLength(1);
  });
});
