import type { Bot } from 'grammy';
import type { Clock } from '../../time/clock.js';
import type { Env } from '../../config/env.js';
import { texts } from '../texts/ru.js';
import type { BotContext } from '../context.js';
import { renderAdminPanel } from '../views/admin.js';

export interface AdminHandlersDeps {
  config: Pick<Env, 'GIT_SHA'>;
  clock: Clock;
}

/**
 * `/admin`: superadmin-only, shows `GIT_SHA` and elapsed uptime since
 * `startedAt` (a `Date` recorded once, at bot construction — computed via
 * `deps.clock` rather than `process.uptime()` so it stays deterministic
 * under `fixedClock` in tests).
 *
 * `/testerror`: hidden, superadmin-only diagnostic that always throws; no
 * buttons because the callback_data codec doesn't exist until Task 1.3. It
 * is deliberately silent for non-superadmins — no reply, no error report —
 * so the command's mere existence isn't discoverable. The thrown error is
 * caught and reported by `src/bot/middleware/errors.ts`, not here.
 */
export function registerAdminHandlers(bot: Bot<BotContext>, deps: AdminHandlersDeps, startedAt: Date): void {
  bot.command('admin', async (ctx) => {
    if (!ctx.state.actor.isSuperadmin) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const uptimeSec = (deps.clock.now().getTime() - startedAt.getTime()) / 1000;
    const view = renderAdminPanel({ gitSha: deps.config.GIT_SHA, uptimeSec });
    await ctx.reply(view.text, { parse_mode: 'HTML' });
  });

  bot.command('testerror', (ctx) => {
    if (!ctx.state.actor.isSuperadmin) return;
    throw new Error('Test error from /testerror');
  });
}
