/**
 * Renders a proposal card's *terminal* state (plan.md Task 2.13, SPEC
 * §11.2): once a decision (`src/domain/proposals/decide.ts`) succeeds,
 * `src/bot/handlers/proposalCallbacks.ts` edits the card in place with one
 * of these instead of its original `ProposalCardView` buttons
 * (`src/bot/views/proposalCard.ts`) — the decision is final, so there is
 * nothing left to act on from this message (no task-management keyboard;
 * that belongs to the task card itself, SPEC §12.4, a later phase/task).
 * Pure functions (CLAUDE.md §7): no DB, no I/O, no grammY — the caller
 * resolves every id/title beforehand.
 */
import type { Buttons } from '../../domain/messenger.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';
import { texts } from '../texts/ru.js';
import { escapeHtml } from './escape.js';

export interface DecisionCardView {
  text: string;
  buttons: Buttons;
}

export type RejectReason = 'not_task' | 'duplicate' | 'already_done' | 'other';

const REASON_LABEL: Record<RejectReason, string> = {
  not_task: texts.proposalDecide.reasonNotTask,
  duplicate: texts.proposalDecide.reasonDuplicate,
  already_done: texts.proposalDecide.reasonAlreadyDone,
  other: texts.proposalDecide.reasonOther,
};

/** The "accept" button (`acc`) succeeded for a `create`-kind proposal. */
export function renderTaskCreatedCard(taskId: number, title: string): DecisionCardView {
  return { text: texts.proposalDecide.createdCard(taskId, escapeHtml(title)), buttons: [] };
}

/** The "apply" button (`apl`) succeeded for an `update`-kind proposal. */
export function renderTaskAppliedCard(taskId: number, title: string): DecisionCardView {
  return { text: texts.proposalDecide.appliedCard(taskId, escapeHtml(title)), buttons: [] };
}

/** The "apply" button (`apl`) succeeded for a `complete`-kind proposal. */
export function renderTaskCompletedCard(taskId: number, title: string): DecisionCardView {
  return { text: texts.proposalDecide.completedCard(taskId, escapeHtml(title)), buttons: [] };
}

/** The "apply" button (`apl`) succeeded for a `cancel`-kind proposal. */
export function renderTaskCancelledCard(taskId: number, title: string): DecisionCardView {
  return { text: texts.proposalDecide.cancelledCard(taskId, escapeHtml(title)), buttons: [] };
}

/** The "mark as duplicate" submenu's own button (`dpm` — mark only, or `dpa` — mark and append) succeeded.
 * `appended` says which one was pressed, for the confirmation text. */
export function renderDuplicateCard(taskId: number, appended: boolean): DecisionCardView {
  return { text: texts.proposalDecide.duplicateCard(taskId, appended), buttons: [] };
}

/** A decline succeeded — `reason` is `null` for `update`/`complete`/`cancel`'s plain decline. */
export function renderRejectedCard(reason: RejectReason | null): DecisionCardView {
  return {
    text: texts.proposalDecide.rejectedCard(reason === null ? null : REASON_LABEL[reason]),
    buttons: [],
  };
}

/**
 * The `create`-kind decline button's reason submenu (SPEC §11.2's four reject reasons: not-a-task,
 * duplicate, already-done, other) — `create`-kind proposals only; `update`/`complete`/`cancel`'s own
 * decline buttons go straight to {@link renderRejectedCard} instead
 * (`src/bot/handlers/proposalCallbacks.ts`).
 */
export function renderReasonMenu(proposalId: number): DecisionCardView {
  const button = (text: string, arg: 'nt' | 'dup' | 'done' | 'oth'): Buttons[number][number] => ({
    text,
    data: encodeCallback({ entity: 'p', action: 'rjr', id: proposalId, arg }),
  });
  return {
    text: texts.proposalDecide.reasonMenuTitle,
    buttons: [
      [button(texts.proposalDecide.reasonNotTask, 'nt'), button(texts.proposalDecide.reasonDuplicate, 'dup')],
      [
        button(texts.proposalDecide.reasonAlreadyDone, 'done'),
        button(texts.proposalDecide.reasonOther, 'oth'),
      ],
    ],
  };
}

/**
 * The "mark as duplicate" button's own follow-up submenu (fix round 1, Important A): the initial click no longer
 * decides anything by itself — it only offers "mark only" (`dpm`) vs. "mark and append the quote" (`dpa`),
 * both encoding `taskId` as `callback_data`'s `arg` (`v1:p:dpm|dpa:<proposalId>:<taskId>`) so
 * `src/domain/proposals/decide.ts`'s `markDuplicate` still gets it from the button press, not a second,
 * separate step after the decision already landed.
 */
export function renderDuplicateMenu(proposalId: number, taskId: number): DecisionCardView {
  const button = (text: string, action: 'dpm' | 'dpa'): Buttons[number][number] => ({
    text,
    data: encodeCallback({ entity: 'p', action, id: proposalId, arg: String(taskId) }),
  });
  return {
    text: texts.proposalDecide.duplicateMenuTitle(taskId),
    buttons: [
      [
        button(texts.proposalDecide.duplicateMarkOnlyButton, 'dpm'),
        button(texts.proposalDecide.duplicateMarkAndAppendButton, 'dpa'),
      ],
    ],
  };
}
