/**
 * The task card's "✏️ edit" dialog (plan.md Task 3.6, SPEC §12.4) — edits an *existing* `TaskRow` via
 * `TaskService.update`, as opposed to `src/bot/conversations/editProposal.ts` (Task 2.14), which edits a
 * not-yet-created `ProposalPayload` draft and ends in `acceptProposal`. The two dialogs share the same
 * *shape* (a field menu, assignee/due/priority submenus, free-text date parsing via `parseDateText`) but
 * this file is deliberately self-contained rather than extracted into a shared `editFields.ts`: every one
 * of `editMenu.ts`'s render functions hardcodes `entity: 'p'` in the `callback_data` it builds
 * (`src/bot/views/editMenu.ts`'s own `button()` helper), so reusing them here as-is would encode this
 * dialog's task ids under the *proposal* entity namespace — reusing them safely would require threading an
 * `entity` parameter through `editMenu.ts` and every one of `editProposal.ts`'s call sites, which is exactly
 * the kind of change to already-shipped, already-reviewed code (Task 2.14) this task's brief asked to avoid
 * unless low-risk. This file instead defines its own small, entity-`'t'` menu renders below, reusing only
 * what's genuinely read-only and already proposal-agnostic: `formatAssigneeLabel`/`formatPriorityLabel`/
 * `Priority` from `editMenu.ts`, and every piece of Russian wording from `texts.editProposal`/
 * `texts.taskCard` that isn't actually proposal-specific (field names, submenu titles/buttons, the
 * free-text date prompt/preview — only the save button and menu header get task-specific wording,
 * `texts.taskCard.editSaveButton`/`.editMenuHeader`, since `texts.editProposal.saveButton`'s own wording always implies creating a task, which is wrong for editing one that already exists). `editProposal.ts`/`editMenu.ts`
 * themselves are untouched by this file.
 */
