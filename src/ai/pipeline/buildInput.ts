import { DateTime } from 'luxon';
import {
  MAX_ANALYSIS_TEXT_CHARS,
  PROMPT_MAX_OPEN_TASKS,
  PROMPT_MAX_OPEN_PROPOSALS,
  CONTEXT_MESSAGES,
  PROMPT_LABELS,
} from '../../config/constants.js';
import { pseudonymizeText, type ParticipantForLlm } from '../pseudonymize.js';
import type { PromptBundle } from '../prompts.js';
import { renderTemplate } from '../prompts.js';

// SPEC §9.3 — an already-resolved assignee for an *existing* open task or
// proposal fed back into the extractor's input, ready to render as
// `P#`/`OWNER`/`ALL`. This is local to the input-formatting step in this
// file: Task 2.6's `resolve.ts` introduces its own, differently-shaped
// `AssigneeResolution` for the model's *output* refs (it carries a raw
// `userId` before it is mapped to a participant code, plus a `text` variant
// for an unmatched name) — the two are unrelated despite the shared name.
export type AssigneeResolution =
  { kind: 'participant'; code: string } | { kind: 'owner' } | { kind: 'all' } | { kind: 'none' };

export interface OpenTaskForLlm {
  id: number;
  title: string;
  assignee: AssigneeResolution;
  dueAt: Date | null;
  dueAllDay: boolean;
}

export interface OpenProposalForLlm {
  id: number;
  title: string;
  kind: string;
  targetTaskId: number | null;
}

export interface MessageForLlm {
  id: number;
  sentAt: Date;
  authorUserId: number;
  authorTz: string | null;
  text: string;
  replyToMessageId: number | null;
  replyQuote: string | null;
  isForward: boolean;
  forwardOriginName: string | null;
  forwardOriginUserId: number | null;
}

export interface RefMaps {
  messages: Map<string, number>;
  participants: Map<string, number>;
  tasks: Map<string, number>;
  proposals: Map<string, number>;
}

export interface ExtractionInput {
  promptVersion: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  refs: RefMaps;
}

const DASH = '—';

function truncateText(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join('')}…`;
}

function formatParticipant(p: ParticipantForLlm): string {
  const head = p.isOwner ? `${p.code}/OWNER` : p.code;
  if (p.isOwner) return `${head}: ${p.displayName} (${PROMPT_LABELS.owner})`;
  if (p.aliases.length > 0)
    return `${head}: ${p.displayName} (${PROMPT_LABELS.aliases}: ${p.aliases.join(', ')})`;
  return `${head}: ${p.displayName}`;
}

function assigneeCode(assignee: AssigneeResolution): string | null {
  switch (assignee.kind) {
    case 'participant':
      return assignee.code;
    case 'owner':
      return 'OWNER';
    case 'all':
      return 'ALL';
    case 'none':
      return null;
  }
}

function formatDue(dueAt: Date, allDay: boolean, zone: string): string {
  const dt = DateTime.fromJSDate(dueAt).setZone(zone);
  return dt.toFormat(allDay ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm');
}

function formatOpenTask(task: OpenTaskForLlm, workspaceTz: string): string {
  const parts = [`«${task.title}»`];
  const code = assigneeCode(task.assignee);
  if (code !== null) parts.push(code);
  parts.push(
    task.dueAt === null
      ? PROMPT_LABELS.noDue
      : `${PROMPT_LABELS.due} ${formatDue(task.dueAt, task.dueAllDay, workspaceTz)}`,
  );
  return `T${task.id}: ${parts.join(' · ')}`;
}

function formatOpenProposal(proposal: OpenProposalForLlm): string {
  const target = proposal.targetTaskId === null ? '' : ` → T${proposal.targetTaskId}`;
  return `R${proposal.id}: «${proposal.title}» · ${proposal.kind}${target}`;
}

function findParticipantCode(userId: number, participants: readonly ParticipantForLlm[]): string {
  const found = participants.find((p) => p.userId === userId);
  if (!found) {
    throw new Error(`buildExtractionInput: no participant projection for author userId=${userId}`);
  }
  return found.code;
}

function formatReplySegment(
  message: MessageForLlm,
  dbIdToRef: ReadonlyMap<number, string>,
  participants: readonly ParticipantForLlm[],
): string | null {
  if (message.replyToMessageId === null) return null;
  const ref = dbIdToRef.get(message.replyToMessageId);
  if (ref !== undefined) return `${PROMPT_LABELS.replyTo} ${ref}`;
  if (message.replyQuote !== null)
    return `${PROMPT_LABELS.replyTo} «${pseudonymizeText(message.replyQuote, participants)}»`;
  return null;
}

function formatForwardSegment(
  message: MessageForLlm,
  participants: readonly ParticipantForLlm[],
): string | null {
  if (!message.isForward) return null;
  if (message.forwardOriginUserId !== null) {
    const found = participants.find((p) => p.userId === message.forwardOriginUserId);
    if (found) return `${PROMPT_LABELS.forwardedFrom} ${found.code}`;
  }
  if (message.forwardOriginName !== null)
    return `${PROMPT_LABELS.forwardedFrom} «${message.forwardOriginName}»`;
  return null;
}

/**
 * Renders one `M#`/`M-ctx-#` line (SPEC §9.3). `dbIdToRef` must already hold
 * refs for every message this one could reply to — callers format context
 * messages before new ones, and within each list in chronological order, so
 * a reply's target (always earlier in time) is always already in the map.
 */
