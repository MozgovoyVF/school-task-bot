import type { Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Clock } from '../../time/clock.js';
import type { Messenger, Buttons } from '../../domain/messenger.js';
import type { WorkspaceRow } from '../../domain/workspaces/repo.js';
import { chats } from '../../db/schema/index.js';
import { can } from '../../domain/people/permissions.js';
import { listMembersWithUsers } from '../../domain/people/repo.js';
import { listChatsForWorkspace } from '../../domain/chats/repo.js';
import {
  listTasks,
  getTaskCardData,
  resolveAssigneeDisplayName,
  type ListFilter,
  type ListTasksResult,
  type TaskCardData,
} from '../../domain/tasks/queries.js';
import { userZone } from '../../time/zones.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import {
  renderTaskList,
  renderAssigneePicker,
  renderChatPicker,
  type TaskListArgs,
} from '../views/taskList.js';
import { renderTaskCard, type TaskCardView } from '../views/taskCard.js';
import { escapeHtml } from '../views/escape.js';
import { texts } from '../texts/ru.js';
import type { BotContext } from '../context.js';

/** The subset of `AppDeps` this handler needs — mirrors `src/bot/handlers/taskCallbacks.ts`'s own
 * `TaskCallbackDeps` precedent. */
export interface ListHandlersDeps {
  db: Db;
  clock: Clock;
  messenger: Messenger;
  workspace: WorkspaceRow;
}

interface SimpleRender {
  text: string;
  buttons: Buttons;
}

/** `callback_data` actions this handler owns (plan.md Task 3.7, entity `'l'`): the eight `ListFilter`
 * kinds (`all|tod|ovd|nod|asg|cht|arc|tov`, the brief's own callback scheme), `opn` (open a row's task
 * card — reuses Task 3.6's `getTaskCardData`/`renderTaskCard` directly, per the brief), and `asm`/`csm`
 * (open the assignee/chat picker submenu). */
const KNOWN_ACTIONS = new Set(['all', 'tod', 'ovd', 'nod', 'asg', 'cht', 'arc', 'tov', 'opn', 'asm', 'csm']);

/** Mirrors `src/bot/handlers/taskCallbacks.ts`'s own private `toCardView` — duplicated rather than
 * exported from that already-shipped file (brief: reuse `getTaskCardData`/`renderTaskCard` directly
 * inside this handler instead of touching Task 3.6's file). */
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

/** Redraws the message a `v1:l:*` callback came from — a no-op if the callback carries no `message` (e.g.
 * a very old keyboard), same convention `taskCallbacks.ts`/`people.ts`/`inbox.ts` already use for their
 * own `editMessage`/`renderInto`. */
async function renderInto(deps: ListHandlersDeps, ctx: BotContext, view: SimpleRender): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  await deps.messenger.edit(msg.chat.id, msg.message_id, view.text, { buttons: view.buttons });
}

/** The assignee/chat filters' own header line needs an already-HTML-escaped display label — `undefined`
 * for every other filter kind (`renderTaskList` only reads `label` for those two). */
async function resolveLabel(deps: ListHandlersDeps, filter: ListFilter): Promise<string | undefined> {
  if (filter.kind === 'assignee') {
    if (filter.userId === 'all') return escapeHtml(texts.proposalCard.assigneeAll);
    if (filter.userId === 'none') return escapeHtml(texts.proposalCard.assigneeNone);
    const name = await resolveAssigneeDisplayName(deps.db, deps.workspace.id, filter.userId);
    return escapeHtml(name ?? texts.proposalCard.assigneeNone);
  }
  if (filter.kind === 'chat') {
    const [row] = await deps.db
      .select({ title: chats.title })
      .from(chats)
      .where(eq(chats.id, filter.chatId))
      .limit(1);
    return escapeHtml(row?.title ?? texts.taskList.chatUntitled);
  }
  return undefined;
}

/** Loads `filter`'s page and renders it — `page` is clamped into `listTasks`' own `[1, result.pages]`
 * before being handed to `renderTaskList`, so the footer/pagination row always reflects the page that was
 * actually fetched (not a stale/forged one from a shrunk list). */
async function buildView(
  deps: ListHandlersDeps,
  filter: ListFilter,
  page: number,
  now: Date,
  zone: string,
): Promise<SimpleRender> {
  const result: ListTasksResult = await listTasks(deps.db, {
    workspaceId: deps.workspace.id,
    filter,
    page,
    now,
    zone,
  });
  const viewPage = Math.min(Math.max(1, page), result.pages);
  const label = await resolveLabel(deps, filter);
  const args: TaskListArgs = { filter, page: viewPage, zone, now, ...(label !== undefined ? { label } : {}) };
  return renderTaskList(result, args);
}