import type { Bot } from 'grammy';
import { createConversation, type Conversation } from '@grammyjs/conversations';
import type { AppDeps } from '../../deps.js';
import type { Buttons } from '../../domain/messenger.js';
import type { AssigneeResolution } from '../../ai/pipeline/resolve.js';
import { can } from '../../domain/people/permissions.js';
import { listMembersWithUsers } from '../../domain/people/repo.js';
import { getTaskById, type TaskRow } from '../../domain/tasks/repo.js';
import { createTaskService, type CreateTaskInput } from '../../domain/tasks/service.js';
import { parseDateText } from '../../ai/pipeline/parseDate.js';
import { quickDue, type QuickDueOption } from '../../time/quickDue.js';
import { formatDue } from '../../time/format.js';
import { userZone } from '../../time/zones.js';
import { CONVERSATION_TIMEOUT_MS } from '../../config/constants.js';
import { texts } from '../texts/ru.js';
import { decodeCallback, encodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { escapeHtml } from '../views/escape.js';
import { formatAssigneeLabel, formatPriorityLabel, type Priority } from '../views/editMenu.js';
import { privateOnly } from '../middleware/privateOnly.js';
import type { BotContext } from '../context.js';

export const EDIT_TASK_CONVERSATION_ID = 'editTask';

type EditTaskConversation = Conversation<BotContext, BotContext>;

/** `src/ai/pipeline/parseDate.ts`'s `ParseDateDeps` plus `TaskService`'s own needs — mirrors
 * `editProposal.ts`'s `EditProposalDeps` precedent (narrowing the brief's literal `deps: AppDeps`). */
export type EditTaskDeps = Pick<
  AppDeps,
  'db' | 'clock' | 'config' | 'messenger' | 'logger' | 'workspace' | 'taskHooks' | 'ai'
>;

type Due = { at: Date | null; allDay: boolean; tz: string | null };

interface Draft {
  title: string;
  assignee: AssigneeResolution;
  due: Due;
  priority: Priority;
  description: string | null;
}

type FieldName = 'title' | 'assignee' | 'due' | 'priority' | 'description';

const CALLBACK_RE = /^v1:t:/;
const MENU_ACTIONS = new Set(['etl', 'eas', 'edu', 'epr', 'edc', 'esv', 'ebk']);
const ASSIGNEE_ACTIONS = new Set(['aus', 'ame', 'ano', 'aal']);
const DUE_ACTIONS = new Set(['dtd', 'dtm', 'dfr', 'dnm', 'dno', 'den']);
const DUE_CONFIRM_ACTIONS = new Set(['dok', 'dca']);
const PRIORITY_ACTIONS = new Set(['plo', 'pno', 'phi']);

const QUICK_DUE_BY_ACTION: Record<string, QuickDueOption> = {
  dtd: 'today',
  dtm: 'tomorrow',
  dfr: 'fri',
  dnm: 'next_mon',
  dno: 'none',
};

/** The inverse of `TaskService`'s own (unexported) `assigneeColumns` — a task row's current assignee. */
function currentAssignee(task: TaskRow): AssigneeResolution {
  if (task.assigneeAll) return { type: 'all' };
  if (task.assigneeUserId !== null) return { type: 'user', userId: task.assigneeUserId };
  if (task.assigneeNameText !== null) return { type: 'text', name: task.assigneeNameText };
  return { type: 'none' };
}

function initialDraft(task: TaskRow): Draft {
  return {
    title: task.title,
    assignee: currentAssignee(task),
    due:
      task.dueAt === null
        ? { at: null, allDay: false, tz: null }
        : { at: task.dueAt, allDay: task.dueAllDay, tz: task.dueTz },
    priority: task.priority,
    description: task.description,
  };
}

function taskButton(taskId: number, text: string, action: string, arg?: string): Buttons[number][number] {
  return {
    text,
    data: encodeCallback({ entity: 't', action, id: taskId, ...(arg !== undefined ? { arg } : {}) }),
  };
}

interface MenuView {
  text: string;
  buttons: Buttons;
}

/** The dialog's main menu — same card recap + per-field buttons shape as `editMenu.ts`'s own
 * `renderEditMenu`, under entity `'t'` instead of `'p'` (see this file's own top doc comment). */
function renderTaskEditMenu(
  taskId: number,
  view: { title: string; assignee: string; due: Due; priority: Priority; description: string | null },
  viewerZone: string,
): MenuView {
  const due = view.due;
  const dueLabel = texts.formatDue(
    formatDue(due.at === null ? null : { at: due.at, allDay: due.allDay, tz: due.tz }, viewerZone),
  );
  const description = view.description === null ? null : escapeHtml(view.description);

  const text = [
    texts.taskCard.editMenuHeader,
    texts.proposalCard.titleLine(escapeHtml(view.title)),
    texts.proposalCard.metaLine(escapeHtml(view.assignee), dueLabel, formatPriorityLabel(view.priority)),
    texts.editProposal.descriptionLine(description),
  ].join('\n');

  const b = (label: string, action: string): Buttons[number][number] => taskButton(taskId, label, action);

  return {
    text,
    buttons: [
      [b(texts.editProposal.fieldTitleButton, 'etl'), b(texts.editProposal.fieldAssigneeButton, 'eas')],
      [b(texts.editProposal.fieldDueButton, 'edu'), b(texts.editProposal.fieldPriorityButton, 'epr')],
      [b(texts.editProposal.fieldDescriptionButton, 'edc')],
      [b(texts.taskCard.editSaveButton, 'esv')],
      [b(texts.editProposal.backButton, 'ebk')],
    ],
  };
}

function renderTaskAssigneeMenu(
  taskId: number,
  members: ReadonlyArray<{ userId: number; name: string }>,
): MenuView {
  const memberRows = members.map((m) => [taskButton(taskId, escapeHtml(m.name), 'aus', String(m.userId))]);
  return {
    text: texts.editProposal.assigneeMenuTitle,
    buttons: [
      ...memberRows,
      [taskButton(taskId, texts.editProposal.assigneeSelfButton, 'ame')],
      [
        taskButton(taskId, texts.proposalCard.assigneeNone, 'ano'),
        taskButton(taskId, texts.proposalCard.assigneeAll, 'aal'),
      ],
    ],
  };
}

function renderTaskDueMenu(taskId: number): MenuView {
  const b = (label: string, action: string): Buttons[number][number] => taskButton(taskId, label, action);
  return {
    text: texts.editProposal.dueMenuTitle,
    buttons: [
      [b(texts.editProposal.dueTodayButton, 'dtd'), b(texts.editProposal.dueTomorrowButton, 'dtm')],
      [b(texts.editProposal.dueFriButton, 'dfr'), b(texts.editProposal.dueNextMonButton, 'dnm')],
      [b(texts.editProposal.dueNoneButton, 'dno')],
      [b(texts.editProposal.dueEnterButton, 'den')],
    ],
  };
}

function renderTaskDuePreview(taskId: number, label: string): MenuView {
  return {
    text: texts.editProposal.duePreview(label),
    buttons: [
      [
        taskButton(taskId, texts.editProposal.yesButton, 'dok'),
        taskButton(taskId, texts.editProposal.noButton, 'dca'),
      ],
    ],
  };
}

function renderTaskPriorityMenu(taskId: number): MenuView {
  return {
    text: texts.editProposal.priorityMenuTitle,
    buttons: [
      [
        taskButton(taskId, formatPriorityLabel('low'), 'plo'),
        taskButton(taskId, formatPriorityLabel('normal'), 'pno'),
        taskButton(taskId, formatPriorityLabel('high'), 'phi'),
      ],
    ],
  };
}

/** Waits for a `v1:t:<action>:<taskId>[:<arg>]` press whose `action` is in `allowed` and whose `id` matches
 * `taskId` — mirrors `editProposal.ts`'s own `waitForMenuAction`. */
async function waitForMenuAction(
  conversation: EditTaskConversation,
  taskId: number,
  allowed: ReadonlySet<string>,
): Promise<{ action: string; arg?: string } | null> {
  const pick = await conversation.waitForCallbackQuery(CALLBACK_RE, {
    otherwise: (otherCtx) => otherCtx.reply(texts.editProposal.pickButtonHint, { parse_mode: 'HTML' }),
  });
  await pick.answerCallbackQuery();
  const decoded = decodeCallback(pick.callbackQuery.data);
  if (!decoded || decoded.id !== taskId || !allowed.has(decoded.action)) return null;
  return { action: decoded.action, arg: decoded.arg };
}

async function editTitle(
  conversation: EditTaskConversation,
  ctx: BotContext,
  current: string,
): Promise<string> {
  await ctx.reply(texts.editProposal.titlePrompt(current), { parse_mode: 'HTML' });
  for (;;) {
    const textCtx = await conversation.waitFor(':text', {
      otherwise: (otherCtx) => otherCtx.reply(texts.editProposal.textHint, { parse_mode: 'HTML' }),
    });
    const trimmed = textCtx.msg.text.trim();
    if (trimmed.length > 0) return trimmed;
    await textCtx.reply(texts.editProposal.textHint, { parse_mode: 'HTML' });
  }
}

async function editDescription(
  conversation: EditTaskConversation,
  ctx: BotContext,
  current: string | null,
): Promise<string | null> {
  const currentLabel = current ?? texts.editProposal.noDescription;
  await ctx.reply(texts.editProposal.descriptionPrompt(currentLabel), { parse_mode: 'HTML' });
  const textCtx = await conversation.waitFor(':text', {
    otherwise: (otherCtx) => otherCtx.reply(texts.editProposal.textHint, { parse_mode: 'HTML' }),
  });
  const trimmed = textCtx.msg.text.trim();
  return trimmed === '-' ? null : trimmed;
}

async function editAssignee(
  conversation: EditTaskConversation,
  ctx: BotContext,
  taskId: number,
  ownerUserId: number,
  candidates: ReadonlyArray<{ userId: number; name: string }>,
): Promise<AssigneeResolution> {
  for (;;) {
    const view = renderTaskAssigneeMenu(taskId, candidates);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, taskId, ASSIGNEE_ACTIONS);
    if (picked === null) continue;

    if (picked.action === 'ame') return { type: 'user', userId: ownerUserId };
    if (picked.action === 'ano') return { type: 'none' };
    if (picked.action === 'aal') return { type: 'all' };

    const userId = picked.arg !== undefined ? Number(picked.arg) : NaN;
    const found = candidates.find((c) => c.userId === userId);
    if (found !== undefined) return { type: 'user', userId: found.userId };
  }
}

