/**
 * Entry points for `src/bot/conversations/settings.ts`'s two dialogs (plan.md Task 3.11): `/settings`
 * (Owner-only, `settings.manage`) and the `v1:a:ais:0` button on `/admin`'s panel (superadmin-only,
 * `admin.tech` — SPEC §16: only a superadmin may change `ai.*`/`batch.*`, via `/admin`). Mirrors the
 * `admin.ts`/`transfer.ts` split: the panel's own command lives in `admin.ts`, the button it offers is
 * wired up in a separate file.
 */
import type { Bot } from 'grammy';
import { can } from '../../domain/people/permissions.js';
import { texts } from '../texts/ru.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import { ADMIN_SETTINGS_CONVERSATION_ID, SETTINGS_CONVERSATION_ID } from '../conversations/settings.js';
import type { BotContext } from '../context.js';

export function registerSettingsHandlers(bot: Bot<BotContext>): void {
  bot.command('settings', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!can(ctx.state.actor, 'settings.manage')) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    await ctx.conversation.enter(SETTINGS_CONVERSATION_ID);
  });

  bot.callbackQuery(/^v1:a:ais:/, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }
    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (!can(ctx.state.actor, 'admin.tech')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter(ADMIN_SETTINGS_CONVERSATION_ID);
  });
}
