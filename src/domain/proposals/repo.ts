import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx, Tx } from '../../db/client.js';
import { proposals } from '../../db/schema/index.js';
import type { AssigneeResolution, Category, ResolvedAction } from '../../ai/pipeline/resolve.js';
import type { ResolvedDue } from '../../time/resolveDue.js';

/**
 * `proposals.category`'s full DB range (plan.md Task 3.10): `'manual'` is a sibling of {@link Category},
 * not a member of it — the same ad hoc widening `src/scheduler/jobs/cards.ts`'s own
 * `ProposalCardView.category` already anticipated (`Category | 'manual' | null`) before this task ever
 * wrote a `'manual'` row. `ai/pipeline/resolve.ts`'s `Category` stays the AI extractor's own 5-value
 * categorization and is not touched by this widening.
 */
export type ProposalCategoryColumn = Category | 'manual';

export type ProposalRow = typeof proposals.$inferSelect;

/** `due`/`changes.due` as persisted inside `payload` — `ResolvedDue` with `dueAt` serialized to ISO (jsonb has no `Date` type) and `dueText` lifted out to the payload's own top-level field (plan.md Task 2.10's payload shape). */
export interface ProposalPayloadDue {
  dueAt: string | null;
  allDay: boolean;
  tz: string | null;
  inPast: boolean;
  invalid: boolean;
}

/** A possible duplicate flagged by `findPossibleDuplicate` (`src/ai/pipeline/dedup.ts`), stripped of `similarity` — display-only, SPEC §9.7.2. */
export interface ProposalPayloadDuplicate {
  type: 'task' | 'proposal';
  id: number;
  title: string;
}

/** One field's before/after pair, already rendered as a display string (plan.md Task 2.14's `ownerEdits`, SPEC §20.4). */
export interface ProposalPayloadOwnerEdit {
  before: string | null;
  after: string | null;
}

/**
 * `proposals.payload` (jsonb, plan.md Task 2.10's brief): the card-facing
 * projection of one `ResolvedAction` (`src/ai/pipeline/resolve.ts`) plus the
 * bookkeeping `processBatch` (`src/ai/pipeline/processBatch.ts`) adds on
 * top. `title`/`description`/`category`/`assignee`/`due`/`dueText`/
 * `priority` are only ever set for `kind='create'`; `changes` only for
 * `kind='update'`. `targetProposalId` is this repo's own addition, not
 * named in the brief's payload shape: `proposals.target_task_id` (the only
 * target column the schema has) cannot hold a *proposal* id, so an
 * `update`/`complete`/`cancel` action whose `ResolvedAction.target` is
 * `{ proposalId }` (SPEC §9.6 — amending/completing a still-pending
 * proposal, not yet a task) would otherwise be silently dropped; recording
 * it here instead keeps CLAUDE.md's "a missed task is worse than a false
 * positive" — Task 2.11/2.13 are expected to read it back when they need to
 * act on that target.
 */
export interface ProposalPayload {
  title?: string;
  description?: string | null;
  category?: Category;
  assignee?: AssigneeResolution;
  due?: ProposalPayloadDue | null;
  dueText?: string | null;
  priority?: 'low' | 'normal' | 'high';
  reasoning: string;
  duplicateOf?: ProposalPayloadDuplicate;
  changes?: {
    due?: ProposalPayloadDue;
    assignee?: AssigneeResolution;
    title?: string;
  };
  targetProposalId?: number;
  origin: 'ai' | 'manual_group' | 'manual_dm' | 'forward';
  noReaction?: boolean;
  quote: string | null;
  quoteAuthorName: string | null;
  /**
   * Fields the Owner changed in the editProposal dialog (`src/bot/conversations/editProposal.ts`, plan.md
   * Task 2.14) before accepting, keyed by field name (`title`/`assignee`/`due`/`priority`/`description`) —
   * SPEC §20.4's before/after pairs. Written by `editProposal.ts` itself, in a best-effort follow-up write
   * after `acceptProposal` (`src/domain/proposals/decide.ts`) has already succeeded — never by
   * `acceptProposal` itself, which predates this field and is not touched by this task. Absent when the
   * proposal was accepted with no edits, or was never accepted via that dialog at all.
   */
  ownerEdits?: Record<string, ProposalPayloadOwnerEdit>;
}

