import type { Bot } from 'grammy';
import type { BotContext } from '../context.js';
import { renderHelp } from '../views/help.js';

/**
 * `/start` and `/help`: both just render the same overview (phase 0 has no
 * owner/member concept yet — see `src/bot/context.ts` — so the only
 * distinction is superadmin vs. everyone else).
 */
export function registerDmHandlers(bot: Bot<BotContext>): void {
  bot.command(['start', 'help'], async (ctx) => {
    const view = renderHelp(ctx.state.actor);
    await ctx.reply(view.text, { parse_mode: 'HTML' });
  });
}
