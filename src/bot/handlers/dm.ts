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
 *
 * Both are DM-only (final Phase 1 review's C1 fix): SPEC §12.2 lets only
 * `/privacy` post text in a group, and `/start` in particular can start the
 * `timezone` conversation — letting it run in a group would leave an active
 * dialog there, swallowing every later group message (including ordinary
 * ones from other members, not saved) for up to `CONVERSATION_TIMEOUT_MS`.
 */
export function registerDmHandlers(bot: Bot<BotContext>): void {
  bot.command('start', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (ctx.state.user && ctx.state.user.timezone === null) {
      await ctx.conversation.enter('timezone', 'start');
      return;
    }
    const view = renderStart(ctx.state.actor);
    await ctx.reply(view.text, { parse_mode: 'HTML' });
  });

  bot.command('help', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const view = renderHelp(ctx.state.actor);
    await ctx.reply(view.text, { parse_mode: 'HTML' });
  });
}
