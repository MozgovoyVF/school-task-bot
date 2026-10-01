import type { Bot } from 'grammy';
import type { BotContext } from '../context.js';
import { texts } from '../texts/ru.js';
import { can } from '../../domain/people/permissions.js';

/**
 * DM-only "coming in a future update" replies for every `OWNER_COMMANDS` (`src/bot/commands.ts`) menu
 * command Phase 3 doesn't implement yet. Without a handler, `bot.command()` finds nothing to run and the
 * bot stays silent — found on dev acceptance testing of v0.3.0-rc.1 (`/tasks` did nothing). Each of these
 * gets its own real handler in Phase 3 (`src/bot/handlers/lists.ts` for `/tasks`/`/today`/`/overdue`/
 * `/archive`, landed in Task 3.7 — removed from `STUB_COMMANDS` below accordingly; `search.ts`/`stats.ts`
 * per Task 3.8, `settings.ts` per Task 3.11, and Task 3.10's manual-creation handler for `/new`) — this
 * file, and `STUB_COMMANDS` below, is meant to shrink command-by-command as those land, not grow.
 *
 * Every one of these is an `OWNER_COMMANDS`-only row (SPEC §12.2) — gated the same way
 * `registerInboxHandlers`'s `/inbox` gates `proposal.receive`: `can(ctx.state.actor, 'task.viewAll')`
 * (review round 1, I1 — the initial version replied to anyone who typed the command, Owner or not,
 * leaking "this is a real, if unfinished, feature" to a stranger/Member). `task.viewAll` is `isOwner`-only
 * in `permissions.ts`, same as every other action these commands will eventually use once Phase 3 gives
 * each its own real (and more specific) permission check — this stub only needs "Owner, not anyone else".
 *
 * Group-chat behaviour is untouched (CLAUDE.md: commands in groups must not start dialogs) — every handler
 * below returns immediately outside a private chat, the same gate `registerInboxHandlers`'s `/inbox` and
 * `registerDmHandlers`'s `/start`/`/help` use, so a group's own message-intake handling
 * (`registerGroupHandlers`) is unaffected. Must be registered in `src/bot/bot.ts` *before*
 * `registerGroupHandlers`, same as `/privacy`/`/inbox` — see that file's own comment for why: its
 * `bot.on('message', ...)` matches every chat type and returns early (no `next()`) for a non-group one,
 * which would otherwise swallow the DM update before a handler registered after it ever ran.
 */
const STUB_COMMANDS = ['new', 'search', 'stats', 'settings'] as const;

export function registerStubCommandHandlers(bot: Bot<BotContext>): void {
  for (const command of STUB_COMMANDS) {
    bot.command(command, async (ctx) => {
      if (ctx.chat?.type !== 'private') return;
      if (!can(ctx.state.actor, 'task.viewAll')) {
        await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
        return;
      }
      await ctx.reply(texts.common.comingSoon, { parse_mode: 'HTML' });
    });
  }
}
