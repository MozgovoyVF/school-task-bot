import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { chats } from './chats.js';
import {
  batchKind,
  batchStatus,
  proposalCategory,
  proposalKind,
  proposalPolicyDecision,
  proposalRejectReason,
  proposalStatus,
} from './enums.js';
import { messages } from './messages.js';
import { users } from './people.js';
import { tasks } from './tasks.js';
import { workspaces } from './workspaces.js';

export const analysisBatches = pgTable(
  'analysis_batches',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // D5: nullable — manual/reanalyze calls are not always tied to one chat.
    chatId: bigint('chat_id', { mode: 'number' }).references(() => chats.id, { onDelete: 'cascade' }),
    status: batchStatus('status').notNull().default('queued'),
    // D5: manual LLM calls also count toward the daily cost budget.
    kind: batchKind('kind').notNull().default('auto'),
    // Explicit return type breaks the analysis_batches <-> messages circular type inference (Drizzle FAQ).
    firstMessageId: bigint('first_message_id', { mode: 'number' }).references(
      (): AnyPgColumn => messages.id,
      {
        onDelete: 'set null',
      },
    ),
    lastMessageId: bigint('last_message_id', { mode: 'number' }).references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    messageCount: integer('message_count').notNull().default(0),
    promptVersion: text('prompt_version'),
    prefilterModel: text('prefilter_model'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    latencyMs: integer('latency_ms'),
    rawResponse: jsonb('raw_response'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    // D5: backoff — next attempt is not scheduled before this timestamp.
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('analysis_batches_chat_status').on(t.chatId, t.status)],
);

export const proposals = pgTable(
  'proposals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // D5: nullable — DM drafts are not tied to a group chat.
    chatId: bigint('chat_id', { mode: 'number' }).references(() => chats.id, { onDelete: 'cascade' }),
    batchId: bigint('batch_id', { mode: 'number' }).references(() => analysisBatches.id, {
      onDelete: 'set null',
    }),
    kind: proposalKind('kind').notNull(),
    category: proposalCategory('category'),
    payload: jsonb('payload').notNull(),
    // Explicit return type breaks the proposals <-> tasks circular type inference (Drizzle FAQ).
    targetTaskId: bigint('target_task_id', { mode: 'number' }).references((): AnyPgColumn => tasks.id, {
      onDelete: 'set null',
    }),
    confidence: real('confidence').notNull(),
    policyDecision: proposalPolicyDecision('policy_decision').notNull(),
    policyReason: text('policy_reason'),
    status: proposalStatus('status').notNull().default('pending'),
    rejectReason: proposalRejectReason('reject_reason'),
    sourceMessageIds: bigint('source_message_ids', { mode: 'number' })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    ownerDmMessageId: integer('owner_dm_message_id'),
    // D5: card outbox — set once the proposal card has actually been sent.
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    decidedByUserId: bigint('decided_by_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // GIN trigram index over payload.title, used for proposal dedup (plan.md task 2.8).
    index('proposals_payload_title_trgm').using('gin', sql`(${t.payload}->>'title') gin_trgm_ops`),
  ],
);