async function editDue(
  conversation: EditTaskConversation,
  ctx: BotContext,
  deps: EditTaskDeps,
  taskId: number,
  zone: string,
  now: Date,
): Promise<Due> {
  for (;;) {
    const view = renderTaskDueMenu(taskId);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, taskId, DUE_ACTIONS);
    if (picked === null) continue;

    const quickOption = QUICK_DUE_BY_ACTION[picked.action];
    if (quickOption !== undefined) return quickDue(quickOption, now, zone);

    await ctx.reply(texts.editProposal.dueTextPrompt, { parse_mode: 'HTML' });
    const textCtx = await conversation.waitFor(':text', {
      otherwise: (otherCtx) => otherCtx.reply(texts.editProposal.textHint, { parse_mode: 'HTML' }),
    });
    const phrase = textCtx.msg.text.trim();

    const resolved = await conversation.external(() => parseDateText(deps, phrase, { zone, now }));
    if (resolved === null || resolved.dueAt === null) {
      await textCtx.reply(texts.editProposal.dateNotParsed, { parse_mode: 'HTML' });
      continue;
    }
    const dueAt = resolved.dueAt;

    const label = texts.formatDue(formatDue({ at: dueAt, allDay: resolved.allDay, tz: resolved.tz }, zone));
    const preview = renderTaskDuePreview(taskId, label);
    await ctx.reply(preview.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(preview.buttons) });
    const confirmed = await waitForMenuAction(conversation, taskId, DUE_CONFIRM_ACTIONS);
    if (confirmed?.action === 'dok') return { at: dueAt, allDay: resolved.allDay, tz: resolved.tz };
  }
}

