import type { Bot } from 'grammy';
import { createConversation, type Conversation } from '@grammyjs/conversations';
import { eq } from 'drizzle-orm';
import type { AppDeps } from '../../deps.js';
import { proposals } from '../../db/schema/index.js';
import { can } from '../../domain/people/permissions.js';
import { listMembersWithUsers } from '../../domain/people/repo.js';
import {
  getProposalById,
  parseProposalPayload,
  type ProposalPayload,
  type ProposalPayloadOwnerEdit,
  type ProposalRow,
} from '../../domain/proposals/repo.js';
import { acceptProposal, type DecideDeps, type ProposalEdits } from '../../domain/proposals/decide.js';
import type { AssigneeResolution } from '../../ai/pipeline/resolve.js';
import { parseDateText } from '../../ai/pipeline/parseDate.js';
import { quickDue, type QuickDueOption } from '../../time/quickDue.js';
import { formatDue } from '../../time/format.js';
import { userZone } from '../../time/zones.js';
import { CONVERSATION_TIMEOUT_MS } from '../../config/constants.js';
import { texts } from '../texts/ru.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { escapeHtml } from '../views/escape.js';
import {
  formatAssigneeLabel,
  formatPriorityLabel,
  renderAssigneeMenu,
  renderDueMenu,
  renderDuePreview,
  renderEditMenu,
  renderPriorityMenu,
  type EditDraftView,
  type Priority,
} from '../views/editMenu.js';
import { privateOnly } from '../middleware/privateOnly.js';
import type { BotContext } from '../context.js';

export const EDIT_PROPOSAL_CONVERSATION_ID = 'editProposal';

type EditProposalConversation = Conversation<BotContext, BotContext>;

/** `DecideDeps` (`src/domain/proposals/decide.ts`) plus `ai` — this dialog's final step calls
 * `acceptProposal` (needs `DecideDeps`) and its free-text date step (`den`) calls `parseDateText` (needs `ai`,
 * absent from `DecideDeps` since Task 2.13 never touched an LLM). Mirrors `DecideDeps`'s own precedent of
 * narrowing the brief's literal `deps: AppDeps` signature. */
export type EditProposalDeps = DecideDeps & Pick<AppDeps, 'ai'>;

type Due = { at: Date | null; allDay: boolean; tz: string | null };

interface Draft {
  title: string;
  assignee: AssigneeResolution;
  due: Due;
  priority: Priority;
  description: string | null;
}

type FieldName = 'title' | 'assignee' | 'due' | 'priority' | 'description';

const CALLBACK_RE = /^v1:p:/;
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

function initialDraft(payload: ProposalPayload): Draft {
  const due: Due =
    payload.due && payload.due.dueAt !== null
      ? { at: new Date(payload.due.dueAt), allDay: payload.due.allDay, tz: payload.due.tz }
      : { at: null, allDay: false, tz: null };
  return {
    title: payload.title ?? '',
    assignee: payload.assignee ?? { type: 'none' },
    due,
    priority: payload.priority ?? 'normal',
    description: payload.description ?? null,
  };
}

function failureText(reason: 'already_decided' | 'forbidden' | 'not_found' | 'target_gone'): string {
  switch (reason) {
    case 'already_decided':
      return texts.proposalDecide.alreadyDecided;
    case 'forbidden':
      return texts.common.forbidden;
    case 'not_found':
      return texts.proposalDecide.notFound;
    case 'target_gone':
      return texts.proposalDecide.targetGone;
  }
}

/** Waits for a `v1:p:<action>:<proposalId>[:<arg>]` press whose `action` is in `allowed` and whose `id`
 * matches `proposalId` — anything else (a stale keyboard from another proposal's card, a malformed
 * payload) is treated like a non-matching press and `null` is returned so the caller's loop re-prompts.
 * Mirrors `src/bot/conversations/timezone.ts`'s `pickZone` loop. */
