import type { Bot } from 'grammy';
import { createConversation, type Conversation } from '@grammyjs/conversations';
import type { AppDeps } from '../../deps.js';
import { can } from '../../domain/people/permissions.js';
import { getTaskListItem } from '../../domain/tasks/queries.js';
import { createSnooze } from '../../domain/notifications/snooze.js';
import { parseDateText } from '../../ai/pipeline/parseDate.js';
import { formatDue } from '../../time/format.js';
import { userZone } from '../../time/zones.js';
import { CONVERSATION_TIMEOUT_MS } from '../../config/constants.js';
import { texts } from '../texts/ru.js';
import { decodeCallback, encodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { privateOnly } from '../middleware/privateOnly.js';
import type { BotContext } from '../context.js';

export const SNOOZE_INPUT_CONVERSATION_ID = 'snoozeInput';

type SnoozeInputConversation = Conversation<BotContext, BotContext>;

/** `ParseDateDeps` (`src/ai/pipeline/parseDate.ts`) plus everything this dialog's final write
 * (`createSnooze`) needs — mirrors `src/bot/conversations/editProposal.ts`'s own `EditProposalDeps`
 * widening precedent. */
export type SnoozeInputDeps = Pick<
  AppDeps,
  'db' | 'clock' | 'config' | 'messenger' | 'logger' | 'workspace' | 'ai'
>;

const CALLBACK_RE = /^v1:n:/;
const CONFIRM_ACTIONS = new Set(['sok', 'sca']);
const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled']);

/** Waits for a `v1:n:<action>:<taskId>` press whose `action` is `sok`/`sca` and whose `id` matches
 * `taskId` — anything else is treated like a non-matching press and `null` is returned so the caller's
 * loop re-prompts. Mirrors `src/bot/conversations/editProposal.ts`'s own `waitForMenuAction`. */
async function waitForConfirm(
  conversation: SnoozeInputConversation,
  taskId: number,
): Promise<{ action: string } | null> {
  const pick = await conversation.waitForCallbackQuery(CALLBACK_RE, {
    otherwise: (otherCtx) => otherCtx.reply(texts.editProposal.pickButtonHint, { parse_mode: 'HTML' }),
  });
  await pick.answerCallbackQuery();
  const decoded = decodeCallback(pick.callbackQuery.data);
  if (!decoded || decoded.id !== taskId || !CONFIRM_ACTIONS.has(decoded.action)) return null;
  return { action: decoded.action };
}

function buildSnoozeInputConversation(deps: SnoozeInputDeps) {
  return async function snoozeInputConversation(
    conversation: SnoozeInputConversation,
    ctx: BotContext,
    taskId: number,
  ): Promise<void> {
    // `ctx.state` is unavailable on the context objects a conversation builder receives directly — only on
    // the live "outside" context `conversation.external`'s callback is given (same pre-verified fact
    // `editPerson.ts`/`timezone.ts`/`editProposal.ts` document, D41).
    const actor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!can(actor, 'reminders.receive') || actor.userId === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const recipientUserId = actor.userId;

    const task = await conversation.external(() => getTaskListItem(deps.db, taskId));
    if (task === null || CLOSED_TASK_STATUSES.has(task.status)) {
      await ctx.reply(texts.reminders.taskGone, { parse_mode: 'HTML' });
      return;
    }

    const user = await conversation.external((outsideCtx) => outsideCtx.state.user);
    const workspace = await conversation.external((outsideCtx) => outsideCtx.state.workspace);
    if (user === null || workspace === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const zone = userZone(user, workspace);

    let fireAt: Date | null = null;
    await ctx.reply(texts.reminders.snoozeEnterPrompt, { parse_mode: 'HTML' });

    while (fireAt === null) {
      const textCtx = await conversation.waitFor(':text', {
        otherwise: (otherCtx) => otherCtx.reply(texts.editProposal.textHint, { parse_mode: 'HTML' }),
      });
      const phrase = textCtx.msg.text.trim();
      const now = new Date(await conversation.now());

      const resolved = await conversation.external(() => parseDateText(deps, phrase, { zone, now }));
      if (resolved === null || resolved.dueAt === null) {
        await textCtx.reply(texts.editProposal.dateNotParsed, { parse_mode: 'HTML' });
        continue;
      }
      const candidate = resolved.dueAt;

      const label = texts.formatDue(
        formatDue({ at: candidate, allDay: resolved.allDay, tz: resolved.tz }, zone),
      );
      await ctx.reply(texts.editProposal.duePreview(label), {
        parse_mode: 'HTML',
        reply_markup: toInlineKeyboard([
          [
            {
              text: texts.editProposal.yesButton,
              data: encodeCallback({ entity: 'n', action: 'sok', id: taskId }),
            },
            {
              text: texts.editProposal.noButton,
              data: encodeCallback({ entity: 'n', action: 'sca', id: taskId }),
            },
          ],
        ]),
      });

      const confirmed = await waitForConfirm(conversation, taskId);
      if (confirmed?.action === 'sok') {
        fireAt = candidate;
      } else {
        // 'sca', or a mismatched press: re-prompt for a fresh phrase.
        await ctx.reply(texts.reminders.snoozeEnterPrompt, { parse_mode: 'HTML' });
      }
    }

    // Re-checked right before the write, not only at entry (mirrors `editProposal.ts`'s "still owner"
    // recheck) — guards against the actor's role changing (e.g. via `/transfer`) while this dialog was
    // sitting idle, within `CONVERSATION_TIMEOUT_MS`, waiting for free text.
    const freshActor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!can(freshActor, 'reminders.receive') || freshActor.userId === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    await conversation.external(() =>
      deps.db.transaction((tx) =>
        createSnooze(tx, { taskId, recipientUserId, fireAt, workspaceId: deps.workspace.id }),
      ),
    );

    const label = texts.formatDue(formatDue({ at: fireAt, allDay: false, tz: null }, zone));
    await ctx.reply(texts.reminders.snoozeConfirm(label), { parse_mode: 'HTML' });
  };
}

/**
 * Registers the `snoozeInput` conversation and the `v1:n:inp:<taskId>` callback that enters it
 * (`src/bot/views/reminder.ts`'s `renderSnoozeMenu` submenu's own `pickEnterButton`, plan.md Task 3.4).
 * `reminders.receive` (D40: only the Owner is ever a real recipient) is checked here,
 * before entering — a forged/forwarded callback from a non-owner actor is rejected on the spot and the
 * conversation never starts; the deeper checks (task still open, still owned by this actor once the
 * dialog finishes) all live inside the conversation itself ({@link buildSnoozeInputConversation}), re-read
 * fresh via `conversation.external` rather than trusted from this entry point. Registered ahead of
 * `src/bot/handlers/reminderCallbacks.ts`'s own broader `v1:n:*` handler in `src/bot/bot.ts` — mirrors
 * `editProposal.ts`'s `v1:p:edt:` entry callback relative to `proposalCallbacks.ts`. Wrapped in
 * `privateOnly` (mirrors every other `createConversation` registration in this codebase): reminder DMs are
 * DM-only by construction (D40), so this callback is never expected in a group, but the guard is repeated
 * here anyway — same belt-and-suspenders reasoning as those.
 */
export function registerSnoozeInputConversation(bot: Bot<BotContext>, deps: SnoozeInputDeps): void {
  bot.use(
    privateOnly(
      createConversation(buildSnoozeInputConversation(deps), {
        id: SNOOZE_INPUT_CONVERSATION_ID,
        maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS,
      }),
    ),
  );

  bot.callbackQuery(/^v1:n:inp:/, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (!can(ctx.state.actor, 'reminders.receive')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.conversation.enter(SNOOZE_INPUT_CONVERSATION_ID, decoded.id);
  });
}
