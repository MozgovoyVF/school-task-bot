import { bigint, bigserial, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { claimPreviousOwnerAction } from './enums.js';
import { users } from './people.js';
import { workspaces } from './workspaces.js';

export const claimCodes = pgTable('claim_codes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: bigint('workspace_id', { mode: 'number' })
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  createdByUserId: bigint('created_by_user_id', { mode: 'number' })
    .notNull()
    .references(() => users.id),
  // D5: what happens to the previous owner's membership once this code is claimed.
  previousOwnerAction: claimPreviousOwnerAction('previous_owner_action').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedByUserId: bigint('used_by_user_id', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const errorReports = pgTable('error_reports', {
  fingerprint: text('fingerprint').primaryKey(),
  count: integer('count').notNull().default(0),
  firstAt: timestamp('first_at', { withTimezone: true }).notNull(),
  lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
  lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
  sample: jsonb('sample'), // no PII
});

// D5: heartbeat, daily-job marks, the LLM consecutive-error streak counter, notification marks.
export const appState = pgTable('app_state', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
