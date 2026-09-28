import type { Buttons } from '../../domain/messenger.js';
import type { AssigneeResolution, Category } from '../../ai/pipeline/resolve.js';
import { QUOTE_MAX_CHARS, TELEGRAM_TEXT_LIMIT } from '../../config/constants.js';
import { formatDue } from '../../time/format.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';
import { escapeHtml } from './escape.js';

export interface ProposalCardView {
  id: number;
  kind: 'create' | 'update' | 'complete' | 'cancel';
  /** Carried through for future per-category rendering; SPEC §11.1's card format doesn't vary by category today, only by `kind`/`manual`. */
  category: Category | 'manual' | null;
  confidence: number;
  manual: boolean;
  title: string;
  assigneeName: string | null;
  assigneeKind: AssigneeResolution['type'];
  due: { at: Date; allDay: boolean; tz: string | null } | null;
  priority: 'low' | 'normal' | 'high';
  quote: string | null;
  quoteAuthor: string | null;
  chatTitle: string | null;
  /** `bot/views/links.ts`'s `messageLink` output, computed by the caller. */
  link: string | null;
  dueInPast: boolean;
  duplicateOf: { taskId: number; title: string } | null;
  target: {
    taskId: number;
    title: string;
    before: string | null;
    after: string | null;
    field: 'due' | 'assignee' | 'title' | null;
  } | null;
}

export interface ProposalCardRender {
  text: string;
  buttons: Buttons;
}

/** SPEC §19.5/D-table: a quote is truncated to `QUOTE_MAX_CHARS` **before** escaping (never after — escaping can only grow the string). */
function truncateQuote(quote: string): string {
  return quote.length > QUOTE_MAX_CHARS ? `${quote.slice(0, QUOTE_MAX_CHARS)}…` : quote;
}

const PRIORITY_LABEL: Record<ProposalCardView['priority'], string> = {
  low: texts.proposalCard.priorityLow,
  normal: texts.proposalCard.priorityNormal,
  high: texts.proposalCard.priorityHigh,
};

/** `assigneeKind` decides the label for the `all`/`none` markers; `user`/`text` show the resolved/typed name, escaped. */
function assigneeLabel(v: ProposalCardView): string {
  if (v.assigneeKind === 'all') return texts.proposalCard.assigneeAll;
  if (v.assigneeKind === 'none') return texts.proposalCard.assigneeNone;
  return v.assigneeName === null ? texts.proposalCard.assigneeNone : escapeHtml(v.assigneeName);
}

function updateFieldLabel(field: 'due' | 'assignee' | 'title' | null): string {
  switch (field) {
    case 'due':
      return texts.proposalCard.updateFieldDue;
    case 'assignee':
      return texts.proposalCard.updateFieldAssignee;
    case 'title':
      return texts.proposalCard.updateFieldTitle;
    case null:
      return texts.proposalCard.updateFieldGeneric;
  }
}

/** `create`-kind body: header, title, assignee/due/priority, optional past-due/duplicate hints, quote, link (SPEC §11.1). */
function renderCreateBody(v: ProposalCardView, viewerZone: string): string[] {
  const lines = [
    v.manual ? texts.proposalCard.headerManual : texts.proposalCard.headerAi(Math.round(v.confidence * 100)),
    texts.proposalCard.titleLine(escapeHtml(v.title)),
    texts.proposalCard.metaLine(
      assigneeLabel(v),
      texts.formatDue(formatDue(v.due, viewerZone)),
      PRIORITY_LABEL[v.priority],
    ),
  ];

  if (v.dueInPast) lines.push(texts.proposalCard.pastDueWarning);
  if (v.duplicateOf !== null) {
    lines.push(texts.proposalCard.duplicateHint(v.duplicateOf.taskId, escapeHtml(v.duplicateOf.title)));
  }
  if (v.quote !== null) {
    const quote = escapeHtml(truncateQuote(v.quote));
    const author = v.quoteAuthor === null ? null : escapeHtml(v.quoteAuthor);
    const chatTitle = v.chatTitle === null ? null : escapeHtml(v.chatTitle);
    lines.push(texts.proposalCard.quoteLine(quote, author, chatTitle));
  }
  if (v.link !== null) lines.push(texts.proposalCard.linkLine(escapeHtml(v.link)));

  return lines;
}

/** `update`-kind body: one summary line (SPEC §11.1's "field changed" line), plus a past-due warning if the new due date is itself in the past. */
function renderUpdateBody(v: ProposalCardView): string[] {
  const target = v.target;
  if (target === null) throw new Error('renderProposalCard: kind "update" requires a target');

  const before = target.before === null ? null : escapeHtml(target.before);
  const after = target.after === null ? null : escapeHtml(target.after);
  const line = texts.proposalCard.updateLine(
    updateFieldLabel(target.field),
    target.taskId,
    escapeHtml(target.title),
    before,
    after,
  );

  return v.dueInPast ? [line, texts.proposalCard.pastDueWarning] : [line];
}

