import type { Bot } from 'grammy';
import type { AppDeps } from '../../deps.js';
import type { Buttons } from '../../domain/messenger.js';
import { can } from '../../domain/people/permissions.js';
import { listMembersWithUsers } from '../../domain/people/repo.js';
import { createTaskService } from '../../domain/tasks/service.js';
import { getTaskCardData, type TaskCardData } from '../../domain/tasks/queries.js';
import { listTaskEvents, type TaskEventRow } from '../../domain/tasks/events.js';
import { userZone } from '../../time/zones.js';
import { decodeCallback, encodeCallback } from '../keyboards/callbackCodec.js';
import { renderTaskCard, type TaskCardView } from '../views/taskCard.js';
import { renderTaskHistory, type TaskHistoryEventView } from '../views/history.js';
import { escapeHtml } from '../views/escape.js';
import { texts } from '../texts/ru.js';
import type { BotContext } from '../context.js';

/** The subset of `AppDeps` this handler needs — mirrors `src/bot/handlers/reminderCallbacks.ts`'s own
 * `ReminderCallbackDeps` precedent. */
export type TaskCallbackDeps = Pick<
  AppDeps,
  'db' | 'clock' | 'config' | 'messenger' | 'logger' | 'workspace' | 'taskHooks'
>;

/**
 * `callback_data` actions this handler owns (plan.md Task 3.6, SPEC §12.4, entity `'t'`, `id = task.id`):
 * `don`/`prg` (status → `done`/`in_progress`), `cnl`/`rst` (archive/unarchive — `cancel`/`restore`), `his`
 * (history screen), and the "delete forever" three-step flow (`del` → first confirm screen, `dla` →
 * second confirm screen, `dlb` → the actual hard delete — SPEC §12.4's double confirmation: two
 * confirmations *past* the initial `del` press). `bck` returns to the live card from the history screen or
 * either confirm screen. `edt` (the edit button) is a forward reference to
 * `src/bot/conversations/editTask.ts`'s own dialog — not handled here, falls through to `next()`, same
 * pattern `editProposal.ts`'s `edt` follows relative to `proposalCallbacks.ts`'s `KNOWN_ACTIONS`.
 */
const KNOWN_ACTIONS = new Set(['don', 'prg', 'cnl', 'rst', 'his', 'del', 'dla', 'dlb', 'bck']);

const HISTORY_LIMIT = 20;

function isArchived(status: TaskCardData['task']['status']): boolean {
  return status === 'done' || status === 'cancelled';
}

function toCardView(data: TaskCardData): TaskCardView {
  const t = data.task;
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assigneeName: data.assigneeName,
    due: t.dueAt === null ? null : { at: t.dueAt, allDay: t.dueAllDay, tz: t.dueTz },
    quote: t.sourceQuote,
    chatTitle: data.chatTitle,
    link: t.sourceLink,
  };
}

/** `task_events.actor_type === 'user'`'s display name comes from the workspace's own memberships (same
 * `displayName` convention every other card/list uses) — an id that no longer resolves (a removed member)
 * falls back to `texts.taskHistory.actorUnknownUser` rather than showing nothing. `system`/`ai`/`apple` all
 * get a fixed label (brief: "a fixed label otherwise"), never a resolved name. */
function actorLabel(event: TaskEventRow, nameByUserId: ReadonlyMap<number, string>): string {
  switch (event.actorType) {
    case 'user': {
      const name = event.actorUserId === null ? undefined : nameByUserId.get(event.actorUserId);
      return escapeHtml(name ?? texts.taskHistory.actorUnknownUser);
    }
    case 'system':
      return texts.taskHistory.actorSystem;
    case 'ai':
      return texts.taskHistory.actorAi;
    case 'apple':
      return texts.taskHistory.actorApple;
  }
}

/** Redraws the message a `v1:t:*` callback came from — a no-op if the callback carries no `message` (e.g.
 * a very old keyboard), mirrors `proposalCallbacks.ts`'s/`reminderCallbacks.ts`'s own `editCard`/
 * `editReminder` helpers. */
async function editMessage(
  deps: TaskCallbackDeps,
  ctx: BotContext,
  text: string,
  buttons: Buttons = [],
): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  await deps.messenger.edit(msg.chat.id, msg.message_id, text, { buttons });
}

/** Re-fetches the task fresh and redraws the live card — used after every status-changing action, after
 * `bck`, and as the "no-op, just show the current state" fallback when a button is pressed out of its
 * valid state (e.g. a stale "start" press on a task that is already `in_progress`). `taskId` gone by
 * the time this runs (e.g. deleted by a concurrent "delete forever") shows `texts.taskCard.notFound`
 * instead of leaving a dead keyboard behind. */
async function redrawCard(
  deps: TaskCallbackDeps,
  ctx: BotContext,
  taskId: number,
  viewerZone: string,
): Promise<void> {
  const data = await getTaskCardData(deps.db, taskId);
  if (data === null) {
    await editMessage(deps, ctx, texts.taskCard.notFound);
    return;
  }
  const rendered = renderTaskCard(toCardView(data), viewerZone);
  await editMessage(deps, ctx, rendered.text, rendered.buttons);
}

function deleteConfirm1Buttons(taskId: number): Buttons {
  return [
    [
      {
        text: texts.taskCard.deleteConfirmButton,
        data: encodeCallback({ entity: 't', action: 'dla', id: taskId }),
      },
      {
        text: texts.taskCard.deleteCancelButton,
        data: encodeCallback({ entity: 't', action: 'bck', id: taskId }),
      },
    ],
  ];
}

