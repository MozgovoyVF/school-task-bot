import type { Bot } from 'grammy';
import { createConversation, type Conversation } from '@grammyjs/conversations';
import type { AppDeps } from '../../deps.js';
import { can } from '../../domain/people/permissions.js';
import { listMembersWithUsers } from '../../domain/people/repo.js';
import { createTaskService } from '../../domain/tasks/service.js';
import type { AssigneeResolution } from '../../ai/pipeline/resolve.js';
import { parseDateText } from '../../ai/pipeline/parseDate.js';
import { quickDue, type QuickDueOption } from '../../time/quickDue.js';
import { formatDue } from '../../time/format.js';
import { userZone } from '../../time/zones.js';
import { CONVERSATION_TIMEOUT_MS } from '../../config/constants.js';
import { texts } from '../texts/ru.js';
import { decodeCallback, encodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { escapeHtml } from '../views/escape.js';
import {
  formatAssigneeLabel,
  formatPriorityLabel,
  renderAssigneeMenu,
  renderDueMenu,
  renderDuePreview,
  renderPriorityMenu,
  type Priority,
} from '../views/editMenu.js';
import { privateOnly } from '../middleware/privateOnly.js';
import type { BotContext } from '../context.js';

export const NEW_TASK_CONVERSATION_ID = 'newTask';

type NewTaskConversation = Conversation<BotContext, BotContext>;

/** `ParseDateDeps` plus everything the final step's `TaskService.create` needs — mirrors
 * `src/bot/conversations/editProposal.ts`'s own `EditProposalDeps` widening precedent. */
export type NewTaskDeps = Pick<
  AppDeps,
  'db' | 'clock' | 'config' | 'messenger' | 'logger' | 'workspace' | 'taskHooks' | 'ai'
>;

type Due = { at: Date | null; allDay: boolean; tz: string | null };

/**
 * This dialog has no persisted row of its own to key its `v1:p:<action>:<id>` menu callbacks by (unlike
 * `editProposal.ts`'s real `proposalId`) — it reuses `src/bot/views/editMenu.ts`'s assignee/due/priority
 * submenus exactly as they are (same entity `p`, D23's same quick-pick buttons), with a fixed placeholder
 * id. Safe because `proposals.id` is a `bigserial` starting at 1: `0` can never collide with a real
 * proposal, and every update matching `v1:p:*:0` while this conversation is active is consumed entirely by
 * its own `conversation.waitForCallbackQuery` calls below, never reaching `editProposal.ts`'s unrelated
 * `bot.callbackQuery(/^v1:p:edt:/)` entry point (which only ever fires outside an active conversation, and
 * only for action `edt`, never one of this dialog's own action codes).
 */
const MENU_ID = 0;

const CALLBACK_RE = /^v1:p:/;
const ASSIGNEE_ACTIONS = new Set(['aus', 'ame', 'ano', 'aal']);
const DUE_ACTIONS = new Set(['dtd', 'dtm', 'dfr', 'dnm', 'dno', 'den']);
const DUE_CONFIRM_ACTIONS = new Set(['dok', 'dca']);
const PRIORITY_ACTIONS = new Set(['plo', 'pno', 'phi']);
const CONFIRM_ACTIONS = new Set(['ncy', 'ncn']);

const QUICK_DUE_BY_ACTION: Record<string, QuickDueOption> = {
  dtd: 'today',
  dtm: 'tomorrow',
  dfr: 'fri',
  dnm: 'next_mon',
  dno: 'none',
};

/** Mirrors `editProposal.ts`'s own `waitForMenuAction`, fixed to {@link MENU_ID}. */
async function waitForMenuAction(
  conversation: NewTaskConversation,
  allowed: ReadonlySet<string>,
): Promise<{ action: string; arg?: string } | null> {
  const pick = await conversation.waitForCallbackQuery(CALLBACK_RE, {
    otherwise: (otherCtx) => otherCtx.reply(texts.editProposal.pickButtonHint, { parse_mode: 'HTML' }),
  });
  await pick.answerCallbackQuery();
  const decoded = decodeCallback(pick.callbackQuery.data);
  if (!decoded || decoded.id !== MENU_ID || !allowed.has(decoded.action)) return null;
  return { action: decoded.action, arg: decoded.arg };
}

/** Step 1: the task's title — loops on an empty submission. */
async function askTitle(conversation: NewTaskConversation, ctx: BotContext): Promise<string> {
  await ctx.reply(texts.newTask.titlePrompt, { parse_mode: 'HTML' });
  for (;;) {
    const textCtx = await conversation.waitFor(':text', {
      otherwise: (otherCtx) => otherCtx.reply(texts.editProposal.textHint, { parse_mode: 'HTML' }),
    });
    const trimmed = textCtx.msg.text.trim();
    if (trimmed.length > 0) return trimmed;
    await textCtx.reply(texts.editProposal.textHint, { parse_mode: 'HTML' });
  }
}

/** Step 2: the assignee — reuses `editMenu.ts`'s submenu as-is (see {@link MENU_ID}'s own doc comment). */
async function askAssignee(
  conversation: NewTaskConversation,
  ctx: BotContext,
  ownerUserId: number,
  candidates: ReadonlyArray<{ userId: number; name: string }>,
): Promise<AssigneeResolution> {
  for (;;) {
    const view = renderAssigneeMenu(MENU_ID, candidates);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, ASSIGNEE_ACTIONS);
    if (picked === null) continue;

    if (picked.action === 'ame') return { type: 'user', userId: ownerUserId };
    if (picked.action === 'ano') return { type: 'none' };
    if (picked.action === 'aal') return { type: 'all' };

    const userId = picked.arg !== undefined ? Number(picked.arg) : NaN;
    const found = candidates.find((c) => c.userId === userId);
    if (found !== undefined) return { type: 'user', userId: found.userId };
  }
}

