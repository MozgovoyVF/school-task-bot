import type { Bot } from 'grammy';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import type { Messenger } from '../../domain/messenger.js';
import type { WorkspaceRow } from '../../domain/workspaces/repo.js';
import { can } from '../../domain/people/permissions.js';
import { getMembershipWithUser, listMembersWithUsers } from '../../domain/people/repo.js';
import { texts } from '../texts/ru.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { renderPeopleList, renderPersonCard, type PeopleView } from '../views/people.js';
import { EDIT_PERSON_CONVERSATION_ID } from '../conversations/editPerson.js';
import type { BotContext } from '../context.js';

export interface PeopleHandlersDeps {
  db: Db;
  messenger: Messenger;
  clock: Clock;
  workspace: WorkspaceRow;
}

/** Redraws the message a `v1:u:*` callback came from with `view`. A no-op if the callback carries no `message` (e.g. a very old keyboard). */
async function renderInto(deps: PeopleHandlersDeps, ctx: BotContext, view: PeopleView): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  await deps.messenger.edit(msg.chat.id, msg.message_id, view.text, { buttons: view.buttons });
}

/** `callback_data` actions this handler owns (`/people`'s list/card, Task 1.10). */
const KNOWN_ACTIONS = new Set(['lst', 'opn', 'edt']);

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

    // 'edt': hand off to editPerson.ts's dialog — it re-checks `people.manage` itself before doing anything.
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter(EDIT_PERSON_CONVERSATION_ID, decoded.id);
  });
}
