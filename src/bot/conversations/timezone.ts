import type { Bot } from 'grammy';
import { createConversation, type Conversation } from '@grammyjs/conversations';
import type { Db } from '../../db/client.js';
import type { Buttons } from '../../domain/messenger.js';
import { setUserTimezone } from '../../domain/people/repo.js';
import { RU_ZONES, parseZoneInput, zoneLabel } from '../../time/zones.js';
import { CONVERSATION_TIMEOUT_MS } from '../../config/constants.js';
import { texts, formatZoneLabel } from '../texts/ru.js';
import { encodeCallback, decodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { renderHelp } from '../views/help.js';
import type { BotContext } from '../context.js';

export const TIMEZONE_CONVERSATION_ID = 'timezone';

type TimezoneConversation = Conversation<BotContext, BotContext>;

const MOSCOW_INDEX = RU_ZONES.indexOf('Europe/Moscow');
const CALLBACK_RE = /^v1:z:/;

/**
 * `texts.timezone.keepMoscow` first, then the rest of `RU_ZONES` (Moscow
 * itself excluded — the first button already covers it) two per row, then a
 * manual-entry button. `id` is `RU_ZONES`' array index (not a DB id — this
 * codec is only used here for a fixed, in-memory list, which the
 * `callback_data` format's "always an internal id" rule (CLAUDE.md §8) is
 * fine with).
 */
function buildZonePickerButtons(at: Date): Buttons {
  const keep = {
    text: texts.timezone.keepMoscow,
    data: encodeCallback({ entity: 'z', action: 'sel', id: MOSCOW_INDEX }),
  };
  const manual = {
    text: texts.timezone.manualButton,
    data: encodeCallback({ entity: 'z', action: 'man', id: 0 }),
  };

  const grid = RU_ZONES.map((zone, id) => ({ zone, id })).filter(({ zone }) => zone !== 'Europe/Moscow');
  const gridButtons = grid.map(({ zone, id }) => ({
    text: texts.timezone.zoneButtonLabel(zone, zoneLabel(zone, at)),
    data: encodeCallback({ entity: 'z', action: 'sel', id }),
  }));

  const rows: Buttons = [[keep]];
  for (let i = 0; i < gridButtons.length; i += 2) {
    const row = gridButtons.slice(i, i + 2);
    rows.push(row);
  }
  rows.push([manual]);
  return rows;
}

/** Manual-entry loop: keeps asking until `parseZoneInput` resolves the text, per the brief's `/timezone` test case. */
async function readManualZone(conversation: TimezoneConversation, ctx: BotContext): Promise<string> {
  await ctx.reply(texts.timezone.manualPrompt, { parse_mode: 'HTML' });
  for (;;) {
    const textCtx = await conversation.waitFor(':text');
    const parsed = parseZoneInput(textCtx.msg.text);
    if (parsed !== null) return parsed;
    await textCtx.reply(texts.timezone.invalid, { parse_mode: 'HTML' });
  }
}

/** Quick-pick loop: keeps re-showing the keyboard until a valid `v1:z:*` button is tapped (or `texts.timezone.manualButton` hands off to {@link readManualZone}). */
async function pickZone(conversation: TimezoneConversation, ctx: BotContext, at: Date): Promise<string> {
  for (;;) {
    await ctx.reply(texts.timezone.prompt, {
      parse_mode: 'HTML',
      reply_markup: toInlineKeyboard(buildZonePickerButtons(at)),
    });
    const pick = await conversation.waitForCallbackQuery(CALLBACK_RE, {
      otherwise: (otherCtx) => otherCtx.reply(texts.timezone.pickButtonHint, { parse_mode: 'HTML' }),
    });
    await pick.answerCallbackQuery();

    const decoded = decodeCallback(pick.callbackQuery.data);
    if (!decoded) continue;

    if (decoded.action === 'man') return readManualZone(conversation, ctx);

    const zone = RU_ZONES[decoded.id];
    if (zone !== undefined) return zone;
  }
}

function buildTimezoneConversation(db: Db) {
  return async function timezoneConversation(
    conversation: TimezoneConversation,
    ctx: BotContext,
    origin: 'start' | 'timezone',
  ): Promise<void> {
    // `ctx.state` is installed by our own `createContextMiddleware`
    // (`src/bot/middleware/context.ts`), which sits outside the
    // conversations() plugin's own context hydration — it is not present on
    // the context objects a conversation builder receives directly, only on
    // the live "outside" context `conversation.external`'s callback is given
    // (CLAUDE.md §5's pre-verified fact: side effects, including reads of
    // anything outside-middleware-installed, go through `external`).
    const userId = await conversation.external((outsideCtx) => outsideCtx.state.user?.id ?? null);
    if (userId == null) return;

    const at = new Date(await conversation.now());
    const zone = await pickZone(conversation, ctx, at);
    await conversation.external(() => setUserTimezone(db, userId, zone));

    const label = formatZoneLabel(zoneLabel(zone, at));
    await ctx.reply(texts.timezone.saved(label), { parse_mode: 'HTML' });

    if (origin === 'start') {
      const actor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
      await ctx.reply(renderHelp(actor).text, { parse_mode: 'HTML' });
    }
  };
}

/** Registers the `timezone` conversation and the `/timezone` command that enters it (SPEC §7.2). */
export function registerTimezoneConversation(bot: Bot<BotContext>, deps: { db: Db }): void {
  bot.use(
    createConversation(buildTimezoneConversation(deps.db), {
      id: TIMEZONE_CONVERSATION_ID,
      maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS,
    }),
  );

  bot.command('timezone', async (ctx) => {
    await ctx.conversation.enter(TIMEZONE_CONVERSATION_ID, 'timezone');
  });
}