/** Step 3: the due date — reuses `editMenu.ts`'s submenu/preview as-is, same free-text `parseDateText`
 * step `editProposal.ts`'s own due-date step uses. */
async function askDue(
  conversation: NewTaskConversation,
  ctx: BotContext,
  deps: NewTaskDeps,
  zone: string,
  now: Date,
): Promise<Due> {
  for (;;) {
    const view = renderDueMenu(MENU_ID);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, DUE_ACTIONS);
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
    const preview = renderDuePreview(MENU_ID, label);
    await ctx.reply(preview.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(preview.buttons) });
    const confirmed = await waitForMenuAction(conversation, DUE_CONFIRM_ACTIONS);
    if (confirmed?.action === 'dok') return { at: dueAt, allDay: resolved.allDay, tz: resolved.tz };
  }
}

/** Step 4: the priority — reuses `editMenu.ts`'s submenu as-is. */
async function askPriority(conversation: NewTaskConversation, ctx: BotContext): Promise<Priority> {
  for (;;) {
    const view = renderPriorityMenu(MENU_ID);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, PRIORITY_ACTIONS);
    if (picked === null) continue;
    if (picked.action === 'plo') return 'low';
    if (picked.action === 'pno') return 'normal';
    return 'high';
  }
}

function displayDue(due: Due, zone: string): string {
  return texts.formatDue(
    formatDue(due.at === null ? null : { at: due.at, allDay: due.allDay, tz: due.tz }, zone),
  );
}

/** Step 5: the confirmation screen — "create task"/"cancel" buttons, built inline rather than through a
 * dedicated `bot/views/` file for two short-lived buttons (mirrors how `editPerson.ts`'s/`timezone.ts`'s
 * own final replies are built inline too, not every screen in this codebase goes through a views file).
 * Buttons go through `encodeCallback` (CLAUDE.md §5) with the same placeholder entity/id {@link MENU_ID}
 * uses, and two action codes (`ncy`/`ncn`) not shared with `editMenu.ts`'s own set. */
