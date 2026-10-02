import type { Bot } from 'grammy';
import type { Clock } from '../../time/clock.js';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import type { WorkspaceRow } from '../../domain/workspaces/repo.js';
import { aiStats, listRecentBatches } from '../../domain/ai/stats.js';
import { reanalyze } from '../../domain/proposals/queries.js';
import { texts } from '../texts/ru.js';
import type { BotContext } from '../context.js';
import { renderAdminPanel } from '../views/admin.js';
import { renderAdminOwnerCodeButton } from '../views/transfer.js';
import { renderAdminAiSettingsButton } from '../views/settings.js';
import { renderDebugPanel } from '../views/debug.js';
import { toInlineKeyboard } from '../keyboards/build.js';

const DEBUG_BATCH_LIMIT = 10;

export interface AdminHandlersDeps {
  config: Pick<Env, 'GIT_SHA'>;
  clock: Clock;
  db: Db;
  /** For `aiStats`'s day/month cost boundaries, `/debug`'s timestamp display and `reanalyze`'s chat lookup (all workspace-scoped, MVP's single default workspace — SPEC §5.2). */
  workspace: WorkspaceRow;
}

/** `ctx.match`'s free-form argument text, split on whitespace, empty tokens dropped — shared by `/debug`'s optional chat id and `/reanalyze`'s chat id + optional N. */
function splitArgs(match: string): string[] {
  return match.trim().length === 0 ? [] : match.trim().split(/\s+/);
}

/** A positive integer `id`/`N` argument — `null` for anything else (not a base-10 integer, zero, or negative). `callback_data`/command text is never trusted (CLAUDE.md §8), same reasoning as `parseTaskIdArg` in `proposalCallbacks.ts`. */
function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * `/admin`: superadmin-only, shows `GIT_SHA`, elapsed uptime since
 * `startedAt` (a `Date` recorded once, at bot construction — computed via
 * `deps.clock` rather than `process.uptime()` so it stays deterministic
 * under `fixedClock` in tests), and (Task 2.15) `aiStats`' AI-pipeline
 * summary. Also offers `texts.admin.ownerCodeButton`
 * (Task 1.5), which issues a claim code without `/transfer`'s demote/remove choice —
 * handled by the `v1:o:adm:0` callback in `src/bot/handlers/transfer.ts`
 * (registered separately; this file only renders the button).
 *
 * `/testerror`: hidden, superadmin-only diagnostic that always throws. It
 * is deliberately silent for non-superadmins — no reply, no error report —
 * so the command's mere existence isn't discoverable. The thrown error is
 * caught and reported by `src/bot/middleware/errors.ts`, not here.
 *
 * `/debug [chatId]` and `/reanalyze <chatId> [lastN]` (Task 2.15, SPEC
 * §12.2's own rows): both superadmin-only, same as `/admin` — *not*
 * Owner-only, despite this task's own brief text claiming otherwise for
 * `/reanalyze`; SPEC §12.2's command table and the pre-existing
 * `src/bot/commands.ts` (Task 1.11 — `SUPERADMIN_COMMANDS`, not
 * `OWNER_COMMANDS`) both agree it is superadmin-only, so that's what's
 * implemented here (CLAUDE.md's source-of-truth order: SPEC.md outranks a
 * task brief). `chatId` throughout is `chats.id` (the internal id
 * `/debug`'s own output exposes), not the raw Telegram chat id.
 *
 * `/admin`, `/debug` and `/reanalyze` are all DM-only (final Phase 1
 * review's C1 fix): SPEC §12.2 lets only `/privacy` post text in a group.
 */
export function registerAdminHandlers(bot: Bot<BotContext>, deps: AdminHandlersDeps, startedAt: Date): void {
  bot.command('admin', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!ctx.state.actor.isSuperadmin) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const uptimeSec = (deps.clock.now().getTime() - startedAt.getTime()) / 1000;
    const stats = await aiStats(deps.db, { now: deps.clock.now(), tz: deps.workspace.timezone });
    const view = renderAdminPanel({
      gitSha: deps.config.GIT_SHA,
      uptimeSec,
      ai: {
        costToday: stats.costToday,
        costMonth: stats.costMonth,
        last7: stats.last7,
        precision: stats.precision,
      },
    });
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      reply_markup: toInlineKeyboard([...renderAdminOwnerCodeButton(), ...renderAdminAiSettingsButton()]),
    });
  });

  bot.command('testerror', (ctx) => {
    if (!ctx.state.actor.isSuperadmin) return;
    throw new Error('Test error from /testerror');
  });

  bot.command('debug', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!ctx.state.actor.isSuperadmin) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    const [chatIdArg] = splitArgs(ctx.match);
    let chatId: number | undefined;
    if (chatIdArg !== undefined) {
      const parsed = parsePositiveInt(chatIdArg);
      if (parsed === null) {
        await ctx.reply(texts.debug.invalidChatArg, { parse_mode: 'HTML' });
        return;
      }
      chatId = parsed;
    }

    const rows = await listRecentBatches(deps.db, { limit: DEBUG_BATCH_LIMIT, chatId });
    const view = renderDebugPanel(rows, deps.workspace.timezone);
    await ctx.reply(view.text, { parse_mode: 'HTML' });
  });

  bot.command('reanalyze', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!ctx.state.actor.isSuperadmin) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    const [chatIdArg, lastNArg] = splitArgs(ctx.match);
    const chatId = parsePositiveInt(chatIdArg);
    if (chatId === null) {
      await ctx.reply(texts.reanalyze.usage, { parse_mode: 'HTML' });
      return;
    }
    let lastN: number | undefined;
    if (lastNArg !== undefined) {
      const parsed = parsePositiveInt(lastNArg);
      if (parsed === null) {
        await ctx.reply(texts.reanalyze.invalidArgs, { parse_mode: 'HTML' });
        return;
      }
      lastN = parsed;
    }

    const result = await reanalyze({ db: deps.db, clock: deps.clock }, { chatId, lastN });
    if (!result.ok) {
      const text =
        result.reason === 'chat_not_found' ? texts.reanalyze.chatNotFound : texts.reanalyze.noMessages;
      await ctx.reply(text, { parse_mode: 'HTML' });
      return;
    }
    const text =
      result.mode === 'requeued'
        ? texts.reanalyze.requeued(result.batches, result.messages)
        : texts.reanalyze.created(result.messages);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });
}
