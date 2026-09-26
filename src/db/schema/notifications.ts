import { bigint, bigserial, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { notificationKind, notificationStatus } from './enums.js';
import { users } from './people.js';
import { tasks } from './tasks.js';
import { workspaces } from './workspaces.js';

export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: bigint('task_id', { mode: 'number' }).references(() => tasks.id, { onDelete: 'cascade' }),
    recipientUserId: bigint('recipient_user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKind('kind').notNull(),
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    status: notificationStatus('status').notNull().default('scheduled'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentTgMessageId: integer('sent_tg_message_id'),
    dedupeKey: text('dedupe_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_status_fire_at').on(t.status, t.fireAt)],
);
