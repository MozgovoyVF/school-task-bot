import type { MiddlewareFn } from 'grammy';
import type { BotContext } from '../context.js';

/**
 * Wraps `mw` so it only runs for private-chat updates — any other chat type
 * (group/supergroup/channel) skips straight to `next()`, leaving `mw`
 * untouched. Used in `src/bot/bot.ts`/`src/bot/conversations/timezone.ts`/
 * `src/bot/conversations/editPerson.ts` to keep `@grammyjs/conversations`'
 * plugin install (`conversations()`) and every `createConversation(...)`
 * registration scoped to DMs, belt-and-suspenders on top of each entry
 * command's own `ctx.chat?.type !== 'private'` guard (final Phase 1 review's
 * C1 fix): a conversation must never install its controls, start, or resume
 * in a group chat — SPEC §12.2 lets only `/privacy` post text there, and an
 * active conversation swallows every later group message (including
 * ordinary ones from other members) for up to `CONVERSATION_TIMEOUT_MS`,
 * which is exactly the "missed task" failure mode CLAUDE.md calls out as
 * worse than a false alarm.
 *
 * Both `conversations()` and every `createConversation(...)` call must be
 * wrapped together, not just the former: `createConversation(...)`'s
 * middleware throws if `conversations()` did not run first on the same
 * update (`@grammyjs/conversations`' own internal check) — wrapping only
 * `conversations()` would turn that guard into an uncaught throw on every
 * group message instead of a silent skip.
 */
export function privateOnly(mw: MiddlewareFn<BotContext>): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await next();
      return;
    }
    await mw(ctx, next);
  };
}