async function waitForMenuAction(
  conversation: EditProposalConversation,
  proposalId: number,
  allowed: ReadonlySet<string>,
): Promise<{ action: string; arg?: string } | null> {
  const pick = await conversation.waitForCallbackQuery(CALLBACK_RE, {
    otherwise: (otherCtx) => otherCtx.reply(texts.editProposal.pickButtonHint, { parse_mode: 'HTML' }),
  });
  await pick.answerCallbackQuery();
  const decoded = decodeCallback(pick.callbackQuery.data);
  if (!decoded || decoded.id !== proposalId || !allowed.has(decoded.action)) return null;
  return { action: decoded.action, arg: decoded.arg };
}

/** The title field (`etl`) — loops on an empty submission instead of accepting a blank title. */
async function editTitle(
  conversation: EditProposalConversation,
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

/** The description field (`edc`) — `-` clears it (mirrors `editPerson.ts`'s skip-token convention). */
async function editDescription(
  conversation: EditProposalConversation,
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

/** The assignee submenu (`eas`; brief: real workspace members, plus self/unassigned/everyone —
 * `ame`/`ano`/`aal`). `candidates` excludes the Owner — `ame` already covers assigning to them (this
 * dialog is Owner-only, D40). */
async function editAssignee(
  conversation: EditProposalConversation,
  ctx: BotContext,
  proposalId: number,
  ownerUserId: number,
  candidates: ReadonlyArray<{ userId: number; name: string }>,
): Promise<AssigneeResolution> {
  for (;;) {
    const view = renderAssigneeMenu(proposalId, candidates);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, proposalId, ASSIGNEE_ACTIONS);
    if (picked === null) continue;

    if (picked.action === 'ame') return { type: 'user', userId: ownerUserId };
    if (picked.action === 'ano') return { type: 'none' };
    if (picked.action === 'aal') return { type: 'all' };

    // 'aus' — a real member's button, `arg` is their `userId`.
    const userId = picked.arg !== undefined ? Number(picked.arg) : NaN;
    const found = candidates.find((c) => c.userId === userId);
    if (found !== undefined) return { type: 'user', userId: found.userId };
    // Otherwise (a malformed/unrecognized arg) falls through and re-prompts, same as any other mismatch.
  }
}

/** The due-date submenu (`edu`, D23): the four quick-pick buttons apply directly (no confirmation — they
 * are deterministic); the free-text option (`den`) reads a phrase, resolves it via `parseDateText`, and
 * shows a preview the Owner must confirm (`dok`/`dca`) before it is applied. */
async function editDue(
  conversation: EditProposalConversation,
  ctx: BotContext,
  deps: EditProposalDeps,
  proposalId: number,
  zone: string,
  now: Date,
): Promise<Due> {
  for (;;) {
    const view = renderDueMenu(proposalId);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, proposalId, DUE_ACTIONS);
    if (picked === null) continue;

    const quickOption = QUICK_DUE_BY_ACTION[picked.action];
    if (quickOption !== undefined) return quickDue(quickOption, now, zone);

    // 'den' — free-text entry.
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
    const preview = renderDuePreview(proposalId, label);
    await ctx.reply(preview.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(preview.buttons) });
    const confirmed = await waitForMenuAction(conversation, proposalId, DUE_CONFIRM_ACTIONS);
    if (confirmed?.action === 'dok') return { at: dueAt, allDay: resolved.allDay, tz: resolved.tz };
    // 'dca', or a mismatched press: back to the due submenu.
  }
}

/** The priority submenu (`epr`). */
async function editPriority(
  conversation: EditProposalConversation,
  ctx: BotContext,
  proposalId: number,
): Promise<Priority> {
  for (;;) {
    const view = renderPriorityMenu(proposalId);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(view.buttons) });
    const picked = await waitForMenuAction(conversation, proposalId, PRIORITY_ACTIONS);
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

/** SPEC §20.4's before/after pairs for every field the Owner actually touched in this dialog — recorded
 * on `proposals.payload.ownerEdits` (never for a field the Owner left alone). */