async function editPriority(
  conversation: EditTaskConversation,
  ctx: BotContext,
  taskId: number,
): Promise<Priority> {
  for (;;) {
    const view = renderTaskPriorityMenu(taskId);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, taskId, PRIORITY_ACTIONS);
    if (picked === null) continue;
    if (picked.action === 'plo') return 'low';
    if (picked.action === 'pno') return 'normal';
    return 'high';
  }
}

async function loadEditableTask(deps: EditTaskDeps, taskId: number): Promise<TaskRow | null> {
  return getTaskById(deps.db, taskId);
}

function isArchived(status: TaskRow['status']): boolean {
  return status === 'done' || status === 'cancelled';
}

function buildEditTaskConversation(deps: EditTaskDeps) {
  return async function editTaskConversation(
    conversation: EditTaskConversation,
    ctx: BotContext,
    taskId: number,
  ): Promise<void> {
    // `ctx.state` is unavailable on the context objects a conversation builder receives directly — only on
    // the live "outside" context `conversation.external`'s callback is given (same pre-verified fact
    // `editProposal.ts`/`editPerson.ts`/`timezone.ts` document).
    const actor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!can(actor, 'task.edit') || actor.userId === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const ownerUserId = actor.userId;

    const task = await conversation.external(() => loadEditableTask(deps, taskId));
    if (task === null) {
      await ctx.reply(texts.taskCard.notFound, { parse_mode: 'HTML' });
      return;
    }
    if (isArchived(task.status)) {
      await ctx.reply(texts.taskCard.editArchived, { parse_mode: 'HTML' });
      return;
    }

    const user = await conversation.external((outsideCtx) => outsideCtx.state.user);
    const workspace = await conversation.external((outsideCtx) => outsideCtx.state.workspace);
    if (user === null || workspace === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const zone = userZone(user, workspace);
    const now = new Date(await conversation.now());

    const members = await conversation.external(() => listMembersWithUsers(deps.db, deps.workspace.id));
    const memberNameByUserId = new Map(members.map((m) => [m.user.id, m.membership.displayName]));
    const assigneeCandidates = members
      .filter((m) => m.membership.role !== 'owner')
      .map((m) => ({ userId: m.user.id, name: m.membership.displayName }));

    const original = initialDraft(task);
    let title = original.title;
    let assignee = original.assignee;
    let due = original.due;
    let priority = original.priority;
    let description = original.description;
    const edited = new Set<FieldName>();

    for (;;) {
      const menu = renderTaskEditMenu(
        taskId,
        { title, assignee: formatAssigneeLabel(assignee, memberNameByUserId), due, priority, description },
        zone,
      );
      await ctx.reply(menu.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(menu.buttons) });

      const picked = await waitForMenuAction(conversation, taskId, MENU_ACTIONS);
      if (picked === null) continue;

      if (picked.action === 'ebk') {
        await ctx.reply(texts.editProposal.cancelled, { parse_mode: 'HTML' });
        return;
      }
      if (picked.action === 'esv') break;

      if (picked.action === 'etl') {
        title = await editTitle(conversation, ctx, title);
        edited.add('title');
      } else if (picked.action === 'eas') {
        assignee = await editAssignee(conversation, ctx, taskId, ownerUserId, assigneeCandidates);
        edited.add('assignee');
      } else if (picked.action === 'edu') {
        due = await editDue(conversation, ctx, deps, taskId, zone, now);
        edited.add('due');
      } else if (picked.action === 'epr') {
        priority = await editPriority(conversation, ctx, taskId);
        edited.add('priority');
      } else {
        description = await editDescription(conversation, ctx, description);
        edited.add('description');
      }
    }

    if (edited.size === 0) {
      await ctx.reply(texts.editProposal.cancelled, { parse_mode: 'HTML' });
      return;
    }

    // Re-checked right before the write (mirrors `editProposal.ts`'s "still owner" recheck), and the task
    // itself must still be editable — it may have been archived by another path while this dialog sat idle.
    const freshActor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!can(freshActor, 'task.edit') || freshActor.userId === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const freshTask = await conversation.external(() => loadEditableTask(deps, taskId));
    if (freshTask === null) {
      await ctx.reply(texts.taskCard.notFound, { parse_mode: 'HTML' });
      return;
    }
    if (isArchived(freshTask.status)) {
      await ctx.reply(texts.taskCard.editArchived, { parse_mode: 'HTML' });
      return;
    }

    const patch: Partial<Pick<CreateTaskInput, 'title' | 'description' | 'assignee' | 'due' | 'priority'>> =
      {};
    if (edited.has('title')) patch.title = title;
    if (edited.has('assignee')) patch.assignee = assignee;
    if (edited.has('due')) patch.due = due;
    if (edited.has('priority')) patch.priority = priority;
    if (edited.has('description')) patch.description = description;

    const freshActorUserId = freshActor.userId;
    const service = createTaskService(deps);
    const updated = await conversation.external(() =>
      deps.db.transaction((tx) =>
        service.update(tx, taskId, patch, { type: 'user', userId: freshActorUserId }),
      ),
    );

    await ctx.reply(texts.taskCard.editSaved(updated.id, escapeHtml(updated.title)), { parse_mode: 'HTML' });
  };
}

/**
 * Registers the `editTask` conversation and the `v1:t:edt:<id>` callback that enters it (SPEC §12.4's
 * "✏️ edit" button, `src/bot/views/taskCard.ts`). `task.edit` (Owner only, D40) is checked here, before
 * entering; the deeper checks (task still exists, still editable) live inside the conversation itself, via
 * `conversation.external`. Wrapped in `privateOnly`, same belt-and-suspenders reasoning as
 * `editProposal.ts`.
 */
export function registerEditTaskConversation(bot: Bot<BotContext>, deps: EditTaskDeps): void {
  bot.use(
    privateOnly(
      createConversation(buildEditTaskConversation(deps), {
        id: EDIT_TASK_CONVERSATION_ID,
        maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS,
      }),
    ),
  );

  bot.callbackQuery(/^v1:t:edt:/, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (!can(ctx.state.actor, 'task.edit')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.conversation.enter(EDIT_TASK_CONVERSATION_ID, decoded.id);
  });
}
