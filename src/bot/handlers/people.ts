import type { Bot } from 'grammy';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import type { Logger } from '../../ops/logger.js';
import type { Env } from '../../config/env.js';
import type { Messenger } from '../../domain/messenger.js';
import type { Buttons } from '../../domain/messenger.js';
import type { WorkspaceRow } from '../../domain/workspaces/repo.js';
import { can } from '../../domain/people/permissions.js';
import { getMembershipWithUser, listMembersWithUsers } from '../../domain/people/repo.js';
import { eraseMember, EraseMemberError } from '../../domain/people/erase.js';
import { texts } from '../texts/ru.js';
import { decodeCallback, encodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { escapeHtml } from '../views/escape.js';
import { renderPeopleList, renderPersonCard, type PeopleView } from '../views/people.js';
import { EDIT_PERSON_CONVERSATION_ID } from '../conversations/editPerson.js';
import type { BotContext } from '../context.js';

export interface PeopleHandlersDeps {
  db: Db;
  messenger: Messenger;
  clock: Clock;
  logger: Logger;
  workspace: WorkspaceRow;
  /** Only `SUPERADMIN_TG_IDS` is needed — `eraseMember`'s own "don't delete a superadmin's `users` row" check (`src/domain/people/erase.ts`). */
  config: Pick<Env, 'SUPERADMIN_TG_IDS'>;
}

/** Redraws the message a `v1:u:*` callback came from with `view`. A no-op if the callback carries no `message` (e.g. a very old keyboard). */
async function renderInto(deps: PeopleHandlersDeps, ctx: BotContext, view: PeopleView): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  await deps.messenger.edit(msg.chat.id, msg.message_id, view.text, { buttons: view.buttons });
}

/**
 * `callback_data` actions this handler owns (`/people`'s list/card, Task
 * 1.10; the "delete data" double-confirmation flow, Task 3.12): `era` → first
 * confirm screen, `erb` → second confirm screen, `erc` → the actual
 * `eraseMember` call — same three-step shape as `taskCallbacks.ts`'s
 * `del`/`dla`/`dlb` delete-forever flow (SPEC §12.4 "double confirmation").
 */
const KNOWN_ACTIONS = new Set(['lst', 'opn', 'edt', 'era', 'erb', 'erc']);

function eraseConfirm1Buttons(membershipId: number): Buttons {
  return [
    [
      {
        text: texts.erase.confirmButton,
        data: encodeCallback({ entity: 'u', action: 'erb', id: membershipId }),
      },
      {
        text: texts.erase.cancelButton,
        data: encodeCallback({ entity: 'u', action: 'opn', id: membershipId }),
      },
    ],
  ];
}

function eraseConfirm2Buttons(membershipId: number): Buttons {
  return [
    [
      {
        text: texts.erase.confirmForeverButton,
        data: encodeCallback({ entity: 'u', action: 'erc', id: membershipId }),
      },
      {
        text: texts.erase.cancelButton,
        data: encodeCallback({ entity: 'u', action: 'opn', id: membershipId }),
      },
    ],
  ];
}

/**
 * Registers `/people` (SPEC §12.2: Owner only — `people.manage`, a fresh
 * Action distinct from `chat.manage`/`chat.approve`, plan.md's precedent for
 * an Owner-only action added on top of SPEC §3's own matrix) and the
 * `v1:u:*` callbacks its list/card keyboards use. DM-only, same reasoning
 * as `/chats` (`chats.ts`): the list would leak every member's name/aliases
 * into a group otherwise.
 *
 * `people.manage` is checked once, immediately after decoding and before
 * *any* branch — including the read-only `lst`/`opn` navigation actions,
 * not only `edt` — since CLAUDE.md §8 requires a DB-backed permission check
 * on every callback and `callback_data` is never trusted on its own (the
 * exact class of bug plan.md's Task 1.9 review caught and fixed: three of
 * that task's eight callback branches had originally skipped this check).
 * `editPerson.ts`'s conversation re-checks `people.manage` again on its own,
 * independently of this handler's check before `ctx.conversation.enter`.
 */
