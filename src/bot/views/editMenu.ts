/**
 * The proposal card's edit dialog's views (`src/bot/conversations/editProposal.ts`, plan.md Task 2.14):
 * the main field menu, the assignee/due/priority submenus, and the free-text date preview. Pure
 * functions (CLAUDE.md §7): no DB, no I/O — the conversation resolves every id/name beforehand.
 */
import type { Buttons } from '../../domain/messenger.js';
import type { AssigneeResolution } from '../../ai/pipeline/resolve.js';
import { formatDue } from '../../time/format.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';
import { escapeHtml } from './escape.js';

export interface EditMenuRender {
  text: string;
  buttons: Buttons;
}

export type Priority = 'low' | 'normal' | 'high';

const PRIORITY_LABEL: Record<Priority, string> = {
  low: texts.proposalCard.priorityLow,
  normal: texts.proposalCard.priorityNormal,
  high: texts.proposalCard.priorityHigh,
};

export function formatPriorityLabel(priority: Priority): string {
  return PRIORITY_LABEL[priority];
}

/** `assignee.type === 'user'`'s display name comes from `memberNameByUserId` — an unknown id (should not
 * happen; every `user` assignee this dialog can produce comes from that same map) falls back to the
 * "unassigned" label rather than showing nothing. */
export function formatAssigneeLabel(
  assignee: AssigneeResolution,
  memberNameByUserId: ReadonlyMap<number, string>,
): string {
  switch (assignee.type) {
    case 'all':
      return texts.proposalCard.assigneeAll;
    case 'none':
      return texts.proposalCard.assigneeNone;
    case 'text':
      return assignee.name;
    case 'user':
      return memberNameByUserId.get(assignee.userId) ?? texts.proposalCard.assigneeNone;
  }
}

export interface EditDraftView {
  title: string;
  /** Already resolved to a display label (`formatAssigneeLabel`), unescaped. */
  assignee: string;
  due: { at: Date; allDay: boolean; tz: string | null } | null;
  priority: Priority;
  description: string | null;
}

function button(proposalId: number, text: string, action: string, arg?: string): Buttons[number][number] {
  return {
    text,
    data: encodeCallback({ entity: 'p', action, id: proposalId, ...(arg !== undefined ? { arg } : {}) }),
  };
}

/** The dialog's main menu: a mini card recapping the current draft, then one button per editable field. */
export function renderEditMenu(proposalId: number, view: EditDraftView, viewerZone: string): EditMenuRender {
  const dueLabel = texts.formatDue(formatDue(view.due, viewerZone));
  const description = view.description === null ? null : escapeHtml(view.description);

  const text = [
    texts.editProposal.menuHeader,
    texts.proposalCard.titleLine(escapeHtml(view.title)),
    texts.proposalCard.metaLine(escapeHtml(view.assignee), dueLabel, PRIORITY_LABEL[view.priority]),
    texts.editProposal.descriptionLine(description),
  ].join('\n');

  const b = (label: string, action: string): Buttons[number][number] => button(proposalId, label, action);

  return {
    text,
    buttons: [
      [b(texts.editProposal.fieldTitleButton, 'etl'), b(texts.editProposal.fieldAssigneeButton, 'eas')],
      [b(texts.editProposal.fieldDueButton, 'edu'), b(texts.editProposal.fieldPriorityButton, 'epr')],
      [b(texts.editProposal.fieldDescriptionButton, 'edc')],
      [b(texts.editProposal.saveButton, 'esv')],
      [b(texts.editProposal.backButton, 'ebk')],
    ],
  };
}

/** The assignee submenu: one button per real workspace member (`aus:<userId>`, brief's "real workspace
 * members"), then the self/unassigned/everyone shortcuts (`ame`/`ano`/`aal`). `members` excludes the
 * Owner themselves — `ame` already covers assigning to the Owner (this dialog is Owner-only, D40). */
export function renderAssigneeMenu(
  proposalId: number,
  members: ReadonlyArray<{ userId: number; name: string }>,
): EditMenuRender {
  const memberRows = members.map((m) => [button(proposalId, escapeHtml(m.name), 'aus', String(m.userId))]);

  return {
    text: texts.editProposal.assigneeMenuTitle,
    buttons: [
      ...memberRows,
      [button(proposalId, texts.editProposal.assigneeSelfButton, 'ame')],
      [
        button(proposalId, texts.proposalCard.assigneeNone, 'ano'),
        button(proposalId, texts.proposalCard.assigneeAll, 'aal'),
      ],
    ],
  };
}

/** The due-date submenu (D23): four quick-pick dates, "no due date", and free-text entry. */
export function renderDueMenu(proposalId: number): EditMenuRender {
  const b = (label: string, action: string): Buttons[number][number] => button(proposalId, label, action);

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

/** The free-text date preview — the due-date submenu's own confirm step. `label` is `texts.formatDue`'s
 * output for the phrase `parseDateText` resolved. */
export function renderDuePreview(proposalId: number, label: string): EditMenuRender {
  return {
    text: texts.editProposal.duePreview(label),
    buttons: [
      [
        button(proposalId, texts.editProposal.yesButton, 'dok'),
        button(proposalId, texts.editProposal.noButton, 'dca'),
      ],
    ],
  };
}

/** The priority submenu. */
export function renderPriorityMenu(proposalId: number): EditMenuRender {
  return {
    text: texts.editProposal.priorityMenuTitle,
    buttons: [
      [
        button(proposalId, PRIORITY_LABEL.low, 'plo'),
        button(proposalId, PRIORITY_LABEL.normal, 'pno'),
        button(proposalId, PRIORITY_LABEL.high, 'phi'),
      ],
    ],
  };
}
