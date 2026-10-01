import type { Bot } from 'grammy';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import type { Messenger } from '../../domain/messenger.js';
import type { WorkspaceRow } from '../../domain/workspaces/repo.js';
import { can } from '../../domain/people/permissions.js';
import { taskStats } from '../../domain/tasks/stats.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { renderStats, STATS_PERIODS, type StatsPeriod, type StatsRender } from '../views/stats.js';
import { texts } from '../texts/ru.js';
import type { BotContext } from '../context.js';

/** The subset of `AppDeps` this handler needs — mirrors `src/bot/handlers/lists.ts`'s own
 * `ListHandlersDeps` precedent. */
export interface StatsHandlersDeps {
  db: Db;
  clock: Clock;
  messenger: Messenger;
  workspace: WorkspaceRow;
}

const DEFAULT_PERIOD_DAYS: StatsPeriod = 30;

/** `v1:s:per:*`'s own `arg` — any value other than `'7'|'30'|'90'` (a stale/forged callback) falls back to
 * {@link DEFAULT_PERIOD_DAYS}, same "never trust callback_data" stance CLAUDE.md §8 requires. */
function parsePeriod(arg: string | undefined): StatsPeriod {
  const n = Number(arg);
  const match = STATS_PERIODS.find((p) => p === n);
  return match ?? DEFAULT_PERIOD_DAYS;
}

async function buildView(deps: StatsHandlersDeps, periodDays: StatsPeriod, now: Date): Promise<StatsRender> {
  const rows = await taskStats(deps.db, { workspaceId: deps.workspace.id, periodDays, now });
  return renderStats(rows, periodDays);
}

/**
 * Registers `/stats` (plan.md Task 3.8, SPEC §12.5, Owner only — D40, `task.viewAll`) and its own
 * `v1:s:per:*` period-switch callback (entity `'s'`, shared with `src/bot/handlers/search.ts`'s `v1:s:pg:*`
 * pagination callback — the two are told apart by `action`; each handler ignores the other's action and
 * calls `next()`, same multi-action-per-entity convention `src/bot/handlers/lists.ts` already uses).
 * DM-only, same reasoning as `/tasks`/`/people`/`/chats` — stats about specific staff members would
 * otherwise leak into a group chat.
 */
export function registerStatsHandlers(bot: Bot<BotContext>, deps: StatsHandlersDeps): void {
  bot.command('stats', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!can(ctx.state.actor, 'task.viewAll')) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    if (ctx.state.workspace === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    const view = await buildView(deps, DEFAULT_PERIOD_DAYS, deps.clock.now());
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      ...(view.buttons.length > 0 ? { reply_markup: toInlineKeyboard(view.buttons) } : {}),
    });
  });

  bot.callbackQuery(/^v1:s:/, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded || decoded.action !== 'per') {
      await next();
      return;
    }

    if (!can(ctx.state.actor, 'task.viewAll')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }
    if (ctx.state.workspace === null) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }

    const periodDays = parsePeriod(decoded.arg);
    const view = await buildView(deps, periodDays, deps.clock.now());
    await ctx.answerCallbackQuery();

    const msg = ctx.callbackQuery.message;
    if (!msg) return;
    await deps.messenger.edit(msg.chat.id, msg.message_id, view.text, { buttons: view.buttons });
  });
}
