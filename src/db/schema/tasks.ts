import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { chats } from './chats.js';
import { taskEventActorType, taskOrigin, taskPriority, taskStatus } from './enums.js';
import { users } from './people.js';
import { proposals } from './ai.js';
import { workspaces } from './workspaces.js';

export const tasks = pgTable(
  'tasks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(), // <= 120 chars, enforced by zod at the domain boundary
    description: text('description'),
    assigneeUserId: bigint('assignee_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    assigneeNameText: text('assignee_name_text'),
    // D5: assignee "everyone".
    assigneeAll: boolean('assignee_all').notNull().default(false),
    dueAt: timestamp('due_at', { withTimezone: true }),
    dueAllDay: boolean('due_all_day').notNull().default(false),
    dueTz: text('due_tz'),
    priority: taskPriority('priority').notNull().default('normal'),
    status: taskStatus('status').notNull().default('open'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedByUserId: bigint('completed_by_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    origin: taskOrigin('origin').notNull(),
    // Explicit return type breaks the tasks <-> proposals circular type inference (Drizzle FAQ).
    proposalId: bigint('proposal_id', { mode: 'number' }).references((): AnyPgColumn => proposals.id, {
      onDelete: 'set null',
    }),
    sourceChatId: bigint('source_chat_id', { mode: 'number' }).references(() => chats.id, {
      onDelete: 'set null',
    }),
    sourceTgMessageId: integer('source_tg_message_id'),
    sourceLink: text('source_link'),
    sourceQuote: text('source_quote'), // <= 200 chars, enforced by zod at the domain boundary
    // D46: the quote's own author, tracked separately from `source_chat_id`/`source_tg_message_id`'s
    // `messages` row (which may be gone after the 30-day retention sweep, `chats/retention.ts`) — this is
    // what lets `eraseMember` (`src/domain/people/erase.ts`) still find and redact `source_quote` after
    // that row is deleted. Nullable: unset for a `forward`-origin task (no reliably resolvable internal
    // id, D46) and for every row created before this migration (no backfill, D46).
    quoteAuthorUserId: bigint('quote_author_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    // D5: nullable for anonymization.
    createdByUserId: bigint('created_by_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('tasks_workspace_status_due').on(t.workspaceId, t.status, t.dueAt),
    index('tasks_workspace_assignee_status').on(t.workspaceId, t.assigneeUserId, t.status),
    index('tasks_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`),
    index('tasks_description_trgm').using('gin', sql`${t.description} gin_trgm_ops`),
  ],
);

export const taskEvents = pgTable('task_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  taskId: bigint('task_id', { mode: 'number' })
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  actorType: taskEventActorType('actor_type').notNull(),
  actorUserId: bigint('actor_user_id', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  // e.g. created, updated, status_changed, review_requested, review_accepted, review_returned, snoozed, deleted…
  type: text('type').notNull(),
  diff: jsonb('diff'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