function formatMessageLine(
  ref: string,
  message: MessageForLlm,
  workspaceTz: string,
  participants: readonly ParticipantForLlm[],
  dbIdToRef: ReadonlyMap<number, string>,
): string {
  const zone = message.authorTz ?? workspaceTz;
  const dt = DateTime.fromJSDate(message.sentAt).setZone(zone).toFormat('yyyy-MM-dd HH:mm');
  const code = findParticipantCode(message.authorUserId, participants);

  const bracket = [dt, code];
  const reply = formatReplySegment(message, dbIdToRef, participants);
  if (reply !== null) bracket.push(reply);
  const forward = formatForwardSegment(message, participants);
  if (forward !== null) bracket.push(forward);
  if (message.authorTz !== null && message.authorTz !== workspaceTz)
    bracket.push(`${PROMPT_LABELS.zone} ${message.authorTz}`);

  const text = truncateText(pseudonymizeText(message.text, participants), MAX_ANALYSIS_TEXT_CHARS);
  return `${ref} [${bracket.join(', ')}]: ${text}`;
}

/**
 * Assembles one extractor request (SPEC §9.3): renders the participants,
 * open tasks/proposals and message lines into the prompt's data template,
 * applies the limits from `src/config/constants.ts` (D27's caps on how much
 * context ever reaches the model), and returns the ref maps that later
 * pipeline steps (Task 2.6) use to turn the model's `M#`/`P#`/`T#`/`R#` refs
 * back into real IDs.
 */
export function buildExtractionInput(
  args: {
    now: Date;
    workspaceTz: string;
    participants: ParticipantForLlm[];
    openTasks: OpenTaskForLlm[];
    openProposals: OpenProposalForLlm[];
    context: MessageForLlm[];
    messages: MessageForLlm[];
  },
  prompt: PromptBundle,
): ExtractionInput {
  const tasks = args.openTasks.slice(0, PROMPT_MAX_OPEN_TASKS);
  const proposals = args.openProposals.slice(0, PROMPT_MAX_OPEN_PROPOSALS);
  const context = args.context.slice(0, CONTEXT_MESSAGES);

  const refs: RefMaps = {
    messages: new Map(),
    participants: new Map(),
    tasks: new Map(),
    proposals: new Map(),
  };
  for (const p of args.participants) refs.participants.set(p.code, p.userId);
  for (const t of tasks) refs.tasks.set(`T${t.id}`, t.id);
  for (const p of proposals) refs.proposals.set(`R${p.id}`, p.id);

  const dbIdToRef = new Map<number, string>();
  const contextLines: string[] = [];
  context.forEach((message, index) => {
    const ref = `M-ctx-${index + 1}`;
    dbIdToRef.set(message.id, ref);
    refs.messages.set(ref, message.id);
    contextLines.push(formatMessageLine(ref, message, args.workspaceTz, args.participants, dbIdToRef));
  });

  const newLines: string[] = [];
  args.messages.forEach((message, index) => {
    const ref = `M${index + 1}`;
    dbIdToRef.set(message.id, ref);
    refs.messages.set(ref, message.id);
    newLines.push(formatMessageLine(ref, message, args.workspaceTz, args.participants, dbIdToRef));
  });

  const nowLocal = DateTime.fromJSDate(args.now).setZone(args.workspaceTz);
  const vars: Record<string, string> = {
    now_local: nowLocal.toFormat('yyyy-MM-dd HH:mm'),
    weekday: nowLocal.setLocale('ru').toFormat('cccc'),
    workspace_tz: args.workspaceTz,
    participants: args.participants.map(formatParticipant).join('\n'),
    open_tasks: tasks.length > 0 ? tasks.map((t) => formatOpenTask(t, args.workspaceTz)).join('\n') : DASH,
    open_proposals: proposals.length > 0 ? proposals.map(formatOpenProposal).join('\n') : DASH,
    context_messages: contextLines.length > 0 ? contextLines.join('\n') : DASH,
    new_messages: newLines.length > 0 ? newLines.join('\n') : DASH,
  };

  const userContent = renderTemplate(prompt.userTemplate, vars);

  return {
    promptVersion: prompt.version,
    messages: [
      { role: 'system', content: prompt.system },
      ...prompt.examples.flatMap((example) => [
        { role: 'user' as const, content: example.user },
        { role: 'assistant' as const, content: example.assistant },
      ]),
      { role: 'user', content: userContent },
    ],
    refs,
  };
}