function renderConfirmation(draft: { title: string; assignee: string; due: string; priority: string }): {
  text: string;
  buttons: ReturnType<typeof renderPriorityMenu>['buttons'];
} {
  const text = [
    texts.newTask.menuHeader,
    texts.proposalCard.titleLine(escapeHtml(draft.title)),
    texts.proposalCard.metaLine(escapeHtml(draft.assignee), draft.due, draft.priority),
  ].join('\n');

  return {
    text,
    buttons: [
      [
        {
          text: texts.newTask.confirmButton,
          data: encodeCallback({ entity: 'p', action: 'ncy', id: MENU_ID }),
        },
        {
          text: texts.newTask.cancelButton,
          data: encodeCallback({ entity: 'p', action: 'ncn', id: MENU_ID }),
        },
      ],
    ],
  };
}

function buildNewTaskConversation(deps: NewTaskDeps) {
  return async function newTaskConversation(
    conversation: NewTaskConversation,
    ctx: BotContext,
  ): Promise<void> {
    // `ctx.state` is unavailable on the context objects a conversation builder receives directly — only on
    // the live "outside" context `conversation.external`'s callback is given (D41, same pre-verified fact
    // every other conversation in this codebase documents).
    const actor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!can(actor, 'task.createDm') || actor.userId === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
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

    const title = await askTitle(conversation, ctx);
    const assignee = await askAssignee(conversation, ctx, actor.userId, assigneeCandidates);
    const due = await askDue(conversation, ctx, deps, zone, now);
    const priority = await askPriority(conversation, ctx);

    for (;;) {
      const view = renderConfirmation({
        title,
        assignee: formatAssigneeLabel(assignee, memberNameByUserId),
        due: displayDue(due, zone),
        priority: formatPriorityLabel(priority),
      });
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
      const picked = await waitForMenuAction(conversation, CONFIRM_ACTIONS);
      if (picked === null) continue;
      if (picked.action === 'ncn') {
        await ctx.reply(texts.newTask.cancelled, { parse_mode: 'HTML' });
        return;
      }
      break; // 'ncy'
    }

    // Re-checked right before the write, not only at entry (mirrors `editProposal.ts`'s/`editPerson.ts`'s
    // own "still owner" recheck) — guards against the role changing (e.g. via `/transfer`) while this
    // dialog was sitting idle, within `CONVERSATION_TIMEOUT_MS`.
    const freshActor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!can(freshActor, 'task.createDm') || freshActor.userId === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const creatorUserId = freshActor.userId;

    const task = await conversation.external(() =>
      deps.db.transaction((tx) =>
        createTaskService(deps).create(
          tx,
          {
            workspaceId: deps.workspace.id,
            title,
            description: null,
            assignee,
            due,
            priority,
            origin: 'manual_dm',
            proposalId: null,
            source: { chatId: null, tgMessageId: null, link: null, quote: null, quoteAuthorUserId: null },
          },
          { type: 'user', userId: creatorUserId },
        ),
      ),
    );

    await ctx.reply(texts.proposalDecide.createdCard(task.id, escapeHtml(task.title)), {
      parse_mode: 'HTML',
    });
  };
}

/**
 * Registers the `/new` conversation (plan.md Task 3.10, SPEC §12.1/§12.2): Owner-only (`task.createDm`,
 * D40), DM-only. Entered directly from `bot.command('new', ...)` rather than a callback (unlike
 * `editProposal`/`editPerson`, which are entered from a card's button) — there is no row to carry an id
 * for.
 */
export function registerNewTaskConversation(bot: Bot<BotContext>, deps: NewTaskDeps): void {
  bot.use(
    privateOnly(
      createConversation(buildNewTaskConversation(deps), {
        id: NEW_TASK_CONVERSATION_ID,
        maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS,
      }),
    ),
  );

  bot.command('new', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!can(ctx.state.actor, 'task.createDm')) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    await ctx.conversation.enter(NEW_TASK_CONVERSATION_ID);
  });
}