/** `complete`-kind body: one summary line (SPEC §11.1's "looks done" line). */
function renderCompleteBody(v: ProposalCardView): string[] {
  const target = v.target;
  if (target === null) throw new Error('renderProposalCard: kind "complete" requires a target');

  const quote = v.quote === null ? null : escapeHtml(truncateQuote(v.quote));
  const author = v.quoteAuthor === null ? null : escapeHtml(v.quoteAuthor);
  return [texts.proposalCard.completeLine(target.taskId, escapeHtml(target.title), quote, author)];
}

/** `cancel`-kind body: one summary line, same shape as `complete` (SPEC §11.1: "analogous" to complete's line). */
function renderCancelBody(v: ProposalCardView): string[] {
  const target = v.target;
  if (target === null) throw new Error('renderProposalCard: kind "cancel" requires a target');

  const quote = v.quote === null ? null : escapeHtml(truncateQuote(v.quote));
  const author = v.quoteAuthor === null ? null : escapeHtml(v.quoteAuthor);
  return [texts.proposalCard.cancelLine(target.taskId, escapeHtml(target.title), quote, author)];
}

/**
 * Buttons for `v.kind` (SPEC §11.1), plus an extra `duplicateButton` row when
 * `duplicateOf` is set. `create`'s decline opens the reject-reason menu
 * (`v1:p:rjr:<id>:nt|dup|done|oth`, built by a later task); `update`'s
 * `ignoreButton` and `complete`/`cancel`'s `noButton` reuse the same `rej`
 * action as a plain decline, since all four ultimately call the one
 * `rejectProposal` (Task 2.13) — only `create`'s handler additionally shows
 * the reason menu first. Likewise `update`/`complete`/`cancel`'s "accept"
 * buttons all reuse `apl`, matching Task 2.13's single `applyModification`
 * covering all three kinds.
 */
function buttonsFor(v: ProposalCardView): Buttons {
  const id = v.id;
  const rows: Buttons = [];

  switch (v.kind) {
    case 'create':
      rows.push([
        { text: texts.proposalCard.acceptButton, data: encodeCallback({ entity: 'p', action: 'acc', id }) },
        { text: texts.proposalCard.editButton, data: encodeCallback({ entity: 'p', action: 'edt', id }) },
        { text: texts.proposalCard.rejectButton, data: encodeCallback({ entity: 'p', action: 'rej', id }) },
      ]);
      break;
    case 'update':
      rows.push([
        { text: texts.proposalCard.applyButton, data: encodeCallback({ entity: 'p', action: 'apl', id }) },
        { text: texts.proposalCard.editButton, data: encodeCallback({ entity: 'p', action: 'edt', id }) },
        { text: texts.proposalCard.ignoreButton, data: encodeCallback({ entity: 'p', action: 'rej', id }) },
      ]);
      break;
    case 'complete':
      rows.push([
        {
          text: texts.proposalCard.closeTaskButton,
          data: encodeCallback({ entity: 'p', action: 'apl', id }),
        },
        { text: texts.proposalCard.noButton, data: encodeCallback({ entity: 'p', action: 'rej', id }) },
      ]);
      break;
    case 'cancel':
      rows.push([
        {
          text: texts.proposalCard.cancelTaskButton,
          data: encodeCallback({ entity: 'p', action: 'apl', id }),
        },
        { text: texts.proposalCard.noButton, data: encodeCallback({ entity: 'p', action: 'rej', id }) },
      ]);
      break;
  }

  if (v.duplicateOf !== null) {
    rows.push([
      {
        text: texts.proposalCard.duplicateButton(v.duplicateOf.taskId),
        data: encodeCallback({ entity: 'p', action: 'dup', id, arg: String(v.duplicateOf.taskId) }),
      },
    ]);
  }

  return rows;
}

/**
 * Pure render for a proposal card (SPEC §11.1, Task 2.11). No DB, no I/O
 * (CLAUDE.md §7) — the caller resolves `v` (including `dueInPast` and
 * `link`) beforehand. `text.slice(0, TELEGRAM_TEXT_LIMIT)` is a defensive
 * backstop only: with the quote capped at `QUOTE_MAX_CHARS` and the title
 * capped at 120 chars upstream (Task 2.13's `TaskService.create`), a card
 * never actually approaches Telegram's 4096-char limit.
 */
export function renderProposalCard(v: ProposalCardView, viewerZone: string): ProposalCardRender {
  const bodyLines =
    v.kind === 'create'
      ? renderCreateBody(v, viewerZone)
      : v.kind === 'update'
        ? renderUpdateBody(v)
        : v.kind === 'complete'
          ? renderCompleteBody(v)
          : renderCancelBody(v);

  return {
    text: bodyLines.join('\n').slice(0, TELEGRAM_TEXT_LIMIT),
    buttons: buttonsFor(v),
  };
}
