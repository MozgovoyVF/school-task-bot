import type { Bot } from 'grammy';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import type { Logger } from '../../ops/logger.js';
import type { Env } from '../../config/env.js';
import type { Messenger } from '../../domain/messenger.js';
import { can } from '../../domain/people/permissions.js';
import {
  createClaimCode,
  normalizeClaimCode,
  redeemClaimCode,
  type PreviousOwnerAction,
} from '../../domain/people/claim.js';
import { afterOwnerChanged } from '../../domain/people/ownerChanged.js';
import { texts } from '../texts/ru.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { renderTransferPrompt, renderTransferCode } from '../views/transfer.js';
import type { BotContext } from '../context.js';

export interface TransferHandlersDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  messenger: Messenger;
  /** Only `SUPERADMIN_TG_IDS` is needed — forwarded to `afterOwnerChanged`'s `syncCommands` call (Task 1.11). */
  config: Pick<Env, 'SUPERADMIN_TG_IDS'>;
}

/**
 * Maps a `v1:o:<action>:0` callback's `action` to the `previousOwnerAction`
 * it issues a claim code with. `dem`/`rem` are `/transfer`'s own two-button
 * choice (`src/bot/views/transfer.ts`); `adm` is `/admin`'s single
 * `texts.admin.ownerCodeButton` button (`src/bot/handlers/admin.ts`) — it skips that choice
 * (mainly meant for the empty-workspace bootstrap case, SPEC §10, where
 * there is no current owner for the choice to matter to) and always issues
 * `demote`, the less destructive default.
 */
const ACTION_TO_PREVIOUS_OWNER_ACTION: Partial<Record<string, PreviousOwnerAction>> = {
  dem: 'demote',
  rem: 'remove',
  adm: 'demote',
};

/**
 * Registers `/transfer` (owner or superadmin — generates a one-time claim
 * code), the `v1:o:*` callback it hands off to (also reached from `/admin`'s
 * owner-code button), and `/claim <code>` (anyone, DM only — SPEC §12.2's
 * `/claim` row; a group/supergroup update is silently ignored, matching
 * `/testerror`'s silent-for-the-wrong-audience pattern in `admin.ts`).
 *
 * Both `/transfer` and its `v1:o:*` callback (which is where the code is
 * actually generated and posted, including from `/admin`'s owner-code
 * button) are DM-only too (plan.md D42): a claim code is a plaintext
 * bearer secret for the whole workspace, and posting it into a group would
 * let any member race the intended recipient to `/claim` it in DM. This
 * also keeps SPEC §12.2's rule that `/privacy` is the only command the bot
 * answers with text in a group. Non-private updates are silently ignored,
 * same as `/claim`'s own group handling.
 *
 * Permission (`transfer.generate`) is (re)checked on both the command and
 * the callback — CLAUDE.md §8: callback_data is never trusted on its own.
 */
export function registerTransferHandlers(bot: Bot<BotContext>, deps: TransferHandlersDeps): void {
  bot.command('transfer', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!can(ctx.state.actor, 'transfer.generate')) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const view = renderTransferPrompt();
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
  });

  bot.callbackQuery(/^v1:o:/, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }
    const decoded = decodeCallback(ctx.callbackQuery.data);
    const previousOwnerAction = decoded ? ACTION_TO_PREVIOUS_OWNER_ACTION[decoded.action] : undefined;
    if (!decoded || previousOwnerAction === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (
      !can(ctx.state.actor, 'transfer.generate') ||
      ctx.state.workspace === null ||
      ctx.state.user === null
    ) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }
    await ctx.answerCallbackQuery();

    const { code } = await createClaimCode(deps.db, {
      workspaceId: ctx.state.workspace.id,
      createdByUserId: ctx.state.user.id,
      previousOwnerAction,
      now: deps.clock.now(),
    });

    const view = renderTransferCode(code);
    await ctx.reply(view.text, { parse_mode: 'HTML' });
  });

  bot.command('claim', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (ctx.state.user === null) return;

    const codeArg = ctx.match.trim();
    if (codeArg === '') {
      await ctx.reply(texts.claim.usage, { parse_mode: 'HTML' });
      return;
    }

    const result = await redeemClaimCode(deps.db, {
      code: normalizeClaimCode(codeArg),
      userId: ctx.state.user.id,
      now: deps.clock.now(),
    });

    if (!result.ok) {
      const text =
        result.reason === 'expired'
          ? texts.claim.expired
          : result.reason === 'used'
            ? texts.claim.used
            : texts.claim.invalid;
      await ctx.reply(text, { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply(texts.claim.success, { parse_mode: 'HTML' });
    await afterOwnerChanged(
      {
        db: deps.db,
        logger: deps.logger,
        messenger: deps.messenger,
        clock: deps.clock,
        api: ctx.api,
        superadminIds: deps.config.SUPERADMIN_TG_IDS,
      },
      result.workspaceId,
    );
  });
}