export interface NewProposal {
  workspaceId: number;
  chatId: number | null;
  batchId: number | null;
  kind: 'create' | 'update' | 'complete' | 'cancel';
  category: ProposalCategoryColumn | null;
  payload: ProposalPayload;
  targetTaskId: number | null;
  confidence: number;
  policyDecision: 'shown' | 'suppressed';
  policyReason: string;
  sourceMessageIds: number[];
  /** CLAUDE.md: `ai/`/`domain/` code takes "now" only from `deps.clock.now()`, never the column's own `defaultNow()` — the caller (`processBatch`) passes its already-captured `now` through here. */
  createdAt: Date;
}

/**
 * Inserts one proposal row (plan.md Task 2.10). Takes a transaction
 * (`Tx`), never a plain `Db`: every call site (`processBatch`) writes
 * proposals, messages and the batch row together as one atomic unit (SPEC
 * §9.7/§8) — see `processBatch`'s doc comment for why a failure partway
 * through that unit must roll every earlier `insertProposal` call in the
 * same batch back too, not just skip the rest.
 */
export async function insertProposal(tx: Tx, p: NewProposal): Promise<ProposalRow> {
  const [row] = await tx
    .insert(proposals)
    .values({
      workspaceId: p.workspaceId,
      chatId: p.chatId,
      batchId: p.batchId,
      kind: p.kind,
      category: p.category,
      payload: p.payload,
      targetTaskId: p.targetTaskId,
      confidence: p.confidence,
      policyDecision: p.policyDecision,
      policyReason: p.policyReason,
      sourceMessageIds: p.sourceMessageIds,
      createdAt: p.createdAt,
    })
    .returning();
  if (!row) throw new Error('insertProposal: insert returned no row');
  return row;
}

export async function getProposalById(db: DbOrTx, id: number): Promise<ProposalRow | null> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  return row ?? null;
}

function serializeManualDue(due: ResolvedDue): ProposalPayloadDue {
  return {
    dueAt: due.dueAt !== null ? due.dueAt.toISOString() : null,
    allDay: due.allDay,
    tz: due.tz,
    inPast: due.inPast,
    invalid: due.invalid,
  };
}

export interface CreateManualProposalInput {
  workspaceId: number;
  /** `null` for a DM-origin draft (`manual_dm`/`forward`) — proposals.chat_id is nullable for exactly this
   * case (see the schema's own D5 comment). */
  chatId: number | null;
  /** `extractSingle`'s (`src/ai/pipeline/extractSingle.ts`) resolved draft — always `kind: 'create'`, D19. */
  action: Extract<ResolvedAction, { kind: 'create' }>;
  origin: 'manual_group' | 'manual_dm' | 'forward';
  sourceMessageIds: number[];
  quote: string | null;
  quoteAuthorName: string | null;
  /** Not persisted on `proposals` (no such column) — accepted only so callers have one place to pass it
   * through for a future audit log, and for a `debug` log line here. */
  createdByUserId: number;
  /** CLAUDE.md §8: never `new Date()` — the caller's already-captured `now`. */
  now: Date;
}