export function registerPeopleHandlers(bot: Bot<BotContext>, deps: PeopleHandlersDeps): void {
  bot.command('people', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!can(ctx.state.actor, 'people.manage')) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    const rows = await listMembersWithUsers(deps.db, deps.workspace.id);
    const view = renderPeopleList(rows, deps.workspace, deps.clock.now());
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      ...(view.buttons.length > 0 ? { reply_markup: toInlineKeyboard(view.buttons) } : {}),
    });
  });

  bot.callbackQuery(/^v1:u:/, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded || !KNOWN_ACTIONS.has(decoded.action)) {
      await next();
      return;
    }

    if (!can(ctx.state.actor, 'people.manage')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }

    if (decoded.action === 'lst') {
      const rows = await listMembersWithUsers(deps.db, deps.workspace.id);
      await ctx.answerCallbackQuery();
      await renderInto(deps, ctx, renderPeopleList(rows, deps.workspace, deps.clock.now()));
      return;
    }

    const row = await getMembershipWithUser(deps.db, decoded.id);
    if (!row || row.membership.workspaceId !== deps.workspace.id) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (decoded.action === 'opn') {
      await ctx.answerCallbackQuery();
      await renderInto(deps, ctx, renderPersonCard(row, deps.workspace, deps.clock.now()));
      return;
    }

    if (decoded.action === 'era') {
      // The Owner-can't-erase-themselves rule (`eraseMember`'s `'owner_must_transfer'`) is checked here
      // too, ahead of the confirmation screens, so tapping the button on the Owner's own card goes
      // straight to the explanatory toast instead of walking through two confirmations for an action
      // that can never succeed.
      if (row.membership.role === 'owner') {
        await ctx.answerCallbackQuery({ text: texts.erase.ownerMustTransfer });
        return;
      }
      await ctx.answerCallbackQuery();
      await renderInto(deps, ctx, {
        text: texts.erase.memberConfirm1(escapeHtml(row.membership.displayName)),
        buttons: eraseConfirm1Buttons(decoded.id),
      });
      return;
    }

    if (decoded.action === 'erb') {
      if (row.membership.role === 'owner') {
        await ctx.answerCallbackQuery({ text: texts.erase.ownerMustTransfer });
        return;
      }
      await ctx.answerCallbackQuery();
      await renderInto(deps, ctx, {
        text: texts.erase.memberConfirm2,
        buttons: eraseConfirm2Buttons(decoded.id),
      });
      return;
    }

    if (decoded.action === 'erc') {
      try {
        const result = await eraseMember(
          { db: deps.db, logger: deps.logger, superadminIds: deps.config.SUPERADMIN_TG_IDS },
          { workspaceId: deps.workspace.id, userId: row.user.id, actor: ctx.state.actor },
        );
        await ctx.answerCallbackQuery();
        const rows = await listMembersWithUsers(deps.db, deps.workspace.id);
        await renderInto(deps, ctx, {
          text: texts.erase.memberDone(result.messages, result.tasksAnonymized),
          buttons: renderPeopleList(rows, deps.workspace, deps.clock.now()).buttons,
        });
      } catch (err) {
        if (!(err instanceof EraseMemberError)) throw err;
        const text =
          err.reason === 'owner_must_transfer'
            ? texts.erase.ownerMustTransfer
            : err.reason === 'forbidden'
              ? texts.common.forbidden
              : texts.erase.memberNotFound;
        await ctx.answerCallbackQuery({ text });
        const rows = await listMembersWithUsers(deps.db, deps.workspace.id);
        await renderInto(deps, ctx, renderPeopleList(rows, deps.workspace, deps.clock.now()));
      }
      return;
    }

    // 'edt': hand off to editPerson.ts's dialog — it re-checks `people.manage` itself before doing anything.
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter(EDIT_PERSON_CONVERSATION_ID, decoded.id);
  });
}
