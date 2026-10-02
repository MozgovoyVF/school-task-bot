import type { Bot } from 'grammy';
import { can } from '../../domain/people/permissions.js';
import {
  acceptProposal,
  applyModification,
  createTaskFromUpdate,
  markDuplicate,
  rejectProposal,
  type DecideDeps,
} from '../../domain/proposals/decide.js';
import { getProposalById } from '../../domain/proposals/repo.js';
import { decodeCallback } from '../keyboards/callbackCodec.js';
import { texts } from '../texts/ru.js';
import {
  renderDuplicateCard,
  renderDuplicateMenu,
  renderReasonMenu,
  renderRejectedCard,
  renderTaskAppliedCard,
  renderTaskCancelledCard,
  renderTaskCompletedCard,
  renderTaskCreatedCard,
  type DecisionCardView,
  type RejectReason,
} from '../views/taskCreated.js';
import type { BotContext } from '../context.js';

/** `callback_data` actions this handler owns (plan.md Task 2.13's `v1:p:*` decision buttons). `edt` (the
 * "edit" button) is a forward reference to Task 2.14's edit dialog — not handled here, falls through to
 * `next()` (inert until then, same pattern as `src/scheduler/jobs/cards.ts`'s `nbx` button). `dup` only
 * opens the mark-as-duplicate submenu; `dpm`/`dpa` (its two buttons) are the actual decision (fix round 1,
 * Important A). `asn` (D47, plan.md Task 3.15) is the `update`-kind card's manual "➕ Create as a new task" (texts.proposalCard.createAsNewButton)
 * escape hatch — always creates a brand-new task via `createTaskFromUpdate`, never applies the suggested
 * change to the existing target. */
const KNOWN_ACTIONS = new Set(['acc', 'rej', 'rjr', 'apl', 'dup', 'dpm', 'dpa', 'asn']);

const REASON_BY_ARG: Record<string, RejectReason> = {
  nt: 'not_task',
  dup: 'duplicate',
  done: 'already_done',
  oth: 'other',
};

/** Parses the `taskId` carried in `callback_data`'s `arg` (`dup`/`dpm`/`dpa`) — `null` for anything that
 * isn't a non-negative integer, since `callback_data` is never trusted (CLAUDE.md §8). */
function parseTaskIdArg(arg: string | undefined): number | null {
  const taskId = arg !== undefined ? Number(arg) : NaN;
  return Number.isInteger(taskId) && taskId >= 0 ? taskId : null;
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

/** Redraws the card a `v1:p:*` callback came from with `view`. A no-op if the callback carries no
 * `message` (e.g. a very old keyboard) — mirrors `src/bot/handlers/chats.ts`'s `renderInto`. */
async function editCard(deps: DecideDeps, ctx: BotContext, view: DecisionCardView): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  await deps.messenger.edit(msg.chat.id, msg.message_id, view.text, { buttons: view.buttons });
}

/**
 * Registers the `v1:p:*` decision callbacks (plan.md Task 2.13, SPEC §11.2): the accept/apply buttons
 * (`acc`/`apl` — create/update/complete/cancel respectively), the decline button (`rej` — for a
 * `create`-kind proposal this opens the reason submenu instead of deciding directly; every other kind
 * declines immediately), the reason submenu's own buttons (`rjr`), and the "mark as duplicate" button
 * (`dup`, which — like `rej` — only opens its own submenu; `dpm`/`dpa` are that submenu's two buttons and
 * the actual decision). `proposal.decide` (Owner only) is checked once, immediately after decoding and before any branch —
 * `callback_data` is never trusted (CLAUDE.md §8) — via `ctx.state.actor`, resolved fresh from the DB on
 * every update (`src/bot/middleware/context.ts`), so a forwarded card pressed by a Member, or a former
 * Owner who has since transferred ownership, both correctly fail here regardless of what the stale
 * `callback_data`/keyboard still shows.
 */
