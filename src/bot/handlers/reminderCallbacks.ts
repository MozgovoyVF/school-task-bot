import type { Bot } from 'grammy';
import type { AppDeps } from '../../deps.js';
import type { Buttons } from '../../domain/messenger.js';
import { can } from '../../domain/people/permissions.js';
import { createTaskService } from '../../domain/tasks/service.js';
import { getTaskListItem } from '../../domain/tasks/queries.js';
import { getSettings } from '../../domain/workspaces/repo.js';
import {
  snoozeFireAt,
  createSnooze,
  SnoozeOptionSchema,
  type SnoozeOption,
} from '../../domain/notifications/snooze.js';
import { userZone } from '../../time/zones.js';
import { formatDue } from '../../time/format.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import { renderSnoozeMenu } from '../views/reminder.js';
import { escapeHtml } from '../views/escape.js';
import { texts } from '../texts/ru.js';
import type { BotContext } from '../context.js';

/** The subset of `AppDeps` this handler needs — mirrors `src/domain/proposals/decide.ts`'s `DecideDeps`
 * precedent (`src/bot/bot.ts`'s `BotDeps`, plan.md D34, is what actually gets passed in). */
export type ReminderCallbackDeps = Pick<
  AppDeps,
  'db' | 'clock' | 'config' | 'messenger' | 'logger' | 'workspace' | 'taskHooks'
>;

/** `callback_data` actions this handler owns (SPEC §13.3's 4 main reminder buttons, `src/bot/views/
 * reminder.ts`'s `buttonsFor`, plus the picker submenu's own `snz`). `inp` (the submenu's own
 * `texts.reminders.pickEnterButton` free-text button) is a forward reference to `src/bot/conversations/
 * snoozeInput.ts`'s own conversation-entry callback —
 * registered separately, before this handler (`src/bot/bot.ts`), mirroring `editProposal.ts`'s `edt`
 * callback relative to `proposalCallbacks.ts`'s own `KNOWN_ACTIONS` (which likewise never lists `edt`) —
 * not handled here, falls through to `next()`. */
const KNOWN_ACTIONS = new Set(['done', 'hour', 'tmrw', 'pick', 'snz']);

/** Mirrors `src/scheduler/jobs/notify.ts`'s own local `CLOSED_TASK_STATUSES` (not exported from there,
 * same module-local convention `src/domain/notifications/plan.ts`'s `CLOSED_STATUSES` also follows). */
const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled']);

/** Redraws the reminder DM a `v1:n:*` callback came from — mirrors `src/bot/handlers/proposalCallbacks.ts`'s
 * own `editCard` helper (same no-op-if-no-`message` reasoning). */
async function editReminder(
  deps: ReminderCallbackDeps,
  ctx: BotContext,
  text: string,
  buttons: Buttons = [],
): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  await deps.messenger.edit(msg.chat.id, msg.message_id, text, { buttons });
}

/**
 * Registers the `v1:n:*` reminder-button callbacks (plan.md Task 3.4, SPEC §13.3): `done` (marks the task
 * done — `TaskService.setStatus` runs `remindersHook` automatically, which cancels every still-scheduled
 * reminder for the task, including any snooze already queued), `hour`/`tmrw` (the two fixed snooze
 * shortcuts), `pick` (opens `src/bot/views/reminder.ts`'s `renderSnoozeMenu` submenu — three fixed options
 * plus a free-text entry — redrawing this same message — mirrors `proposalCallbacks.ts`'s `dup` button
 * opening its own submenu the same way), and `snz` (the submenu's three fixed options).
 *
 * `reminders.receive` (checked with no `target` — D40 means only the Owner is ever a real recipient, so
 * `can()`'s `isOwner` branch always short-circuits before needing one; a forged/forwarded callback from a
 * Member correctly falls through to the Member branch, which needs a target it doesn't have here, and
 * returns `false`) is checked once, immediately after decoding and before any branch — `callback_data` is
 * never trusted (CLAUDE.md §8).
 */
export function registerReminderCallbackHandlers(bot: Bot<BotContext>, deps: ReminderCallbackDeps): void {
  bot.callbackQuery(/^v1:n:/, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded || !KNOWN_ACTIONS.has(decoded.action)) {
      await next();
      return;
    }

    if (!can(ctx.state.actor, 'reminders.receive')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }
    const recipientUserId = ctx.state.actor.userId;
    if (recipientUserId === null) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }

    const taskId = decoded.id;
    const item = await getTaskListItem(deps.db, taskId);
    if (item === null || CLOSED_TASK_STATUSES.has(item.status)) {
      await ctx.answerCallbackQuery({ text: texts.reminders.taskGone });
      return;
    }

    if (decoded.action === 'pick') {
      await ctx.answerCallbackQuery();
      const view = renderSnoozeMenu(taskId);
      await editReminder(deps, ctx, view.text, view.buttons);
      return;
    }

    if (decoded.action === 'done') {
      const service = createTaskService(deps);
      const updated = await deps.db.transaction((tx) =>
        service.setStatus(tx, taskId, 'done', { type: 'user', userId: recipientUserId }),
      );
      await ctx.answerCallbackQuery();
      await editReminder(deps, ctx, texts.reminders.doneConfirm(updated.id, escapeHtml(updated.title)));
      return;
    }

    // 'hour' | 'tmrw' | 'snz' — a snooze option. `callback_data`'s `arg` is untrusted (CLAUDE.md §8), so
    // `snz`'s is validated against `SnoozeOptionSchema` before use; `hour`/`tmrw` carry no `arg` at all
    // (`src/bot/views/reminder.ts`'s `buttonsFor`), their option is implied by the action itself.
    let option: SnoozeOption;
    if (decoded.action === 'hour') {
      option = '1h';
    } else if (decoded.action === 'tmrw') {
      option = 'tomorrow';
    } else {
      const parsed = SnoozeOptionSchema.safeParse(decoded.arg);
      if (!parsed.success) {
        await ctx.answerCallbackQuery();
        return;
      }
      option = parsed.data;
    }

    const user = ctx.state.user;
    const workspace = ctx.state.workspace;
    if (user === null || workspace === null) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }
    const zone = userZone(user, workspace);
    const now = deps.clock.now();
    const settings = await getSettings(deps.db, workspace.id);
    const fireAt = snoozeFireAt(option, now, zone, settings.reminders);
    if (fireAt === null) {
      await ctx.answerCallbackQuery({ text: texts.reminders.snoozeUnavailable });
      return;
    }

    await deps.db.transaction((tx) =>
      createSnooze(tx, { taskId, recipientUserId, fireAt, workspaceId: workspace.id }),
    );

    await ctx.answerCallbackQuery();
    const label = texts.formatDue(formatDue({ at: fireAt, allDay: false, tz: null }, zone));
    await editReminder(deps, ctx, texts.reminders.snoozeConfirm(label));
  });
}
