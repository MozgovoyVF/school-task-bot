import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { membershipRole } from './enums.js';
import { workspaces } from './workspaces.js';

export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tgUserId: bigint('tg_user_id', { mode: 'number' }).notNull().unique(),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  dmStartedAt: timestamp('dm_started_at', { withTimezone: true }),
  dmBlocked: boolean('dm_blocked').notNull().default(false),
  timezone: text('timezone'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull().default('member'),
    displayName: text('display_name').notNull(),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    notifyAssignments: boolean('notify_assignments').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('memberships_workspace_user').on(t.workspaceId, t.userId),
    uniqueIndex('memberships_one_owner')
      .on(t.workspaceId)
      .where(sql`${t.role} = 'owner'`),
  ],
);