function buildOwnerEdits(
  before: Draft,
  after: Draft,
  edited: ReadonlySet<FieldName>,
  zone: string,
  memberNameByUserId: ReadonlyMap<number, string>,
): Record<string, ProposalPayloadOwnerEdit> {
  const result: Record<string, ProposalPayloadOwnerEdit> = {};
  if (edited.has('title')) result.title = { before: before.title, after: after.title };
  if (edited.has('assignee')) {
    result.assignee = {
      before: formatAssigneeLabel(before.assignee, memberNameByUserId),
      after: formatAssigneeLabel(after.assignee, memberNameByUserId),
    };
  }
  if (edited.has('due'))
    result.due = { before: displayDue(before.due, zone), after: displayDue(after.due, zone) };
  if (edited.has('priority')) {
    result.priority = {
      before: formatPriorityLabel(before.priority),
      after: formatPriorityLabel(after.priority),
    };
  }
  if (edited.has('description'))
    result.description = { before: before.description, after: after.description };
  return result;
}

/** Best-effort follow-up write, after `acceptProposal` has already succeeded: merges `ownerEdits` onto the
 * (now `accepted`) proposal's own `payload` (SPEC §20.4's audit trail). Never touches `decide.ts` — this
 * task's brief only names this dialog's own files — and never fails the caller: the task itself was
 * already created by `acceptProposal`, so losing this purely-informational field on a crash or an
 * unparsable payload is logged and swallowed rather than surfaced to the Owner (mirrors `decide.ts`'s own
 * `reactOnAccept`, the same "best-effort, post-commit" shape). */
async function recordOwnerEdits(
  deps: EditProposalDeps,
  proposalId: number,
  ownerEdits: Record<string, ProposalPayloadOwnerEdit>,
): Promise<void> {
  if (Object.keys(ownerEdits).length === 0) return;
  const row = await getProposalById(deps.db, proposalId);
  if (!row) return;
  const payload = parseProposalPayload(row.payload);
  if (!payload) {
    deps.logger.warn({ proposalId }, 'editProposal: unparsable payload, ownerEdits not recorded');
    return;
  }
  await deps.db
    .update(proposals)
    .set({ payload: { ...payload, ownerEdits } })
    .where(eq(proposals.id, proposalId));
}

interface Loaded {
  proposal: ProposalRow;
  payload: ProposalPayload;
}

async function loadEditable(deps: EditProposalDeps, proposalId: number): Promise<Loaded | null> {
  const row = await getProposalById(deps.db, proposalId);
  if (!row) return null;
  const payload = parseProposalPayload(row.payload);
  if (!payload) throw new Error(`editProposal: unparsable payload for proposal ${String(proposalId)}`);
  return { proposal: row, payload };
}