function parseAssigneeArg(arg: string | undefined): number | 'none' | 'all' | null {
  if (arg === 'none' || arg === 'all') return arg;
  if (arg === undefined) return null;
  const n = Number(arg);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The seven `ListFilter`-producing actions (every `KNOWN_ACTIONS` entry except `opn`/`asm`/`csm`) — `null`
 * for a malformed/stale `asg`/`cht` (a picker arg that no longer parses, e.g. a very old keyboard). */
function filterFromAction(action: string, arg: string | undefined): ListFilter | null {
  switch (action) {
    case 'all':
      return { kind: 'open' };
    case 'tod':
      return { kind: 'today' };
    case 'ovd':
      return { kind: 'overdue' };
    case 'nod':
      return { kind: 'no_due' };
    case 'arc':
      return { kind: 'archive' };
    case 'tov':
      return { kind: 'today_and_overdue' };
    case 'asg': {
      const userId = parseAssigneeArg(arg);
      return userId === null ? null : { kind: 'assignee', userId };
    }
    case 'cht': {
      if (arg === undefined) return null;
      const chatId = Number(arg);
      return Number.isInteger(chatId) && chatId >= 0 ? { kind: 'chat', chatId } : null;
    }
    default:
      return null;
  }
}

function registerListCommand(
  bot: Bot<BotContext>,
  deps: ListHandlersDeps,
  command: string,
  filter: ListFilter,
): void {
  bot.command(command, async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!can(ctx.state.actor, 'task.viewAll')) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const user = ctx.state.user;
    const workspace = ctx.state.workspace;
    if (user === null || workspace === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const zone = userZone(user, workspace);
    const view = await buildView(deps, filter, 1, deps.clock.now(), zone);
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      ...(view.buttons.length > 0 ? { reply_markup: toInlineKeyboard(view.buttons) } : {}),
    });
  });
}

/**
 * Registers `/tasks`/`/today`/`/overdue`/`/archive` (plan.md Task 3.7, SPEC §12.2/§12.3, Owner only —
 * D40, `task.viewAll`) and the `v1:l:*` callbacks their lists use: the eight `ListFilter` kinds, `opn`
 * (open a row's task card, reusing Task 3.6's `getTaskCardData`/`renderTaskCard` directly), and `asm`/
 * `csm` (the assignee/chat picker submenus). `task.viewAll` is checked once, immediately after decoding
 * and before any branch — including `opn` — same stance `taskCallbacks.ts`/`people.ts` already take:
 * `callback_data` is never trusted (CLAUDE.md §8).
 *
 * DM-only, same reasoning as `/people`/`/chats`: these lists would otherwise leak task titles/assignees
 * into a group chat. Must be registered in `src/bot/bot.ts` *before* `registerGroupHandlers`, same
 * ordering constraint as `/privacy`/`/inbox`/the `STUB_COMMANDS` this task replaces four of (see
 * `stubs.ts`'s own doc comment for why).
 */
export function registerListHandlers(bot: Bot<BotContext>, deps: ListHandlersDeps): void {
  registerListCommand(bot, deps, 'tasks', { kind: 'open' });
  registerListCommand(bot, deps, 'today', { kind: 'today_and_overdue' });
  registerListCommand(bot, deps, 'overdue', { kind: 'overdue' });
  registerListCommand(bot, deps, 'archive', { kind: 'archive' });

  bot.callbackQuery(/^v1:l:/, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded || !KNOWN_ACTIONS.has(decoded.action)) {
      await next();
      return;
    }

    if (!can(ctx.state.actor, 'task.viewAll')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }
    const user = ctx.state.user;
    const workspace = ctx.state.workspace;
    if (user === null || workspace === null) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }
    const zone = userZone(user, workspace);
    const now = deps.clock.now();

    if (decoded.action === 'opn') {
      const data = await getTaskCardData(deps.db, decoded.id);
      if (data === null) {
        await ctx.answerCallbackQuery({ text: texts.taskCard.notFound });
        return;
      }
      const rendered = renderTaskCard(toCardView(data), zone);
      await ctx.answerCallbackQuery();
      await renderInto(deps, ctx, rendered);
      return;
    }

    if (decoded.action === 'asm') {
      const members = await listMembersWithUsers(deps.db, deps.workspace.id);
      const options = members.map((m) => ({ userId: m.user.id, name: m.membership.displayName }));
      await ctx.answerCallbackQuery();
      await renderInto(deps, ctx, renderAssigneePicker(options));
      return;
    }

    if (decoded.action === 'csm') {
      const chatRows = await listChatsForWorkspace(deps.db, deps.workspace.id);
      const options = chatRows.map((c) => ({ chatId: c.id, title: c.title ?? texts.taskList.chatUntitled }));
      await ctx.answerCallbackQuery();
      await renderInto(deps, ctx, renderChatPicker(options));
      return;
    }

    const filter = filterFromAction(decoded.action, decoded.arg);
    if (filter === null) {
      await ctx.answerCallbackQuery();
      await renderInto(deps, ctx, await buildView(deps, { kind: 'open' }, 1, now, zone));
      return;
    }

    const view = await buildView(deps, filter, decoded.id, now, zone);
    await ctx.answerCallbackQuery();
    await renderInto(deps, ctx, view);
  });
}
