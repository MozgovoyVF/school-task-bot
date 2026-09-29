import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx, Tx } from '../../db/client.js';
import { proposals } from '../../db/schema/index.js';
import type { AssigneeResolution, Category } from '../../ai/pipeline/resolve.js';

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
}

export interface NewProposal {
  workspaceId: number;
  chatId: number | null;
  batchId: number | null;
  kind: 'create' | 'update' | 'complete' | 'cancel';
  category: Category | null;
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
});

/** `safeParse` wrapper — `null` on anything that doesn't match `ProposalPayload`'s shape (never throws). */
export function parseProposalPayload(payload: unknown): ProposalPayload | null {
  const parsed = ProposalPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
