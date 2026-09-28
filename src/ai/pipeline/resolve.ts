import type { ActionT, ExtractionResultT } from '../schemas.js';
import type { RefMaps } from './buildInput.js';
import { resolveDue, type FuzzyTimes, type ResolvedDue } from '../../time/resolveDue.js';

type CreateAction = Extract<ActionT, { type: 'create' }>;
type UpdateAction = Extract<ActionT, { type: 'update' }>;

/**
 * Resolves the model's *output* refs (`assignee_ref`/`assignee_name_text`,
 * SPEC §9.5-9.6) into a concrete assignee: a real `userId`, the `all`
 * marker, an unmatched free-text name, or `none`. `buildInput.ts` exports a
 * differently-shaped `AssigneeResolution` for the opposite direction —
 * rendering an *already-resolved* assignee of an existing open task back
 * into the prompt as `P#`/`OWNER`/`ALL` — the two types are unrelated
 * despite sharing a name; do not import one where the other is meant.
 */
export type AssigneeResolution =
  { type: 'user'; userId: number } | { type: 'all' } | { type: 'text'; name: string } | { type: 'none' };

export type Category = 'assignment' | 'event' | 'owner_intent' | 'commitment' | 'request_to_owner';

interface Common {
  sourceMessageIds: number[];
  confidence: number;
  reasoning: string;
}

export type ResolvedAction =
  | ({
      kind: 'create';
      category: Category;
      title: string;
      description: string | null;
      assignee: AssigneeResolution;
      due: ResolvedDue;
      priority: 'low' | 'normal' | 'high';
    } & Common)
  | ({
      kind: 'update';
      target: { taskId: number } | { proposalId: number };
      changes: { due?: ResolvedDue; assignee?: AssigneeResolution; title?: string };
    } & Common)
  | ({ kind: 'complete' | 'cancel'; target: { taskId: number } | { proposalId: number } } & Common);

export interface ResolveContext {
  refs: RefMaps;
  messages: Map<
    number,
    { authorUserId: number; authorTz: string | null; replyToAuthorUserId: number | null }
  >;
  ownerUserId: number;
  workspaceTz: string;
  now: Date;
  fuzzy: FuzzyTimes;
}

/**
 * Default-assignee rule (SPEC §9.6, applied when `assignee_ref` is absent):
 * `commitment` goes to the author of the first source message, `owner_intent`
 * and `request_to_owner` go to the workspace owner, `assignment` in reply to
 * someone goes to that person, and everything else (a bare `assignment`,
 * `event`) is left unassigned rather than guessed.
 */
export function defaultAssignee(
  category: Category,
  ctx: { authorUserId: number; replyToAuthorUserId: number | null; ownerUserId: number },
): AssigneeResolution {
  switch (category) {
    case 'commitment':
      return { type: 'user', userId: ctx.authorUserId };
    case 'request_to_owner':
    case 'owner_intent':
      return { type: 'user', userId: ctx.ownerUserId };
    case 'assignment':
      return ctx.replyToAuthorUserId === null
        ? { type: 'none' }
        : { type: 'user', userId: ctx.replyToAuthorUserId };
    case 'event':
      return { type: 'none' };
  }
}

