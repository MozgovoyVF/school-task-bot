import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, callback, botKeyboardMessage } from '../../helpers/updates.js';
import { texts, formatZoneLabel } from '../../../src/bot/texts/ru.js';
import { RU_ZONES, zoneLabel } from '../../../src/time/zones.js';
import { decodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { users } from '../../../src/db/schema/index.js';
import { formatCommandList } from '../../../src/bot/views/help.js';
import { SUPERADMIN_COMMANDS } from '../../../src/bot/commands.js';

const superadminHelpText = texts.help.superadmin(formatCommandList(SUPERADMIN_COMMANDS));
const superadminStartText = texts.start.superadmin(formatCommandList(SUPERADMIN_COMMANDS));

const SUPERADMIN = { id: 900000001, firstName: 'Anna' };
const STRANGER = { id: 42, firstName: 'Ivan' };

interface RenderedButton {
  text: string;
  callback_data?: string;
}

/** Reads the inline keyboard off the most recent `sendMessage` to `chatId`, per row. */
function lastKeyboard(harness: BotHarness, chatId: number): RenderedButton[][] {
  const sendCalls = harness.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chatId);
  const last = sendCalls[sendCalls.length - 1];
  const markup = last?.payload.reply_markup as { inline_keyboard?: RenderedButton[][] } | undefined;
  if (!markup?.inline_keyboard)
    throw new Error(`no reply_markup on the last sendMessage to ${String(chatId)}`);
  return markup.inline_keyboard;
}

/** Finds a `v1:z:*` button on `keyboard` by its decoded `action`/`id`. */
function findZoneButtonData(keyboard: RenderedButton[][], action: string, id: number): string {
  for (const row of keyboard) {
    for (const button of row) {
      if (button.callback_data === undefined) continue;
      const decoded = decodeCallback(button.callback_data);
      if (decoded?.action === action && decoded.id === id) return button.callback_data;
    }
  }
  throw new Error(`no button for action=${action} id=${String(id)}`);
}

const YEKATERINBURG_ID = RU_ZONES.indexOf('Asia/Yekaterinburg');