export function registerProposalCallbackHandlers(bot: Bot<BotContext>, deps: DecideDeps): void {
  bot.callbackQuery(/^v1:p:/, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCallbackQuery();
      return;
    }

    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded || !KNOWN_ACTIONS.has(decoded.action)) {
      await next();
      return;
    }

    if (!can(ctx.state.actor, 'proposal.decide')) {
      await ctx.answerCallbackQuery({ text: texts.common.forbidden });
      return;
    }

    if (decoded.action === 'acc') {
      const result = await acceptProposal(deps, { proposalId: decoded.id, actor: ctx.state.actor });
      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: failureText(result.reason) });
        return;
      }
      await ctx.answerCallbackQuery();
      await editCard(deps, ctx, renderTaskCreatedCard(result.value.id, result.value.title));
      return;
    }

    if (decoded.action === 'apl') {
      const result = await applyModification(deps, { proposalId: decoded.id, actor: ctx.state.actor });
      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: failureText(result.reason) });
        return;
      }
      await ctx.answerCallbackQuery();
      // `kind` is immutable once a proposal is created, so reading it right after a successful decision
      // (rather than before) is still race-safe — it only decides which of the three confirmation texts
      // to show, never the decision itself (already made, atomically, inside `applyModification`).
      const proposal = await getProposalById(deps.db, decoded.id);
      const view =
        proposal?.kind === 'complete'
          ? renderTaskCompletedCard(result.value.id, result.value.title)
          : proposal?.kind === 'cancel'
            ? renderTaskCancelledCard(result.value.id, result.value.title)
            : renderTaskAppliedCard(result.value.id, result.value.title);
      await editCard(deps, ctx, view);
      return;
    }

    if (decoded.action === 'asn') {
      // D47 (plan.md Task 3.15): the manual "➕ Create as a new task" (texts.proposalCard.createAsNewButton) escape hatch — always creates a
      // brand-new task from an `update`-kind proposal, same confirmation card as a plain accept.
      const result = await createTaskFromUpdate(deps, { proposalId: decoded.id, actor: ctx.state.actor });
      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: failureText(result.reason) });
        return;
      }
      await ctx.answerCallbackQuery();
      await editCard(deps, ctx, renderTaskCreatedCard(result.value.id, result.value.title));
      return;
    }

    if (decoded.action === 'dup') {
      // Only opens the mark-as-duplicate submenu (fix round 1, Important A) — same best-effort UI-routing
      // read as `rej`'s own submenu below; the actual decision happens on `dpm`/`dpa`.
      const taskId = parseTaskIdArg(decoded.arg);
      if (taskId === null) {
        await ctx.answerCallbackQuery();
        return;
      }
      const proposal = await getProposalById(deps.db, decoded.id);
      if (!proposal) {
        await ctx.answerCallbackQuery({ text: texts.proposalDecide.notFound });
        return;
      }
      if (proposal.status !== 'pending') {
        await ctx.answerCallbackQuery({ text: texts.proposalDecide.alreadyDecided });
        return;
      }
      await ctx.answerCallbackQuery();
      await editCard(deps, ctx, renderDuplicateMenu(decoded.id, taskId));
      return;
    }

    if (decoded.action === 'dpm' || decoded.action === 'dpa') {
      const taskId = parseTaskIdArg(decoded.arg);
      if (taskId === null) {
        await ctx.answerCallbackQuery();
        return;
      }
      const appendToDescription = decoded.action === 'dpa';
      const result = await markDuplicate(deps, {
        proposalId: decoded.id,
        taskId,
        actor: ctx.state.actor,
        appendToDescription,
      });
      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: failureText(result.reason) });
        return;
      }
      await ctx.answerCallbackQuery();
      await editCard(deps, ctx, renderDuplicateCard(taskId, appendToDescription));
      return;
    }

    if (decoded.action === 'rjr') {
      const reason = decoded.arg !== undefined ? REASON_BY_ARG[decoded.arg] : undefined;
      if (!reason) {
        await ctx.answerCallbackQuery();
        return;
      }
      const result = await rejectProposal(deps, { proposalId: decoded.id, actor: ctx.state.actor, reason });
      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: failureText(result.reason) });
        return;
      }
      await ctx.answerCallbackQuery();
      await editCard(deps, ctx, renderRejectedCard(reason));
      return;
    }

    // decoded.action === 'rej': a `create`-kind proposal opens the reason submenu instead of deciding
    // directly; this read is best-effort UI routing only — the eventual real decision (either
    // `rejectProposal` below, or a later `rjr` click) still re-validates everything atomically.
    const proposal = await getProposalById(deps.db, decoded.id);
    if (!proposal) {
      await ctx.answerCallbackQuery({ text: texts.proposalDecide.notFound });
      return;
    }
    if (proposal.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: texts.proposalDecide.alreadyDecided });
      return;
    }
    if (proposal.kind === 'create') {
      await ctx.answerCallbackQuery();
      await editCard(deps, ctx, renderReasonMenu(decoded.id));
      return;
    }

    const result = await rejectProposal(deps, {
      proposalId: decoded.id,
      actor: ctx.state.actor,
      reason: null,
    });
    if (!result.ok) {
      await ctx.answerCallbackQuery({ text: failureText(result.reason) });
      return;
    }
    await ctx.answerCallbackQuery();
    await editCard(deps, ctx, renderRejectedCard(null));
  });
}
