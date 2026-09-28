import type { Bot } from 'grammy';
import { texts } from '../texts/ru.js';
import type { BotContext } from '../context.js';

/**
 * `/privacy` (SPEC §12.2: everyone, including in a group) — the one command the bot
 * ever answers with text inside a group (every other group update either
 * stores a message silently or is ignored, per `src/bot/handlers/group.ts`).
 * No permission check: everyone gets the same `texts.privacy.full()` text,
 * in a group and in a DM alike. Registered ahead of
 * `registerGroupHandlers` in `src/bot/bot.ts` — that file's `bot.on('message',
 * ...)` would otherwise be the first middleware to match a `/privacy` group
 * update and swallow it (`normalizeIncoming` drops every command but
 * `/task`), so this command handler must run first to actually reply and
 * stop propagation.
 */
export function registerPrivacyHandlers(bot: Bot<BotContext>): void {
  bot.command('privacy', async (ctx) => {
    await ctx.reply(texts.privacy.full(), { parse_mode: 'HTML' });
  });
}