/**
 * Inserts one manually-triggered `create` proposal (plan.md Task 3.10): `/task` in a group, DM free text,
 * or a DM forward batch (D18), as opposed to the AI batch pipeline's own `processBatch`/`insertProposal`
 * call site. `category='manual'` (not one of `action.category`'s five AI values — SPEC's card marks it
 * manual via `payload.origin !== 'ai'`, independent of this column), `policyDecision='shown'` always
 * (D19: the auto-pipeline's confidence thresholds never apply to a manual request — CLAUDE.md: a missed
 * task is worse than a false positive), `batchId: null` (not tied to any `analysis_batches` row —
 * `extractSingle`'s own cost tracking writes its own, separate `kind='manual'` row). `noReaction: true` on
 * every row this writes: `/task`'s own ✍ acknowledgement (`src/bot/handlers/taskCommand.ts`) already marks
 * the source message, so the card outbox's usual 👀 (`reactions.onDetect`, `src/scheduler/jobs/cards.ts`)
 * would otherwise double up on it once the card is actually delivered — harmless for a DM-origin draft
 * (`chatId: null`), which never gets a source reaction in the first place. Takes a plain `DbOrTx` rather than
 * `insertProposal`'s stricter `Tx`: none of this task's three call sites need atomicity with another write,
 * so this inserts directly instead of forcing an otherwise-pointless `db.transaction(...)` wrapper on every
 * caller.
 */
export async function createManualProposal(
  db: DbOrTx,
  input: CreateManualProposalInput,
): Promise<ProposalRow> {
  const { action } = input;
  const payload: ProposalPayload = {
    title: action.title,
    description: action.description,
    category: action.category,
    assignee: action.assignee,
    due: serializeManualDue(action.due),
    dueText: action.due.dueText,
    priority: action.priority,
    reasoning: action.reasoning,
    origin: input.origin,
    noReaction: true,
    quote: input.quote,
    quoteAuthorName: input.quoteAuthorName,
  };

  const [row] = await db
    .insert(proposals)
    .values({
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      batchId: null,
      kind: 'create',
      category: 'manual',
      payload,
      targetTaskId: null,
      confidence: action.confidence,
      policyDecision: 'shown',
      policyReason: 'manual_override',
      sourceMessageIds: input.sourceMessageIds,
      createdAt: input.now,
    })
    .returning();
  if (!row) throw new Error('createManualProposal: insert returned no row');
  return row;
}

// CLAUDE.md §8: jsonb goes through zod. Mirrors `ProposalPayload` above field-for-field — kept here,
// next to the interface it validates, so `src/domain/proposals/decide.ts` (plan.md Task 2.13) has one
// canonical parser instead of hand-rolling its own (`src/scheduler/jobs/cards.ts`'s own local schema,
// Task 2.12, predates this and is display-only — left as is rather than churned for this task).
const AssigneeSchema = z.union([
  z.object({ type: z.literal('user'), userId: z.number() }),
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('text'), name: z.string() }),
  z.object({ type: z.literal('none') }),
]);

const DueSchema = z.object({
  dueAt: z.string().nullable(),
  allDay: z.boolean(),
  tz: z.string().nullable(),
  inPast: z.boolean(),
  invalid: z.boolean(),
});

const OwnerEditSchema = z.object({ before: z.string().nullable(), after: z.string().nullable() });

export const ProposalPayloadSchema = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  category: z.enum(['assignment', 'event', 'owner_intent', 'commitment', 'request_to_owner']).optional(),
  assignee: AssigneeSchema.optional(),
  due: DueSchema.nullable().optional(),
  dueText: z.string().nullable().optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  reasoning: z.string(),
  duplicateOf: z.object({ type: z.enum(['task', 'proposal']), id: z.number(), title: z.string() }).optional(),
  changes: z
    .object({ due: DueSchema.optional(), assignee: AssigneeSchema.optional(), title: z.string().optional() })
    .optional(),
  targetProposalId: z.number().optional(),
  origin: z.enum(['ai', 'manual_group', 'manual_dm', 'forward']),
  noReaction: z.boolean().optional(),
  quote: z.string().nullable(),
  quoteAuthorName: z.string().nullable(),
  ownerEdits: z.record(z.string(), OwnerEditSchema).optional(),
});

/** `safeParse` wrapper — `null` on anything that doesn't match `ProposalPayload`'s shape (never throws). */
export function parseProposalPayload(payload: unknown): ProposalPayload | null {
  const parsed = ProposalPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