/** Keeps only the `M#` refs known to this batch, preserving their original order. */
function resolveMessageIds(refsIn: readonly string[], refs: RefMaps): number[] {
  const ids: number[] = [];
  for (const ref of refsIn) {
    const id = refs.messages.get(ref);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** `T#` → an open task id, `R#` → an open proposal id; `null` when the ref is not in this batch (hallucinated). */
function resolveTarget(targetRef: string, refs: RefMaps): { taskId: number } | { proposalId: number } | null {
  if (targetRef.startsWith('T')) {
    const id = refs.tasks.get(targetRef);
    return id === undefined ? null : { taskId: id };
  }
  const id = refs.proposals.get(targetRef);
  return id === undefined ? null : { proposalId: id };
}

function requireMessageInfo(
  id: number,
  messages: ResolveContext['messages'],
): { authorUserId: number; authorTz: string | null; replyToAuthorUserId: number | null } {
  const info = messages.get(id);
  if (info === undefined) {
    throw new Error(`resolveActions: ResolveContext.messages is missing an entry for message id=${id}`);
  }
  return info;
}

type AssigneeRefResolution =
  { kind: 'resolved'; value: AssigneeResolution } | { kind: 'unknown'; ref: string } | { kind: 'absent' };

/** `OWNER`/`ALL`/a known `P#` resolve directly; an unrecognized `P#` is `unknown`; `null`/`undefined` is `absent`. */
function resolveAssigneeRef(
  ref: string | null | undefined,
  refs: RefMaps,
  ownerUserId: number,
): AssigneeRefResolution {
  if (ref === undefined || ref === null) return { kind: 'absent' };
  if (ref === 'OWNER') return { kind: 'resolved', value: { type: 'user', userId: ownerUserId } };
  if (ref === 'ALL') return { kind: 'resolved', value: { type: 'all' } };
  const userId = refs.participants.get(ref);
  return userId === undefined
    ? { kind: 'unknown', ref }
    : { kind: 'resolved', value: { type: 'user', userId } };
}

/**
 * A hallucinated `assignee_ref` (SPEC §9.5's guard against model
 * hallucinations) is not fatal — unlike an unknown message/target ref it does not drop the
 * action, since CLAUDE.md ranks a missed task above a false positive. It
 * only falls back to the default-assignee rule, and is worth a diagnostic:
 * this module is a pure pipeline step with no injected `Logger` (see
 * `ResolveContext`), so `console.warn` is used directly; the message carries
 * only a ref code and an action index, never message text or a name.
 */
function warnUnknownAssigneeRef(actionIndex: number, ref: string): void {
  console.warn(
    `resolveActions: unknown assignee ref "${ref}" at action index ${actionIndex}, falling back to the default assignee rule`,
  );
}

function resolveCreateAssignee(
  action: CreateAction,
  index: number,
  ctx: ResolveContext,
  firstMessage: { authorUserId: number; replyToAuthorUserId: number | null },
): AssigneeResolution {
  const refResolution = resolveAssigneeRef(action.assignee_ref, ctx.refs, ctx.ownerUserId);
  if (refResolution.kind === 'resolved') return refResolution.value;
  if (refResolution.kind === 'unknown') {
    warnUnknownAssigneeRef(index, refResolution.ref);
    return defaultAssignee(action.category, { ...firstMessage, ownerUserId: ctx.ownerUserId });
  }
  if (action.assignee_name_text !== null) return { type: 'text', name: action.assignee_name_text };
  return defaultAssignee(action.category, { ...firstMessage, ownerUserId: ctx.ownerUserId });
}

/**
 * `update.changes.assignee_ref`, unlike `create`'s, has no `category` to
 * fall back on — a hallucinated ref there is warned about and the change is
 * simply skipped (the assignee is left unchanged), same as when no ref was
 * requested at all.
 */
function resolveUpdateAssigneeChange(
  changeRef: string | null | undefined,
  index: number,
  ctx: ResolveContext,
): AssigneeResolution | undefined {
  const refResolution = resolveAssigneeRef(changeRef, ctx.refs, ctx.ownerUserId);
  if (refResolution.kind === 'resolved') return refResolution.value;
  if (refResolution.kind === 'unknown') warnUnknownAssigneeRef(index, refResolution.ref);
  return undefined;
}

function resolveUpdateChanges(
  action: UpdateAction,
  index: number,
  ctx: ResolveContext,
  zone: string,
): { due?: ResolvedDue; assignee?: AssigneeResolution; title?: string } {
  const changes: { due?: ResolvedDue; assignee?: AssigneeResolution; title?: string } = {};
  if (action.changes.due !== undefined) {
    changes.due = resolveDue(action.changes.due, { zone, now: ctx.now, fuzzy: ctx.fuzzy });
  }
  const assignee = resolveUpdateAssigneeChange(action.changes.assignee_ref, index, ctx);
  if (assignee !== undefined) changes.assignee = assignee;
  if (action.changes.title !== undefined) changes.title = action.changes.title;
  return changes;
}

/**
 * Turns the extractor's raw output (Task 2.1's `ExtractionResultT`) into
 * real IDs and values (plan.md Task 2.6, SPEC §9.5-9.6, §10): `M#` source
 * refs are filtered to the ones known in this batch (an action left with
 * none is dropped, `unknown_message_refs`); `T#`/`R#` target refs that
 * aren't in this batch drop the action too (`unknown_target`); assignee
 * refs and due dates are resolved against the first surviving source
 * message's author (SPEC §10.1's timezone rule). Nothing here calls
 * `Date.now()`/`new Date()` — `ctx.now` is the only source of "now"
 * (CLAUDE.md §8).
 */
export function resolveActions(
  result: ExtractionResultT,
  ctx: ResolveContext,
): { actions: ResolvedAction[]; dropped: Array<{ index: number; reason: string }> } {
  const actions: ResolvedAction[] = [];
  const dropped: Array<{ index: number; reason: string }> = [];

  result.actions.forEach((action, index) => {
    const sourceMessageIds = resolveMessageIds(action.source_message_ids, ctx.refs);
    const firstMessageId = sourceMessageIds[0];
    if (firstMessageId === undefined) {
      dropped.push({ index, reason: 'unknown_message_refs' });
      return;
    }

    const firstMessage = requireMessageInfo(firstMessageId, ctx.messages);
    const zone = firstMessage.authorTz ?? ctx.workspaceTz;
    const common: Common = {
      sourceMessageIds,
      confidence: action.confidence,
      reasoning: action.reasoning,
    };

    if (action.type === 'create') {
      const assignee = resolveCreateAssignee(action, index, ctx, firstMessage);
      const due = resolveDue(action.due, { zone, now: ctx.now, fuzzy: ctx.fuzzy });
      actions.push({
        kind: 'create',
        category: action.category,
        title: action.title,
        description: action.description,
        assignee,
        due,
        priority: action.priority,
        ...common,
      });
      return;
    }

    const target = resolveTarget(action.target_ref, ctx.refs);
    if (target === null) {
      dropped.push({ index, reason: 'unknown_target' });
      return;
    }

    if (action.type === 'update') {
      const changes = resolveUpdateChanges(action, index, ctx, zone);
      actions.push({ kind: 'update', target, changes, ...common });
      return;
    }

    actions.push({ kind: action.type, target, ...common });
  });

  return { actions, dropped };
}
