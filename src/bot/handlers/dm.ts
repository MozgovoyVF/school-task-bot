import type { Bot } from 'grammy';
import type { BotContext } from '../context.js';
import { renderStart, renderHelp } from '../views/help.js';

/**
 * `/start`: the very first time a user's `users.timezone` is unset, hands
 * off to the `timezone` conversation (`src/bot/conversations/timezone.ts`,
 * registered in `src/bot/bot.ts`) with `'start'` as its entry argument, so it
 * sends `/help`'s role-based command reference once the zone is saved
 * (SPEC §10.10's first-`/start` flow ends with a brief role-based help).
 * Every later `/start` (zone already set) just re-shows the welcome
 * overview.
 *
 * `/help`: always the role-based command reference, regardless of whether a
 * timezone is set — see `src/bot/views/help.ts`.
 */
export function registerDmHandlers(bot: Bot<BotContext>): void {
  bot.command('start', async (ctx) => {
    if (ctx.state.user && ctx.state.user.timezone === null) {
      await ctx.conversation.enter('timezone', 'start');
      return;
    }
    const view = renderStart(ctx.state.actor);
    await ctx.reply(view.text, { parse_mode: 'HTML' });
  });

  bot.command('help', async (ctx) => {
    const view = renderHelp(ctx.state.actor);
    await ctx.reply(view.text, { parse_mode: 'HTML' });
  });
}