function deleteConfirm2Buttons(taskId: number): Buttons {
  return [
    [
      {
        text: texts.taskCard.deleteForeverConfirmButton,
        data: encodeCallback({ entity: 't', action: 'dlb', id: taskId }),
      },
      {
        text: texts.taskCard.deleteCancelButton,
        data: encodeCallback({ entity: 't', action: 'bck', id: taskId }),
      },
    ],
  ];
}

/**
 * Registers the `v1:t:*` task-card callbacks (plan.md Task 3.6, SPEC §12.4). `task.edit` (Owner only,
 * D40 — no "own task" nuance, unlike `reminders.receive`) is checked once, immediately after decoding and
 * before any branch — `callback_data` is never trusted (CLAUDE.md §8). Every branch below re-reads the
 * task fresh from the DB before acting (`getTaskCardData`, brief scenario 9: a callback
 * referencing an already-deleted task gets `texts.taskCard.notFound`, never a thrown exception).
 */
export function registerTaskCallbackHandlers(bot: Bot<BotContext>, deps: TaskCallbackDeps): void {
  bot.callbackQuery(/^v1:t:/, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded || !KNOWN_ACTIONS.has(decoded.action)) {
      await next();
      return;
    }

    if (!can(ctx.state.actor, 'task.edit')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }
    const actorUserId = ctx.state.actor.userId;
    const user = ctx.state.user;
    const workspace = ctx.state.workspace;
    if (actorUserId === null || user === null || workspace === null) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }
    const zone = userZone(user, workspace);

    const taskId = decoded.id;
    const data = await getTaskCardData(deps.db, taskId);
    if (data === null) {
      await ctx.answerCallbackQuery({ text: texts.taskCard.notFound });
      return;
    }
    const actor = { type: 'user' as const, userId: actorUserId };

    if (decoded.action === 'don') {
      if (isArchived(data.task.status)) {
        await ctx.answerCallbackQuery();
        await redrawCard(deps, ctx, taskId, zone);
        return;
      }
      const service = createTaskService(deps);
      await deps.db.transaction((tx) => service.setStatus(tx, taskId, 'done', actor));
      await ctx.answerCallbackQuery();
      await redrawCard(deps, ctx, taskId, zone);
      return;
    }

    if (decoded.action === 'prg') {
      if (data.task.status !== 'open') {
        await ctx.answerCallbackQuery();
        await redrawCard(deps, ctx, taskId, zone);
        return;
      }
      const service = createTaskService(deps);
      await deps.db.transaction((tx) => service.setStatus(tx, taskId, 'in_progress', actor));
      await ctx.answerCallbackQuery();
      await redrawCard(deps, ctx, taskId, zone);
      return;
    }

    if (decoded.action === 'cnl') {
      if (isArchived(data.task.status)) {
        await ctx.answerCallbackQuery();
        await redrawCard(deps, ctx, taskId, zone);
        return;
      }
      const service = createTaskService(deps);
      await deps.db.transaction((tx) => service.cancel(tx, taskId, actor));
      await ctx.answerCallbackQuery();
      await redrawCard(deps, ctx, taskId, zone);
      return;
    }

    if (decoded.action === 'rst') {
      if (!isArchived(data.task.status)) {
        await ctx.answerCallbackQuery();
        await redrawCard(deps, ctx, taskId, zone);
        return;
      }
      const service = createTaskService(deps);
      await deps.db.transaction((tx) => service.restore(tx, taskId, actor));
      await ctx.answerCallbackQuery();
      await redrawCard(deps, ctx, taskId, zone);
      return;
    }

    if (decoded.action === 'his') {
      const events = await listTaskEvents(deps.db, taskId, HISTORY_LIMIT);
      const members = await listMembersWithUsers(deps.db, deps.workspace.id);
      const nameByUserId = new Map(members.map((m) => [m.user.id, m.membership.displayName]));
      const views: TaskHistoryEventView[] = events.map((e) => ({
        type: e.type,
        actorLabel: actorLabel(e, nameByUserId),
        createdAt: e.createdAt,
      }));
      const rendered = renderTaskHistory(taskId, escapeHtml(data.task.title), views, zone);
      await ctx.answerCallbackQuery();
      await editMessage(deps, ctx, rendered.text, rendered.buttons);
      return;
    }

    if (decoded.action === 'del') {
      if (!isArchived(data.task.status)) {
        await ctx.answerCallbackQuery();
        await redrawCard(deps, ctx, taskId, zone);
        return;
      }
      await ctx.answerCallbackQuery();
      await editMessage(
        deps,
        ctx,
        texts.taskCard.deleteConfirm1(taskId, escapeHtml(data.task.title)),
        deleteConfirm1Buttons(taskId),
      );
      return;
    }

    if (decoded.action === 'dla') {
      if (!isArchived(data.task.status)) {
        await ctx.answerCallbackQuery();
        await redrawCard(deps, ctx, taskId, zone);
        return;
      }
      await ctx.answerCallbackQuery();
      await editMessage(deps, ctx, texts.taskCard.deleteConfirm2, deleteConfirm2Buttons(taskId));
      return;
    }

    if (decoded.action === 'dlb') {
      if (!isArchived(data.task.status)) {
        await ctx.answerCallbackQuery();
        await redrawCard(deps, ctx, taskId, zone);
        return;
      }
      const title = data.task.title;
      const service = createTaskService(deps);
      const deleted = await deps.db.transaction((tx) => service.deleteForever(tx, taskId));
      await ctx.answerCallbackQuery();
      await editMessage(
        deps,
        ctx,
        deleted ? texts.taskCard.deletedConfirm(taskId, escapeHtml(title)) : texts.taskCard.notFound,
      );
      return;
    }

    // decoded.action === 'bck' — back to the live card, from the history screen or either confirm screen.
    await ctx.answerCallbackQuery();
    await redrawCard(deps, ctx, taskId, zone);
  });
}