function buildEditProposalConversation(deps: EditProposalDeps) {
  return async function editProposalConversation(
    conversation: EditProposalConversation,
    ctx: BotContext,
    proposalId: number,
  ): Promise<void> {
    // `ctx.state` is unavailable on the context objects a conversation builder receives directly — only on
    // the live "outside" context `conversation.external`'s callback is given (same pre-verified fact
    // `editPerson.ts`/`timezone.ts` document).
    const actor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!can(actor, 'proposal.decide') || actor.userId === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }
    const ownerUserId = actor.userId;

    const loaded = await conversation.external(() => loadEditable(deps, proposalId));
    if (loaded === null) {
      await ctx.reply(texts.proposalDecide.notFound, { parse_mode: 'HTML' });
      return;
    }
    if (loaded.proposal.status !== 'pending') {
      await ctx.reply(texts.proposalDecide.alreadyDecided, { parse_mode: 'HTML' });
      return;
    }
    if (loaded.proposal.kind !== 'create') {
      // The dialog's only exit (`esv`, "save and create") always calls `acceptProposal`, which only ever
      // accepts a `create`-kind proposal (`src/domain/proposals/decide.ts`) — `update`'s own edit button
      // (`edt`, `src/bot/views/proposalCard.ts`) is out of this task's scope.
      await ctx.reply(texts.editProposal.notSupported, { parse_mode: 'HTML' });
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

    const original = initialDraft(loaded.payload);
    let title = original.title;
    let assignee = original.assignee;
    let due = original.due;
    let priority = original.priority;
    let description = original.description;
    const edited = new Set<FieldName>();

    for (;;) {
      const view: EditDraftView = {
        title,
        assignee: formatAssigneeLabel(assignee, memberNameByUserId),
        due: due.at === null ? null : { at: due.at, allDay: due.allDay, tz: due.tz },
        priority,
        description,
      };
      const menu = renderEditMenu(proposalId, view, zone);
      await ctx.reply(menu.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(menu.buttons) });

      const picked = await waitForMenuAction(conversation, proposalId, MENU_ACTIONS);
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
        assignee = await editAssignee(conversation, ctx, proposalId, ownerUserId, assigneeCandidates);
        edited.add('assignee');
      } else if (picked.action === 'edu') {
        due = await editDue(conversation, ctx, deps, proposalId, zone, now);
        edited.add('due');
      } else if (picked.action === 'epr') {
        priority = await editPriority(conversation, ctx, proposalId);
        edited.add('priority');
      } else {
        // 'edc'
        description = await editDescription(conversation, ctx, description);
        edited.add('description');
      }
    }

    // Re-checked right before the write, not only at entry (mirrors `editPerson.ts`'s "still owner"
    // recheck) — guards against the Owner role changing (e.g. via `/transfer`) while this dialog was
    // sitting idle, within `CONVERSATION_TIMEOUT_MS`, waiting for the Owner's next button press.
    const freshActor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!can(freshActor, 'proposal.decide') || freshActor.userId === null) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    const edits: ProposalEdits = {};
    if (edited.has('title')) edits.title = title;
    if (edited.has('assignee')) edits.assignee = assignee;
    if (edited.has('due')) edits.due = due;
    if (edited.has('priority')) edits.priority = priority;
    if (edited.has('description')) edits.description = description;

    const result = await conversation.external(() =>
      acceptProposal(deps, { proposalId, actor: freshActor, edits }),
    );
    if (!result.ok) {
      await ctx.reply(failureText(result.reason), { parse_mode: 'HTML' });
      return;
    }

    if (edited.size > 0) {
      const after: Draft = { title, assignee, due, priority, description };
      const ownerEdits = buildOwnerEdits(original, after, edited, zone, memberNameByUserId);
      await conversation.external(() => recordOwnerEdits(deps, proposalId, ownerEdits));
    }

    await ctx.reply(texts.proposalDecide.createdCard(result.value.id, escapeHtml(result.value.title)), {
      parse_mode: 'HTML',
    });
  };
}

/**
 * Registers the `editProposal` conversation and the `v1:p:edt:<id>` callback that enters it (SPEC §11.2's
 * edit button, `src/bot/views/proposalCard.ts`). `proposal.decide` (Owner only, D40) is checked
 * here, before entering — a Member pressing the button is rejected on the spot and the conversation never
 * starts (brief's own acceptance case); the deeper checks (proposal still pending, still `kind='create'`,
 * still owned by this actor once the dialog finishes) all live inside the conversation itself
 * ({@link buildEditProposalConversation}), re-read fresh via `conversation.external` rather than trusted
 * from this entry point. Wrapped in `privateOnly` (mirrors `editPerson.ts`/`timezone.ts`): proposal cards
 * are DM-only (D40), so this callback is never expected in a group, but the guard is repeated here anyway
 * — same belt-and-suspenders reasoning as those two conversations.
 */
export function registerEditProposalConversation(bot: Bot<BotContext>, deps: EditProposalDeps): void {
  bot.use(
    privateOnly(
      createConversation(buildEditProposalConversation(deps), {
        id: EDIT_PROPOSAL_CONVERSATION_ID,
        maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS,
      }),
    ),
  );

  bot.callbackQuery(/^v1:p:edt:/, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (!can(ctx.state.actor, 'proposal.decide')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.conversation.enter(EDIT_PROPOSAL_CONVERSATION_ID, decoded.id);
  });
}