describe('/start (first run)', () => {
  it('shows the zone picker with "Оставить: Москва" as the default (workspace.timezone), saves the tapped zone, and follows up with the role help', async () => {
    const harness = await createBotHarness();
    const at = harness.clock.now();

    await harness.send(dmText(SUPERADMIN, '/start'));

    expect(harness.replies(SUPERADMIN.id)).toEqual([texts.timezone.prompt]);
    const keyboard = lastKeyboard(harness, SUPERADMIN.id);
    expect(keyboard[0]?.[0]?.text).toBe(
      texts.timezone.keepDefault(
        texts.timezone.zoneButtonLabel('Europe/Moscow', zoneLabel('Europe/Moscow', at)),
      ),
    );
    const data = findZoneButtonData(keyboard, 'def', 0);

    await harness.send(callback(SUPERADMIN, data, botKeyboardMessage(SUPERADMIN)));

    const [row] = await harness.db.select().from(users).where(eq(users.tgUserId, SUPERADMIN.id));
    expect(row?.timezone).toBe('Europe/Moscow');
    expect(harness.replies(SUPERADMIN.id)).toEqual([
      texts.timezone.prompt,
      texts.timezone.saved(formatZoneLabel(zoneLabel('Europe/Moscow', at))),
      superadminHelpText,
    ]);
    expect(harness.calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
  });

  it('reflects a non-Moscow workspace.timezone in the default button, not a hardcoded "Москва" (plan.md D41)', async () => {
    const harness = await createBotHarness({ workspaceTimezone: 'Asia/Yekaterinburg' });
    const at = harness.clock.now();

    await harness.send(dmText(SUPERADMIN, '/start'));

    const keyboard = lastKeyboard(harness, SUPERADMIN.id);
    const expectedLabel = texts.timezone.zoneButtonLabel(
      'Asia/Yekaterinburg',
      zoneLabel('Asia/Yekaterinburg', at),
    );
    expect(keyboard[0]?.[0]?.text).toBe(texts.timezone.keepDefault(expectedLabel));
    expect(keyboard[0]?.[0]?.text).not.toContain('Москва');
    // The workspace zone is no longer Moscow, so Moscow itself is not excluded from the grid
    // (only whichever zone actually equals `workspace.timezone` is) — it stays selectable there too.
    expect(() => findZoneButtonData(keyboard, 'sel', RU_ZONES.indexOf('Europe/Moscow'))).not.toThrow();

    const data = findZoneButtonData(keyboard, 'def', 0);
    await harness.send(callback(SUPERADMIN, data, botKeyboardMessage(SUPERADMIN)));

    const [row] = await harness.db.select().from(users).where(eq(users.tgUserId, SUPERADMIN.id));
    expect(row?.timezone).toBe('Asia/Yekaterinburg');
    expect(harness.replies(SUPERADMIN.id)).toContain(
      texts.timezone.saved(formatZoneLabel(zoneLabel('Asia/Yekaterinburg', at))),
    );
  });

  it('saves a non-default zone tapped from the grid and marks dm_started_at', async () => {
    const harness = await createBotHarness();
    const at = harness.clock.now();

    await harness.send(dmText(STRANGER, '/start'));
    const keyboard = lastKeyboard(harness, STRANGER.id);
    const data = findZoneButtonData(keyboard, 'sel', YEKATERINBURG_ID);

    await harness.send(callback(STRANGER, data, botKeyboardMessage(STRANGER)));

    const [row] = await harness.db.select().from(users).where(eq(users.tgUserId, STRANGER.id));
    expect(row?.timezone).toBe('Asia/Yekaterinburg');
    expect(row?.dmStartedAt).not.toBeNull();
    expect(harness.replies(STRANGER.id)).toEqual([
      texts.timezone.prompt,
      texts.timezone.saved(formatZoneLabel(zoneLabel('Asia/Yekaterinburg', at))),
      texts.help.stranger(),
    ]);
  });

  it('does not re-offer the picker on a later /start once a timezone is set', async () => {
    const harness = await createBotHarness();
    await harness.send(dmText(SUPERADMIN, '/start'));
    const data = findZoneButtonData(lastKeyboard(harness, SUPERADMIN.id), 'def', 0);
    await harness.send(callback(SUPERADMIN, data, botKeyboardMessage(SUPERADMIN)));
    harness.reset();

    await harness.send(dmText(SUPERADMIN, '/start'));

    expect(harness.replies(SUPERADMIN.id)).toEqual([superadminStartText]);
  });
});

describe('/help', () => {
  it('renders a role command reference, distinct from /start’s welcome text', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/help'));

    expect(harness.replies(SUPERADMIN.id)).toEqual([superadminHelpText]);
    expect(superadminHelpText).not.toBe(superadminStartText);
  });
});

describe('/timezone', () => {
  it('manual entry rejects an unresolvable zone and re-prompts, then saves a valid offset', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/timezone'));
    const manualData = findZoneButtonData(lastKeyboard(harness, SUPERADMIN.id), 'man', 0);

    await harness.send(callback(SUPERADMIN, manualData, botKeyboardMessage(SUPERADMIN)));
    expect(harness.replies(SUPERADMIN.id)).toEqual([texts.timezone.prompt, texts.timezone.manualPrompt]);

    await harness.send(dmText(SUPERADMIN, 'Mars/Base'));
    expect(harness.replies(SUPERADMIN.id)).toEqual([
      texts.timezone.prompt,
      texts.timezone.manualPrompt,
      texts.timezone.invalid,
    ]);

    await harness.send(dmText(SUPERADMIN, '+5'));

    const [row] = await harness.db.select().from(users).where(eq(users.tgUserId, SUPERADMIN.id));
    expect(row?.timezone).toBe('UTC+5');
    expect(harness.replies(SUPERADMIN.id)).toEqual([
      texts.timezone.prompt,
      texts.timezone.manualPrompt,
      texts.timezone.invalid,
      texts.timezone.saved('UTC+5'),
    ]);
  });
});
